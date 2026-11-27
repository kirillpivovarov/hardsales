import {
  BadRequestException, ConflictException, HttpException, Injectable, NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { StaffSession } from '../auth/auth.types';
import { outsideContact } from '../contact';
import { detectContacts } from '../contact-guard/detect';
import { DatabaseService } from '../database/database.service';
import { auditExchange } from '../exchange/audit';
import { ExchangeJobs, type ExchangeClock } from '../exchange/jobs';
import { ExchangeNotifications } from '../exchange/notifications';
import { PlatformSettings } from '../exchange/platform-settings';
import { lockTrustStaff } from '../exchange/trust-access';
import { boolean, integer, object, oneOf, pageParams, str, uuid } from '../market/market.inputs';
import { hardwareModelId } from '../models/model-listings';
import { modelSuggestionsQuery } from '../models/models.service';
import { explainListings, matchingLock, matchingRates, operatorEligibleListings } from './matching.recompute';
import { counterpartyEligible, matchRegion, nearMissKeys, type ListingForMatch, type MatchFailure, type MatchModel } from './matching.rules';
import { MatchingService } from './matching.service';

type VisibleListing = ListingForMatch & { nickname: string; confirmed_at: Date | null; category_slug: string };
type Candidate = VisibleListing & { model: MatchModel | null };
type CandidatePair = { sell: Candidate; buy: Candidate; note: string | null };
type PairIds = { sellListingId: string; buyListingId: string };
type MatchRow = { id: string; number: number; type: 'FULL' | 'PARTIAL'; status: 'NEW' | 'CHAT' | 'DECLINED' | 'VOID'; proposedAt: Date };
type NearResult = ReturnType<typeof presentPair>;
type Cached = { items: NearResult[]; cachedAt: string; expiresAt: number };

const proposalColumns = 'id, number::float8 AS number, type, status, proposed_at AS "proposedAt"';
const expiryMs = 5 * 60 * 1000;
const maximumPairs = 200;

function guessedModel({ sell, buy }: CandidatePair) {
  return !sell.model_id && sell.model ? sell.model : !buy.model_id ? buy.model : null;
}

function presentModel(model: MatchModel | null) {
  return model && { id: model.id, nameRu: model.nameRu, nameEn: model.nameEn };
}

function presentSide(side: Candidate) {
  return {
    id: side.id, title: side.title, nickname: side.nickname, representation: side.representation,
    model: presentModel(side.model), modelByTitle: !side.model_id && Boolean(side.model),
    quantity: side.quantity, minLot: side.min_lot, originCountry: side.origin_country, originScope: side.origin_scope,
    destinationCountry: side.destination_country, currency: side.currency, shipDays: side.ship_days, deliveryBy: side.delivery_by,
    unitPrice: side.price === null ? null : Number(side.price), confirmedAt: side.confirmed_at,
  };
}

function presentPair(pair: CandidatePair, failures: MatchFailure[]) {
  return { sell: presentSide(pair.sell), buy: presentSide(pair.buy), failures, suggestedModel: presentModel(guessedModel(pair)), note: pair.note };
}

function parseIds(input: Record<string, unknown>): PairIds {
  const sellListingId = uuid(input.sellListingId, 'Предложение');
  const buyListingId = uuid(input.buyListingId, 'Заявка');
  if (sellListingId === buyListingId) throw new BadRequestException('Выберите предложение и заявку');
  return { sellListingId, buyListingId };
}

function normalized(text: string) {
  return text.normalize('NFKC').toLocaleLowerCase('ru').replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim();
}

function pairKey(sell: string, buy: string) {
  return `${sell}/${buy}`;
}

function modelKeys(model: MatchModel) {
  return ['id:' + model.id, ...model.groups.map(group => 'group:' + group)];
}

@Injectable()
export class NearMissesService {
  private readonly cache = new Map<string, Cached>();

  constructor(
    private readonly db: DatabaseService, private readonly settings: PlatformSettings, private readonly jobs: ExchangeJobs,
    private readonly notifications: ExchangeNotifications, private readonly matching: MatchingService,
  ) {}

  async list(query: Record<string, unknown>) {
    const { page, limit, offset } = pageParams(query);
    const [maxFailuresCeiling, maxPriceOver] = await Promise.all([
      this.settings.get<number>('near_miss_max_failures'), this.settings.get<number>('near_miss_price_over'),
    ]);
    const maxFailures = query.maxFailures === undefined ? maxFailuresCeiling
      : Math.min(maxFailuresCeiling, integer(query.maxFailures, 'Число причин', 1, 3));
    const modelId = query.modelId === undefined ? null : hardwareModelId(query.modelId);
    const key = query.key === undefined ? null : oneOf(query.key, nearMissKeys, 'Причина');
    const dismissed = query.dismissed === undefined ? false : boolean(query.dismissed, 'Скрытые пары');
    const cacheKey = JSON.stringify([maxFailures, maxPriceOver, modelId, key, dismissed]);
    const current = this.cache.get(cacheKey);
    const now = Date.now();
    let result = current && current.expiresAt > now ? current : undefined;
    if (!result) {
      const items = await this.db.transaction(client => this.findPairs(client, { maxFailures, maxPriceOver, modelId, key, dismissed }));
      result = { items, cachedAt: new Date().toISOString(), expiresAt: Date.now() + expiryMs };
      // Only recent staff filter combinations retain their projection.
      for (const [signature, saved] of this.cache) if (saved.expiresAt <= now) this.cache.delete(signature);
      if (this.cache.size >= 24) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(cacheKey, result);
    }
    return { items: result.items.slice(offset, offset + limit), total: result.items.length, page, limit,
      cachedAt: result.cachedAt, maxFailuresCeiling };
  }

  async propose(actor: StaffSession, raw: unknown) {
    const input = object(raw);
    const ids = parseIds(input);
    const comment = str(input.comment, 'Комментарий', 10, 1000);
    if (outsideContact(comment) || detectContacts(comment).length) throw new BadRequestException('Уберите контакты из комментария');
    const result = await this.db.transaction(async client => {
      await client.query('SET LOCAL jit = off');
      await lockTrustStaff(client, actor);
      if (!await this.settings.enabled('feature_matching', client)) throw new ConflictException('Совпадения выключены в настройках биржи');
      // Use the same transaction lock as the matcher. It serializes the proposal quotas as well as pair creation.
      await client.query('SELECT pg_advisory_xact_lock(18403, $1)', [matchingLock]);
      const listingIds = [ids.sellListingId, ids.buyListingId];
      await client.query(`SELECT id FROM users WHERE id IN (SELECT owner_id FROM listings WHERE id = ANY($1::uuid[]))
        ORDER BY id FOR SHARE`, [listingIds]);
      await client.query('SELECT id FROM listings WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE', [listingIds]);
      const candidates = await this.visibleCandidates(client, listingIds);
      const sell = candidates.find(row => row.id === ids.sellListingId && row.kind === 'SELL');
      const buy = candidates.find(row => row.id === ids.buyListingId && row.kind === 'BUY');
      if (!sell || !buy) throw new ConflictException('Одно из объявлений больше недоступно');
      const pair = { sell, buy, note: null };
      if (sell.owner_id === buy.owner_id) throw new ConflictException('Объявления принадлежат одному участнику');
      if (!counterpartyEligible(sell, buy)) throw new ConflictException('Сторона принимает только компании');
      const { rows: [existing] } = await client.query<MatchRow>(`
        SELECT ${proposalColumns} FROM listing_matches WHERE sell_listing_id = $1 AND buy_listing_id = $2 FOR UPDATE
      `, [sell.id, buy.id]);
      if (existing && existing.status !== 'VOID') throw new ConflictException(existing.status === 'DECLINED'
        ? 'Сторона уже отклонила это совпадение' : 'Совпадение уже есть');
      await this.checkComment(client, [sell.owner_id, buy.owner_id], comment);
      const clock = await this.jobs.clock(client);
      await this.checkQuotas(client, actor, ids, clock);
      const explanation = this.explain(pair, clock.day, await matchingRates(client));
      const { failures, terms } = explanation;
      const mismatches = [...failures.map(({ key, text }) => ({ key, text })), ...terms.mismatches];
      const { rows: [match] } = await client.query<MatchRow>(`
        INSERT INTO listing_matches(sell_listing_id, buy_listing_id, seller_id, buyer_id, type, mismatches,
          common_terms, common_methods, gap, source, operator_comment, proposed_by, proposed_at, operator_failures, operator_model_id,
          seller_notified_at, buyer_notified_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'OPERATOR',$10,$11,now(),$12,$13,now(),now())
        ON CONFLICT (sell_listing_id, buy_listing_id) DO UPDATE SET
          type = EXCLUDED.type, mismatches = EXCLUDED.mismatches, common_terms = EXCLUDED.common_terms,
          common_methods = EXCLUDED.common_methods, gap = EXCLUDED.gap, source = EXCLUDED.source,
          operator_comment = EXCLUDED.operator_comment, proposed_by = EXCLUDED.proposed_by,
          proposed_at = EXCLUDED.proposed_at, operator_failures = EXCLUDED.operator_failures, operator_model_id = EXCLUDED.operator_model_id,
          seller_notified_at = now(), buyer_notified_at = now(), seller_first_action_at = NULL, buyer_first_action_at = NULL,
          status = 'NEW', previous_status = NULL, void_reason = NULL, chat_id = NULL, initial_batch = false, updated_at = now()
        WHERE listing_matches.status = 'VOID'
        RETURNING ${proposalColumns}
      `, [sell.id, buy.id, sell.owner_id, buy.owner_id, failures.length ? 'PARTIAL' : 'FULL', JSON.stringify(mismatches),
        terms.commonTerms, terms.commonMethods, terms.gap, comment, actor.id, JSON.stringify(failures), guessedModel(pair)?.id ?? null]);
      if (!match) throw new ConflictException('Совпадение уже есть');
      await auditExchange(client, actor, 'matches', match.id, 'propose', existing ?? null, { ...ids, ...match, failures });
      await this.announce(client, match, sell, buy, mismatches, comment);
      await this.announce(client, match, buy, sell, mismatches, comment);
      return { matchId: match.id, number: match.number, type: match.type };
    });
    this.cache.clear();
    return result;
  }

  async dismiss(actor: StaffSession, raw: unknown, restore = false) {
    const input = object(raw);
    const { sellListingId, buyListingId } = parseIds(input);
    const note = !restore && input.note !== undefined ? str(input.note, 'Заметка', 0, 500) || null : null;
    await this.db.transaction(async client => {
      await lockTrustStaff(client, actor);
      const pair = [sellListingId, buyListingId];
      const { rows: [change] } = restore ? await client.query(`
        DELETE FROM near_miss_dismissals WHERE sell_listing_id = $1 AND buy_listing_id = $2 RETURNING *
      `, pair) : await client.query(`
        INSERT INTO near_miss_dismissals (sell_listing_id, buy_listing_id, dismissed_by, note)
        SELECT s.id, b.id, $3, $4 FROM listings s, listings b
        WHERE s.id = $1 AND s.kind = 'SELL' AND b.id = $2 AND b.kind = 'BUY' AND s.owner_id <> b.owner_id
        ON CONFLICT DO NOTHING RETURNING *
      `, [...pair, actor.id, note]);
      if (!change) {
        if (restore) throw new NotFoundException('Скрытая пара не найдена');
        const hidden = await client.query('SELECT 1 FROM near_miss_dismissals WHERE sell_listing_id = $1 AND buy_listing_id = $2', pair);
        if (!hidden.rowCount) throw new NotFoundException('Пара не найдена');
        return;
      }
      await auditExchange(client, actor, 'matches', pair.join('/'), restore ? 'restore' : 'dismiss', restore ? change : null,
        restore ? null : change, note);
    });
    this.cache.clear();
    return { ok: true };
  }

  private explain(pair: CandidatePair, day: string, rates: Awaited<ReturnType<typeof matchingRates>>) {
    return explainListings(pair.sell, pair.buy, day, rates, { sell: pair.sell.model, buy: pair.buy.model });
  }

  private async visibleCandidates(client: PoolClient, ids: string[] | null = null): Promise<Candidate[]> {
    const { rows } = await client.query<VisibleListing>(`
      ${operatorEligibleListings} SELECT * FROM operator_eligible
      WHERE ($1::uuid[] IS NULL OR id = ANY($1::uuid[])) ORDER BY confirmed_at DESC NULLS LAST, id
    `, [ids]);
    // Resolve each distinct free-form title once with the public suggestion ranking.
    const suggestions = new Map<string, string | null>();
    const effectiveIds: (string | null)[] = [];
    for (const listing of rows) {
      if (listing.model_id) {
        effectiveIds.push(listing.model_id);
        continue;
      }
      const signature = JSON.stringify([listing.category_slug, listing.title]);
      if (!suggestions.has(signature)) {
        const { rows: [suggestion] } = await client.query<{ id: string }>(modelSuggestionsQuery('$1', '$2', '1'),
          [listing.category_slug, listing.title]);
        suggestions.set(signature, suggestion?.id ?? null);
      }
      effectiveIds.push(suggestions.get(signature) ?? null);
    }
    const { rows: models } = await client.query<MatchModel>(`
      SELECT m.id, m.name_ru AS "nameRu", m.name_en AS "nameEn",
        ARRAY(SELECT group_id FROM model_analog_group_members WHERE model_id = m.id ORDER BY group_id) AS groups
      FROM hardware_models m WHERE m.id = ANY($1::text[]) AND m.status = 'ACTIVE'
    `, [[...new Set(effectiveIds.filter(id => id !== null))]]);
    const lookup = new Map(models.map(model => [model.id, model]));
    return rows.map((row, index) => ({ ...row, model: lookup.get(effectiveIds[index] ?? '') ?? null }));
  }

  private async findPairs(client: PoolClient, filters: {
    maxFailures: number; maxPriceOver: number; modelId: string | null; key: string | null; dismissed: boolean;
  }) {
    await client.query('SET LOCAL jit = off');
    const { day } = await this.jobs.clock(client);
    const rates = await matchingRates(client);
    const candidates = await this.visibleCandidates(client);
    const sellers = candidates.filter(side => side.kind === 'SELL' && side.model);
    const buyers = candidates.filter(side => side.kind === 'BUY' && side.model);
    if (!sellers.length || !buyers.length) return [];
    const ids = [sellers.map(sell => sell.id), buyers.map(buy => buy.id)];
    const { rows: saved } = await client.query<{ sell_listing_id: string; buy_listing_id: string }>(`
      SELECT sell_listing_id, buy_listing_id FROM listing_matches
      WHERE sell_listing_id = ANY($1::uuid[]) AND buy_listing_id = ANY($2::uuid[])
    `, ids);
    const { rows: hidden } = await client.query<{ sell_listing_id: string; buy_listing_id: string; note: string | null }>(`
      SELECT sell_listing_id, buy_listing_id, note FROM near_miss_dismissals
      WHERE sell_listing_id = ANY($1::uuid[]) AND buy_listing_id = ANY($2::uuid[])
    `, ids);
    const matches = new Set(saved.map(row => pairKey(row.sell_listing_id, row.buy_listing_id)));
    const dismissals = new Map(hidden.map(row => [pairKey(row.sell_listing_id, row.buy_listing_id), row.note]));
    const sellersByModel = new Map<string, Candidate[]>();
    for (const seller of sellers) for (const key of modelKeys(seller.model!)) {
      const entries = sellersByModel.get(key);
      if (entries) entries.push(seller);
      else sellersByModel.set(key, [seller]);
    }

    const byFailureCount: NearResult[][] = Array.from({ length: filters.maxFailures }, () => []);
    for (const buy of buyers) {
      const options = [...new Set(modelKeys(buy.model!).flatMap(key => sellersByModel.get(key) ?? []))]
        .sort((left, right) => left.id.localeCompare(right.id));
      for (const sell of options) {
        const key = pairKey(sell.id, buy.id);
        if (matches.has(key) || dismissals.has(key) !== filters.dismissed || sell.owner_id === buy.owner_id
          || !counterpartyEligible(sell, buy)
          || (filters.modelId && sell.model?.id !== filters.modelId && buy.model?.id !== filters.modelId)) continue;
        const pair = { sell, buy, note: dismissals.get(key) ?? null };
        const { failures, priceOver } = this.explain(pair, day, rates);
        if (!failures.length || failures.length > filters.maxFailures || (priceOver !== null && priceOver > filters.maxPriceOver)
          || failures.some(item => item.key === 'MODEL_INCOMPATIBLE' || item.key === 'INVALID_PAIR')
          || (filters.key && !failures.some(item => item.key === filters.key))) continue;
        const group = byFailureCount[failures.length - 1];
        if (group.length < maximumPairs) group.push(presentPair(pair, failures));
        if (byFailureCount[0].length === maximumPairs) return byFailureCount[0];
      }
    }
    return byFailureCount.flat().slice(0, maximumPairs);
  }

  private async checkComment(client: PoolClient, ownerIds: string[], comment: string) {
    const { rows } = await client.query<{ names: (string | null)[] }>(`
      SELECT ARRAY[display_name, company_name, telegram, username] AS names FROM users WHERE id = ANY($1::uuid[])
      UNION ALL SELECT ARRAY[name, company] FROM user_principals WHERE user_id = ANY($1::uuid[])
    `, [ownerIds]);
    const value = normalized(comment);
    if (rows.flatMap(row => row.names).some(name => name && normalized(name) && value.includes(normalized(name)))) {
      throw new BadRequestException('Комментарий раскрывает участника');
    }
  }

  private async checkQuotas(client: PoolClient, actor: StaffSession, ids: PairIds, clock: ExchangeClock) {
    const { rows: [quota] } = await client.query<{ daily: number; sell: number; buy: number }>(`
      SELECT count(*) FILTER (WHERE actor_user_id = $1 AND created_at >= ($2::date::timestamp AT TIME ZONE $3))::int AS daily,
        count(*) FILTER (WHERE after_data->>'sellListingId' = $4)::int AS sell,
        count(*) FILTER (WHERE after_data->>'buyListingId' = $5)::int AS buy
      FROM moderation_audit WHERE entity = 'matches' AND action = 'propose' AND created_at > now() - interval '7 days'
    `, [actor.id, clock.day, clock.timezone, ids.sellListingId, ids.buyListingId]);
    if (quota.daily >= 50) throw new HttpException('Слишком много предложений за сутки', 429);
    if (quota.sell >= 3 || quota.buy >= 3) throw new ConflictException('По этому объявлению уже было 3 предложения за неделю');
  }

  private async announce(client: PoolClient, match: MatchRow, mine: Candidate, other: Candidate,
    mismatches: { key: string; text: string }[], comment: string) {
    const formatter = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: other.currency });
    const price = other.price === null ? null : Number(other.price);
    const unitPrice = price === null ? 'договорная цена' : `${formatter.format(price)} за шт.`;
    const fullPrice = price !== null && other.quantity > 1 ? `${formatter.format(price * other.quantity)} за ${other.quantity} шт.` : null;
    const location = matchRegion(other.kind === 'SELL' ? other.origin_country : other.destination_country);
    const details = [other.model?.nameRu, `${other.quantity} шт.`, location, unitPrice, fullPrice].filter(Boolean).join(', ');
    const differences = mismatches.length ? `\nНе сошлось: ${mismatches.map(item => item.text).join('. ')}` : '';
    await this.notifications.notify(client, mine.owner_id, {
      kind: 'match.new', title: 'Модератор предлагает совпадение',
      body: `По вашему объявлению «${mine.title}»: ${details}.${differences}\nКомментарий модератора: ${comment}`,
      payload: { count: 1, matchIds: [match.id] }, dedupeKey: `match.new:operator:${match.id}:${match.proposedAt.toISOString()}`,
      channels: ['EMAIL'], actions: await this.matching.announcementActions(client, match.id, mine.owner_id, '/matches/' + match.id, match.proposedAt),
    });
  }
}
