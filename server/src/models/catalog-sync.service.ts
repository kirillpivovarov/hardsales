import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common'
import { createHash } from 'node:crypto'
import type { StaffSession } from '../auth/auth.types'
import { demoMode, flag, appOrigin } from '../config'
import { DatabaseService, type Queryable } from '../database/database.service'
import { auditExchange } from '../exchange/audit'
import { ExchangeJobs } from '../exchange/jobs'
import { PlatformSettings } from '../exchange/platform-settings'
import { object, oneOf, pageParams, Parameters, str } from '../market/market.inputs'
import { hardwareModelId } from './model-listings'
import { ModelsService } from './models.service'
import {
  calendarWeek, CatalogPayloadError, catalogSources, eligiblePciName, parsePciIds, readCatalogBody,
  retryDelay, serverSignals, sourceUrl, type CatalogSource,
} from './catalog-sources'

const itemKinds = ['NEW_MODEL', 'LINK_PCI', 'RENAMED', 'GONE', 'SIGNAL'] as const
const itemStatuses = ['PENDING', 'ACCEPTED', 'REJECTED'] as const
const decisions = ['ACCEPT', 'MERGE', 'LINK', 'REJECT', 'ACK'] as const
const pagesSources = ['NVIDIA_PAGES', 'WIKIPEDIA_DGX'] as const

const manualJobs: Record<CatalogSource, string> = {
  PCI_IDS: 'catalog.pci', NVIDIA_PAGES: 'catalog.servers.nvidia', WIKIPEDIA_DGX: 'catalog.servers.wiki',
}

interface Clock { now: Date; timezone: string; day: string; hour: number }
type CheckStatus = 'OK' | 'NOT_MODIFIED' | 'FAILED' | 'REJECTED'
type ItemKind = typeof itemKinds[number]

interface SourceRow {
  code: CatalogSource; urls: string[]; last_successful_slot: string | null
}

interface UrlState {
  etag: string | null; last_modified: string | null; content_sha256: string | null; content_bytes: number | null
  last_successful_slot: string | null; retry_at: Date | null; last_status: CheckStatus | null
}

interface Download {
  status: CheckStatus; retryAfterMs?: number; error?: string; bytes?: number | null; hash?: string | null
  etag?: string | null; lastModified?: string | null; text?: string
}

interface Totals extends Record<string, number> { newModels: number; links: number; signals: number; notices: number }

interface QueueItem {
  id: string; source: CatalogSource; kind: ItemKind; externalId: string; rawName: string; codename: string | null
  modelId: string | null; status: typeof itemStatuses[number]; note: string | null
}

const sourceColumns = `code, urls, etag, last_modified AS "lastModified", content_bytes AS "contentBytes",
  last_checked_at AS "lastCheckedAt", last_changed_at AS "lastChangedAt", last_status AS "lastStatus",
  last_error AS "lastError", consecutive_failures AS "consecutiveFailures"`
const itemColumns = `i.id::text AS id, i.source, i.kind, i.external_id AS "externalId", i.raw_name AS "rawName", i.codename,
  i.model_id AS "modelId", i.status, i.first_seen_at AS "firstSeenAt", i.last_seen_at AS "lastSeenAt", i.note,
  i.decided_at AS "decidedAt", i.decided_by AS "decidedBy"`

@Injectable()
export class CatalogSyncService implements OnModuleInit {
  constructor(private readonly db: DatabaseService, private readonly jobs: ExchangeJobs,
    private readonly settings: PlatformSettings, private readonly models: ModelsService) {}

