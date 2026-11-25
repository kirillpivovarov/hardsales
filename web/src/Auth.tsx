import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type User } from './api';
import { useI18n } from './i18n';
import { CountrySelect } from './CountrySelect';
import { Button, Field, Notice } from './ui';
import './workflows.css';

interface Challenge {
  challengeId: string;
  expiresIn: number;
  email: string;
}

interface PendingChallenge extends Challenge {
  expiresAt: number;
  resendAt: number;
}

interface AccountProps {
  user: User;
  onUser: (user: User) => void;
}

const usernameRules = String.raw`[A-Za-z0-9][A-Za-z0-9_.\-]{2,31}`;
const telegramRules = '@?[A-Za-z][A-Za-z0-9_]{4,31}';
const valueOf = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
const passwordOf = (form: FormData, name = 'password') => String(form.get(name) ?? '');

function returnPath(search: URLSearchParams) {
  const path = search.get('next');
  return path?.startsWith('/') && !path.startsWith('//') && !/[\\\x00-\x1f]/.test(path) ? path : undefined;
}

export function authDestination(user: User, search: string | URLSearchParams) {
  if (user.mustChangePassword) return '/account';
  if (user.role === 'ADMIN') return '/admin';
  return returnPath(new URLSearchParams(search)) ?? '/catalog';
}

export function AuthPage({
  mode,
  onUser,
}: {
  mode: 'login' | 'register';
  onUser: (user: User) => void;
}) {
  return <AuthForm key={mode} mode={mode} onUser={onUser} />;
}

