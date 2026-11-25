import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { DatabaseService, type Queryable } from '../database/database.service'
import { isStaffRole, type SessionUser, type StaffSession } from '../auth/auth.types'
import { outsideContact } from '../contact'
import { auditExchange } from '../exchange/audit'
import { ExchangeNotifications } from '../exchange/notifications'
import { escapedSearch, integer, object, oneOf, pageParams, Parameters as SqlParameters, slug, str, uuid } from '../market/market.inputs'
import { hardwareModelId, validateListingModels } from './model-listings'

const modelStatuses = ['ACTIVE', 'PENDING', 'DISABLED'] as const
const formFactors = ['SXM', 'PCIe', 'NVL', 'OAM', 'rack'] as const

export interface HardwareModelRow {
  id: string; nameRu: string; nameEn: string; categorySlug: string; family: string | null
  gpuCount: number | null; gpuModel: string | null; memoryGb: number | null; formFactor: string | null
  status: typeof modelStatuses[number]; sortOrder: number; familyLabel: string | null; familyOrder: number | null
}

interface AdministrativeModel extends HardwareModelRow {
  aliases: string[]; pciIds: string[]; source: string[]; proposedBy: string | null; proposedAt: Date | null
  approvedAt: Date | null; analogGroupId: string | null; listingCount: number
}

export interface ModelSuggestion { id: string; nameRu: string; matchedAlias: string; score: number }

const modelColumns = `
  m.id, m.name_ru AS "nameRu", m.name_en AS "nameEn", m.category_slug AS "categorySlug", m.family,
  m.gpu_count AS "gpuCount", m.gpu_model AS "gpuModel", m.memory_gb AS "memoryGb", m.form_factor AS "formFactor",
  m.status, m.sort_order AS "sortOrder", f.label_ru AS "familyLabel", f.sort_order AS "familyOrder"
`
const adminColumns = `${modelColumns}, m.pci_ids AS "pciIds", m.source, m.proposed_by AS "proposedBy",
  m.proposed_at AS "proposedAt", m.approved_at AS "approvedAt",
  (SELECT min(g.group_id) FROM model_analog_group_members g WHERE g.model_id = m.id) AS "analogGroupId",
  coalesce((SELECT array_agg(a.alias ORDER BY a.alias) FROM hardware_model_aliases a WHERE a.model_id = m.id), '{}') AS aliases,
  (SELECT count(*)::int FROM listings l WHERE l.model_id = m.id) AS "listingCount"`
const modelOrder = `f.sort_order NULLS LAST, m.sort_order, m.name_ru, m.id`
const aliasesMatch = `a.words <> '{}' AND a.words <@ search.words`
const parentsBySlug = `
  WITH RECURSIVE parents AS (
    SELECT id, slug, parent_id FROM categories WHERE slug = $1
    UNION ALL SELECT c.id, c.slug, c.parent_id FROM categories c JOIN parents p ON p.parent_id = c.id
  )`

function familyGroups(models: HardwareModelRow[]) {
  const groups = new Map<string, { key: string; label: string; models: HardwareModelRow[] }>()
  for (const model of models) {
    const key = model.family ?? ''
    const group = groups.get(key) ?? { key, label: model.familyLabel ?? 'Без семейства', models: [] }
    group.models.push(model)
    groups.set(key, group)
  }
  return [...groups.values()]
}

function normalizedModelName(input: unknown, min: number, max: number) {
  const name = str(input, 'Название модели', min, max).replace(/\s+/g, ' ')
  if (name.length < min || outsideContact(name)) throw new BadRequestException('Укажите название модели без контактов и ссылок')
  return name
}

function modelSlug(name: string) {
  const letters: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l',
    м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
    щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  }
  const value = [...name.toLowerCase()].map(letter => letters[letter] ?? letter).join('').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '')
  return value.length >= 2 ? value : 'model'
}

function parsePciIds(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 256 || input.some(id => typeof id !== 'string' || !/^[0-9a-f]{4}:[0-9a-f]{4}$/i.test(id))) {
    throw new BadRequestException('Укажите коды PCI в формате vendor:device')
  }
  return [...new Set(input.map(id => String(id).toLowerCase()))]
}

