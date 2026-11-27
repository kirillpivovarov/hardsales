import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ActualityBadges, actualityDate } from './ActualityWidgets'
import { api } from './api'
import { useExchange } from './Exchange'
import { useI18n } from './i18n'
import { ListingExchangeBadges } from './ListingExchangeBadges'
import { ListingPrice } from './ListingPrice'
import type { Listing } from './market'
import { StaffDialog } from './StaffDialog'
import { documentStatuses, type TrustDocument, useTrustData } from './Trust'
import { Button, Field, Notice, Spinner } from './ui'
import './lots.css'

function failure(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Не удалось выполнить действие.'
}

export function LotAlternatives({ listing, returnTo }: { listing: Listing; returnTo: string }) {
  const { t, locale } = useI18n()
  const [open, setOpen] = useState(false)
  const group = listing.lotGroup
  const listId = useId()
  const path = group && open ? '/listings/' + listing.id + '/lot-members' : null
  const result = useTrustData<{ items: Listing[] }>(path)
  if (!group) return null
  const plural = new Intl.PluralRules(locale)
  const participant = plural.select(group.participants) === 'few' ? 'предлагают {number} участника' : 'предлагают {number} участников'
  const several = plural.select(group.collapsedCount) === 'few' ? 'Ещё {number} предложения этого лота' : 'Ещё {number} предложений этого лота'
  return <div className="lot-catalog-options">
    <span className="lot-tag">{t(participant, { number: group.participants })}</span>
    <button className="text-link lot-more" type="button" aria-controls={listId} aria-expanded={open}
      onClick={() => setOpen(value => !value)}>
      {open ? t('Свернуть предложения') : t(group.collapsedCount === 1 ? 'Ещё одно предложение этого лота' : several,
        { number: group.collapsedCount })}
    </button>
    <div id={listId} hidden={!open}>
      {open && result.loading && <Spinner />}
      {open && result.error && <Notice tone="error">{t(result.error)}</Notice>}
      {open && result.data && <ul className="lot-alternatives">
        {result.data.items.map(offer => <li key={offer.id}>
          <Link to={'/listings/' + offer.id} state={{ returnTo }} className="text-link">{offer.title}</Link>
          <p>{offer.owner.nickname || offer.owner.displayName}
            {offer.owner.rating != null && ' · ★ ' + offer.owner.rating.toLocaleString(locale)}</p>
          <ListingPrice listing={offer} usd />
          <ListingExchangeBadges listing={offer} /><ActualityBadges listing={offer} />
        </li>)}
      </ul>}
    </div>
  </div>
}

export function OwnLotBadges({ listing }: { listing: Pick<Listing, 'similarLot' | 'isDuplicate'> }) {
  const { t } = useI18n()
  if (listing.isDuplicate) return <p><span className="lot-tag lot-tag-restricted">{t('Дубль')}</span></p>
  if (!listing.similarLot) return null
  return <p><span className="lot-tag">{t('Похожее предложение есть у другого участника. Модератор уточняет лот.')}</span></p>
}

export function LotAppeal({ listing, onSaved }: { listing: Pick<Listing, 'id' | 'isDuplicate' | 'duplicateAppealed'>; onSaved: () => void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  if (!listing.isDuplicate) return null
  if (listing.duplicateAppealed) return <span className="muted">{t('Оспаривание ожидает рассмотрения')}</span>
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    const reason = new FormData(event.currentTarget).get('reason')
    setPending(true)
    setError('')
    try {
      await api('/listings/' + listing.id + '/duplicate-appeal', { method: 'POST', body: { reason } })
      setOpen(false)
      onSaved()
    } catch (cause) { setError(failure(cause)) }
    finally { setPending(false) }
  }
  return <>
    <Button variant="secondary" aria-haspopup="dialog" onClick={() => { setError(''); setOpen(true) }}>{t('Оспорить')}</Button>
    {open && <StaffDialog title={t('Оспорить решение о дубле')} onClose={() => setOpen(false)} closeDisabled={pending}>
      <form className="workflow-stack" onSubmit={submit}>
        <Field label={t('Причина')} hint={t('Укажите, почему это отдельный лот.')}>
          <textarea name="reason" minLength={10} maxLength={1000} required />
        </Field>
        {error && <Notice tone="error">{t(error)}</Notice>}
        <div className="admin-actions"><Button type="submit" disabled={pending}>{t('Отправить модератору')}</Button></div>
      </form>
    </StaffDialog>}
  </>
}

