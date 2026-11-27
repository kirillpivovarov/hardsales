import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from './api';
import { useI18n } from './i18n';
import { StaffDialog } from './StaffDialog';
import { Button, Field, Notice, Spinner } from './ui';
import './disputes.css';

const kinds = {
  MISREPRESENTATION: 'Цена или количество не соответствуют объявлению',
  HIDDEN_MARKUP: 'Скрытая наценка агента',
  NO_CORRESPONDENCE: 'Отказ передать переписку',
  BYPASS: 'Обход площадки после раскрытия',
  FORGERY: 'Подделка документов или фото',
  OTHER: 'Другое',
};
const states = {
  OPENED: 'Открыт', AWAITING_MATERIALS: 'Сбор материалов', REVIEW: 'На рассмотрении',
  DECIDED: 'Решение вынесено', REOPENED: 'На пересмотре', CLOSED: 'Отозван',
};
const penalties = {
  NONE: 'Отклонить спор без наказания',
  MISREPRESENTATION: 'Скрыть объявление, снизить рейтинг на 10 баллов',
  HIDDEN_MARKUP: 'Снять метку об открытом вознаграждении на 90 дней',
  NO_CORRESPONDENCE: 'Решить спор в пользу другой стороны',
  LOST: 'Зафиксировать проигранный спор',
  BYPASS: 'Заблокировать за обход площадки',
  FORGERY: 'Заблокировать за подделку',
};

type Summary = {
  id: string; number: string; kind: keyof typeof kinds; status: keyof typeof states; disclosureId: string; dealId: string | null;
  openedAt: string; notifyBy: string; notifiedAt: string | null; materialsBy: string | null; decisionBy: string | null;
  reviewUntil: string | null; openedByName?: string; againstName?: string;
};
type Page = { items: Summary[]; total: number; page: number; limit: number; timezone: string };
type Message = {
  id: string; body: string; round: number; replyTo: string | null; mine: boolean;
  staff: boolean; fromName?: string; toUserId?: string; createdAt: string;
};
type Dispute = Summary & {
  openedBy: string; against: string; essence: string; demand: string; timezone: string; position: string | null;
  parties: { id: string; nickname: string }[];
  materials: { id: string; round: number; mine: boolean; userId: string; note?: string; fileName?: string }[];
  messages: Message[]; listings: { id: string; title: string; ownerId: string }[];
  decisions: { id: string; round: number; loserId: string | null; decidedAt: string; sameReviewer: boolean;
    penalty: keyof typeof penalties; rationale: string; reviewerName?: string }[];
  reviews: { id: string; userId: string; text: string; submittedAt: string }[];
  restriction: string | null; canReview: boolean;
};
type DealChoices = { items: { id: string; title: string; createdAt: string }[] };

function useResult<T>(path: string, revision = 0) {
  const [result, setResult] = useState<{ path: string; value?: T; error?: string }>();
  useEffect(() => {
    if (!path) return;
    const abort = new AbortController();
    void api<T>(path, { signal: abort.signal })
      .then(value => { if (!abort.signal.aborted) setResult({ path, value }); })
      .catch((error: Error) => { if (!abort.signal.aborted) setResult({ path, error: error.message }); });
    return () => abort.abort();
  }, [path, revision]);
  return result?.path === path ? result : undefined;
}

function useMutation() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(false);
  async function run<T>(fn: () => Promise<T>, done?: (value: T) => void) {
    if (active.current) return;
    active.current = true;
    setBusy(true); setError('');
    try { done?.(await fn()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить изменение.'); }
    finally { active.current = false; setBusy(false); }
  }
  return { busy, error, run };
}

function dateTime(value: string, locale: string, timeZone: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(value));
}

