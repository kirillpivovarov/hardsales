import { Link, useSearchParams } from 'react-router-dom';
import type { User } from './api';
import { AdminDisclosures } from './Disclosures';
import { ExchangeJobRuns, ExchangeSettings } from './Exchange';
import { InvitesPanel, UserOnboardingAnswers } from './InviteAdmin';
import { FxRatesPanel, MatchAdminPanel } from './Matches';
import { CatalogModelsPage } from './Models';
import { AdminPrincipals } from './Representation';
import { PriceCorridorsAdmin, VerificationAdmin } from './Verification';
import { useI18n } from './i18n';

const sections = {
  models: 'Модели оборудования',
  disclosures: 'Журнал раскрытий',
  principals: 'Принципалы',
  matching: 'Совпадения',
  verification: 'Проверки и сделки',
  jobs: 'Фоновые задачи',
  invites: 'Приглашения',
  settings: 'Настройки биржи',
  rates: 'Курсы валют',
  corridors: 'Ценовые ориентиры',
  onboarding: 'Анкета участника',
} as const;

type Section = keyof typeof sections;

export default function ExchangeAdministration({ user }: { user: User }) {
  const { t } = useI18n();
  const [query] = useSearchParams();
  const administrator = user.role === 'ADMIN';
  const requested = query.get('part');
  const participant = query.get('userId');
  const navigation: Section[] = ['models', 'disclosures', 'principals'];
  if (administrator) navigation.push('matching');
  navigation.push('verification', 'jobs');
  if (administrator) navigation.push('invites', 'settings', 'rates', 'corridors');
  const section = administrator && requested === 'onboarding' && participant ? 'onboarding' :
    navigation.find(key => key === requested) ?? navigation[0];

  return <div className="workflow-stack">
    <h2>{t('Закрытая биржа')}</h2>
    <nav className="exchange-admin-nav" aria-label={t('Управление биржей')}>
      {navigation.map(key => <Link key={key} className={`button button-${section === key ? 'secondary' : 'ghost'}`}
        aria-current={section === key ? 'page' : undefined} to={`/admin?section=exchange&part=${key}`}>{t(sections[key])}</Link>)}
    </nav>
    {section === 'models' && <CatalogModelsPage user={user} />}
    {section === 'disclosures' && <AdminDisclosures />}
    {section === 'principals' && <AdminPrincipals />}
    {section === 'matching' && <MatchAdminPanel />}
    {section === 'verification' && <VerificationAdmin isAdmin={administrator} />}
    {section === 'jobs' && <ExchangeJobRuns />}
    {section === 'invites' && <InvitesPanel />}
    {section === 'settings' && <ExchangeSettings />}
    {section === 'rates' && <FxRatesPanel />}
    {section === 'corridors' && <PriceCorridorsAdmin />}
    {section === 'onboarding' && participant && <>
      <Link to="/admin?section=users" className="text-link">{t('К списку участников')}</Link>
      <UserOnboardingAnswers userId={participant} />
    </>}
  </div>;
}
