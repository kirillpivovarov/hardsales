import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api } from './api'
import { useExchange } from './Exchange'
import { useI18n } from './i18n'
import { Button, Field, Notice, Spinner } from './ui'
import './trust.css'

export const verificationLevels = ['Участник не проверен', 'Документы проверены', 'Сделка подтверждена'] as const
const ratingFactorLabels: Record<string, string> = {
  discipline: 'Ответы об актуальности', speed: 'Скорость ответа на совпадения',
  direct: 'Представительство', fees: 'Вознаграждение агента', tenure: 'Срок работы на площадке',
}

export type ListingTrust = {
  score: number | null
  ownerScore: number | null
  ownerLevel: number
  ownerLevelName: string
  ownerLevelSource?: 'OPERATOR_KNOWN' | 'DOCUMENTS' | 'DEAL' | null
  ownerDeals: number
  reliable: boolean
  proof: 'STOCK' | 'FUNDS' | null
  corridor: boolean
}
type DataState<T> = { path: string; version: number; data?: T; error?: string }

export function useTrustData<T>(path: string | null, version = 0, keepPreviousData = false) {
  const [state, setState] = useState<DataState<T>>()
  useEffect(() => {
    if (!path) return
    const controller = new AbortController()
    void api<T>(path, { signal: controller.signal }).then(
      data => { if (!controller.signal.aborted) setState({ path, version, data }) },
      error => { if (!controller.signal.aborted) setState({ path, version, error: (error as Error).message }) },
    )
    return () => controller.abort()
  }, [path, version])
  if (!path) return { loading: false }
  if (state?.path !== path) return { loading: true }
  if (state.version !== version) return { loading: true, data: keepPreviousData ? state.data : undefined }
  return { data: state.data, error: state.error, loading: false }
}

type PaymentTerm = {
  code: string
  label_ru: string
  when_ru: string
  seller_risk_ru: string
  buyer_risk_ru: string
  hint_ru: string
}
type PaymentRule = { id: string; seller_wants_ru: string; buyer_wants_ru: string; tool_ru: string }
type PaymentGuide = { terms: PaymentTerm[]; rules: PaymentRule[]; fallback: PaymentRule }

export function PaymentTerms({ selected = [] }: { selected?: readonly string[] }) {
  const { t } = useI18n()
  const { features } = useExchange()
  const active = features.feature_trust_rating === true
  const result = useTrustData<PaymentGuide>(active ? '/payment-terms' : null)
  if (!active) return null
  return <fieldset className="trust-payment-fields">
    <legend>{t('Условия оплаты')}</legend>
    <Link to="/info/payments" className="text-link">{t('Как выбрать условия оплаты')}</Link>
    {result.loading && <Spinner />}
    {result.error && <Notice tone="error">{t(result.error)}</Notice>}
    {!result.data && selected.map(code => <input key={code} name="paymentTerms" type="hidden" value={code} />)}
    {result.data?.terms.map(term => <div className="trust-payment-option" key={term.code}>
      <label className="checkbox-label"><input name="paymentTerms" type="checkbox" value={term.code}
        defaultChecked={selected.includes(term.code)} />{t(term.label_ru)}</label>
      <details>
        <summary>{t('Применение и риски')}</summary>
        <p>{t(term.when_ru)}</p>
        <p>{t('Риск продавца')} · {t(term.seller_risk_ru)}</p>
        <p>{t('Риск покупателя')} · {t(term.buyer_risk_ru)}</p>
      </details>
    </div>)}
  </fieldset>
}