function due(dispute: Summary) {
  if (dispute.status === 'OPENED') return { label: 'Уведомить до', value: dispute.notifyBy };
  if (dispute.status === 'AWAITING_MATERIALS') return { label: 'Материалы до', value: dispute.materialsBy };
  if (dispute.status === 'REVIEW' || dispute.status === 'REOPENED') return { label: 'Решение до', value: dispute.decisionBy };
  if (dispute.status === 'DECIDED' && dispute.reviewUntil) return { label: 'Запросить пересмотр до', value: dispute.reviewUntil };
  return null;
}

function Deadline({ dispute, timezone }: { dispute: Summary; timezone: string }) {
  const { t, locale } = useI18n();
  const deadline = due(dispute);
  if (!deadline?.value) return null;
  const late = dispute.status !== 'DECIDED' && new Date(deadline.value).getTime() < Date.now();
  return <div className={late ? 'dispute-deadline dispute-overdue' : 'dispute-deadline'}>
    <strong>{t(deadline.label)}</strong> <time dateTime={deadline.value}>{dateTime(deadline.value, locale, timezone)}</time>
    {late && <span> · {t('Срок прошёл')}</span>}
  </div>;
}

function DisputeSummaries({ page, onSelect, onPage }: {
  page: Page;
  onSelect?: (id: string, control: HTMLButtonElement) => void;
  onPage?: (page: number) => void;
}) {
  const { t } = useI18n();
  return <>
    {!page.items.length && <Notice>{t('Споров пока нет.')}</Notice>}
    <ul className="exchange-records">
      {page.items.map(dispute => <li className="panel exchange-record" key={dispute.id}>
        <strong>{t('Спор №{number}', { number: dispute.number })}</strong>
        <span>{t(states[dispute.status])} · {t(kinds[dispute.kind])}</span>
        {dispute.openedByName && <span className="muted">{dispute.openedByName} · {dispute.againstName}</span>}
        <Deadline dispute={dispute} timezone={page.timezone} />
        {onSelect ? <Button variant="secondary" aria-haspopup="dialog" onClick={event => onSelect(dispute.id, event.currentTarget)}>
          {t('Открыть спор №{number}', { number: dispute.number })}
        </Button> : <Link className="button button-secondary" to={'/disputes/' + dispute.id}>{t('Открыть спор №{number}', { number: dispute.number })}</Link>}
      </li>)}
    </ul>
    {onPage && page.total > page.limit && <nav className="exchange-actions" aria-label={t('Страницы споров')}>
      <Button variant="secondary" disabled={page.page <= 1} onClick={() => onPage(page.page - 1)}>{t('Назад')}</Button>
      <span>{page.page} / {Math.ceil(page.total / page.limit)}</span>
      <Button variant="secondary" disabled={page.page * page.limit >= page.total} onClick={() => onPage(page.page + 1)}>{t('Далее')}</Button>
    </nav>}
  </>;
}

