import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { api, isStaff, type User } from './api';
import { useI18n } from './i18n';
import { StaffDialog } from './StaffDialog';
import { Button, Field, Notice, Spinner } from './ui';
import './exchange-detail.css';

type Mode = 'DIRECT' | 'AGENT' | 'BOTH';
type Fee = { disclosed: boolean; kind?: string | null; value?: number | null; payer?: string | null };
type Letter = { toEmail: string; sentAt: string; status: string; deliveryStatus?: string };
type Principal = {
  id: string; number: number; name: string; company: string; email?: string | null; confirmed: boolean;
  confirmedVia?: string | null; confirmedAt?: string | null; confirmedBy?: { name?: string; position?: string } | null;
  deniedAt?: string | null; requestedAt?: string | null; emailAck?: { name?: string; at?: string } | null;
  liveListings: number; archivedListings: number; platformUser?: { nickname: string } | null; lastLetter?: Letter | null;
  userId?: string; agentNickname?: string; sameDomain?: boolean;
};
type RepresentationState = {
  enabled: boolean; representationMode?: Mode; companyEmail?: string | null; companyEmailDomainKind?: string | null;
  companyEmailConfirmedAt?: string | null; canUseAccountEmail?: boolean; companyEmailLetter?: Letter | null;
  agentFee?: Fee; agentFeeConfirmedAt?: string | null; agentFeePrincipalSays?: string | null;
};
type ListingRepresentation = {
  representation?: string | null; principalId?: string | null; principal?: { id: string } | null;
  agentFeeDisclosed?: boolean | null; agentFeeKind?: string | null; agentFeeValue?: number | null; agentFeePayer?: string | null;
};

const modeLabels = { DIRECT: 'Прямая сторона', AGENT: 'Агент', BOTH: 'Прямая сторона и агент' };

function useRepresentationState(user?: User | null) {
  const active = Boolean(user && !isStaff(user));
  const [state, setState] = useState<RepresentationState>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    void api<RepresentationState>('/me/representation', { signal: abort.signal }).then(data => {
      if (!abort.signal.aborted) setState(data);
    }).catch((cause: Error) => { if (!abort.signal.aborted) setError(cause.message); });
    return () => abort.abort();
  }, [active, user?.id]);
  return { state, setState, error };
}

function feeFromForm(form: FormData): Fee {
  return { disclosed: form.get('agentFeeDisclosed') === 'true', kind: String(form.get('agentFeeKind') ?? ''),
    value: Number(form.get('agentFeeValue')), payer: String(form.get('agentFeePayer') ?? '') };
}

function FeeFields({ fee }: { fee?: Fee }) {
  const { t } = useI18n();
  const [disclosed, setDisclosed] = useState(Boolean(fee?.disclosed));
  const [kind, setKind] = useState(fee?.kind || 'PERCENT');
  return <fieldset className="exchange-representation">
    <legend>{t('Вознаграждение агента')}</legend>
    <Field label={t('Вознаграждение в объявлении')}>
      <select name="agentFeeDisclosed" value={String(disclosed)} onChange={event => setDisclosed(event.target.value === 'true')}>
        <option value="false">{t('Не показывать')}</option><option value="true">{t('Показывать')}</option>
      </select>
    </Field>
    {disclosed && <div className="form-grid">
      <Field label={t('Вид вознаграждения')}><select name="agentFeeKind" value={kind} onChange={event => setKind(event.target.value)}>
        <option value="PERCENT">{t('Процент от суммы')}</option><option value="PER_UNIT">{t('Сумма за единицу')}</option>
      </select></Field>
      <Field label={t('Размер вознаграждения')}><input type="number" name="agentFeeValue" min="0.01"
        max={kind === 'PERCENT' ? 100 : 9999999999.99} step="0.01" defaultValue={fee?.value ?? ''} required /></Field>
      <Field label={t('Плательщик')}><select name="agentFeePayer" defaultValue={fee?.payer || 'SELLER'}>
        <option value="SELLER">{t('Продавец')}</option><option value="BUYER">{t('Покупатель')}</option><option value="BOTH">{t('Обе стороны')}</option>
      </select></Field>
    </div>}
  </fieldset>;
}

