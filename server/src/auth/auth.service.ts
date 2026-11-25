import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus,
  Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown,
  ServiceUnavailableException, UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { appOrigin, demoMode, isProduction } from '../config';
import { DatabaseService } from '../database/database.service';
import { codesMatch, hashCode, hashPassword, hashToken, passwordMatches } from './auth.crypto';
import type { CredentialsDto, LoginDto, ProfileDto, RegisterDto } from './auth.dto';
import { SessionUser, UserRow, sessionUser } from './auth.types';
import { MailService } from './mail.service';

export type { SessionUser } from './auth.types';

export const SESSION_TTL = 7 * 24 * 60 * 60;
export const COOKIE_NAME = 'hwforai_session';
const COOKIE_TOKEN = /^[\da-f]{64}$/;
const OTP_TTL = 600;
const RESEND_DELAY = 60;
const OTP_ATTEMPTS = 5;
const DEMO_ACCOUNT_IDS = new Set([
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
]);

const INVALID_CODE = 'Код неверен, истёк или уже использован. Запросите новый код.';
const DUMMY_PASSWORD_HASH = `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`;

interface PendingRegistration extends Omit<RegisterDto, 'password'> {
  passwordHash: string;
}

type ChallengePurpose = 'REGISTER' | 'LOGIN';

interface ChallengeRow {
  id: string;
  purpose: ChallengePurpose;
  email: string;
  code_hash: string;
  user_id: string | null;
  pending_registration: PendingRegistration | null;
  credential_version: number | null;
  expires_at: Date;
  resend_at: Date;
  attempts: number;
  delivered_at: Date | null;
  consumed_at: Date | null;
}

interface NewChallenge {
  id: string;
  code: string;
  email: string;
}

export interface ChallengeResult {
  challengeId: string;
  expiresIn: number;
  email: string;
}

export interface SessionResult {
  user: SessionUser;
  token: string;
}

function statusError(status: UserRow['status']): ForbiddenException {
  return new ForbiddenException(status === 'FROZEN' ? 'Профиль временно заморожен.' : 'Профиль заблокирован.');
}

function expired(challenge: ChallengeRow): boolean {
  return challenge.expires_at.getTime() <= Date.now();
}

function maskEmail(email: string): string {
  const separator = email.lastIndexOf('@');
  return `${email.slice(0, 1)}***${email.slice(separator)}`;
}

