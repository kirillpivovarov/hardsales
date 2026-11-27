import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api';
import { useI18n } from './i18n';
import { countryName, formatMoney } from './market';
import { StaffDialog } from './StaffDialog';
import { Button, Field, Notice, Spinner } from './ui';

const failureLabels = {
  MODEL_ANALOG: 'Аналог не выбран', MODEL_MISSING: 'Модель определена по названию', CONDITION: 'Состояние',
  QUANTITY: 'Количество и партия', ORIGIN: 'Страна отгрузки', DESTINATION: 'Страна доставки',
  COUNTERPARTY: 'Тип контрагента', SHIP_DATE: 'Срок отгрузки', PRICE_OVER: 'Цена выше бюджета',
};
const representationLabels: Record<string, string> = {
  DIRECT: 'Прямая сторона', AGENT: 'Агент', BOTH: 'Прямая сторона или агент',
};
type Model = { id: string; nameRu: string; nameEn: string };
type Side = {
  id: string; title: string; nickname: string; representation: string; model: Model | null; modelByTitle: boolean;
  quantity: number; minLot: number; originScope: string | null; originCountry: string | null;
  destinationCountry: string | null; currency: string; unitPrice: number | null; shipDays: number | null;
  deliveryBy: string | null; confirmedAt: string | null;
};
type Pair = { sell: Side; buy: Side; failures: { key: string; text: string }[]; suggestedModel: Model | null; note: string | null };
type Page = { items: Pair[]; page: number; limit: number; total: number; maxFailuresCeiling: number };
type Dialog = { type: 'propose' | 'dismiss'; pair: Pair; trigger: HTMLElement };
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const idOf = (pair: Pair) => `${pair.sell.id}/${pair.buy.id}`;

function SideDetails({ side, sell }: { side: Side; sell: boolean }) {
  const { t, locale } = useI18n();
  const formatDate = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(value));
  const model = side.model && ((!locale.startsWith('ru') && side.model.nameEn) || side.model.nameRu);
  const origin = side.originScope === 'ANY' ? t('Любая страна') : side.originCountry ? countryName(side.originCountry, locale) : null;
  return <div className="near-miss-side">
    <span className="muted">{t(sell ? 'Предложение' : 'Заявка')}</span>
    <h3><Link to={'/listings/' + side.id}>{side.title}</Link></h3>
    <p>{side.nickname} · {t(representationLabels[side.representation] ?? 'Участник')}</p>
    <dl>
      <div><dt>{t('Модель')}</dt><dd>{model ?? t('Без модели')}{side.modelByTitle && <small> · {t('По названию')}</small>}</dd></div>
      <div><dt>{t('Количество')}</dt><dd>{t('{count} шт. (партия от {min})', { count: side.quantity, min: side.minLot })}</dd></div>
      {origin && <div><dt>{t('Страна отгрузки')}</dt><dd>{origin}</dd></div>}
      {side.destinationCountry && <div><dt>{t('Страна доставки')}</dt><dd>{countryName(side.destinationCountry, locale)}</dd></div>}
      <div><dt>{t('Цена за единицу')}</dt><dd>{side.unitPrice === null ? t('По договорённости') : <>
        {formatMoney(side.unitPrice, side.currency, locale)}
        {side.quantity > 1 && <div className="muted">{t('{price} за {quantity} шт.', {
          price: formatMoney(side.unitPrice * side.quantity, side.currency, locale), quantity: side.quantity,
        })}</div>}
      </>}</dd></div>
      {side.shipDays !== null && <div><dt>{t('Срок отгрузки')}</dt><dd>{t('{count} раб. дн. после оплаты', { count: side.shipDays })}</dd></div>}
      {side.deliveryBy && <div><dt>{t('Доставка до')}</dt><dd>{formatDate(side.deliveryBy + 'T12:00:00')}</dd></div>}
      {side.confirmedAt && <div><dt>{t('Подтверждено')}</dt><dd>{formatDate(side.confirmedAt)}</dd></div>}
    </dl>
  </div>;
}