export function PaymentsPage() {
  const { t } = useI18n()
  const { features } = useExchange()
  const result = useTrustData<PaymentGuide>(features.feature_trust_rating === true ? '/payment-terms' : null)
  return <div className="container workflow-page">
    <h1>{t('Условия оплаты')}</h1>
    {result.loading && <Spinner />}
    {result.error && <Notice tone="error">{t(result.error)}</Notice>}
    {features.feature_trust_rating === false && <Notice>{t('Справочник условий оплаты пока недоступен.')}</Notice>}
    {result.data && <div className="workflow-stack">
      <section className="panel workflow-section">
        <h2>{t('Варианты и риски')}</h2>
        <div className="trust-card-grid">{result.data.terms.map(term => <article key={term.code} className="trust-card">
          <h3>{t(term.label_ru)}</h3>
          <p><strong>{t('Когда уместно')}</strong> · {t(term.when_ru)}</p>
          <p><strong>{t('Риск продавца')}</strong> · {t(term.seller_risk_ru)}</p>
          <p><strong>{t('Риск покупателя')}</strong> · {t(term.buyer_risk_ru)}</p>
          <p className="muted">{t(term.code === 'PREPAY_100' ? 'Учитывайте подтверждённые сделки продавца перед полной предоплатой.' : term.hint_ru)}</p>
        </article>)}</div>
      </section>
      <section className="panel workflow-section">
        <h2>{t('Как согласовать условия оплаты')}</h2>
        <div className="trust-card-grid">{[...result.data.rules, result.data.fallback].map(rule => <article className="trust-card" key={rule.id}>
          <h3>{t(rule.seller_wants_ru)} / {t(rule.buyer_wants_ru)}</h3>
          <p>{t(rule.tool_ru)}</p>
        </article>)}</div>
      </section>
    </div>}
  </div>
}

type ListingFields = { kind?: string; trust?: ListingTrust | null; paymentTerms?: string[] }

export function TrustBadges({ listing }: { listing: ListingFields }) {
  const { t } = useI18n()
  const { features } = useExchange()
  const trust = listing.trust
  if (!features.feature_trust_rating || !trust) return null
  return <ul className="trust-badges" aria-label={t('Рейтинг и подтверждения')}>
    {trust.score != null && <li className="trust-tag">{t('Рейтинг объявления · {score}/100', { score: trust.score })}</li>}
    <li className={'trust-tag trust-level-' + trust.ownerLevel}>{t(trust.ownerLevelSource === 'OPERATOR_KNOWN'
      ? 'Проверен оператором' : verificationLevels[trust.ownerLevel] ?? verificationLevels[0])}
      {trust.ownerLevel === 2 && ` · ${t('Сделок: {count}', { count: trust.ownerDeals })}`}</li>
    {trust.reliable && <li className="trust-tag trust-level-2">{t('Надёжный участник')}</li>}
    {trust.proof && <li className="trust-tag trust-level-1">{t(trust.proof === 'STOCK' ? 'Наличие подтверждено' : 'Средства подтверждены')}</li>}
    {trust.corridor && <li className="trust-tag trust-warning">{t('Цена вне ориентировочного диапазона')}</li>}
  </ul>
}

export function PaymentRisk({ listing }: { listing: ListingFields }) {
  const { t } = useI18n()
  const { features } = useExchange()
  if (!features.feature_trust_rating || listing.kind !== 'SELL' || listing.paymentTerms?.length !== 1 ||
    listing.paymentTerms[0] !== 'PREPAY_100' || (listing.trust?.ownerLevel ?? 0) >= 2) return null
  return <Notice>{t('Перед полной предоплатой проверьте, есть ли у продавца подтверждённые сделки, или согласуйте другой способ оплаты.')}</Notice>
}

export const documentKinds: Record<string, string> = {
  COMPANY_CARD: 'Карточка компании', SIGNATORY: 'Документ о полномочиях подписанта',
  MANDATE: 'Документ о полномочиях агента', PRINCIPAL_LETTER: 'Письмо принципала',
  SERIAL_PHOTO: 'Фото серийного номера', WAREHOUSE_CERT: 'Складская справка', INVOICE: 'Накладная',
  WAREHOUSE_VIDEO: 'Видео со склада', LC_LETTER: 'Письмо об аккредитиве', FUNDS_PROOF: 'Подтверждение средств',
  BANK_LETTER: 'Письмо банка', DEAL_DOC: 'Документ по сделке', OTHER: 'Другой документ',
}
export const documentStatuses: Record<string, string> = { PENDING: 'На проверке', APPROVED: 'Принят', REJECTED: 'Отклонён' }

export type TrustDocument = {
  id: string; userId: string; listingId: string | null; kind: string; fileName: string
  status: string; note?: string; dayCodeOk?: boolean | null; uploadedAt: string
  participantName?: string; listingTitle?: string
}

