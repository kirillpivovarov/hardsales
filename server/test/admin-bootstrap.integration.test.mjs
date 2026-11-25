import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { passwordMatches } from '../dist/auth/auth.crypto.js';
import { DatabaseService } from '../dist/database/database.service.js';
import { seedConfiguredUsers } from '../dist/database/seed.js';

const connectionString = process.env.HWFORAI_ADMIN_TEST_DATABASE_URL;
const adminPassword = randomBytes(24).toString('hex');

async function withDatabase(check) {
  const schema = 'hwforai_admin_test_' + randomBytes(8).toString('hex');
  const maintenance = new pg.Pool({ connectionString });
  const isolated = new URL(connectionString);
  isolated.searchParams.set('options', `-c search_path=${schema},public`);
  process.env.DATABASE_URL = isolated.href;
  const databases = [new DatabaseService(), new DatabaseService()];
  try {
    await maintenance.query(`CREATE SCHEMA ${schema}`);
    await check(...databases);
  } finally {
    await Promise.all(databases.map(db => db.onApplicationShutdown()));
    await maintenance.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await maintenance.end();
  }
}

const duplicateAdmin = { code: '23505', constraint: 'users_one_administrator' };
const accounts = db => db.query('SELECT id, username, email, role, status, email_verified_at, must_change_password FROM users ORDER BY role');

async function simulateLegacyAdministratorSchema(db) {
  await db.query(`
    DROP INDEX users_one_administrator;
    ALTER TABLE moderation_audit DROP COLUMN actor_user_id;
    DELETE FROM schema_migrations WHERE file_name = '007_single_administrator.sql';
  `);
}

test('fresh and concurrent administrator bootstrap, account singleton and demo separation', {
  skip: !connectionString && 'Set HWFORAI_ADMIN_TEST_DATABASE_URL to a disposable PostgreSQL instance with schema creation rights',
}, async t => {
  process.env.NODE_ENV = 'production';
  process.env.DEMO_MODE = 'false';
  process.env.BOOTSTRAP_ADMIN_USERNAME = 'RootFixture';
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'RootFixture@example.test';

  await t.test('production rejects missing or default credentials, serializes first startup, and rejects invalid existing admin state', async () => {
    await withDatabase(async (db, replica) => {
      await Promise.all([db.migrate(), replica.migrate()]);
      delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
      await assert.rejects(seedConfiguredUsers(db), /strong 12/);
      process.env.BOOTSTRAP_ADMIN_PASSWORD = 'AdminAdminAdmin';
      await assert.rejects(seedConfiguredUsers(db), /strong 12/);
      assert.deepEqual((await accounts(db)).rows, []);

      process.env.BOOTSTRAP_ADMIN_PASSWORD = adminPassword;
      await Promise.all([seedConfiguredUsers(db), seedConfiguredUsers(replica)]);
      const seeded = (await accounts(db)).rows;
      assert.equal(seeded.length, 1);
      const [admin] = seeded;
      assert.equal(admin.username, 'RootFixture');
      assert.equal(admin.email, 'rootfixture@example.test');
      assert.equal(admin.role, 'ADMIN');
      assert.equal(admin.status, 'ACTIVE');
      assert.ok(admin.email_verified_at);
      assert.equal(admin.must_change_password, true);

      delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
      await seedConfiguredUsers(replica);
      assert.deepEqual((await accounts(db)).rows, seeded);
      await assert.rejects(db.query(`
        INSERT INTO users (username, display_name, email, password_hash, role)
        VALUES ('other_admin', 'Other admin', 'other_admin@example.test', 'fixture', 'ADMIN')
      `), duplicateAdmin);
      await db.query(`
        INSERT INTO users (username, display_name, email, password_hash, role, participant_type, city, country, telegram)
        VALUES ('customer', 'Customer', 'customer@example.test', 'fixture', 'BUYER', 'INDIVIDUAL', 'Самара', 'RU', 'customer')
      `);
      await assert.rejects(db.query("UPDATE users SET role = 'ADMIN' WHERE username = 'customer'"), duplicateAdmin);

      await db.query("UPDATE users SET status = 'FROZEN' WHERE id = $1", [admin.id]);
      await assert.rejects(seedConfiguredUsers(db), /active and have a verified email/);
      await db.query("UPDATE users SET status = 'ACTIVE', email_verified_at = NULL WHERE id = $1", [admin.id]);
      await assert.rejects(seedConfiguredUsers(db), /active and have a verified email/);

      await simulateLegacyAdministratorSchema(db);
      await db.query("UPDATE users SET role = 'ADMIN' WHERE username = 'customer'");
      await assert.rejects(db.migrate(), /Multiple administrator accounts found/);
      assert.equal((await accounts(db)).rows.filter(user => user.role === 'ADMIN').length, 2);
    });
  });

  await t.test('demo keeps the initial administrator credentials across migration and is rejected in production', async () => {
    await withDatabase(async (db, replica) => {
      await db.migrate();
      process.env.NODE_ENV = 'development';
      process.env.DEMO_MODE = 'true';
      await Promise.all([seedConfiguredUsers(db), seedConfiguredUsers(replica)]);
      const seeded = (await accounts(db)).rows;
      assert.deepEqual(seeded.map(({ username, role }) => [username, role]), [
        ['admin', 'ADMIN'], ['test2', 'BUYER'], ['test1', 'SELLER'],
      ]);
      assert.ok(seeded.every(account => account.email_verified_at));
      assert.equal(seeded[0].must_change_password, true);
      const credentials = async () => (await db.query(`
        SELECT password_hash, credential_version FROM users WHERE id = $1
      `, [seeded[0].id])).rows[0];
      const initial = await credentials();
      assert.ok(await passwordMatches('admin', initial.password_hash));

      await simulateLegacyAdministratorSchema(db);
      await replica.migrate();
      await seedConfiguredUsers(replica);
      assert.deepEqual((await accounts(db)).rows, seeded);
      assert.deepEqual(await credentials(), initial);

      process.env.NODE_ENV = 'production';
      process.env.DEMO_MODE = 'false';
      await assert.rejects(seedConfiguredUsers(db), /database without demo accounts/);
      assert.deepEqual((await accounts(db)).rows, seeded);
    });
  });
});