  onModuleInit() {
    const enabled = async () => (!demoMode() || flag('CATALOG_SYNC_IN_DEMO')) && this.settings.enabled('feature_catalog_sync')
    const policy = { enabled, maxAttempts: 3, minRetryMs: 60 * 60 * 1000 }
    this.jobs.register({ ...policy, name: 'catalog.pci', lock: 15,
      slot: clock => clock.hour >= 4 ? clock.day : null,
      run: (client, clock) => this.run(client, clock, ['PCI_IDS']),
    })
    this.jobs.register({ ...policy, name: 'catalog.servers', lock: 16,
      slot: clock => new Date(`${clock.day}T00:00:00Z`).getUTCDay() !== 1 || clock.hour >= 5 ? calendarWeek(clock.day) : null,
      run: (client, clock) => this.run(client, clock, [...pagesSources]),
    })
    for (const code of pagesSources) this.jobs.register({ ...policy, name: manualJobs[code], lock: 16,
      slot: () => null, run: (client, clock) => this.run(client, clock, [code]),
    })
  }

  async items(query: Record<string, unknown>) {
    const { page, limit, offset } = pageParams(query)
    const params = new Parameters()
    const filters = []
    if (query.status) filters.push(`i.status = ${params.add(oneOf(query.status, itemStatuses, 'Статус'))}`)
    if (query.kind) filters.push(`i.kind = ${params.add(oneOf(query.kind, itemKinds, 'Тип'))}`)
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const [items, count, pending] = await Promise.all([
      this.db.query<QueueItem>(`SELECT ${itemColumns}, m.name_ru AS "modelName", m.category_slug AS "modelCategory"
        FROM catalog_sync_items i LEFT JOIN hardware_models m ON m.id = i.model_id ${where}
        ORDER BY i.first_seen_at DESC, i.id DESC LIMIT $${params.values.length + 1} OFFSET $${params.values.length + 2}`,
      [...params.values, limit, offset]),
      this.db.query<{ total: number }>(`SELECT count(*)::int AS total FROM catalog_sync_items i ${where}`, params.values),
      this.db.query<{ total: number }>(`SELECT count(*)::int AS total FROM catalog_sync_items WHERE status = 'PENDING'`),
    ])
    return { items: items.rows, total: count.rows[0].total, page, limit, pending: pending.rows[0].total }
  }

  async sources() {
    const { rows } = await this.db.query(`SELECT ${sourceColumns}, (
      SELECT jsonb_agg(jsonb_build_object('url', configured.url, 'etag', u.etag, 'contentBytes', u.content_bytes,
        'lastStatus', u.last_status, 'lastCheckedAt', u.last_checked_at, 'lastError', u.last_error) ORDER BY configured.position)
      FROM unnest(s.urls) WITH ORDINALITY configured(url, position)
      LEFT JOIN catalog_sync_urls u ON u.source = s.code AND u.url = configured.url
    ) AS "urlChecks" FROM catalog_sync_sources s ORDER BY code`)
    return rows
  }

  async saveSource(actor: StaffSession, codeInput: string, raw: unknown) {
    if (actor.role !== 'ADMIN') throw new ForbiddenException('Изменение источников доступно администратору')
    const code = oneOf(codeInput, catalogSources, 'Источник')
    const input = object(raw)
    if (!Array.isArray(input.urls) || input.urls.length < 1 || input.urls.length > 5 ||
      (code === 'WIKIPEDIA_DGX' && input.urls.length !== 1)) {
      throw new BadRequestException('Укажите от одного до пяти адресов, для Википедии один')
    }
    const urls = [...new Set(input.urls.map(value => sourceUrl(code, value)))]
    return this.models.staffWrite(actor, async client => {
      const { rows: [previous] } = await client.query<{ urls: string[] }>('SELECT urls FROM catalog_sync_sources WHERE code = $1', [code])
      const { rows: [current] } = await client.query(`UPDATE catalog_sync_sources SET urls = $2 WHERE code = $1
        RETURNING ${sourceColumns}`, [code, urls])
      await auditExchange(client, actor, 'catalog_sync', code, 'source-edited', previous, { urls })
      return current
    })
  }

