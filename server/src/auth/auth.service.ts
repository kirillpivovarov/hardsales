import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus,
  Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown,
  ServiceUnavailableException, UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { appOrigin, demoMode, isProduction } from '../config';
import { isPublicProfileText } from '../contact';
import { ContactGuardService } from '../contact-guard/contact-guard.service';
import { DatabaseService, type Queryable } from '../database/database.service';
import { assertCompanyAlias } from '../exchange/disclosure-names';
import { INVALID_INVITE, INVITE_NO_LONGER_AVAILABLE, InvitesService, type AvailableInvite } from '../exchange/invites.service';
import { OnboardingService } from '../exchange/onboarding.service';
import { onboardingGroups } from '../exchange/onboarding.questions';
import { object } from '../market/market.inputs';
import {
  assertPolicyVersion, assertRegistrationAvailable, CONSENT_REQUIRED, policyRequired, policyVersion,
  recordConsent, registrationAvailable, type ConsentEvidence,
} from '../privacy/policy';
import { codesMatch, hashCode, hashPassword, hashToken, passwordMatches, strongAdminPassword } from './auth.crypto';
import type { AcceptPolicyDto, CreateModeratorDto, CredentialsDto, LoginDto, ProfileDto, RegisterDto } from './auth.dto';
import { defaultTradeSide, isStaffRole, type ParticipantRole, type SessionUser, type StaffSession, type TradeSide, type UserRow } from './auth.types';
import { MailService } from './mail.service';
import { CAPTCHA_TTL, createRegistrationCaptcha, verifyRegistrationCaptcha } from './captcha';

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

const INVALID_CODE = 'Код неверен, истёк или уже использован. Если повторная отправка недоступна, вернитесь к форме.';
const REGISTRATION_COOLDOWN = 'Код можно запросить ещё раз через минуту.';
const DUMMY_PASSWORD_HASH = `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`;

interface PendingProfile extends Omit<RegisterDto, 'password' | 'captchaToken' | 'inviteCode' | 'pdConsent' | 'pdPolicyVersion'> {
  passwordHash: string;
  inviteId?: string;
  pdConsentVersion: string;
  pdConsentAt: string;
  consentIp: string | null;
  consentUserAgent: string | null;
}

type PendingRegistration = PendingProfile | { suppressed: true };

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
  code: string | null;
  email: string;
  purpose: ChallengePurpose;
}

type StaffAuditAction = 'moderator-created' | 'login' | 'logout' | 'credentials-changed' | 'profile-edited';
type StaffAuditActor = Pick<UserRow, 'id' | 'username' | 'role'>;

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

