import { lazy, Suspense, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, isStaff, type User } from './api'
import { useI18n } from './i18n'
import { ListingForm } from './ListingForm'
import { StaffDialog } from './StaffDialog'
import { TelegramUserControl } from './Telegram'
import { CountrySelect } from './CountrySelect'
import { categoryIcons, countryName, reportReasonNames } from './market'
import { Button, Field, Notice, Spinner } from './ui'
import './admin.css'

const ExchangeAdministration = lazy(() => import('./ExchangeAdmin'))

const tabs = {
  users: 'Пользователи',
  listings: 'Объявления',
  categories: 'Категории',
  reviews: 'Отзывы',
  reports: 'Жалобы',
  content: 'Страницы',
  locales: 'Языки',
  moderators: 'Модераторы',
  exchange: 'Закрытая биржа',
  audit: 'Журнал действий',
} as const

type Tab = keyof typeof tabs
type StatusTab = 'users' | 'listings' | 'reviews' | 'reports'
type PagedTab = StatusTab | 'moderators' | 'audit'
type Translator = ReturnType<typeof useI18n>['t']

const statuses: Partial<Record<PagedTab, readonly string[]>> = {
  users: ['ACTIVE', 'FROZEN', 'BANNED'],
  moderators: ['ACTIVE', 'FROZEN', 'BANNED'],
  listings: ['PENDING_REVIEW', 'PENDING_OWNER', 'ACTIVE', 'FROZEN', 'BANNED', 'ARCHIVED'],
  reviews: ['ACTIVE', 'HIDDEN', 'BANNED'],
  reports: ['OPEN', 'RESOLVED', 'REJECTED'],
}

const labels: Record<string, string> = {
  ACTIVE: 'Активен',
  FROZEN: 'Заморожен',
  HIDDEN: 'Скрыт',
  BANNED: 'Заблокирован навсегда',
  ARCHIVED: 'В архиве',
  PENDING_REVIEW: 'На проверке',
  PENDING_OWNER: 'Ждёт владельца',
  OPEN: 'Открыта',
  RESOLVED: 'Решена',
  REJECTED: 'Отклонена',
  SELL: 'Продажа',
  BUY: 'Покупка',
  BUYER: 'Покупатель',
  SELLER: 'Продавец',
  ADMIN: 'Администратор',
  MODERATOR: 'Модератор',
  AGENT: 'Агент модерации',
  COMPANY: 'Компания',
  INDIVIDUAL: 'Частное лицо',
  ...reportReasonNames,
  CONTACT_BYPASS: 'Попытки обхода защиты контактов',
  CONTACT_PHOTO: 'Контакты на фото',
  ON_PLATFORM: 'Чат площадки',
  VERIFIED_TELEGRAM: 'Привязанный Telegram',
  edited: 'Редактирование',
  created: 'Создание',
  'status-changed': 'Изменение статуса',
  'status-unchanged': 'Проверка статуса',
  'status-denied': 'Отказ в смене статуса',
  'edit-denied': 'Отказ в редактировании',
  'profiles-listed': 'Просмотр списка профилей',
  'profile-viewed': 'Просмотр профиля',
  'profile-edited': 'Редактирование профиля',
  'reports-listed': 'Просмотр списка жалоб',
  'report-viewed': 'Просмотр жалобы',
  'evidence-viewed': 'Просмотр переписки по жалобе',
  'contact-blocks-viewed': 'Просмотр журнала попыток обхода',
  'credentials-changed': 'Смена данных для входа',
  'moderator-created': 'Создание модератора',
  login: 'Вход в аккаунт',
  logout: 'Выход из аккаунта',
}

type UserRow = {
  id: string
  username: string
  displayName: string
  role: string
  participantType: string | null
  city: string | null
  country: string | null
  email: string | null
  telegram: string | null
  companyName: string | null
  status: string
  emailVerified: boolean
  companyEmailStatus?: 'CORPORATE' | 'PUBLIC' | 'UNVERIFIED' | null
  createdAt: string
}

type ListingRow = {
  id: string
  title: string
  kind: string
  owner: { nickname: string; city: string; country: string }
  status: string
  createdAt: string
}

type Person = { nickname: string }

type ReviewRow = {
  id: string
  rating: number
  comment: string
  status: string
  author: Person
  subject: Person
  chatId: string
  createdAt: string
}

type ReportRow = {
  id: string
  chatId: string | null
  listingId?: string | null
  reporter: Person | null
  subject: Person
  reason: string
  scope?: string
  details: string
  status: string
  createdAt: string
  resolution?: string | null
}

type ReportMessage = { id: number; body: string; nickname: string; createdAt: string }

type AuditRow = {
  id: number
  actor: string | { username?: string; nickname?: string; id?: string } | null
  actorRole: User['role'] | 'AGENT' | null
  entity: string
  entityId: string
  action: string
  reason: string | null
  before: unknown
  after: unknown
  createdAt: string
}

type CategoryTranslation = { name: string; shortName?: string; description?: string }
type CategoryRow = {
  id: string
  slug: string
  name: string
  shortName?: string
  description?: string | null
  icon?: string | null
  parentId?: string | null
  sortOrder: number
  active: boolean
  translations?: Record<string, CategoryTranslation>
  attributeKeys?: string[]
}

type ContentTranslation = { title: string; body: string }
type ContentRow = {
  key: string
  active: boolean
  translations: Record<string, ContentTranslation>
  updatedAt: string
}

type LocaleRow = {
  code: string
  name: string
  active: boolean
  messages: Record<string, string>
}

type Page<T> = { items: T[]; total: number; page: number; limit: number }

type Editor =
  | { type: 'user'; id: string; row?: UserRow }
  | { type: 'listing'; id: string }
  | { type: 'listing-review'; id: string; name: string }
  | { type: 'status'; tab: StatusTab; id: string; name: string; status: string; report?: ReportRow }
  | { type: 'category'; row?: CategoryRow; categories: CategoryRow[]; locales: LocaleRow[] }
  | { type: 'content'; row?: ContentRow; locales: LocaleRow[]; existingKeys?: string[] }
  | { type: 'locale'; row?: LocaleRow; existingCodes?: string[] }
  | { type: 'moderator' }

function statusLabel(t: Translator, value: string) {
  return Object.hasOwn(labels, value) ? t(labels[value]) : value
}

function formatDate(locale: string, date?: string, withTime = false) {
  if (!date) return '—'
  const value = new Date(date)
  if (Number.isNaN(+value)) return '—'
  return withTime ? value.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' }) : value.toLocaleDateString(locale)
}

function formText(data: FormData, key: string) {
  return String(data.get(key) ?? '').trim()
}

function geography(city: string | null | undefined, country: string | null | undefined, locale: string) {
  return [city, country ? countryName(country, locale) : undefined].filter(Boolean).join(', ')
}