type LotRequest = { id: string; listingId: string; title: string; principalId: string | null; principalName: string | null }
type AvailableMandate = TrustDocument & { principalId?: string | null }

function LotRequestForm({ request, onSaved }: { request: LotRequest; onSaved: () => void }) {
  const { t } = useI18n()
  const { features } = useExchange()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [uploaded, setUploaded] = useState<string>()
  const mandates = useTrustData<AvailableMandate[]>(features.feature_trust_rating ? '/documents?listingId=' + request.listingId : null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    const form = new FormData(event.currentTarget)
    setPending(true)
    setError('')
    try {
      const file = form.get('file')
      let mandateDocumentId = form.get('mandateDocumentId') || uploaded
      if (!mandateDocumentId && file instanceof File && file.size && request.principalId) {
        if (file.size > 10 * 1024 * 1024) throw new Error(t('Размер файла не должен превышать 10 МиБ.'))
        const body = new FormData()
        body.set('file', file)
        body.set('data', JSON.stringify({ kind: 'MANDATE', listingId: request.listingId, principalId: request.principalId }))
        const created = await api<{ id: string }>('/documents', { method: 'POST', body })
        mandateDocumentId = created.id
        setUploaded(created.id)
      }
      await api('/me/lot-requests/' + request.id, { method: 'POST', body: {
        principalLegalName: form.get('principalLegalName'),
        exclusiveMandate: form.get('exclusiveMandate') === 'yes',
        mandateDocumentId, note: form.get('note'),
      } })
      onSaved()
    } catch (cause) { setError(failure(cause)) }
    finally { setPending(false) }
  }

  const docs = mandates.data?.filter(document => document.kind === 'MANDATE' && document.principalId === request.principalId) ?? []
  return <form className="workflow-stack lot-request-form" onSubmit={submit} aria-busy={pending}>
    <Field label={t('Юридическое наименование принципала')}>
      <input name="principalLegalName" defaultValue={request.principalName ?? ''} minLength={2} maxLength={200} required />
    </Field>
    <Field label={t('Есть эксклюзивный мандат?')}>
      <select name="exclusiveMandate" defaultValue="" required>
        <option value="" disabled>{t('Выберите ответ')}</option>
        <option value="yes">{t('Да')}</option>
        <option value="no">{t('Нет')}</option>
      </select>
    </Field>
    {docs.length > 0 && <Field label={t('Ранее загруженный мандат')}>
      <select name="mandateDocumentId" defaultValue="">
        <option value="">{t('Без ранее загруженного документа')}</option>
        {docs.map(doc => <option key={doc.id} value={doc.id}>{doc.fileName} · {t(documentStatuses[doc.status])}</option>)}
      </select>
    </Field>}
    {features.feature_trust_rating && request.principalId && <Field label={t('Загрузить мандат')} hint={t('Необязательно. PDF, JPEG, PNG или WebP до 10 МиБ.')}>
      <input type="file" name="file" accept="application/pdf,image/jpeg,image/png,image/webp" />
    </Field>}
    <Field label={t('Комментарий')}><textarea name="note" maxLength={1000} /></Field>
    {error && <Notice tone="error">{t(error)}</Notice>}
    <div className="admin-actions"><Button type="submit" disabled={pending}>{t('Отправить ответ')}</Button></div>
  </form>
}

export function MyLotRequests() {
  const { t } = useI18n()
  const { features } = useExchange()
  const [query] = useSearchParams()
  const [revision, setRevision] = useState(0)
  const [notice, setNotice] = useState(false)
  const result = useTrustData<{ items: LotRequest[] }>(features.feature_lot_groups ? '/me/lot-requests' : null, revision)
  const focused = query.get('lotRequest')
  useEffect(() => {
    if (!focused || !result.data?.items.some(item => item.id === focused)) return
    const selector = document.getElementById('lot-request-' + focused)
    selector?.focus()
  }, [focused, result.data])
  if (!result.error && !result.data?.items.length && !notice) return null
  return <section className="panel workflow-section workflow-stack" aria-label={t('Запросы модератора')}>
    <h2>{t('Запросы модератора')}</h2>
    {notice && <Notice tone="success">{t('Ответ отправлен модератору.')}</Notice>}
    {result.error && <Notice tone="error">{t(result.error)}</Notice>}
    {result.data?.items.map(request => <details key={request.id} open={request.id === focused || undefined}>
      <summary id={'lot-request-' + request.id}>{request.title}</summary>
      <p>{t('Конфиденциально укажите юрлицо принципала и есть ли у вас эксклюзивный мандат. Ответ видит только модератор.')}</p>
      <LotRequestForm request={request} onSaved={() => { setNotice(true); setRevision(value => value + 1) }} />
    </details>)}
  </section>
}

