export type Role = 'BUYER' | 'SELLER' | 'ADMIN';
export type ParticipantType = 'INDIVIDUAL' | 'COMPANY';
export type UserStatus = 'ACTIVE' | 'FROZEN' | 'BANNED';

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
}

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: Role;
  participantType: ParticipantType | null;
  companyName: string | null;
  city: string | null;
  country: string | null;
  telegram: string | null;
  status: UserStatus;
  emailVerified: boolean;
  mustChangePassword: boolean;
}

export function sessionUser(row: UserRow): SessionUser {
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
  };
}