export function DisputeDisclosurePanel({ id }: { id: string }) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const [show, setShow] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const result = useResult<Page>('/disputes?disclosureId=' + id);
  const deals = useResult<DealChoices>(show ? '/disclosures/' + id + '/dispute-deals' : '');
  const { busy, error, run } = useMutation();
  return <section className="panel detail-panel dispute-panel">
    <h2>{t('Споры по раскрытию')}</h2>
    <Link to="/info/disputes">{t('Порядок рассмотрения')}</Link>
    {result?.value ? <DisputeSummaries page={result.value} /> : result?.error ? <Notice tone="error">{t(result.error)}</Notice> : <Spinner />}
    <Button aria-haspopup="dialog" onClick={event => { trigger.current = event.currentTarget; setShow(true); }}>{t('Открыть спор')}</Button>
    {show && <StaffDialog title={t('Открыть спор')} onClose={() => setShow(false)} closeDisabled={busy} returnFocus={trigger.current}>
      <form className="dispute-form" onSubmit={event => {
        event.preventDefault();
        const fields = Object.fromEntries(new FormData(event.currentTarget));
        void run(() => api<Dispute>('/disputes', { method: 'POST', body: { ...fields, disclosureId: id } }),
          dispute => navigate('/disputes/' + dispute.id));
      }}>
        <Field label={t('Причина спора')}><select name="kind" required defaultValue="">
          <option value="" disabled>{t('Выберите причину')}</option>
          {Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select></Field>
        <Field label={t('Сделка')} hint={t('Если спор относится к конкретной сделке, выберите её.')}>
          <select name="dealId" defaultValue=""><option value="">{t('Без привязки к сделке')}</option>
            {deals?.value?.items.map(deal => <option key={deal.id} value={deal.id}>{deal.title} · {new Date(deal.createdAt).toLocaleDateString(locale)}</option>)}
          </select>
        </Field>
        <Field label={t('Опишите, что случилось')}><textarea name="essence" minLength={20} maxLength={4000} required rows={4} /></Field>
        <Field label={t('Какого результата вы ожидаете')}><textarea name="demand" minLength={5} maxLength={1000} required rows={3} /></Field>
        {error && <Notice tone="error">{t(error)}</Notice>}
        <Button type="submit" disabled={busy}>{t('Подать спор')}</Button>
      </form>
    </StaffDialog>}
  </section>;
}

export function DisputesPage({ userId }: { userId: string }) {
  const { t } = useI18n();
  const { id } = useParams();
  const [page, setPage] = useState(1);
  const result = useResult<Page>(id ? '' : '/disputes?page=' + page);
  return <div className="container workflow-page exchange-page">
    {id ? <>
      <Link className="back-link" to="/disputes">{t('К списку споров')}</Link>
      <DisputeDetail key={id} id={id} userId={userId} />
    </> : <>
      <h1>{t('Споры')}</h1>
      <Link to="/info/disputes">{t('Порядок рассмотрения')}</Link>
      {result?.value ? <DisputeSummaries page={result.value} onPage={setPage} /> : result?.error ? <Notice tone="error">{t(result.error)}</Notice> : <Spinner />}
    </>}
  </div>;
}

export function AdminDisputes() {
  const { t } = useI18n();
  const [query, setQuery] = useSearchParams();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const selected = query.get('dispute');
  const heading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const fallback = useRef<HTMLElement>(null);
  const result = useResult<Page>('/admin/disputes?' + new URLSearchParams({ page: String(page), ...(status ? { status } : {}) }), revision);
  function select(id: string, control?: HTMLButtonElement) {
    const next = new URLSearchParams(query);
    if (id) { trigger.current = control ?? null; fallback.current = null; next.set('dispute', id); }
    else { if (!trigger.current?.isConnected) fallback.current = heading.current; next.delete('dispute'); }
    setQuery(next, { replace: !id, preventScrollReset: true });
  }
  return <section className="exchange-page">
    <h2 ref={heading} tabIndex={-1}>{t('Споры')}</h2>
    <Field label={t('Состояние спора')}><select value={status} onChange={event => { setPage(1); setStatus(event.target.value); }}>
      <option value="">{t('Все состояния')}</option>{Object.entries(states).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}
    </select></Field>
    {result?.value ? <DisputeSummaries page={result.value} onPage={setPage} onSelect={select} /> : result?.error ? <Notice tone="error">{t(result.error)}</Notice> : <Spinner />}
    {selected && <StaffDialog key={selected} title={t('Карточка спора')} onClose={() => select('')}
      returnFocus={trigger.current} returnFocusOverride={fallback}>
      <DisputeDetail id={selected} userId="" staff onChange={() => setRevision(value => value + 1)} />
    </StaffDialog>}
  </section>;
}