const groupStatus: Record<string, string> = { OPEN: 'На уточнении', RESOLVED: 'Решение принято', DISSOLVED: 'Группа распущена' }
const reasonLabels: Record<string, string> = {
  EXCLUSIVE_MANDATE: 'Эксклюзивный мандат', FIRST_CONFIRMED: 'Первый подтверждённый принципал',
  PRINCIPAL_OWN: 'Карточка самого принципала', OPERATOR: 'Решение модератора', DIFFERENT_LOTS: 'Разные лоты',
}
const memberRole: Record<string, string> = { MEMBER: 'В группе', PRIMARY: 'Главная', DUPLICATE: 'Дубль', REMOVED: 'Исключена' }
type AdminMember = {
  listingId: string; title: string; nickname: string; listingStatus: string; membershipRole: string;
  representation: 'DIRECT' | 'AGENT'; quantity: number; city: string | null; country: string | null;
  currency: string; pricePerUnit: number | null; trustScore: number | null; listingConfirmedAt: string | null;
  principalName: string | null; principalCompany: string | null; confirmedAt: string | null;
  requestId: string | null; answeredAt: string | null; principalLegalName: string | null; requestNote: string | null;
  exclusiveMandate: boolean | null; mandateStatus: string | null; mandateFileName: string | null; mandateDocumentId: string | null;
  appealReason: string | null;
}
type AdminLot = {
  id: string; number: string; modelName: string; status: string; participants: number; members: AdminMember[];
  sharedPrincipal: boolean | null; principalOwnerListingId: string | null; resolution: string | null; resolutionNote: string | null;
  recommendation: { listingId: string; resolution: string } | null;
}

type LotAction = 'principals' | 'shared' | 'resolve' | 'dissolve' | 'restore' | 'approve'

