import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from './api'
import { useI18n } from './i18n'
import { ListingForm } from './ListingForm'
import type { StaffListingOwner } from './StaffListingFields'
import { countryName, formatMoney } from './market'
import { Button, Notice, Spinner } from './ui'

export function StaffListingPage() {
  const { userId } = useParams()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [owner, setOwner] = useState<StaffListingOwner>()
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void api<StaffListingOwner>(`/admin/users/${userId}/listing-options`, { signal: controller.signal }).then(setOwner).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить участника.')
    })
    return () => controller.abort()
  }, [userId])
  return <div className="container workflow-page workflow-stack">
    <Link to="/admin?section=users">{t('К списку участников')}</Link>
    <h1>{t('Завести объявление за участника')}</h1>
    {error ? <Notice tone="error">{t(error)}</Notice> : owner?.id === userId && owner ? <>
      <p>{t('Владелец: {name}. Он получит черновик и решит, публиковать ли объявление.', { name: owner.nickname })}</p>
      <ListingForm staffOwner={owner} homeCountry={owner.country} onSaved={listing => navigate(`/listings/${listing.id}`)} />
    </> : <Spinner />}
  </div>
}

export type ListingOwnerFields = {
  listingId?: string; title?: string; quantity?: number; price?: number | null; currency?: string
  country?: string | null; rejectHref?: string
}

export function ListingOwnerAction({ purpose, fields, onSubmit, pending }: {
  purpose: string; fields?: ListingOwnerFields; pending: boolean; onSubmit: () => void
}) {
  const { t, locale } = useI18n()
  if (!fields?.listingId) return null
  return <div className="workflow-stack">
    <dl className="workflow-stack">
      <div><dt>{t('Объявление')}</dt><dd>{fields.title}</dd></div>
      <div><dt>{t('Количество')}</dt><dd>{fields.quantity} {t('шт.')}</dd></div>
      <div><dt>{t('Цена за шт.')}</dt><dd>{fields.price != null && fields.currency ?
        formatMoney(fields.price, fields.currency, locale) : t('По договорённости')}</dd></div>
      <div><dt>{t('Страна')}</dt><dd>{fields.country ? countryName(fields.country, locale) : t('По договорённости')}</dd></div>
    </dl>
    {purpose === 'listing.owner-confirm' ? <div className="admin-actions">
      <Button disabled={pending} onClick={onSubmit}>{t('Подтверждаю, публиковать')}</Button>
      <Link className="button button-secondary" to={`/listings/${fields.listingId}/edit`}>{t('Исправить')}</Link>
      {fields.rejectHref && <Link className="button button-ghost" to={fields.rejectHref}>{t('Отказаться')}</Link>}
    </div> : <Button variant="danger" disabled={pending} onClick={onSubmit}>{t('Отказаться от объявления')}</Button>}
  </div>
}
