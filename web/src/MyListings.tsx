import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ActualityBadges, ActualityDialog, ActualityEditForm, ActualityStartNotice, ActualitySuspension, actualityDate, useActuality,
  type ActualityAnswer, type ActualityListingFields,
} from './ActualityWidgets';
import { api, tradeSidesFor, type User } from './api';
import { useExchange } from './Exchange';
import { useI18n } from './i18n';
import { LotAppeal, MyLotRequests, OwnLotBadges } from './LotGroups';
import { TelegramHint } from './Telegram';
import type { Listing } from './market';
import { ListingPrice } from './ListingPrice';
import { Button, Notice, Spinner } from './ui';
import './workflows.css';

type OwnListing = Pick<Listing, 'id' | 'kind' | 'title' | 'status' | 'priceMode' | 'price' | 'currency' | 'deliveryBy' | 'quantity' |
  'priceUsd' | 'totalPrice' | 'requiresModel' | 'modelId' | 'hiddenByRatingBelow' | 'similarLot' | 'isDuplicate' |
  'duplicateAppealed' | 'reviewReasons' | 'reviewReturnNote'> & ActualityListingFields;

interface ListingPage {
  items: OwnListing[];
  total: number;
  page: number;
  limit: number;
}

const statuses: Record<string, string> = {
  ACTIVE: 'Активно', HIDDEN: 'Скрыто', FROZEN: 'Заморожено', BANNED: 'Заблокировано', ARCHIVED: 'В архиве',
  PENDING_OWNER: 'Ждёт вашего решения', PENDING_REVIEW: 'На проверке',
};
const hiddenLabels: Record<string, string> = {
  NO_ANSWER: 'Скрыто: нет ответа', MISSED3: 'Скрыто: три пропуска', PAUSE: 'Скрыто: пауза', SPOT_CHECK: 'Скрыто: до завершения проверки',
  DUPLICATE: 'Скрыто как дубль лота',
};
const publications = [
  ['current', 'Активные'], ['pending', 'На подтверждении'], ['archive', 'Архив'], ['restricted', 'Ограниченные'],
] as const;
const dayMs = 24 * 60 * 60 * 1000;