function boundedList(input: unknown, label: string, maxItems: number, maxLength: number) {
  if (!Array.isArray(input) || input.length > maxItems) throw new BadRequestException(`${label}: максимум ${maxItems} значений`)
  return [...new Set(input.map(value => str(value, label, 1, maxLength)))]
}

function isUniqueViolation(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
}

@Injectable()
export class ModelsService {
  constructor(private readonly db: DatabaseService, private readonly notifications: ExchangeNotifications) {}

  async browse(user: SessionUser, query: Record<string, unknown>) {
    const params = new SqlParameters()
    const filters = [`(m.status = 'ACTIVE' OR (m.status = 'PENDING' AND m.proposed_by = ${params.add(user.id)}))`]
    let parents = ''
    if (query.category) {
      params.add(slug(query.category, 'Категория'))
      // parentsBySlug has a fixed first parameter, so substitute its calculated position.
      parents = parentsBySlug.replace('$1', '$2')
      filters.push('m.category_slug IN (SELECT slug FROM parents)')
    }
    if (query.family) {
      const family = params.add(str(query.family, 'Семейство', 1, 40))
      filters.push(`(f.key = ${family} OR f.code = ${family})`)
    }
    if (query.q) {
      const term = str(query.q, 'Поиск модели', 1, 200)
      const pattern = params.add(escapedSearch(term))
      const words = params.add(term)
      filters.push(`(m.name_ru ILIKE ${pattern} OR m.name_en ILIKE ${pattern} OR m.search_words @> market_search_words(${words})
        OR EXISTS (SELECT 1 FROM hardware_model_aliases a WHERE a.model_id = m.id
          AND (a.alias ILIKE ${pattern} OR a.words @> market_search_words(${words}))))`)
    }
    const { rows } = await this.db.query<HardwareModelRow>(`
      ${parents}
      SELECT ${modelColumns} FROM hardware_models m LEFT JOIN model_families f ON f.key = m.family
      WHERE ${filters.join(' AND ')} ORDER BY ${modelOrder} LIMIT 500
    `, params.values)
    return { families: familyGroups(rows) }
  }

  suggest(query: Record<string, unknown>) {
    const term = str(query.q, 'Поиск модели', 2, 200)
    const category = query.category ? slug(query.category, 'Категория') : null
    return this.suggestions(this.db, term, category).then(items => ({ items }))
  }

  async suggestions(client: Queryable, text: string, category: string | null, limit = 5) {
    const { rows } = await client.query<ModelSuggestion>(`
      ${parentsBySlug}, search AS (SELECT market_search_words($2) AS words)
      SELECT id, "nameRu", "matchedAlias", score FROM (
        SELECT DISTINCT ON (m.id) m.id, m.name_ru AS "nameRu", a.alias AS "matchedAlias",
          cardinality(a.words) AS score, m.sort_order
        FROM hardware_model_aliases a JOIN hardware_models m ON m.id = a.model_id CROSS JOIN search
        WHERE m.status = 'ACTIVE' AND ($1::text IS NULL OR m.category_slug IN (SELECT slug FROM parents)) AND ${aliasesMatch}
        ORDER BY m.id, cardinality(a.words) DESC, a.alias
      ) matched ORDER BY score DESC, sort_order, id LIMIT $3
    `, [category, text, limit])
    return rows
  }

  async analogs(user: SessionUser, idInput: string) {
    const id = hardwareModelId(idInput)
    const { rows: [selected] } = await this.db.query<{ category_slug: string }>(`
      SELECT category_slug FROM hardware_models WHERE id = $1 AND (status = 'ACTIVE'
        OR (status = 'PENDING' AND proposed_by = $2))
    `, [id, user.id])
    if (!selected) throw new NotFoundException('Модель не найдена')
    const { rows } = await this.db.query<HardwareModelRow & { similar: boolean }>(`
      SELECT ${modelColumns}, EXISTS (SELECT 1 FROM model_analog_group_members a
        JOIN model_analog_group_members b USING (group_id) WHERE a.model_id = m.id AND b.model_id = $1) AS similar
      FROM hardware_models m LEFT JOIN model_families f ON f.key = m.family
      WHERE m.status = 'ACTIVE' AND m.category_slug = $2 AND m.id <> $1 ORDER BY ${modelOrder} LIMIT 500
    `, [id, selected.category_slug])
    return { group: rows.filter(row => row.similar), others: familyGroups(rows.filter(row => !row.similar)).map(row => ({ ...row, family: row.label })) }
  }

