import { useEffect, useId, useState, type FormEvent } from 'react';
import { api } from './api';
import { useI18n } from './i18n';
import { Button, Field, Notice, Spinner } from './ui';
import './pilot.css';

type Period = { from: string; to: string };
type Rule = { date: string; minLiveMatches: number };
type Targets = {
  confirmedPerDay: number; matches: number; liveMatches: number; disclosures: number; dealsAgreed: number; onTimeShare: number;
};
type Day = {
  date: string; confirmed: number; visibleSell: number | null; visibleBuy: number | null; hidden: number | null;
  matches: number; matchesOperator: number; liveMatches: number; disclosures: number; dealsAgreed: number; asks: number; onTime: number;
  snapshot: 'LIVE' | 'SNAPSHOT' | 'LATE' | 'MISSING';
};
type Report = Period & {
  timezone: string;
  stopRule: Rule & { liveMatches: number; state: 'PASSED' | 'WARNING' | 'TRIGGERED'; dateReached: boolean };
  targets: Targets;
  totals: {
    matches: { total: number; full: number; partial: number; system: number; operator: number };
    liveMatches: number; disclosures: number; dealsAgreed: number; dealsExecuted: number;
    onTimeShare: number | null; disclosuresToAgreedShare: number | null; confirmedPerDay: number | null;
    participants: { level0: number; level1: number; level2: number; registered: number; invitesIssued: number; invitesUsed: number };
  };
  days: Day[];
};
type Account = { id: string; nickname: string };

const dateLabel = (date: string) => date.split('-').reverse().join('.');
const printNumber = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const printPercent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 1 });
const targetNames = {
  confirmedPerDay: 'Подтверждённые объявления в день', matches: 'Совпадения', liveMatches: 'Живые совпадения',
  disclosures: 'Раскрытия', dealsAgreed: 'Сделки с согласованными условиями', onTimeShare: 'Доля ответов в срок, %',
} as const;
const snapshotNames = { LIVE: 'Текущий день', SNAPSHOT: 'Снимок суток', LATE: 'Поздний снимок', MISSING: 'Снимка нет' } as const;

function Measure({ label, actual, target, note, percent = false }: {
  label: string; actual: number | null; target?: number; note: string; percent?: boolean;
}) {
  const { t } = useI18n();
  const format = percent ? printPercent : printNumber;
  const achieved = actual !== null && target !== undefined && actual >= target;
  return <article className={'panel pilot-measure' + (achieved ? ' pilot-measure-achieved' : '')}>
    <h3>{t(label)}</h3>
    <p className="pilot-measure-value">{actual === null ? t('Нет данных') : format.format(actual)}
      {target !== undefined && <span> / {format.format(target)}</span>}</p>
    <p>{note}</p>
    {target !== undefined && actual !== null && <span className="pilot-target-status">
      {t(achieved ? 'Ориентир достигнут' : 'Ориентир пока не достигнут')}
    </span>}
  </article>;
}

function VisibilityChart({ days }: { days: Day[] }) {
  const { t } = useI18n();
  const titleId = useId();
  const width = 800;
  const height = 226;
  const left = 45;
  const bottom = 190;
  const step = (width - left - 14) / days.length;
  const top = Math.max(1, ...days.flatMap(day => [day.visibleSell ?? 0, day.visibleBuy ?? 0, day.confirmed]));
  const y = (value: number) => bottom - value / top * (bottom - 16);
  const x = (index: number) => left + step * (index + .5);
  const barWidth = Math.min(22, step * .31);
  const ticks = [...new Set([0, top / 4, top / 2, top * .75, top].map(Math.round))];
  const points = days.map((day, index) => `${x(index)},${y(day.confirmed)}`).join(' ');
  return <figure className="pilot-chart">
    <figcaption id={titleId}>{t('Объявления в выдаче по дням')}</figcaption>
    <ul aria-hidden="true" className="pilot-legend">
      <li><i className="pilot-fill-seller" />{t('Предложения')}</li>
      <li><i className="pilot-fill-buyer" />{t('Заявки')}</li>
      <li><i className="pilot-line" />{t('Подтверждённые объявления')}</li>
    </ul>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId}>
      <desc>{t('Столбцы предложений и заявок, линия подтверждений. Точные значения приведены в таблице.')}</desc>
      {ticks.map(tick => <g key={tick}>
        <line x1={left} x2={width - 14} y1={y(tick)} y2={y(tick)} className="pilot-chart-grid" />
        <text x={left - 5} y={y(tick) + 4} textAnchor="end">{printNumber.format(tick)}</text>
      </g>)}
      {days.map((day, index) => <g key={day.date}>
        {day.visibleSell !== null && <rect className="pilot-fill-seller" x={x(index) - barWidth}
          y={y(day.visibleSell)} width={barWidth} height={bottom - y(day.visibleSell)} />}
        {day.visibleBuy !== null && <rect className="pilot-fill-buyer" x={x(index)}
          y={y(day.visibleBuy)} width={barWidth} height={bottom - y(day.visibleBuy)} />}
        {index % Math.ceil(days.length / 7) === 0 && <text x={x(index)} y={bottom + 18} textAnchor="middle">
          {dateLabel(day.date).slice(0, 5)}
        </text>}
      </g>)}
      <polyline className="pilot-confirmations" points={points} />
      {days.length === 1 && <circle className="pilot-fill-confirmation" cx={x(0)} cy={y(days[0].confirmed)} r={3} />}
    </svg>
  </figure>;
}

