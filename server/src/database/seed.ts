import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isEmail } from 'class-validator';
import type { PoolClient } from 'pg';
import { hashPassword, strongAdminPassword } from '../auth/auth.crypto';
import { USERNAME_PATTERN } from '../auth/auth.dto';
import { demoMode, isProduction } from '../config';
import { policyVersion, recordConsent } from '../privacy/policy';
import { DatabaseService } from './database.service';

const DEMO_SELLER = '00000000-0000-4000-8000-000000000001';
const DEMO_BUYER = '00000000-0000-4000-8000-000000000002';
const DEMO_ADMIN = '00000000-0000-4000-8000-000000000003';
const DEMO_AGENT = '00000000-0000-4000-8000-000000000004';

async function seedExchangeFile(client: PoolClient, name: 'exchange' | 'exchange-features'): Promise<void> {
  const marker = `seed:demo-${name}`;
  const existing = await client.query('SELECT 1 FROM schema_migrations WHERE file_name = $1', [marker]);
  if (existing.rowCount) return;

  let sql: string;
  try {
    sql = await readFile(resolve(__dirname, `../../seeds/${name}.sql`), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await client.query(sql);
  await client.query(
    "INSERT INTO schema_migrations (file_name, checksum) VALUES ($1, repeat('0', 64))", [marker],
  );
}

async function seedDemoExchange(client: PoolClient): Promise<void> {
  const enableFeatures = process.env.EXCHANGE_DEMO_FEATURES === 'true';
  await client.query("SELECT set_config('hwforai.demo_exchange', $1, true)", [enableFeatures ? 'on' : 'off']);
  await seedExchangeFile(client, 'exchange');
  if (enableFeatures) await seedExchangeFile(client, 'exchange-features');

  // Only the fixed synthetic accounts get consent at initialization. A later policy version still requires acceptance.
  const version = await policyVersion(client);
  const at = new Date();
  const { rows } = await client.query<{ id: string }>(`
    UPDATE users SET pd_consent_version=$1, pd_consent_at=$2
    WHERE id=ANY($3::uuid[]) AND pd_consent_version IS NULL RETURNING id
  `, [version, at, [DEMO_SELLER, DEMO_BUYER, DEMO_AGENT]]);
  for (const { id } of rows) {
    await recordConsent(client, id, version, 'MIGRATION', { at, ip: null, userAgent: null }, { pd: true, infoEmail: false });
  }
}

export async function seedConfiguredUsers(database: DatabaseService): Promise<void> {
  await database.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(18403, 2)');
    const { rows: [admin] } = await client.query<{
      id: string; status: string; email_verified_at: Date | null;
    }>("SELECT id, status, email_verified_at FROM users WHERE role = 'ADMIN'");
    if (demoMode()) {
      if (admin && admin.id !== DEMO_ADMIN) throw new Error('DEMO_MODE requires a separate database');
      const { rows: seeded } = await client.query(
        'SELECT 1 FROM schema_migrations WHERE file_name = $1', ['seed:demo-market'],
      );
      if (seeded.length) {
        if (!admin) throw new Error('The seeded demo administrator is missing');
        await seedDemoExchange(client);
        return;
      }

      const demoUsers = [
        { id: DEMO_SELLER, username: 'test1', displayName: 'TechSupply', role: 'SELLER', city: 'Москва', company: 'ТехСапплай', telegram: 'hwforai_demo_seller' },
        { id: DEMO_BUYER, username: 'test2', displayName: 'ComputeLab', role: 'BUYER', city: 'Новосибирск', company: 'КомпьютЛаб', telegram: 'hwforai_demo_buyer' },
        { id: DEMO_ADMIN, username: 'admin', displayName: 'Администратор', role: 'ADMIN', city: null, company: null, telegram: null },
      ];

      for (const user of demoUsers) {
        await client.query(`
          INSERT INTO users (id, username, display_name, email, password_hash, role, participant_type,
            company_name, city, country, telegram, email_verified_at, must_change_password)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), $12)
          ON CONFLICT (id) DO NOTHING
        `, [user.id, user.username, user.displayName, `${user.username}@example.test`,
          await hashPassword(user.username), user.role, user.company ? 'COMPANY' : null,
          user.company, user.city, user.city ? 'RU' : null, user.telegram, user.role === 'ADMIN']);
      }

      const demoSql = await readFile(resolve(__dirname, '../../seeds/market.sql'), 'utf8');
      await client.query(demoSql);
      await client.query(
        "INSERT INTO schema_migrations (file_name, checksum) VALUES ($1, repeat('0', 64))", ['seed:demo-market'],
      );
      await seedDemoExchange(client);
      return;
    }

    if (isProduction()) {
      const demo = await client.query('SELECT 1 FROM users WHERE id = ANY($1::uuid[]) LIMIT 1', [[DEMO_SELLER, DEMO_BUYER, DEMO_ADMIN]]);
      if (demo.rowCount) throw new Error('Use a database without demo accounts for production');
      if (admin && (admin.status !== 'ACTIVE' || !admin.email_verified_at)) {
        throw new Error('The production administrator must be active and have a verified email');
      }
    }

    if (admin) return;

    const username = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim() || 'admin';
    const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    if (!email && !password && !isProduction()) return;
    if (!USERNAME_PATTERN.test(username) || !email || email.length > 254 || !isEmail(email) || !password ||
        !strongAdminPassword(password, username)) {
      throw new Error('Configure a valid BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_EMAIL and a strong 12–128 character BOOTSTRAP_ADMIN_PASSWORD');
    }
    await client.query(`
      INSERT INTO users (username, display_name, email, password_hash, role, email_verified_at, must_change_password)
      VALUES ($1, 'Администратор', $2, $3, 'ADMIN', now(), true)
    `, [username, email, await hashPassword(password)]);
  });
}