  async proposal(user: SessionUser, raw: unknown) {
    const input = object(raw)
    const name = normalizedModelName(input.name, 3, 80)
    const category = slug(input.category, 'Категория')
    return this.db.transaction(async client => {
      await this.lockCatalog(client)
      const activeUser = await client.query(`SELECT id FROM users WHERE id = $1 AND status = 'ACTIVE' AND email_verified_at IS NOT NULL FOR SHARE`, [user.id])
      if (!activeUser.rowCount) throw new ForbiddenException('Профиль недоступен')
      const categorySlug = await this.modelCategory(client, category)
      const { rows: [existing] } = await client.query<HardwareModelRow & { proposedBy: string | null }>(`
        SELECT ${modelColumns}, m.proposed_by AS "proposedBy" FROM hardware_models m
        LEFT JOIN model_families f ON f.key = m.family WHERE lower(m.name_ru) = lower($1)
      `, [name])
      if (existing) {
        if (existing.status === 'DISABLED') throw new ConflictException('Такая модель есть в справочнике, но выключена модератором')
        if (existing.status === 'PENDING' && existing.proposedBy !== user.id) {
          throw new ConflictException('Модель с таким названием уже ожидает проверки')
        }
        const { proposedBy: _, ...model } = existing
        return { model, existing: true }
      }
      const { rows: [count] } = await client.query<{ total: number }>(`
        SELECT count(*)::int AS total FROM hardware_models WHERE proposed_by = $1 AND status = 'PENDING'
      `, [user.id])
      if (count.total >= 5) throw new ConflictException('Уже 5 ваших моделей ждут модератора')
      const base = modelSlug(name)
      let id = base
      let suffix = 2
      while ((await client.query('SELECT 1 FROM hardware_models WHERE id = $1', [id])).rowCount) id = `${base}-${suffix++}`
      await client.query(`
        INSERT INTO hardware_models (id, name_ru, name_en, category_slug, status, proposed_by, proposed_at)
        VALUES ($1, $2, $2, $3, 'PENDING', $4, now())
      `, [id, name, categorySlug, user.id])
      await client.query('INSERT INTO hardware_model_aliases (model_id, alias) VALUES ($1, $2)', [id, name])
      await this.notifyAdministrators(client, { kind: 'model.proposed', title: 'Новая модель ждёт проверки', body: `${name} (${categorySlug})`, payload: { modelId: id } })
      return { model: await this.readVisible(client, id), existing: false }
    })
  }

  async adminOptions() {
    const [families, groups, categories] = await Promise.all([
      this.db.query('SELECT key, code, label_ru AS label FROM model_families ORDER BY sort_order, code'),
      this.db.query(`SELECT id, family_code AS "familyCode", category_slug AS "categorySlug", rack
        FROM model_analog_groups ORDER BY category_slug, id`),
      this.db.query(`SELECT DISTINCT c.slug, c.name FROM categories c JOIN hardware_models m ON m.category_slug = c.slug ORDER BY c.name`),
    ])
    return { families: families.rows, groups: groups.rows, categories: categories.rows }
  }

  async adminList(query: Record<string, unknown>) {
    const { page, limit, offset } = pageParams(query)
    const params = new SqlParameters()
    const filters: string[] = []
    if (query.status) filters.push(`m.status = ${params.add(oneOf(query.status, modelStatuses, 'Статус'))}`)
    if (query.q) {
      const pattern = params.add(escapedSearch(query.q))
      filters.push(`(m.name_ru ILIKE ${pattern} OR m.name_en ILIKE ${pattern} OR m.id ILIKE ${pattern}
        OR EXISTS (SELECT 1 FROM hardware_model_aliases a WHERE a.model_id = m.id AND a.alias ILIKE ${pattern}))`)
    }
    const from = `FROM hardware_models m LEFT JOIN model_families f ON f.key = m.family ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}`
    const [items, count] = await Promise.all([
      this.db.query<AdministrativeModel>(`SELECT ${adminColumns} ${from} ORDER BY m.sort_order, m.id LIMIT $${params.values.length + 1} OFFSET $${params.values.length + 2}`, [...params.values, limit, offset]),
      this.db.query<{ total: number }>(`SELECT count(*)::int AS total ${from}`, params.values),
    ])
    return { items: items.rows, total: count.rows[0].total, page, limit }
  }

