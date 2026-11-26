import { Injectable, OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService, type Queryable } from '../database/database.service';
import { ExchangeJobs, type ExchangeClock } from '../exchange/jobs';
import { ExchangeNotifications } from '../exchange/notifications';
import { PlatformSettings } from '../exchange/platform-settings';
import { str } from '../market/market.inputs';
import { exclusions, readLiveCount, readParticipants, readPilotDays, readVisibility, type PilotDay } from './pilot.data';
import { pilotPeriod, type PilotPeriod, type PilotTargets, type StopRule } from './pilot.settings';

const yesterday = (day: string) => new Date(Date.parse(day) - 86_400_000).toISOString().slice(0, 10);
const sum = (days: PilotDay[], key: keyof PilotDay) => days.reduce((total, day) => total + Number(day[key]), 0);

function stopRuleResult(rule: StopRule, liveMatches: number, today: string) {
  const dateReached = today >= rule.date;
  const state = liveMatches >= rule.minLiveMatches ? 'PASSED' : dateReached ? 'TRIGGERED' : 'WARNING';
  return { ...rule, liveMatches, state, dateReached };
}

function summarize(days: PilotDay[], today: string) {
  const elapsed = days.filter(day => day.date <= today);
  const matches = sum(days, 'matches');
  const full = sum(days, 'matchesFull');
  const operator = sum(days, 'matchesOperator');
  const disclosures = sum(days, 'disclosures');
  const asks = sum(days, 'asks');
  return {
    matches: { total: matches, full, partial: matches - full, system: matches - operator, operator },
    liveMatches: sum(days, 'liveMatches'), disclosures,
    disclosuresToAgreedShare: disclosures ? sum(days, 'agreementsFromDisclosures') / disclosures : null,
    dealsAgreed: sum(days, 'dealsAgreed'), dealsExecuted: sum(days, 'dealsExecuted'),
    onTimeShare: asks ? sum(days, 'onTime') / asks : null,
    confirmedPerDay: elapsed.length ? sum(elapsed, 'confirmed') / elapsed.length : null,
  };
}

@Injectable()
export class PilotService implements OnModuleInit {
  private readonly startedAt = new Date();
  private readonly cache = new Map<string, { expires: number; data: Awaited<ReturnType<PilotService['calculate']>> }>();

  constructor(private readonly db: DatabaseService, private readonly settings: PlatformSettings,
    private readonly jobs: ExchangeJobs, private readonly notifications: ExchangeNotifications) {}

  onModuleInit(): void {
    this.jobs.register({
      name: 'pilot.snapshot', lock: 22, slot: clock => yesterday(clock.day),
      run: (client, clock) => this.snapshot(client, clock),
    });
    this.jobs.register({
      name: 'pilot.stop-rule', lock: 22,
      run: (client, clock) => this.notifyStopRule(client, clock),
    });
  }