function DisputeDetail({ id, userId, staff = false, onChange }: { id: string; userId: string; staff?: boolean; onChange?: () => void }) {
  const { t, locale } = useI18n();
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<'decision' | 'withdraw'>();
  const [evidence, setEvidence] = useState(false);
  const [replyTo, setReplyTo] = useState('');
  const trigger = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const dialogFallback = useRef<HTMLElement>(null);
  const formFocus = useRef<HTMLTextAreaElement>(null);
  const errorFocus = useRef<HTMLDivElement>(null);
  const result = useResult<Dispute>('/disputes/' + id, revision);
  const mutation = useMutation();
  useEffect(() => {
    if (mutation.error && !dialog) errorFocus.current?.focus();
  }, [mutation.error, dialog]);
  const dispute = result?.value;
  if (!dispute) return result?.error ? <Notice tone="error">{t(result.error)}</Notice> : <Spinner />;
  const nickname = (id?: string | null) => dispute.parties.find(party => party.id === id)?.nickname ?? '';
  const inReview = dispute.status === 'REVIEW' || dispute.status === 'REOPENED';
  const awaiting = dispute.status === 'AWAITING_MATERIALS' && Boolean(dispute.materialsBy && new Date(dispute.materialsBy).getTime() > Date.now());
  const canAttach = !staff && (awaiting || dispute.status === 'OPENED' && dispute.openedBy === userId ||
    dispute.status === 'REOPENED' && dispute.reviews.some(review => review.userId === userId) || inReview && Boolean(replyTo));
  const refresh = () => { setRevision(value => value + 1); onChange?.(); };
  function act(path: string, body?: unknown, done?: () => void) {
    void mutation.run(() => api(path, { method: 'POST', body }), () => { done?.(); refresh(); });
  }
  function submit(event: FormEvent<HTMLFormElement>, path: string, additional: Record<string, unknown> = {}) {
    event.preventDefault();
    const form = event.currentTarget;
    act(path, { ...Object.fromEntries(new FormData(form)), ...additional }, () => form.reset());
  }
  return <article className="dispute-detail workflow-stack">
    <header>
      {staff ? <h2 ref={heading} tabIndex={-1}>{t('Спор №{number}', { number: dispute.number })}</h2>
        : <h1 ref={heading} tabIndex={-1}>{t('Спор №{number}', { number: dispute.number })}</h1>}
      <p>{t(states[dispute.status])} · {t(kinds[dispute.kind])}</p>
      <Deadline dispute={dispute} timezone={dispute.timezone} />
      <p className="muted">{t('Часовой пояс площадки')}: {dispute.timezone}</p>
    </header>
    <section className="panel detail-panel">
      <h3>{t('Суть спора')}</h3><p className="preserve-text">{dispute.essence}</p>
      <h3>{t('Требование')}</h3><p className="preserve-text">{dispute.demand}</p>
      <p className="muted">{t('Подал спор')}: {nickname(dispute.openedBy)} · {t('Вторая сторона')}: {nickname(dispute.against)}</p>
      {!staff && <div className="exchange-actions">
        <Link to={'/disclosures/' + dispute.disclosureId}>{t('Запись раскрытия')}</Link>
        {dispute.dealId && <Link to={'/deals/' + dispute.dealId}>{t('Сделка')}</Link>}
      </div>}
    </section>
    {staff && <div className="exchange-actions">
      {dispute.status === 'OPENED' && <Button disabled={mutation.busy} onClick={() => act('/admin/disputes/' + id + '/notify')}>{t('Уведомить вторую сторону')}</Button>}
      {dispute.status === 'AWAITING_MATERIALS' && <Button disabled={mutation.busy} onClick={() => act('/admin/disputes/' + id + '/start-review')}>{t('Начать разбор')}</Button>}
      {inReview && <Button aria-haspopup="dialog" disabled={Boolean(dispute.restriction) || mutation.busy}
        onClick={event => { trigger.current = event.currentTarget; dialogFallback.current = null; setDialog('decision'); }}>{t('Решить')}</Button>}
      <Button variant="secondary" aria-expanded={evidence} onClick={() => setEvidence(!evidence)}>{t('Переписка пары')}</Button>
    </div>}
    {dispute.restriction && <Notice>{t(dispute.restriction)}</Notice>}
    {evidence && <Evidence id={id} />}
    <section className="panel detail-panel">
      <h3>{t('Позиция второй стороны')}</h3>
      {!staff && userId === dispute.against && awaiting ?
        <form className="dispute-form" onSubmit={event => submit(event, '/disputes/' + id + '/position')}>
          <Field label={t('Ваша позиция')}><textarea name="text" defaultValue={dispute.position ?? ''} maxLength={4000} required rows={4} /></Field>
          <Button type="submit" variant="secondary" disabled={mutation.busy}>{t('Сохранить позицию')}</Button>
        </form> : <p className="preserve-text">{dispute.position ?? t('Позиция пока не представлена.')}</p>}
    </section>
    <section className="panel detail-panel">
      <h3>{t('Материалы')}</h3>
      <ul className="dispute-list">
        {dispute.materials.map(material => <li key={material.id}>
          <strong>{nickname(material.userId)} · {t(material.round === 1 ? 'Материалы спора' : 'Материалы пересмотра')}</strong>
          {material.note && <p className="preserve-text">{material.note}</p>}
          {material.fileName && <a href={'/api/v1/disputes/' + id + '/materials/' + material.id + '/file'} download>{material.fileName}</a>}
        </li>)}
      </ul>
      {!dispute.materials.length && <p className="muted">{t('Материалов пока нет.')}</p>}
      {canAttach && <form className="dispute-form" onSubmit={event => {
        event.preventDefault();
        const form = event.currentTarget;
        const fields = new FormData(form);
        const file = fields.get('file');
        const note = String(fields.get('note') ?? '').trim();
        const data = new FormData();
        if (file instanceof File && file.size) data.set('file', file);
        data.set('data', JSON.stringify({ note, ...(replyTo ? { questionId: replyTo } : {}) }));
        act('/disputes/' + id + '/materials', data, () => form.reset());
      }}>
        <Field label={t('Описание материала')}><textarea name="note" maxLength={2000} rows={3} /></Field>
        <Field label={t('Файл')} hint={t('PDF, JPEG, PNG, WebP или текст UTF-8 до 10 МиБ.')}>
          <input name="file" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.txt" />
        </Field>
        <Button type="submit" variant="secondary" disabled={mutation.busy}>{t('Добавить материал')}</Button>
      </form>}
    </section>
    <section className="panel detail-panel">
      <h3>{t('Вопросы сотрудника')}</h3>
      {dispute.messages.length ? <ul className="dispute-list">{dispute.messages.map(message => <li key={message.id}>
        <strong>{message.staff ? t('Вопрос сотрудника') : t('Ответ участника')}{staff && message.toUserId && nickname(message.toUserId) ? ' · ' + nickname(message.toUserId) : ''}</strong>
        <p className="preserve-text">{message.body}</p>
        {!staff && message.staff && inReview && message.round === (dispute.status === 'REOPENED' ? 2 : 1) && <Button variant="secondary"
          onClick={() => { setReplyTo(message.id); requestAnimationFrame(() => formFocus.current?.focus()); }}>{t('Ответить')}</Button>}
      </li>)}</ul> : <p className="muted">{t('Вопросов пока нет.')}</p>}
      {staff && inReview && <form className="dispute-form" onSubmit={event => submit(event, '/disputes/' + id + '/messages')}>
        <Field label={t('Кому')}><select name="toUserId" defaultValue={dispute.against} required>
          {dispute.parties.map(party => <option key={party.id} value={party.id}>{party.nickname}</option>)}</select></Field>
        <Field label={t('Вопрос')}><textarea name="body" maxLength={4000} required rows={3} /></Field>
        <Button type="submit" variant="secondary" disabled={mutation.busy}>{t('Задать вопрос')}</Button>
      </form>}
      {!staff && inReview && replyTo && <form className="dispute-form"
        onSubmit={event => submit(event, '/disputes/' + id + '/messages', { replyTo })}>
        <Field label={t('Ответ сотруднику')}><textarea ref={formFocus} name="body" maxLength={4000} required rows={3} /></Field>
        <div className="exchange-actions"><Button type="submit" disabled={mutation.busy}>{t('Отправить ответ')}</Button>
          <Button variant="ghost" onClick={() => setReplyTo('')}>{t('Отмена')}</Button></div>
      </form>}
    </section>
    {dispute.decisions.map(decision => <section className="panel detail-panel" key={decision.id}>
      <h3>{t(decision.round === 1 ? 'Решение оператора' : 'Окончательное решение')}</h3>
      <p>{t(penalties[decision.penalty])}{decision.loserId && ' · ' + nickname(decision.loserId)}</p>
      <p className="preserve-text">{decision.rationale}</p>
      <time dateTime={decision.decidedAt}>{dateTime(decision.decidedAt, locale, dispute.timezone)}</time>
      {staff && decision.reviewerName && <p>{decision.reviewerName}{decision.sameReviewer && ' · ' + t('Пересмотр тем же сотрудником')}</p>}
    </section>)}
    {dispute.reviews.length > 0 && <section className="panel detail-panel">
      <h3>{t('Доводы для пересмотра')}</h3>
      <ul className="dispute-list">{dispute.reviews.map(review => <li key={review.id}><strong>{nickname(review.userId)}</strong>
        <p className="preserve-text">{review.text}</p></li>)}</ul>
    </section>}
    {dispute.canReview && <form className="panel detail-panel dispute-form"
      onSubmit={event => submit(event, '/disputes/' + id + '/review')}>
      <Field label={t('Новые доводы для пересмотра')}><textarea name="text" minLength={20} maxLength={4000} required rows={4} /></Field>
      <Button type="submit" disabled={mutation.busy}>{t('Подать запрос на пересмотр')}</Button>
    </form>}
    {!staff && dispute.openedBy === userId && ['OPENED', 'AWAITING_MATERIALS', 'REVIEW'].includes(dispute.status) &&
      <Button variant="secondary" aria-haspopup="dialog" onClick={event => { trigger.current = event.currentTarget; dialogFallback.current = null; setDialog('withdraw'); }}>{t('Отозвать спор')}</Button>}
    {mutation.error && !dialog && <div ref={errorFocus} tabIndex={-1}><Notice tone="error">{t(mutation.error)}</Notice></div>}
    {dialog && <StaffDialog title={t(dialog === 'decision' ? 'Решение по спору' : 'Отозвать спор')} onClose={() => setDialog(undefined)}
      returnFocus={trigger.current} closeDisabled={mutation.busy} returnFocusOverride={dialogFallback}>
      {dialog === 'decision' ? <DecisionForm dispute={dispute} busy={mutation.busy} submit={body => act('/admin/disputes/' + id + '/decide', body, () => { dialogFallback.current = heading.current; setDialog(undefined); })} /> : <>
        <p>{t('Рассмотрение спора прекратится.')}</p>
        <Button variant="danger" disabled={mutation.busy} onClick={() => act('/disputes/' + id + '/withdraw', {}, () => { dialogFallback.current = heading.current; setDialog(undefined); })}>{t('Подтвердить отзыв')}</Button>
      </>}
      {mutation.error && <Notice tone="error">{t(mutation.error)}</Notice>}
    </StaffDialog>}
  </article>;
}

