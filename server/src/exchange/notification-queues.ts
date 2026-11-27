import type { Queryable } from '../database/database.service';
import { publicListingTitle, publicNickname } from '../contact-guard/public-text';
import type { ExchangeClock } from './jobs';
import type { Notification } from './notifications';

type EnqueueNotice = (client: Queryable, userId: string, notice: Notification) => Promise<string | null>;
export const staffInstantKinds = [
  'onboarding.submitted', 'verification.document_uploaded', 'deal.executed',
  'deal.amount_mismatch', 'listing.pending_review', 'dispute.opened', 'dispute.reopened',
] as const;

export const chatUnread = `SELECT count(*)::int FROM chats c JOIN chat_messages m ON m.chat_id=c.id
  WHERE (c.owner_id=$1 OR c.visitor_id=$1) AND m.sender_id<>$1
    AND m.id>CASE WHEN c.owner_id=$1 THEN c.owner_read_id ELSE c.visitor_read_id END`;

const chatAction = (chatId: string) => ({ label: 'Открыть чат', href: '/chats/' + chatId });
const messageCount = (count: number) => 'Новых сообщений: ' + count;

async function chatNotice(client: Queryable, chatId: string, senderId?: string) {
  const { rows: [notice] } = await client.query<{ title: string; nickname: string | null }>(`
    SELECT l.title,u.display_name AS nickname FROM chats c JOIN listings l ON l.id=c.listing_id
    LEFT JOIN users u ON u.id=$2 WHERE c.id=$1
  `, [chatId, senderId ?? null]);
  return { listing: publicListingTitle(notice.title), nickname: notice.nickname ? publicNickname(notice.nickname) : null };
}

export async function queueChatMessage(client: Queryable, enqueue: EnqueueNotice, chatId: string, recipient: string,
  sender: string, id: number, telegram: boolean) {
  const { listing, nickname } = await chatNotice(client, chatId, sender);
  const { rows: [pending] } = await client.query<{ telegramDue: boolean }>(`
    INSERT INTO chat_notify_state(chat_id,user_id,pending_since,pending_message_id)
    VALUES ($1,$2,now(),$3)
    ON CONFLICT (chat_id,user_id) DO UPDATE SET
      pending_since=coalesce(chat_notify_state.pending_since,excluded.pending_since),
      pending_message_id=excluded.pending_message_id
    RETURNING (last_telegram_at IS NULL OR last_telegram_at<=now()-interval '15 minutes') AS "telegramDue"
  `, [chatId, recipient, id]);
  const { rowCount: merged } = await client.query(`
    UPDATE notifications SET body='Новых сообщений: ' || ((payload->>'count')::int+1),
      payload=jsonb_set(payload,'{count}',to_jsonb((payload->>'count')::int+1))
    WHERE user_id=$1 AND kind='chat.message' AND NOT delivery_only AND read_at IS NULL AND payload->>'chatId'=$2
  `, [recipient, chatId]);
  if (!merged) await client.query(`
    INSERT INTO notifications(user_id,kind,title,body,payload,actions,dedupe_key,priority)
    SELECT $1,'chat.message',$3,$4,$5::jsonb,$6::jsonb,'chat.message:' || c.id || ':' ||
      CASE WHEN c.owner_id=$1 THEN c.owner_read_id ELSE c.visitor_read_id END,1
    FROM chats c WHERE c.id=$2
    ON CONFLICT (user_id,dedupe_key) DO UPDATE SET
      title=excluded.title,body=excluded.body,payload=excluded.payload,created_at=now(),read_at=NULL
  `, [recipient, chatId, nickname ? 'Новое сообщение от ' + nickname : 'Новое сообщение в чате',
    'По объявлению «' + listing + '»', JSON.stringify({ chatId, count: 1 }), JSON.stringify([chatAction(chatId)])]);
  if (telegram && pending.telegramDue) {
    const { rowCount: linked } = await client.query(`
      SELECT 1 FROM users u WHERE u.id=$1 AND u.telegram_chat_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM platform_settings WHERE key='feature_telegram' AND value='true'::jsonb)
      AND NOT EXISTS (
        SELECT 1 FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id
        WHERE n.user_id=$1 AND n.kind='chat.message' AND n.payload->>'chatId'=$2 AND d.channel='TELEGRAM'
          AND (d.status='PENDING' OR (d.status='SENT' AND d.sent_at>now()-interval '15 minutes'))
      )
    `, [recipient, chatId]);
    if (linked) {
      await enqueue(client, recipient, {
        kind: 'chat.message', title: 'Новое сообщение в чате', body: 'По объявлению «' + listing + '»',
        actions: [chatAction(chatId)], channels: ['TELEGRAM'], payload: { chatId, messageId: id },
        deliveryOnly: true, dedupeKey: 'chat.telegram:' + chatId + ':' + id,
      });
      await client.query('UPDATE chat_notify_state SET last_telegram_at=now() WHERE chat_id=$1 AND user_id=$2', [chatId, recipient]);
    }
  }
}