  async readAdmin(client: Queryable, id: string): Promise<AdministrativeModel> {
    const { rows: [model] } = await client.query<AdministrativeModel>(`
      SELECT ${adminColumns} FROM hardware_models m LEFT JOIN model_families f ON m.family = f.key WHERE m.id = $1
    `, [hardwareModelId(id)])
    if (!model) throw new NotFoundException('Модель не найдена')
    return model
  }

  async save(actor: StaffSession, id: string | null, raw: unknown) {
    return this.staffWrite(actor, async client => {
      const before = id ? await this.readAdmin(client, id) : null
      const saved = await this.saveModel(client, before, object(raw))
      await auditExchange(client, actor, 'models', saved.id, before ? 'edited' : 'created', before, saved)
      const { rows: aliasConflicts } = await client.query(`
        SELECT DISTINCT a.alias, a.model_id AS "modelId" FROM hardware_model_aliases a
        JOIN hardware_model_aliases b ON b.words = a.words AND b.model_id = $1
        WHERE a.model_id <> $1 AND a.words <> '{}' ORDER BY a.alias, a.model_id LIMIT 50
      `, [saved.id])
      return { ...saved, aliasConflicts }
    })
  }

  async saveModel(client: Queryable, before: AdministrativeModel | null, input: Record<string, unknown>) {
    const next: Record<string, unknown> = { ...before, ...input }
    const nameRu = normalizedModelName(next.nameRu, 2, 120)
    const nameEn = normalizedModelName(next.nameEn, 2, 120)
    const id = before?.id ?? hardwareModelId(next.id || modelSlug(nameEn))
    if (before && input.id !== undefined && input.id !== id) throw new BadRequestException('Код существующей модели изменить нельзя')
    const category = slug(next.categorySlug, 'Категория модели')
    const categorySlug = await this.modelCategory(client, category)
    if (categorySlug !== category) throw new BadRequestException('Выберите основную категорию модели')
    if (before && categorySlug !== before.categorySlug && (await client.query(`
      SELECT 1 FROM listings WHERE model_id = $1 OR analog_model_ids @> ARRAY[$1]::text[] LIMIT 1
    `, [id])).rowCount) throw new ConflictException('Уберите ссылки из объявлений перед изменением категории модели')
    const family = next.family ? str(next.family, 'Семейство', 1, 40) : null
    if (family && !(await client.query('SELECT 1 FROM model_families WHERE key = $1', [family])).rowCount) {
      throw new BadRequestException('Семейство не найдено')
    }
    const gpuCount = next.gpuCount == null || next.gpuCount === '' ? null : integer(next.gpuCount, 'Количество GPU', 1, 1000)
    const gpuModel = next.gpuModel ? normalizedModelName(next.gpuModel, 1, 60) : null
    const memory = next.memoryGb == null || next.memoryGb === '' ? null : integer(next.memoryGb, 'Видеопамять', 1, 100000)
    const form = next.formFactor ? oneOf(next.formFactor, formFactors, 'Форм-фактор') : null
    const group = next.analogGroupId ? slug(next.analogGroupId, 'Группа аналогов') : null
    if (group && !(await client.query(`
      SELECT 1 FROM model_analog_groups g JOIN model_families f ON f.code = g.family_code
      WHERE g.id = $1 AND g.category_slug = $2 AND g.rack = $3 AND f.key = $4
    `, [group, categorySlug, form === 'rack', family])).rowCount) {
      throw new BadRequestException('Группа аналогов не соответствует категории, семейству или форм-фактору')
    }
    const pciIds = parsePciIds(next.pciIds ?? [])
    await this.checkPciOwnership(client, id, pciIds)
    const source = boundedList(next.source ?? [], 'Источник', 16, 1000)
    const aliases = boundedList(next.aliases ?? [], 'Псевдоним', 80, 80)
    const allAliases = [...new Set([...aliases, nameRu.slice(0, 80), nameEn.slice(0, 80)])]
    if (allAliases.some(outsideContact)) throw new BadRequestException('Уберите контакты из псевдонимов')
    const sort = next.sortOrder == null || next.sortOrder === '' ? 1000 : integer(next.sortOrder, 'Порядок', 0, 100000)
    const values = [id, nameRu, nameEn, categorySlug, family, gpuCount, gpuModel, memory, form, pciIds, source, sort]
    if (before) {
      await client.query(`UPDATE hardware_models SET name_ru = $2, name_en = $3, category_slug = $4, family = $5,
        gpu_count = $6, gpu_model = $7, memory_gb = $8, form_factor = $9, pci_ids = $10,
        source = $11, sort_order = $12, updated_at = now() WHERE id = $1`, values)
    } else {
      await client.query(`INSERT INTO hardware_models (id, name_ru, name_en, category_slug, family, gpu_count, gpu_model,
        memory_gb, form_factor, pci_ids, source, sort_order, approved_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())`, values)
    }
    await client.query('DELETE FROM hardware_model_aliases WHERE model_id = $1', [id])
    await client.query(`INSERT INTO hardware_model_aliases (model_id, alias) SELECT $1, unnest($2::text[])`, [id, allAliases])
    await client.query('DELETE FROM model_analog_group_members WHERE model_id = $1', [id])
    if (group) await client.query('INSERT INTO model_analog_group_members (group_id, model_id) VALUES ($1,$2)', [group, id])
    return this.readAdmin(client, id)
  }

