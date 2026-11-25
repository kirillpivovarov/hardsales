import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from './api';
import { useI18n } from './i18n';
import { countryName, formatMoney, terms } from './market';
import { Button, Field, Notice, Spinner } from './ui';
import './exchange-detail.css';

type Party = { nickname: string; companyName: string | null; participantType?: string; country: string; telegram?: string | null };
type Snapshot = {
  id: string; title: string; kind: 'BUY' | 'SELL'; description?: string; quantity?: number; currency?: string;
  price?: number | null; availability?: string; condition?: string; deliveryBy?: string; originCountry?: string;
  destinationCountry?: string; paymentMethods?: string[]; deliveryIncluded?: boolean; customsIncluded?: boolean;
};
type RecordSummary = {
  id: string; number: string; kind: 'FIRST' | 'REPEAT'; acceptedAt: string; chatId: string; listing: Snapshot;
  partner?: Party; partyA?: Party; partyB?: Party; canMarkKnown?: boolean; alreadyKnown?: { mine: boolean; partner: boolean };
  migrated?: boolean;
};
type RecordDetail = RecordSummary & {
  timezone: string; rulesVersion: string | null; requestedAt: string | null; counterListing: Snapshot | null;
  events: Array<{ type: string; by?: string; at: string; data?: { text?: string } }>;
};
type Page = { items: RecordSummary[]; page: number; limit: number; total: number; timezone: string };

function useRecord<T>(path: string, revision: number) {
  const [state, setState] = useState<{ path: string; data?: T; error?: string }>();
  useEffect(() => {
    const abort = new AbortController();
    void api<T>(path, { signal: abort.signal }).then(data => {
      if (!abort.signal.aborted) setState({ path, data });
    }).catch((error: Error) => {
      if (!abort.signal.aborted) setState({ path, error: error.message });
    });
    return () => abort.abort();
  }, [path, revision]);
  return state?.path === path ? state : undefined;
}

function localDate(date: string, locale: string, timezone: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(date));
}

function SummaryRows({ records, admin, onSelect, reload }: { records: Page; admin?: boolean; onSelect?: (id: string) => void; reload: () => void }) {
  const { t, locale } = useI18n();
  if (!records.items.length) return <Notice>{t('Записей раскрытия пока нет.')}</Notice>;
  return <ul className="exchange-records">
    {records.items.map(record => <li key={record.id} className="panel exchange-record">
      <strong>{record.number}</strong>
      <span className="muted">{localDate(record.acceptedAt, locale, records.timezone)} · {t(record.kind === 'FIRST' ? 'Первое раскрытие' : 'Повторное раскрытие')}</span>
      <span>{record.listing.title}</span>
      {record.partner && <span>{record.partner.nickname} · {record.partner.companyName ?? t('Компания не указана')}</span>}
      {admin && <span>{[record.partyA?.nickname, record.partyB?.nickname].filter(Boolean).join(' / ')}</span>}
      <div className="exchange-actions">
        {onSelect ? <Button variant="secondary" onClick={() => onSelect(record.id)}>{t('Открыть запись')}</Button>
          : <Link className="button button-secondary" to={'/disclosures/' + record.id}>{t('Открыть запись {number}', { number: record.number })}</Link>}
        {!admin && <Known record={record} reload={reload} />}
      </div>
    </li>)}
  </ul>;
}

function Known({ record, reload }: { record: RecordSummary; reload: () => void }) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  if (record.alreadyKnown?.mine) return <span className="muted">{t('Отмечено: уже знакомы')}</span>;
  if (!record.canMarkKnown) return null;
  async function mark() {
    setPending(true);
    setError('');
    try {
      await api('/disclosures/' + record.id + '/already-known', { method: 'POST' });
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось сохранить отметку.');
    } finally {
      setPending(false);
    }
  }
  return <>
    <Button variant="secondary" disabled={pending} onClick={() => void mark()}>{t('Уже знакомы')}</Button>
    {error && <Notice tone="error">{t(error)}</Notice>}
  </>;
}

