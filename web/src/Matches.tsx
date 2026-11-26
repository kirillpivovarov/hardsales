import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import paymentForms from '../../server/seeds/exchange_data/payment_forms.json';
import { api } from './api';
import { useI18n } from './i18n';
import { countryName, formatMoney, terms } from './market';
import { NearMisses } from './NearMisses';
import { PaymentRisk, TrustBadges, type ListingTrust } from './Trust';
import { Button, Field, Notice, Spinner } from './ui';
import './matches.css';

const statuses = {
  NEW: 'Новые', CHAT: 'В переписке', DECLINED: 'Отклонённые', VOID: 'Неактуальные',
} as const;
const declineReasons = [
  'Цена не подходит', 'Количество не подходит', 'Срок не подходит', 'Форма оплаты не подходит',
  'Локация не подходит', 'Уже нашли', 'Другое',
];
type Status = keyof typeof statuses;
type Summary = { id: string; kind: 'SELL' | 'BUY'; title: string };
type MatchListing = Summary & {
  quantity: number; minLot: number; condition: string; originCountry: string | null;
  originScope: string | null; destinationCountry: string | null; stockCity: string | null;
  shipDays: number | null; deliveryBy: string | null; price: number | null; currency: string;
  unitPrice: number | null; unitPriceUsd: number | null; paymentMethods: string[]; paymentTerms: string[];
  labels: { id: string; text: string; tone: string }[];
};
type MatchSummary = {
  id: string; number: number; status: Status; type: 'FULL' | 'PARTIAL'; createdAt: string;
  model: { nameRu: string; nameEn: string; viaAnalog: boolean; byTitle: boolean } | null;
  mismatches: { key: string; text: string }[];
  declineReason: string | null; voidReason: string | null; chatId: string | null;
  source: 'SYSTEM' | 'OPERATOR'; operatorComment: string | null; operatorConditionsChanged: boolean;
};
type Match = MatchSummary & {
  side: 'SELL' | 'BUY'; mine: Summary;
  counterpart: {
    listing: MatchListing;
    owner: { nickname: string; accountType: string; country: string; city: string | null; rating: number | null; ratingCount: number };
    trust: ListingTrust | null;
  };
  gap: { rows: { id: string; tool: string; partner: string }[] } | null;
};
type AdminSide = {
  listing: { id: string; title: string };
  owner: { nickname: string; companyName: string | null; email: string; telegram: string | null };
};
type AdminMatch = MatchSummary & { seller: AdminSide; buyer: AdminSide; proposedBy: { nickname: string } | null };
type Page<Item> = { items: Item[]; total: number; page: number; limit: number };
type FxRate = { currency: string; usdPerUnit: string | null; updatedAt: string };

const paymentLabels = Object.fromEntries(paymentForms.payment_terms.map(item => [item.code, item.label_ru]));
const partnerLabels = Object.fromEntries(paymentForms.partner_kinds.map(item => [item.code, item.label_ru]));
const requestError = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;

