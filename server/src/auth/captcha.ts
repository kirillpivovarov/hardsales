import { BadRequestException } from '@nestjs/common';
import type { Payload } from 'altcha-lib' with { 'resolution-mode': 'import' };
import { randomInt } from 'node:crypto';
import { registrationCaptchaSecret } from './auth.crypto';

export const CAPTCHA_TTL = 300;
const ALGORITHM = 'PBKDF2/SHA-256';
const library = Promise.all([import('altcha-lib'), import('altcha-lib/algorithms/pbkdf2')]);

export async function createRegistrationCaptcha() {
  const [{ createChallenge }, { deriveKey }] = await library;
  return createChallenge({
    algorithm: ALGORITHM,
    cost: 1_000,
    counter: randomInt(800, 1_601),
    expiresAt: new Date(Date.now() + CAPTCHA_TTL * 1_000),
    hmacSignatureSecret: registrationCaptchaSecret,
    deriveKey,
  });
}

export async function verifyRegistrationCaptcha(token: string): Promise<string> {
  try {
    const { challenge, solution } = JSON.parse(Buffer.from(token, 'base64').toString('utf8')) as Payload;
    if (challenge?.parameters?.algorithm === ALGORITHM && Number.isSafeInteger(challenge.parameters.expiresAt) &&
        /^[a-f0-9]{64}$/.test(challenge.signature ?? '')) {
      const [{ verifySolution }, { deriveKey }] = await library;
      const result = await verifySolution({
        challenge, solution, hmacSignatureSecret: registrationCaptchaSecret, deriveKey,
      });
      if (result.verified) return challenge.signature!;
    }
  } catch {
    // The browser payload is untrusted. Invalid encodings and structures use the same response.
  }
  throw new BadRequestException('Проверка CAPTCHA недействительна или истекла. Повторите проверку.');
}
