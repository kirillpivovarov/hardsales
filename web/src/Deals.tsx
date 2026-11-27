import { useState, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api } from './api'
import { useExchange } from './Exchange'
import { useI18n } from './i18n'
import { Button, Field, Notice, Spinner } from './ui'
import { DocumentBox, useTrustData } from './Trust'

const labels = {
  NEGOTIATING: 'Идут переговоры', AGREED: 'Условия согласованы', FAILED: 'Сделка не состоялась', EXECUTED: 'Сделка исполнена',
} as const
const actions = {
  NEGOTIATING: 'Продолжить переговоры', AGREED: 'Указать условия', FAILED: 'Сообщить, что сделка не состоялась', EXECUTED: 'Подтвердить исполнение',
} as const
const reasons = ['Цена', 'Оплата', 'Сроки', 'Товар', 'Документы', 'Контрагент пропал', 'Другое']
type DealStatus = keyof typeof labels
export type ChatDealSummary = { id?: string; status?: DealStatus | null; amountMismatch?: boolean; canStart: boolean }
type Agreement = { amount: number; quantity: number; currency: string }
type Deal = {
  id: string; disclosureId: string; disclosureNumber: string
  sellerId: string; buyerId: string; sellTitle: string | null; buyTitle: string | null
  partnerId: string | null; partnerName: string | null; chatId: string | null
  status: DealStatus; sellerAgreed: Agreement | null; buyerAgreed: Agreement | null; amountMismatch: boolean
  sellerExecutedAt: string | null; buyerExecutedAt: string | null
  failedReason: string | null; adminVerifiedAt: string | null; adminRejectedAt: string | null; adminNote: string | null
  ratingNextEligibleAt?: string | null
  updatedAt: string
  events?: { id: string; type: string; data: { status?: DealStatus; resultingStatus?: DealStatus; action?: string;
    approved?: boolean; reason?: string }; actorUserId: string | null; createdAt: string }[]
}

function dealTitle(deal: Deal) {
  return deal.sellTitle || deal.buyTitle || deal.disclosureNumber
}

function dealStatusLabel(deal: Deal) {
  return deal.status === 'AGREED' && deal.amountMismatch ? 'Условия расходятся' : labels[deal.status]
}

function reasonLabel(reason: string) {
  return reason === 'Контрагент пропал' ? 'Контрагент не отвечает' : reason
}

export function DealsPage() {
  const { t } = useI18n()
  const { features } = useExchange()
  const { id } = useParams()
  const enabled = features.feature_trust_rating === true
  return <section className="container workflow-page" aria-labelledby="deals-title">
    <h1 id="deals-title">{t('Сделки')}</h1>
    {features.feature_trust_rating === false && <Notice>{t('Сделки пока недоступны.')}</Notice>}
    {enabled && (id ? <DealDetails key={id} id={id} /> : <DealList />)}
  </section>
}

function DealList() {
  const { t, locale } = useI18n()
  const [page, setPage] = useState(1)
  const [search, setSearch] = useSearchParams()
  const selectedPartner = search.get('pairUserId')
  const parameters = new URLSearchParams({ page: String(page), limit: '20' })
  if (selectedPartner) parameters.set('pairUserId', selectedPartner)
  const result = useTrustData<{ items: Deal[]; total: number }>('/deals?' + parameters)
  const groups = new Map<string, Deal[]>()
  for (const deal of result.data?.items ?? []) {
    const key = deal.partnerId ?? ''
    const group = groups.get(key) ?? []
    group.push(deal)
    groups.set(key, group)
  }
  return <>
    {result.loading && <Spinner />}
    {result.error && <Notice tone="error">{t(result.error)}</Notice>}
    {selectedPartner && <Button variant="secondary" onClick={() => {
      setPage(1)
      setSearch({})
    }}>{t('Все контрагенты')}</Button>}
    {result.data?.total === 0 && <Notice>{t('Сделок пока нет.')}</Notice>}
    {[...groups].map(([partner, group]) => <section className="panel workflow-section" key={partner}>
      <div className="trust-heading">
        <h2>{group[0].partnerName || t('Контрагент')}</h2>
        {!selectedPartner && partner && <Button variant="ghost" onClick={() => {
          setPage(1)
          setSearch({ pairUserId: partner })
        }}>{t('Все сделки с участником')}</Button>}
      </div>
      <ul className="trust-item-list" aria-label={t('Сделки по объявлениям')}>
        {group.map(deal => <li key={deal.id}>
          <div className="trust-heading">
            <Link className="text-link" to={'/deals/' + deal.id}>{dealTitle(deal)}</Link>
            <span className="trust-tag">{t(dealStatusLabel(deal))}</span>
          </div>
          <p className="muted">{deal.disclosureNumber} · {new Date(deal.updatedAt).toLocaleDateString(locale)}</p>
          <DealRatingNote deal={deal} />
        </li>)}
      </ul>
    </section>)}
    {result.data && (result.data.total > 20 || page > 1) && <nav className="admin-actions" aria-label={t('Страницы сделок')}>
      <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>{t('Назад')}</Button>
      <span>{page}</span>
      <Button variant="secondary" disabled={page * 20 >= result.data.total} onClick={() => setPage(value => value + 1)}>{t('Далее')}</Button>
    </nav>}
  </>
}