function MatchCard({ match, busy, onChat, onDecline }: {
  match: Match; busy: boolean; onChat: () => void; onDecline: () => void;
}) {
  const { t, locale } = useI18n();
  const { listing, owner, trust } = match.counterpart;
  const modelName = match.model && ((locale.startsWith('ru') ? match.model.nameRu : match.model.nameEn) || match.model.nameRu);
  const payment = listing.paymentTerms.length ? listing.paymentTerms.map(term => t(paymentLabels[term] ?? term))
    : listing.paymentMethods.map(method => t(terms[method] ?? method));
  const origin = listing.originScope === 'ANY' ? t('Любая страна')
    : [listing.stockCity, listing.originCountry && countryName(listing.originCountry, locale)].filter(Boolean).join(', ');
  const date = listing.deliveryBy && new Date(listing.deliveryBy + 'T00:00:00Z');
  return <article className="panel match-card">
    <header className="match-card-header">
      <span className={match.type === 'FULL' ? 'match-badge match-full' : 'match-badge match-partial'}>
        {t(match.type === 'FULL' ? 'Полное совпадение' : 'Частичное совпадение')}
      </span>
      {match.source === 'OPERATOR' && <span className="match-badge">{t('Предложено модератором')}</span>}
      <span className="muted">№ {match.number}</span>
    </header>
    <div className="match-card-listings">
      <div>
        <span className="muted">{t('Моё объявление')}</span>
        <p><Link to={'/listings/' + match.mine.id}>{match.mine.title}</Link></p>
      </div>
      <div>
        <span className="muted">{t(listing.kind === 'SELL' ? 'Предложение' : 'Заявка')}</span>
        <h2>{match.status === 'VOID' ? listing.title : <Link to={'/listings/' + listing.id}>{listing.title}</Link>}</h2>
        {modelName && <p>{modelName}{match.model?.viaAnalog && <span className="match-badge">{t('По аналогу')}</span>}
          {match.model?.byTitle && <span className="match-badge">{t('По названию')}</span>}</p>}
      </div>
    </div>
    <dl className="match-specs">
      <div><dt>{t('Количество')}</dt><dd>{t('{count} шт. (партия от {min})', { count: listing.quantity, min: listing.minLot })}</dd></div>
      <div><dt>{t('Состояние')}</dt><dd>{t(terms[listing.condition] ?? listing.condition)}</dd></div>
      {origin && <div><dt>{t('Отгрузка')}</dt><dd>{origin}</dd></div>}
      {listing.destinationCountry && <div><dt>{t('Страна доставки')}</dt><dd>{countryName(listing.destinationCountry, locale)}</dd></div>}
      {listing.shipDays !== null && <div><dt>{t('Срок отгрузки')}</dt><dd>{t('{count} раб. дн. после оплаты', { count: listing.shipDays })}</dd></div>}
      {date && <div><dt>{t('Доставка до')}</dt><dd>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(date)}</dd></div>}
      <div><dt>{t('Стоимость')}</dt><dd>{listing.price === null || listing.unitPrice === null ? t('По договорённости')
        : <>{formatMoney(listing.unitPrice, listing.currency, locale)} {t('за шт.')} · {formatMoney(listing.price, listing.currency, locale)} {t('за всё')}</>}</dd></div>
      <div><dt>{t('Оплата')}</dt><dd>{payment.join(', ') || '—'}</dd></div>
    </dl>
    <div className="match-owner">
      <strong>{owner.nickname}</strong><span>{t(terms[owner.accountType] ?? owner.accountType)}</span>
      <span>{owner.rating === null ? t('Нет отзывов') : t('★ {rating} ({count})', { rating: new Intl.NumberFormat(locale).format(owner.rating), count: owner.ratingCount })}</span>
      {listing.labels.map(label => <span className="match-badge" key={label.id}>{t(label.text)}</span>)}
    </div>
    <TrustBadges listing={{ trust }} />
    {match.side === 'BUY' && <PaymentRisk listing={{ kind: listing.kind, paymentTerms: listing.paymentTerms, trust }} />}
    {match.mismatches.length > 0 && <div className="match-explanation">
      <h3>{t('Различия в условиях')}</h3>
      <ul>{match.mismatches.map(item => <li key={item.key}>{t(item.text)}</li>)}</ul>
    </div>}
    {match.gap && <div className="match-explanation">
      <h3>{t('Варианты согласования оплаты')}</h3>
      <ul>{match.gap.rows.map(row => <li key={row.id}>{t(row.tool)} · {t(partnerLabels[row.partner] ?? row.partner)}</li>)}</ul>
    </div>}
    {match.operatorComment && <div className="match-explanation">
      <h3>{t('Комментарий модератора')}</h3><p>{match.operatorComment}</p>
      {match.operatorConditionsChanged && <small>{t('Условия могли измениться после предложения модератора')}</small>}
    </div>}
    {(match.voidReason || match.declineReason) && <Notice>{t(match.voidReason ?? match.declineReason!)}</Notice>}
    {(match.status === 'NEW' || match.status === 'CHAT') && <div className="match-actions">
      <Button disabled={busy} onClick={onChat}>{t(match.status === 'CHAT' ? 'Открыть чат' : 'Написать')}</Button>
      {match.status === 'NEW' && <Button variant="secondary" aria-haspopup="dialog" disabled={busy} onClick={onDecline}>{t('Не подходит')}</Button>}
    </div>}
  </article>;
}

