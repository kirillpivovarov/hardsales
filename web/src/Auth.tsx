import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, isStaff, type User } from './api';
import { useI18n } from './i18n';
import { CountrySelect } from './CountrySelect';
import { Button, Field, Notice } from './ui';
import './workflows.css';

const RegistrationCaptcha = lazy(() => import('./RegistrationCaptcha'));

interface Challenge {
  challengeId: string;
  expiresIn: number;
  email: string;
}

interface PendingChallenge extends Challenge {
  expiresAt: number;
  resendAt: number;
}

interface RegistrationDraft {
  inviteCode?: string;
  username: string;
  email: string;
  role: string;
  participantType: string;
  companyName?: string;
  city: string;
  country: string;
  telegram: string;
}

interface AccountProps {
  user: User;
  onUser: (user: User) => void;
  onboardingAvailable?: boolean;
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
  if (user.onboardingState === 'REQUIRED') return '/onboarding';
  return returnPath(new URLSearchParams(search)) ?? (isStaff(user) ? '/admin' : '/catalog');
}

export function AuthPage({
  mode,
  onUser,
  registrationMode = 'OPEN',
}: {
  mode: 'login' | 'register';
  onUser: (user: User) => void;
  registrationMode?: 'OPEN' | 'INVITE';
}) {
  return <AuthForm key={mode} mode={mode} onUser={onUser} registrationMode={registrationMode} />;
}

function AuthForm({
  mode,
  onUser,
  registrationMode,
}: {
  mode: 'login' | 'register';
  onUser: (user: User) => void;
  registrationMode: 'OPEN' | 'INVITE';
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
  const [draft, setDraft] = useState<RegistrationDraft>();
  const [captchaToken, setCaptchaToken] = useState<string>();
  const [captchaAttempt, setCaptchaAttempt] = useState(0);
  const isRegistering = mode === 'register';
  const invitationFromLink = search.get('invite');
  const requiresInvite = registrationMode === 'INVITE';

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
    if (busy || (isRegistering && !challenge && !captchaToken)) return;
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
      if (isRegistering) {
        const inviteCode = valueOf(form, 'inviteCode');
        const fields: RegistrationDraft = {
          ...(inviteCode && { inviteCode }),
          username: valueOf(form, 'username'),
          email: valueOf(form, 'email'),
          role: valueOf(form, 'role'),
          participantType,
          ...(participantType === 'COMPANY' && { companyName: valueOf(form, 'companyName') }),
          country: valueOf(form, 'country'),
          city: valueOf(form, 'city'),
          telegram: valueOf(form, 'telegram'),
        };
        const result = await api<Challenge>('/auth/register', {
          method: 'POST',
          body: { ...fields, password: passwordOf(form), captchaToken },
        });
        setDraft(fields);
        storeChallenge(result);
        return;
      }
      const result = await api<Challenge | { user: User }>('/auth/login', {
        method: 'POST',
        body: { login: valueOf(form, 'login'), password: passwordOf(form) },
      });
      if ('challengeId' in result) storeChallenge(result);
      else finish(result.user);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось завершить действие. Попробуйте ещё раз.');
    } finally {
      if (isRegistering && !challenge) {
        setCaptchaToken(undefined);
        setCaptchaAttempt(attempt => attempt + 1);
      }
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
      setNotice(isRegistering ? 'Запрос на повторную отправку принят.' : 'Новый код отправлен на почту.');
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
          {challenge && <p>{t(isRegistering
            ? 'Если на {email} пришло письмо, введите шестизначный код. Проверьте папку «Спам».'
            : 'Введите шестизначный код, отправленный на {email}.', { email: challenge.email })}</p>}
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
              {(requiresInvite || invitationFromLink) && (
                <div className="workflow-span">
                  <Field label={t('Код приглашения')} hint={t('Код выдаёт модератор площадки. Формат: XXXX-XXXX')}>
                    <input name="inviteCode" autoComplete="off" autoCapitalize="characters" inputMode="text"
                      spellCheck={false} defaultValue={draft?.inviteCode ?? invitationFromLink ?? ''}
                      minLength={4} maxLength={20} required={requiresInvite} />
                  </Field>
                </div>
              )}
              <Field label={t('Роль')}>
                <select name="role" defaultValue={draft?.role ?? 'BUYER'}>
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
                    <input name="companyName" autoComplete="organization" defaultValue={draft?.companyName} minLength={2} maxLength={120} required />
                  </Field>
                </div>
              )}
              <Field label={t('Логин')} hint={t('Введите от 3 до 32 латинских букв, цифр, точек, дефисов или подчёркиваний.')}>
                <input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} defaultValue={draft?.username} pattern={usernameRules} minLength={3} maxLength={32} required />
              </Field>
              <Field label={t('Электронная почта')}>
                <input name="email" type="email" autoComplete="email" defaultValue={draft?.email} maxLength={254} required />
              </Field>
              <CountrySelect label={t('Страна')} name="country" autoComplete="country" defaultValue={draft?.country ?? 'RU'} required />
              <Field label={t('Город')}>
                <input name="city" autoComplete="address-level2" defaultValue={draft?.city} minLength={2} maxLength={80} required />
              </Field>
              <Field label={t('Имя пользователя в Telegram')} hint={t('Укажите свой контакт. Он откроется собеседнику только по взаимному согласию.')}>
                <input name="telegram" placeholder="@username" autoCapitalize="none" spellCheck={false} defaultValue={draft?.telegram} pattern={telegramRules} minLength={5} maxLength={33} required />
              </Field>
              <Field label={t('Пароль')} hint={t('Не менее 12 символов.')}>
                <input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required />
              </Field>
              <div className="workflow-span">
                <Suspense fallback={<p role="status">{t('Загружаем проверку CAPTCHA…')}</p>}>
                  <RegistrationCaptcha key={captchaAttempt} onToken={setCaptchaToken} />
                </Suspense>
              </div>
              {error && <div className="workflow-span"><Notice tone="error">{t(error)}</Notice></div>}
              <div className="workflow-span"><Button type="submit" disabled={busy || !captchaToken}>{t('Получить код')}</Button></div>
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
            <>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => {
                setChallenge(undefined);
                setError('');
                setNotice('');
              }}>{t('Вернуться к форме')}</Button>
              {isRegistering && <p>{t('Уже есть аккаунт?')} <Link to={`/login${nextQuery}`}>{t('Войти')}</Link></p>}
            </>
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