  async approve(actor: StaffSession, id: string, raw: unknown) {
    const input = object(raw ?? {})
    const reason = input.reason ? str(input.reason, 'Причина', 3, 500) : null
    return this.staffWrite(actor, async client => {
      await this.requireStandaloneDecision(client, id)
      return this.approveModel(client, actor, id, reason)
    })
  }

  async approveModel(client: Queryable, actor: StaffSession, id: string, reason: string | null) {
    const before = await this.readAdmin(client, id)
    if (before.status !== 'PENDING') throw new ConflictException('Модель уже рассмотрена')
    await client.query(`UPDATE hardware_models SET status = 'ACTIVE', approved_at = now(), updated_at = now() WHERE id = $1`, [id])
    const after = await this.readAdmin(client, id)
    await auditExchange(client, actor, 'models', id, 'approved', before, after, reason)
    if (before.proposedBy) await this.notifications.notify(client, before.proposedBy, {
      kind: 'model.approved', title: 'Модель добавлена в справочник', body: `Модель «${after.nameRu}» добавлена. Площадка начала искать совпадения для ваших объявлений.`,
      payload: { modelId: id }, dedupeKey: `model-approved:${id}`,
    })
    return after
  }

  async merge(actor: StaffSession, id: string, raw: unknown) {
    const input = object(raw)
    const target = hardwareModelId(input.intoModelId)
    const reason = str(input.reason, 'Причина', 3, 500)
    return this.staffWrite(actor, async client => {
      await this.requireStandaloneDecision(client, id)
      return this.mergeModel(client, actor, id, target, reason)
    })
  }

