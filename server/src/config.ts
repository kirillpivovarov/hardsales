import { isAbsolute } from 'node:path';

export function flag(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (value === 'true' || value === 'false') return value === 'true';
  throw new Error(`${name} must be true or false`);
}

export function port(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} is invalid`);
  return value;
}

export const isProduction = () => process.env.NODE_ENV === 'production';
export const demoMode = () => flag('DEMO_MODE');

export function appOrigin(): string | undefined {
  const value = process.env.APP_ORIGIN;
  if (!value) return undefined;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/') {
    throw new Error('APP_ORIGIN must contain only the site origin');
  }
  return url.origin;
}

export function checkConfig(): void {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (process.env.SERVE_WEB_DIR && !isAbsolute(process.env.SERVE_WEB_DIR)) {
    throw new Error('SERVE_WEB_DIR must be an absolute path');
  }
  if (isProduction()) {
    if (demoMode()) throw new Error('DEMO_MODE is forbidden in production');
    if (!appOrigin()?.startsWith('https://')) throw new Error('An HTTPS APP_ORIGIN is required in production');
    if (!process.env.OTP_SECRET || process.env.OTP_SECRET.length < 32) {
      throw new Error('OTP_SECRET must contain at least 32 characters in production');
    }
  }
}
