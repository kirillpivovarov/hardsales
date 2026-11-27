import type { Queryable } from '../database/database.service'

export const disclosureDocuments = [
  { kind: 'COMPANY_CARD', label: 'Карточка компании' },
  { kind: 'SIGNATORY', label: 'Кто подписывает' },
] as const
export type VerificationSource = 'DOCUMENTS' | 'OPERATOR_KNOWN' | 'DEAL'
type DocumentStatus = 'MISSING' | 'PENDING' | 'APPROVED' | 'REJECTED'

export function verificationLevelName(level: number, source: VerificationSource | null) {
  if (level === 2) return 'Сделка подтверждена'
  if (level === 1) return source === 'OPERATOR_KNOWN' ? 'Проверен оператором' : 'Документы проверены'
  return 'Участник не проверен'
}

export async function verificationRequirements(db: Queryable, userId: string) {
  const { rows: [member] } = await db.query<{
    level: number; source: VerificationSource | null; agent: boolean; approved: boolean
    principalId: string | null; principalAddress: string | null; pendingMail: boolean
    companyCard: DocumentStatus | null; signatory: DocumentStatus | null
  }>(`
    SELECT u.verification_level AS level, u.verification_source AS source, u.representation_mode<>'DIRECT' AS agent,
      EXISTS (SELECT 1 FROM user_principals p WHERE p.user_id=u.id AND p.confirmed_via='EMAIL'
        AND p.confirmed_at IS NOT NULL AND p.removed_at IS NULL) AS approved,
      principal.id AS "principalId", principal.email AS "principalAddress",
      EXISTS (SELECT 1 FROM company_email_letters pc JOIN action_tokens token USING(token_hash)
        WHERE pc.principal_id=principal.id AND pc.status='SENT' AND token.expires_at>now()) AS "pendingMail",
      cards.company_card AS "companyCard", cards.signatory
    FROM users u
    LEFT JOIN LATERAL (
      SELECT id,email FROM user_principals WHERE user_id=u.id AND removed_at IS NULL
      ORDER BY (email IS NOT NULL) DESC, created_at, id LIMIT 1
    ) principal ON true
    LEFT JOIN LATERAL (
      SELECT max(status) FILTER (WHERE kind='COMPANY_CARD') AS company_card,
        max(status) FILTER (WHERE kind='SIGNATORY') AS signatory
      FROM (
        SELECT DISTINCT ON (kind) kind,status FROM verification_documents WHERE user_id=u.id
          AND kind IN ('COMPANY_CARD','SIGNATORY') AND listing_id IS NULL AND principal_id IS NULL
        ORDER BY kind, CASE status WHEN 'APPROVED' THEN 0 WHEN 'PENDING' THEN 1 ELSE 2 END, uploaded_at DESC
      ) current_documents
    ) cards ON true
    WHERE u.id=$1
  `, [userId])
  const requirements = disclosureDocuments.map((item, index) => ({
    ...item, status: (index === 0 ? member?.companyCard : member?.signatory) ?? 'MISSING',
  }))
  const principalEmail = {
    required: member?.agent === true,
    status: member?.approved ? 'APPROVED' : member?.pendingMail ? 'PENDING' : 'MISSING',
    principalId: member?.principalId ?? null,
    hasAddress: Boolean(member?.principalAddress),
  }
  const eligible = requirements.every(item => item.status === 'APPROVED')
    && (!principalEmail.required || principalEmail.status === 'APPROVED')
  const level = member?.level ?? 0
  return { level, source: member?.source ?? null, levelName: verificationLevelName(level, member?.source ?? null),
    requirements, principalEmail, eligible }
}