function AuthForm({
  mode,
  onUser,
}: {
  mode: 'login' | 'register';
  onUser: (user: User) => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const next = returnPath(search);
  const nextQuery = next ? `?next=${encodeURIComponent(next)}` : '';
  const [participantType, setParticipantType] = useState('INDIVIDUAL');
  const [challenge, setChallenge] = useState<PendingChallenge>();
  const [clock, setClock] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const isRegistering = mode === 'register';

  useEffect(() => {
    if (!challenge) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [challenge]);

  function storeChallenge(next: Challenge) {
    const now = Date.now();
    setClock(now);
    setChallenge({ ...next, expiresAt: now + next.expiresIn * 1000, resendAt: now + 60_000 });
  }

  function finish(user: User) {
    onUser(user);
    navigate(authDestination(user, search), { replace: true });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setNotice('');
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      if (challenge) {
        const result = await api<{ user: User }>('/auth/verify', {
          method: 'POST',
          body: { challengeId: challenge.challengeId, code: valueOf(form, 'code') },
        });
        finish(result.user);
        return;
      }
      const body = isRegistering ? {
        username: valueOf(form, 'username'),
        email: valueOf(form, 'email'),
        password: passwordOf(form),
        role: valueOf(form, 'role'),
        participantType,
        ...(participantType === 'COMPANY' && { companyName: valueOf(form, 'companyName') }),
        country: valueOf(form, 'country'),
        city: valueOf(form, 'city'),
        telegram: valueOf(form, 'telegram'),
      } : { login: valueOf(form, 'login'), password: passwordOf(form) };

      const result = await api<Challenge | { user: User }>(isRegistering ? '/auth/register' : '/auth/login', {
        method: 'POST',
        body,
      });
      if ('challengeId' in result) storeChallenge(result);
      else finish(result.user);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось завершить действие. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (!challenge) return;
    setError('');
    setNotice('');
    setBusy(true);
    try {
      storeChallenge(await api<Challenge>('/auth/resend', { method: 'POST', body: { challengeId: challenge.challengeId } }));
      setNotice('Новый код отправлен на почту.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось отправить новый код.');
    } finally {
      setBusy(false);
    }
  }

  const expired = challenge ? clock >= challenge.expiresAt : false;
  const resendRemaining = challenge ? Math.max(0, Math.ceil((challenge.resendAt - clock) / 1000)) : 0;

  return (
    <div className="workflow-page container">
      <section className={`panel workflow-auth ${isRegistering && !challenge ? 'workflow-auth-wide' : ''}`} aria-labelledby="auth-title">
        <div className="workflow-intro">
          <h1 id="auth-title">{t(challenge ? isRegistering ? 'Подтвердите почту' : 'Подтвердите вход' : isRegistering ? 'Регистрация' : 'Вход в аккаунт')}</h1>
          {challenge && <p>{t('Введите шестизначный код, отправленный на {email}.', { email: challenge.email })}</p>}
          {isRegistering && !challenge && <p>{t('Создайте профиль, чтобы просматривать объявления и общаться с контрагентами.')}</p>}
        </div>
        <form className={challenge || !isRegistering ? 'workflow-stack' : 'form-grid workflow-form'} onSubmit={submit} aria-busy={busy} key={challenge ? challenge.challengeId : mode}>
          {challenge ? (
            <>
              <Field label={t('Код из письма')} hint={t(expired ? 'Срок действия кода истёк. Запросите новый.' : 'Код действует 10 минут.')}>
                <input
                  name="code"
                  type="text"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoFocus
                  required
                />
              </Field>
              {error && <Notice tone="error">{t(error)}</Notice>}
              {notice && <Notice tone="success">{t(notice)}</Notice>}
              <Button type="submit" disabled={busy || expired}>{t('Подтвердить')}</Button>
              <Button type="button" variant="secondary" onClick={() => void resend()} disabled={busy || resendRemaining > 0}>
                {resendRemaining > 0 ? t('Отправить ещё раз через {seconds} с', { seconds: resendRemaining }) : t('Отправить код ещё раз')}
              </Button>
            </>
          ) : isRegistering ? (
            <>
              <Field label={t('Роль')}>
                <select name="role" defaultValue="BUYER">
                  <option value="BUYER">{t('Покупатель')}</option>
                  <option value="SELLER">{t('Продавец')}</option>
                </select>
              </Field>
              <Field label={t('Тип участника')}>
                <select name="participantType" value={participantType} onChange={event => setParticipantType(event.target.value)}>
                  <option value="INDIVIDUAL">{t('Частное лицо')}</option>
                  <option value="COMPANY">{t('Компания')}</option>
                </select>
              </Field>
              {participantType === 'COMPANY' && (
                <div className="workflow-span">
                  <Field label={t('Название компании')}>
                    <input name="companyName" autoComplete="organization" minLength={2} maxLength={120} required />
                  </Field>
                </div>
              )}
              <Field label={t('Логин')} hint={t('Введите от 3 до 32 латинских букв, цифр, точек, дефисов или подчёркиваний.')}>
                <input name="username" autoComplete="username" pattern={usernameRules} minLength={3} maxLength={32} required />
              </Field>
              <Field label={t('Электронная почта')}>
                <input name="email" type="email" autoComplete="email" maxLength={254} required />
              </Field>
              <CountrySelect label={t('Страна')} name="country" autoComplete="country" defaultValue="RU" required />
              <Field label={t('Город')}>
                <input name="city" autoComplete="address-level2" minLength={2} maxLength={80} required />
              </Field>
              <Field label={t('Имя пользователя в Telegram')} hint={t('Контакт откроется собеседнику только по взаимному согласию.')}>
                <input name="telegram" placeholder="@username" pattern={telegramRules} minLength={5} maxLength={33} required />
              </Field>
              <Field label={t('Пароль')} hint={t('Не менее 12 символов.')}>
                <input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required />
              </Field>
              {error && <div className="workflow-span"><Notice tone="error">{t(error)}</Notice></div>}
              <div className="workflow-span"><Button type="submit" disabled={busy}>{t('Получить код')}</Button></div>
            </>
          ) : (
            <>
              <Field label={t('Логин или электронная почта')}>
                <input name="login" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={254} required />
              </Field>
              <Field label={t('Пароль')}>
                <input name="password" type="password" autoComplete="current-password" maxLength={128} required />
              </Field>
              {error && <Notice tone="error">{t(error)}</Notice>}
              <Button type="submit" disabled={busy}>{t('Войти')}</Button>
            </>
          )}
        </form>
        <div className="workflow-auth-links">
          {challenge ? (
            <Button type="button" variant="ghost" disabled={busy} onClick={() => { setChallenge(undefined); setError(''); setNotice(''); }}>{t('Вернуться к форме')}</Button>
          ) : isRegistering ? (
            <p>{t('Уже есть аккаунт?')} <Link to={`/login${nextQuery}`}>{t('Войти')}</Link></p>
          ) : (
            <p>{t('Нет аккаунта?')} <Link to={`/register${nextQuery}`}>{t('Зарегистрироваться')}</Link></p>
          )}
        </div>
      </section>
    </div>
  );
}

export function AccountPage({ user, onUser }: AccountProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [profileFeedback, setProfileFeedback] = useState({ error: '', notice: '', busy: false });
  const [passwordFeedback, setPasswordFeedback] = useState({ error: '', notice: '', busy: false });
  const isAdmin = user.role === 'ADMIN';

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setProfileFeedback({ busy: true, error: '', notice: '' });
    try {
      const result = await api<{ user: User }>('/auth/profile', {
        method: 'PATCH',
        body: {
          displayName: valueOf(form, 'displayName'),
          city: valueOf(form, 'city'),
          country: valueOf(form, 'country'),
          telegram: valueOf(form, 'telegram'),
          ...(user.participantType === 'COMPANY' && { companyName: valueOf(form, 'companyName') }),
        },
      });
      onUser(result.user);
      setProfileFeedback({ busy: false, error: '', notice: 'Профиль обновлён.' });
    } catch (cause) {
      setProfileFeedback({ busy: false, error: cause instanceof Error ? cause.message : 'Не удалось обновить профиль.', notice: '' });
    }
  }

  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const newPassword = passwordOf(form, 'newPassword');
    if (newPassword !== passwordOf(form, 'confirmPassword')) {
      setPasswordFeedback({ busy: false, error: 'Новые пароли не совпадают.', notice: '' });
      return;
    }
    setPasswordFeedback({ busy: true, error: '', notice: '' });
    try {
      const result = await api<{ user?: User }>(isAdmin ? '/auth/credentials' : '/auth/password', {
        method: isAdmin ? 'PATCH' : 'POST',
        body: {
          currentPassword: passwordOf(form, 'currentPassword'),
          newPassword,
          ...(isAdmin && valueOf(form, 'username') && { username: valueOf(form, 'username') }),
        },
      });
      element.reset();
      if (result?.user) {
        const username = element.elements.namedItem('username');
        if (username instanceof HTMLInputElement) username.value = result.user.username;
        onUser(result.user);
      }
      setPasswordFeedback({ busy: false, error: '', notice: 'Данные для входа обновлены.' });
      if (user.mustChangePassword && isAdmin) navigate('/admin', { replace: true });
    } catch (cause) {
      setPasswordFeedback({ busy: false, error: cause instanceof Error ? cause.message : 'Не удалось сменить пароль.', notice: '' });
    }
  }

  return (
    <div className="workflow-page container">
      <div className="workflow-intro"><h1>{t('Настройки аккаунта')}</h1></div>
      <div className="workflow-stack workflow-account">
        {user.mustChangePassword && <Notice>{t('Смените временный пароль администратора, чтобы открыть панель управления.')}</Notice>}
        {!user.mustChangePassword && !isAdmin && (
          <section className="panel workflow-section" aria-labelledby="profile-title">
            <h2 id="profile-title">{t('Профиль')}</h2>
            <form className="form-grid workflow-form" onSubmit={saveProfile} aria-busy={profileFeedback.busy}>
              <Field label={t('Отображаемое имя')}>
                <input name="displayName" defaultValue={user.displayName} minLength={2} maxLength={80} required />
              </Field>
              <Field label={t('Электронная почта')}>
                <input type="email" readOnly value={user.email} />
              </Field>
              <CountrySelect label={t('Страна')} name="country" autoComplete="country" defaultValue={user.country} required />
              <Field label={t('Город')}>
                <input name="city" autoComplete="address-level2" defaultValue={user.city} minLength={2} maxLength={80} required />
              </Field>
              {user.participantType === 'COMPANY' && (
                <Field label={t('Название компании')}>
                  <input name="companyName" autoComplete="organization" defaultValue={user.companyName ?? ''} minLength={2} maxLength={120} required />
                </Field>
              )}
              <Field label={t('Имя пользователя в Telegram')} hint={t('Контакт открывается в чате по взаимному согласию.')}>
                <input name="telegram" defaultValue={user.telegram ?? ''} pattern={telegramRules} minLength={5} maxLength={33} required />
              </Field>
              {profileFeedback.error && <div className="workflow-span"><Notice tone="error">{t(profileFeedback.error)}</Notice></div>}
              {profileFeedback.notice && <div className="workflow-span"><Notice tone="success">{t(profileFeedback.notice)}</Notice></div>}
              <div className="workflow-span"><Button type="submit" disabled={profileFeedback.busy}>{t('Сохранить профиль')}</Button></div>
            </form>
          </section>
        )}
        <section className="panel workflow-section" aria-labelledby="password-title">
          <h2 id="password-title">{t(isAdmin ? 'Данные администратора' : 'Смена пароля')}</h2>
          <form className="form-grid workflow-form" onSubmit={savePassword} aria-busy={passwordFeedback.busy}>
            {isAdmin && (
              <Field label={t('Логин')}>
                <input name="username" autoComplete="username" defaultValue={user.username} pattern={usernameRules} maxLength={32} required />
              </Field>
            )}
            <Field label={t('Текущий пароль')}>
              <input name="currentPassword" type="password" autoComplete="current-password" maxLength={128} required />
            </Field>
            <Field label={t('Новый пароль')} hint={t('Не менее 12 символов.')}>
              <input name="newPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required />
            </Field>
            <Field label={t('Повторите новый пароль')}>
              <input name="confirmPassword" type="password" autoComplete="new-password" maxLength={128} required />
            </Field>
            {passwordFeedback.error && <div className="workflow-span"><Notice tone="error">{t(passwordFeedback.error)}</Notice></div>}
            {passwordFeedback.notice && <div className="workflow-span"><Notice tone="success">{t(passwordFeedback.notice)}</Notice></div>}
            <div className="workflow-span">
              <Button type="submit" disabled={passwordFeedback.busy}>{t(isAdmin ? 'Обновить данные для входа' : 'Сменить пароль')}</Button>
            </div>
          </form>
        </section>
        {!user.mustChangePassword && !isAdmin && <nav className="workflow-actions" aria-label={t('Сервисы аккаунта')}>
          <Link className="button button-secondary" to="/my-listings">{t('Мои объявления')}</Link>
          <Link className="button button-secondary" to="/chats">{t('Сообщения')}</Link>
        </nav>}
      </div>
    </div>
  );
}
