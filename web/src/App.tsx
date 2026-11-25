import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { api, isStaff } from './api';
import type { User } from './api';
import { AccountActuality, ActualityActionForm } from './ActualityWidgets';
import { ActionPage, ExchangeProvider, NotificationLink, NotificationsPage, useExchange } from './Exchange';
import { OnboardingPage, RulesAcceptance, RulesBanner } from './Onboarding';
import { MatchesPage } from './Matches';
import { DisclosureDetailPage, DisclosuresPage } from './Disclosures';
import { PrincipalAnswerPage, RepresentationAccount, RepresentationAction } from './Representation';
import { PaymentsPage, TrustAccount } from './Trust';
import { DealsPage } from './Deals';
import { AdminPage } from './AdminPage';
import { AccountPage, AuthPage, authDestination } from './Auth';
import { CatalogPage } from './Catalog';
import { ChatPage } from './ChatPage';
import { ListingDetail } from './Detail';
import { useI18n } from './i18n';
import { ListingEditorPage } from './ListingForm';
import { MyListingsPage } from './MyListings';
import { Button, Icon, Notice, Spinner } from './ui';
import './contextual.css';
import './exchange.css';

interface Content {
  key: string;
  active: boolean;
  translations: Record<string, { title: string; body: string }>;
}

function Brand() {
  return <Link to="/" className="brand" aria-label="hwforai"><img src="/mark.svg" width="34" height="34" alt="" />
    <span>hwfor<span>ai</span></span></Link>;
}

function MatchesLink() {
  const { t } = useI18n();
  const location = useLocation();
  const [count, setCount] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ total: number }>('/matches/counts', { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setCount(data.total);
    }).catch(() => {});
    return () => controller.abort();
  }, [location.key]);
  return <Link to="/matches">{t('Совпадения')}{count > 0 && <span className="exchange-count">{count}</span>}</Link>;
}

function Header({ user, onLogout, notificationRevision }: {
  user: User | null;
  onLogout: () => Promise<void>;
  notificationRevision: number;
}) {
  const { t, locales, locale, setLocale } = useI18n();
  const [open, setOpen] = useState(false);
  const [sessionError, setSessionError] = useState('');
  const location = useLocation();
  const { features } = useExchange();
  const staff = isStaff(user);
  const member = user && !staff;
  useEffect(() => { setOpen(false); }, [location.pathname]);
  const languageSelect = locales.length > 1 && <select aria-label={t('Язык интерфейса')} className="locale-select" value={locale} onChange={event => setLocale(event.target.value)}>
    {locales.map(item => <option key={item.code} value={item.code}>{item.name}</option>)}
  </select>;
  return <header className="site-header">
    <div className="container header-inner">
      <Brand />
      <nav className={'site-nav' + (open ? ' nav-open' : '')} id="site-nav" aria-label={t('Основная навигация')}>
        <NavLink to="/catalog" className={({isActive}) => isActive && new URLSearchParams(location.search).get('kind') !== 'BUY' ? 'active' : ''}>{t('Каталог')}</NavLink>
        {member ? <NavLink to="/my-listings">{t('Мои объявления')}</NavLink> :
          <Link to="/catalog?kind=BUY" className={location.pathname === '/catalog' && new URLSearchParams(location.search).get('kind') === 'BUY' ? 'active' : ''}>{t('Заявки')}</Link>}
        <NavLink to="/info/about">{t('Как это работает')}</NavLink>
        {member && <NavLink to="/chats"><Icon name="messages-square" size={17} /> {t('Чаты')}</NavLink>}
        {staff && <NavLink to="/admin">{t(user?.role === 'ADMIN' ? 'Администрирование' : 'Модерация')}</NavLink>}
        {languageSelect}
      </nav>
      <div className="header-actions">
        {user ? <>
          {member && <Link className="button button-primary publish-link" aria-label={t('Разместить объявление')} to="/listings/new"><Icon name="plus" size={17} /> <span>{t('Разместить')}</span></Link>}
          {!user.mustChangePassword && Object.entries(features).some(([key, value]) => key.startsWith('feature_') && value === true) &&
            <NotificationLink key={user.id} revision={notificationRevision} />}
          <details className="account-menu" key={location.key}>
            <summary className="button button-secondary" aria-label={t('{name}, меню профиля', { name: user.displayName || user.username })}><Icon name="user-round" size={17} /><span>{user.displayName || user.username}</span><Icon name="chevron-down" size={14} className="account-chevron" /></summary>
            <div className="menu-popover">
              <Link to="/account">{t('Профиль')}</Link>
              {member && features.feature_matching === true && <MatchesLink />}
              {member && features.feature_disclosure_journal === true && <Link to="/disclosures">{t('Раскрытия')}</Link>}
              {member && features.feature_trust_rating === true && <Link to="/deals">{t('Сделки')}</Link>}
              {member && <Link to="/my-listings">{t('Мои объявления')}</Link>}
              <button type="button" onClick={() => { void onLogout().catch((error: Error) => setSessionError(error.message)); }}>{t('Выйти')}</button>
              {sessionError && <span role="alert">{t(sessionError)}</span>}
            </div>
          </details>
        </> : <>
          <Link to="/login" className="button button-ghost header-login" aria-label={t('Войти')}>
            <Icon name="user-round" size={17} /><span>{t('Войти')}</span>
          </Link>
          <Link to="/register" className="button button-primary header-register">{t('Регистрация')}</Link>
        </>}
        <Button className="mobile-menu" variant="secondary" aria-label={t(open ? 'Закрыть меню' : 'Открыть меню')} aria-expanded={open} aria-controls="site-nav" onClick={() => setOpen(!open)}><Icon name={open ? 'x' : 'menu'} /></Button>
      </div>
    </div>
  </header>;
}

