import { BadRequestException } from '@nestjs/common'
import type { Queryable } from '../database/database.service'
import { boolean, oneOf, priceValue, uuid } from '../market/market.inputs'

export const feeKinds = ['PERCENT', 'PER_UNIT'] as const
export const feePayers = ['SELLER', 'BUYER', 'BOTH'] as const
export type AgentFee = { disclosed: boolean; kind: typeof feeKinds[number] | null; value: number | null; payer: typeof feePayers[number] | null }

export function agentFee(disclosed: unknown, kind: unknown, value: unknown, payer: unknown): AgentFee {
  if (disclosed === undefined || disclosed === null) {
    throw new BadRequestException('agentFee: Для агента укажите вознаграждение или «не раскрываю»')
  }
  if (!boolean(disclosed, 'Раскрытие вознаграждения')) return { disclosed: false, kind: null, value: null, payer: null }
  const type = oneOf(kind, feeKinds, 'Вид вознаграждения')
  const amount = priceValue(value, 'Размер вознаграждения', 0.01)
  if (amount > 9999999999.99 || (type === 'PERCENT' && amount > 100)) throw new BadRequestException('Укажите допустимый размер вознаграждения')
  return { disclosed: true, kind: type, value: amount, payer: oneOf(payer, feePayers, 'Плательщик вознаграждения') }
}

type ListingRepresentation = {
  representation: 'DIRECT' | 'AGENT'
  principalId: string | null
  agentFeeDisclosed: boolean | null
  agentFeeKind: AgentFee['kind']
  agentFeeValue: number | null
  agentFeePayer: AgentFee['payer']
}

export async function listingRepresentation(
  db: Queryable, userId: string, input: Record<string, unknown>, existing?: { id: string },
): Promise<ListingRepresentation> {
  const { rows: [owner] } = await db.query<{ mode: string; enabled: boolean }>(`
    SELECT representation_mode AS mode, EXISTS (SELECT 1 FROM platform_settings
      WHERE key = 'feature_representation' AND value = 'true'::jsonb) AS enabled FROM users WHERE id = $1
  `, [userId])
  if (!owner) throw new BadRequestException('Профиль объявления не найден')
  const { rows: [stored] } = existing ? await db.query<ListingRepresentation>(`
    SELECT representation, principal_id AS "principalId", agent_fee_disclosed AS "agentFeeDisclosed",
      agent_fee_kind AS "agentFeeKind", agent_fee_value::float8 AS "agentFeeValue",
      agent_fee_payer AS "agentFeePayer" FROM listings WHERE id = $1 AND owner_id = $2
  `, [existing.id, userId]) : { rows: [] }
  if (owner.enabled && owner.mode === 'BOTH' && input.representation === undefined && !existing) {
    throw new BadRequestException('Укажите, публикуете вы как прямая сторона или как агент')
  }
  const representation = oneOf(input.representation ?? stored?.representation ??
    (owner.enabled && owner.mode === 'AGENT' ? 'AGENT' : 'DIRECT'), ['DIRECT', 'AGENT'], 'Роль в объявлении')
  if (owner.enabled && owner.mode !== 'BOTH' && owner.mode !== representation) {
    throw new BadRequestException('Эта роль не указана в вашем профиле')
  }
  if (representation === 'DIRECT') return {
    representation, principalId: null, agentFeeDisclosed: null, agentFeeKind: null, agentFeeValue: null, agentFeePayer: null,
  }
  const principalInput = input.principalId ?? stored?.principalId
  if (!principalInput) throw new BadRequestException('principalId: Выберите, от чьего имени объявление')
  const principalId = uuid(principalInput, 'Принципал')
  const principal = await db.query(`
    SELECT p.id FROM user_principals p LEFT JOIN users principal ON principal.id = p.platform_user_id
    WHERE p.id = $1 AND p.user_id = $2 AND p.removed_at IS NULL
      AND coalesce(principal.representation_mode, 'DIRECT') <> 'AGENT'
    FOR SHARE OF p
  `, [principalId, userId])
  if (!principal.rowCount) throw new BadRequestException('principalId: Такого принципала нет в вашем профиле')
  const fee = agentFee(input.agentFeeDisclosed ?? stored?.agentFeeDisclosed, input.agentFeeKind ?? stored?.agentFeeKind,
    input.agentFeeValue ?? stored?.agentFeeValue, input.agentFeePayer ?? stored?.agentFeePayer)
  return { representation, principalId, agentFeeDisclosed: fee.disclosed, agentFeeKind: fee.kind, agentFeeValue: fee.value, agentFeePayer: fee.payer }
}

