import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { SessionUser } from '../auth/auth.types';
import { DatabaseService, type Queryable } from '../database/database.service';
import { auditExchange } from '../exchange/audit';
import { ExchangeJobs, type ExchangeClock } from '../exchange/jobs';
import { ExchangeNotifications } from '../exchange/notifications';
import { OnboardingService } from '../exchange/onboarding.service';
import { PlatformSettings } from '../exchange/platform-settings';
import { paymentForms } from '../exchange/trust-score';
import { currencies, escapedSearch, object, oneOf, pageParams, uuid } from '../market/market.inputs';
import { publicProfile, trustEnabledSql } from '../market/market.queries';
import {
  compareListings, eligibleListings, isInitialPass, matchingRates, recomputeAllPairs, recomputeListingPairs,
} from './matching.recompute';
import { declineReasons, type ListingForMatch } from './matching.rules';
import { adminMatchColumns, matchJoins, member, participantMatchColumns } from './matching.views';

const statuses = ['NEW', 'CHAT', 'DECLINED', 'VOID'] as const;
const matchLock = 12;

type MatchIdentity = {
  id: string; status: typeof statuses[number];
  sell_listing_id: string; buy_listing_id: string; seller_id: string; buyer_id: string;
};
type RateRow = { currency: string; usdPerUnit: string | null; updatedAt: Date };
const rateColumns = 'currency, usd_per_unit::text AS "usdPerUnit", updated_at AS "updatedAt"';
const firstAction = `
  seller_first_action_at = CASE WHEN seller_id = $2 THEN coalesce(seller_first_action_at, now()) ELSE seller_first_action_at END,
  buyer_first_action_at = CASE WHEN buyer_id = $2 THEN coalesce(buyer_first_action_at, now()) ELSE buyer_first_action_at END
`;