  async mergeModel(client: Queryable, actor: StaffSession, id: string, target: string, reason: string) {
    if (id === target) throw new BadRequestException('Выберите другую модель для объединения')
    const [before, into] = await Promise.all([this.readAdmin(client, id), this.readAdmin(client, target)])
    if (before.status !== 'PENDING' || into.status !== 'ACTIVE' || before.categorySlug !== into.categorySlug) {
      throw new ConflictException('Объединить можно ожидающую проверки модель с действующей моделью той же категории')
    }
    const moved = await client.query(`UPDATE listings l SET
      model_id = CASE WHEN l.model_id = $1 THEN $2 ELSE l.model_id END,
      analog_model_ids = ARRAY(SELECT CASE WHEN a.id = $1 THEN $2 ELSE a.id END
        FROM unnest(l.analog_model_ids) WITH ORDINALITY a(id, position)
        WHERE (CASE WHEN a.id = $1 THEN $2 ELSE a.id END) <> (CASE WHEN l.model_id = $1 THEN $2 ELSE l.model_id END)
        GROUP BY 1 ORDER BY min(a.position)), updated_at = now()
      WHERE l.model_id = $1 OR l.analog_model_ids @> ARRAY[$1]::text[]`, [id, target])
    await client.query(`UPDATE hardware_models SET status = 'DISABLED', updated_at = now() WHERE id = $1`, [id])
    await client.query(`INSERT INTO hardware_model_aliases (model_id, alias)
      SELECT $2, alias FROM hardware_model_aliases WHERE model_id = $1 ON CONFLICT DO NOTHING`, [id, target])
    await auditExchange(client, actor, 'models', id, 'merge', before, { intoModelId: target, moved: moved.rowCount ?? 0 }, reason)
    if (before.proposedBy) await this.notifications.notify(client, before.proposedBy, {
      kind: 'model.merged', title: 'Модели объединены', body: `Модель «${before.nameRu}» объединена с «${into.nameRu}». Ваши объявления переведены на неё.`,
      payload: { modelId: target }, dedupeKey: `model-merged:${id}`,
    })
    return { moved: moved.rowCount ?? 0 }
  }

  async status(actor: StaffSession, id: string, raw: unknown) {
    const input = object(raw)
    const status = oneOf(input.status, ['ACTIVE', 'DISABLED'], 'Статус')
    const reason = str(input.reason, 'Причина', 3, 500)
    return this.staffWrite(actor, async client => {
      const before = await this.readAdmin(client, id)
      await this.requireStandaloneDecision(client, id)
      if (before.status === 'PENDING' && status === 'ACTIVE') throw new ConflictException('Для новой модели используйте одобрение')
      if (before.status === status) return before
      await client.query(`UPDATE hardware_models SET status = $2, updated_at = now() WHERE id = $1`, [id, status])
      await auditExchange(client, actor, 'models', id, 'status-changed', { status: before.status }, { status }, reason)
      if (status === 'DISABLED') {
        const { rows } = await client.query<{ owner_id: string }>(`SELECT DISTINCT owner_id FROM listings
          WHERE status = 'ACTIVE' AND (model_id = $1 OR analog_model_ids @> ARRAY[$1]::text[])`, [id])
        for (const row of rows) await this.notifications.notify(client, row.owner_id, {
          kind: 'model.disabled', title: 'Модель выключена в справочнике', body: `Модель «${before.nameRu}» выключена. Выберите другую в объявлении.`,
          payload: { modelId: id },
        })
      }
      return this.readAdmin(client, id)
    })
  }

  async backfillPreview(query: Record<string, unknown>) {
    const { page, limit, offset } = pageParams(query, 20)
    const candidates = await this.db.query<{ id: string; title: string; slug: string }>(`
      SELECT l.id, l.title, c.slug FROM listings l JOIN categories c ON c.id = l.category_id
      WHERE l.model_id IS NULL AND EXISTS (
        WITH RECURSIVE parents AS (SELECT id, slug, parent_id FROM categories WHERE id = c.id
          UNION ALL SELECT n.id,n.slug,n.parent_id FROM categories n JOIN parents p ON n.id = p.parent_id)
        SELECT 1 FROM hardware_models WHERE category_slug IN (SELECT slug FROM parents))
      ORDER BY l.created_at DESC, l.id LIMIT $1 OFFSET $2
    `, [limit + 1, offset])
    const items = []
    for (const row of candidates.rows.slice(0, limit)) {
      const [found] = await this.suggestions(this.db, row.title, row.slug, 1)
      if (found) items.push({ listingId: row.id, title: row.title, suggestedModelId: found.id, matchedAlias: found.matchedAlias })
    }
    return { items, page, limit, hasMore: candidates.rows.length > limit }
  }