export function readListingRepresentation(form: FormData) {
  const representation = form.get('representation');
  if (!representation) return {};
  if (representation !== 'AGENT') return { representation };
  const fee = feeFromForm(form);
  return {
    representation, principalId: form.get('principalId') || null,
    ...(form.has('agentFeeDisclosed') && { agentFeeDisclosed: fee.disclosed, agentFeeKind: fee.kind, agentFeeValue: fee.value, agentFeePayer: fee.payer }),
  };
}

export function ListingRepresentationFields({ user, listing }: { user?: User | null; listing?: ListingRepresentation | null }) {
  const { t } = useI18n();
  const { state, error } = useRepresentationState(user);
  const [chosen, setChosen] = useState('');
  const [principals, setPrincipals] = useState<Principal[]>();
  const [principalError, setPrincipalError] = useState('');
  const mode = state?.representationMode ?? 'DIRECT';
  const eligible = state?.enabled && mode !== 'DIRECT';
  useEffect(() => {
    if (!eligible) return;
    const abort = new AbortController();
    void api<{ items: Principal[] }>('/me/principals', { signal: abort.signal }).then(response => setPrincipals(response.items))
      .catch((cause: Error) => { if (!abort.signal.aborted) setPrincipalError(cause.message); });
    return () => abort.abort();
  }, [eligible]);
  if (!user || isStaff(user)) return null;
  if (error) return <Notice tone="error">{t(error)}</Notice>;
  if (!state?.enabled) return null;
  const role = mode === 'BOTH' ? chosen || listing?.representation || 'DIRECT' : mode;
  const selected = listing?.principalId ?? listing?.principal?.id;
  const assigned = principals?.some(principal => principal.id === selected) ? selected : undefined;
  const fee = listing?.agentFeeDisclosed == null ? state.agentFee : {
    disclosed: listing.agentFeeDisclosed, kind: listing.agentFeeKind, value: listing.agentFeeValue, payer: listing.agentFeePayer,
  };
  return <div className="exchange-representation">
    {mode === 'BOTH' ? <Field label={t('Публикую как')}><select name="representation" value={role} onChange={event => setChosen(event.target.value)}>
      <option value="DIRECT">{t('Прямая сторона')}</option><option value="AGENT">{t('Агент')}</option>
    </select></Field> : <input type="hidden" name="representation" value={role} />}
    {role === 'AGENT' && <>
      {principalError ? <Notice tone="error">{t(principalError)}</Notice> : !principals ? <Spinner /> : principals.length ?
        <Field label={t('От чьего имени публикуется объявление')} hint={t('Имя и компания принципала доступны вам и модератору. Контрагент видит статус подтверждения полномочий.')}>
          <select name="principalId" defaultValue={assigned ?? (principals.length === 1 ? principals[0].id : '')} required>
            <option value="">{t('Выберите принципала')}</option>
            {principals.map(principal => <option key={principal.id} value={principal.id}>
              {[principal.name, principal.company].filter(Boolean).join(', ')} ({t(principal.confirmed ? 'полномочия подтверждены' : 'полномочия не подтверждены')})
            </option>)}
          </select>
        </Field> :
        <Notice>{t('В профиле нет ни одного принципала. Добавьте принципала, затем вернитесь к объявлению.')} <Link to="/account#principals">{t('Открыть профиль')}</Link></Notice>}
      <FeeFields fee={fee} />
    </>}
  </div>;
}

function letterMessage(letter: Letter | null | undefined, locale: string) {
  return letter ? { address: letter.toEmail, date: new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(letter.sentAt)) } : null;
}