function Pager({ records, setPage }: { records: Page; setPage: (page: number) => void }) {
  const { t } = useI18n();
  const pages = Math.max(1, Math.ceil(records.total / records.limit));
  return pages > 1 && <nav className="exchange-actions" aria-label={t('Страницы журнала')}>
    <Button variant="secondary" disabled={records.page <= 1} onClick={() => setPage(records.page - 1)}>{t('Назад')}</Button>
    <span>{t('{page} из {total}', { page: records.page, total: pages })}</span>
    <Button variant="secondary" disabled={records.page >= pages} onClick={() => setPage(records.page + 1)}>{t('Дальше')}</Button>
  </nav>;
}

export function DisclosuresPage() {
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const result = useRecord<Page>('/disclosures?page=' + page, revision);
  return <div className="container workflow-page exchange-page">
    <h1>{t('Раскрытия')}</h1>
    {!result ? <Spinner /> : result.error ? <Notice tone="error">{t(result.error)}</Notice> : result.data && <>
      <SummaryRows records={result.data} reload={() => setRevision(value => value + 1)} />
      <Pager records={result.data} setPage={setPage} />
    </>}
  </div>;
}

function SnapshotCard({ listing, title }: { listing: Snapshot; title: string }) {
  const { t, locale } = useI18n();
  const properties = [
    ['Количество', listing.quantity],
    ['Цена', listing.price == null || !listing.currency ? t('По договорённости') : formatMoney(listing.price, listing.currency, locale)],
    ['Состояние', listing.condition && t(terms[listing.condition] ?? listing.condition)],
    ['Наличие', listing.availability && t(terms[listing.availability] ?? listing.availability)],
    ['Страна отгрузки', listing.originCountry && countryName(listing.originCountry, locale)],
    ['Страна поставки', listing.destinationCountry && countryName(listing.destinationCountry, locale)],
    ['Срок поставки', listing.deliveryBy],
    ['Оплата', listing.paymentMethods?.map(method => t(terms[method] ?? method)).join(', ')],
    ['Доставка', listing.deliveryIncluded === undefined ? null : t(listing.deliveryIncluded ? 'Включена' : 'Отдельно')],
    ['Оформление и пошлины', listing.customsIncluded === undefined ? null : t(listing.customsIncluded ? 'Включены' : 'Отдельно')],
  ];
  return <section className="panel detail-panel">
    <h2>{title}</h2><p><strong>{listing.title}</strong></p>
    {listing.description && <p className="preserve-text">{listing.description}</p>}
    <dl>{properties.filter(([,value]) => value !== null && value !== undefined && value !== '').map(([label, value]) =>
      <div key={label}><dt>{t(String(label))}</dt><dd>{value}</dd></div>
    )}</dl>
  </section>;
}