function sessionToken(request: Request): string | undefined {
  const cookies = request.headers.cookie?.split(';') ?? [];
  const value = cookies.map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
  return value && COOKIE_TOKEN.test(value) ? value : undefined;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export function sessionCookie() {
  return { httpOnly: true, sameSite: 'lax' as const, secure: isProduction() || Boolean(appOrigin()?.startsWith('https://')), path: '/' };
}

@Injectable()
export class AuthService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AuthService.name);
  private cleanupTimer?: NodeJS.Timeout;

  constructor(private readonly db: DatabaseService, private readonly mail: MailService) {}

  onApplicationBootstrap(): void {
    void this.cleanup();
    this.cleanupTimer = setInterval(() => void this.cleanup(), 60 * 60 * 1_000);
    this.cleanupTimer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.cleanupTimer);
  }

  async register(input: RegisterDto, ip: string): Promise<ChallengeResult> {
    await this.limit('register-ip', ip, 12, 3600);
    await this.limit('register-email', input.email, 5, 3600);
    const { rows } = await this.db.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM users WHERE lower(username) = lower($1)) AS exists', [input.username],
    );
    if (rows[0].exists) throw new ConflictException('Этот логин занят.');
    // The account is inserted only after mailbox control is confirmed.
    const { password, ...profile } = input;
    const passwordHash = await hashPassword(password);
    const challenge = await this.db.transaction((client) => this.insertChallenge(
      client, 'REGISTER', input.email, null, { ...profile, passwordHash }, null,
    ));
    return this.deliverChallenge(challenge);
  }

  async login(input: LoginDto, ip: string): Promise<ChallengeResult | SessionResult> {
    const login = input.login.toLowerCase();
    await this.limit('login-ip', ip, 35, 900);
    await this.limit('login-account', login, 12, 900);
    const { rows } = await this.db.query<UserRow>(
      'SELECT * FROM users WHERE lower(username) = $1 OR lower(email) = $1', [login],
    );
    const user = rows[0];
    if (!(await passwordMatches(input.password, user?.password_hash ?? DUMMY_PASSWORD_HASH)) || !user || !user.email_verified_at) {
      throw new UnauthorizedException('Логин, почта или пароль указаны неверно.');
    }
    if (user.status !== 'ACTIVE') throw statusError(user.status);
    if (demoMode() && DEMO_ACCOUNT_IDS.has(user.id)) {
      return this.db.transaction(async (client) => {
        const current = (await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [user.id])).rows[0];
        if (!current || current.password_hash !== user.password_hash) throw new UnauthorizedException('Попробуйте войти снова.');
        if (current.status !== 'ACTIVE') throw statusError(current.status);
        return this.issueSession(client, current);
      });
    }
    await this.limit('login-otp-email', user.email, 6, 3600);
    const challenge = await this.db.transaction((client) => this.insertChallenge(
      client, 'LOGIN', user.email, user.id, null, user.credential_version,
    ));
    return this.deliverChallenge(challenge);
  }

  async resend(id: string, ip: string): Promise<ChallengeResult> {
    await this.limit('resend-ip', ip, 15, 3600);
    const existing = (await this.db.query<ChallengeRow>('SELECT * FROM email_challenges WHERE id = $1', [id])).rows[0];
    if (!existing) throw new BadRequestException(INVALID_CODE);
    await this.limit('resend-email', existing.email, 5, 3600);
    const newChallenge = await this.db.transaction(async (client) => {
      const { rows } = await client.query<ChallengeRow>('SELECT * FROM email_challenges WHERE id = $1 FOR UPDATE', [id]);
      const challenge = rows[0];
      if (!challenge || challenge.consumed_at || !challenge.delivered_at || challenge.attempts >= OTP_ATTEMPTS ||
          challenge.expires_at.getTime() + OTP_TTL * 1000 < Date.now()) {
        throw new BadRequestException(INVALID_CODE);
      }
      if (challenge.resend_at.getTime() > Date.now()) {
        throw new HttpException('Повторно отправить код можно через минуту.', HttpStatus.TOO_MANY_REQUESTS);
      }
      await client.query('UPDATE email_challenges SET consumed_at = now() WHERE id = $1', [id]);
      return this.insertChallenge(client, challenge.purpose, challenge.email, challenge.user_id,
        challenge.pending_registration, challenge.credential_version, challenge.attempts);
    });

    try {
      return await this.deliverChallenge(newChallenge);
    } catch (error) {
      await this.db.query('UPDATE email_challenges SET consumed_at = NULL WHERE id = $1', [id]);
      throw error;
    }
  }

  async verify(id: string, code: string, ip: string): Promise<SessionResult> {
    await this.limit('verify-ip', ip, 45, 900);
    const result = await this.db.transaction(async (client) => {
      const { rows } = await client.query<ChallengeRow>('SELECT * FROM email_challenges WHERE id = $1 FOR UPDATE', [id]);
      const challenge = rows[0];
      if (!challenge || !challenge.delivered_at || challenge.consumed_at || expired(challenge) ||
          challenge.attempts >= OTP_ATTEMPTS) return null;
      if (!codesMatch(id, code, challenge.code_hash)) {
        await client.query('UPDATE email_challenges SET attempts = attempts + 1 WHERE id = $1', [id]);
        return null;
      }

      let user: UserRow | undefined;
      if (challenge.purpose === 'REGISTER') {
        const pending = challenge.pending_registration!;
        user = (await client.query<UserRow>(`
          INSERT INTO users (username, display_name, email, password_hash, role, participant_type,
            company_name, city, country, telegram, email_verified_at)
          VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, now())
          ON CONFLICT DO NOTHING RETURNING *
        `, [pending.username, pending.email, pending.passwordHash, pending.role, pending.participantType,
          pending.participantType === 'COMPANY' ? pending.companyName : null,
          pending.city, pending.country, pending.telegram.replace(/^@/, '')])).rows[0];
      } else {
        user = (await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [challenge.user_id])).rows[0];
      }

      await client.query('DELETE FROM email_challenges WHERE id = $1', [id]);
      if (!user) return { error: challenge.purpose === 'REGISTER' ? 'conflict' : 'missing' } as const;
      if (user.status !== 'ACTIVE') return { error: user.status } as const;
      // A password change invalidates codes issued with the previous credential.
      if (!user.email_verified_at || user.email !== challenge.email ||
          (challenge.purpose === 'LOGIN' && user.credential_version !== challenge.credential_version)) {
        return { error: 'missing' } as const;
      }
      return this.issueSession(client, user);
    });
    if (!result) throw new BadRequestException(INVALID_CODE);
    if ('token' in result) return result;
    if (result.error === 'conflict') throw new ConflictException('Этот логин или адрес уже зарегистрирован. Войдите в свой аккаунт.');
    if (result.error === 'missing') throw new UnauthorizedException('Запросите вход заново.');
    throw statusError(result.error);
  }

  async resolve(request: Request, required = false): Promise<SessionUser | null> {
    const token = sessionToken(request);
    if (token) {
      const { rows } = await this.db.query<UserRow>(`
        SELECT u.* FROM auth_sessions AS s
        JOIN users AS u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()
      `, [hashToken(token)]);
      const user = rows[0];
      if (user?.status === 'ACTIVE' && user.email_verified_at) return sessionUser(user);
      if (user && user.status !== 'ACTIVE' && required) throw statusError(user.status);
    }
    if (required) throw new UnauthorizedException('Войдите в аккаунт и подтвердите почту.');
    return null;
  }

  async require(request: Request): Promise<SessionUser> {
    const user = (await this.resolve(request, true))!;
    if (user.mustChangePassword) throw new ForbiddenException('Замените начальный пароль в настройках аккаунта.');
    return user;
  }

  async admin(request: Request): Promise<SessionUser> {
    const user = await this.require(request);
    if (user.role !== 'ADMIN') throw new ForbiddenException('Действие доступно администратору.');
    return user;
  }

  async logout(request: Request): Promise<void> {
    const token = sessionToken(request);
    if (token) await this.db.query('DELETE FROM auth_sessions WHERE token_hash = $1', [hashToken(token)]);
  }

  async updateProfile(request: Request, input: ProfileDto): Promise<SessionUser> {
    const owner = await this.require(request);
    if (input.companyName !== undefined && owner.participantType !== 'COMPANY') {
      throw new BadRequestException('Название компании доступно только компаниям.');
    }
    const { rows } = await this.db.query<UserRow>(`
      UPDATE users SET
        display_name = COALESCE($2, display_name),
        city = COALESCE($3, city),
        country = COALESCE($4, country),
        telegram = COALESCE($5, telegram),
        company_name = COALESCE($6, company_name),
        updated_at = now()
      WHERE id = $1 AND status = 'ACTIVE' RETURNING *
    `, [owner.id, input.displayName, input.city, input.country, input.telegram?.replace(/^@/, ''), input.companyName]);
    if (!rows[0]) throw new ForbiddenException('Профиль недоступен.');
    return sessionUser(rows[0]);
  }

  async changeCredentials(request: Request, input: CredentialsDto): Promise<SessionResult> {
    const owner = (await this.resolve(request, true))!;
    if (input.username !== undefined && owner.role !== 'ADMIN') {
      throw new ForbiddenException('Смена логина доступна администратору.');
    }
    if (input.currentPassword === input.newPassword) {
      throw new BadRequestException('Новый пароль должен отличаться от текущего.');
    }
    await this.limit('change-password', owner.id, 10, 900);
    const current = (await this.db.query<UserRow>('SELECT * FROM users WHERE id = $1', [owner.id])).rows[0];
    if (!current || !await passwordMatches(input.currentPassword, current.password_hash)) {
      throw new UnauthorizedException('Текущий пароль указан неверно.');
    }
    const passwordHash = await hashPassword(input.newPassword);
    try {
      return await this.db.transaction(async (client) => {
        const { rows } = await client.query<UserRow>(`
          UPDATE users SET
            password_hash = $2, username = COALESCE($3, username),
            must_change_password = false, credential_version = credential_version + 1, updated_at = now()
          WHERE id = $1 AND password_hash = $4 AND status = 'ACTIVE' RETURNING *
        `, [owner.id, passwordHash, input.username, current.password_hash]);
        if (!rows[0]) throw new UnauthorizedException('Профиль изменился. Войдите снова.');
        await client.query('DELETE FROM auth_sessions WHERE user_id = $1', [owner.id]);
        return this.issueSession(client, rows[0]);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Этот логин занят.');
      throw error;
    }
  }

  private async issueSession(client: PoolClient, user: UserRow): Promise<SessionResult> {
    const token = randomBytes(32).toString('hex');
    await client.query(`
      INSERT INTO auth_sessions (token_hash, user_id, expires_at)
      VALUES ($1, $2, now() + $3::integer * interval '1 second')
    `, [hashToken(token), user.id, SESSION_TTL]);
    return { user: sessionUser(user), token };
  }

  private async insertChallenge(
    client: PoolClient, purpose: ChallengePurpose, email: string, userId: string | null,
    pending: PendingRegistration | null, credentialVersion: number | null, attempts = 0,
  ): Promise<NewChallenge> {
    const id = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await client.query(`
      INSERT INTO email_challenges (id, purpose, email, code_hash, user_id, pending_registration, credential_version, expires_at, resend_at, attempts)
      VALUES ($1, $2, $3, $4, $5, $6, $7, now() + $8::integer * interval '1 second', now() + $9::integer * interval '1 second', $10)
    `, [id, purpose, email, hashCode(id, code), userId, pending, credentialVersion, OTP_TTL, RESEND_DELAY, attempts]);
    return { id, code, email };
  }

  private async deliverChallenge(challenge: NewChallenge): Promise<ChallengeResult> {
    try {
      await this.mail.sendCode(challenge.email, challenge.code, OTP_TTL / 60);
    } catch {
      await this.db.query('DELETE FROM email_challenges WHERE id = $1 AND delivered_at IS NULL', [challenge.id]);
      this.logger.warn('Email transport could not deliver an authentication challenge');
      throw new ServiceUnavailableException('Письмо не отправлено. Попробуйте позже.');
    }
    await this.db.query(
      `UPDATE email_challenges SET delivered_at = now(),
        expires_at = now() + $2::integer * interval '1 second',
        resend_at = now() + $3::integer * interval '1 second'
        WHERE id = $1`,
      [challenge.id, OTP_TTL, RESEND_DELAY],
    );
    return { challengeId: challenge.id, expiresIn: OTP_TTL, email: maskEmail(challenge.email) };
  }

  private async limit(namespace: string, key: string, limit: number, seconds: number): Promise<void> {
    const { rows } = await this.db.query<{ count: number }>(`
      INSERT INTO auth_rate_limits (bucket, count, expires_at)
      VALUES ($1, 1, now() + $2::integer * interval '1 second')
      ON CONFLICT (bucket) DO UPDATE SET
        count = CASE WHEN auth_rate_limits.expires_at <= now() THEN 1 ELSE auth_rate_limits.count + 1 END,
        expires_at = CASE WHEN auth_rate_limits.expires_at <= now() THEN EXCLUDED.expires_at ELSE auth_rate_limits.expires_at END
      RETURNING count
    `, [`${namespace}:${hashToken(key)}`, seconds]);
    if (rows[0].count > limit) {
      throw new HttpException('Слишком много попыток. Попробуйте немного позже.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private async cleanup(): Promise<void> {
    try {
      await this.db.query('DELETE FROM auth_sessions WHERE expires_at <= now()');
      await this.db.query("DELETE FROM email_challenges WHERE expires_at <= now() - interval '1 hour'");
      await this.db.query('DELETE FROM auth_rate_limits WHERE expires_at <= now()');
    } catch {
      this.logger.warn('Could not clean expired authentication records');
    }
  }
}