function Footer() {
  const { t } = useI18n();
  return <footer className="site-footer"><div className="container footer-inner">
    <Brand /><p>{t('Площадка для закупки и продажи серверного оборудования')}</p>
    <nav aria-label={t('Документы')}>
      <Link to="/info/rules">{t('Правила')}</Link><Link to="/info/privacy">{t('Конфиденциальность')}</Link>
    </nav>
  </div></footer>;
}

const fallbackContent: Record<string, { title: string; body: string }> = {
  about: { title: 'Как работает hwforai', body: 'hwforai помогает покупателям и продавцам серверного оборудования находить друг друга.\n\nПодтвердите электронную почту, чтобы смотреть объявления. Укажите модель, сроки и коммерческие условия в предложении или заявке.\n\nОбсудите детали в чате на площадке. Контакты Telegram открываются только по взаимному согласию.' },
  rules: { title: 'Правила площадки', body: 'Указывайте точные сведения об оборудовании, состоянии, цене и условиях поставки.\n\nПервый контакт происходит в чате. Для продолжения в Telegram используйте контакт, открытый через профиль. Жалоба на переписку с другим аккаунтом Telegram не принимается.\n\nУчастники проверяют контрагента, оборудование и применимые требования при заключении сделки.' },
  privacy: { title: 'Конфиденциальность', body: 'Почта нужна для подтверждения аккаунта и входа. Она не отображается в каталоге.\n\nУчастники видят ник, город, страну и репутацию автора объявления. После взаимного согласия имена Telegram доступны в диалогах между этими собеседниками. После смены имени требуется новое согласие. Площадка хранит историю изменений привязанного Telegram. Собеседникам доступны только имена, которыми обе стороны согласились обменяться в текущей версии.' },
};

function InfoPage({ user, onUser }: { user: User | null; onUser: (user: User) => void }) {
  const { key = 'about' } = useParams();
  const { t, locale } = useI18n();
  const [contentState, setContentState] = useState<{ path: string; items?: Content[]; failed?: boolean }>();
  const staff = isStaff(user) && !user?.mustChangePassword;
  const path = staff ? '/admin/content' : '/content';
  useEffect(() => {
    const controller = new AbortController();
    void api<Content[]>(path, { signal: controller.signal }).then(items => {
      if (!controller.signal.aborted) setContentState({ path, items });
    }).catch(() => {
      if (!controller.signal.aborted) setContentState({ path, failed: true });
    });
    return () => controller.abort();
  }, [path]);
  const { items, failed } = contentState?.path === path ? contentState : {};
  if (!items && !failed) return <div className="container content-page"><Spinner /></div>;
  const record = items?.find(item => item.key === key && (item.active || staff));
  const fallback = failed && Object.hasOwn(fallbackContent, key) ? fallbackContent[key] : undefined;
  const content = record?.translations[locale] ?? record?.translations.ru ?? fallback;
  return <div className="container content-page">
    {record && staff && !record.active && <p className="contextual-status">{t('Страница скрыта')}</p>}
    {!content ? <Notice>{t('Страница не найдена.')}</Notice> : <article className="panel detail-panel"><h1>{t(content.title)}</h1>
      {content.body.split(/\n\s*\n/).map((paragraph,i) => <p key={i} className="preserve-text">{t(paragraph)}</p>)}</article>}
    {key === 'rules' && content && <RulesAcceptance user={user} onUser={onUser} />}
    <Link to="/catalog" className="back-link"><Icon name="chevron-left" size={16} />{t('К каталогу')}</Link>
  </div>;
}

export function App() {
  return <ExchangeProvider><AppRoutes /></ExchangeProvider>;
}