  async runNow(actor: StaffSession, raw: unknown) {
    if (actor.role !== 'ADMIN') throw new ForbiddenException('Проверить источник вручную может администратор')
    if ((demoMode() && !flag('CATALOG_SYNC_IN_DEMO')) || !await this.settings.enabled('feature_catalog_sync')) {
      throw new ConflictException('Синхронизация каталога выключена')
    }
    const code = oneOf(object(raw).source, catalogSources, 'Источник')
    await this.models.staffWrite(actor, client => auditExchange(client, actor, 'catalog_sync', code, 'manual-run-requested'))
    const clock = await this.jobs.clock()
    return this.jobs.runNow(manualJobs[code], code === 'PCI_IDS' ? clock.day : calendarWeek(clock.day))
  }

  async decide(actor: StaffSession, id: string, raw: unknown) {
    if (!/^[1-9]\d{0,17}$/.test(id)) throw new BadRequestException('Неверный идентификатор элемента очереди')
    const input = object(raw)
    const decision = oneOf(input.decision, decisions, 'Решение')
    const note = input.note ? str(input.note, 'Примечание', 1, 1000) : null
    return this.models.staffWrite(actor, async client => {
      const { rows: [item] } = await client.query<QueueItem>(`SELECT ${itemColumns} FROM catalog_sync_items i WHERE i.id = $1 FOR UPDATE`, [id])
      if (!item) throw new NotFoundException('Элемент обновления не найден')
      if (item.status !== 'PENDING') throw new ConflictException('Элемент уже рассмотрен')
      let model = item.modelId ? await this.models.readAdmin(client, item.modelId) : null
      if (decision === 'ACCEPT' && item.kind === 'NEW_MODEL' && model) {
        const patch = input.modelPatch ? object(input.modelPatch) : {}
        model = await this.models.saveModel(client, model, { ...patch, pciIds: [...model.pciIds, item.externalId] })
        model = await this.models.approveModel(client, actor, model.id, note)
      } else if (decision === 'MERGE' && item.kind === 'NEW_MODEL' && model) {
        const target = hardwareModelId(input.intoModelId)
        await this.linkPci(client, target, item.externalId)
        await this.models.mergeModel(client, actor, model.id, target, note ?? 'Модель объединена по данным PCI ID')
        model = await this.models.readAdmin(client, target)
      } else if (decision === 'LINK' && item.kind === 'LINK_PCI' && model) {
        model = await this.linkPci(client, model.id, item.externalId)
      } else if (decision === 'REJECT') {
        if (item.kind === 'NEW_MODEL' && model?.status === 'PENDING') {
          await client.query(`UPDATE hardware_models SET status = 'DISABLED', updated_at = now() WHERE id = $1`, [model.id])
          model = await this.models.readAdmin(client, model.id)
        }
      } else if (decision !== 'ACK' || !['RENAMED', 'GONE', 'SIGNAL'].includes(item.kind)) {
        throw new BadRequestException('Решение не подходит для этого типа обновления')
      }
      const status = decision === 'REJECT' ? 'REJECTED' : 'ACCEPTED'
      const { rows: [updated] } = await client.query<QueueItem>(`UPDATE catalog_sync_items i SET status = $2,
        decided_by = $3, decided_at = now(), note = coalesce($4, note), model_id = coalesce($5, model_id)
        WHERE id = $1 RETURNING ${itemColumns}`, [id, status, actor.id, note, model?.id ?? null])
      await auditExchange(client, actor, 'catalog_sync', id, decision.toLowerCase(), item, updated, note)
      return { item: updated, model }
    })
  }

  private async linkPci(client: Queryable, modelId: string, pciId: string) {
    const model = await this.models.readAdmin(client, modelId)
    if (model.status !== 'ACTIVE') throw new ConflictException('Код можно привязать только к действующей модели')
    await this.models.checkPciOwnership(client, modelId, [pciId])
    await client.query(`UPDATE hardware_models SET pci_ids = array_append(pci_ids, $2), updated_at = now()
      WHERE id = $1 AND NOT ($2 = ANY(pci_ids))`, [modelId, pciId])
    return this.models.readAdmin(client, modelId)
  }