export function AccountPage({ user, onUser, onboardingAvailable = false }: AccountProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [profileFeedback, setProfileFeedback] = useState({ error: '', notice: '', busy: false });
  const [passwordFeedback, setPasswordFeedback] = useState({ error: '', notice: '', busy: false });
  const isAdmin = user.role === 'ADMIN';
  const staff = isStaff(user);

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
          notifyEmail: form.get('notifyEmail') === 'on',
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
      if (user.mustChangePassword && staff) navigate('/admin', { replace: true });
    } catch (cause) {
      setPasswordFeedback({ busy: false, error: cause instanceof Error ? cause.message : 'Не удалось сменить пароль.', notice: '' });
    }
  }

  return (
    <div className="workflow-page container">
      <div className="workflow-intro"><h1>{t('Настройки аккаунта')}</h1></div>
      <div className="workflow-stack workflow-account">
        {user.mustChangePassword && <Notice>{t('Смените временный пароль, чтобы открыть панель управления.')}</Notice>}
        {!user.mustChangePassword && !staff && (
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
              <Field label={t('Имя пользователя в Telegram')} hint={t('Контакт открывается в чате по взаимному согласию. После смены имени пользователя нужно обменяться контактами заново.')}>
                <input name="telegram" defaultValue={user.telegram ?? ''} pattern={telegramRules} minLength={5} maxLength={33} required />
              </Field>
              <label className="workflow-span workflow-checkbox">
                <input type="checkbox" name="notifyEmail" defaultChecked={user.notifyEmail ?? true} />
                {t('Получать уведомления по электронной почте')}
              </label>
              {profileFeedback.error && <div className="workflow-span"><Notice tone="error">{t(profileFeedback.error)}</Notice></div>}
              {profileFeedback.notice && <div className="workflow-span"><Notice tone="success">{t(profileFeedback.notice)}</Notice></div>}
              <div className="workflow-span"><Button type="submit" disabled={profileFeedback.busy}>{t('Сохранить профиль')}</Button></div>
            </form>
          </section>
        )}
        {!staff && (onboardingAvailable || user.onboardingState === 'REQUIRED') && (
          <section className="panel workflow-section" aria-labelledby="account-onboarding-title">
            <h2 id="account-onboarding-title">{t('Анкета входа')}</h2>
            <Link className="button button-secondary" to="/onboarding">
              {t(user.onboardingState === 'DONE' ? 'Открыть анкету' : 'Заполнить анкету')}
            </Link>
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
        {!user.mustChangePassword && !staff && <nav className="workflow-actions" aria-label={t('Сервисы аккаунта')}>
          <Link className="button button-secondary" to="/my-listings">{t('Мои объявления')}</Link>
          <Link className="button button-secondary" to="/chats">{t('Сообщения')}</Link>
        </nav>}
      </div>
    </div>
  );
}
