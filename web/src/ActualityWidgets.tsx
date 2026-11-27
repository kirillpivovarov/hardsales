import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from './api';
import { useI18n } from './i18n';
import { maxUnitPrice } from './market';
import { Button, Field, Notice } from './ui';
import './actuality.css';

interface PendingListing {
  id: string;
  title: string;
  askedAt: string;
  deadlineAt: string;
}

export interface ActualitySummary {
  enabled: boolean;
  startsAt?: string | null;
  timezone: string;
  pending: PendingListing[];
  deadlineAt: string | null;
  suspended: boolean;
  pause: { startsAt: string; endsAt: string } | null;
  pauseDaysLeft: number;
  missedDays30: number;
}

export interface ActualityListingFields {
  lifetimeDays?: number;
  expiresAt?: string | null;
  confirmedAt?: string | null;
  askedAt?: string | null;
  hiddenAt?: string | null;
  hiddenReason?: string | null;
  spotCheckHold?: boolean | null;
  archivedReason?: string | null;
  freshness?: { today: boolean; hoursAgo: number; label: string } | null;
  priceChanges14?: number;
}

export type ActualityAnswer = { answer: 'ACTUAL' } |
  { answer: 'CHANGED'; price?: number; quantity?: number } |
  { answer: 'WITHDRAWN'; reason: 'SOLD_PLATFORM' | 'SOLD_OUTSIDE' | 'CANCELLED' };

type FormListing = { priceMode?: string; price?: number | null; quantity?: number; minLot?: number };
type EditAction = 'CHANGED' | 'WITHDRAWN';

export function useActuality(revision = 0) {
  const [summary, setSummary] = useState<ActualitySummary>();
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    setError('');
    api<ActualitySummary>('/me/actuality', { signal: abort.signal }).then(value => {
      if (!abort.signal.aborted) setSummary(value);
    }).catch(cause => {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить актуальность.');
    });
    return () => abort.abort();
  }, [revision]);
  return { summary, error };
}