export async function applyChatRead(client: Queryable, chatId: string, recipient: string, readThrough: string) {
  const { rows: [remaining] } = await client.query<{ count: number; firstAt: Date | null }>(`
    SELECT count(*)::int,min(created_at) AS "firstAt" FROM chat_messages
    WHERE chat_id=$1 AND sender_id<>$2 AND id>$3
  `, [chatId, recipient, readThrough]);
  await client.query(`
    UPDATE chat_notify_state SET
      pending_since = CASE WHEN pending_message_id <= $3 THEN NULL ELSE greatest(pending_since,$4::timestamptz) END,
      pending_message_id = CASE WHEN pending_message_id <= $3 THEN NULL ELSE pending_message_id END
    WHERE chat_id=$1 AND user_id=$2 AND pending_since IS NOT NULL
  `, [chatId, recipient, readThrough, remaining.firstAt]);
  await client.query(`
    UPDATE notifications SET read_at=CASE WHEN $3::int=0 THEN now() ELSE NULL END,
      payload=jsonb_set(payload,'{count}',to_jsonb($3::int)),body=CASE WHEN $3=0 THEN body ELSE $4 END
    WHERE user_id=$1 AND kind='chat.message' AND NOT delivery_only AND read_at IS NULL AND payload->>'chatId'=$2
  `, [recipient, chatId, remaining.count, messageCount(remaining.count)]);
  await client.query(`
    UPDATE notification_deliveries d SET status='SKIPPED',error='Сообщения прочитаны'
    FROM notifications n WHERE n.id=d.notification_id AND n.user_id=$1 AND n.kind='chat.message' AND n.delivery_only
      AND n.payload->>'chatId'=$2 AND (n.payload->>'messageId')::bigint <= $3 AND d.status='PENDING'
  `, [recipient, chatId, readThrough]);
}

