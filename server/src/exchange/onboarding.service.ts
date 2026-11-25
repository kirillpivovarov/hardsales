import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  isStaffRole, sessionUser, type ParticipantRole, type RepresentationMode, type SessionUser, type UserRow,
} from '../auth/auth.types';
import { outsideContact } from '../contact';
import { DatabaseService, type Queryable } from '../database/database.service';
import { object, oneOf, str, uuid } from '../market/market.inputs';
import { ExchangeNotifications } from './notifications';
import { onboardingAnswerMaxLength, onboardingGroups, onboardingOptionalHeading } from './onboarding.questions';
import { PlatformSettings } from './platform-settings';
import type { PoolClient } from 'pg';

const modes = ['DIRECT', 'AGENT', 'BOTH'] as const;
const staleRules = 'Правила обновились. Обновите страницу и примите текущую версию';

function groupsFor(role: ParticipantRole, mode: RepresentationMode) {
  return onboardingGroups.filter((group) => group.key === (role === 'SELLER' ? 'seller' : 'buyer') ||
    (group.key === 'agent' && mode !== 'DIRECT'));
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly settings: PlatformSettings,
    private readonly notifications: ExchangeNotifications,
  ) {}

  async presentUser(row: UserRow, db: Queryable = this.db): Promise<SessionUser> {
    const { version, enabled } = await this.rules(db);
    return sessionUser(row, version, enabled);
  }

  async assertOnboardingComplete(userId: string, db: Queryable = this.db): Promise<void> {
    this.assertCompleted(await this.marketUser(db, userId));
  }

  async assertCanPublish(userId: string, db: Queryable = this.db): Promise<void> {
    const user = await this.marketUser(db, userId);
    this.assertCompleted(user);
    const { version, enabled } = await this.rules(db);
    if (enabled && user.rules_accepted_version !== version) {
      throw new ConflictException({
        statusCode: 409, code: 'RULES_NOT_ACCEPTED', message: 'Примите обновлённые правила площадки',
      });
    }
  }

  async get(user: SessionUser<ParticipantRole>) {
    const [current, rules, principals, pages] = await Promise.all([
      this.marketUser(this.db, user.id),
      this.rules(this.db),
      this.hasPrincipal(this.db, user.id),
      this.db.query<{ translations: Record<string, { title: string; body: string }> }>(
        "SELECT translations FROM site_content WHERE key = 'rules'",
      ),
    ]);
    return {
      groups: groupsFor(user.role, current.representation_mode),
      agentGroup: onboardingGroups.find((group) => group.key === 'agent'),
      optionalHeading: onboardingOptionalHeading,
      answers: current.onboarding_answers,
      representationMode: current.representation_mode,
      rulesVersion: rules.version,
      rulesContent: pages.rows[0]?.translations ?? {},
      principalRequired: current.representation_mode !== 'DIRECT' && !principals,
      hasPrincipal: principals,
    };
  }

  async submit(user: SessionUser<ParticipantRole>, raw: unknown): Promise<SessionUser> {
    const input = object(raw);
    const mode = oneOf(input.representationMode, modes, 'Режим представительства');
    const version = str(input.rulesVersion, 'Версия правил', 1, 32);
    const rawAnswers = object(input.answers, 'Ответы анкеты');
    return this.db.transaction(async (client) => {
      const rules = await this.lockRules(client);
      const current = await this.lockParticipant(client, user.id);
      if (version !== rules.version) throw new ConflictException(staleRules);
      const answers = this.validateAnswers(rawAnswers, current.onboarding_answers, user.role, mode);
      if (mode === 'DIRECT' && current.representation_mode !== 'DIRECT') {
        await this.assertNoAgentListings(client, user.id);
      } else if (mode !== 'DIRECT' && !(await this.hasPrincipal(client, user.id))) {
        await this.addFirstPrincipal(client, user.id, input.principal);
      }
      const { rows: [updated] } = await client.query<UserRow>(`
        UPDATE users SET
          onboarding_answers = $2, representation_mode = $3, onboarding_state = 'DONE',
          onboarding_submitted_at = coalesce(onboarding_submitted_at, now()),
          rules_accepted_version = $4, rules_accepted_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *
      `, [user.id, answers, mode, version]);
      if (!current.onboarding_submitted_at) await this.notifyAdmin(client, updated);
      return sessionUser(updated, version, rules.enabled);
    });
  }

  async acceptRules(user: SessionUser<ParticipantRole>, raw: unknown): Promise<SessionUser> {
    const version = str(object(raw).rulesVersion, 'Версия правил', 1, 32);
    return this.db.transaction(async (client) => {
      const rules = await this.lockRules(client);
      const current = await this.lockParticipant(client, user.id);
      if (version !== rules.version) throw new ConflictException(staleRules);
      if (current.rules_accepted_version === version) return sessionUser(current, version, rules.enabled);
      const { rows: [updated] } = await client.query<UserRow>(`
        UPDATE users SET rules_accepted_version = $2, rules_accepted_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *
      `, [user.id, version]);
      return sessionUser(updated, version, rules.enabled);
    });
  }

  async staffAnswers(input: string) {
    const id = uuid(input);
    const current = await this.marketUser(this.db, id);
    if (isStaffRole(current.role)) throw new NotFoundException('У участника нет анкеты');
    const known = onboardingGroups.flatMap((group) => group.questions);
    const questions = groupsFor(current.role, current.representation_mode).flatMap((group) => group.questions);
    const present = new Set(questions.map((question) => question.id));
    for (const key of Object.keys(current.onboarding_answers)) {
      if (!present.has(key)) {
        questions.push(known.find((question) => question.id === key) ?? {
          id: key, text: 'Вопрос снят', required: false,
        });
      }
    }
    return {
      answers: current.onboarding_answers,
      questions,
      submittedAt: current.onboarding_submitted_at,
      representationMode: current.representation_mode,
      rulesAcceptedVersion: current.rules_accepted_version,
    };
  }

  private async rules(db: Queryable) {
    const [version, enabled] = await Promise.all([
      this.settings.get<string>('rules_version', db),
      this.settings.enabled('feature_invites', db),
    ]);
    return { version, enabled };
  }

  private async lockRules(client: PoolClient) {
    const { rows } = await client.query<{ key: string; value: boolean | string }>(`
      SELECT key, value FROM platform_settings WHERE key IN ('rules_version','feature_invites') ORDER BY key FOR SHARE
    `);
    const version = rows.find((row) => row.key === 'rules_version')?.value;
    if (typeof version !== 'string') throw new NotFoundException('Версия правил не найдена');
    return { version, enabled: rows.find((row) => row.key === 'feature_invites')?.value === true };
  }

  private async marketUser(db: Queryable, id: string): Promise<UserRow> {
    const { rows: [user] } = await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    if (!user) throw new NotFoundException('Пользователь не найден');
    return user;
  }

  private async lockParticipant(client: PoolClient, id: string): Promise<UserRow> {
    const { rows: [current] } = await client.query<UserRow>(`
      SELECT * FROM users WHERE id = $1 AND role IN ('BUYER','SELLER') AND status = 'ACTIVE'
        AND email_verified_at IS NOT NULL FOR UPDATE
    `, [id]);
    if (!current) throw new ForbiddenException('Профиль участника недоступен');
    return current;
  }

  private assertCompleted(user: UserRow) {
    if (user.onboarding_state === 'REQUIRED') throw new ForbiddenException('Заполните анкету входа');
  }

  private validateAnswers(input: Record<string, unknown>, previous: Record<string, string>,
    role: ParticipantRole, mode: RepresentationMode): Record<string, string> {
    const questions = groupsFor(role, mode).flatMap((group) => group.questions);
    const supported = new Set(questions.map((question) => question.id));
    for (const key of Object.keys(input)) {
      if (!supported.has(key) && !Object.hasOwn(previous, key)) throw new BadRequestException('Неизвестный вопрос анкеты');
    }
    const entries: [string, string][] = [];
    for (const question of questions) {
      const value = Object.hasOwn(input, question.id) ? input[question.id] : '';
      const answer = str(value, question.text, question.required ? 2 : 0, onboardingAnswerMaxLength);
      if (outsideContact(answer)) throw new BadRequestException('Уберите контакты из ответов анкеты');
      if (answer) entries.push([question.id, answer]);
    }
    return Object.fromEntries(entries);
  }

  private async hasPrincipal(db: Queryable, userId: string): Promise<boolean> {
    const result = await db.query('SELECT 1 FROM user_principals WHERE user_id = $1 AND removed_at IS NULL LIMIT 1', [userId]);
    return Boolean(result.rowCount);
  }

  private async addFirstPrincipal(client: PoolClient, userId: string, value: unknown): Promise<void> {
    if (!value) throw new BadRequestException('Укажите, кого вы представляете');
    const input = object(value, 'Принципал');
    const name = str(input.name, 'Имя принципала', 2, 160);
    const company = input.company === undefined ? '' : str(input.company, 'Компания принципала', 0, 160);
    const { rows: [next] } = await client.query<{ number: number }>(`
      SELECT coalesce(max(number), 0)::int + 1 AS number FROM user_principals WHERE user_id = $1
    `, [userId]);
    if (next.number > 999) throw new ConflictException('Достигнут предел числа принципалов');
    await client.query('INSERT INTO user_principals (user_id, number, name, company) VALUES ($1, $2, $3, $4)',
      [userId, next.number, name, company]);
  }

  private async assertNoAgentListings(client: PoolClient, userId: string) {
    const result = await client.query(`
      SELECT 1 FROM listings WHERE owner_id = $1 AND representation = 'AGENT' AND status IN ('ACTIVE', 'HIDDEN') LIMIT 1
    `, [userId]);
    if (result.rowCount) throw new ConflictException('Сначала архивируйте агентские объявления');
  }

  private async notifyAdmin(client: PoolClient, user: UserRow) {
    const { rows: [owner] } = await client.query<{ id: string }>(
      "SELECT id FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'",
    );
    if (!owner) return;
    await this.notifications.notify(client, owner.id, {
      kind: 'onboarding.submitted',
      title: `Новый участник ${user.display_name} заполнил анкету`,
      body: 'Ответы доступны в профиле участника.',
      payload: { userId: user.id },
      actions: [{ label: 'Открыть', href: `/admin?section=exchange&part=onboarding&userId=${user.id}` }],
      dedupeKey: `onboarding.submitted:${user.id}`,
      channels: [],
    });
  }
}