function canConfirmModeratorEmail(user: UserRow): boolean {
  return user.role === 'MODERATOR' && user.must_change_password;
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

  constructor(
    private readonly db: DatabaseService,
    private readonly mail: MailService,
    private readonly invites: InvitesService,
    private readonly onboarding: OnboardingService,
    private readonly contactGuard: ContactGuardService,
  ) {}

  onApplicationBootstrap(): void {
    void this.cleanup();
    this.cleanupTimer = setInterval(() => void this.cleanup(), 60 * 60 * 1_000);
    this.cleanupTimer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.cleanupTimer);
  }

  async registrationCaptcha(ip: string) {
    await this.limit('registration-captcha-ip', ip, 40, 900);
    return createRegistrationCaptcha();
  }

  async registrationMode() {
    return (await this.invites.registration()).mode;
  }

  async privacyStatus() {
    const version = await policyVersion(this.db);
    return { pdPolicyVersion: version, pdRegistrationAvailable: registrationAvailable(version) };
  }

  async register(input: RegisterDto, ip: string, evidence: ConsentEvidence): Promise<ChallengeResult> {
    const { captchaToken, password, inviteCode, pdConsent, pdPolicyVersion, infoEmailConsent, ...profile } = input;
    if (pdConsent !== true) throw new BadRequestException(CONSENT_REQUIRED);
    const version = await policyVersion(this.db);
    assertRegistrationAvailable(version);
    assertPolicyVersion(version, pdPolicyVersion);
    await this.contactGuard.assertFields(undefined, 'PROFILE', { username: profile.username, city: profile.city });
    await this.limit('register-ip', ip, 12, 3600);
    const signature = await verifyRegistrationCaptcha(captchaToken);
    // A challenge can be submitted only once, even across application replicas or encoded differently.
    await this.limit('registration-captcha-used', signature, 1, CAPTCHA_TTL);

    const { mode } = await this.invites.registration();
    let invite: AvailableInvite | undefined;
    if (mode === 'INVITE' || inviteCode !== undefined) {
      await this.inviteLimit('register-invite-ip', ip, 20);
      invite = inviteCode === undefined ? undefined : await this.invites.available(inviteCode);
      if (!invite) {
        await this.inviteLimit('register-invite-bad-ip', ip, 10);
        throw new BadRequestException(INVALID_INVITE);
      }
      if (invite.preset_role && invite.preset_role !== profile.role) {
        if (profile.role === 'BOTH') {
          const side = invite.preset_role === 'SELLER' ? 'продавца' : 'покупателя';
          throw new BadRequestException(`Приглашение выдано для ${side}. Вторую сторону добавьте в профиле после входа.`);
        }
        throw new BadRequestException('Приглашение выдано для другой роли');
      }
    }

    if (profile.participantType === 'COMPANY') await assertCompanyAlias(this.db, profile.companyName, profile.username);

    const passwordHash = await hashPassword(password);
    const challenge = await this.db.transaction(async (client) => {
      await this.lockRegistrationMailbox(client, profile.email);
      await this.checkRegistrationCooldown(client, profile.email);
      const pending: PendingRegistration = await this.registeredEmail(client, profile.email)
        ? { suppressed: true }
        : {
          ...profile, passwordHash, inviteId: invite?.id, pdConsentVersion: version, pdConsentAt: evidence.at.toISOString(),
          consentIp: evidence.ip, consentUserAgent: evidence.userAgent, infoEmailConsent: infoEmailConsent === true,
        };
      return this.insertChallenge(client, 'REGISTER', profile.email, null, pending, null);
    });
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
    if (!(await passwordMatches(input.password, user?.password_hash ?? DUMMY_PASSWORD_HASH)) || !user ||
        (!user.email_verified_at && !canConfirmModeratorEmail(user))) {
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
    const challenge = await this.db.transaction((client) => this.insertChallenge(
      client, 'LOGIN', user.email, user.id, null, user.credential_version,
    ));
    return this.deliverChallenge(challenge);
  }

  async resend(id: string, ip: string): Promise<ChallengeResult> {
    await this.limit('resend-ip', ip, 15, 3600);
    const existing = (await this.db.query<ChallengeRow>('SELECT * FROM email_challenges WHERE id = $1', [id])).rows[0];
    if (!existing) throw new BadRequestException(INVALID_CODE);
    const newChallenge = await this.db.transaction(async (client) => {
      if (existing.purpose === 'REGISTER') await this.lockRegistrationMailbox(client, existing.email);
      const { rows } = await client.query<ChallengeRow>('SELECT * FROM email_challenges WHERE id = $1 FOR UPDATE', [id]);
      const challenge = rows[0];
      if (!challenge || challenge.consumed_at || !challenge.delivered_at || challenge.attempts >= OTP_ATTEMPTS ||
          challenge.expires_at.getTime() + OTP_TTL * 1000 < Date.now()) {
        throw new BadRequestException(INVALID_CODE);
      }
      if (challenge.resend_at.getTime() > Date.now()) {
        throw new HttpException(REGISTRATION_COOLDOWN, HttpStatus.TOO_MANY_REQUESTS);
      }
      let pending = challenge.pending_registration;
      if (challenge.purpose === 'REGISTER') {
        await this.checkRegistrationCooldown(client, challenge.email);
        if (await this.registeredEmail(client, challenge.email)) pending = { suppressed: true };
      } else {
        const valid = await client.query(`
          SELECT 1 FROM users WHERE id = $1 AND email = $2 AND status = 'ACTIVE' AND credential_version = $3
        `, [challenge.user_id, challenge.email, challenge.credential_version]);
        if (!valid.rowCount) throw new BadRequestException(INVALID_CODE);
      }
      await client.query('UPDATE email_challenges SET consumed_at = now() WHERE id = $1', [id]);
      return this.insertChallenge(client, challenge.purpose, challenge.email, challenge.user_id,
        pending, challenge.credential_version, challenge.attempts);
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
      const pending = challenge.pending_registration;
      if (!codesMatch(id, code, challenge.code_hash) || (pending && 'suppressed' in pending)) {
        await client.query('UPDATE email_challenges SET attempts = attempts + 1 WHERE id = $1', [id]);
        return null;
      }

      let user: UserRow | undefined;
      if (challenge.purpose === 'REGISTER') {
        if (!pending || !['BUYER', 'SELLER', 'BOTH'].includes(pending.role)) return null;
        if (!pending.pdConsentVersion || !pending.pdConsentAt) {
          await client.query('DELETE FROM email_challenges WHERE id = $1', [id]);
          return { error: 'consent' } as const;
        }
        const consentAt = new Date(pending.pdConsentAt);
        const registration = await this.invites.lockRegistration(client);
        if (!pending.inviteId && registration.mode === 'INVITE') throw new ConflictException(INVITE_NO_LONGER_AVAILABLE);
        const role = pending.role === 'BUYER' ? 'BUYER' : 'SELLER';
        const tradeSides = pending.role === 'BOTH' ? ['BUY', 'SELL'] : [defaultTradeSide(role)];
        const invite = pending.inviteId ? await this.invites.lockAvailable(client, pending.inviteId, role) : null;
        if (invite?.preset_role && pending.role === 'BOTH') throw new ConflictException(INVITE_NO_LONGER_AVAILABLE);
        user = (await client.query<UserRow>(`
          INSERT INTO users (username, display_name, email, password_hash, role, participant_type,
            company_name, city, country, telegram, email_verified_at, invite_id, onboarding_state,
            pd_consent_version, pd_consent_at, info_email_consent, trade_sides)
          VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10, $11, $12, $13, $14, $15)
          ON CONFLICT DO NOTHING RETURNING *
        `, [pending.username, pending.email, pending.passwordHash, role, pending.participantType,
          pending.participantType === 'COMPANY' ? pending.companyName : null,
          pending.city, pending.country, pending.telegram.replace(/^@/, ''), invite?.id ?? null,
          registration.enabled || invite || pending.role === 'BOTH' ? 'REQUIRED' : 'EXEMPT', pending.pdConsentVersion, consentAt,
          pending.infoEmailConsent === true, tradeSides])).rows[0];
        if (user) await recordConsent(client, user.id, pending.pdConsentVersion, 'REGISTRATION',
          { at: consentAt, ip: pending.consentIp, userAgent: pending.consentUserAgent },
          { pd: true, infoEmail: pending.infoEmailConsent === true });
        if (invite && user) {
          await this.invites.consume(client, invite, user.id, user.display_name);
          if (invite.known_personally) {
            user = (await client.query<UserRow>('SELECT * FROM users WHERE id=$1', [user.id])).rows[0];
          }
        }
      } else {
        user = (await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [challenge.user_id])).rows[0];
      }

      await client.query('DELETE FROM email_challenges WHERE id = $1', [id]);
      if (!user) return { error: challenge.purpose === 'REGISTER' ? 'conflict' : 'missing' } as const;
      if (user.status !== 'ACTIVE') return { error: user.status } as const;
      // A password change invalidates codes issued with the previous credential.
      if (user.email !== challenge.email ||
          (challenge.purpose === 'LOGIN' && user.credential_version !== challenge.credential_version)) {
        return { error: 'missing' } as const;
      }
      if (!user.email_verified_at) {
        if (challenge.purpose !== 'LOGIN' || !canConfirmModeratorEmail(user)) return { error: 'missing' } as const;
        user = (await client.query<UserRow>(`
          UPDATE users SET email_verified_at = now(), updated_at = now() WHERE id = $1 RETURNING *
        `, [user.id])).rows[0];
      }
      return this.issueSession(client, user);
    });
    if (!result) throw new BadRequestException(INVALID_CODE);
    if ('token' in result) return result;
    if (result.error === 'conflict') {
      throw new ConflictException('Этот логин или адрес уже используется. Вернитесь к форме и выберите другой логин или войдите в свой аккаунт.');
    }
    if (result.error === 'missing') throw new UnauthorizedException('Запросите вход заново.');
    if (result.error === 'consent') throw new ConflictException('Подтвердите согласие и запросите код заново.');
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
      if (user?.status === 'ACTIVE' && user.email_verified_at) return this.onboarding.presentUser(user);
      if (user && user.status !== 'ACTIVE' && required) throw statusError(user.status);
    }
    if (required) throw new UnauthorizedException('Войдите в аккаунт и подтвердите почту.');
    return null;
  }

  async require(request: Request, allowPendingConsent = false): Promise<SessionUser> {
    const user = (await this.resolve(request, true))!;
    if (user.mustChangePassword) throw new ForbiddenException('Замените начальный пароль в настройках аккаунта.');
    if (!allowPendingConsent && user.pdConsentRequired && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      throw policyRequired();
    }
    return user;
  }

  async admin(request: Request): Promise<StaffSession<'ADMIN'>> {
    const user = await this.require(request);
    if (user.role !== 'ADMIN') throw new ForbiddenException('Действие доступно администратору.');
    return { ...user, role: user.role, sessionHash: hashToken(sessionToken(request)!) };
  }

  async staff(request: Request): Promise<StaffSession> {
    const user = await this.require(request);
    if (!isStaffRole(user.role)) throw new ForbiddenException('Действие доступно сотрудникам модерации.');
    return { ...user, role: user.role, sessionHash: hashToken(sessionToken(request)!) };
  }

  async participant(request: Request, allowPendingConsent = false): Promise<SessionUser<ParticipantRole>> {
    const user = await this.require(request, allowPendingConsent);
    if (isStaffRole(user.role)) throw new ForbiddenException('Действие доступно покупателям и продавцам.');
    return { ...user, role: user.role };
  }

  async changeTradeSides(request: Request, raw: unknown): Promise<SessionUser> {
    const owner = await this.participant(request);
    const values = object(raw).tradeSides;
    if (!Array.isArray(values) || values.length < 1 || values.length > 2 ||
        values.some(side => side !== 'BUY' && side !== 'SELL') || new Set(values).size !== values.length) {
      throw new BadRequestException('Выберите хотя бы одну сторону: покупка или продажа.');
    }
    const tradeSides = (['BUY', 'SELL'] as const).filter(side => values.includes(side));
    return this.db.transaction(async client => {
      const version = await policyVersion(client, true);
      const { rows: [current] } = await client.query<UserRow>(`
        SELECT * FROM users u WHERE id=$1 AND status='ACTIVE' AND email_verified_at IS NOT NULL
          AND role IN ('BUYER','SELLER') AND NOT must_change_password
          AND EXISTS (SELECT 1 FROM auth_sessions WHERE token_hash=$2 AND user_id=$1 AND expires_at>now())
        FOR UPDATE
      `, [owner.id, hashToken(sessionToken(request)!)]);
      if (!current) throw new ForbiddenException('Профиль недоступен.');
      if (current.pd_consent_version !== version) throw policyRequired();
      const currentSides = current.trade_sides!;
      const removed = currentSides.filter(side => !tradeSides.includes(side));
      if (removed.length && (await client.query(`
        SELECT 1 FROM listings WHERE owner_id=$1 AND kind=ANY($2::text[])
          AND status IN ('ACTIVE','HIDDEN','PENDING_REVIEW','PENDING_OWNER') LIMIT 1
      `, [owner.id, removed])).rowCount) throw new ConflictException('Сначала архивируйте объявления этого вида');
      const added = tradeSides.find(side => !currentSides.includes(side));
      const questions = onboardingGroups.find(group => group.key === (added === 'BUY' ? 'buyer' : 'seller'))?.questions ?? [];
      let addedSide: TradeSide | null = current.onboarding_added_side;
      let state = current.onboarding_state;
      if (addedSide && !tradeSides.includes(addedSide)) {
        addedSide = null;
        state = 'DONE';
      }
      if (added && questions.some(question => question.required && !current.onboarding_answers[question.id]?.trim())) {
        if (state !== 'REQUIRED') addedSide = added;
        state = 'REQUIRED';
      }
      const { rows: [updated] } = await client.query<UserRow>(`
        UPDATE users SET trade_sides=$2,onboarding_state=$3,onboarding_added_side=$4,updated_at=now()
        WHERE id=$1 RETURNING *
      `, [owner.id, tradeSides, state, addedSide]);
      return this.onboarding.presentUser(updated, client);
    });
  }

  async acceptPolicy(request: Request, input: AcceptPolicyDto, evidence: ConsentEvidence): Promise<SessionUser> {
    const owner = await this.participant(request, true);
    return this.db.transaction(async client => {
      const version = await policyVersion(client, true);
      assertPolicyVersion(version, input.pdPolicyVersion);
      const { rows: [user] } = await client.query<UserRow>(`
        UPDATE users SET pd_consent_version=$2, pd_consent_at=$3, info_email_consent=COALESCE($4,info_email_consent)
        WHERE id=$1 AND status='ACTIVE'
          AND EXISTS (SELECT 1 FROM auth_sessions WHERE token_hash=$5 AND user_id=$1 AND expires_at>now())
        RETURNING *
      `, [owner.id, version, evidence.at, input.infoEmailConsent, hashToken(sessionToken(request)!)]);
      if (!user) throw new ForbiddenException('Профиль недоступен.');
      await recordConsent(client, user.id, version, 'LOGIN', evidence, { pd: true, infoEmail: input.infoEmailConsent });
      return this.onboarding.presentUser(user, client);
    });
  }

  async createModerator(request: Request, input: CreateModeratorDto): Promise<SessionUser> {
    const owner = await this.admin(request);
    if (!strongAdminPassword(input.temporaryPassword, input.username)) {
      throw new BadRequestException('Выберите длинный непредсказуемый временный пароль, отличный от логина.');
    }
    const passwordHash = await hashPassword(input.temporaryPassword);
    try {
      return await this.db.transaction(async (client) => {
        const { rows: [actor] } = await client.query<StaffAuditActor>(`
          SELECT id, username, role FROM users WHERE id = $1 AND role = 'ADMIN' AND status = 'ACTIVE'
            AND email_verified_at IS NOT NULL AND NOT must_change_password FOR SHARE
        `, [owner.id]);
        if (!actor) throw new UnauthorizedException('Профиль изменился. Войдите снова.');
        // Check the same session after locking the actor so a concurrent credential change cannot race this write.
        const session = await client.query(`
          SELECT 1 FROM auth_sessions WHERE user_id = $1 AND token_hash = $2
            AND expires_at > clock_timestamp() FOR SHARE
        `, [owner.id, owner.sessionHash]);
        if (!session.rowCount) throw new UnauthorizedException('Сеанс завершён. Войдите снова.');

        const { rows: [created] } = await client.query<UserRow>(`
          INSERT INTO users (username, display_name, email, password_hash, role, must_change_password)
          VALUES ($1, $2, $3, $4, 'MODERATOR', true) RETURNING *
        `, [input.username, input.displayName, input.email, passwordHash]);
        await this.recordStaffAction(client, actor, created.id, 'moderator-created', {
          role: created.role, emailVerified: false, mustChangePassword: true,
        });
        return this.onboarding.presentUser(created, client);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Этот логин или адрес уже используется.');
      throw error;
    }
  }

  async logout(request: Request): Promise<void> {
    const token = sessionToken(request);
    if (!token) return;
    await this.db.transaction(async (client) => {
      const { rows: [actor] } = await client.query<StaffAuditActor & { unexpired: boolean }>(`
        DELETE FROM auth_sessions AS s USING users AS u
        WHERE s.token_hash = $1 AND s.user_id = u.id
        RETURNING u.id, u.username, u.role, (s.expires_at > now()) AS unexpired
      `, [hashToken(token)]);
      if (actor?.unexpired) await this.recordStaffAction(client, actor, actor.id, 'logout');
    });
  }

  async updateProfile(request: Request, input: ProfileDto, evidence: ConsentEvidence): Promise<SessionUser> {
    const owner = await this.require(request);
    if (owner.role === 'MODERATOR') throw new ForbiddenException('Настройки торгового профиля доступны покупателям и продавцам.');
    await this.contactGuard.assertFields(isStaffRole(owner.role) ? undefined : owner.id, 'PROFILE', {
      displayName: input.displayName, city: input.city,
    });
    if ([input.displayName, input.city].some(value => value !== undefined && !isPublicProfileText(value))) {
      throw new BadRequestException('Уберите контакты и ссылки из отображаемого имени и города.');
    }
    if (input.companyName !== undefined && owner.participantType !== 'COMPANY') {
      throw new BadRequestException('Название компании доступно только компаниям.');
    }
    if (input.infoEmailConsent !== undefined && isStaffRole(owner.role)) {
      throw new ForbiddenException('Настройка информационных писем доступна участникам.');
    }
    return this.db.transaction(async (client) => {
      let previousInfoConsent: boolean | undefined;
      if (input.companyName !== undefined || input.displayName !== undefined || input.infoEmailConsent !== undefined) {
        const { rows: [current] } = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [owner.id]);
        if (!current) throw new ForbiddenException('Профиль недоступен.');
        previousInfoConsent = current.info_email_consent;
        const name = input.companyName ?? current.company_name;
        const nickname = input.displayName ?? current.display_name;
        if (name !== current.company_name || nickname !== current.display_name) {
          await assertCompanyAlias(client, name, current.username, nickname);
        }
      }
      const { rows: [updated] } = await client.query<UserRow>(`
        UPDATE users SET
          display_name = COALESCE($2, display_name),
          city = COALESCE($3, city),
          country = COALESCE($4, country),
          telegram = COALESCE($5, telegram),
          company_name = COALESCE($6, company_name),
          notify_email = COALESCE($8, notify_email),
          info_email_consent = COALESCE($9, info_email_consent),
          updated_at = now()
        WHERE id = $1 AND status = 'ACTIVE'
          AND EXISTS (SELECT 1 FROM auth_sessions WHERE token_hash = $7 AND user_id = $1 AND expires_at > now())
        RETURNING *
      `, [owner.id, input.displayName, input.city, input.country, input.telegram?.replace(/^@/, ''), input.companyName,
        hashToken(sessionToken(request)!), input.notifyEmail, input.infoEmailConsent]);
      if (!updated) throw new ForbiddenException('Профиль недоступен.');
      if (input.infoEmailConsent !== undefined && input.infoEmailConsent !== previousInfoConsent) {
        await recordConsent(client, updated.id, owner.pdPolicyVersion, 'PROFILE', evidence, { infoEmail: input.infoEmailConsent });
      }
      await this.recordStaffAction(client, updated, updated.id, 'profile-edited', {
        fields: Object.keys(input).filter((key) => input[key as keyof ProfileDto] !== undefined),
      });
      return this.onboarding.presentUser(updated, client);
    });
  }

  async changeCredentials(request: Request, input: CredentialsDto): Promise<SessionResult> {
    const owner = (await this.resolve(request, true))!;
    if (owner.pdConsentRequired) throw policyRequired();
    const token = sessionToken(request)!;
    if (input.username !== undefined && owner.role !== 'ADMIN') {
      throw new ForbiddenException('Смена логина доступна администратору.');
    }
    if (input.currentPassword === input.newPassword) {
      throw new BadRequestException('Новый пароль должен отличаться от текущего.');
    }
    if (isStaffRole(owner.role) && !strongAdminPassword(input.newPassword, input.username ?? owner.username)) {
      throw new BadRequestException('Выберите длинный непредсказуемый пароль, отличный от логина.');
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
          WHERE id = $1 AND password_hash = $4 AND credential_version = $5
            AND status = 'ACTIVE' AND email_verified_at IS NOT NULL
            AND EXISTS (SELECT 1 FROM auth_sessions WHERE token_hash = $6 AND user_id = $1 AND expires_at > now())
          RETURNING *
        `, [owner.id, passwordHash, input.username, current.password_hash, current.credential_version, hashToken(token)]);
        if (!rows[0]) throw new UnauthorizedException('Профиль изменился. Войдите снова.');
        await client.query('DELETE FROM auth_sessions WHERE user_id = $1', [owner.id]);
        await this.recordStaffAction(client, current, owner.id, 'credentials-changed', {
          usernameChanged: current.username !== rows[0].username,
        });
        return this.issueSession(client, rows[0], false);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Этот логин занят.');
      throw error;
    }
  }

  private async recordStaffAction(client: PoolClient, actor: StaffAuditActor, targetId: string,
    action: StaffAuditAction, after: Record<string, unknown> | null = null): Promise<void> {
    if (!isStaffRole(actor.role)) return;
    await client.query(`
      INSERT INTO moderation_audit (actor, actor_user_id, actor_role, entity, entity_id, action, after_data)
      VALUES ($1, $2, $3, 'users', $4, $5, $6)
    `, [actor.username, actor.id, actor.role, targetId, action, after]);
  }

  private async issueSession(client: PoolClient, user: UserRow, signingIn = true): Promise<SessionResult> {
    const token = randomBytes(32).toString('hex');
    await client.query(`
      INSERT INTO auth_sessions (token_hash, user_id, expires_at)
      VALUES ($1, $2, now() + $3::integer * interval '1 second')
    `, [hashToken(token), user.id, SESSION_TTL]);
    if (signingIn) await this.recordStaffAction(client, user, user.id, 'login');
    return { user: await this.onboarding.presentUser(user, client), token };
  }

  private async inviteLimit(namespace: string, ip: string, attempts: number): Promise<void> {
    try {
      await this.limit(namespace, ip, attempts, 3600);
    } catch (error) {
      if (!(error instanceof HttpException) || error.getStatus() !== HttpStatus.TOO_MANY_REQUESTS) throw error;
      throw new HttpException('Слишком много попыток. Попробуйте через час', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private async insertChallenge(
    client: PoolClient, purpose: ChallengePurpose, email: string, userId: string | null,
    pending: PendingRegistration | null, credentialVersion: number | null, attempts = 0,
  ): Promise<NewChallenge> {
    if (purpose === 'REGISTER') await this.limit('register-email', email, 5, 3600, client);
    else await this.limit('login-otp-email', email, 6, 3600, client);
    const id = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await client.query(`
      INSERT INTO email_challenges (id, purpose, email, code_hash, user_id, pending_registration, credential_version, expires_at, resend_at, attempts)
      VALUES ($1, $2, $3, $4, $5, $6, $7, now() + $8::integer * interval '1 second', now() + $9::integer * interval '1 second', $10)
    `, [id, purpose, email, hashCode(id, code), userId, pending, credentialVersion, OTP_TTL, RESEND_DELAY, attempts]);
    return { id, code: pending && 'suppressed' in pending ? null : code, email, purpose };
  }

  private async deliverChallenge(challenge: NewChallenge): Promise<ChallengeResult> {
    try {
      if (challenge.code) await this.mail.sendCode(challenge.email, challenge.code, OTP_TTL / 60, challenge.purpose);
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

  private async lockRegistrationMailbox(client: PoolClient, email: string): Promise<void> {
    // Different requests for the same mailbox share a cooldown, including across application processes.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7723904))', [email]);
  }

  private async checkRegistrationCooldown(client: PoolClient, email: string): Promise<void> {
    const { rows } = await client.query<{ exists: boolean }>(`
      SELECT EXISTS(
        SELECT 1 FROM email_challenges WHERE purpose = 'REGISTER' AND email = $1
          AND consumed_at IS NULL AND resend_at > now()
      ) AS exists
    `, [email]);
    if (rows[0].exists) throw new HttpException(REGISTRATION_COOLDOWN, HttpStatus.TOO_MANY_REQUESTS);
  }

  private async registeredEmail(client: PoolClient, email: string): Promise<boolean> {
    const { rows } = await client.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM users WHERE lower(email) = $1) AS exists', [email],
    );
    return rows[0].exists;
  }

  private async limit(namespace: string, key: string, limit: number, seconds: number, connection: Queryable = this.db): Promise<void> {
    const { rows } = await connection.query<{ count: number }>(`
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
