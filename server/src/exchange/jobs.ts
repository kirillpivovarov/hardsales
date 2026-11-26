import { Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService, type Queryable } from '../database/database.service';
import { pageParams, str } from '../market/market.inputs';
import { PlatformSettings } from './platform-settings';

export type ExchangeClock = { now: Date; timezone: string; day: string; hour: number };
type JobResult = Record<string, unknown> | void;
type ExchangeJob = {
  name: string;
  lock: number;
  slot?: (clock: ExchangeClock) => string | null;
  run: (client: PoolClient, clock: ExchangeClock, slot?: string) => Promise<JobResult>;
  enabled?: () => Promise<boolean>;
  maxAttempts?: number;
  minRetryMs?: number;
};

@Injectable()
export class ExchangeJobs implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly jobs = new Map<string, ExchangeJob>();
  private readonly logger = new Logger(ExchangeJobs.name);
  private timer?: NodeJS.Timeout;
  private startup?: NodeJS.Timeout;
  private ticking: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly db: DatabaseService, private readonly settings: PlatformSettings) {}

  register(job: ExchangeJob): void {
    if (this.jobs.has(job.name)) throw new Error('Duplicate exchange job ' + job.name);
    this.jobs.set(job.name, job);
  }

  onApplicationBootstrap(): void {
    this.register({ name: 'platform.cleanup', lock: 19, slot: clock => clock.day, run: async client => {
      await client.query("DELETE FROM job_runs WHERE started_at < now() - interval '90 days'");
      await client.query("DELETE FROM action_tokens WHERE expires_at < now() - interval '30 days'");
      await client.query("DELETE FROM exchange_email_outbox WHERE status <> 'PENDING' AND created_at < now() - interval '90 days'");
      await client.query("UPDATE data_requests SET export_content=NULL WHERE export_content IS NOT NULL AND export_expires_at <= now()");
      await client.query('DELETE FROM telegram_dialogs WHERE expires_at <= now()');
      await client.query("DELETE FROM telegram_updates WHERE received_at < now()-interval '7 days'");
      await client.query("DELETE FROM telegram_delivery_recipient_limits WHERE sent_at < now()-interval '24 hours'");
      await client.query("DELETE FROM telegram_delivery_rate_window WHERE sent_at < now()-interval '1 hour'");
    } });
    const tick = () => {
      if (this.closed || this.ticking) return;
      this.ticking = this.tick().catch(() => this.logger.warn('Exchange job tick failed')).finally(() => { this.ticking = null; });
    };
    this.startup = setTimeout(tick, 100);
    this.timer = setInterval(tick, 60_000);
    this.startup.unref();
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    clearTimeout(this.startup);
    await this.ticking;
  }

  async clock(client?: Queryable): Promise<ExchangeClock> {
    const timezone = await this.settings.get<string>('timezone', client);
    const { rows: [clock] } = await (client ?? this.db).query<{ now: Date; day: string; hour: number }>(`
      SELECT now() AS now, (now() AT TIME ZONE $1)::date::text AS day,
        extract(hour FROM now() AT TIME ZONE $1)::int AS hour
    `, [timezone]);
    return { ...clock, timezone };
  }

  async runNow(name: string, slotOverride?: string) {
    const job = this.jobs.get(name);
    if (!job) throw new NotFoundException('Задача не найдена');
    if (job.enabled && !await job.enabled()) return { jobRunId: null, status: 'SKIPPED' };
    const clock = await this.clock();
    return this.run(job, clock, slotOverride ?? job.slot?.(clock) ?? clock.day);
  }

  async history(query: Record<string, unknown>) {
    const { page, limit, offset } = pageParams(query);
    const job = query.job === undefined ? null : str(query.job, 'Задача', 1, 80);
    const [items, count] = await Promise.all([
      this.db.query(`
        SELECT id, job, slot, status, attempts, started_at AS "startedAt", finished_at AS "finishedAt", stats, error
        FROM job_runs WHERE ($1::text IS NULL OR job=$1) ORDER BY id DESC LIMIT $2 OFFSET $3
      `, [job, limit, offset]),
      this.db.query<{ total: number }>('SELECT count(*)::int AS total FROM job_runs WHERE ($1::text IS NULL OR job=$1)', [job]),
    ]);
    return { items: items.rows, page, limit, total: count.rows[0].total };
  }

  private async tick(): Promise<void> {
    const clock = await this.clock();
    for (const job of this.jobs.values()) {
      if (this.closed) return;
      const slot = job.slot?.(clock) ?? null;
      if (job.slot && !slot) continue;
      try {
        if (job.enabled && !await job.enabled()) continue;
        await this.run(job, clock, slot);
      } catch {
        this.logger.warn('Exchange job failed: ' + job.name);
      }
    }
  }

  private run(job: ExchangeJob, clock: ExchangeClock, slot: string | null) {
    return this.db.transaction(async client => {
      const { rows: [lock] } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock(18403,$1) AS locked', [job.lock],
      );
      if (!lock.locked) return { jobRunId: null, status: 'SKIPPED' };
      if (slot === null) {
        await job.run(client, clock);
        return { jobRunId: null, status: 'DONE' };
      }
      const { rows: [entry] } = await client.query<{ id: string; status: string; started: boolean }>(`
        WITH run AS (
          INSERT INTO job_runs (job,slot,status) VALUES ($1,$2,'RUNNING')
          ON CONFLICT (job,slot) DO UPDATE SET status='RUNNING', started_at=now(), finished_at=NULL,
            error=NULL, attempts=job_runs.attempts+1
          WHERE job_runs.status='FAILED' AND job_runs.attempts < $3
            AND (job_runs.retry_at IS NULL OR job_runs.retry_at <= now())
          RETURNING id,status
        )
        SELECT id,status,true AS started FROM run
        UNION ALL SELECT id,status,false FROM job_runs WHERE job=$1 AND slot=$2 AND NOT EXISTS (SELECT 1 FROM run)
      `, [job.name, slot, job.maxAttempts ?? 5]);
      if (!entry?.started) return { jobRunId: entry?.id ?? null, status: entry?.status ?? 'SKIPPED' };
      await client.query('SAVEPOINT exchange_job');
      let result: Exclude<JobResult, void> = {};
      try {
        result = (await job.run(client, clock, slot)) ?? {};
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT exchange_job');
        result = { jobStatus: 'FAILED' };
      }
      const { jobStatus, retryAfterMs, ...stats } = result;
      const status = jobStatus === 'FAILED' || jobStatus === 'SKIPPED' ? jobStatus : 'DONE';
      const retry = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) ? retryAfterMs : 0;
      await client.query(`
        UPDATE job_runs SET status=$2, finished_at=now(), stats=$3,
          error=CASE WHEN $2='FAILED' THEN 'Не удалось завершить задачу' END,
          retry_at=CASE WHEN $2='FAILED' THEN now()+$4::float8*interval '1 millisecond' END
        WHERE id=$1
      `, [entry.id, status, JSON.stringify(stats), Math.max(retry, job.minRetryMs ?? 60_000)]);
      return { jobRunId: entry.id, status, ...stats };
    });
  }
}
