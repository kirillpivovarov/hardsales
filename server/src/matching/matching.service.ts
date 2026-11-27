import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { SessionUser, StaffSession } from '../auth/auth.types';
import { publicCity, publicListingTitle, withoutLegacyProfileContacts, type PublicProfileText } from '../contact-guard/public-text';
import { DatabaseService, type Queryable } from '../database/database.service';
import { ExchangeActions, type ExchangeAction } from '../exchange/actions';
import { DealsService } from '../exchange/deals.service';
import { auditExchange } from '../exchange/audit';
import { ExchangeJobs, type ExchangeClock } from '../exchange/jobs';
import { ExchangeNotifications } from '../exchange/notifications';
import { OnboardingService } from '../exchange/onboarding.service';
import { PlatformSettings } from '../exchange/platform-settings';
import { lockTrustStaff } from '../exchange/trust-access';
import { paymentForms } from '../exchange/trust-score';
import { currencies, escapedSearch, object, oneOf, pageParams, uuid } from '../market/market.inputs';
import { trustEnabledSql } from '../market/market.queries';
import {
  compareListings, eligibleListings, isInitialPass, matchingLock, matchingRates, operatorEligibleListings,
  recomputeAllPairs, recomputeListingPairs,
} from './matching.recompute';
import { counterpartyEligible, declineReasons, type ListingForMatch } from './matching.rules';
import { adminMatchColumns, matchJoins, member, participantMatchColumns } from './matching.views';

const statuses = ['NEW', 'CHAT', 'DECLINED', 'VOID'] as const;
const sources = ['SYSTEM', 'OPERATOR'] as const;

type MatchIdentity = {
  id: string; status: typeof statuses[number];
  sell_listing_id: string; buy_listing_id: string; seller_id: string; buyer_id: string;
  source: typeof sources[number]; operator_model_id: string | null; proposed_by: string | null; proposed_at: Date | null; number: string;
};
type RateRow = { currency: string; usdPerUnit: string | null; updatedAt: Date };
type ParticipantMatchRow = Record<string, unknown> & {
  counterpart: {
    listing: { title: string; stockCity: string | null };
    owner: PublicProfileText;
    trust: unknown;
  };
};
const rateColumns = 'currency, usd_per_unit::text AS "usdPerUnit", updated_at AS "updatedAt"';
const firstAction = `
  seller_first_action_at = CASE WHEN seller_id = $2 THEN coalesce(seller_first_action_at, now()) ELSE seller_first_action_at END,
  buyer_first_action_at = CASE WHEN buyer_id = $2 THEN coalesce(buyer_first_action_at, now()) ELSE buyer_first_action_at END
`;

function participantMatch(row: ParticipantMatchRow) {
  const { counterpart } = row;
  return {
    ...row,
    counterpart: {
      ...counterpart,
      listing: { ...counterpart.listing, title: publicListingTitle(counterpart.listing.title),
        stockCity: publicCity(counterpart.listing.stockCity) },
      owner: withoutLegacyProfileContacts(counterpart.owner),
    },
  };
}

