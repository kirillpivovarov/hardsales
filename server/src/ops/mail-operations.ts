import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { isEmail } from 'class-validator';
import type { StaffSession } from '../auth/auth.types';
import { MailService, mailErrorText } from '../auth/mail.service';
import { DatabaseService } from '../database/database.service';
import { auditExchange } from '../exchange/audit';
import { lockTrustStaff } from '../exchange/trust-access';
import { object, oneOf, pageParams, str } from '../market/market.inputs';

const states = ['SENT', 'PENDING', 'FAILED', 'SKIPPED'] as const;
const sources = ['deliveries', 'outbox'] as const;
const tables = { deliveries: 'notification_deliveries', outbox: 'exchange_email_outbox' } as const;

@Injectable()
export class MailOperations {
  constructor(private readonly db: DatabaseService, private readonly mail: MailService) {}

  async queue(actor: StaffSession, params: Record<string, unknown>) {
    const source = oneOf(params.source ?? 'deliveries', sources, 'Очередь');
    const status = params.status ? oneOf(params.status, states, 'Статус') : null;
    const kind = params.kind ? str(params.kind, 'Вид уведомления', 1, 64) : null;
    const from = this.parseDate(params.from, false);
    const to = this.parseDate(params.to, true);
    if (from && to && from >= to) throw new BadRequestException('Укажите корректный период');
    const { page, limit, offset } = pageParams(params);
    const query = source === 'deliveries' ? `
      SELECT d.id,n.created_at,d.last_attempt_at,n.kind,u.email AS recipient,
        d.channel,d.status,d.attempts,d.next_attempt_at,d.error
      FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id JOIN users u ON u.id=n.user_id
    ` : `
      SELECT id,created_at,last_attempt_at,
        CASE WHEN split_part(dedupe_key,':',1) ~ '^[a-z][a-z_.]{2,63}$' THEN split_part(dedupe_key,':',1)
          ELSE 'company.letter' END AS kind,recipient,'EMAIL' AS channel,status,attempts,next_attempt_at,error
      FROM exchange_email_outbox
    `;
    const matches = `WHERE ($1::text IS NULL OR status=$1) AND ($2::text IS NULL OR kind=$2)
      AND ($3::timestamptz IS NULL OR created_at >= $3) AND ($4::timestamptz IS NULL OR created_at < $4)`;
    const filters = [status, kind, from, to];
    const [items, total, summary, kinds] = await Promise.all([
      this.db.query(`SELECT id,created_at AS "createdAt",last_attempt_at AS "lastAttemptAt",kind,
        CASE WHEN $7 THEN recipient WHEN strpos(recipient,'@')>1 THEN left(recipient,1)||'***@'||split_part(recipient,'@',2)
          ELSE '***' END AS recipient,channel,status,attempts,next_attempt_at AS "nextAttemptAt",error
        FROM (${query}) mail ${matches} ORDER BY id DESC LIMIT $5 OFFSET $6`, [...filters, limit, offset, actor.role === 'ADMIN']),
      this.db.query<{ count: number }>(`SELECT count(*)::int AS count FROM (${query}) mail ${matches}`, filters),
      this.db.query<{ status: string; count: number }>(`
        SELECT status,count(*)::int AS count FROM (${query}) mail WHERE created_at>=now()-interval '24 hours' GROUP BY status
      `),
      this.db.query<{ kind: string }>(`SELECT DISTINCT kind FROM (${query}) mail ORDER BY kind LIMIT 100`),
    ]);
    return { items: items.rows, total: total.rows[0].count, page, limit, source,
      summary: Object.fromEntries(states.map(state => [state, summary.rows.find(row => row.status === state)?.count ?? 0])),
      kinds: kinds.rows.map(row => row.kind) };
  }

  async retry(actor: StaffSession, sourceInput: string, id: string) {
    const source = oneOf(sourceInput, sources, 'Очередь');
    if (!/^[1-9]\d{0,17}$/.test(id)) throw new BadRequestException('Некорректный номер письма');
    return this.db.transaction(async client => {
      await lockTrustStaff(client, actor);
      const { rows: [entry] } = await client.query<{ status: string }>(
        'SELECT status FROM ' + tables[source] + ' WHERE id=$1 FOR UPDATE', [id],
      );
      if (!entry) throw new NotFoundException('Письмо не найдено');
      if (entry.status !== 'FAILED') throw new ConflictException('Повторить можно только неудачную отправку');
      const { rows: [updated] } = await client.query(
        `UPDATE ${tables[source]} SET status='PENDING',attempts=0,error=NULL,next_attempt_at=now()
         WHERE id=$1 RETURNING id,status,attempts,next_attempt_at AS "nextAttemptAt"`, [id],
      );
      await auditExchange(client, actor, 'mail_queue', source + ':' + id, 'retry', { status: entry.status }, { status: updated.status });
      return updated;
    });
  }

  async test(actor: StaffSession<'ADMIN'>, raw: unknown) {
    const to = str(object(raw).to, 'Электронная почта', 3, 254).toLowerCase();
    if (!isEmail(to)) throw new BadRequestException('Укажите корректный адрес электронной почты');
    await this.db.transaction(async client => {
      await lockTrustStaff(client, actor);
      const claimed = await client.query(`
        UPDATE ops_status SET last_test_mail_at=now(),test_mail_ok=false
        WHERE singleton AND (last_test_mail_at IS NULL OR last_test_mail_at <= now()-interval '10 seconds') RETURNING singleton
      `);
      if (!claimed.rowCount) throw new HttpException('Подождите 10 секунд перед следующей отправкой', 429);
    });
    let error: string | undefined;
    try {
      await this.mail.sendMessage(to, 'hwforai: тест почты', 'Тестовое письмо для проверки доставки с площадки hwforai.');
    } catch (cause) { error = mailErrorText(cause); }
    await this.db.transaction(async client => {
      await client.query('UPDATE ops_status SET test_mail_ok=$1 WHERE singleton', [!error]);
      await auditExchange(client, actor, 'mail_queue', 'test', 'test_mail', null, { ok: !error });
    });
    return { ok: !error, ...(error ? { error } : {}) };
  }

  private parseDate(raw: unknown, inclusive: boolean) {
    if (raw === undefined || raw === '') return null;
    if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new BadRequestException('Укажите дату в формате ГГГГ-ММ-ДД');
    }
    const date = new Date(raw);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
      throw new BadRequestException('Укажите корректную дату');
    }
    return inclusive ? new Date(date.getTime() + 86_400_000) : date;
  }
}
