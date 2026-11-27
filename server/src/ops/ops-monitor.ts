import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { PlatformSettings } from '../exchange/platform-settings';
import { object } from '../market/market.inputs';

type Status = {
  failedJobsLastHour: number;
  oldestPendingEmailMinutes: number | null;
  failedEmailsLastHour: number;
  lastBackupAgeHours: number | null;
  diskFreePercent: number | null;
  backupOk: boolean | null;
  restoreOk: boolean | null;
  restoreAgeHours: number | null;
  diskStale: boolean;
};

@Injectable()
export class OpsMonitor {
  constructor(private readonly db: DatabaseService, private readonly settings: PlatformSettings) {}

  requireToken(header?: string) {
    const token = process.env.OPS_MONITOR_TOKEN;
    if (!token || token.length < 32) throw new NotFoundException();
    const actual = Buffer.from(header ?? '');
    const expected = Buffer.from('Bearer ' + token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new UnauthorizedException();
  }

  async status() {
    const { rows: [metrics] } = await this.db.query<Status>(`
      WITH mail AS (
        SELECT status,n.created_at AS created,d.last_attempt_at AS attempted
        FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id
        WHERE d.channel='EMAIL' AND d.status IN ('PENDING','FAILED')
        UNION ALL
        SELECT status,created_at,last_attempt_at FROM exchange_email_outbox WHERE status IN ('PENDING','FAILED')
      )
      SELECT
        (SELECT count(*)::int FROM job_runs WHERE status='FAILED' AND finished_at>=now()-interval '1 hour') AS "failedJobsLastHour",
        (SELECT floor(extract(epoch FROM now()-min(created)) / 60)::int FROM mail WHERE status='PENDING') AS "oldestPendingEmailMinutes",
        (SELECT count(*)::int FROM mail WHERE status='FAILED' AND attempted>=now()-interval '1 hour') AS "failedEmailsLastHour",
        round(extract(epoch FROM now()-last_backup_at)/3600,1)::float8 AS "lastBackupAgeHours",
        disk_free_percent::float8 AS "diskFreePercent",last_backup_ok AS "backupOk",
        last_restore_ok AS "restoreOk",round(extract(epoch FROM now()-last_restore_at)/3600,1)::float8 AS "restoreAgeHours",
        COALESCE(disk_checked_at < now()-interval '26 hours',true) AS "diskStale"
      FROM ops_status WHERE singleton
    `);
    const alerts = await this.settings.get<{ failedEmailsPerHour: number }>('ops_alerts');
    const ok = metrics.failedJobsLastHour === 0 && (metrics.oldestPendingEmailMinutes ?? 0) <= 30 &&
      metrics.failedEmailsLastHour <= alerts.failedEmailsPerHour && metrics.lastBackupAgeHours !== null &&
      metrics.lastBackupAgeHours <= 26 && metrics.backupOk === true && metrics.diskFreePercent !== null &&
      metrics.diskFreePercent >= 15 && !metrics.diskStale;
    const { backupOk, restoreOk, restoreAgeHours, diskStale, ...publicMetrics } = metrics;
    return { ok, ...publicMetrics, backupReady: backupOk === true && restoreOk === true &&
      (metrics.lastBackupAgeHours ?? Infinity) <= 26 && (restoreAgeHours ?? Infinity) <= 192 };
  }

  async report(input: unknown) {
    const data = object(input);
    const kind = data.kind ?? 'BACKUP';
    const finishedAt = typeof data.finishedAt === 'string' ? new Date(data.finishedAt) : new Date(NaN);
    if ((kind !== 'BACKUP' && kind !== 'RESTORE') || typeof data.ok !== 'boolean' ||
      !Number.isFinite(finishedAt.getTime()) || finishedAt.getTime() > Date.now() + 300_000 ||
      (data.sizeBytes !== undefined && (typeof data.sizeBytes !== 'number' || !Number.isSafeInteger(data.sizeBytes) || data.sizeBytes < 0)) ||
      (data.diskFreePercent !== undefined && (typeof data.diskFreePercent !== 'number' || !Number.isFinite(data.diskFreePercent) ||
        data.diskFreePercent < 0 || data.diskFreePercent > 100))) {
      throw new BadRequestException('Некорректный отчёт о резервной копии');
    }
    if (kind === 'RESTORE') {
      await this.db.query(`
        UPDATE ops_status SET last_restore_ok=$1,last_restore_report_at=$2,last_restore_at=CASE WHEN $1 THEN $2 ELSE last_restore_at END
        WHERE singleton AND (last_restore_report_at IS NULL OR last_restore_report_at <= $2)
      `, [data.ok, finishedAt]);
      return;
    }
    await this.db.query(`
      UPDATE ops_status SET last_backup_ok=$1,last_backup_report_at=$2,
        last_backup_at=CASE WHEN $1 THEN $2 ELSE last_backup_at END,
        backup_bytes=CASE WHEN $1 THEN $3 ELSE backup_bytes END,
        disk_free_percent=COALESCE($4,disk_free_percent),
        disk_checked_at=CASE WHEN $4 IS NOT NULL THEN $2 ELSE disk_checked_at END
      WHERE singleton AND (last_backup_report_at IS NULL OR last_backup_report_at <= $2)
    `, [data.ok, finishedAt, data.sizeBytes ?? null, data.diskFreePercent ?? null]);
  }
}