  async backfillApply(actor: StaffSession, raw: unknown) {
    const input = object(raw)
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) {
      throw new BadRequestException('Выберите от 1 до 100 объявлений')
    }
    const entries = input.items.map(row => {
      const entry = object(row)
      return [uuid(entry.listingId), hardwareModelId(entry.modelId)] as const
    })
    return this.staffWrite(actor, async client => {
      let changed = 0
      for (const [id, modelId] of new Map(entries)) {
        const { rows: [listing] } = await client.query<{ owner_id: string; category_id: string; kind: 'BUY' | 'SELL'; model_id: string | null }>(`
          SELECT owner_id, category_id, kind, model_id FROM listings WHERE id = $1 FOR UPDATE
        `, [id])
        if (!listing) throw new NotFoundException('Объявление не найдено')
        if (listing.model_id) continue
        if ((await this.readAdmin(client, modelId)).status !== 'ACTIVE') throw new BadRequestException('Выберите действующую модель')
        await validateListingModels(client, { modelId }, {}, listing.category_id, listing.kind, listing.owner_id)
        await client.query(`UPDATE listings SET model_id = $2, updated_at = now() WHERE id = $1`, [id, modelId])
        await auditExchange(client, actor, 'models', modelId, 'backfill', { listingId: id, modelId: null }, { listingId: id, modelId })
        changed += 1
      }
      return { changed }
    })
  }

  async modelCategory(client: Queryable, slug: string) {
    const { rows: [root] } = await client.query<{ slug: string }>(`
      ${parentsBySlug} SELECT p.slug FROM parents p WHERE EXISTS (SELECT 1 FROM hardware_models m WHERE m.category_slug = p.slug) LIMIT 1
    `, [slug])
    if (!root) throw new BadRequestException('Справочник доступен для ускорителей и GPU-серверов')
    return root.slug
  }

  async checkPciOwnership(client: Queryable, id: string, pciIds: string[]) {
    if (pciIds.length && (await client.query(`SELECT 1 FROM hardware_models WHERE id <> $1 AND pci_ids && $2::text[] LIMIT 1`, [id, pciIds])).rowCount) {
      throw new ConflictException('Один из кодов PCI уже относится к другой модели')
    }
  }

  async notifyAdministrators(client: Queryable, notice: Parameters<ExchangeNotifications['notify']>[2]) {
    const { rows } = await client.query<{ id: string }>(`SELECT id FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'`)
    for (const user of rows) await this.notifications.notify(client, user.id, notice)
  }

  async lockCatalog(client: Queryable): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(18403, 18)')
  }

  async staffWrite<T>(actor: StaffSession, write: (client: Queryable) => Promise<T>) {
    if (!isStaffRole(actor.role)) throw new ForbiddenException('Действие доступно сотрудникам модерации')
    try {
      return await this.db.transaction(async client => {
        const valid = await client.query(`SELECT 1 FROM users WHERE id = $1 AND role = $2 AND status = 'ACTIVE'
          AND email_verified_at IS NOT NULL AND NOT must_change_password FOR SHARE`, [actor.id, actor.role])
        const session = await client.query(`SELECT 1 FROM auth_sessions WHERE user_id = $1 AND token_hash = $2
          AND expires_at > clock_timestamp() FOR SHARE`, [actor.id, actor.sessionHash])
        if (!valid.rowCount || !session.rowCount) throw new ForbiddenException('Сеанс сотрудника завершён. Войдите снова.')
        await this.lockCatalog(client)
        return write(client)
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Код или название модели уже заняты')
      throw error
    }
  }

  private async requireStandaloneDecision(client: Queryable, id: string) {
    if ((await client.query(`SELECT 1 FROM catalog_sync_items
      WHERE model_id = $1 AND kind = 'NEW_MODEL' AND status = 'PENDING' LIMIT 1`, [hardwareModelId(id)])).rowCount) {
      throw new ConflictException('Рассмотрите модель в очереди обновлений каталога')
    }
  }

  private async readVisible(client: Queryable, id: string) {
    const { rows: [model] } = await client.query<HardwareModelRow>(`
      SELECT ${modelColumns} FROM hardware_models m LEFT JOIN model_families f ON f.key = m.family WHERE m.id = $1
    `, [id])
    return model
  }
}