function DecisionForm({ dispute, busy, submit }: { dispute: Dispute; busy: boolean; submit: (body: Record<string, unknown>) => void }) {
  const { t } = useI18n();
  const [penalty, setPenalty] = useState<keyof typeof penalties>('NONE');
  const [loser, setLoser] = useState('');
  return <form className="dispute-form" onSubmit={event => { event.preventDefault(); submit(Object.fromEntries(new FormData(event.currentTarget))); }}>
    <Field label={t('Решение')}><select name="penalty" value={penalty} onChange={event => setPenalty(event.target.value as keyof typeof penalties)}>
      {Object.entries(penalties).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
    </select></Field>
    {penalty !== 'NONE' && <Field label={t('Проигравшая сторона')}>
      <select name="loserId" value={loser} onChange={event => setLoser(event.target.value)} required>
        <option value="" disabled>{t('Выберите сторону')}</option>{dispute.parties.map(party => <option key={party.id} value={party.id}>{party.nickname}</option>)}
      </select>
    </Field>}
    {penalty === 'MISREPRESENTATION' && <Field label={t('Какое объявление скрыть')}>
      <select name="listingId" key={loser} defaultValue="">
        <option value="">{t('Объявление проигравшего из записи раскрытия')}</option>
        {dispute.listings.filter(listing => listing.ownerId === loser).map(listing => <option key={listing.id} value={listing.id}>{listing.title}</option>)}
      </select>
    </Field>}
    <Field label={t('Обоснование')}><textarea name="rationale" minLength={20} maxLength={4000} rows={4} required /></Field>
    <Button type="submit" disabled={busy}>{t('Сохранить решение')}</Button>
  </form>;
}

function Evidence({ id }: { id: string }) {
  const { t } = useI18n();
  const [chat, setChat] = useState('');
  const [page, setPage] = useState(1);
  type EvidencePage = { chats: { id: string; title: string }[]; chatId?: string; page: number; total: number; limit: number;
    items: { id: string; body: string; nickname: string }[] };
  const result = useResult<EvidencePage>('/admin/disputes/' + id + '/evidence?' +
    new URLSearchParams({ page: String(page), ...(chat ? { chatId: chat } : {}) }));
  if (!result?.value) return result?.error ? <Notice tone="error">{t(result.error)}</Notice> : <Spinner />;
  const value = result.value;
  return <section className="panel detail-panel">
    <h3>{t('Переписка пары')}</h3>
    {value.chats.length > 0 && <Field label={t('Чат')}>
      <select value={value.chatId} onChange={event => { setChat(event.target.value); setPage(1); }}>
        {value.chats.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select>
    </Field>}
    {value.items.length ? <ul className="dispute-list">{value.items.map(message => <li key={message.id}><strong>{message.nickname}</strong>
      <p className="preserve-text">{message.body}</p></li>)}</ul> : <p>{t('Сообщений пока нет.')}</p>}
    {value.total > value.limit && <div className="exchange-actions">
      <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('Назад')}</Button>
      <Button variant="secondary" disabled={page * value.limit >= value.total} onClick={() => setPage(page + 1)}>{t('Далее')}</Button>
    </div>}
  </section>;
}

export function BlockedDisputeAppeal() {
  const { t } = useI18n();
  const { token } = useParams();
  const [complete, setComplete] = useState(false);
  const mutation = useMutation();
  if (complete) return <Notice tone="success">{t('Запрос на пересмотр принят.')}</Notice>;
  return <form className="dispute-form" onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const file = data.get('file');
    if (!(file instanceof File) || !file.size) data.delete('file');
    void mutation.run(() => api('/disputes/review-link/' + encodeURIComponent(token ?? ''), { method: 'POST', body: data }),
      () => setComplete(true));
  }}>
    <Field label={t('Новые доводы для пересмотра')}><textarea name="text" minLength={20} maxLength={4000} required rows={5} /></Field>
    <Field label={t('Файл к пересмотру')} hint={t('PDF, JPEG, PNG, WebP или текст UTF-8 до 10 МиБ.')}>
      <input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.txt" />
    </Field>
    {mutation.error && <Notice tone="error">{t(mutation.error)}</Notice>}
    <Button type="submit" disabled={mutation.busy}>{t('Подать запрос на пересмотр')}</Button>
  </form>;
}