  private async run(client: Queryable, clock: Clock, codes: CatalogSource[]) {
    const stats: Totals = { newModels: 0, links: 0, signals: 0, notices: 0 }
    let failed = false
    let wait = 0
    let rejected = 0
    for (const code of codes) {
      const result = await this.checkSource(client, clock, code, stats)
      if (result.status === 'FAILED') {
        failed = true
        wait = Math.max(wait, result.retryAfterMs ?? 0)
      }
      if (result.status === 'REJECTED') rejected += 1
    }
    if (stats.newModels || stats.links || stats.signals || stats.notices) {
      await this.models.notifyAdministrators(client, { kind: 'catalog_sync.updated', title: 'Обновления каталога',
        body: `Новых моделей: ${stats.newModels}, привязок кода: ${stats.links}, сигналов по серверам: ${stats.signals}, других изменений: ${stats.notices}.`,
      })
    }
    const result = { ...stats, rejected }
    return failed ? { ...result, jobStatus: 'FAILED' as const, retryAfterMs: wait } : result
  }

  private async checkSource(client: Queryable, clock: Clock, code: CatalogSource, stats: Totals): Promise<Download> {
    const { rows: [source] } = await client.query<SourceRow>(`SELECT code, urls, last_successful_slot FROM catalog_sync_sources WHERE code = $1`, [code])
    const slot = code === 'PCI_IDS' ? clock.day : calendarWeek(clock.day)
    if (source.last_successful_slot === slot) return { status: 'NOT_MODIFIED' }
    const results: Download[] = []
    for (const raw of source.urls) {
      const url = sourceUrl(code, raw)
      const result = await this.checkUrl(client, clock, code, url, slot, stats)
      results.push(result)
      if (code === 'PCI_IDS' && result.status !== 'FAILED') break
    }
    const status = results.find(item => item.status === 'FAILED') ? 'FAILED' : results.find(item => item.status === 'REJECTED') ? 'REJECTED'
      : results.some(item => item.status === 'OK') ? 'OK' : 'NOT_MODIFIED'
    const aggregate = code === 'PCI_IDS' ? results.at(-1)! : results.find(item => item.status === status) ?? results[0]
    await this.saveSourceHealth(client, code, slot, clock, aggregate)
    return aggregate
  }

  private async checkUrl(client: Queryable, clock: Clock, code: CatalogSource, url: string, slot: string, stats: Totals): Promise<Download> {
    const previous = await client.query<UrlState>(`SELECT etag, last_modified, content_sha256, content_bytes,
      last_successful_slot, retry_at, last_status FROM catalog_sync_urls WHERE source = $1 AND url = $2`, [code, url])
    const state = previous.rows[0]
    if (state?.last_successful_slot === slot) return { status: 'NOT_MODIFIED' }
    if (state?.retry_at && state.retry_at.getTime() > clock.now.getTime()) {
      return { status: 'FAILED', retryAfterMs: state.retry_at.getTime() - clock.now.getTime(), error: 'Источник попросил отложить запрос' }
    }
    const claim = await client.query(`INSERT INTO catalog_sync_urls (source, url, request_day, requests)
      VALUES ($1,$2,$3,1) ON CONFLICT(source,url) DO UPDATE SET request_day = $3,
        requests = CASE WHEN catalog_sync_urls.request_day = $3 THEN catalog_sync_urls.requests + 1 ELSE 1 END
      WHERE catalog_sync_urls.request_day IS DISTINCT FROM $3 OR catalog_sync_urls.requests < 4 RETURNING 1`, [code, url, clock.day])
    if (!claim.rowCount) return { status: 'FAILED', error: 'Достигнут суточный лимит запросов к адресу' }
    let result: Download
    try {
      result = await this.download(url, clock.now, state)
      if (result.status === 'OK') {
        if (code === 'PCI_IDS') await this.importPci(client, clock, url, result.text!, stats)
        else await this.importSignals(client, code, url, result.text!, stats)
      }
    } catch (error) {
      if (!(error instanceof CatalogPayloadError)) throw error
      result = { status: 'REJECTED', error: error.message }
    }
    await this.saveUrlHealth(client, code, url, slot, clock, result)
    return result
  }