@Injectable()
export class MatchingService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService, private readonly settings: PlatformSettings,
    private readonly jobs: ExchangeJobs, private readonly notifications: ExchangeNotifications,
    private readonly onboarding: OnboardingService, private readonly actions: ExchangeActions,
    private readonly deals: DealsService,
  ) {}

  onModuleInit() {
    this.jobs.register({
      name: 'matching.recompute', lock: matchingLock, slot: clock => clock.day + 'T' + clock.hour,
      run: async (client, clock) => {
        if (!await this.settings.enabled('feature_matching', client)) return { enabled: false };
        const result = await recomputeAllPairs(client, clock, await matchingRates(client), await isInitialPass(client));
        return { enabled: true, ...result };
      },
    });
    this.jobs.register({ name: 'matching.pending', lock: matchingLock, run: (client, clock) => this.processPending(client, clock) });
    this.jobs.register({ name: 'matching.notify', lock: matchingLock, run: (client) => this.notifyNew(client) });
    this.actions.register('match.chat', {
      lockSubjects: (client, token) => this.lockActionParties(client, token),
      describe: (client, token) => this.describeAction(client, token),
      execute: async (client, token) => ({
        ...await this.chatWithClient(client, this.actionUser(token), token.subjectId, this.actionProposal(token)), message: 'Чат открыт',
      }),
    });
    this.actions.register('match.decline', {
      lockSubjects: (client, token) => this.lockActionParties(client, token),
      describe: (client, token) => this.describeAction(client, token),
      execute: async (client, token, body) => {
        await this.declineWithClient(client, this.actionUser(token), token.subjectId,
          oneOf(object(body).reason, declineReasons, 'Причина'), this.actionProposal(token));
        return { status: 'DECLINED', message: 'Совпадение отклонено' };
      },
    });
  }

  async recomputeListing(client: PoolClient, id: string) {
    if (!await this.settings.enabled('feature_matching', client)) return;
    const { rows: [lock] } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock(18403, $1) AS locked', [matchingLock],
    );
    if (!lock.locked) return;
    const result = await recomputeListingPairs(
      client, id, await this.jobs.clock(client), await matchingRates(client), await isInitialPass(client),
    );
    // The complete hourly pass covers any listing that exceeds the cap.
    if (result.evaluated < 500) await client.query('DELETE FROM matching_pending WHERE listing_id = $1', [id]);
  }

  private async processPending(client: PoolClient, clock: ExchangeClock) {
    if (!await this.settings.enabled('feature_matching', client)) return;
    const { rows } = await client.query<{ listing_id: string; queued_at: string }>(`
      SELECT listing_id, queued_at::text FROM matching_pending ORDER BY queued_at, listing_id LIMIT 25
    `);
    if (!rows.length) return;
    const rates = await matchingRates(client);
    const initial = await isInitialPass(client);
    for (const row of rows) {
      await recomputeListingPairs(client, row.listing_id, clock, rates, initial);
      await client.query('DELETE FROM matching_pending WHERE listing_id = $1 AND queued_at = $2', [row.listing_id, row.queued_at]);
    }
  }

  async counts(userId: string) {
    if (!await this.settings.enabled('feature_matching')) return { total: 0, byListing: {} };
    const { rows } = await this.db.query<{ id: string; total: number }>(`
      SELECT CASE WHEN seller_id = $1 THEN sell_listing_id ELSE buy_listing_id END AS id, count(*)::int AS total
      FROM listing_matches WHERE status = 'NEW' AND (seller_id = $1 OR buyer_id = $1) GROUP BY id
    `, [userId]);
    return { total: rows.reduce((sum, row) => sum + row.total, 0), byListing: Object.fromEntries(rows.map(row => [row.id, row.total])) };
  }

  async list(userId: string, query: Record<string, unknown>) {
    const { page, limit, offset } = pageParams(query);
    if (!await this.settings.enabled('feature_matching')) return { items: [], total: 0, page, limit };
    const status = query.status === undefined ? null : oneOf(query.status, statuses, 'Статус');
    const listingId = query.listingId === undefined ? null : uuid(query.listingId, 'Объявление');
    const where = `${member} AND ($2::text IS NULL OR m.status = $2) AND ($3::uuid IS NULL
      OR CASE WHEN m.seller_id = $1 THEN m.sell_listing_id ELSE m.buy_listing_id END = $3)`;
    const [items, total, maskLegacyContacts] = await Promise.all([
      this.db.query<ParticipantMatchRow>(`SELECT ${participantMatchColumns} ${matchJoins} WHERE ${where}
        ORDER BY (CASE WHEN m.buyer_id = $1 AND ${trustEnabledSql} AND s.trust_score >= 70 THEN EXISTS (
          SELECT 1 FROM listing_matches request_match WHERE request_match.buy_listing_id = m.buy_listing_id
            AND ($2::text IS NULL OR request_match.status = $2) OFFSET 5
        ) ELSE false END) DESC, type, m.created_at DESC, m.id LIMIT $4 OFFSET $5`, [userId, status, listingId, limit, offset]),
      this.db.query<{ count: number }>(`SELECT count(*)::int FROM listing_matches m WHERE ${where}`, [userId, status, listingId]),
      this.settings.enabled('feature_disclosure_journal'),
    ]);
    return { items: maskLegacyContacts ? items.rows.map(participantMatch) : items.rows, total: total.rows[0].count, page, limit };
  }

  async detail(userId: string, idInput: string) {
    await this.assertEnabled(this.db);
    return this.show(this.db, userId, uuid(idInput));
  }

  private async show(db: Queryable, userId: string, id: string) {
    const { rows: [row] } = await db.query<ParticipantMatchRow>(`
      SELECT ${participantMatchColumns} ${matchJoins} WHERE ${member} AND m.id = $2
    `, [userId, id]);
    if (!row) throw new NotFoundException('Совпадение не найдено');
    return await this.settings.enabled('feature_disclosure_journal', db) ? participantMatch(row) : row;
  }

  private async assertEnabled(db: Queryable) {
    if (!await this.settings.enabled('feature_matching', db)) throw new NotFoundException('Совпадение не найдено');
  }

  private async identity(client: PoolClient, userId: string, id: string, lock = false) {
    const { rows: [row] } = await client.query<MatchIdentity>(`
      SELECT m.id, m.status, m.sell_listing_id, m.buy_listing_id, m.seller_id, m.buyer_id,
        m.source, m.operator_model_id, m.proposed_by, m.proposed_at, m.number::text
      FROM listing_matches m WHERE ${member} AND m.id = $2 ${lock ? 'FOR UPDATE' : ''}
    `, [userId, id]);
    if (!row) throw new NotFoundException('Совпадение не найдено');
    return row;
  }

  private actionUser(token: ExchangeAction) {
    if (!token.userId) throw new NotFoundException('Совпадение не найдено');
    return token.userId;
  }

  private actionProposal(token: ExchangeAction) {
    return typeof token.payload.proposedAt === 'string' ? token.payload.proposedAt : null;
  }

  private checkActionProposal(match: MatchIdentity, expected?: string | null) {
    if (expected !== undefined && expected !== (match.proposed_at?.toISOString() ?? null)) {
      throw new ConflictException('Предложение обновилось. Откройте текущее совпадение.');
    }
  }

  private async lockActionParties(client: PoolClient, token: ExchangeAction) {
    await client.query(`SELECT u.id FROM listing_matches m JOIN users u ON u.id IN (m.seller_id, m.buyer_id)
      WHERE m.id = $2 AND ${member} ORDER BY u.id FOR UPDATE OF u`, [this.actionUser(token), token.subjectId]);
  }

  private async describeAction(client: PoolClient, token: ExchangeAction) {
    await this.assertEnabled(client);
    const userId = this.actionUser(token);
    const match = await this.identity(client, userId, token.subjectId);
    this.checkActionProposal(match, this.actionProposal(token));
    const listingId = userId === match.seller_id ? match.sell_listing_id : match.buy_listing_id;
    const { rows: [listing] } = await client.query<{ title: string }>('SELECT title FROM listings WHERE id = $1', [listingId]);
    return { status: match.status, number: Number(match.number), title: listing.title, fields: { reasons: declineReasons } };
  }

  async announcementActions(client: PoolClient, matchId: string, userId: string, href: string, proposedAt?: Date) {
    const { now } = await this.jobs.clock(client);
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const target = { subjectId: matchId, userId, expiresAt, payload: { proposedAt: proposedAt?.toISOString() ?? null } };
    const chat = await this.actions.issue(client, { ...target, purpose: 'match.chat' });
    const decline = await this.actions.issue(client, { ...target, purpose: 'match.decline' });
    return [
      { label: 'Открыть', action: 'OPEN_MATCH', href },
      { label: 'Написать', action: 'match.chat', token: chat },
      { label: 'Не подходит', action: 'match.decline', token: decline },
    ];
  }

  private async otherSideNotice(
    client: PoolClient, match: MatchIdentity, userId: string, kind: 'match.chat' | 'match.declined', reason?: string, chatId?: string,
  ) {
    const seller = userId === match.seller_id;
    const receiver = seller ? match.buyer_id : match.seller_id;
    const otherListing = seller ? match.buy_listing_id : match.sell_listing_id;
    const { rows: [listing] } = await client.query<{ title: string }>('SELECT title FROM listings WHERE id = $1', [otherListing]);
    const body = kind === 'match.chat'
      ? `По совпадению с вашим объявлением «${listing.title}» открыт чат`
      : `Совпадение по «${listing.title}»: контрагент ответил «Не подходит». Причина: ${reason}`;
    await this.notifications.notify(client, receiver, {
      kind, title: kind === 'match.chat' ? 'Открыт чат по совпадению' : 'Совпадение отклонено',
      body, payload: { matchId: match.id }, dedupeKey: kind + ':' + match.id, channels: ['EMAIL'],
      actions: [chatId
        ? { label: 'Открыть чат', action: 'OPEN_CHAT', href: '/chats/' + chatId }
        : { label: 'Открыть', action: 'OPEN_MATCH', href: '/matches/' + match.id }],
    });
  }

  async decline(userId: string, idInput: string, body: unknown) {
    const id = uuid(idInput);
    const reason = oneOf(object(body).reason, declineReasons, 'Причина');
    return this.db.transaction(client => this.declineWithClient(client, userId, id, reason));
  }

  private async declineWithClient(client: PoolClient, userId: string, id: string, reason: typeof declineReasons[number],
    expectedProposal?: string | null) {
    await this.assertEnabled(client);
    const unlocked = await this.identity(client, userId, id);
    await this.lockParticipants(client, unlocked);
    await this.onboarding.assertOnboardingComplete(userId, client);
    const match = await this.identity(client, userId, id, true);
    this.checkActionProposal(match, expectedProposal);
    if (match.status === 'CHAT') throw new ConflictException('Переписка уже начата: закройте её в чате или архивируйте объявление');
    if (match.status !== 'NEW') throw new ConflictException('Совпадение уже закрыто');
    await client.query(`
      UPDATE listing_matches SET status = 'DECLINED', declined_by = $2, decline_reason = $3,
        updated_at = now(), ${firstAction} WHERE id = $1
    `, [id, userId, reason]);
    await this.otherSideNotice(client, match, userId, 'match.declined', reason);
    if (match.proposed_by) await this.notifications.notify(client, match.proposed_by, {
      kind: 'match.operator_declined', title: `Предложенное совпадение № ${match.number} отклонено`,
      body: `Причина: ${reason}`, payload: { matchId: id }, dedupeKey: 'match.operator_declined:' + id,
      actions: [{ label: 'Открыть', href: '/admin?section=exchange&part=matching' }],
    });
    return this.show(client, userId, id);
  }

  async chat(userId: string, idInput: string) {
    return this.db.transaction(client => this.chatWithClient(client, userId, uuid(idInput)));
  }

  private async lockParticipants(client: PoolClient, match: MatchIdentity) {
    await client.query('SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE', [[match.seller_id, match.buyer_id]]);
  }

  private async chatWithClient(client: PoolClient, userId: string, id: string, expectedProposal?: string | null) {
    await this.assertEnabled(client);
    const match = await this.identity(client, userId, id);
    this.checkActionProposal(match, expectedProposal);
    if (match.status !== 'NEW' && match.status !== 'CHAT') throw new ConflictException('Совпадение уже закрыто');
    // Chat actions use the same participant-first order as existing chat mutations.
    await this.lockParticipants(client, match);
    await this.onboarding.assertOnboardingComplete(userId, client);
    await client.query('SELECT id FROM listings WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE', [[match.sell_listing_id, match.buy_listing_id]]);
    const operator = match.source === 'OPERATOR';
    const { rows } = await client.query<ListingForMatch>(`
      ${operator ? operatorEligibleListings : eligibleListings}
      SELECT * FROM ${operator ? 'operator_eligible' : 'eligible'} WHERE id = ANY($1::uuid[])
        AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM hardware_models WHERE id = $2 AND status = 'ACTIVE'))
    `, [[match.sell_listing_id, match.buy_listing_id], match.operator_model_id]);
    const sell = rows.find(row => row.id === match.sell_listing_id);
    const buy = rows.find(row => row.id === match.buy_listing_id);
    if (!sell || !buy) throw new ConflictException('Объявление больше недоступно');
    if (!counterpartyEligible(sell, buy)) {
      throw new ForbiddenException('Автор объявления принимает предложения только от компаний');
    }
    if (!operator && !compareListings(sell, buy, (await this.jobs.clock(client)).day, await matchingRates(client))) {
      throw new ConflictException('Условия объявлений больше не совпадают');
    }
    await client.query(`
      INSERT INTO chats (listing_id, owner_id, visitor_id) VALUES ($1, $2, $3)
      ON CONFLICT (listing_id, visitor_id) DO NOTHING
    `, [sell.id, match.seller_id, match.buyer_id]);
    const { rows: [chat] } = await client.query<{ id: string }>(
      'SELECT id FROM chats WHERE listing_id = $1 AND visitor_id = $2 FOR UPDATE', [sell.id, match.buyer_id],
    );
    const current = await this.identity(client, userId, id, true);
    this.checkActionProposal(current, expectedProposal);
    if (current.status !== 'NEW' && current.status !== 'CHAT') throw new ConflictException('Совпадение уже закрыто');
    await client.query('UPDATE chats SET match_id = $2 WHERE id = $1 AND match_id IS NULL', [chat.id, id]);
    await client.query(`
      UPDATE listing_matches SET status = 'CHAT', chat_id = $3, updated_at = now(), ${firstAction} WHERE id = $1
    `, [id, userId, chat.id]);
    await this.deals.startFromChat(client, chat.id, userId, 'PAIR_CHAT', true);
    if (current.status === 'NEW') await this.otherSideNotice(client, match, userId, 'match.chat', undefined, chat.id);
    return { chatId: chat.id };
  }

  async adminList(query: Record<string, unknown>) {
    const { page, limit, offset } = pageParams(query);
    const status = query.status === undefined ? null : oneOf(query.status, statuses, 'Статус');
    const search = query.q === undefined ? null : escapedSearch(query.q);
    const source = query.source === undefined ? null : oneOf(query.source, sources, 'Источник совпадения');
    const where = `($1::text IS NULL OR m.status = $1) AND ($2::text IS NULL OR
      m.number::text ILIKE $2 OR s.title ILIKE $2 OR b.title ILIKE $2 OR seller.display_name ILIKE $2 OR buyer.display_name ILIKE $2)
      AND ($3::text IS NULL OR m.source = $3)`;
    const [items, total] = await Promise.all([
      this.db.query(`SELECT ${adminMatchColumns} ${matchJoins} WHERE ${where}
        ORDER BY m.created_at DESC, m.id LIMIT $4 OFFSET $5`, [status, search, source, limit, offset]),
      this.db.query<{ count: number }>(`SELECT count(*)::int ${matchJoins} WHERE ${where}`, [status, search, source]),
    ]);
    return { items: items.rows, total: total.rows[0].count, page, limit };
  }

  async rates() {
    const { rows } = await this.db.query<RateRow>(`SELECT ${rateColumns} FROM fx_rates ORDER BY currency`);
    return rows;
  }

  async putRate(actor: StaffSession<'ADMIN'>, currencyInput: string, body: unknown) {
    return this.db.transaction(async client => {
      await lockTrustStaff(client, actor);
      return this.setRateWith(client, actor, currencyInput, body);
    });
  }

  async setRateWith(client: PoolClient, actor: Pick<SessionUser<'ADMIN'>, 'id' | 'username' | 'role'>,
    currencyInput: string, body: unknown) {
    const currency = oneOf(currencyInput, currencies, 'Валюта');
    const value = object(body).usdPerUnit;
    const rate = typeof value === 'number' && Number(value.toFixed(8)) === value ? value.toFixed(8)
      : typeof value === 'string' ? value.trim() : '';
    if (value !== null && (!/^\d{1,10}(\.\d{1,8})?$/.test(rate) || Number(rate) <= 0)) {
      throw new BadRequestException('Укажите положительный курс. Допустимо до 8 знаков после точки.');
    }
    await client.query('SELECT pg_advisory_xact_lock(18403, 32)');
    const { rows: [before] } = await client.query<RateRow>(
      `SELECT ${rateColumns} FROM fx_rates WHERE currency = $1 FOR UPDATE`, [currency],
    );
    if (value === null ? before.usdPerUnit === null : canonicalRate(rate) === canonicalRate(before.usdPerUnit)) return before;
    const { rows: [after] } = await client.query<RateRow>(`
      UPDATE fx_rates SET usd_per_unit = $2, updated_at = now(), updated_by = $3 WHERE currency = $1
      RETURNING ${rateColumns}
    `, [currency, value === null ? null : rate, actor.id]);
    await client.query(`
      UPDATE listings SET price_usd = round(price * $2::numeric, 2)
      WHERE currency = $1 AND price_mode = 'FIXED'
        AND price_usd IS DISTINCT FROM round(price * $2::numeric, 2)
    `, [currency, after.usdPerUnit]);
    await auditExchange(client, actor, 'fx_rate', currency, 'update', before, after);
    // Changing a rate can admit or invalidate both same-currency and cross-currency pairs.
    await client.query(`
      INSERT INTO matching_pending(listing_id) SELECT id FROM listings WHERE currency = $1 AND model_id IS NOT NULL
      ON CONFLICT (listing_id) DO UPDATE SET queued_at = EXCLUDED.queued_at
    `, [currency]);
    return after;
  }

  private async notifyNew(client: PoolClient) {
    if (!await this.settings.enabled('feature_matching', client)) return;
    // One batch per participant and interval. SKIPPED recipients stay queued with the pair.
    const { rows: recipients } = await client.query<{ id: string }>(`
      WITH pending AS (
        SELECT seller_id AS id FROM listing_matches WHERE status = 'NEW' AND seller_notified_at IS NULL
        UNION
        SELECT buyer_id FROM listing_matches WHERE status = 'NEW' AND buyer_notified_at IS NULL
      )
      SELECT u.id FROM pending p JOIN users u ON u.id = p.id
      WHERE u.status = 'ACTIVE' AND u.email_verified_at IS NOT NULL AND u.onboarding_state <> 'REQUIRED'
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = u.id AND n.kind = 'match.new'
          AND n.created_at > now() - interval '15 minutes')
      ORDER BY u.id LIMIT 100
    `);
    for (const { id } of recipients) await this.notifyBatch(client, id);
  }

  private async notifyBatch(client: PoolClient, userId: string) {
    type Pending = { id: string; initial: boolean; total: number; prefix: string; label: string; labelIsPeerTitle: boolean; suffix: string };
    const { rows } = await client.query<Pending>(`
      SELECT m.id, m.initial_batch AS initial, count(*) OVER()::int AS total,
        concat(CASE m.type WHEN 'FULL' THEN 'Полное' ELSE 'Частичное' END,
          ' совпадение по объявлению «', mine.title, '»: ') AS prefix,
        coalesce(h.name_ru, s.title) AS label,
        h.id IS NULL AND m.seller_id <> $1 AS "labelIsPeerTitle",
        concat(CASE WHEN s.model_id IS DISTINCT FROM b.model_id THEN ' (по аналогу)' ELSE '' END, ', ',
          other.quantity, ' шт. (партия от ', other.min_lot, '), ',
          coalesce(other.origin_country, 'любая страна'), ', ',
          coalesce(other.price::text || ' ' || other.currency || ' за шт.' ||
            CASE WHEN other.quantity>1 THEN ' (' || (other.price*other.quantity)::text || ' ' || other.currency ||
              ' за ' || other.quantity || ' шт.)' ELSE '' END, 'договорная цена'),
          ', оплата: ', array_to_string(ARRAY(
            SELECT coalesce(term->>'label_ru', method_label) FROM unnest(
              CASE WHEN cardinality(other.payment_terms) > 0 THEN other.payment_terms ELSE other.payment_methods END
            ) AS methods(code)
            LEFT JOIN LATERAL (SELECT CASE code WHEN 'BANK_TRANSFER' THEN 'Банковский перевод' WHEN 'CARD' THEN 'Карта'
              WHEN 'CASH' THEN 'Наличные' WHEN 'LETTER_OF_CREDIT' THEN 'Аккредитив' ELSE code END) ml(method_label) ON true
            LEFT JOIN LATERAL (SELECT t AS term FROM jsonb_array_elements($2::jsonb) t WHERE t->>'code' = code LIMIT 1) forms ON true
          ), ', '), '. Контрагент: ',
          CASE WHEN other.representation = 'AGENT' THEN 'агент' WHEN other.kind = 'SELL' THEN 'продавец' ELSE 'покупатель' END,
          ', ', CASE (CASE WHEN m.seller_id=$1 THEN listing_trust_projection(b,buyer) ELSE listing_trust_projection(s,seller) END)->>'ownerLevelName'
            WHEN 'проверен сделкой' THEN 'сделка подтверждена' WHEN 'проверен документами' THEN 'документы проверены'
            WHEN 'проверен оператором' THEN 'проверен оператором' ELSE 'участник не проверен' END,
          ', рейтинг ', coalesce((CASE WHEN m.seller_id=$1 THEN buyer.trust_score ELSE seller.trust_score END)::text || ' из 100', 'считается'),
          CASE WHEN m.type = 'PARTIAL' THEN '. Различия в условиях: ' || coalesce((
            SELECT string_agg(x->>'text', ' ') FROM jsonb_array_elements(m.mismatches) x), '') ELSE '' END) AS suffix
      ${matchJoins}
      JOIN listings mine ON mine.id = CASE WHEN m.seller_id = $1 THEN s.id ELSE b.id END
      JOIN listings other ON other.id = CASE WHEN m.seller_id = $1 THEN b.id ELSE s.id END
      WHERE m.status = 'NEW' AND ((m.seller_id = $1 AND m.seller_notified_at IS NULL)
        OR (m.buyer_id = $1 AND m.buyer_notified_at IS NULL))
      ORDER BY m.initial_batch DESC, m.created_at, m.id LIMIT 6
    `, [userId, JSON.stringify(paymentForms.payment_terms)]);
    if (!rows.length) return;
    const maskLegacyContacts = await this.settings.enabled('feature_disclosure_journal', client);
    const lines = rows.map(row => row.prefix + (maskLegacyContacts && row.labelIsPeerTitle ? publicListingTitle(row.label) : row.label) + row.suffix);
    const { total } = rows[0];
    const title = (rows[0].initial ? 'Площадка нашла совпадения по вашим объявлениям: ' : 'Новые совпадения: ') + total;
    const continuation = total > rows.length ? '\n\nВсе совпадения доступны на площадке.' : '';
    const notified = await this.notifications.notify(client, userId, {
      kind: 'match.new', title,
      body: Array.from(lines.join('\n\n')).slice(0, 3950).join('') + continuation,
      payload: { count: total, matchIds: rows.map(row => row.id) },
      dedupeKey: 'match.new:' + rows[0].id, channels: ['EMAIL'],
      actions: await this.announcementActions(client, rows[0].id, userId, '/matches'),
    });
    if (notified) await client.query(`
      UPDATE listing_matches SET
        seller_notified_at = CASE WHEN seller_id = $1 THEN coalesce(seller_notified_at, now()) ELSE seller_notified_at END,
        buyer_notified_at = CASE WHEN buyer_id = $1 THEN coalesce(buyer_notified_at, now()) ELSE buyer_notified_at END
      WHERE status = 'NEW' AND ((seller_id = $1 AND seller_notified_at IS NULL) OR (buyer_id = $1 AND buyer_notified_at IS NULL))
    `, [userId]);
  }
}

function canonicalRate(value: string | null) {
  if (value === null) return null;
  const [integer, fractional = ''] = value.split('.');
  return BigInt(integer + fractional.padEnd(8, '0'));
}
