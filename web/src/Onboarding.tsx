import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, isStaff, type User } from './api';
import { useI18n } from './i18n';
import { useExchange } from './Exchange';
import { TelegramProfile, type TelegramState } from './Telegram';
import { Button, Field, Notice } from './ui';
import './onboarding.css';

export { InvitesPanel, UserOnboardingAnswers } from './InviteAdmin';

type RepresentationMode = 'DIRECT' | 'AGENT' | 'BOTH';
type Question = { id: string; text: string; required: boolean };
type QuestionGroup = { key: 'buyer' | 'seller' | 'agent'; title: string; questions: Question[] };
type OnboardingData = {
  groups: QuestionGroup[];
  agentGroup: QuestionGroup;
  optionalHeading: string;
  answers: Record<string, string>;
  representationMode: RepresentationMode;
  rulesVersion: string;
  rulesContent: Record<string, { title: string; body: string }>;
  principalRequired: boolean;
  hasPrincipal: boolean;
};
type UserUpdateProps = { user: User; onUser: (user: User) => void };

const representationOptions = [
  { key: 'DIRECT', title: 'Прямая сторона', hint: 'Товар на своём складе или по прямому договору.' },
  { key: 'AGENT', title: 'Агент', hint: 'Мандат или агентский договор с продавцом или поручение заказчика.' },
  { key: 'BOTH', title: 'И то и другое', hint: 'Работаю напрямую и представляю другую сторону.' },
] as const;

