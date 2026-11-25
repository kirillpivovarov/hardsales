import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { registrationCaptchaSecret } from '../dist/auth/auth.crypto.js';
import { CAPTCHA_TTL, createRegistrationCaptcha, verifyRegistrationCaptcha } from '../dist/auth/captcha.js';
import { captchaForChallenge } from './captcha-helper.mjs';

test('local CAPTCHA accepts a valid solution and rejects tampering, invalid solutions and expiry', async () => {
  const now = Math.floor(Date.now() / 1000);
  const challenge = await createRegistrationCaptcha();
  assert.ok(challenge.parameters.expiresAt >= now + CAPTCHA_TTL);
  const token = await captchaForChallenge(challenge);
  assert.equal(await verifyRegistrationCaptcha(token), challenge.signature);

  const rejection = error => error.getStatus() === 400;
  const payload = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  payload.solution.counter++;
  await assert.rejects(() => verifyRegistrationCaptcha(Buffer.from(JSON.stringify(payload)).toString('base64')), rejection);

  payload.solution.counter--;
  payload.challenge.parameters.expiresAt += CAPTCHA_TTL;
  await assert.rejects(() => verifyRegistrationCaptcha(Buffer.from(JSON.stringify(payload)).toString('base64')), rejection);
  await assert.rejects(() => verifyRegistrationCaptcha('invalid-base64'), rejection);

  const expiredChallenge = await createChallenge({
    algorithm: 'PBKDF2/SHA-256',
    cost: 1_000,
    counter: 10,
    expiresAt: new Date(Date.now() - 5_000),
    hmacSignatureSecret: registrationCaptchaSecret,
    deriveKey,
  });
  const expired = await captchaForChallenge(expiredChallenge);
  await assert.rejects(() => verifyRegistrationCaptcha(expired), rejection);
});