function useAdminData<T>(path: string | null, version: number) {
  const { t } = useI18n()
  const [state, setState] = useState<{ path: string; version: number; data?: T; error?: string }>()
  useEffect(() => {
    if (!path) return
    const controller = new AbortController()
    void api<T>(path, { signal: controller.signal }).then(
      data => {
        if (!controller.signal.aborted) setState({ path, version, data })
      },
      error => {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : ''
          setState({ path, version, error: message })
        }
      },
    )
    return () => controller.abort()
  }, [path, version])
  if (!path) return { loading: false }
  if (state?.path !== path || state.version !== version) return { loading: true }
  return {
    loading: false,
    data: state.data,
    error: state.data === undefined ? t(state.error || 'Не удалось загрузить данные.') : undefined,
  }
}

type Column<T> = { label: string; render: (item: T) => ReactNode }

function AdminTable<T>({ items, columns, identify }: { items: T[]; columns: Column<T>[]; identify: (item: T) => string | number }) {
  const { t } = useI18n()
  if (!items.length) return <p className="admin-empty muted">{t('Записей нет.')}</p>
  return <table className="admin-table">
    <thead><tr>{columns.map(column => <th key={column.label} scope="col">{column.label}</th>)}</tr></thead>
    <tbody>{items.map(item => <tr key={identify(item)}>
      {columns.map(column => <td key={column.label} data-label={column.label}><div>{column.render(item)}</div></td>)}
    </tr>)}</tbody>
  </table>
}

function RecordLabel({ title, detail }: { title: ReactNode; detail?: ReactNode }) {
  return <><span className="admin-record">{title}</span>{detail ? <span className="admin-meta muted">{detail}</span> : null}</>
}

function PagedRecords<T extends { id: string | number; status?: string }>({
  tab, version, columns, headerAction, subjectId,
}: {
  tab: PagedTab
  version: number
  columns: Column<T>[]
  headerAction?: ReactNode
  subjectId?: string
}) {
  const { t } = useI18n()
  const [routeQuery] = useSearchParams()
  const initialStatus = tab === 'listings' ? routeQuery.get('status') ?? '' : ''
  const [page, setPage] = useState(1)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState(initialStatus)
  const [reviewSignal, setReviewSignal] = useState('')
  const [actorRole, setActorRole] = useState('')
  const [withoutModel, setWithoutModel] = useState(false)
  const [retry, setRetry] = useState(0)
  const limit = 20
  const params = new URLSearchParams({ page: String(page), limit: String(limit) })
  if (query) params.set('q', query)
  if (status) params.set('status', status)
  if (reviewSignal) params.set('reviewSignal', reviewSignal)
  if (tab === 'audit' && actorRole) params.set('actorRole', actorRole)
  if (tab === 'listings' && withoutModel) params.set('withoutModel', 'true')
  if (tab === 'moderators') params.set('role', 'MODERATOR')
  if (subjectId) params.set('subjectId', subjectId)
  const path = tab === 'moderators' ? 'users' : tab
  const { data, loading, error } = useAdminData<Page<T>>('/admin/' + path + '?' + params.toString(), version + retry)
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / limit))
  useEffect(() => { setStatus(initialStatus); setPage(1) }, [initialStatus, tab])
  useEffect(() => {
    if (data && page > pages) setPage(pages)
  }, [data, page, pages])

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setQuery(draft.trim())
    setPage(1)
  }

  return <>
    <div className="admin-toolbar"><h2>{t(tabs[tab])}</h2>{data && <span className="muted">{t('Всего записей · {count}', { count: data.total })}</span>}{headerAction}</div>
    <form className="admin-filters" onSubmit={search}>
      <Field label={t('Поиск')}>
        <input type="search" value={draft} onChange={event => setDraft(event.target.value)} maxLength={120} />
      </Field>
      {statuses[tab] && <Field label={t('Статус')}>
        <select value={status} onChange={event => { setStatus(event.target.value); setPage(1) }}>
          <option value="">{t('Все статусы')}</option>
          {statuses[tab].map(value => <option key={value} value={value}>{statusLabel(t, value)}</option>)}
        </select>
      </Field>}
      {tab === 'audit' && <Field label={t('Роль исполнителя')}>
        <select value={actorRole} onChange={event => { setActorRole(event.target.value); setPage(1) }}>
          <option value="">{t('Все роли')}</option>
          {['ADMIN', 'MODERATOR', 'AGENT', 'BUYER', 'SELLER'].map(role => <option key={role} value={role}>{statusLabel(t, role)}</option>)}
        </select>
      </Field>}
      {tab === 'listings' && <label className="admin-check"><input type="checkbox" checked={withoutModel}
        onChange={event => { setWithoutModel(event.target.checked); setPage(1) }} />{t('Без модели')}</label>}
      {tab === 'listings' && <Field label={t('Сигнал для проверки')}>
        <select value={reviewSignal} onChange={event => { setReviewSignal(event.target.value); setPage(1) }}>
          <option value="">{t('Все объявления')}</option>
          <option value="RECENT">{t('Новые и изменённые')}</option>
          <option value="UNVERIFIED">{t('Участник не проверен')}</option>
          <option value="PRICE_OUTSIDE">{t('Цена вне рыночного коридора')}</option>
          <option value="PRICE_DROPS">{t('Цена снижалась 3 раза за 14 дней')}</option>
          <option value="NEW_MODEL">{t('Модель добавлена за последние 14 дней')}</option>
          <option value="POSSIBLE_DUPLICATE">{t('Похожее предложение')}</option>
        </select>
      </Field>}
      <Button variant="secondary" type="submit">{t('Найти')}</Button>
    </form>
    {loading && <Spinner />}
    {error && <Notice tone="error">{error} <Button type="button" variant="ghost" onClick={() => setRetry(retry + 1)}>{t('Повторить')}</Button></Notice>}
    {data && <>
      <AdminTable items={data.items} columns={columns} identify={item => item.id} />
      {pages > 1 && <nav className="admin-pager" aria-label={t('Страницы результатов')}>
        <span className="muted">{t('Страница {page} из {total}', { page, total: pages })}</span>
        <div className="admin-actions">
          <Button variant="secondary" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('Назад')}</Button>
          <Button variant="secondary" type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>{t('Далее')}</Button>
        </div>
      </nav>}
    </>}
  </>
}

type PagedProps = { version: number; edit: (editor: Editor) => void }

function isMarketProfile(row: UserRow) {
  return row.role === 'BUYER' || row.role === 'SELLER'
}