function StaffLotDetails({ lot, onChange, onBusy }: { lot: AdminLot; onChange: () => void; onBusy: (busy: boolean) => void }) {
  const { t, locale } = useI18n()
  const base = '/admin/lot-groups/' + lot.id
  const [action, setAction] = useState<LotAction>()
  const [memberId, setMemberId] = useState('')
  const [primary, setPrimary] = useState(lot.recommendation?.listingId ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const actionForm = useRef<HTMLFormElement>(null)
  const candidates = lot.members.filter(member => member.membershipRole === 'MEMBER' && member.listingStatus === 'ACTIVE')
  const advised = lot.recommendation?.listingId === primary ? lot.recommendation.resolution : 'OPERATOR'

  useEffect(() => {
    if (action) actionForm.current?.focus()
  }, [action, memberId])

  function select(next: LotAction, listingId = '') {
    if (next === 'resolve') setPrimary(lot.recommendation?.listingId ?? '')
    setAction(next)
    setMemberId(listingId)
    setError('')
    setNotice('')
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending || !action) return
    const fields = new FormData(event.currentTarget)
    const instructions = {
      principals: { path: base + '/principal-requests', body: {} },
      shared: { path: base + '/shared-principal', body: { shared: fields.get('shared') === 'true', principalOwnerListingId: fields.get('owner') || undefined } },
      resolve: { path: base + '/resolve', body: { primaryListingId: primary, resolution: advised, note: fields.get('note') } },
      dissolve: { path: base + '/dissolve', body: { note: fields.get('note') } },
      restore: { path: base + '/members/' + memberId + '/restore', body: { note: fields.get('note') } },
      approve: { path: '/admin/documents/' + memberId + '/approve', body: {} },
    }[action]
    setPending(true)
    onBusy(true)
    setError('')
    try {
      const data = await api<{ created?: number }>(instructions.path, { method: 'POST', body: instructions.body })
      setNotice(action === 'principals' ? t('Запросов отправлено: {number}', { number: data.created ?? 0 }) : t('Изменения сохранены.'))
      setAction(undefined)
      onChange()
    } catch (cause) { setError(failure(cause)) }
    finally { setPending(false); onBusy(false) }
  }

  return <div className="workflow-stack">
    <p><strong>{lot.modelName}</strong> · {t(groupStatus[lot.status])}</p>
    {lot.recommendation && <Notice>{t('Рекомендуемая главная карточка')} · {lot.members.find(member => member.listingId === lot.recommendation?.listingId)?.title}
      {' · '}{t(reasonLabels[lot.recommendation.resolution])}</Notice>}
    {lot.resolution && <p>{t(reasonLabels[lot.resolution])}{lot.resolutionNote ? ' · ' + lot.resolutionNote : ''}</p>}
    <div className="lot-table-scroll" role="region" aria-label={t('Участники лота')} tabIndex={0}>
      <table className="lot-members-table"><thead>
        <tr><th scope="col">{t('Карточка')}</th><th scope="col">{t('Принципал')}</th><th scope="col">{t('Ответ и мандат')}</th><th scope="col">{t('Показатели')}</th></tr>
      </thead><tbody>
        {lot.members.map(member => <tr key={member.listingId}>
          <td><strong>{member.title}</strong><p>{member.nickname} · {t(member.representation === 'DIRECT' ? 'Прямой участник' : 'Агент')}</p>
            <p>{t(memberRole[member.membershipRole])}</p>
            {member.appealReason && <p><strong>{t('Оспаривание')}</strong> · {member.appealReason}</p>}
            {member.membershipRole === 'DUPLICATE' && <Button variant="secondary" onClick={() => select('restore', member.listingId)}>{t('Вернуть дубль')}</Button>}
          </td>
          <td>{member.principalName || '—'}{member.principalCompany ? <p>{member.principalCompany}</p> : null}
            {member.principalName && <p>{t(member.confirmedAt ? 'Подтверждён' : 'Не подтверждён')}</p>}
          </td>
          <td>{member.principalLegalName ?? (member.requestId ? t('Ответ пока не получен') : '—')}
            {member.answeredAt && <p>{t(member.exclusiveMandate ? 'Эксклюзивный мандат указан' : 'Эксклюзивный мандат отсутствует')}</p>}
            {member.requestNote && <p>{member.requestNote}</p>}
            {member.mandateDocumentId && <p><a className="text-link" download href={'/api/v1/documents/' + member.mandateDocumentId + '/file'}>
              {member.mandateFileName}</a> · {t(documentStatuses[member.mandateStatus ?? ''])}</p>}
            {lot.status === 'OPEN' && member.mandateStatus === 'PENDING' && member.mandateDocumentId &&
              <Button variant="secondary" onClick={() => select('approve', member.mandateDocumentId!)}>{t('Одобрить мандат')}</Button>}
          </td>
          <td><ListingPrice listing={{ kind: 'SELL', price: member.pricePerUnit, currency: member.currency, quantity: member.quantity }} />
            <p>{t('Количество')}: {member.quantity}</p>
            {member.listingConfirmedAt && <p>{t('Актуальность')}: {actualityDate(member.listingConfirmedAt, locale)}</p>}
            {member.trustScore != null && <p>{t('Рейтинг объявления')}: {member.trustScore}</p>}
          </td>
        </tr>)}
      </tbody></table>
    </div>
    {lot.status === 'OPEN' && <div className="admin-actions">
      <Button variant="secondary" onClick={() => select('principals')}>{t('Запросить принципала')}</Button>
      <Button variant="secondary" onClick={() => select('shared')}>{t('Принципал общий')}</Button>
      <Button onClick={() => select('resolve')}>{t('Оставить главной')}</Button>
      <Button variant="secondary" onClick={() => select('dissolve')}>{t('Это разные лоты')}</Button>
    </div>}
    {notice && <Notice tone="success">{notice}</Notice>}
    {action && <form ref={actionForm} tabIndex={-1} className="workflow-stack panel workflow-section" onSubmit={submit} aria-busy={pending}>
      {action === 'principals' && <p>{t('Запрос получат агенты группы. Каждый увидит только своё объявление и свою форму ответа.')}</p>}
      {action === 'approve' && <p>{t('Подтвердите, что документ относится к полномочиям агента по этому объявлению.')}</p>}
      {action === 'shared' && <>
        <Field label={t('Принципал общий?')}><select name="shared" defaultValue={lot.sharedPrincipal === false ? 'false' : 'true'}>
          <option value="true">{t('Да')}</option><option value="false">{t('Нет')}</option>
        </select></Field>
        <Field label={t('Карточка самого принципала')}>
          <select name="owner" defaultValue={lot.principalOwnerListingId ?? ''}>
            <option value="">{t('Не указана')}</option>
            {candidates.filter(member => member.representation === 'DIRECT').map(member => <option value={member.listingId} key={member.listingId}>{member.title} · {member.nickname}</option>)}
          </select>
        </Field>
      </>}
      {action === 'resolve' && <>
        <Field label={t('Главная карточка')}>
          <select value={primary} onChange={event => setPrimary(event.target.value)} required>
            <option value="">{t('Выберите объявление')}</option>
            {candidates.map(member => <option key={member.listingId} value={member.listingId}>{member.title} · {member.nickname}</option>)}
          </select>
        </Field>
        <p>{t(reasonLabels[advised])}</p>
      </>}
      {action === 'restore' && <p><strong>{t('Вернуть объявление')}</strong> · {lot.members.find(member => member.listingId === memberId)?.title}</p>}
      {(action === 'dissolve' || action === 'resolve' || action === 'restore') &&
        <Field label={t('Причина')}><textarea name="note" maxLength={1000} required={action !== 'resolve' || advised === 'OPERATOR'} /></Field>}
      {error && <Notice tone="error">{t(error)}</Notice>}
      <div className="admin-actions"><Button type="submit" disabled={pending}>{t('Подтвердить')}</Button>
        <Button variant="secondary" onClick={() => setAction(undefined)} disabled={pending}>{t('Отмена')}</Button></div>
    </form>}
  </div>
}