function PrincipalStatus({ principal }: { principal: Principal }) {
  const { t, locale } = useI18n();
  const status = principal.confirmedVia === 'EMAIL' ? 'Полномочия подтверждены по корпоративной почте'
    : principal.confirmedVia === 'PLATFORM' ? 'Полномочия подтверждены на площадке'
    : principal.confirmedVia === 'ADMIN' ? 'Полномочия подтверждены модератором'
    : principal.emailAck ? 'Ответ получен с публичного почтового сервиса. Ожидается проверка модератора'
    : principal.deniedAt ? 'Компания не подтвердила полномочия' : principal.lastLetter?.deliveryStatus === 'FAILED' ? 'Письмо не доставлено'
    : principal.requestedAt && principal.lastLetter?.status === 'SENT' ? 'Запрос отправлен' : 'Полномочия не подтверждены';
  const sent = letterMessage(principal.lastLetter, locale);
  return <>
    <p>{t(status)}{principal.confirmedAt ? ' · ' + new Date(principal.confirmedAt).toLocaleDateString(locale) : ''}</p>
    {sent && <p className="muted">{t('Письмо на {address} от {date}', sent)}</p>}
    <p className="muted">{t('Действующих объявлений: {live}. В архиве: {archive}.', { live: principal.liveListings, archive: principal.archivedListings })}</p>
  </>;
}