export function DocumentDownload({ document }: { document: Pick<TrustDocument, 'id' | 'fileName'> }) {
  return <a className="text-link" href={'/api/v1/documents/' + encodeURIComponent(document.id) + '/file'} download>{document.fileName}</a>
}

type DocumentContext = { listingId?: string; dealId?: string; kinds: readonly string[] }

export function DocumentBox({ listingId, dealId, kinds }: DocumentContext) {
  const { t } = useI18n()
  const { features } = useExchange()
  const [version, setVersion] = useState(0)
  const [kind, setKind] = useState(kinds[0])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const filter = listingId ? '?listingId=' + listingId : dealId ? '?dealId=' + dealId : ''
  const result = useTrustData<TrustDocument[]>(features.feature_trust_rating ? '/documents' + filter : null, version)
  const needsPrincipal = kind === 'MANDATE' || kind === 'PRINCIPAL_LETTER'
  const principals = useTrustData<{ items: { id: string; name: string }[] }>(needsPrincipal ? '/me/principals' : null)
  if (!features.feature_trust_rating) return null

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    const file = values.get('file')
    if (!(file instanceof File) || file.size === 0) return
    if (file.size > 10 * 1024 * 1024) { setError('Размер файла не должен превышать 10 МиБ.'); return }
    const payload = new FormData()
    payload.set('file', file)
    payload.set('data', JSON.stringify({
      kind, listingId, dealId,
      principalId: needsPrincipal ? values.get('principalId') || undefined : undefined,
      dayCode: kind === 'SERIAL_PHOTO' ? values.get('dayCode') || undefined : undefined,
    }))
    setBusy(true); setNotice(''); setError('')
    try {
      await api('/documents', { method: 'POST', body: payload })
      form.reset()
      setVersion(value => value + 1)
      setNotice('Документ отправлен на проверку.')
    } catch (cause) {
      setError((cause as Error).message)
    } finally { setBusy(false) }
  }

  const documents = result.data?.filter(document => listingId || dealId || (kinds.includes(document.kind) && document.listingId === null))
  return <div className="workflow-stack">
    {result.error && <Notice tone="error">{t(result.error)}</Notice>}
    {result.loading && <Spinner />}
    {documents && documents.length > 0 && <ul className="trust-item-list">
      {documents.map(document => <li key={document.id}>
        <DocumentDownload document={document} /> <span className="muted">· {t(documentStatuses[document.status] ?? document.status)}</span>
        {document.note && <p>{document.note}</p>}
        {document.dayCodeOk === false && <p>{t('Код дня не найден или истёк.')}</p>}
      </li>)}
    </ul>}
    <form className="form-grid trust-upload" onSubmit={upload} aria-busy={busy}>
      {kinds.length > 1 && <Field label={t('Вид документа')}>
        <select value={kind} onChange={event => setKind(event.target.value)}>
          {kinds.map(code => <option key={code} value={code}>{t(documentKinds[code] ?? code)}</option>)}
        </select>
      </Field>}
      {needsPrincipal && <Field label={t('Принципал')}>
        <select name="principalId" required><option value="">{t('Выберите принципала')}</option>
          {principals.data?.items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </Field>}
      {principals.error && <Notice tone="error">{t(principals.error)}</Notice>}
      {kind === 'SERIAL_PHOTO' && <Field label={t('Код дня')}>
        <input name="dayCode" placeholder="K7-2511" maxLength={32} autoCapitalize="characters" />
      </Field>}
      <Field label={t('Файл документа')} hint={t('PDF, JPEG, PNG, WebP или MP4 до 10 МиБ.')}>
        <input name="file" type="file" accept={kind === 'SERIAL_PHOTO' ? 'image/jpeg,image/png,image/webp' : 'application/pdf,image/jpeg,image/png,image/webp,video/mp4'} required />
      </Field>
      <div className="workflow-span">
        {error && <Notice tone="error">{t(error)}</Notice>}
        {notice && <Notice tone="success">{t(notice)}</Notice>}
        <Button type="submit" disabled={busy}>{t('Загрузить документ')}</Button>
      </div>
    </form>
  </div>
}