export function MyListingsPage({ user }: { user: User }) {
  const { t, locale } = useI18n();
  const { features } = useExchange();
  const navigate = useNavigate();
  const today = new Date().toISOString().slice(0, 10);
  const [query, setQuery] = useSearchParams();
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const { summary, error: summaryError } = useActuality(revision);
  const [data, setData] = useState<ListingPage>();
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState<string>();
  const [edit, setEdit] = useState<{ listing: OwnListing; action: 'CHANGED' | 'WITHDRAWN' }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestedTab = query.get('tab');
  const tab = publications.find(([value]) => value === requestedTab)?.[0] ?? 'current';
  const publication = summary?.enabled || tab === 'pending' ? '&publication=' + tab : '';
  const dual = tradeSidesFor(user).length === 2;
  const side = dual ? query.get('kind') === 'BUY' ? 'BUY' : 'SELL' : undefined;
  const url = `/listings/mine?page=${page}&limit=12${publication}${side ? '&kind=' + side : ''}`;
  const pendingCount = summary?.pending.length ?? 0;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<ListingPage>(url, { signal: controller.signal })
      .then(result => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch(cause => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить объявления.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [url, revision]);

  const refresh = () => setRevision(previous => previous + 1);

  async function changePublication(id: string, action: 'archive' | 'restore' | 'extend' | 'confirm') {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (action === 'archive') await api(`/listings/${id}`, { method: 'DELETE' });
      else if (action === 'confirm') await api(`/listings/${id}/actuality`, { method: 'POST', body: { answer: 'ACTUAL' } });
      else await api(`/listings/${id}/${action}`, { method: 'POST' });
      setConfirm(undefined);
      refresh();
      setNotice({
        archive: 'Объявление перенесено в архив.', restore: 'Объявление снова опубликовано.',
        extend: 'Срок показа продлён.', confirm: 'Актуальность подтверждена.',
      }[action]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось изменить объявление.');
    } finally { setBusy(false); }
  }

  async function confirmAll() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/me/actuality/confirm-all', { method: 'POST' });
      refresh();
      setNotice('Актуальность объявлений подтверждена.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось подтвердить объявления.'); }
    finally { setBusy(false); }
  }

  async function answer(id: string, input: ActualityAnswer) {
    const result = await api<{ dealId?: string }>(`/listings/${id}/actuality`, { method: 'POST', body: input });
    setEdit(undefined);
    if (result.dealId) {
      void navigate(`/deals/${result.dealId}?action=agree`);
      return;
    }
    refresh();
    setNotice(input.answer === 'WITHDRAWN' ? 'Объявление снято.' : 'Изменения сохранены, актуальность подтверждена.');
  }

  function selectTab(value: string) {
    setPage(1);
    setQuery(next => {
      if (value === 'current') next.delete('tab');
      else next.set('tab', value);
      return next;
    });
  }

  return (
    <div className="workflow-page container">
      <div className="workflow-page-heading">
        <h1>{t('Мои объявления')}</h1>
        <Link className="button button-primary" to="/listings/new">{t('Разместить объявление')}</Link>
      </div>
      <div className="workflow-stack">
        {dual && <nav className="workflow-actions" aria-label={t('Виды моих объявлений')}>
          {([['SELL', 'Предложения'], ['BUY', 'Заявки']] as const).map(([kind, label]) =>
            <Button key={kind} type="button" variant={side === kind ? 'primary' : 'secondary'} aria-pressed={side === kind}
              onClick={() => {
                setPage(1);
                setQuery(next => { next.set('kind', kind); return next; });
              }}>{t(label)}</Button>)}
        </nav>}
        <MyLotRequests />
        <ActualityStartNotice summary={summary} />
        <ActualitySuspension summary={summary} onChanged={refresh} />
        {!pendingCount && <TelegramHint enabled={features.feature_telegram === true} />}
        {summary?.enabled && pendingCount > 0 && summary.deadlineAt && <section className="actuality-banner" aria-label={t('Подтверждение актуальности')}>
          <div>
            <strong>{t('Ждут ответа «Актуально?»: {n}', { n: pendingCount })}</strong>
            <p>{t('Ответьте до {deadline} ({timezone}), иначе объявления скроются.', {
              deadline: actualityDate(summary.deadlineAt, locale, summary.timezone), timezone: summary.timezone,
            })}</p>
            <TelegramHint enabled={features.feature_telegram === true} />
          </div>
          <Button type="button" disabled={busy} onClick={() => void confirmAll()}>{t('Все актуальны')}</Button>
        </section>}
        {summary?.enabled && <nav className="workflow-actions" aria-label={t('Состояния моих объявлений')}>
          {publications.map(([value, label]) => <Button key={value} type="button"
            variant={tab === value ? 'primary' : 'secondary'} onClick={() => selectTab(value)} aria-current={tab === value ? 'page' : undefined}>
            {t(label)}
          </Button>)}
        </nav>}
        {notice && <Notice tone="success">{t(notice)}</Notice>}
        {(error || summaryError) && <Notice tone="error">{t(error || summaryError)}</Notice>}
        {loading ? <Spinner /> : data && (
          <>
            {data.items.length === 0 && <Notice>{t(summary?.enabled ? 'В этом разделе пока нет объявлений.' : 'У вас пока нет объявлений.')}</Notice>}
            <ul className="workflow-stack workflow-own-list">
              {data.items.map(listing => {
                const isLive = listing.status === 'ACTIVE';
                const isHidden = listing.status === 'HIDDEN';
                const isArchived = listing.status === 'ARCHIVED';
                const waiting = listing.status === 'PENDING_OWNER' || listing.status === 'PENDING_REVIEW';
                const isExpired = isLive && listing.deliveryBy !== null && listing.deliveryBy < today;
                const status = isArchived && listing.spotCheckHold ? 'В архиве до завершения проверки'
                  : isExpired ? 'Срок истёк, объявление скрыто из каталога'
                  : hiddenLabels[listing.hiddenReason ?? ''] ?? statuses[listing.status] ?? listing.status;
                const hiddenDays = listing.hiddenAt ? Math.max(0, 7 - Math.floor((Date.now() - new Date(listing.hiddenAt).getTime()) / dayMs)) : 0;
                const restoreHidden = isHidden && !listing.isDuplicate && !summary?.suspended && !summary?.pause && (
                  (listing.hiddenReason === 'NO_ANSWER' && hiddenDays > 0) || listing.hiddenReason === 'PAUSE'
                );
                return (
                  <li className="panel workflow-section workflow-own-item" key={listing.id}>
                    <div className="workflow-stack">
                      <div>
                        <h2>{listing.title}</h2>
                        <p className="workflow-muted-line">
                          {t(listing.kind === 'SELL' ? 'Продажа' : 'Покупка')} · {t(status)}
                        </p>
                        <ListingPrice listing={listing} />
                        {listing.reviewReasons?.length ? <p className="workflow-muted-line">
                          {listing.reviewReasons.map(reason => t(reason === 'PRICE_OUTSIDE' ?
                            'Цена вне рыночного коридора' : 'Найдено похожее предложение')).join(' · ')}
                        </p> : null}
                        {listing.reviewReturnNote && <p className="workflow-muted-line">{listing.reviewReturnNote}</p>}
                        {listing.requiresModel && !listing.modelId && <p className="workflow-muted-line">
                          {t('Укажите модель, чтобы площадка искала совпадения.')}
                        </p>}
                        {listing.hiddenByRatingBelow != null && <p className="workflow-muted-line">
                          {t('Объявление скрыто в обычной выдаче из-за рейтинга ниже {threshold}.', { threshold: listing.hiddenByRatingBelow })}
                        </p>}
                        {listing.expiresAt && (isLive || isHidden) && <p className="workflow-muted-line">{t('Показ до {date}, осталось {days} дн.', {
                          date: actualityDate(listing.expiresAt, locale, summary?.timezone),
                          days: Math.max(0, Math.ceil((new Date(listing.expiresAt).getTime() - Date.now()) / dayMs)),
                        })}</p>}
                        {restoreHidden && listing.hiddenReason === 'NO_ANSWER' && <p className="workflow-muted-line">
                          {t('Вернуть можно ещё {n} дн.', { n: hiddenDays })}
                        </p>}
                      </div>
                      <ActualityBadges listing={listing} />
                      <OwnLotBadges listing={listing} />
                    </div>
                    <div className="workflow-actions">
                      <LotAppeal listing={listing} onSaved={refresh} />
                      {(isLive || isArchived || isHidden || waiting) && <Link className="button button-ghost" to={`/listings/${listing.id}`}>{t('Открыть')}</Link>}
                      {(isLive || isArchived || waiting) && <Link className="button button-secondary" to={`/listings/${listing.id}/edit`}>{t('Редактировать')}</Link>}
                      {summary?.enabled && isLive && <>{(listing.askedAt || !listing.freshness?.today) && <Button type="button" variant="secondary" disabled={busy}
                        onClick={() => void changePublication(listing.id, 'confirm')}>{t(listing.askedAt ? 'Актуально' : 'Подтвердить сегодня')}</Button>}
                        {listing.askedAt && <Button type="button" variant="secondary" disabled={busy}
                          onClick={() => setEdit({ listing, action: 'CHANGED' })}>{t('Изменилась цена или количество')}</Button>}
                        <Button type="button" variant="ghost" disabled={busy}
                          onClick={() => setEdit({ listing, action: 'WITHDRAWN' })}>{t('Снято')}</Button>
                      </>}
                      {summary?.enabled && (isLive || isHidden) && <Button type="button" variant="ghost" disabled={busy}
                        onClick={() => void changePublication(listing.id, 'extend')}>{t('Продлить на {n} дн.', { n: listing.kind === 'BUY' ? 21 : 14 })}</Button>}
                      {restoreHidden && <Button type="button" variant="secondary" disabled={busy}
                        onClick={() => void changePublication(listing.id, 'restore')}>{t('Вернуть')}</Button>}
                      {(isLive || isHidden) && <Button type="button" variant="ghost" disabled={busy}
                        onClick={() => { setConfirm(listing.id); setNotice(''); setError(''); }}>{t('В архив')}</Button>}
                      {isArchived && !listing.spotCheckHold && !listing.isDuplicate && <Button type="button" variant="secondary" disabled={busy}
                        onClick={() => void changePublication(listing.id, 'restore')}>{t('Опубликовать снова')}</Button>}
                    </div>
                    {confirm === listing.id && (
                      <div className="workflow-span workflow-confirmation">
                        <p>{t('Перенести объявление в архив? Оно исчезнет из результатов поиска.')}</p>
                        <div className="workflow-actions">
                          <Button type="button" variant="danger" disabled={busy} onClick={() => void changePublication(listing.id, 'archive')}>{t('Перенести в архив')}</Button>
                          <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirm(undefined)}>{t('Отмена')}</Button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {data.total > data.limit && (
              <nav className="workflow-actions" aria-label={t('Страницы моих объявлений')}>
                <Button type="button" variant="secondary" disabled={page <= 1 || busy} onClick={() => setPage(page - 1)}>{t('Назад')}</Button>
                <span>{t('Страница {page}', { page })}</span>
                <Button type="button" variant="secondary" disabled={page * data.limit >= data.total || busy} onClick={() => setPage(page + 1)}>{t('Далее')}</Button>
              </nav>
            )}
          </>
        )}
        {edit && <ActualityDialog title={t(edit.action === 'CHANGED' ? 'Изменилась цена или количество' : 'Снять объявление')} onClose={() => setEdit(undefined)}>
          <ActualityEditForm action={edit.action} listing={edit.listing} onClose={() => setEdit(undefined)}
            onSubmit={input => answer(edit.listing.id, input)} />
        </ActualityDialog>}
      </div>
    </div>
  );
}