export function RepresentationAccount({ user }: { user: User }) {
  const { t, locale } = useI18n();
  const { hash } = useLocation();
  const { state, setState, error: loadError } = useRepresentationState(user);
  const [principals, setPrincipals] = useState<Principal[]>([]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState('');
  const agent = state?.representationMode === 'AGENT' || state?.representationMode === 'BOTH';

  useEffect(() => {
    if (state?.enabled && (hash === '#principals' || hash === '#company-email')) {
      document.getElementById(hash.slice(1))?.scrollIntoView();
    }
  }, [state?.enabled, hash]);

  useEffect(() => {
    if (!agent) return;
    const abort = new AbortController();
    void api<{ items: Principal[] }>('/me/principals', { signal: abort.signal }).then(data => setPrincipals(data.items))
      .catch((cause: Error) => { if (!abort.signal.aborted) setError(cause.message); });
    return () => abort.abort();
  }, [agent]);

  async function action(path: string, method: string, body?: unknown, form?: HTMLFormElement) {
    setPending(true);
    setMessage('');
    setError('');
    try {
      await api(path, { method, body });
      const next = await api<RepresentationState>('/me/representation');
      setState(next);
      if (next.representationMode === 'AGENT' || next.representationMode === 'BOTH') {
        const data = await api<{ items: Principal[] }>('/me/principals');
        setPrincipals(data.items);
      }
      form?.reset();
      setEditing('');
      setMessage('Изменения сохранены.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось сохранить изменения.');
    } finally {
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>, path: string, method: string, toBody?: (form: FormData) => unknown, reset = false) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void action(path, method, toBody ? toBody(data) : Object.fromEntries(data), reset ? form : undefined);
  }

  if (isStaff(user)) return null;
  if (loadError) return <Notice tone="error">{t(loadError)}</Notice>;
  if (!state?.enabled) return null;
  const sent = letterMessage(state.companyEmailLetter, locale);
  const scope = state.companyEmailDomainKind === 'PUBLIC' ? 'Адрес подтверждён. Используется публичный почтовый сервис' : 'Корпоративный адрес подтверждён';
  return <div className="exchange-representation">
    <section className="panel workflow-section exchange-representation" id="company-email">
      <h2>{t('Почта компании')}</h2>
      <p>{t(state.companyEmailConfirmedAt ? scope : 'Почта компании ещё не подтверждена')}{state.companyEmail ? ' · ' + state.companyEmail : ''}</p>
      {sent && <p className="muted">{t('Письмо на {address} от {date}', sent)}
        {state.companyEmailLetter?.deliveryStatus === 'FAILED' ? ' · ' + t('Письмо не доставлено') : ''}</p>}
      <form className="exchange-filter" onSubmit={event => submit(event, '/me/company-email', 'POST')}>
        <Field label={t('Рабочая почта компании')}><input name="email" type="email" maxLength={254} required /></Field>
        <Button type="submit" disabled={pending}>{t('Подтвердить почту')}</Button>
        {state.canUseAccountEmail && <Button variant="secondary" disabled={pending}
          onClick={() => void action('/me/company-email', 'POST', { useAccountEmail: true })}>{t('Использовать почту аккаунта')}</Button>}
      </form>
    </section>

    <section className="panel workflow-section exchange-representation" id="principals">
      <h2>{t('Роль в сделках')}</h2>
      <form className="exchange-filter" key={state.representationMode} onSubmit={event => submit(event, '/me/representation', 'PATCH')}>
        <Field label={t('Представительство')}><select name="representationMode" defaultValue={state.representationMode}>
          {(Object.keys(modeLabels) as Mode[]).map(mode => <option key={mode} value={mode}>{t(modeLabels[mode])}</option>)}
        </select></Field>
        <Button type="submit" disabled={pending}>{t('Сохранить роль')}</Button>
      </form>
      {agent && <>
        <h3>{t('Принципалы и вознаграждение агента')}</h3>
        <p className="muted">{t('Имя и компания принципала доступны вам и модератору. При публикации выберите, от чьего имени размещаете объявление.')}</p>
        <ul className="exchange-records">{principals.map(principal => <li key={principal.id} className="panel exchange-record">
          <strong>{'PR-' + principal.number} · {principal.name}{principal.company ? ' · ' + principal.company : ''}</strong>
          <PrincipalStatus principal={principal} />
          {editing === principal.id && <form className="exchange-filter" onSubmit={event => submit(event, '/me/principals/' + principal.id, 'PATCH')}>
            <Field label={t('Имя принципала')}><input name="name" minLength={2} maxLength={160} defaultValue={principal.name} required /></Field>
            <Field label={t('Компания принципала')}><input name="company" maxLength={160} defaultValue={principal.company} /></Field>
            <Button type="submit" disabled={pending}>{t('Сохранить')}</Button>
            <Button variant="ghost" onClick={() => setEditing('')}>{t('Отмена')}</Button>
          </form>}
          <form className="exchange-filter" onSubmit={event => submit(event, '/me/principals/' + principal.id + '/email', 'POST')}>
            <Field label={t('Рабочая почта принципала')}><input type="email" name="email" defaultValue={principal.email ?? ''} maxLength={254} required /></Field>
            <Button type="submit" variant="secondary" disabled={pending}>{t(principal.lastLetter ? 'Отправить заново' : 'Отправить письмо компании')}</Button>
          </form>
          <div className="exchange-actions">
            {principal.platformUser && <Button variant="secondary" disabled={pending}
              onClick={() => void action('/me/principals/' + principal.id + '/request', 'POST')}>{t('Запросить подтверждение на площадке')}</Button>}
            {!principal.confirmed && editing !== principal.id && <Button variant="secondary" disabled={pending} onClick={() => setEditing(principal.id)}>{t('Редактировать')}</Button>}
            <Button variant="ghost" disabled={pending} onClick={() => {
              if (window.confirm(t('Убрать принципала {name}?', { name: principal.name }))) void action('/me/principals/' + principal.id, 'DELETE');
            }}>{t('Убрать')}</Button>
          </div>
        </li>)}</ul>
        <form className="exchange-filter" onSubmit={event => submit(event, '/me/principals', 'POST', undefined, true)}>
          <Field label={t('Имя принципала')}><input name="name" minLength={2} maxLength={160} required /></Field>
          <Field label={t('Компания принципала')}><input name="company" maxLength={160} /></Field>
          <Field label={t('Логин принципала на площадке')}><input name="platformNickname" maxLength={80} /></Field>
          <Button type="submit" disabled={pending}>{t('Добавить принципала')}</Button>
        </form>
        <p className="muted">{t('Ответ с рабочей почты подтверждает представительство сразу. Ответ с общей почты проверяет модератор.')}</p>
        <form className="exchange-representation" onSubmit={event => submit(event, '/me/agent-fee', 'PUT', feeFromForm)}>
          <FeeFields fee={state.agentFee} />
          {state.agentFeeConfirmedAt && <p>{t('Вознаграждение подтверждено принципалом.')}</p>}
          {state.agentFeePrincipalSays && <p>{t('Размер вознаграждения по данным принципала — {value}', { value: state.agentFeePrincipalSays })}</p>}
          <p className="muted">{t('После изменения вознаграждения подтвердите его у принципала повторно.')}</p>
          <div className="exchange-actions"><Button type="submit" disabled={pending}>{t('Сохранить вознаграждение')}</Button></div>
        </form>
      </>}
      {message && <Notice tone="success">{t(message)}</Notice>}
      {error && <Notice tone="error">{t(error)}</Notice>}
    </section>
  </div>;
}

function FeeSummary({ fee }: { fee: Fee }) {
  const { t } = useI18n();
  const payer = fee.payer === 'BOTH' ? 'обе стороны' : fee.payer === 'BUYER' ? 'покупатель' : 'продавец';
  return <p>{t('Вознаграждение агента')}: {fee.value} {t(fee.kind === 'PERCENT' ? '% от суммы' : 'за единицу')} · {t('Платит {payer}', { payer: t(payer) })}</p>;
}

export type RepresentationActionData = {
  purpose: string; agent?: { nickname: string; companyName?: string | null }; fee?: Fee | null;
};

export function RepresentationAction({ action, onSubmit, pending }: {
  action: RepresentationActionData; onSubmit: (answer: Record<string, unknown>) => void; pending?: boolean;
}) {
  const { t } = useI18n();
  const [feeAnswer, setFeeAnswer] = useState('');
  const principal = action.purpose === 'principal.confirm';
  return <form className="exchange-representation" onSubmit={event => {
    event.preventDefault();
    onSubmit({ ...Object.fromEntries(new FormData(event.currentTarget)), answer: 'YES' });
  }}>
    {principal ? <>
      <p>{t('Агент {name} указал, что представляет вашу компанию.', {
        name: [action.agent?.nickname, action.agent?.companyName].filter(Boolean).join(' · '),
      })}</p>
      <Field label={t('Ваше имя')}><input name="name" minLength={2} maxLength={120} required /></Field>
      <Field label={t('Должность')}><input name="position" maxLength={120} /></Field>
      {action.fee?.disclosed && <>
        <FeeSummary fee={action.fee} />
        <Field label={t('Вы согласны с размером вознаграждения?')}><select name="feeAnswer" value={feeAnswer} onChange={event => setFeeAnswer(event.target.value)} required>
          <option value="">{t('Выберите ответ')}</option>
          <option value="CONFIRMED">{t('Цифра верна')}</option><option value="OTHER">{t('Цифра другая')}</option>
        </select></Field>
        {feeAnswer === 'OTHER' && <Field label={t('Какая цифра верна')}><input name="feeOtherValue" maxLength={120} required /></Field>}
      </>}
    </> : <p>{t('Подтвердите, что это рабочий почтовый адрес вашей компании.')}</p>}
    <div className="exchange-actions">
      <Button type="submit" disabled={pending}>{t('Подтверждаю')}</Button>
      <Button variant="secondary" disabled={pending} onClick={() => onSubmit({ answer: 'NO' })}>{t('Не подтверждаю')}</Button>
    </div>
  </form>;
}

export function PrincipalAnswerPage() {
  const { t } = useI18n();
  const [search] = useSearchParams();
  const id = search.get('principalId') ?? '';
  const [record, setRecord] = useState<{ agentId: string; principalId: string; nickname: string; fee: Fee | null }>();
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<'' | 'YES' | 'NO' | 'OTHER'>('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    void api<NonNullable<typeof record>>('/principal-answers?principalId=' + encodeURIComponent(id), { signal: abort.signal }).then(setRecord)
      .catch((cause: Error) => { if (!abort.signal.aborted) setError(cause.message); });
    return () => abort.abort();
  }, [id]);
  return <div className="container workflow-page exchange-page">
    <h1>{t('Подтверждение представительства')}</h1>
    {done ? <Notice tone="success">{t('Ответ сохранён.')}</Notice> : record ? <form className="panel exchange-record" onSubmit={async event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      setPending(true);
      setError('');
      try {
        await api('/principal-answers', { method: 'POST', body: { agentId: record.agentId, principalId: record.principalId, answer, value: data.get('value') } });
        setDone(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Не удалось сохранить ответ.');
      } finally { setPending(false); }
    }}>
      <p>{t('Агент {name} указал, что представляет вас. Верно?', { name: record.nickname })}</p>
      {record.fee?.disclosed && <FeeSummary fee={record.fee} />}
      <Field label={t('Ответ')}><select value={answer} onChange={event => setAnswer(event.target.value as typeof answer)} required>
        <option value="">{t('Выберите ответ')}</option>
        <option value="YES">{t('Да')}</option><option value="NO">{t('Нет')}</option>
        {record.fee?.disclosed && <option value="OTHER">{t('Другая цифра')}</option>}
      </select></Field>
      {answer === 'OTHER' && <Field label={t('Какая цифра верна')}><input name="value" maxLength={120} required /></Field>}
      <Button type="submit" disabled={pending}>{t('Сохранить ответ')}</Button>
    </form> : !error && <Spinner />}
    {error && <Notice tone="error">{t(error)}</Notice>}
  </div>;
}