function Users({ version, edit, administrator }: PagedProps & { administrator: boolean }) {
  const { t, locale } = useI18n()
  return <PagedRecords<UserRow> tab="users" version={version} columns={[
    { label: t('Пользователь'), render: row => <RecordLabel title={row.displayName} detail={<>{row.username}{row.email && ` · ${row.email}`}{(row.city || row.country) && <><br />{geography(row.city, row.country, locale)}</>}</>} /> },
    { label: t('Роль'), render: row => <RecordLabel title={statusLabel(t, row.role)} detail={row.companyName || (row.participantType ? statusLabel(t, row.participantType) : undefined)} /> },
    { label: t('Статус'), render: row => <RecordLabel title={statusLabel(t, row.status)} detail={<>
      {row.emailVerified ? t('Почта подтверждена') : t('Почта ожидает подтверждения')}<br />{formatDate(locale, row.createdAt)}
      {row.companyEmailStatus && <><br />{t(row.companyEmailStatus === 'CORPORATE' ? 'Почта компании подтверждена'
        : row.companyEmailStatus === 'PUBLIC' ? 'Почта компании подтверждена, общий домен' : 'Почта компании не проверена')}</>}
    </>} /> },
    { label: t('Действия'), render: row => isMarketProfile(row) && <div className="admin-actions">
      <Button variant="secondary" type="button" onClick={() => edit({ type: 'user', id: row.id })}>{t('Редактировать')}</Button>
      {row.status !== 'BANNED' && <Button variant="ghost" type="button" onClick={() => edit({ type: 'status', tab: 'users', id: row.id, name: row.displayName, status: row.status })}>{t('Статус')}</Button>}
      <Link className="button button-ghost" to={'/admin?section=exchange&part=onboarding&userId=' + row.id}>{t('Анкета')}</Link>
      <Link className="button button-ghost" to={'/admin?section=exchange&part=verification&userId=' + row.id}>{t('Проверка')}</Link>
      {row.status === 'ACTIVE' && row.emailVerified && <Link className="button button-ghost" to={`/admin/users/${row.id}/listing/new`}>
        {t('Завести объявление за участника')}
      </Link>}
      {administrator && <Link className="button button-ghost" to={'/admin?section=exchange&part=user-consents&userId=' + row.id}>{t('История согласий')}</Link>}
    </div> },
  ]} />
}

function Moderators({ version, edit }: PagedProps) {
  const { t, locale } = useI18n()
  return <PagedRecords<UserRow> tab="moderators" version={version}
    headerAction={<Button onClick={() => edit({ type: 'moderator' })}>{t('Добавить модератора')}</Button>}
    columns={[
      { label: t('Модератор'), render: row => <RecordLabel title={row.displayName} detail={<>{row.username}{row.email && ` · ${row.email}`}</>} /> },
      { label: t('Статус'), render: row => <RecordLabel title={statusLabel(t, row.status)} detail={<>{row.emailVerified ? t('Почта подтверждена') : t('Почта ожидает подтверждения')}<br />{formatDate(locale, row.createdAt)}</>} /> },
      { label: t('Действия'), render: row => row.status !== 'BANNED' && <Button variant="ghost" onClick={() => edit({ type: 'status', tab: 'users', id: row.id, name: row.displayName, status: row.status })}>{t('Статус')}</Button> },
    ]} />
}

function Listings({ version, edit }: PagedProps) {
  const { t, locale } = useI18n()
  return <PagedRecords<ListingRow> tab="listings" version={version} columns={[
    { label: t('Объявление'), render: row => <RecordLabel title={<Link className="text-link" to={'/listings/' + row.id}>{row.title}</Link>} detail={statusLabel(t, row.kind)} /> },
    { label: t('Автор'), render: row => <RecordLabel title={row.owner?.nickname ?? '—'} detail={geography(row.owner?.city, row.owner?.country, locale)} /> },
    { label: t('Статус'), render: row => <RecordLabel title={statusLabel(t, row.status)} detail={formatDate(locale, row.createdAt)} /> },
    { label: t('Действия'), render: row => <div className="admin-actions">
      <Button variant="secondary" type="button" onClick={() => edit({ type: 'listing', id: row.id })}>{t('Редактировать')}</Button>
      {row.status === 'PENDING_REVIEW' && <Button type="button" onClick={() => edit({ type: 'listing-review', id: row.id, name: row.title })}>
        {t('Рассмотреть')}
      </Button>}
      {row.status !== 'BANNED' && !row.status.startsWith('PENDING_') &&
        <Button variant="ghost" type="button" onClick={() => edit({ type: 'status', tab: 'listings', id: row.id, name: row.title, status: row.status })}>{t('Статус')}</Button>}
    </div> },
  ]} />
}

function Reviews({ version, edit, subjectId }: PagedProps & { subjectId?: string }) {
  const { t, locale } = useI18n()
  return <PagedRecords<ReviewRow> tab="reviews" version={version} subjectId={subjectId} columns={[
    { label: t('Отзыв'), render: row => <RecordLabel title={t('{rating} из 5', { rating: row.rating })} detail={row.comment} /> },
    { label: t('Участники'), render: row => <RecordLabel title={row.author?.nickname ?? '—'} detail={t('О профиле {name}', { name: row.subject?.nickname ?? '—' })} /> },
    { label: t('Статус'), render: row => <RecordLabel title={statusLabel(t, row.status)} detail={formatDate(locale, row.createdAt)} /> },
    { label: t('Действия'), render: row => row.status !== 'BANNED' && <Button variant="secondary" type="button" onClick={() => edit({ type: 'status', tab: 'reviews', id: row.id, name: row.comment || t('Отзыв'), status: row.status })}>{t('Модерировать')}</Button> },
  ]} />
}

function Reports({ version, edit, subjectId }: PagedProps & { subjectId?: string }) {
  const { t, locale } = useI18n()
  return <PagedRecords<ReportRow> tab="reports" version={version} subjectId={subjectId} columns={[
    { label: t('Жалоба'), render: row => <RecordLabel title={statusLabel(t, row.reason)} detail={row.details.length > 150 ? row.details.slice(0, 149) + '…' : row.details} /> },
    { label: t('Участники'), render: row => <RecordLabel title={row.reporter?.nickname ?? t('Площадка')} detail={t('На профиль {name}', { name: row.subject?.nickname ?? '—' })} /> },
    { label: t('Статус'), render: row => <RecordLabel title={statusLabel(t, row.status)} detail={formatDate(locale, row.createdAt)} /> },
    { label: t('Действия'), render: row => <Button variant="secondary" type="button" onClick={() => edit({ type: 'status', tab: 'reports', id: row.id, name: statusLabel(t, row.reason), status: row.status })}>{t('Рассмотреть')}</Button> },
  ]} />
}

