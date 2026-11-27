import { BadRequestException } from '@nestjs/common'
import type { Queryable } from '../database/database.service'
import { boolean, type Parameters } from '../market/market.inputs'

export function hardwareModelId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{1,47}$/.test(value)) {
    throw new BadRequestException('Укажите корректный код модели')
  }
  return value
}

export const listingModelColumns = `
  l.model_id AS "modelId", l.analog_model_ids AS "analogModelIds",
  (SELECT ${listingModel('hm')} FROM hardware_models hm WHERE hm.id = l.model_id) AS model,
  COALESCE((SELECT jsonb_agg(${listingModel('hm')} ORDER BY m.position)
    FROM unnest(l.analog_model_ids) WITH ORDINALITY AS m(id, position)
    JOIN hardware_models hm ON hm.id = m.id), '[]'::jsonb) AS "analogModels"
`

function listingModel(alias: string): string {
  return `jsonb_build_object('id', ${alias}.id, 'nameRu', ${alias}.name_ru, 'nameEn', ${alias}.name_en,
    'categorySlug', ${alias}.category_slug, 'status', ${alias}.status, 'gpuCount', ${alias}.gpu_count,
    'memoryGb', ${alias}.memory_gb, 'formFactor', ${alias}.form_factor)`
}

interface ExistingListingModels {
  modelId?: unknown
  analogModelIds?: unknown
  categoryId?: unknown
}

export const modelRequiredMessage = 'Выберите модель из справочника. Без неё площадка не найдёт встречные объявления. Нет в списке: нажмите «Предложить модель».'

async function assertModelMayBeOmitted(client: Queryable, categoryId: string) {
  const { rows: [category] } = await client.query<{ required: boolean }>(
    'SELECT listing_model_required($1) AS required', [categoryId],
  )
  if (category.required) {
    throw new BadRequestException({ code: 'MODEL_REQUIRED', field: 'modelId', message: modelRequiredMessage })
  }
}

export async function validateListingModels(
  client: Queryable, patch: Record<string, unknown>, existing: ExistingListingModels,
  categoryId: string, kind: 'BUY' | 'SELL', ownerId: string,
): Promise<[string | null, string[]]> {
  const explicitModel = Object.hasOwn(patch, 'modelId')
  const explicitAnalogs = Object.hasOwn(patch, 'analogModelIds')
  const modelValue = explicitModel ? patch.modelId : existing.modelId
  const modelId = modelValue == null || modelValue === '' ? null : hardwareModelId(modelValue)
  const input = explicitAnalogs ? patch.analogModelIds : !explicitModel || modelId === existing.modelId ? existing.analogModelIds ?? [] : []
  if (!Array.isArray(input) || input.length > 30) throw new BadRequestException('Можно указать до 10 аналогов')
  const analogs = [...new Set(input.map(hardwareModelId))].filter(id => id !== modelId)
  if (analogs.length > 10) throw new BadRequestException('Можно указать до 10 аналогов')
  if (kind === 'SELL' && input.length > 0) throw new BadRequestException('Аналоги можно указать только в заявке')
  if (!modelId) {
    await assertModelMayBeOmitted(client, categoryId)
    if (analogs.length) throw new BadRequestException('Сначала выберите модель')
    return [null, []]
  }
  if (!explicitModel && !explicitAnalogs && categoryId === existing.categoryId) return [modelId, analogs]
  const { rows } = await client.query<{ id: string; category_slug: string; status: string; proposed_by: string | null; compatible: boolean }>(`
    WITH RECURSIVE parents AS (
      SELECT id, slug, parent_id FROM categories WHERE id = $1
      UNION ALL SELECT c.id, c.slug, c.parent_id FROM categories c JOIN parents p ON p.parent_id = c.id
    )
    SELECT id, category_slug, status, proposed_by, category_slug IN (SELECT slug FROM parents) AS compatible
    FROM hardware_models WHERE id = ANY($2::text[])
  `, [categoryId, [modelId, ...analogs]])
  const model = rows.find(row => row.id === modelId)
  if (!model || (model.status === 'PENDING' && model.proposed_by !== ownerId)) {
    throw new BadRequestException('Модели нет в справочнике')
  }
  if (!model.compatible) {
    if (!explicitModel && !explicitAnalogs && categoryId !== existing.categoryId) {
      await assertModelMayBeOmitted(client, categoryId)
      return [null, []]
    }
    throw new BadRequestException('Модель не из выбранной категории')
  }
  if (model.status === 'DISABLED' && modelId !== existing.modelId) {
    throw new BadRequestException('Модель выключена в справочнике')
  }
  const currentAnalogs = Array.isArray(existing.analogModelIds) ? existing.analogModelIds : []
  for (const id of analogs) {
    const analog = rows.find(row => row.id === id)
    if (!analog || analog.category_slug !== model.category_slug ||
      (analog.status !== 'ACTIVE' && !(modelId === existing.modelId && currentAnalogs.includes(id)))) {
      throw new BadRequestException('Выберите действующие аналоги из категории модели')
    }
  }
  return [modelId, analogs]
}

export function listingModelFilter(model: unknown, withAnalogs: unknown, params: Parameters): string {
  const selected = params.add(hardwareModelId(model))
  const include = withAnalogs === undefined || withAnalogs === '' ? false : boolean(withAnalogs, 'С аналогами')
  return !include ? `l.model_id = ${selected}` : `(
    l.model_id = ${selected} OR l.model_id IN (
      SELECT linked.model_id FROM model_analog_group_members chosen
      JOIN hardware_models active ON active.id = chosen.model_id AND active.status = 'ACTIVE'
      JOIN model_analog_group_members linked USING (group_id)
      JOIN hardware_models candidate ON candidate.id = linked.model_id AND candidate.status = 'ACTIVE'
      WHERE chosen.model_id = ${selected}
    )
  )`
}

/** Take this lock before locking any listing that may change its hardware references. */
export async function lockHardwareModelReferences(client: Queryable): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock_shared(18403, 18)')
}
