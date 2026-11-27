export type TradeSide = 'BUY' | 'SELL';

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: 'BUYER' | 'SELLER' | 'ADMIN' | 'MODERATOR';
  tradeSides?: TradeSide[];
  participantType: 'COMPANY' | 'INDIVIDUAL';
  city: string;
  country: string;
  email: string;
  telegram: string;
  companyName: string | null;
  status: 'ACTIVE' | 'FROZEN' | 'BANNED';
  emailVerified: boolean;
  mustChangePassword: boolean;
  onboardingState?: 'EXEMPT' | 'REQUIRED' | 'DONE';
  representationMode?: 'DIRECT' | 'AGENT' | 'BOTH';
  rulesAcceptedVersion?: string | null;
  rulesVersion?: string;
  rulesRequired?: boolean;
  notifyEmail?: boolean;
  pdPolicyVersion?: string;
  pdConsentVersion?: string | null;
  pdConsentAt?: string | null;
  pdConsentRequired?: boolean;
  infoEmailConsent?: boolean;
}

export function isStaff(user?: User | null): boolean {
  return user?.role === 'ADMIN' || user?.role === 'MODERATOR';
}

export function tradeSidesFor(user?: User | null): TradeSide[] {
  if (!user || isStaff(user)) return [];
  return user.tradeSides ?? [user.role === 'SELLER' ? 'SELL' : 'BUY'];
}

export class ApiError extends Error {
  readonly code?: string;
  readonly field?: string;
  readonly kinds?: string[];
  readonly warning: boolean;

  constructor(public status: number, message: string, metadata?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = typeof metadata?.code === 'string' ? metadata.code : undefined;
    this.field = typeof metadata?.field === 'string' ? metadata.field : undefined;
    this.kinds = Array.isArray(metadata?.kinds) ? metadata.kinds.filter((kind): kind is string => typeof kind === 'string') : undefined;
    this.warning = metadata?.warning === true;
  }
}

export async function api<T>(path: string, options: {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
} = {}): Promise<T> {
  const { body } = options;
  const isJson = body !== undefined && !(body instanceof FormData);
  const response = await fetch('/api/v1' + path, {
    method: options.method,
    body: isJson ? JSON.stringify(body) : body,
    headers: isJson ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
    signal: options.signal,
  });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 403 && payload?.code === 'PD_CONSENT_REQUIRED') {
      window.dispatchEvent(new Event('hwforai:consent-required'));
    }
    const message = Array.isArray(payload?.message) ? payload.message.join(' · ') : payload?.message;
    const fallback = response.status === 413 ? 'Размер запроса превышает допустимый предел.' : 'Сервис временно недоступен.';
    throw new ApiError(response.status, typeof message === 'string' ? message : fallback, payload);
  }
  if (payload === null) throw new ApiError(502, 'Сервис вернул некорректный ответ.');
  return payload as T;
}