function Audit({ version }: { version: number }) {
  const { t, locale } = useI18n()
  return <PagedRecords<AuditRow> tab="audit" version={version} columns={[
    { label: t('Действие'), render: row => <RecordLabel title={statusLabel(t, row.action)} detail={row.reason} /> },
    { label: t('Объект'), render: row => <RecordLabel title={Object.hasOwn(tabs, row.entity) ? t(tabs[row.entity as Tab]) : row.entity} detail={row.entityId} /> },
    { label: t('Исполнитель'), render: row => <RecordLabel title={typeof row.actor === 'string' ? row.actor : row.actor?.username ?? row.actor?.nickname ?? row.actor?.id ?? '—'} detail={<>{row.actorRole && <>{statusLabel(t, row.actorRole)}<br /></>}{formatDate(locale, row.createdAt, true)}</>} /> },
    { label: t('Изменения'), render: row => <details className="admin-audit">
      <summary>{t('Подробнее')}</summary>
      <pre>{JSON.stringify({ [t('До')]: row.before, [t('После')]: row.after }, null, 2)}</pre>
    </details> },
  ]} />
}

function ReferenceRecords({ tab, version, edit, administrator }: { tab: 'categories' | 'content' | 'locales'; version: number; edit: (editor: Editor) => void; administrator: boolean }) {
  const { t, locale } = useI18n()
  const [retry, setRetry] = useState(0)
  const records = useAdminData<CategoryRow[] | ContentRow[] | LocaleRow[]>('/admin/' + tab, version + retry)
  const locales = useAdminData<LocaleRow[]>(tab === 'locales' ? null : '/admin/locales', version + retry)
  const error = records.error ?? locales.error
  if (error) return <Notice tone="error">{error} <Button type="button" variant="ghost" onClick={() => setRetry(retry + 1)}>{t('Повторить')}</Button></Notice>
  if (records.loading || locales.loading) return <Spinner />
  if (tab === 'categories') {
    const categories = records.data as CategoryRow[]
    const names = new Map(categories.map(row => [row.id, row.name]))
    return <>
      <div className="admin-toolbar">
        <h2>{t(tabs.categories)}</h2>
        <Button type="button" onClick={() => edit({ type: 'category', categories, locales: locales.data ?? [] })}>{t('Добавить категорию')}</Button>
      </div>
      <AdminTable identify={row => row.id} items={categories} columns={[
        { label: t('Категория'), render: row => <RecordLabel title={row.name} detail={row.slug} /> },
        { label: t('Родительская категория'), render: row => row.parentId ? names.get(row.parentId) ?? '—' : '—' },
        { label: t('Статус'), render: row => row.active ? t('В каталоге') : t('Скрыта') },
        { label: t('Действия'), render: row => <Button variant="secondary" type="button" onClick={() => edit({ type: 'category', row, categories, locales: locales.data ?? [] })}>{t('Редактировать')}</Button> },
      ]} />
    </>
  }
  if (tab === 'content') {
    const pages = records.data as ContentRow[]
    const adminPages = new Set(['rules', 'rules_draft', 'pd_policy'])
    return <>
      <div className="admin-toolbar">
        <h2>{t(tabs.content)}</h2>
        <Button type="button" onClick={() => edit({ type: 'content', locales: locales.data ?? [], existingKeys: pages.map(row => row.key) })}>{t('Добавить страницу')}</Button>
      </div>
      <AdminTable identify={row => row.key} items={pages} columns={[
        { label: t('Страница'), render: row => {
          const title = row.translations[locale]?.title ?? row.translations.ru?.title ?? row.key
          return <RecordLabel title={row.active ? <Link className="text-link" to={'/info/' + row.key}>{title}</Link> : title}
            detail={'/info/' + row.key} />
        } },
        { label: t('Статус'), render: row => <RecordLabel title={row.active ? t('Опубликована') : t('Скрыта')} detail={formatDate(locale, row.updatedAt)} /> },
        { label: t('Действия'), render: row => row.key !== 'rules_upcoming' && (administrator || !adminPages.has(row.key))
          ? <Button variant="secondary" type="button" onClick={() => edit({ type: 'content', row, locales: locales.data ?? [] })}>{t('Редактировать')}</Button>
          : <span className="muted">{t('Управляет администратор')}</span> },
      ]} />
    </>
  }
  const languages = records.data as LocaleRow[]
  return <>
    <div className="admin-toolbar">
      <h2>{t(tabs.locales)}</h2>
      <Button type="button" onClick={() => edit({ type: 'locale', existingCodes: languages.map(row => row.code) })}>{t('Добавить язык')}</Button>
    </div>
    <AdminTable identify={row => row.code} items={languages} columns={[
      { label: t('Язык'), render: row => <RecordLabel title={row.name} detail={row.code} /> },
      { label: t('Переводы'), render: row => Object.keys(row.messages ?? {}).length },
      { label: t('Статус'), render: row => row.active ? t('Доступен') : t('Отключён') },
      { label: t('Действия'), render: row => <Button variant="secondary" type="button" onClick={() => edit({ type: 'locale', row })}>{t('Редактировать')}</Button> },
    ]} />
  </>
}

function MutationForm({
  onClose, onSaved, save, children, buttonLabel,
}: {
  onClose: () => void
  onSaved: (result?: unknown) => void
  save: (data: FormData) => Promise<unknown>
  children: ReactNode
  buttonLabel?: string
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const data = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      const result = await save(data)
      onSaved(result)
    } catch (error) {
      setError(t(error instanceof Error ? error.message : 'Не удалось сохранить изменения.'))
    } finally {
      setBusy(false)
    }
  }
  return <form onSubmit={submit} aria-busy={busy}>
    {children}
    {error && <Notice tone="error">{error}</Notice>}
    <div className="admin-actions">
      <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{t('Отмена')}</Button>
      <Button type="submit" disabled={busy}>{busy ? t('Сохранение…') : buttonLabel ?? t('Сохранить')}</Button>
    </div>
  </form>
}

