import assert from 'node:assert/strict';
import { solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';

export const demoRegistrationConsent = Object.freeze({ pdConsent: true, pdPolicyVersion: '0.1' });

export async function captchaForChallenge(challenge) {
  const solution = await solveChallenge({ challenge, deriveKey });
  assert.ok(solution, 'The issued registration challenge is solvable');
  return Buffer.from(JSON.stringify({ challenge, solution })).toString('base64');
}

export async function solveCaptcha(api) {
  const response = await fetch(`${api}/auth/captcha`);
  assert.equal(response.status, 200, 'The application issues registration challenges');
  assert.match(response.headers.get('cache-control'), /no-store/);
  return captchaForChallenge(await response.json());
}