type TrustSummary = {
  total: number; reliable: boolean; level: number; levelName: string; listingLimit: number | null; listingsUsed: number
  factors: { id: string; name: string; max: number; value: number; detail: string; hint: string }[]
  penalties: { id: string; points: number; reason: string }[]
  dayCodes: { id: string; code: string; listingId?: string; expiresAt: string; spotCheck: boolean }[]
  publishBanAt?: string; publishBanNote?: string; verificationRejectedAt?: string; verificationNote?: string
}

export function TrustAccount() {
  const { t, locale } = useI18n()
  const { features } = useExchange()
  const { data: value, loading, error } = useTrustData<TrustSummary>(features.feature_trust_rating ? '/me/trust' : null)
  if (!features.feature_trust_rating) return null
  return <>
    {error && <Notice tone="error">{t(error)}</Notice>}
    {loading && <Spinner />}
    {value && <>
      <section className="panel workflow-section">
        <div className="trust-heading"><h2>{t('Рейтинг участника')}</h2><strong>{value.total}/100</strong></div>
        {value.reliable && <p className="trust-tag trust-level-2">{t('Надёжный участник')}</p>}
        <ul className="trust-item-list">
          {value.factors.map(entry => <li key={entry.id}>
            <div className="trust-heading"><strong>{t(ratingFactorLabels[entry.id] ?? entry.name)}</strong><span>{entry.value} / {entry.max}</span></div>
            <p>{t(entry.id === 'level' ? value.levelName : entry.detail)}</p>
            {entry.hint && <small className="muted">{t(entry.hint)} (+{new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(entry.max - entry.value)})</small>}
          </li>)}
          {value.penalties.map(penalty => <li key={penalty.id}>−{penalty.points} · {penalty.reason}</li>)}
        </ul>
      </section>
      <section className="panel workflow-section">
        <h2>{t('Уровень проверки')}</h2>
        <p><span className={'trust-tag trust-level-' + value.level}>{t(value.levelName)}</span></p>
        <p>{t('Активных и скрытых объявлений: {used}', { used: value.listingsUsed })} · {value.listingLimit === null ? t('без ограничения') : t('лимит {limit}', { limit: value.listingLimit })}</p>
        {value.publishBanAt && <Notice tone="error">{t('Публикация закрыта до проверки документов.')} {value.publishBanNote}</Notice>}
        {value.verificationRejectedAt && <Notice>{t('Проверка документов не пройдена.')} {value.verificationNote}</Notice>}
        {value.dayCodes.length > 0 && <ul className="trust-item-list">
          {value.dayCodes.map(code => <li key={code.id}>
            <strong>{t('Код дня')} · <code>{code.code}</code></strong> <span className="muted">{t('Действует до {date}', { date: new Date(code.expiresAt).toLocaleString(locale) })}</span>
            {code.listingId && <> · <Link to={'/listings/' + code.listingId + '/edit'}>{t('Загрузить фото объявления')}</Link></>}
          </li>)}
        </ul>}
        <DocumentBox kinds={['COMPANY_CARD', 'SIGNATORY', 'SERIAL_PHOTO', ...(features.feature_representation ? ['MANDATE', 'PRINCIPAL_LETTER'] : []), 'OTHER']} />
      </section>
      <section className="panel workflow-section"><h2>{t('Сделки')}</h2><Link className="text-link" to="/deals">{t('Мои сделки')}</Link></section>
    </>}
  </>
}

export function ListingProof({ listingId, kind }: { listingId: string; kind: 'SELL' | 'BUY' }) {
  const { t } = useI18n()
  const { features } = useExchange()
  if (!features.feature_trust_rating) return null
  return <section className="panel workflow-section">
    <h2>{t(kind === 'SELL' ? 'Подтверждение наличия' : 'Подтверждение средств')}</h2>
    <DocumentBox listingId={listingId} kinds={kind === 'SELL'
      ? ['SERIAL_PHOTO', 'WAREHOUSE_CERT', 'INVOICE', 'WAREHOUSE_VIDEO'] : ['LC_LETTER', 'FUNDS_PROOF', 'BANK_LETTER']} />
  </section>
}
