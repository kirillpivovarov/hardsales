export type ParticipantRole = 'BUYER' | 'SELLER';
export type StaffRole = 'ADMIN' | 'MODERATOR';
export type Role = ParticipantRole | StaffRole;
export type ParticipantType = 'INDIVIDUAL' | 'COMPANY';
export type UserStatus = 'ACTIVE' | 'FROZEN' | 'BANNED';
export type RepresentationMode = 'DIRECT' | 'AGENT' | 'BOTH';
export type OnboardingState = 'REQUIRED' | 'DONE' | 'EXEMPT';

export function isStaffRole(role: Role): role is StaffRole {
  return role === 'ADMIN' || role === 'MODERATOR';
}

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  email: string;
  password_hash: string;
  role: Role;
  participant_type: ParticipantType | null;
  company_name: string | null;
  city: string | null;
  country: string | null;
  telegram: string | null;
  status: UserStatus;
  email_verified_at: Date | null;
  must_change_password: boolean;
  credential_version: number;
  representation_mode: RepresentationMode;
  onboarding_state: OnboardingState;
  onboarding_answers: Record<string, string>;
  onboarding_submitted_at: Date | null;
  rules_accepted_version: string | null;
  notify_email: boolean;
  pd_consent_version: string | null;
  pd_consent_at: Date | null;
  info_email_consent: boolean;
}

export interface SessionUser<R extends Role = Role> {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: R;
  participantType: ParticipantType | null;
  companyName: string | null;
  city: string | null;
  country: string | null;
  telegram: string | null;
  status: UserStatus;
  emailVerified: boolean;
  mustChangePassword: boolean;
  representationMode: RepresentationMode;
  onboardingState: OnboardingState;
  rulesAcceptedVersion: string | null;
  rulesVersion: string;
  rulesRequired: boolean;
  notifyEmail: boolean;
  pdPolicyVersion: string;
  pdConsentVersion: string | null;
  pdConsentAt: Date | null;
  pdConsentRequired: boolean;
  infoEmailConsent: boolean;
}

/** Server-side authorization context; never return this through a public response. */
export type StaffSession<R extends StaffRole = StaffRole> = SessionUser<R> & { sessionHash: string };

export function sessionUser(row: UserRow, rulesVersion: string, rulesEnabled: boolean, pdPolicyVersion: string): SessionUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    participantType: row.participant_type,
    companyName: row.company_name,
    city: row.city,
    country: row.country,
    telegram: row.telegram,
    status: row.status,
    emailVerified: row.email_verified_at !== null,
    mustChangePassword: row.must_change_password,
    representationMode: row.representation_mode,
    onboardingState: row.onboarding_state,
    rulesAcceptedVersion: row.rules_accepted_version,
    rulesVersion,
    rulesRequired: rulesEnabled && !isStaffRole(row.role) && row.rules_accepted_version !== rulesVersion,
    notifyEmail: row.notify_email,
    pdPolicyVersion,
    pdConsentVersion: row.pd_consent_version,
    pdConsentAt: row.pd_consent_at,
    pdConsentRequired: !isStaffRole(row.role) && row.pd_consent_version !== pdPolicyVersion,
    infoEmailConsent: row.info_email_consent,
  };
}