  private async download(url: string, now: Date, state: UrlState | undefined): Promise<Download> {
    const origin = appOrigin()
    const headers: Record<string, string> = { 'User-Agent': `hwforai-catalog-sync/1.0${origin ? ` (+${origin})` : ''}`, 'Accept-Encoding': 'gzip' }
    if (state?.etag) headers['If-None-Match'] = state.etag
    if (state?.last_modified) headers['If-Modified-Since'] = state.last_modified
    try {
      const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) })
      const etag = response.headers.get('etag')?.slice(0, 1000) ?? null
      const lastModified = response.headers.get('last-modified')?.slice(0, 1000) ?? null
      if (response.status === 304) {
        return { status: 'NOT_MODIFIED', etag: etag ?? state?.etag, lastModified: lastModified ?? state?.last_modified,
          hash: state?.content_sha256, bytes: state?.content_bytes }
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {})
        return { status: 'FAILED', error: `HTTP ${response.status}`,
          retryAfterMs: response.status === 429 ? retryDelay(response.headers.get('retry-after'), now) ?? undefined : undefined }
      }
      const body = await readCatalogBody(response)
      const hash = createHash('sha256').update(body).digest('hex')
      return { status: hash === state?.content_sha256 ? 'NOT_MODIFIED' : 'OK', etag, lastModified,
        hash, bytes: body.byteLength, text: body.toString('utf8') }
    } catch (error) {
      if (error instanceof CatalogPayloadError) throw error
      return { status: 'FAILED', error: 'Сетевой сбой при загрузке источника' }
    }
  }

  private async importPci(client: Queryable, clock: Clock, url: string, text: string, stats: Totals) {
    const configured = await this.settings.get<string[]>('catalog_sync_vendors', client)
    const vendors = [...new Set(['10de', ...(Array.isArray(configured) ? configured.filter(code => /^[0-9a-f]{4}$/.test(code)) : [])])]
    const devices = parsePciIds(text, vendors)
    if ([...devices.values()].filter(device => device.vendor === '10de').length < 1000) {
      throw new CatalogPayloadError('Файл PCI ID содержит менее 1000 устройств NVIDIA')
    }
    await this.models.lockCatalog(client)
    const owners = await client.query<{ id: string; pci_ids: string[]; name_ru: string }>(`
      SELECT id, pci_ids, name_ru FROM hardware_models WHERE cardinality(pci_ids) > 0 ORDER BY id
    `)
    const type = new Map<string, typeof owners.rows[number]>()
    for (const row of owners.rows) for (const id of row.pci_ids) if (vendors.includes(id.slice(0, 4))) type.set(id, row)
    const observations = await client.query<{ pci_id: string; raw_name: string | null; missing_since: Date | null }>(`
      SELECT pci_id, raw_name, missing_since FROM catalog_sync_pci_observations
    `)
    const oldById = new Map(observations.rows.map(row => [row.pci_id, row]))
    const seenOwners = new Set<string>()
    for (const [id, owner] of type) {
      const device = devices.get(id)
      const previous = oldById.get(id)
      if (device) {
        seenOwners.add(owner.id)
        const name = device.names.includes(previous?.raw_name ?? '') ? previous?.raw_name : device.names.find(eligiblePciName) ?? device.names[0]
        await client.query(`INSERT INTO catalog_sync_pci_observations (pci_id, raw_name) VALUES ($1,$2)
          ON CONFLICT(pci_id) DO UPDATE SET raw_name = coalesce(EXCLUDED.raw_name,catalog_sync_pci_observations.raw_name), missing_since = NULL`, [id, name ?? null])
        if (name && previous?.raw_name && name !== previous.raw_name) {
          if (await this.upsertItem(client, 'PCI_IDS', 'RENAMED', id, name, device.codename, owner.id, url)) stats.notices += 1
        }
      } else if (!previous?.missing_since) {
        await client.query(`INSERT INTO catalog_sync_pci_observations (pci_id, missing_since) VALUES ($1,$2)
          ON CONFLICT(pci_id) DO UPDATE SET missing_since = EXCLUDED.missing_since`, [id, clock.now])
      } else if (clock.now.getTime() - previous.missing_since.getTime() >= 30 * 86400 * 1000) {
        if (await this.upsertItem(client, 'PCI_IDS', 'GONE', id, previous.raw_name ?? owner.name_ru, null, owner.id, url)) stats.notices += 1
      }
    }
    if (seenOwners.size) await client.query('UPDATE hardware_models SET pci_last_seen_at = $2 WHERE id = ANY($1)', [[...seenOwners], clock.now])
    const { rows: [gpu] } = await client.query<{ category_slug: string }>("SELECT category_slug FROM hardware_models WHERE id = 'h100-sxm'")
    for (const device of devices.values()) {
      if (type.has(device.id)) continue
      const names = device.names.filter(eligiblePciName)
      if (!names.length) continue
      const prior = await client.query(`UPDATE catalog_sync_items SET last_seen_at = now()
        WHERE source = 'PCI_IDS' AND kind IN ('NEW_MODEL','LINK_PCI') AND external_id = $1 RETURNING 1`, [device.id])
      if (prior.rowCount) continue
      const candidates = await Promise.all(names.map(name => this.models.suggestions(client, name, gpu.category_slug, 1)))
      const matched = candidates.map(([item], index) => ({ item, name: names[index] }))
        .filter(row => row.item).sort((a, b) => b.item.score - a.item.score)[0]
      if (matched) {
        if (await this.upsertItem(client, 'PCI_IDS', 'LINK_PCI', device.id, matched.name, device.codename, matched.item.id, url)) stats.links += 1
        continue
      }
      const proposedId = `pci-${device.id.replace(':', '-')}`
      const name = names[0]
      const duplicate = await client.query('SELECT 1 FROM hardware_models WHERE lower(name_ru) = lower($1)', [name])
      const modelName = duplicate.rowCount ? `${name.slice(0, 102)} (${device.id})` : name
      await client.query(`INSERT INTO hardware_models (id,name_ru,name_en,category_slug,status,source,proposed_at)
        VALUES ($1,$2,$2,$4,'PENDING',ARRAY[$3],now()) ON CONFLICT (id) DO NOTHING`, [proposedId, modelName, url, gpu.category_slug])
      await client.query(`INSERT INTO hardware_model_aliases (model_id,alias) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [proposedId, name.slice(0, 80)])
      if (await this.upsertItem(client, 'PCI_IDS', 'NEW_MODEL', device.id, name, device.codename, proposedId, url)) stats.newModels += 1
    }
  }

  private async importSignals(client: Queryable, code: CatalogSource, url: string, text: string, stats: Totals) {
    const names = serverSignals(code, text)
    if (!names.length) return
    const { rows } = await client.query<{ key: string; name: string }>(`
      WITH names AS (SELECT name, market_search_words(name) AS words FROM unnest($1::text[]) AS name)
      SELECT DISTINCT ON (key) array_to_string(words, ' ') AS key, name FROM names
      WHERE cardinality(words) > 0 AND NOT EXISTS (SELECT 1 FROM hardware_model_aliases a
        JOIN hardware_models m ON m.id = a.model_id WHERE m.category_slug = (SELECT category_slug FROM hardware_models WHERE id = 'hgx-h100-8') AND m.status = 'ACTIVE' AND names.words <@ a.words)
      ORDER BY key, name
    `, [names])
    for (const row of rows) if (await this.upsertItem(client, code, 'SIGNAL', row.key, row.name, null, null, url)) stats.signals += 1
  }

  private async upsertItem(client: Queryable, code: CatalogSource, kind: ItemKind, key: string, name: string,
    codename: string | null, modelId: string | null, url: string): Promise<boolean> {
    const inserted = await client.query(`INSERT INTO catalog_sync_items (source,kind,external_id,raw_name,codename,model_id,note)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source,kind,external_id) DO NOTHING RETURNING 1`, [code, kind, key, name, codename, modelId, url])
    if (inserted.rowCount) return true
    await client.query(`UPDATE catalog_sync_items SET last_seen_at = now(),
      raw_name = CASE WHEN status = 'PENDING' THEN $4 ELSE raw_name END WHERE source = $1 AND kind = $2 AND external_id = $3`, [code, kind, key, name])
    return false
  }

  private async saveSourceHealth(client: Queryable, code: CatalogSource, slot: string, clock: Clock, result: Download) {
    const { rows: [current] } = await client.query<{ consecutive_failures: number; last_failure_day: string | null }>(`
      UPDATE catalog_sync_sources SET last_checked_at = $3, last_status = $4, last_error = $5,
        etag = CASE WHEN $4 IN ('OK','NOT_MODIFIED') THEN $6 ELSE etag END,
        last_modified = CASE WHEN $4 IN ('OK','NOT_MODIFIED') THEN $7 ELSE last_modified END,
        content_sha256 = CASE WHEN $4 IN ('OK','NOT_MODIFIED') THEN coalesce($8,content_sha256) ELSE content_sha256 END,
        content_bytes = CASE WHEN $4 IN ('OK','NOT_MODIFIED') THEN coalesce($9,content_bytes) ELSE content_bytes END,
        last_changed_at = CASE WHEN $4 = 'OK' THEN $3 ELSE last_changed_at END,
        last_successful_slot = CASE WHEN $4 IN ('OK','NOT_MODIFIED') THEN $2 ELSE last_successful_slot END,
        consecutive_failures = CASE WHEN $4 <> 'FAILED' THEN 0 WHEN last_failure_day = $10 THEN consecutive_failures
          WHEN last_failure_day = $10::date - 1 THEN consecutive_failures + 1 ELSE 1 END,
        last_failure_day = CASE WHEN $4 = 'FAILED' THEN $10 ELSE NULL END WHERE code = $1
      RETURNING consecutive_failures, last_failure_day::text
    `, [code, slot, clock.now, result.status, result.error ?? null, result.etag ?? null, result.lastModified ?? null,
      result.hash ?? null, result.bytes ?? null, clock.day])
    if (result.status === 'REJECTED') await this.models.notifyAdministrators(client, {
      kind: 'catalog_sync.rejected', title: 'Файл каталога отклонён', body: `${code}: ${result.error ?? 'проверка источника не пройдена'}.`,
      dedupeKey: `catalog-sync-rejected:${code}:${slot}`,
    })
    if (current.consecutive_failures >= 3) await this.models.notifyAdministrators(client, {
      kind: 'catalog_sync.unavailable', title: 'Источник каталога недоступен', body: `Источник ${code} недоступен три дня подряд.`,
      dedupeKey: `catalog-sync-unavailable:${code}:${current.last_failure_day}`,
      channels: ['EMAIL'],
    })
  }

  private async saveUrlHealth(client: Queryable, code: CatalogSource, url: string, slot: string, clock: Clock, result: Download) {
    const retryAt = result.retryAfterMs ? new Date(clock.now.getTime() + result.retryAfterMs) : null
    await client.query(`UPDATE catalog_sync_urls SET last_checked_at = $4, last_status = $5, last_error = $6, retry_at = $7,
      last_successful_slot = CASE WHEN $5 IN ('OK','NOT_MODIFIED') THEN $3 ELSE last_successful_slot END,
      etag = CASE WHEN $5 IN ('OK','NOT_MODIFIED') THEN $8 ELSE etag END,
      last_modified = CASE WHEN $5 IN ('OK','NOT_MODIFIED') THEN $9 ELSE last_modified END,
      content_sha256 = CASE WHEN $5 IN ('OK','NOT_MODIFIED') THEN coalesce($10,content_sha256) ELSE content_sha256 END,
      content_bytes = CASE WHEN $5 IN ('OK','NOT_MODIFIED') THEN coalesce($11,content_bytes) ELSE content_bytes END
      WHERE source = $1 AND url = $2`, [code, url, slot, clock.now, result.status, result.error ?? null, retryAt,
      result.etag ?? null, result.lastModified ?? null, result.hash ?? null, result.bytes ?? null])
  }
}
