import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const scryptOptions = { N: 32_768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const OTP_SECRET = process.env.OTP_SECRET || randomBytes(32).toString('hex');

function stretch(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, scryptOptions, (error, key) => error ? reject(error) : resolve(key));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await stretch(password, salt);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function passwordMatches(password: string, digest: string): Promise<boolean> {
  const [scheme, saltHex, digestHex] = digest.split('$');
  if (scheme !== 'scrypt' || !/^[0-9a-f]{32}$/.test(saltHex ?? '') || !/^[0-9a-f]{128}$/.test(digestHex ?? '')) return false;
  const hash = await stretch(password, Buffer.from(saltHex, 'hex'));
  return timingSafeEqual(hash, Buffer.from(digestHex, 'hex'));
}

export function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashCode(id: string, code: string): string {
  return createHmac('sha256', OTP_SECRET).update(id).update('.').update(code).digest('hex');
}

export function codesMatch(id: string, code: string, digest: string): boolean {
  return timingSafeEqual(Buffer.from(hashCode(id, code), 'hex'), Buffer.from(digest, 'hex'));
}