function DeclineDialog({ busy, error, onClose, onSubmit }: {
  busy: boolean; error: string; onClose: () => void; onSubmit: (reason: string) => void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    return () => node.close();
  }, []);
  return <dialog ref={dialog} className="panel match-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id={titleId}>{t('Отклонить совпадение')}</h2>
    <form onSubmit={event => {
      event.preventDefault();
      onSubmit(String(new FormData(event.currentTarget).get('reason')));
    }}>
      <Field label={t('Причина')}>
        <select name="reason" required defaultValue="" disabled={busy} autoFocus>
          <option value="" disabled>{t('Выберите причину')}</option>
          {declineReasons.map(reason => <option key={reason} value={reason}>{t(reason)}</option>)}
        </select>
      </Field>
      {error && <Notice tone="error">{t(error)}</Notice>}
      <div className="match-actions">
        <Button variant="secondary" disabled={busy} onClick={onClose}>{t('Отмена')}</Button>
        <Button type="submit" disabled={busy}>{t('Отклонить')}</Button>
      </div>
    </form>
  </dialog>;
}

export function MatchesPage({ onChanged }: { onChanged?: () => void } = {}) {
  const { t } = useI18n();
  const { id } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const inputStatus = params.get('status') ?? 'NEW';
  const status = Object.hasOwn(statuses, inputStatus) ? inputStatus as Status : 'NEW';
  const listingId = params.get('listingId');
  const page = Math.min(10_000, Math.max(1, Math.floor(Number(params.get('page')) || 1)));
  const [data, setData] = useState<Page<Match>>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState<string>();
  const [declining, setDeclining] = useState<string>();
  const [error, setError] = useState('');
  const [dialogError, setDialogError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const query = new URLSearchParams({ status, page: String(page) });
    if (listingId) query.set('listingId', listingId);
    const load = id ? api<Match>('/matches/' + encodeURIComponent(id), { signal: controller.signal })
      .then(match => ({ items: [match], total: 1, page: 1, limit: 1 }))
      : api<Page<Match>>('/matches?' + query, { signal: controller.signal });
    void load.then(setData).catch(cause => {
      if (!controller.signal.aborted) {
        setData(undefined);
        setError(requestError(cause, 'Не удалось загрузить совпадения.'));
      }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, listingId, page, revision, status]);

  function setFilter(newStatus: Status, nextPage = 1) {
    const query = new URLSearchParams({ status: newStatus });
    if (nextPage > 1) query.set('page', String(nextPage));
    if (listingId) query.set('listingId', listingId);
    setParams(query);
  }

  async function chat(match: Match) {
    setBusy(match.id);
    setError('');
    try {
      const { chatId } = await api<{ chatId: string }>('/matches/' + match.id + '/chat', { method: 'POST' });
      onChanged?.();
      navigate('/chats/' + chatId);
    } catch (cause) {
      setError(requestError(cause, 'Не удалось открыть чат.'));
    } finally { setBusy(undefined); }
  }

  async function decline(reason: string) {
    setBusy(declining);
    setDialogError('');
    try {
      await api('/matches/' + declining + '/decline', { method: 'POST', body: { reason } });
      setDeclining(undefined);
      if (!id && data?.items.length === 1 && page > 1) setFilter(status, page - 1);
      setRevision(value => value + 1);
      onChanged?.();
    } catch (cause) {
      setDialogError(requestError(cause, 'Не удалось отклонить совпадение.'));
    } finally { setBusy(undefined); }
  }

  return <div className="workflow-page container">
    <div className="workflow-page-heading">
      <h1>{t(id ? 'Совпадение' : 'Совпадения')}</h1>
      {(id || listingId) && <Link className="button button-secondary" to="/matches">{t('Все совпадения')}</Link>}
    </div>
    {!id && <nav aria-label={t('Статусы совпадений')} className="match-filters">
      {Object.entries(statuses).map(([value, label]) =>
        <Button key={value} variant={status === value ? 'primary' : 'secondary'} aria-pressed={status === value}
          onClick={() => setFilter(value as Status)}>{t(label)}</Button>)}
    </nav>}
    {error && <Notice tone="error">{t(error)}</Notice>}
    {loading ? <Spinner /> : data && <div className="match-results">
      {data.items.length === 0 && <div className="panel match-card"><p>{t('В этом разделе пока нет совпадений.')}</p></div>}
      {data.items.map(match => <MatchCard key={match.id} match={match} busy={busy === match.id}
        onChat={() => void chat(match)} onDecline={() => { setDialogError(''); setDeclining(match.id); }} />)}
      {!id && <MatchPagination data={data} onPage={value => setFilter(status, value)} />}
    </div>}
    {declining && <DeclineDialog busy={busy === declining} error={dialogError} onClose={() => setDeclining(undefined)}
      onSubmit={reason => void decline(reason)} />}
  </div>;
}

function MatchPagination({ data, onPage }: { data: Page<unknown>; onPage: (value: number) => void }) {
  const { t } = useI18n();
  if (data.page === 1 && data.total <= data.limit) return null;
  return <nav className="match-pagination" aria-label={t('Страницы совпадений')}>
    <Button variant="secondary" disabled={data.page === 1} onClick={() => onPage(data.page - 1)}>{t('Назад')}</Button>
    <span>{t('Страница {page}', { page: data.page })}</span>
    <Button variant="secondary" disabled={data.page * data.limit >= data.total} onClick={() => onPage(data.page + 1)}>{t('Далее')}</Button>
  </nav>;
}

export function MatchAdminPanel() {
  const { t } = useI18n();
  const [near, setNear] = useState(false);
  return <div className="match-results">
    <nav aria-label={t('Разделы совпадений')} className="match-filters">
      <Button aria-pressed={!near} variant={!near ? 'primary' : 'secondary'} onClick={() => setNear(false)}>{t('Все совпадения')}</Button>
      <Button aria-pressed={near} variant={near ? 'primary' : 'secondary'} onClick={() => setNear(true)}>{t('Почти совпадения')}</Button>
    </nav>
    {near ? <NearMisses /> : <AdminMatchList />}
  </div>;
}

function AdminMatchList() {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [q, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page<AdminMatch>>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const query = new URLSearchParams({ page: String(page) });
    if (status) query.set('status', status);
    if (source) query.set('source', source);
    if (q) query.set('q', q);
    void api<Page<AdminMatch>>('/admin/matches?' + query, { signal: controller.signal }).then(setData).catch(cause => {
      if (!controller.signal.aborted) setError(requestError(cause, 'Не удалось загрузить совпадения.'));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, q, source, status]);

  return <section className="match-results" aria-label={t('Совпадения')}>
    <form className="panel match-card match-admin-filters" onSubmit={event => {
      event.preventDefault();
      setPage(1);
      setQuery(search.trim());
    }}>
      <Field label={t('Поиск совпадений')}>
        <input type="search" value={search} maxLength={200} placeholder={t('Номер, объявление или ник')}
          onChange={event => setSearch(event.target.value)} />
      </Field>
      <Field label={t('Статус')}>
        <select value={status} onChange={event => { setPage(1); setStatus(event.target.value); }}>
          <option value="">{t('Все статусы')}</option>
          {Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select>
      </Field>
      <Field label={t('Источник совпадения')}>
        <select value={source} onChange={event => { setPage(1); setSource(event.target.value); }}>
          <option value="">{t('Все источники')}</option>
          <option value="SYSTEM">{t('Автоматически')}</option>
          <option value="OPERATOR">{t('Вручную')}</option>
        </select>
      </Field>
      <Button type="submit">{t('Найти')}</Button>
    </form>
    {error && <Notice tone="error">{t(error)}</Notice>}
    {loading ? <Spinner /> : !error && data && <>
      {data.items.length === 0 && <p>{t('Совпадения не найдены.')}</p>}
      {data.items.map(match => <article key={match.id} className="panel match-card">
        <header className="match-card-header">
          <strong>№ {match.number} · {t(match.type === 'FULL' ? 'Полное совпадение' : 'Частичное совпадение')}</strong>
          {match.source === 'OPERATOR' && <span className="match-badge">{t('Вручную')}{match.proposedBy && ` · ${match.proposedBy.nickname}`}</span>}
          <span>{t(statuses[match.status])}</span>
        </header>
        <div className="match-card-listings">
          {[match.seller, match.buyer].map((side, index) => <div key={side.listing.id}>
            <span className="muted">{t(index === 0 ? 'Предложение' : 'Заявка')}</span>
            <h3><Link to={'/listings/' + side.listing.id}>{side.listing.title}</Link></h3>
            <p>{[side.owner.nickname, side.owner.companyName, side.owner.email, side.owner.telegram && '@' + side.owner.telegram].filter(Boolean).join(' · ')}</p>
          </div>)}
        </div>
        {match.mismatches.length > 0 && <ul>{match.mismatches.map(item => <li key={item.key}>{t(item.text)}</li>)}</ul>}
        {match.operatorComment && <p><strong>{t('Комментарий модератора')}</strong> · {match.operatorComment}</p>}
        {(match.declineReason || match.voidReason) && <p>{t(match.declineReason ?? match.voidReason!)}</p>}
      </article>)}
      <MatchPagination data={data} onPage={setPage} />
    </>}
  </section>;
}

function FxRateForm({ rate, onSaved }: { rate: FxRate; onSaved: (rate: FxRate) => void }) {
  const { t, locale } = useI18n();
  const [draft, setDraft] = useState(rate.usdPerUnit?.replace(/\.?0+$/, '') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      onSaved(await api<FxRate>('/admin/fx-rates/' + rate.currency, {
        method: 'PUT', body: { usdPerUnit: draft.trim().replace(',', '.') || null },
      }));
      setSaved(true);
    } catch (cause) {
      setError(requestError(cause, 'Не удалось сохранить курс.'));
    } finally { setBusy(false); }
  }
  return <form className="match-rate-row" onSubmit={event => void submit(event)}>
    <Field label={t('USD за 1 {currency}', { currency: rate.currency })}>
      <input inputMode="decimal" value={draft} maxLength={19} placeholder={t('Не задан')}
        onChange={event => { setDraft(event.target.value); setSaved(false); }} />
    </Field>
    <small className="muted">{new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(rate.updatedAt))}</small>
    <Button type="submit" variant="secondary" disabled={busy}>{t('Сохранить')}</Button>
    {error && <Notice tone="error">{t(error)}</Notice>}
    {saved && <Notice tone="success">{t('Курс сохранён.')}</Notice>}
  </form>;
}

export function FxRatesPanel() {
  const { t } = useI18n();
  const [rates, setRates] = useState<FxRate[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api<FxRate[]>('/admin/fx-rates', { signal: controller.signal }).then(setRates).catch(cause => {
      if (!controller.signal.aborted) setError(requestError(cause, 'Не удалось загрузить курсы.'));
    });
    return () => controller.abort();
  }, []);
  return <section className="panel match-card">
    <h2>{t('Курсы валют')}</h2>
    <p>{t('Проверьте значения перед включением совпадений. Пустое поле отключает сравнение цен в валюте.')}</p>
    {error ? <Notice tone="error">{t(error)}</Notice> : !rates ? <Spinner /> : rates.map(rate =>
      <FxRateForm key={rate.currency} rate={rate} onSaved={updated => setRates(previous =>
        previous?.map(row => row.currency === updated.currency ? updated : row))} />)}
  </section>;
}

export default MatchesPage;