function DisclosureRecord({ id, admin = false }: { id: string; admin?: boolean }) {
  const { t, locale } = useI18n();
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const path = (admin ? '/admin/disclosures/' : '/disclosures/') + encodeURIComponent(id);
  const result = useRecord<RecordDetail>(path, revision);
  const reload = () => setRevision(value => value + 1);
  if (!result) return <Spinner />;
  if (!result.data) return <Notice tone="error">{t(result.error ?? 'Запись не найдена.')}</Notice>;
  const record = result.data;
  const eventLabels: Record<string, string> = {
    ALREADY_KNOWN: 'Уже знакомы', DEAL_STATUS: 'Состояние сделки обновлено', DEAL_VERIFIED: 'Сделка проверена', ADMIN_NOTE: 'Заметка модератора',
  };
  return <>
    <h2>{record.number}</h2>
    <p>{localDate(record.acceptedAt, locale, record.timezone)} · {record.timezone}</p>
    <p>{record.rulesVersion ? t('Версия правил {version}', { version: record.rulesVersion }) : t('Версия правил не зафиксирована')}</p>
    {record.migrated && <Notice>{t('Условия и данные участников перенесены из прежней версии площадки.')}</Notice>}
    {[record.partner, record.partyA, record.partyB].filter(Boolean).map((party, index) => party && <div key={index} className="panel exchange-record">
      <strong>{party.nickname}</strong><span>{party.companyName ?? t('Частное лицо')}</span>
      <span>{countryName(party.country, locale)}{party.telegram ? ' · @' + party.telegram.replace(/^@/, '') : ''}</span>
    </div>)}
    <SnapshotCard listing={record.listing} title={t('Объявление на момент раскрытия')} />
    {record.counterListing && <SnapshotCard listing={record.counterListing} title={t('Встречное объявление')} />}
    <section className="panel detail-panel">
      <h2>{t('События раскрытия')}</h2>
      {record.events.length ? <ul className="exchange-events">{record.events.map((event, index) => <li key={index}>
        <strong>{t(eventLabels[event.type] ?? event.type)}</strong> · {localDate(event.at, locale, record.timezone)}
        {event.by && <span className="muted"> · {t(event.by === 'mine' ? 'Вы' : event.by === 'partner' ? 'Собеседник' : 'Система')}</span>}
        {event.data?.text && <p className="preserve-text">{event.data.text}</p>}
      </li>)}</ul> : <p className="muted">{t('Событий пока нет.')}</p>}
    </section>
    {!admin && <div className="exchange-actions"><Link className="button button-secondary" to={'/chats/' + record.chatId}>{t('Открыть чат')}</Link><Known record={record} reload={reload} /></div>}
    {admin && <form className="panel exchange-record" onSubmit={async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      setError('');
      setPending(true);
      try {
        await api(path + '/notes', { method: 'POST', body: { text: data.get('text') } });
        form.reset();
        reload();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Не удалось добавить заметку.');
      } finally {
        setPending(false);
      }
    }}>
      <p className="muted">{t('Идентификатор чата')}: <code>{record.chatId}</code></p>
      <Field label={t('Заметка модератора')}><textarea name="text" rows={3} minLength={10} maxLength={2000} required /></Field>
      {error && <Notice tone="error">{t(error)}</Notice>}
      <Button type="submit" disabled={pending}>{t('Добавить заметку')}</Button>
    </form>}
  </>;
}

export function DisclosureDetailPage() {
  const { id } = useParams();
  const { t } = useI18n();
  return <div className="container workflow-page exchange-page">
    <Link className="back-link" to="/disclosures">{t('К журналу раскрытий')}</Link>
    <h1>{t('Запись раскрытия')}</h1>
    {id && <DisclosureRecord id={id} />}
  </div>;
}

export function AdminDisclosures() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const selected = params.get('id') ?? '';
  const [filters, setFilters] = useState('');
  const [page, setPage] = useState(1);
  const result = useRecord<Page>('/admin/disclosures?page=' + page + filters, 0);
  function setSelected(id: string) {
    const next = new URLSearchParams(params);
    if (id) next.set('id', id);
    else next.delete('id');
    setParams(next, { replace: !id, preventScrollReset: true });
  }
  return <div className="exchange-page">
    <h2>{t('Журнал раскрытий')}</h2>
    {selected ? <><Button variant="ghost" onClick={() => setSelected('')}>{t('К журналу раскрытий')}</Button><DisclosureRecord key={selected} id={selected} admin /></> :
      <>
        <form className="exchange-filter" onSubmit={event => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const params = new URLSearchParams();
          for (const key of ['q', 'from', 'to', 'userId']) {
            const value = String(data.get(key) ?? '').trim();
            if (value) params.set(key, value);
          }
          setFilters(params.size ? '&' + params : '');
          setPage(1);
        }}>
          <Field label={t('Поиск')}><input name="q" type="search" maxLength={200} /></Field>
          <Field label={t('Участник (ID)')}><input name="userId" maxLength={36} /></Field>
          <Field label={t('Дата от')}><input name="from" type="date" /></Field>
          <Field label={t('Дата до')}><input name="to" type="date" /></Field>
          <Button type="submit" variant="secondary">{t('Найти')}</Button>
        </form>
        {!result ? <Spinner /> : result.error ? <Notice tone="error">{t(result.error)}</Notice> : result.data && <>
          <SummaryRows records={result.data} onSelect={setSelected} reload={() => {}} admin /><Pager records={result.data} setPage={setPage} />
        </>}
      </>}
  </div>;
}