function PilotDays({ days }: { days: Day[] }) {
  const { t } = useI18n();
  const tableTitle = useId();
  const headings = ['Дата', 'Подтверждено объявлений', 'Предложений в выдаче', 'Заявок в выдаче', 'Скрыто', 'Совпадений',
    'Совпадений оператора', 'Живых совпадений', 'Раскрытий', 'Договорились', 'Вопросов', 'Ответов в срок', 'Доля в срок', 'Источник данных'];
  return <section className="workflow-stack">
    <h3 id={tableTitle}>{t('Таблица по дням')}</h3>
    <div className="pilot-table-scroll" role="region" aria-labelledby={tableTitle} tabIndex={0}>
      <table className="pilot-table">
        <thead><tr>{headings.map(heading => <th key={heading} scope="col">{t(heading)}</th>)}</tr></thead>
        <tbody>{days.map(day => <tr key={day.date}>
          <th scope="row"><time dateTime={day.date}>{dateLabel(day.date)}</time></th>
          {[day.confirmed, day.visibleSell, day.visibleBuy, day.hidden, day.matches, day.matchesOperator,
            day.liveMatches, day.disclosures, day.dealsAgreed, day.asks, day.onTime].map((value, column) => <td key={headings[column + 1]}>
              {value === null ? '—' : printNumber.format(value)}
            </td>)}
          <td>{day.asks ? printPercent.format(day.onTime / day.asks) : '—'}</td>
          <td>{t(snapshotNames[day.snapshot])}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

function PeriodFields({ period }: { period: Period }) {
  const { t } = useI18n();
  return <>
    <Field label={t('Дата начала')}><input type="date" name="from" defaultValue={period.from} required /></Field>
    <Field label={t('Дата окончания')}><input type="date" name="to" defaultValue={period.to} required /></Field>
  </>;
}

function SettingsPanel({ revised }: { revised: () => void }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<{ period: Period; stop: Rule; targets: Targets }>();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [results, setResults] = useState<Account[] | null>(null);
  const [busy, setBusy] = useState('');
  const [feedback, setFeedback] = useState<{ key: string; text: string; error: boolean }>();
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api<{ key: string; value: unknown }[]>('/admin/settings', { signal: controller.signal }),
      api<{ items: Account[] }>('/admin/pilot-accounts', { signal: controller.signal }),
    ]).then(([rows, selection]) => {
      const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
      setSettings({ period: values.pilot_period as Period, stop: values.stop_rule as Rule, targets: values.pilot_targets as Targets });
      setAccounts(selection.items);
    }).catch((err: Error) => {
      if (!controller.signal.aborted) setFeedback({ key: 'load', text: err.message, error: true });
    });
    return () => controller.abort();
  }, []);

  async function save(key: string, value: unknown) {
    if (busy) return;
    setBusy(key); setFeedback(undefined);
    try {
      await api('/admin/settings/' + key, { method: 'PUT', body: { value } });
      setFeedback({ key, text: 'Настройка сохранена.', error: false });
      revised();
    } catch (err) { setFeedback({ key, text: (err as Error).message, error: true }); }
    finally { setBusy(''); }
  }

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const q = String(new FormData(event.currentTarget).get('q') ?? '').trim();
    if (!q) return;
    setBusy('search'); setFeedback(undefined); setResults(null);
    try { setResults((await api<{ items: Account[] }>('/admin/pilot-accounts?q=' + encodeURIComponent(q))).items); }
    catch (err) { setFeedback({ key: 'search', text: (err as Error).message, error: true }); }
    finally { setBusy(''); }
  }

  function message(key: string) {
    return feedback?.key === key && <Notice tone={feedback.error ? 'error' : 'success'}>{t(feedback.text)}</Notice>;
  }

  if (!settings) return message('load') || <Spinner />;
  return <section className="workflow-stack pilot-settings">
    <h3>{t('Настройки пробы')}</h3>
    <form className="panel workflow-section workflow-stack" onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      void save('pilot_period', { from: data.get('from'), to: data.get('to') });
    }}>
      <h4>{t('Период по умолчанию')}</h4>
      <div className="form-grid"><PeriodFields period={settings.period} /></div>
      <div><Button variant="secondary" type="submit" disabled={Boolean(busy)}>{t('Сохранить период')}</Button></div>
      {message('pilot_period')}
    </form>
    <form className="panel workflow-section workflow-stack" onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      void save('stop_rule', { date: data.get('date'), minLiveMatches: Number(data.get('minLiveMatches')) });
    }}>
      <h4>{t('Стоп-правило')}</h4>
      <div className="form-grid">
        <Field label={t('Дата стоп-правила')}><input name="date" type="date" defaultValue={settings.stop.date} required /></Field>
        <Field label={t('Минимум живых совпадений')}><input name="minLiveMatches" type="number" min="1" max="1000"
          defaultValue={settings.stop.minLiveMatches} required /></Field>
      </div>
      <div><Button variant="secondary" type="submit" disabled={Boolean(busy)}>{t('Сохранить стоп-правило')}</Button></div>
      {message('stop_rule')}
    </form>
    <form className="panel workflow-section workflow-stack" onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      void save('pilot_targets', Object.fromEntries(Object.keys(targetNames).map(key => [key,
        Number(data.get(key)) / (key === 'onTimeShare' ? 100 : 1)])));
    }}>
      <h4>{t('Ориентиры')}</h4>
      <div className="form-grid">{(Object.keys(targetNames) as (keyof Targets)[]).map(key => <Field label={t(targetNames[key])} key={key}>
        <input name={key} type="number" min="0" max={key === 'onTimeShare' ? 100 : 10000} step={key === 'onTimeShare' ? 'any' : 1}
          defaultValue={settings.targets[key] * (key === 'onTimeShare' ? 100 : 1)} required />
      </Field>)}</div>
      <div><Button variant="secondary" type="submit" disabled={Boolean(busy)}>{t('Сохранить ориентиры')}</Button></div>
      {message('pilot_targets')}
    </form>
    <div className="panel workflow-section workflow-stack">
      <h4>{t('Исключённые аккаунты')}</h4>
      <form className="pilot-search" onSubmit={event => void search(event)}>
        <Field label={t('Поиск по нику участника')}><input name="q" type="search" maxLength={100} required /></Field>
        <Button variant="secondary" type="submit" disabled={Boolean(busy)}>{t('Найти')}</Button>
      </form>
      {message('search')}
      {results?.length === 0 && <p>{t('Участники не найдены.')}</p>}
      {Boolean(results?.length) && <ul aria-label={t('Результаты поиска')} className="pilot-account-list">
        {results?.map(account => <li key={account.id}>{account.nickname} <Button variant="secondary" type="button"
          disabled={Boolean(busy) || accounts.some(item => item.id === account.id)}
          aria-label={t('Исключить {name} из показателей', { name: account.nickname })}
          onClick={() => setAccounts(items => [...items, account])}>{t('Исключить')}</Button></li>)}
      </ul>}
      {accounts.length > 0 && <ul aria-label={t('Аккаунты, исключённые из показателей')} className="pilot-account-list">
        {accounts.map(account => <li key={account.id}>{account.nickname} <Button variant="secondary" type="button"
          disabled={Boolean(busy)} aria-label={t('Вернуть {name} в показатели', { name: account.nickname })}
          onClick={() => setAccounts(items => items.filter(item => item.id !== account.id))}>{t('Вернуть')}</Button></li>)}
      </ul>}
      <div><Button type="button" variant="secondary" disabled={Boolean(busy)}
        onClick={() => void save('pilot_excluded_users', accounts.map(account => account.id))}>{t('Сохранить исключения')}</Button></div>
      {message('pilot_excluded_users')}
    </div>
  </section>;
}

