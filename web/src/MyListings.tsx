import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api';
import { useI18n } from './i18n';
import { formatMoney, type Listing } from './market';
import { Button, Notice, Spinner } from './ui';
import './workflows.css';

type OwnListing = Pick<Listing, 'id' | 'kind' | 'title' | 'status' | 'priceMode' | 'price' | 'currency' | 'deliveryBy'>;

interface ListingPage {
  items: OwnListing[];
  total: number;
  page: number;
  limit: number;
}

const statuses: Record<string, string> = {
  ACTIVE: 'Активно',
  FROZEN: 'Заморожено',
  BANNED: 'Заблокировано',
  ARCHIVED: 'В архиве',
};

export function MyListingsPage() {
  const { t, locale } = useI18n();
  const today = new Date().toISOString().slice(0, 10);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<ListingPage>();
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<ListingPage>(`/listings/mine?page=${page}&limit=12`, { signal: controller.signal })
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
  }, [page, revision]);

  async function changePublication(id: string, action: 'archive' | 'restore') {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (action === 'archive') await api(`/listings/${id}`, { method: 'DELETE' });
      else await api(`/listings/${id}/restore`, { method: 'POST' });
      setConfirm(undefined);
      setRevision(previous => previous + 1);
      setNotice(action === 'archive' ? 'Объявление перенесено в архив.' : 'Объявление снова опубликовано.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось изменить статус объявления.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workflow-page container">
      <div className="workflow-page-heading">
        <h1>{t('Мои объявления')}</h1>
        <Link className="button button-primary" to="/listings/new">{t('Разместить объявление')}</Link>
      </div>
      <div className="workflow-stack">
        {notice && <Notice tone="success">{t(notice)}</Notice>}
        {error && <Notice tone="error">{t(error)}</Notice>}
        {loading ? <Spinner /> : data && (
          <>
            {data.items.length === 0 && <Notice>{t('У вас пока нет объявлений.')}</Notice>}
            <ul className="workflow-stack workflow-own-list">
              {data.items.map(listing => {
                const isLive = listing.status === 'ACTIVE';
                const isArchived = listing.status === 'ARCHIVED';
                const isExpired = isLive && listing.deliveryBy !== null && listing.deliveryBy < today;
                const price = listing.price == null ? '' : formatMoney(listing.price, listing.currency, locale);
                const amount = listing.priceMode === 'FIXED' && listing.price != null
                  ? listing.kind === 'BUY' ? t('До {price}', { price }) : price
                  : t('По договорённости');
                return (
                  <li className="panel workflow-section workflow-own-item" key={listing.id}>
                    <div>
                      <h2>{listing.title}</h2>
                      <p className="workflow-muted-line">
                        {t(listing.kind === 'SELL' ? 'Продажа' : 'Покупка')} · {amount} · {t(isExpired ? 'Срок истёк, объявление скрыто из каталога' : statuses[listing.status] ?? listing.status)}
                      </p>
                    </div>
                    <div className="workflow-actions">
                      {(isLive || isArchived) && <>
                        <Link className="button button-ghost" to={`/listings/${listing.id}`}>{t('Открыть')}</Link>
                        <Link className="button button-secondary" to={`/listings/${listing.id}/edit`}>{t('Редактировать')}</Link>
                      </>}
                      {isLive && <Button type="button" variant="ghost" disabled={busy} onClick={() => { setConfirm(listing.id); setNotice(''); setError(''); }}>{t('В архив')}</Button>}
                      {isArchived && <Button type="button" variant="secondary" disabled={busy} onClick={() => void changePublication(listing.id, 'restore')}>{t('Опубликовать снова')}</Button>}
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
      </div>
    </div>
  );
}