function UserForm({ row, onClose, onSaved }: { row: UserRow; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n()
  const [participantType, setParticipantType] = useState(row.participantType ?? 'INDIVIDUAL')
  const company = participantType === 'COMPANY'
  return <MutationForm onClose={onClose} onSaved={onSaved} save={data => api('/admin/users/' + row.id, {
    method: 'PATCH',
    body: {
      displayName: formText(data, 'displayName'),
      participantType,
      city: formText(data, 'city'),
      country: formText(data, 'country').toUpperCase(),
      telegram: formText(data, 'telegram').replace(/^@/, ''),
      companyName: company ? formText(data, 'companyName') : null,
    },
  })}>
    <p className="muted">{row.username} · {row.email}</p>
    <div className="form-grid">
      <Field label={t('Публичный ник')}><input name="displayName" defaultValue={row.displayName} required minLength={2} maxLength={80} /></Field>
      <Field label={t('Тип участника')}>
        <select name="participantType" value={participantType} onChange={event => setParticipantType(event.target.value)}>
          <option value="INDIVIDUAL">{t('Частное лицо')}</option>
          <option value="COMPANY">{t('Компания')}</option>
        </select>
      </Field>
      {company && <Field label={t('Название компании')}><input name="companyName" defaultValue={row.companyName ?? ''} required minLength={2} maxLength={120} /></Field>}
      <Field label={t('Город')}><input name="city" defaultValue={row.city ?? ''} required minLength={2} maxLength={80} /></Field>
      <CountrySelect label={t('Страна')} name="country" defaultValue={row.country ?? ''} required />
      <Field label={t('Ник в Telegram')}><input name="telegram" defaultValue={row.telegram ?? ''} required pattern="@?[A-Za-z][A-Za-z0-9_]{4,31}" maxLength={33} /></Field>
    </div>
  </MutationForm>
}

function UserEditor({ id, close, saved }: { id: string } & EditorActions) {
  const { t } = useI18n()
  const [retry, setRetry] = useState(0)
  const { data: row, error, loading } = useAdminData<UserRow>('/admin/users/' + id, retry)
  if (loading) return <Spinner />
  if (error) return <Notice tone="error">{error} <Button variant="ghost" onClick={() => setRetry(current => current + 1)}>{t('Повторить')}</Button></Notice>
  if (!row || !isMarketProfile(row)) return <Notice>{t('Запись недоступна для редактирования.')}</Notice>
  return <UserForm row={row} onClose={close} onSaved={saved} />
}

function ModeratorForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n()
  const [temporaryPassword, setTemporaryPassword] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
  function generatePassword() {
    const bytes = crypto.getRandomValues(new Uint8Array(24))
    setTemporaryPassword(Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''))
    setPasswordVisible(true)
  }
  return <MutationForm onClose={onClose} onSaved={onSaved} buttonLabel={t('Создать модератора')} save={data => api('/admin/moderators', {
    method: 'POST', body: {
      username: formText(data, 'username'),
      displayName: formText(data, 'displayName'),
      email: formText(data, 'email'),
      temporaryPassword: String(data.get('temporaryPassword') ?? ''),
    },
  })}>
    <div className="form-grid">
      <Field label={t('Логин')}><input name="username" autoComplete="off" autoCapitalize="none" spellCheck={false} required pattern={String.raw`[A-Za-z0-9][A-Za-z0-9_.\-]{2,31}`} maxLength={32} /></Field>
      <Field label={t('Отображаемое имя')}><input name="displayName" autoComplete="off" required minLength={2} maxLength={80} /></Field>
      <Field label={t('Электронная почта')}><input name="email" type="email" autoComplete="off" required maxLength={254} /></Field>
      <Field label={t('Временный пароль')} hint={t('Не менее 12 символов.')}>
        <input name="temporaryPassword" type={passwordVisible ? 'text' : 'password'} value={temporaryPassword}
          onChange={event => setTemporaryPassword(event.target.value)} autoComplete="new-password" required minLength={12} maxLength={128} />
      </Field>
    </div>
    <div className="admin-password-actions">
      <Button variant="secondary" onClick={generatePassword}>{t('Создать случайный пароль')}</Button>
      <Button variant="ghost" onClick={() => setPasswordVisible(current => !current)}>{t(passwordVisible ? 'Скрыть пароль' : 'Показать пароль')}</Button>
    </div>
    <p className="muted admin-first-login">{t('Передайте модератору логин и временный пароль. При первом входе модератор введёт код из письма и выберет свой пароль.')}</p>
  </MutationForm>
}

function StatusForm({
  editor, onClose, onSaved,
}: {
  editor: Extract<Editor, { type: 'status' }>
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useI18n()
  const options = (statuses[editor.tab] ?? []).filter(status => status !== editor.status && !status.startsWith('PENDING_'))
  const [status, setStatus] = useState('')
  return <MutationForm onClose={onClose} onSaved={onSaved} buttonLabel={t('Применить статус')} save={data => api('/admin/' + editor.tab + '/' + editor.id + '/status', {
    method: 'PATCH', body: { status, reason: formText(data, 'reason') },
  })}>
    <p>{editor.name} <span className="muted">· {statusLabel(t, editor.status)}</span></p>
    {editor.report && <div>
      {editor.report.scope && editor.report.chatId && <p className="muted">{statusLabel(t, editor.report.scope)}</p>}
      <p className="preserve-text">{editor.report.details}</p>
      {editor.report.listingId && <Link className="text-link" to={'/listings/' + editor.report.listingId}>{t('Открыть объявление')}</Link>}
      {editor.report.resolution && <p className="muted preserve-text">{t('Решение · {reason}', { reason: editor.report.resolution })}</p>}
    </div>}
    {editor.tab === 'reports' && editor.report?.chatId && <ReportEvidence reportId={editor.id} />}
    <Field label={t('Новый статус')}>
      <select name="status" value={status} onChange={event => setStatus(event.target.value)} required>
        <option value="">{t('Выберите статус')}</option>
        {options.map(value => <option key={value} value={value}>{statusLabel(t, value)}</option>)}
      </select>
    </Field>
    <Field label={t('Причина')} hint={t('Причина сохранится в журнале действий.')}>
      <textarea name="reason" required minLength={3} maxLength={500} rows={3} />
    </Field>
    {status === 'BANNED' && <>
      <Notice>{t('Бессрочную блокировку «{name}» нельзя отменить.', { name: editor.name })}</Notice>
      <label className="admin-check"><input type="checkbox" required />{t('Подтверждаю бессрочную блокировку')}</label>
    </>}
  </MutationForm>
}

function ReportStatusForm({ editor, ...actions }: { editor: Extract<Editor, { type: 'status' }> } & EditorActions) {
  const { t } = useI18n()
  const [retry, setRetry] = useState(0)
  const { data: report, error, loading } = useAdminData<ReportRow>('/admin/reports/' + editor.id, retry)
  if (loading) return <Spinner />
  if (!report) return <Notice tone="error">{error} <Button variant="ghost" onClick={() => setRetry(current => current + 1)}>{t('Повторить')}</Button></Notice>
  return <StatusForm editor={{ ...editor, name: statusLabel(t, report.reason), status: report.status, report }} onClose={actions.close} onSaved={actions.saved} />
}

function ReportEvidence({ reportId }: { reportId: string }) {
  const { t, locale } = useI18n()
  const [page, setPage] = useState(0)
  const [retry, setRetry] = useState(0)
  const limit = 20
  const path = page ? '/admin/reports/' + reportId + '/messages?page=' + page + '&limit=' + limit : null
  const { data, error, loading } = useAdminData<Page<ReportMessage>>(path, retry)
  if (!page) return <div><Button type="button" variant="secondary" onClick={() => setPage(1)}>{t('Посмотреть переписку по жалобе')}</Button></div>
  return <div>
    <h3>{t('Сообщения чата площадки')}</h3>
    {loading && <Spinner />}
    {error && <Notice tone="error">{error} <Button type="button" variant="ghost" onClick={() => setRetry(retry + 1)}>{t('Повторить')}</Button></Notice>}
    {data && (data.items.length ? <ul className="admin-evidence">
      {data.items.map(message => <li key={message.id}>
        <RecordLabel title={message.nickname} detail={formatDate(locale, message.createdAt, true)} />
        <p className="preserve-text">{message.body}</p>
      </li>)}
    </ul> : <p className="muted">{t('В чате нет сообщений.')}</p>)}
    {data && data.total > limit && <div className="admin-actions">
      <Button type="button" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('Более новые')}</Button>
      <Button type="button" variant="secondary" disabled={page * limit >= data.total} onClick={() => setPage(page + 1)}>{t('Более ранние')}</Button>
    </div>}
  </div>
}

