export function telegramMode(): 'webhook' | 'polling' {
  const production = process.env.NODE_ENV === 'production';
  const mode = process.env.TELEGRAM_MODE || (production ? 'webhook' : 'polling');
  if (production && mode !== 'webhook') throw new Error('TELEGRAM_MODE=webhook is required in production');
  if (mode !== 'webhook' && mode !== 'polling') throw new Error('TELEGRAM_MODE must be webhook or polling');
  return mode;
}

export function telegramToken(): string | undefined {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return undefined;
  if (!/^\d+:[\w-]{10,150}$/.test(token)) throw new Error('TELEGRAM_BOT_TOKEN is invalid');
  return token;
}

export function telegramApiOrigin(): string {
  const override = process.env.TELEGRAM_BOT_API_TEST_ORIGIN;
  if (!override) return 'https://api.telegram.org';
  if (process.env.NODE_ENV !== 'test') throw new Error('TELEGRAM_BOT_API_TEST_ORIGIN is for tests only');
  const url = new URL(override);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('TELEGRAM_BOT_API_TEST_ORIGIN must be a loopback HTTP origin');
  }
  return url.origin;
}

export function checkTelegramConfig(): void {
  const token = telegramToken();
  const mode = telegramMode();
  const origin = telegramApiOrigin();
  if (token && mode === 'webhook') {
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(process.env.TELEGRAM_WEBHOOK_SECRET ?? '')) {
      throw new Error('TELEGRAM_WEBHOOK_SECRET must contain 32 to 256 URL-safe characters');
    }
    if (origin === 'https://api.telegram.org' && !process.env.APP_ORIGIN?.startsWith('https://')) {
      throw new Error('An HTTPS APP_ORIGIN is required for the Telegram webhook');
    }
  }
}