@Injectable()
export class MatchingService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService, private readonly settings: PlatformSettings,
    private readonly jobs: ExchangeJobs, private readonly notifications: ExchangeNotifications,
    private readonly onboarding: OnboardingService,
  ) {}

  onModuleInit() {
    this.jobs.register({
      name: 'matching.recompute', lock: matchLock, slot: clock => clock.day + 'T' + clock.hour,
      run: async (client, clock) => {
        if (!await this.settings.enabled('feature_matching', client)) return { enabled: false };
        const result = await recomputeAllPairs(client, clock, await matchingRates(client), await isInitialPass(client));
        return { enabled: true, ...result };
      },
    });
    this.jobs.register({ name: 'matching.pending', lock: matchLock, run: (client, clock) => this.processPending(client, clock) });
    this.jobs.register({ name: 'matching.notify', lock: matchLock, run: (client) => this.notifyNew(client) });
  }

  async recomputeListing(client: PoolClient, id: string) {
    if (!await this.settings.enabled('feature_matching', client)) return;
    const { rows: [lock] } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock(18403, $1) AS locked', [matchLock],
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
    const [items, total] = await Promise.all([
      this.db.query(`SELECT ${participantMatchColumns} ${matchJoins} WHERE ${where}
        ORDER BY (CASE WHEN m.buyer_id = $1 AND ${trustEnabledSql} AND s.trust_score >= 70 THEN EXISTS (
          SELECT 1 FROM listing_matches request_match WHERE request_match.buy_listing_id = m.buy_listing_id
            AND ($2::text IS NULL OR request_match.status = $2) OFFSET 5
        ) ELSE false END) DESC, type, m.created_at DESC, m.id LIMIT $4 OFFSET $5`, [userId, status, listingId, limit, offset]),
      this.db.query<{ count: number }>(`SELECT count(*)::int FROM listing_matches m WHERE ${where}`, [userId, status, listingId]),
    ]);
    return { items: items.rows, total: total.rows[0].count, page, limit };
  }

  async detail(userId: string, idInput: string) {
    await this.assertEnabled(this.db);
    return this.show(this.db, userId, uuid(idInput));
  }

  private async show(db: Queryable, userId: string, id: string) {
    const { rows: [row] } = await db.query(`
      SELECT ${participantMatchColumns} ${matchJoins} WHERE ${member} AND m.id = $2
    `, [userId, id]);
    if (!row) throw new NotFoundException('Совпадение не найдено');
    return row;
  }

  private async assertEnabled(db: Queryable) {
    if (!await this.settings.enabled('feature_matching', db)) throw new NotFoundException('Совпадение не найдено');
  }

  private async identity(client: PoolClient, userId: string, id: string, lock = false) {
    const { rows: [row] } = await client.query<MatchIdentity>(`
      SELECT m.id, m.status, m.sell_listing_id, m.buy_listing_id, m.seller_id, m.buyer_id
      FROM listing_matches m WHERE ${member} AND m.id = $2 ${lock ? 'FOR UPDATE' : ''}
    `, [userId, id]);
    if (!row) throw new NotFoundException('Совпадение не найдено');
    return row;
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
      body, payload: { matchId: match.id }, dedupeKey: kind + ':' + match.id,
      actions: [chatId
        ? { label: 'Открыть чат', action: 'OPEN_CHAT', href: '/chats/' + chatId }
        : { label: 'Открыть', action: 'OPEN_MATCH', href: '/matches/' + match.id }],
    });
  }

  async decline(userId: string, idInput: string, body: unknown) {
    const id = uuid(idInput);
    const reason = oneOf(object(body).reason, declineReasons, 'Причина');
    return this.db.transaction(async client => {
      await this.assertEnabled(client);
      await this.onboarding.assertOnboardingComplete(userId, client);
      const match = await this.identity(client, userId, id, true);
      if (match.status === 'CHAT') throw new ConflictException('Переписка уже начата: закройте её в чате или архивируйте объявление');
      if (match.status !== 'NEW') throw new ConflictException('Совпадение уже закрыто');
      await client.query(`
        UPDATE listing_matches SET status = 'DECLINED', declined_by = $2, decline_reason = $3,
          updated_at = now(), ${firstAction} WHERE id = $1
      `, [id, userId, reason]);
      await this.otherSideNotice(client, match, userId, 'match.declined', reason);
      return this.show(client, userId, id);
    });
  }

  async chat(userId: string, idInput: string) {
    const id = uuid(idInput);
    return this.db.transaction(async client => {
      await this.assertEnabled(client);
      const match = await this.identity(client, userId, id);
      if (match.status !== 'NEW' && match.status !== 'CHAT') throw new ConflictException('Совпадение уже закрыто');
      // Chat actions use the same participant-first order as existing chat mutations.
      await client.query('SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE', [[match.seller_id, match.buyer_id]]);
      await this.onboarding.assertOnboardingComplete(userId, client);
      await client.query('SELECT id FROM listings WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE', [[match.sell_listing_id, match.buy_listing_id]]);
      const { rows } = await client.query<ListingForMatch>(`
        ${eligibleListings} SELECT * FROM eligible WHERE id = ANY($1::uuid[])
      `, [[match.sell_listing_id, match.buy_listing_id]]);
      const sell = rows.find(row => row.id === match.sell_listing_id);
      const buy = rows.find(row => row.id === match.buy_listing_id);
      if (!sell || !buy) throw new ConflictException('Объявление больше недоступно');
      if ((sell.counterparty === 'COMPANY' && buy.participant_type !== 'COMPANY') ||
        (buy.counterparty === 'COMPANY' && sell.participant_type !== 'COMPANY')) {
        throw new ForbiddenException('Автор объявления принимает предложения только от компаний');
      }
      if (!compareListings(sell, buy, (await this.jobs.clock(client)).day, await matchingRates(client))) {
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
      if (current.status !== 'NEW' && current.status !== 'CHAT') throw new ConflictException('Совпадение уже закрыто');
      await client.query('UPDATE chats SET match_id = $2 WHERE id = $1 AND match_id IS NULL', [chat.id, id]);
      await client.query(`
        UPDATE listing_matches SET status = 'CHAT', chat_id = $3, updated_at = now(), ${firstAction} WHERE id = $1
      `, [id, userId, chat.id]);
      if (current.status === 'NEW') await this.otherSideNotice(client, match, userId, 'match.chat', undefined, chat.id);
      return { chatId: chat.id };
    });
  }

  async adminList(query: Record<string, unknown>) {
    const { page, limit, offset } = pageParams(query);
    const status = query.status === undefined ? null : oneOf(query.status, statuses, 'Статус');
    const search = query.q === undefined ? null : escapedSearch(query.q);
    const where = `($1::text IS NULL OR m.status = $1) AND ($2::text IS NULL OR
      m.number::text ILIKE $2 OR s.title ILIKE $2 OR b.title ILIKE $2 OR seller.display_name ILIKE $2 OR buyer.display_name ILIKE $2)`;
    const [items, total] = await Promise.all([
      this.db.query(`SELECT ${adminMatchColumns} ${matchJoins} WHERE ${where}
        ORDER BY m.created_at DESC, m.id LIMIT $3 OFFSET $4`, [status, search, limit, offset]),
      this.db.query<{ count: number }>(`SELECT count(*)::int ${matchJoins} WHERE ${where}`, [status, search]),
    ]);
    return { items: items.rows, total: total.rows[0].count, page, limit };
  }

  async rates() {
    const { rows } = await this.db.query<RateRow>(`SELECT ${rateColumns} FROM fx_rates ORDER BY currency`);
    return rows;
  }

  async putRate(actor: SessionUser<'ADMIN'>, currencyInput: string, body: unknown) {
    const currency = oneOf(currencyInput, currencies, 'Валюта');
    const value = object(body).usdPerUnit;
    const rate = typeof value === 'number' && Number(value.toFixed(8)) === value ? value.toFixed(8)
      : typeof value === 'string' ? value.trim() : '';
    if (value !== null && (!/^\d{1,10}(\.\d{1,8})?$/.test(rate) || Number(rate) <= 0)) {
      throw new BadRequestException('Укажите положительный курс. Допустимо до 8 знаков после точки.');
    }
    return this.db.transaction(async client => {
      const { rows: [before] } = await client.query<RateRow>(
        `SELECT ${rateColumns} FROM fx_rates WHERE currency = $1 FOR UPDATE`, [currency],
      );
      if (value === null ? before.usdPerUnit === null : canonicalRate(rate) === canonicalRate(before.usdPerUnit)) return before;
      const { rows: [after] } = await client.query<RateRow>(`
        UPDATE fx_rates SET usd_per_unit = $2, updated_at = now(), updated_by = $3 WHERE currency = $1
        RETURNING ${rateColumns}
      `, [currency, value === null ? null : rate, actor.id]);
      await auditExchange(client, actor, 'fx_rate', currency, 'update', before, after);
      // Changing a rate can admit or invalidate both same-currency and cross-currency pairs.
      await client.query(`
        INSERT INTO matching_pending(listing_id) SELECT id FROM listings WHERE currency = $1 AND model_id IS NOT NULL
        ON CONFLICT (listing_id) DO UPDATE SET queued_at = EXCLUDED.queued_at
      `, [currency]);
      return after;
    });
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
    type Pending = { id: string; initial: boolean; total: number; line: string };
    const { rows } = await client.query<Pending>(`
      SELECT m.id, m.initial_batch AS initial, count(*) OVER()::int AS total,
        concat(CASE m.type WHEN 'FULL' THEN 'Полное' ELSE 'Частичное' END,
          ' совпадение по объявлению «', mine.title, '»: ', coalesce(h.name_ru, s.title),
          CASE WHEN s.model_id IS DISTINCT FROM b.model_id THEN ' (по аналогу)' ELSE '' END, ', ',
          other.quantity, ' шт. (партия от ', other.min_lot, '), ',
          coalesce(other.origin_country, 'любая страна'), ', ',
          coalesce(round(other.price / other.quantity, 2)::text || ' ' || other.currency || ' за ед.', 'договорная цена'),
          ', оплата: ', array_to_string(ARRAY(
            SELECT coalesce(term->>'label_ru', method_label) FROM unnest(
              CASE WHEN cardinality(other.payment_terms) > 0 THEN other.payment_terms ELSE other.payment_methods END
            ) AS methods(code)
            LEFT JOIN LATERAL (SELECT CASE code WHEN 'BANK_TRANSFER' THEN 'Безналичный перевод' WHEN 'CARD' THEN 'Карта'
              WHEN 'CASH' THEN 'Наличные' WHEN 'LETTER_OF_CREDIT' THEN 'Аккредитив' ELSE code END) ml(method_label) ON true
            LEFT JOIN LATERAL (SELECT t AS term FROM jsonb_array_elements($2::jsonb) t WHERE t->>'code' = code LIMIT 1) forms ON true
          ), ', '), '. Контрагент: ',
          CASE WHEN other.representation = 'AGENT' THEN 'агент' WHEN other.kind = 'SELL' THEN 'продавец' ELSE 'покупатель' END,
          ', рейтинг ', coalesce(CASE WHEN m.seller_id = $1 THEN (${publicProfile('buyer')}) ->> 'rating'
            ELSE (${publicProfile('seller')}) ->> 'rating' END, 'пока нет'),
          CASE WHEN m.type = 'PARTIAL' THEN '. Не сошлось: ' || coalesce((
            SELECT string_agg(x->>'text', ' ') FROM jsonb_array_elements(m.mismatches) x), '') ELSE '' END) AS line
      ${matchJoins}
      JOIN listings mine ON mine.id = CASE WHEN m.seller_id = $1 THEN s.id ELSE b.id END
      JOIN listings other ON other.id = CASE WHEN m.seller_id = $1 THEN b.id ELSE s.id END
      WHERE m.status = 'NEW' AND ((m.seller_id = $1 AND m.seller_notified_at IS NULL)
        OR (m.buyer_id = $1 AND m.buyer_notified_at IS NULL))
      ORDER BY m.initial_batch DESC, m.created_at, m.id LIMIT 6
    `, [userId, JSON.stringify(paymentForms.payment_terms)]);
    if (!rows.length) return;
    const { total } = rows[0];
    const title = (rows[0].initial ? 'Площадка нашла совпадения по вашим объявлениям: ' : 'Новые совпадения: ') + total;
    const continuation = total > rows.length ? '\n\nВсе совпадения доступны на площадке.' : '';
    const notified = await this.notifications.notify(client, userId, {
      kind: 'match.new', title,
      body: Array.from(rows.map(row => row.line).join('\n\n')).slice(0, 3950).join('') + continuation,
      payload: { count: total, matchIds: rows.map(row => row.id) },
      dedupeKey: 'match.new:' + rows[0].id, channels: ['EMAIL'],
      actions: [
        { label: 'Открыть', action: 'OPEN_MATCHES', href: '/matches' },
        { label: 'Написать', action: 'OPEN_MATCH', href: '/matches/' + rows[0].id },
      ],
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