export function actualityDate(value: string, locale: string, timezone = 'Europe/Moscow') {
  return new Intl.DateTimeFormat(locale, { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

export function ActualityStartNotice({ summary }: { summary?: ActualitySummary }) {
  const { t, locale } = useI18n();
  if (!summary?.startsAt) return null;
  return <Notice>{t('Ежедневное подтверждение начнётся {date} ({timezone}).', {
    date: actualityDate(summary.startsAt, locale, summary.timezone), timezone: summary.timezone,
  })}</Notice>;
}

export function ActualityBadges({ listing }: { listing: ActualityListingFields }) {
  const { t } = useI18n();
  const changes = listing.priceChanges14 ?? 0;
  const freshness = listing.askedAt ? null : listing.freshness;
  if (!freshness && !changes) return null;
  const plural = changes % 100 < 11 || changes % 100 > 14;
  const changeLabel = plural && changes % 10 >= 2 && changes % 10 <= 4
    ? 'Цена менялась {n} раза за 14 дней' : 'Цена менялась {n} раз за 14 дней';
  return <div className="actuality-badges">
    {freshness && <span className={freshness.today ? 'actuality-badge actuality-fresh' : 'actuality-badge'}>
      {freshness.today ? t('Подтверждено сегодня') : t('Подтверждено {n} ч назад', { n: freshness.hoursAgo })}
    </span>}
    {changes > 0 && <span className="actuality-badge actuality-price">{t(changeLabel, { n: changes })}</span>}
  </div>;
}

export function ActualitySuspension({ summary, onChanged }: { summary?: ActualitySummary; onChanged: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!summary?.suspended) return null;
  async function resume() {
    setBusy(true);
    setError('');
    try {
      await api('/me/actuality/resume', { method: 'POST' });
      onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось вернуть объявления.'); }
    finally { setBusy(false); }
  }
  return <div className="actuality-banner actuality-suspension" role="alert">
    <div>
      <strong>{t('Три пропуска за 30 дней: все объявления скрыты')}</strong>
      {error && <p>{t(error)}</p>}
    </div>
    <Button variant="secondary" disabled={busy} onClick={() => void resume()}>{t('Я на связи, вернуть объявления')}</Button>
  </div>;
}

export function AccountActuality() {
  const { t, locale } = useI18n();
  const [revision, setRevision] = useState(0);
  const { summary, error: loadError } = useActuality(revision);
  const [days, setDays] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const onChanged = () => setRevision(count => count + 1);

  async function togglePause(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await (summary?.pause ? api('/me/pause', { method: 'DELETE' }) :
        api('/me/pause', { method: 'POST', body: { days: Number(days) } }));
      onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось изменить паузу.'); }
    finally { setBusy(false); }
  }

  if (loadError) return <Notice tone="error">{t(loadError)}</Notice>;
  if (!summary || (!summary.enabled && !summary.startsAt && !summary.pause && !summary.suspended)) return null;
  return <div className="workflow-stack">
    <ActualityStartNotice summary={summary} />
    <ActualitySuspension summary={summary} onChanged={onChanged} />
    {(summary.enabled || summary.pause) && <section className="panel workflow-section">
      <h2>{t('Пауза объявлений')}</h2>
      <p className="workflow-muted-line">{t('В этом месяце использовано {used} дн., осталось {left} дн.', {
        used: 5 - summary.pauseDaysLeft, left: summary.pauseDaysLeft,
      })}</p>
      {summary.pause ? <p>{t('Пауза до {date}. Объявления скрыты, запросы актуальности не приходят.', {
        date: actualityDate(summary.pause.endsAt, locale, summary.timezone),
      })}</p> : <p>{t('На время паузы активные объявления скрываются. После окончания они вернутся в каталог автоматически.')}</p>}
      {error && <Notice tone="error">{t(error)}</Notice>}
      <form className="actuality-pause-controls" onSubmit={togglePause}>
        {!summary.pause && <Field label={t('Дни паузы')}>
          <select value={days} onChange={event => setDays(event.target.value)}>
            {[1, 2, 3, 4, 5].map(day => <option key={day} value={day}>{day}</option>)}
          </select>
        </Field>}
        <Button type="submit" variant="secondary"
          disabled={busy || (!summary.pause && (!summary.enabled || summary.pauseDaysLeft === 0))}>
          {t(summary.pause ? 'Снять паузу' : 'Поставить паузу')}
        </Button>
      </form>
    </section>}
  </div>;
}

export function ActualityDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const labelId = useId();
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    return () => {
      element?.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return <dialog className="panel actuality-dialog" ref={dialog} aria-labelledby={labelId}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <h2 id={labelId}>{title}</h2>
    {children}
  </dialog>;
}

export function ActualityEditForm({ action, listing, onSubmit, onClose }: {
  action: EditAction; listing: FormListing; onSubmit: (input: ActualityAnswer) => Promise<unknown>; onClose?: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError('');
    setBusy(true);
    try {
      if (action === 'WITHDRAWN') {
        await onSubmit({ answer: action, reason: String(data.get('reason')) as Extract<ActualityAnswer, { answer: 'WITHDRAWN' }>['reason'] });
      } else {
        const price = String(data.get('price') ?? '').trim();
        const quantity = String(data.get('quantity') ?? '').trim();
        if (!price && !quantity) {
          setError('Укажите новую цену или количество.');
          return;
        }
        await onSubmit({ answer: action, ...(price ? { price: Number(price) } : {}), ...(quantity ? { quantity: Number(quantity) } : {}) });
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось подтвердить объявление.'); }
    finally { setBusy(false); }
  }

  return <form className="workflow-stack" onSubmit={submit}>
    {action === 'CHANGED' ? <>
      {listing.priceMode !== 'NEGOTIABLE' && <Field label={t('Новая цена за шт.')}>
        <input name="price" type="number" min="0.01" max={maxUnitPrice} step="0.01"
          placeholder={listing.price == null ? undefined : String(listing.price)} />
      </Field>}
      <Field label={t('Новое количество')} hint={listing.minLot && listing.minLot > 1
        ? t('Минимальная партия · {quantity}', { quantity: listing.minLot }) : undefined}>
        <input name="quantity" type="number" min={listing.minLot ?? 1} max="1000000" step="1"
          placeholder={listing.quantity === undefined ? undefined : String(listing.quantity)} />
      </Field>
    </> : <Field label={t('Причина снятия')}>
      <select name="reason" defaultValue="SOLD_PLATFORM">
        <option value="SOLD_PLATFORM">{t('Сделка через площадку')}</option>
        <option value="SOLD_OUTSIDE">{t('Сделка вне площадки')}</option>
        <option value="CANCELLED">{t('Отменено')}</option>
      </select>
    </Field>}
    {error && <Notice tone="error">{t(error)}</Notice>}
    <div className="workflow-actions">
      <Button type="submit" variant={action === 'WITHDRAWN' ? 'danger' : 'primary'} disabled={busy}>
        {t(action === 'WITHDRAWN' ? 'Снять объявление' : 'Сохранить и подтвердить')}
      </Button>
      {onClose && <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{t('Отмена')}</Button>}
    </div>
  </form>;
}

export function ActualityActionForm({ fields, onSubmit }: { fields: FormListing; onSubmit: (input: ActualityAnswer) => Promise<unknown> }) {
  const { t } = useI18n();
  const [action, setAction] = useState<EditAction>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function confirm() {
    setBusy(true);
    setError('');
    try { await onSubmit({ answer: 'ACTUAL' }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось подтвердить объявление.'); }
    finally { setBusy(false); }
  }

  return <div className="workflow-stack">
    {error && <Notice tone="error">{t(error)}</Notice>}
    <div className="workflow-actions">
      <Button type="button" disabled={busy} onClick={() => void confirm()}>{t('Актуально')}</Button>
      <Button type="button" variant="secondary" disabled={busy} onClick={() => setAction('CHANGED')}>{t('Изменилась цена или количество')}</Button>
      <Button type="button" variant="ghost" disabled={busy} onClick={() => setAction('WITHDRAWN')}>{t('Снято')}</Button>
    </div>
    {action && <ActualityDialog title={t(action === 'CHANGED' ? 'Изменилась цена или количество' : 'Снять объявление')} onClose={() => setAction(undefined)}>
      <ActualityEditForm action={action} listing={fields} onSubmit={onSubmit} onClose={() => setAction(undefined)} />
    </ActualityDialog>}
  </div>;
}