function additionalLanguages(locales: LocaleRow[], existing: Record<string, unknown> = {}) {
  const languages = new Map(locales.map(locale => [locale.code, locale.name]))
  for (const code of Object.keys(existing)) {
    if (!languages.has(code)) languages.set(code, code)
  }
  languages.delete('ru')
  return [...languages]
}

function CategoryForm({
  row, categories, locales, onClose, onSaved,
}: {
  row?: CategoryRow
  categories: CategoryRow[]
  locales: LocaleRow[]
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useI18n()
  const languages = additionalLanguages(locales, row?.translations)
  const parentOptions = categories.filter(category => {
    let current: CategoryRow | undefined = category
    const seen = new Set<string>()
    while (current && !seen.has(current.id)) {
      if (current.id === row?.id) return false
      seen.add(current.id)
      current = categories.find(candidate => candidate.id === current?.parentId)
    }
    return true
  })
  const iconList = Object.keys(categoryIcons)

  function save(data: FormData) {
    const name = formText(data, 'name')
    const shortName = formText(data, 'shortName') || name
    const description = formText(data, 'description')
    const translations = { ...row?.translations, ru: { name, shortName, description } }
    const allTranslations: Record<string, CategoryTranslation> = translations
    for (const [code] of languages) {
      const translatedName = formText(data, 'name.' + code)
      const translatedShortName = formText(data, 'shortName.' + code)
      const translatedDescription = formText(data, 'description.' + code)
      if ((translatedDescription || translatedShortName) && !translatedName) throw new Error(t('Укажите название категории для языка {code}.', { code }))
      if (translatedName) allTranslations[code] = { name: translatedName, shortName: translatedShortName || translatedName, description: translatedDescription }
      else delete allTranslations[code]
    }
    const body = {
      slug: formText(data, 'slug'),
      name,
      shortName,
      description,
      icon: formText(data, 'icon') || 'components',
      parentId: formText(data, 'parentId') || null,
      sortOrder: Number(data.get('sortOrder')),
      active: data.has('active'),
      attributeKeys: formText(data, 'attributeKeys').split(',').map(key => key.trim()).filter(Boolean),
      translations,
    }
    return api(row ? '/admin/categories/' + row.id : '/admin/categories', { method: row ? 'PATCH' : 'POST', body })
  }

  return <MutationForm onClose={onClose} onSaved={onSaved} save={save}>
    <div className="form-grid">
      <Field label={t('Название категории')}><input name="name" defaultValue={row?.name} required minLength={2} maxLength={120} /></Field>
      <Field label={t('Короткое название')} hint={t('Показывается в карточках и фильтрах.')}>
        <input name="shortName" defaultValue={row?.shortName} minLength={2} maxLength={120} />
      </Field>
      <Field label={t('Код в каталоге')} hint={t('Строчные латинские буквы, цифры и дефисы.')}>
        <input name="slug" defaultValue={row?.slug} required pattern="[a-z][a-z0-9_\-]{1,47}" maxLength={48} />
      </Field>
      <Field label={t('Родительская категория')}>
        <select name="parentId" defaultValue={row?.parentId ?? ''}>
          <option value="">{t('Самостоятельная категория')}</option>
          {parentOptions.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
      </Field>
      <Field label={t('Порядок сортировки')}><input type="number" name="sortOrder" min={0} max={10000} defaultValue={row?.sortOrder ?? 100} required /></Field>
      <Field label={t('Значок')}>
        <input name="icon" list="admin-category-icons" defaultValue={row?.icon ?? 'components'} pattern="[a-z](?:[a-z0-9]|-){1,47}" />
        <datalist id="admin-category-icons">{iconList.map(icon => <option key={icon} value={icon} />)}</datalist>
      </Field>
      <Field label={t('Характеристики')} hint={t('Названия полей через запятую.')}>
        <input name="attributeKeys" defaultValue={row?.attributeKeys?.join(', ')} maxLength={300} />
      </Field>
      <div className="admin-full"><Field label={t('Описание')}><textarea name="description" rows={3} defaultValue={row?.description ?? ''} maxLength={500} /></Field></div>
    </div>
    {languages.map(([code, language]) => <fieldset key={code}>
      <legend>{language}</legend>
      <Field label={t('Название категории')}><input name={'name.' + code} defaultValue={row?.translations?.[code]?.name} minLength={2} maxLength={120} /></Field>
      <Field label={t('Короткое название')}><input name={'shortName.' + code} defaultValue={row?.translations?.[code]?.shortName} minLength={2} maxLength={120} /></Field>
      <Field label={t('Описание')}><textarea name={'description.' + code} rows={2} defaultValue={row?.translations?.[code]?.description} maxLength={500} /></Field>
    </fieldset>)}
    <label className="admin-check"><input type="checkbox" name="active" defaultChecked={row?.active ?? true} />{t('Показывать в каталоге')}</label>
  </MutationForm>
}

function ContentForm({
  row, locales, existingKeys = [], onClose, onSaved,
}: {
  row?: ContentRow
  locales: LocaleRow[]
  existingKeys?: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useI18n()
  const languages: [string, string][] = [['ru', t('Русский')], ...additionalLanguages(locales, row?.translations)]
  function save(data: FormData) {
    const key = row?.key ?? formText(data, 'key')
    if (!row && existingKeys.includes(key)) throw new Error(t('Этот адрес уже используется. Откройте страницу для редактирования.'))
    const translations: Record<string, ContentTranslation> = {}
    for (const [code] of languages) {
      const title = formText(data, 'title.' + code)
      const body = formText(data, 'body.' + code)
      if (title && body) translations[code] = { title, body }
      else if (title || body) throw new Error(t('Заполните заголовок и текст для языка {code}.', { code }))
    }
    return api('/admin/content/' + encodeURIComponent(key), {
      method: 'PUT', body: { translations, active: data.has('active') },
    })
  }
  return <MutationForm onClose={onClose} onSaved={onSaved} save={save}>
    <Field label={t('Адрес страницы')} hint={t('Этот код используется после /info/ в адресе страницы.')}>
      <input name="key" defaultValue={row?.key} required readOnly={Boolean(row)} pattern="[a-z][a-z0-9_\-]{1,47}" maxLength={48} />
    </Field>
    {languages.map(([code, language]) => <fieldset key={code}>
      <legend>{language}</legend>
      <Field label={t('Заголовок')}><input name={'title.' + code} defaultValue={row?.translations[code]?.title} required={code === 'ru'} minLength={2} maxLength={140} /></Field>
      <Field label={t('Текст страницы')}><textarea name={'body.' + code} rows={6} defaultValue={row?.translations[code]?.body} required={code === 'ru'} maxLength={20000} /></Field>
    </fieldset>)}
    {row?.key === 'rules_draft' ? <p>{t('Замените значения в квадратных скобках. Новую версию можно запланировать в настройках биржи.')}</p> :
      <label className="admin-check"><input type="checkbox" name="active" defaultChecked={row?.active ?? false} />{t('Опубликовать страницу')}</label>}
  </MutationForm>
}

function LocaleForm({ row, existingCodes = [], onClose, onSaved }: { row?: LocaleRow; existingCodes?: string[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n()
  return <MutationForm onClose={onClose} onSaved={onSaved} save={data => {
    let messages: unknown
    const raw = formText(data, 'messages')
    try {
      messages = JSON.parse(raw || '{}')
    } catch {
      throw new Error(t('Переводы должны быть записаны в формате JSON.'))
    }
    if (typeof messages !== 'object' || messages === null || Array.isArray(messages) || Object.values(messages).some(value => typeof value !== 'string')) {
      throw new Error(t('Укажите JSON-объект со строковыми ключами и переводами.'))
    }
    const code = (row?.code ?? formText(data, 'code')).toLowerCase()
    if (!row && existingCodes.includes(code)) throw new Error(t('Этот язык уже добавлен. Откройте его для редактирования.'))
    return api('/admin/locales/' + encodeURIComponent(code), {
      method: 'PUT', body: { name: formText(data, 'name'), active: code === 'ru' || data.has('active'), messages },
    })
  }}>
    <div className="form-grid">
      <Field label={t('Название языка')}><input name="name" defaultValue={row?.name} required minLength={2} maxLength={80} /></Field>
      <Field label={t('Код языка')} hint={t('Например, en или en-GB.')}>
        <input name="code" defaultValue={row?.code} required readOnly={Boolean(row)} pattern="[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*" maxLength={35} />
      </Field>
    </div>
    <Field label={t('Переводы интерфейса')} hint={t('Ключ — исходная русская фраза, значение — перевод. Сохраняйте переменные, например {count}.')}>
      <textarea name="messages" className="admin-json" rows={10} defaultValue={JSON.stringify(row?.messages ?? {}, null, 2)} spellCheck={false} />
    </Field>
    <label className="admin-check"><input type="checkbox" name="active" disabled={row?.code === 'ru'} defaultChecked={row?.active ?? false} />{t('Включить в переключателе языков')}</label>
  </MutationForm>
}

function editorTitle(editor: Editor, t: Translator) {
  switch (editor.type) {
    case 'user': return t('Редактирование профиля')
    case 'listing': return t('Редактирование объявления')
    case 'listing-review': return t('Проверка объявления')
    case 'status': return t('Модерация')
    case 'category': return t(editor.row ? 'Редактирование категории' : 'Новая категория')
    case 'content': return t(editor.row ? 'Редактирование страницы' : 'Новая страница')
    case 'locale': return t(editor.row ? 'Редактирование языка' : 'Новый язык')
    case 'moderator': return t('Новый модератор')
  }
}

type EditorActions = { close: () => void; saved: (result?: unknown) => void }

function ListingReviewForm({ editor, close, saved }: { editor: Extract<Editor, { type: 'listing-review' }> } & EditorActions) {
  const { t } = useI18n()
  const [decision, setDecision] = useState('PUBLISH')
  return <MutationForm onClose={close} onSaved={saved} buttonLabel={t(decision === 'PUBLISH' ? 'Опубликовать' : 'Вернуть на доработку')}
    save={data => api('/admin/listings/' + editor.id + '/review', {
      method: 'POST', body: { decision, ...(decision === 'RETURN' && { reason: formText(data, 'reason') }) },
    })}>
    <p>{editor.name}</p>
    <Field label={t('Решение')}>
      <select value={decision} onChange={event => setDecision(event.target.value)}>
        <option value="PUBLISH">{t('Опубликовать')}</option><option value="RETURN">{t('Вернуть на доработку')}</option>
      </select>
    </Field>
    {decision === 'RETURN' && <Field label={t('Что исправить')}>
      <textarea name="reason" required minLength={5} maxLength={500} rows={3} />
    </Field>}
  </MutationForm>
}

function EditorFields({ editor, close, saved, administrator = false }: { editor: Editor; administrator?: boolean } & EditorActions) {
  const actions = { onClose: close, onSaved: saved }
  switch (editor.type) {
    case 'user': return <>
      {editor.row ? <UserForm row={editor.row} {...actions} /> : <UserEditor id={editor.id} close={close} saved={saved} />}
      {administrator && <TelegramUserControl userId={editor.id} />}
    </>
    case 'listing': return <ListingForm listingId={editor.id} admin onSaved={saved} />
    case 'listing-review': return <ListingReviewForm editor={editor} close={close} saved={saved} />
    case 'status': return editor.tab === 'reports' ? <ReportStatusForm editor={editor} close={close} saved={saved} /> : <StatusForm editor={editor} {...actions} />
    case 'category': return <CategoryForm {...editor} {...actions} />
    case 'content': return <ContentForm {...editor} {...actions} />
    case 'locale': return <LocaleForm {...editor} {...actions} />
    case 'moderator': return <ModeratorForm {...actions} />
  }
}

type ContextModerationTarget = { type: 'listing' | 'user'; id: string; title: string }

export function ListingModeration({ user, listing, owner, onSaved }: {
  user: User | null
  listing: { id: string; title: string }
  owner?: { id: string; title: string }
  onSaved: () => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState<ContextModerationTarget['type']>()
  const [saved, setSaved] = useState(false)
  const chooser = useRef<HTMLButtonElement>(null)
  const targetHeading = useRef<HTMLHeadingElement>(null)
  const selected = choice === 'listing' ? listing : choice === 'user' ? owner : undefined

  useEffect(() => {
    if (open) (choice ? targetHeading.current : chooser.current)?.focus()
  }, [open, choice])

  if (!isStaff(user) || !user?.emailVerified || user.mustChangePassword || user.status !== 'ACTIVE') return null

  const close = () => { setOpen(false); setChoice(undefined) }
  return <div className="context-moderation">
    <Button variant="secondary" aria-haspopup="dialog" onClick={() => { setSaved(false); setOpen(true) }}>
      {t('Действия модерации')}
    </Button>
    {saved && <span className="context-moderation-feedback" role="status">{t('Изменения сохранены.')}</span>}
    {open && <StaffDialog title={t('Действия модерации')} onClose={close}>
      {choice && selected ? <>
        <Button variant="ghost" onClick={() => setChoice(undefined)}>{t('К списку действий')}</Button>
        <h3 ref={targetHeading} tabIndex={-1} className="context-moderation-target">{selected.title}</h3>
        <ContextModerationFields key={choice + selected.id} target={{ ...selected, type: choice }}
          onStepChange={() => targetHeading.current?.focus()} close={close} saved={() => {
          close()
          setSaved(true)
          onSaved()
        }} />
      </> : <div className="admin-actions context-moderation-options">
        <button ref={chooser} type="button" className="button button-secondary" onClick={() => setChoice('listing')}>
          {t('Модерировать объявление')}
        </button>
        {owner && <Button variant="secondary" onClick={() => setChoice('user')}>{t('Модерировать профиль')}</Button>}
      </div>}
    </StaffDialog>}
  </div>
}

function ContextModerationFields({ target, close, saved, onStepChange }: {
  target: ContextModerationTarget; onStepChange: () => void
} & EditorActions) {
  const { t } = useI18n()
  const [operation, setOperation] = useState<'edit' | 'status' | 'reviews' | 'reports'>()
  const [retry, setRetry] = useState(0)
  const listing = useAdminData<ListingRow>(target.type === 'listing' ? '/admin/listings/' + target.id : null, retry)
  const profile = useAdminData<UserRow>(target.type === 'user' ? '/admin/users/' + target.id : null, retry)
  function chooseOperation(next: typeof operation) {
    setOperation(next)
    onStepChange()
  }

  if (listing.loading || profile.loading) return <Spinner />
  const error = listing.error ?? profile.error
  if (error) return <Notice tone="error">{error} <Button variant="ghost" onClick={() => setRetry(current => current + 1)}>{t('Повторить')}</Button></Notice>

  let available: { editor: Editor; status: string; name: string; tab: 'listings' | 'users' } | undefined
  if (listing.data) {
    available = { editor: { type: 'listing', id: target.id }, status: listing.data.status, name: listing.data.title, tab: 'listings' }
  }
  if (profile.data && isMarketProfile(profile.data)) {
    available = { editor: { type: 'user', id: target.id, row: profile.data }, status: profile.data.status, name: profile.data.displayName, tab: 'users' }
  }
  if (available) {
    if (operation === 'reviews' || operation === 'reports') {
      return <RelatedModeration tab={operation} subjectId={target.id} back={() => chooseOperation(undefined)} saved={saved} />
    }
    if (!operation) return <>
      <p className="muted">{available.name !== target.title && <>{available.name} · </>}{t('Текущий статус: {status}', { status: statusLabel(t, available.status) })}</p>
      <div className="admin-actions context-moderation-options">
        <Button variant="secondary" onClick={() => chooseOperation('edit')}>{t('Редактировать')}</Button>
        {available.status !== 'BANNED' && <Button variant="secondary" onClick={() => chooseOperation('status')}>{t('Изменить статус')}</Button>}
        {target.type === 'user' && <>
          <Button variant="secondary" onClick={() => chooseOperation('reviews')}>{t('Отзывы о профиле')}</Button>
          <Button variant="secondary" onClick={() => chooseOperation('reports')}>{t('Жалобы на профиль')}</Button>
        </>}
      </div>
    </>
    const editor: Editor = operation === 'status'
      ? { type: 'status', tab: available.tab, id: target.id, name: available.name, status: available.status }
      : available.editor
    return <EditorFields editor={editor} close={close} saved={saved} />
  }

  return <Notice>{t('Запись недоступна для редактирования.')}</Notice>
}

function RelatedModeration({ tab, subjectId, back, saved }: {
  tab: 'reviews' | 'reports'; subjectId: string; back: () => void; saved: EditorActions['saved']
}) {
  const { t } = useI18n()
  const [editor, setEditor] = useState<Editor>()
  if (editor) return <EditorFields editor={editor} close={() => setEditor(undefined)} saved={saved} />

  const props = { version: 0, edit: setEditor, subjectId }
  return <div className="context-related">
    <Button variant="ghost" onClick={back}>{t('К действиям профиля')}</Button>
    {tab === 'reviews' ? <Reviews {...props} /> : <Reports {...props} />}
  </div>
}

export function AdminPage({ user }: { user?: User | null }) {
  const { t, reloadLocales } = useI18n()
  const [params] = useSearchParams()
  const requestedTab = params.get('section')
  const availableTabs = (Object.keys(tabs) as Tab[]).filter(key => key !== 'moderators' || user?.role === 'ADMIN')
  const tab = availableTabs.find(key => key === requestedTab) ?? 'users'
  const [editor, setEditor] = useState<Editor>()
  const [version, setVersion] = useState(0)
  const [saved, setSaved] = useState(false)
  const edit = (next: Editor) => {
    setSaved(false)
    setEditor(next)
  }
  const close = () => setEditor(undefined)
  const refresh = () => {
    setEditor(current => current === editor ? undefined : current)
    if (editor?.type === 'locale') reloadLocales()
    setVersion(current => current + 1)
    setSaved(true)
  }
  const props = { version, edit }
  return <div className="container admin-page">
    <header className="admin-heading">
      <h1>{t('Администрирование')}</h1>
    </header>
    <div className="admin-layout">
      <nav className="panel admin-nav" aria-label={t('Разделы администрирования')}>
        {availableTabs.map(key => <Link
          key={key}
          to={'/admin?section=' + key}
          className={'button button-' + (key === tab ? 'secondary' : 'ghost')}
          aria-current={key === tab ? 'page' : undefined}
          onClick={() => { setSaved(false); close() }}
        >{t(tabs[key])}</Link>)}
      </nav>
      <section className="panel admin-panel" aria-label={t(tabs[tab])}>
        {saved && <Notice tone="success">{t('Изменения сохранены.')}</Notice>}
        {tab === 'users' && <Users {...props} administrator={user?.role === 'ADMIN'} />}
        {tab === 'listings' && <Listings {...props} />}
        {tab === 'reviews' && <Reviews {...props} />}
        {tab === 'reports' && <Reports {...props} />}
        {tab === 'moderators' && <Moderators {...props} />}
        {tab === 'exchange' && user && <Suspense fallback={<Spinner />}><ExchangeAdministration user={user} /></Suspense>}
        {tab === 'audit' && <Audit version={version} />}
        {(tab === 'categories' || tab === 'content' || tab === 'locales') && <ReferenceRecords tab={tab} {...props} administrator={user?.role === 'ADMIN'} />}
      </section>
    </div>
    {editor && <StaffDialog title={editorTitle(editor, t)} onClose={close}>
      <EditorFields editor={editor} close={close} saved={refresh} administrator={user?.role === 'ADMIN'} />
    </StaffDialog>}
  </div>
}

export default AdminPage
