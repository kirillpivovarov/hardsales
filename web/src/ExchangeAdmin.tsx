import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { User } from './api';
import { AdminDisclosures } from './Disclosures';
import { AdminDisputes } from './Disputes';
import { ExchangeJobRuns, ExchangeSettings, useExchange } from './Exchange';
import { InvitesPanel, UserOnboardingAnswers } from './InviteAdmin';
import { FxRatesPanel, MatchAdminPanel } from './Matches';
import { CatalogModelsPage } from './Models';
import { AdminPrincipals } from './Representation';
import { PriceCorridorsAdmin, VerificationAdmin } from './Verification';
import { ContactBlocksAdmin } from './ContactBlocks';
import { DataRequestsPanel, UserConsents } from './Consent';
import { AdminLotsPanel } from './LotGroups';
import { PilotMetrics } from './PilotMetrics';
import { TelegramAdmin } from './Telegram';
import { useI18n } from './i18n';
import { InvitationReadiness, MailQueuePanel, PilotOperations } from './PilotOperations';

const sections = {
  models: 'Модели оборудования',
  disclosures: 'Журнал раскрытий',
  disputes: 'Споры',
  principals: 'Принципалы',
  matching: 'Совпадения',
  verification: 'Проверки и сделки',
  jobs: 'Фоновые задачи',
  mail: 'Письма',
  invites: 'Приглашения',
  settings: 'Настройки биржи',
  rates: 'Курсы валют',
  corridors: 'Ценовые ориентиры',
  pilot: 'Показатели пробы',
  lots: 'Дубли лотов',
  'contact-blocks': 'Попытки обхода',
  telegram: 'Telegram',
  'data-requests': 'Запросы по данным',
  onboarding: 'Анкета участника',
  'user-consents': 'История согласий',
} as const;

type Section = keyof typeof sections;

export default function ExchangeAdministration({ user }: { user: User }) {
  const { t } = useI18n();
  const { features } = useExchange();
  const [query] = useSearchParams();
  const [settingsRevision, setSettingsRevision] = useState(0);
  const administrator = user.role === 'ADMIN';
  const requested = query.get('part');
  const participant = query.get('userId');
  const navigation: Section[] = ['models', 'disclosures', 'principals', 'matching', 'verification', 'jobs', 'mail', 'pilot', 'lots', 'invites'];
  if (features.feature_disputes === true) navigation.push('disputes');
  if (administrator) navigation.push('settings', 'rates', 'corridors', 'contact-blocks', 'telegram', 'data-requests');
  const section = participant && (requested === 'onboarding' || administrator && requested === 'user-consents') ? requested :
    navigation.find(key => key === requested) ?? navigation[0];

  return <div className="workflow-stack">
    <h2>{t('Закрытая биржа')}</h2>
    <nav className="exchange-admin-nav" aria-label={t('Управление биржей')}>
      {navigation.map(key => <Link key={key} className={`button button-${section === key ? 'secondary' : 'ghost'}`}
        aria-current={section === key ? 'page' : undefined} to={`/admin?section=exchange&part=${key}`}>{t(sections[key])}</Link>)}
    </nav>
    {section === 'models' && <CatalogModelsPage user={user} />}
    {section === 'disclosures' && <AdminDisclosures />}
    {section === 'disputes' && <AdminDisputes />}
    {section === 'principals' && <AdminPrincipals />}
    {section === 'matching' && <MatchAdminPanel />}
    {section === 'verification' && <VerificationAdmin isAdmin={administrator} />}
    {section === 'jobs' && <ExchangeJobRuns administrator={administrator} />}
    {section === 'mail' && <MailQueuePanel />}
    {section === 'invites' && <>{administrator && <InvitationReadiness />}<InvitesPanel administrator={administrator} /></>}
    {section === 'settings' && <>
      <PilotOperations onApplied={() => setSettingsRevision(value => value + 1)} />
      <ExchangeSettings key={settingsRevision} />
    </>}
    {section === 'rates' && <FxRatesPanel />}
    {section === 'corridors' && <PriceCorridorsAdmin />}
    {section === 'pilot' && <PilotMetrics isAdmin={administrator} />}
    {section === 'lots' && <AdminLotsPanel />}
    {section === 'contact-blocks' && <ContactBlocksAdmin />}
    {section === 'telegram' && <TelegramAdmin />}
    {section === 'data-requests' && <DataRequestsPanel />}
    {section === 'user-consents' && participant && <>
      <Link to="/admin?section=users" className="text-link">{t('К списку участников')}</Link>
      <UserConsents userId={participant} />
    </>}
    {section === 'onboarding' && participant && <>
      <Link to="/admin?section=users" className="text-link">{t('К списку участников')}</Link>
      <UserOnboardingAnswers userId={participant} />
    </>}
  </div>;
}
