import { BadRequestException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { integer, object, uuid } from '../market/market.inputs';

export type PilotPeriod = { from: string; to: string };
export type StopRule = { date: string; minLiveMatches: number };
export type PilotTargets = {
  confirmedPerDay: number; matches: number; liveMatches: number; disclosures: number; dealsAgreed: number; onTimeShare: number;
};

const DAY_MS = 86_400_000;

export function pilotDate(value: unknown): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith('0000')) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value) return value;
  }
  throw new BadRequestException('Укажите корректную дату в формате ГГГГ-ММ-ДД.');
}

export function pilotPeriod(from: unknown, to: unknown): PilotPeriod {
  const start = pilotDate(from);
  const end = pilotDate(to);
  if (start > end || Date.parse(end) - Date.parse(start) >= 366 * DAY_MS) {
    throw new BadRequestException('Выберите период от 1 до 366 дней.');
  }
  return { from: start, to: end };
}

const beforeStart = () => new BadRequestException('Дата стоп-правила раньше начала пробы');

export async function validatePilotSetting(client: PoolClient, key: string, value: unknown): Promise<unknown> {
  if (key === 'pilot_period') {
    const period = object(value, 'Период пробы');
    const next = pilotPeriod(period.from, period.to);
    const { rows: [stop] } = await client.query<{ value: StopRule }>(
      "SELECT value FROM platform_settings WHERE key='stop_rule' FOR SHARE",
    );
    if (stop.value.date < next.from) throw beforeStart();
    return next;
  }
  if (key === 'stop_rule') {
    const rule = object(value, 'Стоп-правило');
    const date = pilotDate(rule.date);
    const { rows: [period] } = await client.query<{ value: PilotPeriod }>(
      "SELECT value FROM platform_settings WHERE key='pilot_period' FOR SHARE",
    );
    if (date < period.value.from) throw beforeStart();
    return { date, minLiveMatches: integer(rule.minLiveMatches, 'Порог живых совпадений', 1, 1000) };
  }
  if (key === 'pilot_targets') {
    const targets = object(value, 'Ориентиры пробы');
    const onTimeShare = targets.onTimeShare;
    if (typeof onTimeShare !== 'number' || !Number.isFinite(onTimeShare) || onTimeShare < 0 || onTimeShare > 1) {
      throw new BadRequestException('Доля ответов в срок должна быть от 0 до 1.');
    }
    return {
      confirmedPerDay: integer(targets.confirmedPerDay, 'Подтверждено объявлений в день', 0, 10000),
      matches: integer(targets.matches, 'Совпадения', 0, 10000),
      liveMatches: integer(targets.liveMatches, 'Живые совпадения', 0, 10000),
      disclosures: integer(targets.disclosures, 'Раскрытия', 0, 10000),
      dealsAgreed: integer(targets.dealsAgreed, 'Сделки', 0, 10000),
      onTimeShare,
    };
  }
  if (key === 'pilot_excluded_users') {
    if (!Array.isArray(value) || value.length > 1000) throw new BadRequestException('Допустим список до 1000 аккаунтов.');
    return [...new Set(value.map(id => uuid(id, 'Идентификатор исключённого аккаунта')))].sort();
  }
  return undefined;
}