  async metrics(query: Record<string, unknown>) {
    return this.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const clock = await this.jobs.clock(client);
      const defaults = await this.settings.get<PilotPeriod>('pilot_period', client);
      const rule = await this.settings.get<StopRule>('stop_rule', client);
      const targets = await this.settings.get<PilotTargets>('pilot_targets', client);
      const excluded = await this.excluded(client);
      const period = pilotPeriod(query.from === undefined ? defaults.from : query.from, query.to === undefined ? defaults.to : query.to);
      const key = JSON.stringify([period, defaults, rule, targets, excluded, clock.day, clock.timezone]);
      const cached = this.cache.get(key);
      if (cached && cached.expires > Date.now()) return cached.data;
      const data = await this.calculate(client, clock, period, defaults, rule, targets, excluded);
      this.cache.delete(key);
      if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { expires: Date.now() + 60_000, data });
      return data;
    });
  }

  async accounts(search: unknown) {
    const selected = await this.settings.get<string[]>('pilot_excluded_users');
    const q = search === undefined ? null : str(search, 'Ник участника', 1, 100);
    const { rows: items } = await this.db.query<{ id: string; nickname: string }>(`
      SELECT id,display_name AS nickname FROM users WHERE role IN ('BUYER','SELLER')
        AND CASE WHEN $2::text IS NULL THEN id = ANY($1::uuid[])
                 ELSE strpos(lower(display_name),lower($2)) > 0 END
      ORDER BY lower(display_name),id LIMIT $3
    `, [selected, q, q === null ? 1000 : 20]);
    return { items };
  }

  private async excluded(client: Queryable) {
    return exclusions(await this.settings.get<string[]>('pilot_excluded_users', client));
  }

  private async calculate(client: Queryable, clock: ExchangeClock, period: PilotPeriod,
    defaults: PilotPeriod, rule: StopRule, targets: PilotTargets, excluded: string[]) {
    const days = await readPilotDays(client, period, clock.timezone, excluded);
    const visibility = await readVisibility(client, excluded);
    const current = days.find(day => day.date === clock.day);
    if (current) {
      current.visibleSell = visibility.visibleSell;
      current.visibleBuy = visibility.visibleBuy;
      current.hidden = visibility.hidden;
      current.snapshot = 'LIVE';
    }
    const participants = await readParticipants(client, period, clock.timezone, excluded);
    const live = await readLiveCount(client, { from: defaults.from, to: rule.date }, clock.timezone, excluded);
    return {
      ...period, timezone: clock.timezone,
      totals: { ...summarize(days, clock.day), participants: { ...visibility.participants, ...participants } },
      targets, stopRule: stopRuleResult(rule, live, clock.day), days,
    };
  }

  private async snapshot(client: PoolClient, clock: ExchangeClock) {
    const date = yesterday(clock.day);
    const visible = await readVisibility(client, await this.excluded(client));
    const result = await client.query(`
      INSERT INTO pilot_daily_snapshots (local_date,taken_at,late,listings_visible_sell,listings_visible_buy,listings_hidden,participants_by_level)
      SELECT $1,$2,$3::timestamptz >= midnight OR $2::timestamptz - midnight > interval '2 minutes',
        $6,$7,$8,$9
      FROM (SELECT $4::date::timestamp AT TIME ZONE $5::text AS midnight) local
      ON CONFLICT (local_date) DO NOTHING
    `, [date, clock.now, this.startedAt, clock.day, clock.timezone, visible.visibleSell, visible.visibleBuy,
      visible.hidden, JSON.stringify(visible.participants)]);
    return { taken: result.rowCount === 1 };
  }

  private async notifyStopRule(client: PoolClient, clock: ExchangeClock) {
    const rule = await this.settings.get<StopRule>('stop_rule', client);
    if (clock.day < rule.date) return;
    const dedupeKey = `pilot.stop-rule:${rule.date}`;
    const { rows: [admin] } = await client.query<{ id: string }>(`
      SELECT u.id FROM users u WHERE u.role='ADMIN' AND u.status='ACTIVE' AND u.email_verified_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id=u.id AND n.dedupe_key=$1)
    `, [dedupeKey]);
    if (!admin) return;
    const period = await this.settings.get<PilotPeriod>('pilot_period', client);
    const live = await readLiveCount(client, { from: period.from, to: rule.date }, clock.timezone, await this.excluded(client));
    const date = rule.date.split('-').reverse().join('.');
    await this.notifications.notify(client, admin.id, {
      kind: 'pilot.stop_rule', title: 'Дата стоп-правила пробы',
      body: `Дата стоп-правила ${date}: живых совпадений ${live} при пороге ${rule.minLiveMatches}.`,
      actions: [{ label: 'Показатели пробы', href: '/admin?section=exchange&part=pilot' }],
      dedupeKey, channels: ['EMAIL'],
    });
  }
}

export function pilotCsv(days: PilotDay[]): string {
  const header = 'Дата;Подтверждено объявлений;Предложений в выдаче;Заявок в выдаче;Скрыто;Совпадений;Совпадений оператора;Живых совпадений;Раскрытий;Договорились;Вопросов;Ответов в срок;Доля в срок';
  const rows = days.map(day => [day.date, day.confirmed, day.visibleSell, day.visibleBuy, day.hidden,
    day.matches, day.matchesOperator, day.liveMatches, day.disclosures, day.dealsAgreed, day.asks, day.onTime,
    day.asks ? (day.onTime / day.asks).toFixed(2).replace('.', ',') : '',
  ].join(';'));
  return '\uFEFF' + [header, ...rows, ''].join('\r\n');
}