export async function deliverChatDigest(client: Queryable, enqueue: EnqueueNotice) {
  const { rows } = await client.query<{ chatId: string; userId: string; throughId: string; listing: string;
    eligible: boolean; unread: boolean }>(`
    SELECT s.chat_id AS "chatId",s.user_id AS "userId",s.pending_message_id AS "throughId",l.title AS listing,
      (u.status='ACTIVE' AND u.notify_email AND u.email_verified_at IS NOT NULL) AS eligible,
      (s.pending_message_id>CASE WHEN c.owner_id=s.user_id THEN c.owner_read_id ELSE c.visitor_read_id END) AS unread
    FROM chat_notify_state s JOIN users u ON u.id=s.user_id JOIN chats c ON c.id=s.chat_id
    JOIN listings l ON l.id=c.listing_id
    WHERE s.pending_since<=now()-interval '5 minutes'
      AND (s.last_email_at IS NULL OR s.last_email_at<=now()-interval '15 minutes')
    ORDER BY s.pending_since,s.chat_id,s.user_id LIMIT 200 FOR UPDATE OF s SKIP LOCKED
  `);
  for (const row of rows) {
    const send = row.eligible && row.unread;
    if (send) await enqueue(client, row.userId, {
      kind: 'chat.message', title: ('У вас новые сообщения по объявлению «' + publicListingTitle(row.listing) + '»').slice(0, 200),
      body: 'У вас новые сообщения по объявлению «' + publicListingTitle(row.listing) + '».',
      payload: { chatId: row.chatId, messageId: row.throughId }, actions: [chatAction(row.chatId)],
      channels: ['EMAIL'], deliveryOnly: true, dedupeKey: 'chat.email:' + row.chatId + ':' + row.throughId,
    });
    await client.query(`
      UPDATE chat_notify_state SET pending_since=NULL,pending_message_id=NULL,
        last_email_at=CASE WHEN $3 THEN now() ELSE last_email_at END WHERE chat_id=$1 AND user_id=$2
    `, [row.chatId, row.userId, send]);
  }
}

export async function queueStaffNotice(client: Queryable, enqueue: EnqueueNotice, notice: Notification) {
  const { rows: [setting] } = await client.query<{ value: string[] }>(
    "SELECT value FROM platform_settings WHERE key='staff_instant_kinds'",
  );
  const { rows: staff } = await client.query<{ id: string }>(`
    SELECT id FROM users WHERE role IN ('ADMIN','MODERATOR') AND status='ACTIVE' ORDER BY id
  `);
  for (const { id } of staff) {
    const noticeId = await enqueue(client, id, { ...notice, channels: [] });
    if (!noticeId || !setting?.value.includes(notice.kind)) continue;
    const { rowCount: first } = await client.query(`
      INSERT INTO staff_notify_state(user_id,kind,last_email_at,first_notice_id)
      VALUES ($1,$2,now(),$3) ON CONFLICT (user_id,kind) DO UPDATE SET
        last_email_at=now(),first_notice_id=excluded.first_notice_id
      WHERE NOT staff_notify_state.has_pending AND staff_notify_state.last_email_at<=now()-interval '10 minutes'
    `, [id, notice.kind, noticeId]);
    if (first) {
      await client.query("INSERT INTO notification_deliveries(notification_id,channel) VALUES ($1,'EMAIL')", [noticeId]);
    } else {
      await client.query('UPDATE staff_notify_state SET has_pending=true WHERE user_id=$1 AND kind=$2', [id, notice.kind]);
    }
  }
}

export async function deliverStaffPending(client: Queryable, enqueue: EnqueueNotice) {
  const { rows } = await client.query<{ userId: string; kind: string; firstId: string; eligible: boolean }>(`
    SELECT s.user_id AS "userId",s.kind,s.first_notice_id AS "firstId",
      (u.status='ACTIVE' AND u.role IN ('ADMIN','MODERATOR') AND u.notify_email AND cfg.value ? s.kind) AS eligible
    FROM staff_notify_state s JOIN users u ON u.id=s.user_id
    JOIN platform_settings cfg ON cfg.key='staff_instant_kinds'
    WHERE s.has_pending AND s.last_email_at<=now()-interval '10 minutes'
    ORDER BY s.last_email_at,s.user_id,s.kind LIMIT 100 FOR UPDATE OF s SKIP LOCKED
  `);
  for (const row of rows) {
    const { rows: notices } = await client.query<{ id: string; title: string; body: string; total: number }>(`
      SELECT id,title,body,count(*) OVER()::int AS total FROM notifications
      WHERE user_id=$1 AND kind=$2 AND id>=$3 AND NOT delivery_only ORDER BY id DESC LIMIT 12
    `, [row.userId, row.kind, row.firstId]);
    if (row.eligible && notices.length) {
      const count = notices[0].total;
      const titles = notices.reverse().map(item => item.title === item.body ? item.title : item.title + '\n' + item.body);
      await enqueue(client, row.userId, {
        kind: row.kind, title: 'События для проверки: ' + count, body: titles.join('\n\n').slice(0, 3900),
        actions: [{ label: 'Открыть уведомления', href: '/notifications' }], channels: ['EMAIL'],
        deliveryOnly: true, dedupeKey: 'staff.pending:' + row.kind + ':' + row.firstId,
      });
    }
    // The next notice starts a new batch. A temporary mail failure remains in the delivery queue.
    await client.query(`
      UPDATE staff_notify_state SET has_pending=false,last_email_at=now(),first_notice_id=coalesce($3::bigint+1,first_notice_id)
      WHERE user_id=$1 AND kind=$2
    `, [row.userId, row.kind, notices.at(-1)?.id]);
  }
}