export function AdminPrincipals() {
  const { t } = useI18n();
  const [rows, setRows] = useState<{ items: Principal[]; page: number; limit: number; total: number }>();
  const [status, setStatus] = useState('UNCONFIRMED');
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<Principal>();
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusOverride = useRef<HTMLElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [decisionError, setDecisionError] = useState('');
  const [saved, setSaved] = useState<{ rowId?: string }>();
  useEffect(() => {
    const abort = new AbortController();
    setError('');
    void api<NonNullable<typeof rows>>('/admin/principals?' + new URLSearchParams({ status, page: String(page) }), { signal: abort.signal }).then(result => {
      if (abort.signal.aborted) return;
      const lastPage = Math.max(1, Math.ceil(result.total / result.limit));
      if (page > lastPage) setPage(lastPage);
      else setRows(result);
    })
      .catch((cause: Error) => { if (!abort.signal.aborted) setError(cause.message); });
    return () => abort.abort();
  }, [page, status, revision]);
  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || pending) return;
    const data = new FormData(event.currentTarget);
    setPending(true);
    setDecisionError('');
    try {
      await api('/admin/users/' + selected.userId + '/principals/' + selected.id + '/confirm', {
        method: 'POST', body: { feeConfirmed: data.get('feeConfirmed') === 'true', reason: data.get('reason') },
      });
      const disappears = status !== '' && status !== 'CONFIRMED';
      if (disappears) focusOverride.current = heading.current;
      setSaved(disappears ? {} : { rowId: selected.id });
      setSelected(undefined);
      setRevision(value => value + 1);
    } catch (cause) {
      setDecisionError(cause instanceof Error ? cause.message : 'Не удалось подтвердить принципала.');
    } finally {
      setPending(false);
    }
  }
  return <div className="exchange-page">
    <h2 ref={heading} tabIndex={-1}>{t('Принципалы')}</h2>
    <Field label={t('Статус принципала')}><select value={status} onChange={event => { setStatus(event.target.value); setPage(1); setSaved(undefined); }}>
      <option value="">{t('Все')}</option><option value="UNCONFIRMED">{t('Неподтверждённые')}</option>
      <option value="PUBLIC_ACK">{t('Ответ с общей почты')}</option><option value="DENIED">{t('Получен отказ')}</option>
      <option value="CONFIRMED">{t('Подтверждённые')}</option>
    </select></Field>
    {error && <Notice tone="error">{t(error)}</Notice>}
    {saved && !saved.rowId && <Notice tone="success">{t('Полномочия принципала подтверждены.')}</Notice>}
    {!rows ? !error && <Spinner /> : !rows.items.length ? <Notice>{t('Записей нет.')}</Notice> : <ul className="exchange-records">
      {rows.items.map(principal => <li key={principal.id} className="panel exchange-record">
        <strong>{'PR-' + principal.number} · {principal.name}{principal.company ? ' · ' + principal.company : ''}</strong>
        <p>{t('Агент: {name}', { name: principal.agentNickname ?? '' })}{principal.email ? ' · ' + principal.email : ''}</p>
        <PrincipalStatus principal={principal} />
        {principal.sameDomain && <Notice>{t('Домен совпадает с почтой агента.')}</Notice>}
        {principal.emailAck && <p>{t('Имя в ответе: {name}', { name: principal.emailAck.name ?? '' })}</p>}
        {principal.confirmedBy?.name && <p>{[principal.confirmedBy.name, principal.confirmedBy.position].filter(Boolean).join(', ')}</p>}
        <div className="exchange-actions"><Button variant="secondary" aria-haspopup="dialog" onClick={event => {
          trigger.current = event.currentTarget;
          focusOverride.current = null;
          setSaved(undefined);
          setDecisionError('');
          setSelected(principal);
        }}>{t('Подтвердить вручную')}</Button></div>
        {saved?.rowId === principal.id && <Notice tone="success">{t('Полномочия принципала подтверждены.')}</Notice>}
      </li>)}
    </ul>}
    {selected && <StaffDialog title={t('Подтвердить полномочия')} onClose={() => setSelected(undefined)}
      returnFocus={trigger.current} returnFocusOverride={focusOverride} closeDisabled={pending}>
        <form className="exchange-representation" onSubmit={confirm} aria-busy={pending}>
          <p><strong>{'PR-' + selected.number} · {selected.name}{selected.company ? ' · ' + selected.company : ''}</strong></p>
          {selected.confirmed && <Notice>{t('Повторная проверка обновит текущий результат.')}</Notice>}
          <Field label={t('Что проверено')}><select name="feeConfirmed" required defaultValue={selected.confirmed ? '' : 'false'}>
            {selected.confirmed && <option value="" disabled>{t('Выберите результат проверки')}</option>}
            <option value="false">{t('Только представительство')}</option><option value="true">{t('Представительство и вознаграждение')}</option>
          </select></Field>
          <Field label={t('Причина')}><textarea name="reason" minLength={3} maxLength={500} rows={2} required /></Field>
          {decisionError && <Notice tone="error">{t(decisionError)}</Notice>}
          <div className="exchange-actions"><Button type="submit" disabled={pending}>{t('Подтвердить')}</Button>
            <Button variant="secondary" disabled={pending} onClick={() => setSelected(undefined)}>{t('Отмена')}</Button></div>
        </form>
    </StaffDialog>}
    {rows && rows.total > rows.limit && <nav className="exchange-actions" aria-label={t('Страницы принципалов')}>
      <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('Назад')}</Button>
      <Button variant="secondary" disabled={page * rows.limit >= rows.total} onClick={() => setPage(page + 1)}>{t('Дальше')}</Button>
    </nav>}
  </div>;
}
