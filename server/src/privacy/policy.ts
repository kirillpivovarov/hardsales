import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { isIP } from 'node:net';
import type { Request } from 'express';
import { demoMode } from '../config';
import type { Queryable } from '../database/database.service';
import { object, str } from '../market/market.inputs';

export type ConsentEvidence = { at: Date; ip: string | null; userAgent: string | null };
export type ConsentSource = 'REGISTRATION' | 'LOGIN' | 'PROFILE' | 'MIGRATION';
export const CONSENT_REQUIRED = 'Подтвердите согласие на обработку персональных данных';
export const REGISTRATION_CLOSED = 'Регистрация временно недоступна: политика обработки данных ещё не опубликована';

export function consentRequest(request: Request): ConsentEvidence {
  const ip = request.ip || request.socket.remoteAddress;
  return {
    at: new Date(), ip: ip && isIP(ip) ? ip : null,
    userAgent: request.get('User-Agent')?.slice(0, 300) || null,
  };
}

export async function policyVersion(db: Queryable, lock = false): Promise<string> {
  const { rows: [current] } = await db.query<{ value: string }>(
    'SELECT value FROM platform_settings WHERE key=\'pd_policy_version\'' + (lock ? ' FOR SHARE' : ''),
  );
  if (!current || typeof current.value !== 'string') throw new Error('Missing personal data policy version');
  return current.value;
}

export function assertPolicyVersion(current: string, given: string): void {
  if (given !== current) throw new ConflictException('Политика обработки данных обновилась. Обновите страницу');
}

export function registrationAvailable(version: string): boolean {
  return demoMode() || !/^0(?:\.|$)/.test(version);
}

export function assertRegistrationAvailable(version: string): void {
  if (!registrationAvailable(version)) throw new ServiceUnavailableException(REGISTRATION_CLOSED);
}

export function policyRequired(): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403, code: 'PD_CONSENT_REQUIRED', message: 'Примите обновлённую политику обработки персональных данных',
  });
}

export async function recordConsent(db: Queryable, userId: string, version: string, source: ConsentSource,
  evidence: ConsentEvidence, decisions: { pd?: boolean; infoEmail?: boolean }): Promise<void> {
  await db.query(`
    INSERT INTO user_consents (user_id,kind,granted,policy_version,given_at,ip,user_agent,source)
    SELECT $1,kind,granted,$2,$3,$4,$5,$6
    FROM (VALUES ('PD_PROCESSING',$7::boolean),('INFO_EMAIL',$8::boolean)) consent(kind,granted)
    WHERE granted IS NOT NULL
  `, [userId, version, evidence.at, evidence.ip, evidence.userAgent, source, decisions.pd, decisions.infoEmail]);
}

export type ThirdPartyLetter = {
  approved: boolean; subject: string; body: string; approvedAt: string | null; approvedBy: string | null;
};
export const LETTER_PLACEHOLDERS = ['link', 'policyUrl', 'optOutUrl', 'agentNickname', 'agentCompany', 'fee', 'expiresDays'] as const;
type LetterPlaceholder = typeof LETTER_PLACEHOLDERS[number];

export function thirdPartyLetterSetting(value: unknown, before: unknown,
  actor: { id: string }, now: Date): ThirdPartyLetter {
  const input = object(value);
  const previous = before as ThirdPartyLetter;
  if (typeof input.approved !== 'boolean') throw new BadRequestException('Укажите, утверждён ли текст письма');
  const subject = str(input.subject, 'Тема письма', 5, 150);
  if (/[\r\n]/.test(subject)) throw new BadRequestException('Тема письма должна содержать одну строку');
  const body = str(input.body, 'Текст письма', 50, 3000);
  if (!['link', 'policyUrl', 'optOutUrl'].every(key => body.includes('{' + key + '}'))) {
    throw new BadRequestException('В тексте письма нет {link}, {policyUrl} или {optOutUrl}');
  }
  for (const match of (subject + '\n' + body).matchAll(/\{([^{}]+)\}/g)) {
    if (!LETTER_PLACEHOLDERS.includes(match[1] as LetterPlaceholder)) {
      throw new BadRequestException('В тексте письма указана неизвестная подстановка');
    }
  }
  const changed = previous.subject !== subject || previous.body !== body;
  const approved = input.approved && (!changed || !previous.subject && !previous.body);
  if (approved && previous.approved && !changed) return previous;
  return {
    approved, subject, body,
    approvedAt: approved ? now.toISOString() : null,
    approvedBy: approved ? actor.id : null,
  };
}

export function renderLetter(template: string, values: Record<LetterPlaceholder, string>) {
  return template.replace(/\{([^{}]+)\}/g, (whole, key: string) => Object.hasOwn(values, key)
    ? values[key as LetterPlaceholder] : whole);
}