function DealRatingNote({ deal }: { deal: Deal }) {
  const { t, locale } = useI18n()
  return deal.ratingNextEligibleAt ? <p className="muted">{t('Сделка засчитана. Следующая сделка с этим контрагентом войдёт в рейтинг не раньше {date}.', {
    date: new Date(deal.ratingNextEligibleAt).toLocaleDateString(locale),
  })}</p> : null
}

function DealDetails({ id }: { id: string }) {
  const { t, locale } = useI18n()
  const [search] = useSearchParams()
  const [version, setVersion] = useState(0)
  const { data: deal, loading, error } = useTrustData<Deal>('/deals/' + encodeURIComponent(id), version)
  const format = (agreement: Agreement) => `${new Intl.NumberFormat(locale).format(agreement.amount)} ${agreement.currency}, ${agreement.quantity} ${t('шт.')}`
  return <div className="workflow-stack">
    <Link className="text-link" to="/deals">{t('Все сделки')}</Link>
    {loading && <Spinner />}
    {error && <Notice tone="error">{t(error)}</Notice>}
    {deal && <>
      <section className="panel workflow-section">
        <div className="trust-heading"><h2>{dealTitle(deal)}</h2><span className="trust-tag">{t(dealStatusLabel(deal))}</span></div>
        <p><Link className="text-link" to={'/disclosures/' + deal.disclosureId}>{t('Запись об обмене контактами')} {deal.disclosureNumber}</Link></p>
        <ul className="trust-item-list">
          <li>{t('Условия продавца')} · {deal.sellerAgreed ? format(deal.sellerAgreed) : t('Ещё не указаны')}
            {deal.sellerExecutedAt && <p>{t('Продавец подтвердил исполнение.')}</p>}</li>
          <li>{t('Условия покупателя')} · {deal.buyerAgreed ? format(deal.buyerAgreed) : t('Ещё не указаны')}
            {deal.buyerExecutedAt && <p>{t('Покупатель подтвердил исполнение.')}</p>}</li>
        </ul>
        {deal.amountMismatch && <Notice>{t('Сумма, валюта или количество у сторон расходятся. Модератор увидит расхождение при проверке.')}</Notice>}
        {deal.failedReason && <p>{t('Причина')} · {t(reasonLabel(deal.failedReason))}</p>}
        {deal.adminVerifiedAt && <Notice tone="success">{t('Модератор подтвердил сделку.')}</Notice>}
        <DealRatingNote deal={deal} />
        {deal.adminRejectedAt && <Notice>{t('Модератор не подтвердил сделку.')} {deal.adminNote}</Notice>}
        {(deal.status === 'NEGOTIATING' || deal.status === 'AGREED') && <DealStatusForm deal={deal}
          initial={search.get('status') ?? (search.get('action') === 'agree' ? 'AGREED' : null)}
          onSaved={() => setVersion(value => value + 1)} />}
      </section>
      <section className="panel workflow-section">
        <h2>{t('Документ по сделке')}</h2>
        <DocumentBox dealId={deal.id} kinds={['DEAL_DOC']} />
      </section>
      {Boolean(deal.events?.length) && <section className="panel workflow-section" aria-labelledby="deal-history-title">
        <h2 id="deal-history-title">{t('История сделки')}</h2>
        <ul className="trust-item-list">{deal.events?.map(event => <li key={event.id}>
          <strong>{event.type === 'DEAL_VERIFIED' ? t(event.data.approved ? 'Сделка подтверждена модератором' : 'Модератор не подтвердил сделку')
            : event.data.action === 'STARTED' ? t('Сделка начата')
            : event.data.status ? t(event.data.status === 'AGREED' ? 'Условия указаны'
              : event.data.resultingStatus === 'EXECUTED' ? 'Сделка исполнена'
              : event.data.status === 'EXECUTED' ? 'Исполнение подтверждено одной из сторон' : labels[event.data.status]) : t('Статус изменён')}</strong>
          <p className="muted">{t(event.actorUserId === deal.sellerId ? 'Продавец' : event.actorUserId === deal.buyerId ? 'Покупатель'
            : event.actorUserId ? 'Модератор' : 'Площадка')}
            {' · '}{new Date(event.createdAt).toLocaleString(locale)}</p>
          {event.data.reason && <p>{t(reasonLabel(event.data.reason))}</p>}
        </li>)}</ul>
      </section>}
    </>}
  </div>
}