function message(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

export function OnboardingPage({ user, onUser }: UserUpdateProps) {
  const { t, locale } = useI18n();
  const { features } = useExchange();
  const [data, setData] = useState<OnboardingData>();
  const [mode, setMode] = useState<RepresentationMode>('DIRECT');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [accepted, setAccepted] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [telegramInvite, setTelegramInvite] = useState(false);
  const [readyForListing, setReadyForListing] = useState(false);
  const loadedFor = useRef<string | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    void api<OnboardingData>('/onboarding', { signal: controller.signal }).then((result) => {
      setData(result);
      setAccepted(false);
      if (loadedFor.current !== user.id) {
        loadedFor.current = user.id;
        setMode(result.representationMode);
        setAnswers(result.answers);
      }
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(message(cause, 'Не удалось загрузить анкету.'));
    });
    return () => controller.abort();
  }, [user.id, loadAttempt]);

  const groups = data?.groups.filter((group) => group.key !== 'agent') ?? [];
  const questions = groups.flatMap((group) => group.questions);
  if (data && mode !== 'DIRECT') questions.push(...data.agentGroup.questions);
  const required = questions.filter((question) => question.required);
  const done = required.filter((question) => (answers[question.id] ?? '').trim().length >= 2).length;
  const principalRequired = Boolean(data && mode !== 'DIRECT' && !data.hasPrincipal);
  const rules = data?.rulesContent[locale] ?? data?.rulesContent.ru ?? Object.values(data?.rulesContent ?? {})[0];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || !accepted || saving || done !== required.length) return;
    const fields = new FormData(event.currentTarget);
    setSaving(true);
    setError('');
    setSuccess(false);
    try {
      const { user: updated } = await api<{ user: User }>('/onboarding', {
        method: 'PUT',
        body: {
          representationMode: mode,
          answers: Object.fromEntries(questions.map((question) => [question.id, answers[question.id] ?? ''])),
          rulesVersion: data.rulesVersion,
          ...(principalRequired && { principal: { name: fields.get('principalName'), company: fields.get('principalCompany') } }),
        },
      });
      onUser(updated);
      if (user.onboardingState === 'REQUIRED') {
        const telegram = features.feature_telegram === true
          ? await api<TelegramState>('/me/telegram').catch(() => undefined) : undefined;
        setTelegramInvite(Boolean(telegram?.enabled && !telegram.linked));
        setReadyForListing(true);
      } else {
        if (principalRequired) setData({ ...data, principalRequired: false, hasPrincipal: true });
        setSuccess(true);
      }
    } catch (cause) {
      setError(message(cause, 'Не удалось сохранить анкету.'));
    } finally {
      setSaving(false);
    }
  }

  function refresh() {
    setError('');
    setSuccess(false);
    setLoadAttempt((attempt) => attempt + 1);
  }

  function questionField(question: Question) {
    return (
      <Field key={question.id} label={t(question.text) + (question.required ? ' *' : '')}>
        <textarea name={question.id} value={answers[question.id] ?? ''} rows={3} required={question.required}
          minLength={question.required ? 2 : undefined} maxLength={2000}
          onChange={(event) => {
            setSuccess(false);
            const answer = event.target.value;
            setAnswers((previous) => ({ ...previous, [question.id]: answer }));
          }} />
      </Field>
    );
  }

  if (readyForListing) return <div className="container workflow-page workflow-stack">
    <p>{t('Шаг 4 из 4')}</p>
    <h1>{t('Разместите первое объявление')}</h1>
    <p>{t('Документы понадобятся, только когда захотите открыть контакты.')}</p>
    <div className="admin-actions">
      <Link className="button button-primary" to="/listings/new" replace>{t('Разместить')}</Link>
      <Link className="button button-ghost" to="/catalog" replace>{t('Позже')}</Link>
    </div>
    {telegramInvite && <details className="panel workflow-section">
      <summary>{t('Подключите Telegram')}</summary><TelegramProfile />
    </details>}
  </div>;

  return (
    <div className="container workflow-page">
      <div className="workflow-intro">
        {user.onboardingState === 'REQUIRED' && <p>{t('Шаг 3 из 4')}</p>}
        <h1>{t('Анкета участника')}</h1>
        <p>{t('Ответы доступны администрации площадки.')}</p>
      </div>
      {!data ? (
        error ? <div className="workflow-stack">
          <Notice tone="error">{t(error)}</Notice>
          <Button type="button" variant="secondary" onClick={refresh}>{t('Загрузить ещё раз')}</Button>
        </div> : <p role="status">{t('Загружаем анкету…')}</p>
      ) : (
        <form className="onboarding-form workflow-stack" onSubmit={submit} aria-busy={saving}>
          <fieldset className="panel workflow-section onboarding-section">
            <legend>{t('Как вы работаете')}</legend>
            <div className="onboarding-modes">
              {representationOptions.map(({ key, title, hint }) => (
                <label key={key} className="onboarding-choice">
                  <input type="radio" name="representationMode" value={key} checked={mode === key}
                    onChange={() => { setMode(key); setSuccess(false); }} />
                  <span><strong>{t(title)}</strong><span>{t(hint)}</span></span>
                </label>
              ))}
            </div>
          </fieldset>

          <section className="panel workflow-section workflow-stack" aria-labelledby="onboarding-questions">
            <h2 id="onboarding-questions">{t('Анкета')}</h2>
            <p className="onboarding-count" aria-live="polite">
              {t('Заполнено {done} из {total} обязательных полей', { done, total: required.length })}
            </p>
            {required.map(questionField)}
            <details>
              <summary>{t('Ответить подробнее (по желанию)')}</summary>
              <div className="workflow-stack">
                <p>{t(data.optionalHeading)}</p>
                {questions.filter((question) => !question.required).map(questionField)}
              </div>
            </details>
          </section>

          {principalRequired && (
            <section className="panel workflow-section workflow-stack" aria-labelledby="onboarding-principal">
              <h2 id="onboarding-principal">{t('Принципал')}</h2>
              <p>{t('Видит только модератор. Других принципалов можно добавить в профиле.')}</p>
              <Field label={t('Кого представляете')}><input name="principalName" minLength={2} maxLength={160} required /></Field>
              <Field label={t('Компания принципала')}><input name="principalCompany" maxLength={160} /></Field>
            </section>
          )}

          <section className="panel workflow-section workflow-stack" aria-labelledby="onboarding-rules">
            <h2 id="onboarding-rules">{t('Правила')}</h2>
            {rules ? <div className="onboarding-rules-text" tabIndex={0} role="region" aria-label={rules.title}>{rules.body}</div> :
              <Link to="/info/rules">{t('Читать правила площадки')}</Link>}
            <label className="onboarding-check">
              <input type="checkbox" checked={accepted} required onChange={(event) => setAccepted(event.target.checked)} />
              {t('Принимаю правила площадки версии {version}', { version: data.rulesVersion })}
            </label>
          </section>

          {error && <div className="workflow-stack">
            <Notice tone="error">{t(error)}</Notice>
            <Button type="button" variant="secondary" onClick={refresh}>{t('Обновить правила')}</Button>
          </div>}
          {success && <Notice tone="success">{t('Анкета сохранена.')}</Notice>}
          <div className="onboarding-submit">
            <Button type="submit" disabled={!accepted || saving || done !== required.length}>
              {t('Отправить анкету')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function useCurrentRules(user?: User | null) {
  const [current, setCurrent] = useState({ version: user?.rulesVersion, required: user?.rulesRequired });
  useEffect(() => {
    setCurrent({ version: user?.rulesVersion, required: user?.rulesRequired });
    if (!user?.id || isStaff(user)) return;
    const controller = new AbortController();
    void api<{ user: User | null }>('/auth/me', { signal: controller.signal }).then(({ user: loaded }) => {
      if (loaded) setCurrent({ version: loaded.rulesVersion, required: loaded.rulesRequired });
    }).catch(() => undefined);
    return () => controller.abort();
  }, [user?.id, user?.role, user?.rulesVersion, user?.rulesRequired]);
  return current;
}

export function RulesBanner({ user }: { user?: User | null }) {
  const { t } = useI18n();
  const { required, version } = useCurrentRules(user);
  if (!required || !version) return null;
  return (
    <Notice>
      <div className="onboarding-notice">
        <span>{t('Правила площадки обновились (версия {version})', { version })}</span>
        <Link to="/info/rules" className="button button-secondary">{t('Прочитать и принять')}</Link>
      </div>
    </Notice>
  );
}

export function RulesAcceptance({ user, onUser }: { user?: User | null; onUser: (user: User) => void }) {
  const { t } = useI18n();
  const { required, version } = useCurrentRules(user);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState(false);
  if (!user || isStaff(user) || user.mustChangePassword || (!required && !accepted)) return null;

  async function accept() {
    if (!version || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ user: User }>('/auth/rules/accept', { method: 'POST', body: { rulesVersion: version } });
      setAccepted(true);
      onUser(result.user);
    } catch (cause) {
      setError(message(cause, 'Не удалось принять правила.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workflow-stack onboarding-notice" aria-live="polite">
      {required && <Button type="button" disabled={busy || !version} onClick={() => void accept()}>
        {t('Принять правила версии {version}', { version: version ?? '' })}
      </Button>}
      {accepted && !required && <Notice tone="success">{t('Правила приняты.')}</Notice>}
      {error && <Notice tone="error">{t(error)}</Notice>}
    </div>
  );
}