export function PilotMetrics({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useI18n();
  const [period, setPeriod] = useState<Period>();
  const [report, setReport] = useState<Report>();
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    const query = period ? '?' + new URLSearchParams(period) : '';
    setLoading(true); setError('');
    void api<Report>('/admin/pilot-metrics' + query, { signal: controller.signal }).then(setReport)
      .catch((err: Error) => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [period, revision]);

  const stop = report?.stopRule;
  const totals = report?.totals;
  const targets = report?.targets;
  const participantLabels = { level0: 'Уровень 0', level1: 'Уровень 1', level2: 'Уровень 2',
    registered: 'Зарегистрировано за период', invitesIssued: 'Приглашений выдано', invitesUsed: 'Приглашений использовано' } as const;
  return <section className="workflow-stack pilot-page">
    <h2>{t('Показатели пробы')}</h2>
    {error && <Notice tone="error">{t(error)}</Notice>}
    {!report && loading && <Spinner />}
    {report && stop && totals && targets && <>
      <form className="pilot-filters" aria-busy={loading} onSubmit={event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setPeriod({ from: String(data.get('from')), to: String(data.get('to')) });
      }}>
        <PeriodFields period={report} key={`${report.from}-${report.to}`} />
        <Button type="submit" disabled={loading}>{t('Показать')}</Button>
        <a className="button button-secondary" href={'/api/v1/admin/pilot-metrics.csv?' + new URLSearchParams({ from: report.from, to: report.to })}>
          {t('Выгрузить CSV')}
        </a>
      </form>
      <p className="muted">{t('Часовой пояс площадки: {timezone}', { timezone: report.timezone })}</p>
      <article className={'pilot-stop pilot-stop-' + stop.state.toLowerCase()}>
        <h3>{t(!stop.dateReached ? 'Стоп-правило {date}' : stop.state === 'TRIGGERED' ? 'Стоп-правило сработало' : 'Порог пройден',
          { date: dateLabel(stop.date) })}</h3>
        <p>{t('Живых совпадений {actual} из {target}', { actual: stop.liveMatches, target: stop.minLiveMatches })}</p>
        <p>{t('Готовность платить учитывается вне площадки.')}</p>
      </article>
      <div className="pilot-grid">
        <Measure label="Совпадения" actual={totals.matches.total} target={targets.matches}
          note={t('Полных {full}, частичных {partial}. Системой {system}, оператором {operator}.', totals.matches)} />
        <Measure label="Живые совпадения" actual={totals.liveMatches} target={targets.liveMatches}
          note={t('После создания совпадения обе стороны написали в чат.')} />
        <Measure label="Раскрытия" actual={totals.disclosures} target={targets.disclosures}
          note={t('Стороны впервые согласились на обмен контактами.')} />
        <Measure label="Доля раскрытий до договорённости" actual={totals.disclosuresToAgreedShare} percent
          note={t('Обе стороны подтвердили условия после первого раскрытия.')} />
        <Measure label="Сделки" actual={totals.dealsAgreed} target={targets.dealsAgreed}
          note={t('Обе стороны указали условия. Исполнено {count}.', { count: totals.dealsExecuted })} />
        <Measure label="Ответы в срок" actual={totals.onTimeShare} target={targets.onTimeShare} percent
          note={t('Доля своевременных ответов среди завершённых вопросов об актуальности.')} />
        <Measure label="Подтверждено в среднем в день" actual={totals.confirmedPerDay} target={targets.confirmedPerDay}
          note={t('Разные объявления, подтверждённые в каждый день периода до текущего включительно.')} />
      </div>
      <VisibilityChart days={report.days} />
      <PilotDays days={report.days} />
      <section className="workflow-stack">
        <h3>{t('Участники по уровням')}</h3>
        <dl className="pilot-grid pilot-participants">{(Object.keys(participantLabels) as (keyof typeof participantLabels)[]).map(key => <div className="panel" key={key}>
          <dt>{t(participantLabels[key])}</dt><dd>{printNumber.format(totals.participants[key])}</dd>
        </div>)}</dl>
      </section>
    </>}
    {isAdmin && <SettingsPanel revised={() => setRevision(value => value + 1)} />}
  </section>;
}
