import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

@Injectable()
export class DatabaseService implements Queryable, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5_000,
  });

  constructor() {
    this.pool.on('error', () => {
      this.logger.warn('An idle database connection closed unexpectedly');
    });
  }

  query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.pool.query<T>(sql, params);
  }

  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let unusable = false;
    try {
      await client.query('BEGIN');
      const value = await callback(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        unusable = true;
      }
      throw error;
    } finally {
      client.release(unusable);
    }
  }

  async migrate(): Promise<void> {
    const directory = resolve(__dirname, '../../migrations');
    const files = (await readdir(directory)).filter((name) => /^\d+_[-a-z\d_]+\.sql$/i.test(name)).sort();
    await this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(18403, 1)');
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          file_name text PRIMARY KEY,
          checksum char(64) NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      for (const file of files) {
        const sql = await readFile(resolve(directory, file), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        const { rows } = await client.query<{ checksum: string }>(
          'SELECT checksum FROM schema_migrations WHERE file_name = $1', [file],
        );
        if (rows[0]) {
          if (rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${file}`);
          continue;
        }
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (file_name, checksum) VALUES ($1, $2)', [file, checksum]);
      }
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