export function AdminLotsPanel() {
  const { t } = useI18n()
  const { features } = useExchange()
  const [params, setParams] = useSearchParams()
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [pending, setPending] = useState(false)
  const selected = params.get('lot')
  const result = useTrustData<{ items: AdminLot[]; total: number; limit: number }>(
    '/admin/lot-groups?' + new URLSearchParams({ status, page: String(page) }), revision, true)
  const detail = useTrustData<AdminLot>(selected ? '/admin/lot-groups/' + selected : null, revision, true)
  const open = (id?: string) => {
    const next = new URLSearchParams(params)
    if (id) next.set('lot', id)
    else next.delete('lot')
    setParams(next)
  }
  return <section className="workflow-stack">
    <h2>{t('Дубли лотов')}</h2>
    {features.feature_lot_groups === false && <Notice>{t('Поиск похожих лотов выключен. Принятые решения доступны в списке.')}</Notice>}
    <Field label={t('Статус группы')}>
      <select value={status} onChange={event => { setStatus(event.target.value); setPage(1) }}>
        <option value="">{t('Все группы')}</option>
        {Object.entries(groupStatus).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
      </select>
    </Field>
    {result.loading && !result.data && <Spinner />}
    {result.error && <Notice tone="error">{t(result.error)}</Notice>}
    {result.data?.items.length === 0 && <Notice>{t('Групп похожих лотов пока нет.')}</Notice>}
    {result.data && <ul className="exchange-records">{result.data.items.map(lot => {
      const sample = lot.members.find(member => member.membershipRole !== 'REMOVED') ?? lot.members[0]
      return <li className="panel exchange-record" key={lot.id}>
        <strong>{t('Лот №{number}', { number: lot.number })} · {lot.modelName}</strong>
        <p>{t(groupStatus[lot.status])} · {t('Участников: {number}', { number: lot.participants })}
          {sample?.quantity ? ' · ' + t('{number} шт', { number: sample.quantity }) : ''}{sample?.city ? ' · ' + sample.city : ''}</p>
        {lot.recommendation && <p>{t('Есть рекомендация')} · {t(reasonLabels[lot.recommendation.resolution])}</p>}
        <div className="admin-actions"><Button variant="secondary" aria-haspopup="dialog" onClick={() => open(lot.id)}>{t('Открыть группу')}</Button></div>
      </li>
    })}</ul>}
    {result.data && result.data.total > result.data.limit && <nav className="admin-actions" aria-label={t('Страницы групп лотов')}>
      <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>{t('Назад')}</Button>
      <Button variant="secondary" disabled={page * result.data.limit >= result.data.total} onClick={() => setPage(value => value + 1)}>{t('Далее')}</Button>
    </nav>}
    {selected && <StaffDialog title={detail.data ? t('Лот №{number}', { number: detail.data.number }) : t('Группа лотов')}
      onClose={() => open()} closeDisabled={pending}>
      {detail.loading && !detail.data && <Spinner />}
      {detail.error && <Notice tone="error">{t(detail.error)}</Notice>}
      {detail.data && <StaffLotDetails key={selected} lot={detail.data} onChange={() => setRevision(value => value + 1)} onBusy={setPending} />}
    </StaffDialog>}
  </section>
}