export async function staffDailyDigest(client: Queryable, enqueue: EnqueueNotice, clock: ExchangeClock) {
  const { rows: [queue] } = await client.query<Record<string, number>>(`
    SELECT
      (SELECT count(*)::int FROM users WHERE onboarding_state='DONE' AND onboarding_submitted_at IS NOT NULL
        AND verification_level=0 AND status='ACTIVE') AS onboarding,
      (SELECT count(*)::int FROM verification_documents WHERE status='PENDING') AS documents,
      (SELECT count(DISTINCT p.id)::int FROM user_principals p JOIN company_email_letters e ON e.principal_id=p.id
        WHERE e.kind='PRINCIPAL' AND e.domain_kind='PUBLIC' AND e.status IN ('SENT','CONFIRMED')
          AND p.removed_at IS NULL AND p.confirmed_at IS NULL AND p.denied_at IS NULL) AS principals,
      (SELECT count(*)::int FROM deals WHERE status='EXECUTED' AND admin_verified_at IS NULL AND admin_rejected_at IS NULL) AS deals,
      (SELECT count(*)::int FROM listings WHERE status='PENDING_REVIEW') AS premod,
      (SELECT count(*)::int FROM listings WHERE status='PENDING_OWNER') AS owner,
      (SELECT count(*)::int FROM disputes WHERE status NOT IN ('DECIDED','CLOSED')) AS disputes,
      ((SELECT count(*)::int FROM exchange_email_outbox WHERE status='FAILED'
          AND last_attempt_at>=now()-interval '1 day')
       + (SELECT count(*)::int FROM notification_deliveries WHERE channel='EMAIL' AND status='FAILED'
          AND last_attempt_at>=now()-interval '1 day')) AS errors
  `);
  if (!Object.values(queue).some(count => count > 0)) return { notified: 0 };
  const { rows: staff } = await client.query<{ id: string }>(`
    SELECT id FROM users WHERE role IN ('ADMIN','MODERATOR') AND status='ACTIVE' ORDER BY id
  `);
  let notified = 0;
  for (const { id } of staff) {
    const sent = await enqueue(client, id, {
      kind: 'staff.digest', title: 'Сводка для модераторов',
      body: `Ждут проверки: анкеты ${queue.onboarding}, документы ${queue.documents}, принципалы с общей почты ${queue.principals}, `
        + `сделки ${queue.deals}, объявления на премодерации ${queue.premod}, ждут владельца ${queue.owner}, споры ${queue.disputes}. `
        + `Ошибок доставки писем за сутки: ${queue.errors}.`,
      payload: queue, channels: ['EMAIL'], priority: 3, dedupeKey: 'staff.digest:' + clock.day,
      actions: [
        { label: 'Открыть участников', href: '/admin?section=users' },
        { label: 'Проверки и сделки', href: '/admin?section=exchange&part=verification' },
        { label: 'Объявления', href: '/admin?section=listings' },
        { label: 'Споры', href: '/admin?section=exchange&part=disputes' },
      ],
    });
    if (sent) notified++;
  }
  return { notified };
}
