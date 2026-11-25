import { useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from './api'
import { useExchange } from './Exchange'
import { useI18n } from './i18n'
import { DocumentDownload, documentKinds, documentStatuses, useTrustData, verificationLevels, type TrustDocument } from './Trust'
import { Button, Field, Notice, Spinner } from './ui'

type Participant = {
  id: string; username: string; displayName: string; level: number; representationMode: string
  verificationNote?: string; publishBanAt?: string; actualitySuspendedAt?: string; linkGroup?: string
  trustScore?: number; chain: Record<string, string>
  listings: { id: string; kind: string; title: string }[]
}
type Principal = { id: string; name: string; company: string; participantName: string; confirmedAt?: string; deniedAt?: string }
type DealReview = {
  id: string; disclosureNumber: string; disclosureId: string; sellerName: string; buyerName: string
  amountMismatch: boolean; documents: { id: string; fileName: string; status: string }[]
}
type DayCode = { id: string; participantName: string; listingTitle?: string; code: string; spotCheck: boolean; result?: string; expiresAt: string }
type Queue = { participants: Participant[]; documents: TrustDocument[]; principals: Principal[]; dealsToVerify: DealReview[]; dayCodes: DayCode[] }
type Corridor = { modelId: string; modelName?: string; basis: string; minUsd: string; maxUsd: string }
const chainNames: Record<string, string> = {
  dayCode: 'Фото с кодом дня', principal: 'Подтверждение полномочий', document: 'Документ на имя участника',
}
const chainStatuses: Record<string, string> = {
  PASSED: 'Подтверждено', FAILED: 'Не подтверждено', WAITING: 'Ожидается подтверждение', NOT_NEEDED: 'Не требуется',
}
const archiveStatuses: Record<string, string> = { APPROVED: 'Принят', REJECTED: 'Отклонён', PENDING: 'На проверке' }

type Mutation = { path: string; method?: string; body?: unknown }
function DecisionForm({ save, children, onSaved, label }: {
  save: (data: FormData) => Mutation; children: React.ReactNode; onSaved: () => void; label?: string
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try {
      const { path, method = 'POST', body } = save(new FormData(event.currentTarget))
      await api(path, { method, body })
      onSaved()
    } catch (error) { setError((error as Error).message) }
    finally { setBusy(false) }
  }
  return <form className="trust-admin-form" onSubmit={submit} aria-busy={busy}>
    {children}
    {error && <Notice tone="error">{t(error)}</Notice>}
    <Button type="submit" disabled={busy}>{t(label ?? 'Сохранить решение')}</Button>
  </form>
}

export function VerificationAdmin({ isAdmin = false }: { isAdmin?: boolean }) {
  const { t, locale } = useI18n()
  const { features } = useExchange()
  const [params] = useSearchParams()
  const profileId = params.get('userId') ?? ''
  const [draft, setDraft] = useState(profileId)
  const [query, setQuery] = useState(draft)
  const [version, setVersion] = useState(0)
  const [saved, setSaved] = useState(false)
  useEffect(() => { setDraft(profileId); setQuery(profileId) }, [profileId])
  const result = useTrustData<Queue>(features.feature_trust_rating
    ? '/admin/verification' + (query ? '?' + new URLSearchParams({ q: query }).toString() : '') : null, version)
  const afterSave = () => { setVersion(value => value + 1); setSaved(true) }
  if (!features.feature_trust_rating) return <Notice>{t('Проверка пока не включена.')}</Notice>
  return <div className="workflow-stack">
    <h2>{t('Кабинет проверки')}</h2>
    <form className="admin-filters" onSubmit={event => { event.preventDefault(); setQuery(draft.trim()); setSaved(false) }}>
      <Field label={t('Найти участника')}><input type="search" value={draft} onChange={event => setDraft(event.target.value)} maxLength={100} /></Field>
      <Button type="submit" variant="secondary">{t('Найти')}</Button>
    </form>
    {saved && <Notice tone="success">{t('Изменения сохранены.')}</Notice>}
    {result.loading && <Spinner />}
    {result.error && <Notice tone="error">{t(result.error)}</Notice>}
    {result.data && <>
      <section>
        <h3>{t('Участники')}</h3>
        {result.data.participants.length === 0 && <p className="muted">{t('Нет участников для проверки.')}</p>}
        <ul className="trust-item-list">{result.data.participants.map(participant => <li key={participant.id}>
          <details>
            <summary><strong>{participant.displayName}</strong> · {participant.username} · {t(verificationLevels[participant.level] ?? verificationLevels[0])}</summary>
            <ParticipantForm participant={participant} onSaved={afterSave} isAdmin={isAdmin} />
          </details>
        </li>)}</ul>
      </section>
      <section>
        <h3>{t('Документы на проверке')}</h3>
        {result.data.documents.length === 0 && <p className="muted">{t('Нет новых документов.')}</p>}
        <ul className="trust-item-list">{result.data.documents.map(document => <li key={document.id}>
          <p><strong>{t(documentKinds[document.kind] ?? document.kind)}</strong> · {document.participantName}</p>
          {document.listingTitle && document.listingId && <p><Link to={'/listings/' + document.listingId}>{document.listingTitle}</Link></p>}
          <DocumentDownload document={document} />
          {document.dayCodeOk != null && <p>{t(document.dayCodeOk ? 'Код дня действителен.' : 'Код дня не найден или истёк.')}</p>}
          <details><summary>{t('Решение по документу')}</summary><DocumentReview document={document} onSaved={afterSave} /></details>
        </li>)}</ul>
      </section>
      <section>
        <h3>{t('Сделки на проверке')}</h3>
        {result.data.dealsToVerify.length === 0 && <p className="muted">{t('Нет сделок на проверке.')}</p>}
        <ul className="trust-item-list">{result.data.dealsToVerify.map(deal => <li key={deal.id}>
          <Link to={'/admin?section=exchange&part=disclosures&id=' + deal.disclosureId}>{deal.disclosureNumber}</Link>
          <p>{deal.sellerName} · {deal.buyerName}</p>
          {deal.amountMismatch && <Notice>{t('Стороны указали разные условия.')}</Notice>}
          {deal.documents.map(document => <p key={document.id}><DocumentDownload document={document} /> · {t(archiveStatuses[document.status] ?? document.status)}</p>)}
          <details><summary>{t('Решение по сделке')}</summary><DealReviewForm deal={deal} onSaved={afterSave} /></details>
        </li>)}</ul>
      </section>
      <section>
        <h3>{t('Принципалы')}</h3>
        {result.data.principals.length === 0 && <p className="muted">{t('Принципалы не добавлены.')}</p>}
        <ul className="trust-item-list">{result.data.principals.map(principal => <li key={principal.id}>
          <strong>{principal.name}</strong>{principal.company && ` · ${principal.company}`} · {principal.participantName}
          <p>{t(principal.confirmedAt ? 'Полномочия подтверждены' : principal.deniedAt ? 'В подтверждении отказано' : 'Ожидается подтверждение')}</p>
        </li>)}</ul>
      </section>
      <section>
        <h3>{t('Коды дня')}</h3>
        {result.data.dayCodes.length === 0 && <p className="muted">{t('Коды ещё не выданы.')}</p>}
        <ul className="trust-item-list">{result.data.dayCodes.map(code => <li key={code.id}>
          <strong>{code.code}</strong> · {code.participantName}{code.listingTitle && ` · ${code.listingTitle}`}
          <p>{t(code.result ? chainStatuses[code.result] ?? code.result : 'Ожидается фото')} · {new Date(code.expiresAt).toLocaleString(locale)}</p>
          {code.spotCheck && <p>{t('Выборочная проверка')}</p>}
        </li>)}</ul>
      </section>
    </>}
  </div>
}

function ParticipantForm({ participant, onSaved, isAdmin }: { participant: Participant; onSaved: () => void; isAdmin: boolean }) {
  const { t } = useI18n()
  const prefix = '/admin/users/' + participant.id
  const [action, setAction] = useState('verify')
  const [listing, setListing] = useState('')
  const options: Record<string, string> = {
    verify: 'Подтвердить проверку документов', 'verification-reject': 'Отклонить документы', restrict: 'Ограничить публикацию',
    'day-codes': 'Выдать код дня', penalties: 'Назначить штраф', 'link-group': 'Указать связанные аккаунты',
    ...(isAdmin && participant.actualitySuspendedAt ? { 'actuality/resume': 'Разрешить подтверждение актуальности' } : {}),
  }
  const outstanding = Object.values(participant.chain).filter(value => value === 'FAILED' || value === 'WAITING').length
  return <div className="workflow-stack">
    <ul className="trust-item-list">{Object.entries(participant.chain).map(([key, value]) => <li key={key}>{t(chainNames[key] ?? key)} · {t(chainStatuses[value] ?? value)}</li>)}</ul>
    {outstanding >= 2 && <Notice>{t('Два или более условия ещё не подтверждены.')}</Notice>}
    {participant.publishBanAt && <Notice>{t('Публикация закрыта до проверки документов.')}</Notice>}
    {participant.actualitySuspendedAt && <Notice>{t('Действует ограничение после пропусков вопросов об актуальности.')}</Notice>}
    <DecisionForm onSaved={onSaved} label={options[action]} save={form => {
      const note = String(form.get('note') ?? '').trim()
      const path = prefix + '/' + action
      if (action === 'day-codes') return { path, body: { listingId: listing || null, spotCheck: form.get('spotCheck') === 'on' } }
      if (action === 'link-group') return { path, method: 'PATCH', body: { linkGroup: String(form.get('group') ?? '').trim() || null } }
      if (action === 'penalties') return { path, body: { kind: form.get('kind'), points: Number(form.get('points')), reason: note } }
      if (action === 'actuality/resume') return { path, body: { reason: note } }
      return { path, body: action === 'verify' ? { note, level: 1 } : { note } }
    }}>
      <Field label={t('Действие')}>
        <select value={action} onChange={event => { setAction(event.target.value); setListing('') }}>
          {Object.entries(options).map(([code, name]) => <option value={code} key={code}>{t(name)}</option>)}
        </select>
      </Field>
      {action === 'day-codes' && <>
        <Field label={t('Объявление для кода дня')}>
          <select value={listing} onChange={event => setListing(event.target.value)}>
            <option value="">{t('Общий код для участника')}</option>
            {participant.listings.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}
          </select>
        </Field>
        {participant.listings.some(item => item.id === listing && item.kind === 'SELL') && <label className="checkbox-label">
          <input name="spotCheck" type="checkbox" /> {t('Выборочная проверка за 24 часа')}
        </label>}
      </>}
      {action === 'link-group' && <Field label={t('Группа связанных аккаунтов')} hint={t('Чтобы убрать привязку, оставьте пустым.')}>
        <input name="group" maxLength={40} pattern="[a-z0-9\\-]+" defaultValue={participant.linkGroup ?? ''} />
      </Field>}
      {action === 'penalties' && <>
        <Field label={t('Вид штрафа')}><select name="kind">
          <option value="OTHER">{t('Другой штраф')}</option>
          <option value="MISREPRESENTATION_PROVEN">{t('Доказано несоответствие цены или количества · 10')}</option>
        </select></Field>
        <Field label={t('Баллы')}><input name="points" type="number" min="1" max="100" defaultValue="10" required /></Field>
      </>}
      {!['link-group', 'day-codes'].includes(action) && <Field label={t('Причина или примечание')}>
        <textarea name="note" required={action !== 'verify'} minLength={3} maxLength={action === 'penalties' ? 500 : 1000} rows={2} />
      </Field>}
    </DecisionForm>
  </div>
}

function DocumentReview({ document, onSaved }: { document: TrustDocument; onSaved: () => void }) {
  const { t } = useI18n()
  const [approve, setApprove] = useState(true)
  return <DecisionForm onSaved={onSaved} save={form => ({
    path: '/admin/documents/' + document.id + (approve ? '/approve' : '/reject'), body: { note: form.get('note') },
  })}>
    <Field label={t('Решение')}><select value={approve ? 'yes' : 'no'} onChange={event => setApprove(event.target.value === 'yes')}>
      <option value="yes">{t('Принять')}</option><option value="no">{t('Отклонить')}</option>
    </select></Field>
    <Field label={t('Примечание')}><textarea name="note" minLength={3} maxLength={1000} required={!approve} rows={2} /></Field>
  </DecisionForm>
}

function DealReviewForm({ deal, onSaved }: { deal: DealReview; onSaved: () => void }) {
  const { t } = useI18n()
  const hasProof = deal.documents.some(document => document.status !== 'REJECTED')
  const [approve, setApprove] = useState(hasProof)
  return <DecisionForm onSaved={onSaved} save={form => ({ path: '/admin/deals/' + deal.id + '/verify', body: { approve, note: form.get('note') } })}>
    {!hasProof && <p>{t('Для зачёта нужен документ по сделке.')}</p>}
    <Field label={t('Решение')}><select value={approve ? 'yes' : 'no'} onChange={event => setApprove(event.target.value === 'yes')}>
      <option value="yes" disabled={!hasProof}>{t('Засчитать')}</option><option value="no">{t('Не засчитывать')}</option>
    </select></Field>
    <Field label={t('Примечание')}><textarea name="note" minLength={3} maxLength={1000} required={!approve} rows={2} /></Field>
  </DecisionForm>
}

const bases: Record<string, string> = { SELLER_WAREHOUSE: 'Склад продавца', DELIVERED: 'С доставкой' }
export function PriceCorridorsAdmin() {
  const { t, locale } = useI18n()
  const [version, setVersion] = useState(0)
  const [target, setTarget] = useState<Corridor>()
  const [error, setError] = useState('')
  const result = useTrustData<Corridor[]>('/admin/corridors', version)
  const refresh = () => { setTarget(undefined); setVersion(value => value + 1); setError('') }
  async function remove(row: Corridor) {
    try {
      await api('/admin/corridors/' + encodeURIComponent(row.modelId) + '/' + row.basis, { method: 'DELETE' })
      refresh()
    } catch (cause) { setError((cause as Error).message) }
  }
  return <section className="workflow-stack">
    <h3>{t('Коридоры цен')}</h3>
    <p className="muted">{t('Диапазон указывается в USD за единицу. Значения доступны администратору.')}</p>
    {result.loading && <Spinner />}
    {(error || result.error) && <Notice tone="error">{t(error || result.error || '')}</Notice>}
    <ul className="trust-item-list">{result.data?.map(row => <li key={row.modelId + row.basis}>
      <strong>{row.modelName || row.modelId}</strong> · {t(bases[row.basis] ?? row.basis)}
      <p>{new Intl.NumberFormat(locale).format(Number(row.minUsd))} – {new Intl.NumberFormat(locale).format(Number(row.maxUsd))} USD</p>
      <div className="admin-actions trust-admin-actions"><Button variant="secondary" onClick={() => setTarget(row)}>{t('Редактировать')}</Button>
        <Button variant="ghost" onClick={() => void remove(row)}>{t('Убрать коридор')}</Button></div>
    </li>)}</ul>
    <DecisionForm key={target ? target.modelId + target.basis : 'new'} onSaved={refresh} label="Сохранить коридор" save={form => ({
      path: '/admin/corridors/' + encodeURIComponent(String(form.get('modelId') ?? '').trim()) + '/' + form.get('basis'), method: 'PUT',
      body: { minUsd: Number(form.get('min')), maxUsd: Number(form.get('max')) },
    })}>
      <Field label={t('Код модели')}><input name="modelId" required defaultValue={target?.modelId} placeholder="hgx-h100-8" maxLength={48} /></Field>
      <Field label={t('Условия поставки')}><select name="basis" defaultValue={target?.basis}>
        {Object.entries(bases).map(([code, text]) => <option key={code} value={code}>{t(text)}</option>)}
      </select></Field>
      <Field label={t('Минимум, USD')}><input name="min" type="number" min="0.01" step="0.01" required defaultValue={target?.minUsd} /></Field>
      <Field label={t('Максимум, USD')}><input name="max" type="number" min="0.01" step="0.01" required defaultValue={target?.maxUsd} /></Field>
    </DecisionForm>
  </section>
}