export function NearMisses() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<Page>();
  const [families, setFamilies] = useState<{ key: string; label: string; models: Model[] }[]>([]);
  const [modelError, setModelError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState(1);
  const [maxFailures, setMaxFailures] = useState('');
  const [model, setModel] = useState('');
  const [reason, setReason] = useState('');
  const [dismissed, setDismissed] = useState(false);
  const [selected, setSelected] = useState<Dialog>();
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [dialogError, setDialogError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    void api<{ families: typeof families }>('/models', { signal: abort.signal }).then(value => {
      if (!abort.signal.aborted) setFamilies(value.families);
    }).catch(() => {
      if (!abort.signal.aborted) setModelError(true);
    });
    return () => abort.abort();
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError('');
    const query = new URLSearchParams({ page: String(page) });
    if (maxFailures) query.set('maxFailures', maxFailures);
    if (model) query.set('modelId', model);
    if (reason) query.set('key', reason);
    if (dismissed) query.set('dismissed', 'true');
    void api<Page>('/admin/near-misses?' + query, { signal: abort.signal }).then(result => {
      if (!abort.signal.aborted) setData(result);
    }).catch(cause => {
      if (!abort.signal.aborted) setError(message(cause, 'Не удалось загрузить пары.'));
    }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [page, dismissed, maxFailures, model, reason, revision]);

  function afterChange(text: string) {
    setNotice(text);
    if (data?.items.length === 1 && page > 1) setPage(page - 1);
    setRevision(value => value + 1);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || busy) return;
    const form = new FormData(event.currentTarget);
    const { pair, type } = selected;
    setBusy(idOf(pair));
    setDialogError('');
    setNotice('');
    const ids = { sellListingId: pair.sell.id, buyListingId: pair.buy.id };
    try {
      if (type === 'propose') {
        const result = await api<{ number: number }>('/admin/near-misses/propose', {
          method: 'POST', body: { ...ids, comment: form.get('comment') },
        });
        afterChange(t('Совпадение № {number} предложено обеим сторонам.', { number: result.number }));
      } else {
        await api('/admin/near-misses/dismiss', { method: 'POST', body: { ...ids, note: form.get('note') } });
        afterChange(t('Пара скрыта. Её можно вернуть из скрытых пар.'));
      }
      returnFocus.current = heading.current;
      setSelected(undefined);
    } catch (cause) { setDialogError(message(cause, 'Не удалось сохранить действие.')); }
    finally { setBusy(''); }
  }

  async function restore(pair: Pair) {
    if (busy) return;
    setBusy(idOf(pair));
    setError('');
    setNotice('');
    try {
      await api('/admin/near-misses/dismiss', { method: 'DELETE', body: { sellListingId: pair.sell.id, buyListingId: pair.buy.id } });
      heading.current?.focus();
      afterChange(t('Пара возвращена.'));
    } catch (cause) { setError(message(cause, 'Не удалось вернуть пару.')); }
    finally { setBusy(''); }
  }

  function open(type: Dialog['type'], pair: Pair, trigger: HTMLElement) {
    returnFocus.current = null;
    setDialogError('');
    setSelected({ type, pair, trigger });
  }

  const ceiling = data?.maxFailuresCeiling ?? 2;
  return <section aria-labelledby="near-miss-heading" className="match-results">
    <h3 id="near-miss-heading" tabIndex={-1} ref={heading}>{t('Почти совпадения')}</h3>
    <div className="panel match-card near-miss-filters">
      <Field label={t('Число причин')}>
        <select value={Number(maxFailures) > ceiling ? String(ceiling) : maxFailures} onChange={event => { setMaxFailures(event.target.value); setPage(1); }}>
          <option value="">{t('По настройке биржи')}</option>
          {Array.from({ length: ceiling }, (_, index) => index + 1).map(count =>
            <option key={count} value={count}>{t('До {count}', { count })}</option>)}
        </select>
      </Field>
      <Field label={t('Модель')}>
        <select value={model} onChange={event => { setModel(event.target.value); setPage(1); }} disabled={modelError}>
          <option value="">{t('Все модели')}</option>
          {families.map(family => <optgroup key={family.key} label={family.label}>
            {family.models.map(item => <option value={item.id} key={item.id}>{(!locale.startsWith('ru') && item.nameEn) || item.nameRu}</option>)}
          </optgroup>)}
        </select>
      </Field>
      <Field label={t('Причина')}>
        <select value={reason} onChange={event => { setReason(event.target.value); setPage(1); }}>
          <option value="">{t('Все причины')}</option>
          {Object.entries(failureLabels).filter(([key]) => key !== 'COUNTERPARTY').map(([key, label]) =>
            <option value={key} key={key}>{t(label)}</option>)}
        </select>
      </Field>
      <label className="checkbox near-miss-check"><input type="checkbox" checked={dismissed}
        onChange={event => { setDismissed(event.target.checked); setPage(1); }} />{t('Скрытые пары')}</label>
    </div>
    {modelError && <Notice>{t('Фильтр по моделям временно недоступен.')}</Notice>}
    {notice && <Notice tone="success">{notice}</Notice>}
    {error && <Notice tone="error">{t(error)} <Button variant="secondary" onClick={() => setRevision(value => value + 1)}>{t('Повторить')}</Button></Notice>}
    {loading ? <Spinner /> : data && <>
      {data.items.length === 0 && <p>{t(dismissed ? 'Скрытых пар нет.' : 'Почти совпадения не найдены.')}</p>}
      {data.items.map(pair => <article className="panel match-card" key={idOf(pair)}>
        <div className="near-miss-line">
          <SideDetails side={pair.sell} sell />
          <div className="near-miss-reasons"><h4>{t('Что различается')}</h4>
            <ul>{pair.failures.map(item => <li key={item.key}>{t(item.text)}</li>)}</ul>
          </div>
          <SideDetails side={pair.buy} sell={false} />
        </div>
        {dismissed && pair.note && <p>{pair.note}</p>}
        <div className="match-actions">
          {dismissed ? <Button variant="secondary" disabled={Boolean(busy)} onClick={() => void restore(pair)}>{t('Вернуть пару')}</Button> : <>
            <Button aria-haspopup="dialog" disabled={Boolean(busy)} onClick={event => open('propose', pair, event.currentTarget)}>{t('Предложить совпадение')}</Button>
            <Button aria-haspopup="dialog" disabled={Boolean(busy)} variant="secondary" onClick={event => open('dismiss', pair, event.currentTarget)}>{t('Скрыть пару')}</Button>
          </>}
        </div>
      </article>)}
      {(page > 1 || data.total > data.limit) && <nav className="match-pagination" aria-label={t('Страницы почти совпадений')}>
        <Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>{t('Назад')}</Button>
        <span>{t('Страница {page}', { page })}</span>
        <Button variant="secondary" disabled={page * data.limit >= data.total} onClick={() => setPage(page + 1)}>{t('Далее')}</Button>
      </nav>}
    </>}
    {selected && <StaffDialog title={t(selected.type === 'propose' ? 'Предложить совпадение' : 'Скрыть пару')}
      returnFocus={selected.trigger} returnFocusOverride={returnFocus} closeDisabled={Boolean(busy)} onClose={() => setSelected(undefined)}>
      <form aria-busy={Boolean(busy)} onSubmit={event => void submit(event)}>
        <p>{selected.pair.sell.title} · {selected.pair.buy.title}</p>
        {selected.type === 'propose' ? <Field label={t('Комментарий')}
          hint={t('Комментарий увидят обе стороны. Не называйте участников и компании.') }>
          <textarea name="comment" required minLength={10} maxLength={1000} disabled={Boolean(busy)} />
        </Field> : <Field label={t('Заметка для сотрудников')}><textarea name="note" maxLength={500} disabled={Boolean(busy)} /></Field>}
        {dialogError && <Notice tone="error">{t(dialogError)}</Notice>}
        <div className="match-actions">
          <Button type="submit" disabled={Boolean(busy)}>{t(selected.type === 'propose' ? 'Отправить предложение' : 'Скрыть пару')}</Button>
          <Button variant="secondary" disabled={Boolean(busy)} onClick={() => setSelected(undefined)}>{t('Отмена')}</Button>
        </div>
      </form>
    </StaffDialog>}
  </section>;
}