export function ChatDealPanel({ deal, active, pending, onStart, onChanged }: {
  deal: ChatDealSummary; active: boolean; pending: boolean; onStart: () => void; onChanged: () => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const status = deal.status ?? 'NEGOTIATING'
  const mayUpdate = active && (status === 'NEGOTIATING' || status === 'AGREED')
  const { data, error, loading } = useTrustData<Deal>(open && deal.id && mayUpdate ? '/deals/' + deal.id : null)
  if (!deal.id && (!deal.canStart || !active)) return null

  return <section className="workflow-stack chat-deal-panel" aria-labelledby="chat-deal-title">
    <div className="trust-heading">
      <strong id="chat-deal-title">{t('Сделка по этому объявлению')}</strong>
      {deal.id && <span className="trust-tag">{t(status === 'AGREED' && deal.amountMismatch ? 'Условия расходятся' : labels[status])}</span>}
    </div>
    <div className="workflow-actions">
      {deal.id ? <>
        {mayUpdate && <Button variant="secondary" aria-expanded={open} onClick={() => setOpen(value => !value)}>{t('Изменить статус сделки')}</Button>}
        <Link className="button button-ghost" to={'/deals/' + deal.id}>{t('Открыть сделку')}</Link>
      </> : <Button variant="secondary" disabled={pending} onClick={onStart}>{t('Начать сделку по этому объявлению')}</Button>}
    </div>
    {open && mayUpdate && <>
      {loading && <Spinner />}
      {error && <Notice tone="error">{t(error)}</Notice>}
      {data && <DealStatusForm deal={data} initial={null} onSaved={() => { setOpen(false); onChanged() }} />}
    </>}
  </section>
}

function DealStatusForm({ deal, initial, onSaved }: { deal: Deal; initial: string | null; onSaved: () => void }) {
  const { t } = useI18n()
  const options: DealStatus[] = deal.status === 'AGREED'
    ? ['EXECUTED', ...(!deal.sellerExecutedAt && !deal.buyerExecutedAt ? ['AGREED' as const] : []), 'NEGOTIATING', 'FAILED']
    : ['NEGOTIATING', 'AGREED', 'FAILED']
  const [status, setStatus] = useState<DealStatus>(options.find(option => option === initial) ?? options[0])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true); setError('')
    try {
      await api('/deals/' + deal.id + '/status', { method: 'POST', body: {
        status, ...(status === 'AGREED' ? { amount: Number(form.get('amount')), quantity: Number(form.get('quantity')), currency: form.get('currency') } : {}),
        ...(status === 'FAILED' ? { reason: form.get('reason') } : {}),
      } })
      onSaved()
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }
  return <form className="form-grid" onSubmit={save} aria-busy={busy}>
    <Field label={t('Статус сделки')}><select value={status} onChange={event => setStatus(event.target.value as DealStatus)}>
      {options.map(option => <option key={option} value={option}>{t(actions[option])}</option>)}
    </select></Field>
    {status === 'AGREED' && <>
      <Field label={t('Сумма')}><input type="number" name="amount" min="0.01" step="0.01" required /></Field>
      <Field label={t('Количество')}><input type="number" name="quantity" min="1" max="1000000" step="1" required /></Field>
      <Field label={t('Валюта')}><select name="currency">{['RUB', 'USD', 'EUR', 'CNY', 'KZT', 'AED'].map(currency => <option key={currency}>{currency}</option>)}</select></Field>
    </>}
    {status === 'FAILED' && <Field label={t('Причина')}><select name="reason" required>
      <option value="">{t('Выберите причину')}</option>{reasons.map(reason => <option value={reason} key={reason}>{t(reasonLabel(reason))}</option>)}
    </select></Field>}
    <div className="workflow-span">
      {error && <Notice tone="error">{t(error)}</Notice>}
      <Button type="submit" disabled={busy}>{t('Сохранить статус')}</Button>
    </div>
  </form>
}
