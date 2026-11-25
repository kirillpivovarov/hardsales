export interface User {
  id: string;
  username: string;
  displayName: string;
  role: 'BUYER' | 'SELLER' | 'ADMIN';
  participantType: 'COMPANY' | 'INDIVIDUAL';
  city: string;
  country: string;
  email: string;
  telegram: string;
  companyName: string | null;
  status: 'ACTIVE' | 'FROZEN' | 'BANNED';
  emailVerified: boolean;
  mustChangePassword: boolean;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, options: {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
} = {}): Promise<T> {
  const response = await fetch('/api/v1' + path, {
    method: options.method,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    signal: options.signal,
  });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = Array.isArray(payload?.message) ? payload.message.join(' · ') : payload?.message;
    throw new ApiError(response.status, typeof message === 'string' ? message : 'Сервис временно недоступен.');
  }
  if (payload === null) throw new ApiError(502, 'Сервис вернул некорректный ответ.');
  return payload as T;
}