function AppRoutes() {
  const { features } = useExchange();
  const { t } = useI18n();
  const location = useLocation();
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [notificationRevision, setNotificationRevision] = useState(0);
  const [registrationMode, setRegistrationMode] = useState<'INVITE' | 'OPEN'>('OPEN');

  useEffect(() => {
    const controller = new AbortController();
    void api<{ user: User; registrationMode?: 'INVITE' | 'OPEN' }>('/auth/me', { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) { setUser(data.user); setRegistrationMode(data.registrationMode ?? 'OPEN'); }
    }).catch((err: Error) => {
      if (err.name !== 'AbortError') setUser(null);
    }).finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [location.pathname, location.hash]);

  function secure(child: ReactNode, role?: 'MEMBER' | 'STAFF', requiresOnboarding = false) {
    if (checking) return <div className="container workflow-page"><Spinner /></div>;
    if (!user?.emailVerified) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
    if (user.mustChangePassword && location.pathname !== '/account') return <Navigate to="/account" replace />;
    if (requiresOnboarding && user.onboardingState === 'REQUIRED') return <Navigate to="/onboarding" replace />;
    if ((role === 'MEMBER' && isStaff(user)) || (role === 'STAFF' && !isStaff(user))) return <Navigate to="/catalog" replace />;
    return child;
  }

  const logout = async () => { await api('/auth/logout', { method: 'POST' }); setUser(null); };
  return <>
    <a href="#main" className="skip-link">{t('Перейти к содержимому')}</a>
    <Header user={user} onLogout={logout} notificationRevision={notificationRevision} />
    <main id="main" tabIndex={-1}>
      {location.pathname !== '/info/rules' && <div className="container"><RulesBanner user={user} /></div>}
      <Routes>
        <Route path="/" element={<CatalogPage user={user} home />} />
        <Route path="/catalog" element={<CatalogPage user={user} />} />
        <Route path="/login" element={checking ? <Spinner /> : user ? <Navigate to={authDestination(user, location.search)} replace /> : <AuthPage mode="login" onUser={setUser} />} />
        <Route path="/register" element={checking ? <Spinner /> : user ? <Navigate to={authDestination(user, location.search)} replace /> : <AuthPage mode="register" onUser={setUser}
          registrationMode={Object.hasOwn(features, 'feature_invites')
            ? features.feature_invites && features.registration_mode === 'INVITE' ? 'INVITE' : 'OPEN' : registrationMode} />} />
        <Route path="/account" element={secure(user && <AccountPage user={user} onUser={setUser} onboardingAvailable={features.feature_invites === true}>
          {!isStaff(user) && features.feature_actuality === true && <AccountActuality />}
          {!isStaff(user) && features.feature_representation === true && <RepresentationAccount user={user} />}
          {!isStaff(user) && features.feature_trust_rating === true && <TrustAccount />}
        </AccountPage>)} />
        <Route path="/onboarding" element={secure(user && <OnboardingPage user={user} onUser={setUser} />, 'MEMBER')} />
        <Route path="/notifications" element={secure(<NotificationsPage onRead={() => setNotificationRevision(value => value + 1)} />)} />
        <Route path="/matches" element={secure(<MatchesPage />, 'MEMBER')} />
        <Route path="/matches/:id" element={secure(<MatchesPage />, 'MEMBER')} />
        <Route path="/disclosures" element={secure(<DisclosuresPage />, 'MEMBER')} />
        <Route path="/disclosures/:id" element={secure(<DisclosureDetailPage />, 'MEMBER')} />
        <Route path="/deals" element={secure(<DealsPage />, 'MEMBER')} />
        <Route path="/deals/:id" element={secure(<DealsPage />, 'MEMBER')} />
        <Route path="/principal-answers" element={secure(<PrincipalAnswerPage />, 'MEMBER')} />
        <Route path="/payments" element={<PaymentsPage />} />
        <Route path="/info/payments" element={<PaymentsPage />} />
        <Route path="/a/:token" element={<ActionPage renderForm={(action, submit, pending) => {
          switch (action.purpose) {
            case 'principal.confirm':
            case 'company_email.confirm':
              return <RepresentationAction action={action} onSubmit={input => void submit(input)} pending={pending} />;
            case 'listing.actuality':
              return <ActualityActionForm fields={action.fields ?? {}} onSubmit={submit} />;
            case 'listing.actuality-all':
            case 'listing.extend':
              return <Button disabled={pending} onClick={() => void submit({ answer: 'ACTUAL' })}>{t('Подтвердить')}</Button>;
            default:
              return <Notice tone="error">{t('Действие недоступно.')}</Notice>;
          }
        }} />} />
        <Route path="/my-listings" element={secure(<MyListingsPage />, 'MEMBER')} />
        <Route path="/listings/new" element={secure(user && <ListingEditorPage user={user} />, 'MEMBER', true)} />
        <Route path="/listings/:id/edit" element={secure(user && <ListingEditorPage user={user} />, 'MEMBER', true)} />
        <Route path="/listings/:id" element={checking ? <Spinner /> : <ListingDetail user={user} />} />
        <Route path="/chats" element={secure(user && <ChatPage user={user} />, 'MEMBER', true)} />
        <Route path="/chats/:id" element={secure(user && <ChatPage user={user} />, 'MEMBER', true)} />
        <Route path="/admin" element={secure(user && <AdminPage user={user} />, 'STAFF')} />
        <Route path="/info/:key" element={<InfoPage user={user} onUser={setUser} />} />
        <Route path="*" element={<div className="container workflow-page"><h1>{t('Страница не найдена')}</h1><Link to="/catalog" className="button button-primary">{t('К каталогу')}</Link></div>} />
      </Routes>
    </main>
    <Footer />
  </>;
}