export const representationEnabled = "EXISTS (SELECT 1 FROM platform_settings WHERE key = 'feature_representation' AND value = 'true'::jsonb)"
export const verifiedPrincipal = `EXISTS (SELECT 1 FROM user_principals p WHERE p.id = l.principal_id AND
  p.user_id = l.owner_id AND p.confirmed_at IS NOT NULL AND p.removed_at IS NULL)`
const emailPrincipal = `EXISTS (SELECT 1 FROM user_principals p WHERE p.id = l.principal_id AND
  p.confirmed_via = 'EMAIL' AND p.removed_at IS NULL)`
const feeConfirmed = `u.agent_fee_confirmed_at IS NOT NULL AND u.agent_fee_kind = l.agent_fee_kind AND
  u.agent_fee_value = l.agent_fee_value AND u.agent_fee_payer = l.agent_fee_payer AND EXISTS (
    SELECT 1 FROM user_principals p WHERE p.id = l.principal_id AND p.confirmed_at IS NOT NULL AND
      p.fee_confirmed_at IS NOT NULL AND p.removed_at IS NULL
  )`
const feeVisible = "l.representation = 'AGENT' AND l.agent_fee_disclosed AND (u.agent_fee_banned_until IS NULL OR u.agent_fee_banned_until <= now())"

export function representationListingColumns() {
  return `
    CASE WHEN ${representationEnabled} THEN l.representation END AS representation,
    CASE WHEN ${representationEnabled} THEN l.agent_fee_disclosed END AS "agentFeeDisclosed",
    CASE WHEN ${representationEnabled} AND ${feeVisible} THEN l.agent_fee_kind END AS "agentFeeKind",
    CASE WHEN ${representationEnabled} AND ${feeVisible} THEN l.agent_fee_value::float8 END AS "agentFeeValue",
    CASE WHEN ${representationEnabled} AND ${feeVisible} THEN l.agent_fee_payer END AS "agentFeePayer"`
}

export function representationLabels() {
  return `CASE WHEN ${representationEnabled} THEN
    jsonb_build_array(jsonb_build_object('id', 'representation', 'text',
      CASE WHEN l.kind = 'SELL' AND l.representation = 'DIRECT' THEN 'Прямой продавец'
        WHEN l.kind = 'BUY' AND l.representation = 'DIRECT' THEN 'Прямой покупатель'
        WHEN l.kind = 'SELL' THEN 'Агент продавца' ELSE 'Агент покупателя' END,
      'tone', CASE WHEN l.representation = 'DIRECT' THEN 'ink' ELSE 'gray' END)) ||
    CASE WHEN l.representation = 'AGENT' AND ${verifiedPrincipal} THEN jsonb_build_array(
      jsonb_build_object('id', 'principal', 'text',
        CASE WHEN ${emailPrincipal} THEN 'Полномочия подтверждены по корпоративной почте' ELSE 'Полномочия подтверждены' END, 'tone', 'blue'))
      ELSE '[]'::jsonb END ||
    CASE WHEN u.company_email_confirmed_at IS NOT NULL AND u.company_email_domain_kind = 'CORPORATE' THEN jsonb_build_array(
      jsonb_build_object('id', 'email', 'text', 'Корпоративный адрес подтверждён', 'tone', 'blue')) ELSE '[]'::jsonb END ||
    CASE WHEN ${feeVisible} THEN jsonb_build_array(jsonb_build_object('id', 'fee', 'text',
      CASE WHEN ${feeConfirmed} THEN 'Вознаграждение подтверждено принципалом' ELSE 'Размер вознаграждения указан' END,
      'tone', CASE WHEN ${feeConfirmed} THEN 'blue' ELSE 'gray' END)) ELSE '[]'::jsonb END
    ELSE '[]'::jsonb END`
}

export function representationOwnerColumns() {
  return `(SELECT jsonb_build_object('id', p.id, 'number', p.number, 'name', p.name, 'company', p.company,
    'confirmed', p.confirmed_at IS NOT NULL, 'removed', p.removed_at IS NOT NULL)
    FROM user_principals p WHERE p.id = l.principal_id AND p.user_id = l.owner_id) AS principal,
    l.principal_id AS "principalId", l.representation AS representation,
    l.agent_fee_disclosed AS "agentFeeDisclosed", l.agent_fee_kind AS "agentFeeKind",
    l.agent_fee_value::float8 AS "agentFeeValue", l.agent_fee_payer AS "agentFeePayer"`
}
