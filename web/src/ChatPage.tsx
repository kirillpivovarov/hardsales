import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from './api';
import type { User } from './api';
import { useI18n } from './i18n';
import { countryName } from './market';
import { Button, Field, Icon, Notice, Spinner } from './ui';
import './chat.css';

type ReportReason = 'FRAUD' | 'ABUSE' | 'OTHER';
type ReportScope = 'ON_PLATFORM' | 'VERIFIED_TELEGRAM';
type RevealAction = 'REQUEST' | 'ACCEPT' | 'DECLINE';

type ChatSummaryMessage = {
  body: string;
  createdAt: string;
  senderId: string;
};

type Chat = {
  id: string;
  listing: { id: string; title: string; kind: 'SELL' | 'BUY'; status: string };
  partner: {
    id: string;
    nickname: string;
    country: string;
    city: string;
    accountType: string;
    rating: number | null;
    ratingCount: number;
  };
  lastMessage: ChatSummaryMessage | null;
  unreadCount: number;
  revealState: 'NONE' | 'REQUESTED' | 'ACCEPTED' | 'DECLINED';
  revealRequestedBy: string | null;
  revealRequestId: string | null;
  telegramChanged: { mine: boolean; partner: boolean } | null;
  telegram: { mine: string; partner: string } | null;
  status: 'ACTIVE' | 'RESTRICTED';
  hasReview: boolean;
  canReview?: boolean;
  hasReport: boolean;
  canReportTelegram?: boolean;
  createdAt: string;
};

type ChatMessage = ChatSummaryMessage & { id: number; contactWarning: boolean };
type ChatList = { items: Chat[]; total: number; page: number; limit: number };
type Translate = ReturnType<typeof useI18n>['t'];

const PAGE_SIZE = 20;
const MESSAGE_PAGE_SIZE = 100;
const MESSAGE_MAX_LENGTH = 4000;
const REVIEW_MAX_LENGTH = 1000;
const REPORT_MAX_LENGTH = 4000;
const CONTACT_WARNING = 'Рекомендуем общаться по Telegram, раскрытому в чате. При мошенничестве мы можем заблокировать профиль. За общение по другим контактам отвечают собеседники. Жалобы на такую переписку не рассматриваем.';

function mergeMessages(previous: ChatMessage[], additions: ChatMessage[]) {
  const byId = new Map(previous.map((message) => [message.id, message]));
  additions.forEach((message) => byId.set(message.id, message));
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function hasUnverifiedContact(body: string, telegram: Chat['telegram']) {
  const knownHandles = new Set(telegram ? [telegramName(telegram.mine).toLowerCase(), telegramName(telegram.partner).toLowerCase()] : []);
  const contacts = body.matchAll(/(?:^|[^\p{L}\p{N}._%+-])@([a-z0-9_]{5,32})\b|\b(?:(?:t\.me|telegram\.me|telegram\.dog)\/|tg:\/\/)([^\s<>]*)/giu);
  return [...contacts].some((match) => {
    const target = match[2]?.replace(/[.,!?;:)\]}]+$/, '') ?? '';
    const handle = match[1] ?? (match[0].toLowerCase().startsWith('tg:') ? /^resolve[?/]+domain=([a-z0-9_]+)$/i.exec(target)?.[1] : target);
    return !handle || !knownHandles.has(handle.toLowerCase());
  });
}

function telegramName(handle: string) {
  return handle.replace(/^@/, '');
}

function errorMessage(error: unknown, t: Translate) {
  return error instanceof ApiError ? t(error.message) : t('Не удалось связаться с площадкой. Попробуйте ещё раз.');
}

function messageTime(sentAt: string, locale: string, expanded = false) {
  return new Intl.DateTimeFormat(locale, expanded ? { dateStyle: 'medium', timeStyle: 'short' } : { hour: '2-digit', minute: '2-digit' }).format(new Date(sentAt));
}

function threadTime(sentAt: string, locale: string) {
  const date = new Date(sentAt);
  if (date.toDateString() === new Date().toDateString()) return messageTime(sentAt, locale);
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(date);
}

function Avatar({ name }: { name: string }) {
  return <span className="chat-avatar" aria-hidden="true">{Array.from(name).slice(0, 2).join('').toUpperCase()}</span>;
}

export function StartChatButton({ listingId }: { listingId: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function start() {
    setPending(true);
    setError('');
    try {
      const chat = await api<Chat>('/chats', { method: 'POST', body: { listingId } });
      navigate(`/chats/${chat.id}`);
    } catch (cause) {
      setError(errorMessage(cause, t));
    } finally {
      setPending(false);
    }
  }

  return <div className="chat-start">
    <Button type="button" onClick={() => void start()} disabled={pending}>
      <Icon name="message-circle" size={18} /> {pending ? t('Открываем чат…') : t('Написать')}
    </Button>
    {error && <Notice tone="error">{error}</Notice>}
  </div>;
}

export function ChatPage({ user }: { user: User }) {
  const { id } = useParams();
  const { t } = useI18n();
  const [refresh, setRefresh] = useState(0);

  return <section className="container chat-page" aria-labelledby="chat-page-title">
    <div className="chat-page-heading">
      {id && <Link className="chat-mobile-back" to="/chats">{t('Все сообщения')}</Link>}
      <h1 id="chat-page-title">{t('Сообщения')}</h1>
    </div>
    <div className={`chat-workspace${id ? ' chat-workspace-selected' : ''}`}>
      <ChatInbox refresh={refresh} selectedId={id} userId={user.id} />
      {id ? <ChatConversation key={id} id={id} userId={user.id} onInboxChange={() => setRefresh((value) => value + 1)} />
        : <div className="panel chat-no-selection">
          <Icon name="message-circle" size={30} />
          <p>{t('Выберите переписку')}</p>
        </div>}
    </div>
  </section>;
}

function ChatInbox({ selectedId, refresh, userId }: { selectedId?: string; refresh: number; userId: string }) {
  const { t, locale } = useI18n();
  const [pages, setPages] = useState<ChatList[]>([]);
  const [error, setError] = useState('');
  const [morePending, setMorePending] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const data = await api<ChatList>(`/chats?page=1&limit=${PAGE_SIZE}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setPages((previous) => [data, ...previous.slice(1)]);
        setError('');
      } catch (cause) {
        if (!controller.signal.aborted) setError(errorMessage(cause, t));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void load(), 10000);
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [refresh, retry, t]);

  async function loadMore() {
    setMorePending(true);
    setError('');
    try {
      const next = await api<ChatList>(`/chats?page=${pages.length + 1}&limit=${PAGE_SIZE}`);
      setPages((previous) => [...previous, next]);
    } catch (cause) {
      setError(errorMessage(cause, t));
    } finally {
      setMorePending(false);
    }
  }

  const seen = new Set<string>();
  const threads = pages.flatMap((page) => page.items).filter((chat) => {
    if (seen.has(chat.id)) return false;
    seen.add(chat.id);
    return true;
  });
  const hasMore = pages.length > 0 && pages.length * PAGE_SIZE < pages[0].total;

  return <aside aria-label={t('Переписки')} className="panel chat-inbox">
    {pages.length === 0 && !error && <div className="chat-inbox-padding"><Spinner /></div>}
    {threads.length === 0 && pages.length > 0 && <div className="chat-inbox-padding chat-empty-inbox">
      <Icon name="message-circle" size={24} />
      <p><strong>{t('Переписок пока нет')}</strong></p>
      <p className="muted">{t('Выберите объявление в каталоге и напишите его автору.')}</p>
      <Link className="button button-secondary" to="/">{t('Открыть каталог')}</Link>
    </div>}
    {threads.length > 0 && <nav aria-label={t('Список переписок')}>
      {threads.map((chat) => <Link className="chat-thread" key={chat.id} to={`/chats/${chat.id}`} aria-current={chat.id === selectedId ? 'page' : undefined}>
        <Avatar name={chat.partner.nickname} />
        <div className="chat-thread-text">
          <strong>{chat.partner.nickname}</strong>
          <span className="chat-thread-listing">{chat.listing.title}</span>
          {chat.lastMessage && <span className="chat-thread-preview">{chat.lastMessage.senderId === userId ? t('Вы: {message}', { message: chat.lastMessage.body }) : chat.lastMessage.body}</span>}
        </div>
        <span className="chat-thread-meta">
          <time dateTime={chat.lastMessage?.createdAt ?? chat.createdAt}>{threadTime(chat.lastMessage?.createdAt ?? chat.createdAt, locale)}</time>
          {chat.unreadCount > 0 && <span className="chat-unread" aria-label={t('Непрочитанных сообщений: {count}', { count: chat.unreadCount })}>{chat.unreadCount}</span>}
        </span>
      </Link>)}
    </nav>}
    {error && <div className="chat-inbox-padding"><Notice tone="error">{error}</Notice><Button variant="ghost" onClick={() => setRetry((value) => value + 1)}>{t('Повторить')}</Button></div>}
    {hasMore && <div className="chat-inbox-padding"><Button variant="secondary" onClick={() => void loadMore()} disabled={morePending}>{t('Ещё переписки')}</Button></div>}
  </aside>;
}

function ChatConversation({ id, userId, onInboxChange }: { id: string; userId: string; onInboxChange: () => void }) {
  const { t, locale } = useI18n();
  const [chat, setChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageBody, setMessageBody] = useState('');
  const [form, setForm] = useState<'review' | 'report' | null>(null);
  const [olderAvailable, setOlderAvailable] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [banner, setBanner] = useState('');
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const inboxChange = useRef(onInboxChange);
  const cursor = useRef<number | undefined>(undefined);
  const markedRead = useRef(0);
  const latestIncoming = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const preservePosition = useRef<number | undefined>(undefined);
  const follow = useRef(true);

  useEffect(() => { inboxChange.current = onInboxChange; }, [onInboxChange]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const chatPath = `/chats/${id}`;

    async function markRead() {
      if (document.visibilityState !== 'visible' || !follow.current || latestIncoming.current <= markedRead.current) return;
      const messageId = latestIncoming.current;
      try {
        await api<void>(`${chatPath}/read`, { method: 'PATCH', body: { messageId }, signal: controller.signal });
        if (!controller.signal.aborted) {
          markedRead.current = Math.max(markedRead.current, messageId);
          inboxChange.current();
        }
      } catch {
        // The next poll retries the current read marker.
      }
    }

    async function load() {
      let nextDelay = 4000;
      try {
        const previousCursor = cursor.current;
        const query = new URLSearchParams({ limit: String(MESSAGE_PAGE_SIZE) });
        if (previousCursor !== undefined) query.set('after', String(previousCursor));
        const [nextChat, nextMessages] = await Promise.all([
          api<Chat>(chatPath, { signal: controller.signal }),
          api<ChatMessage[]>(`${chatPath}/messages?${query}`, { signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        if (previousCursor === undefined) setOlderAvailable(nextMessages.length === MESSAGE_PAGE_SIZE);
        cursor.current = nextMessages.at(-1)?.id ?? previousCursor ?? 0;
        if (nextMessages.length) {
          setMessages((previous) => mergeMessages(previous, nextMessages));
          nextMessages.forEach((message) => {
            if (message.senderId !== userId) latestIncoming.current = Math.max(latestIncoming.current, message.id);
          });
        }
        setChat(nextChat);
        setLoadError('');
        if (nextMessages.length === MESSAGE_PAGE_SIZE && previousCursor !== undefined) nextDelay = 0;
        if (nextChat.unreadCount) await markRead();
      } catch (cause) {
        if (!controller.signal.aborted) setLoadError(errorMessage(cause, t));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void load(), nextDelay);
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, refresh, t, userId]);

  useLayoutEffect(() => {
    const viewport = scroll.current;
    if (!viewport) return;
    if (preservePosition.current !== undefined) {
      viewport.scrollTop = viewport.scrollHeight - preservePosition.current;
      preservePosition.current = undefined;
    } else if (follow.current) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [messages, chat?.id]);

  async function loadOlder() {
    const first = messages[0];
    if (!first) return;
    setLoadingOlder(true);
    setActionError('');
    try {
      const older = await api<ChatMessage[]>(`/chats/${id}/messages?before=${first.id}&limit=${MESSAGE_PAGE_SIZE}`);
      if (scroll.current) preservePosition.current = scroll.current.scrollHeight - scroll.current.scrollTop;
      setMessages((previous) => mergeMessages(previous, older));
      setOlderAvailable(older.length === MESSAGE_PAGE_SIZE);
    } catch (cause) {
      setActionError(errorMessage(cause, t));
    } finally {
      setLoadingOlder(false);
    }
  }

  async function action(work: () => Promise<void>) {
    setPending(true);
    setActionError('');
    setBanner('');
    try {
      await work();
    } catch (cause) {
      setActionError(errorMessage(cause, t));
    } finally {
      setRefresh((value) => value + 1);
      setPending(false);
    }
  }

  function send(event: FormEvent) {
    event.preventDefault();
    const body = messageBody.trim();
    if (!body || pending) return;
    void action(async () => {
      const sent = await api<ChatMessage>(`/chats/${id}/messages`, { method: 'POST', body: { body } });
      follow.current = true;
      setMessages((previous) => mergeMessages(previous, [sent]));
      setMessageBody((current) => current.trim() === body ? '' : current);
      inboxChange.current();
    });
  }

  function reveal(revealAction: RevealAction) {
    const requestId = chat?.revealRequestId;
    if (revealAction !== 'REQUEST' && !requestId) return;
    void action(async () => {
      const body = revealAction === 'REQUEST' ? { action: revealAction } : { action: revealAction, requestId };
      const updated = await api<Chat>(`/chats/${id}/reveal`, { method: 'PATCH', body });
      setChat(updated);
    });
  }

  if (!chat) return <section className="panel chat-no-selection" aria-label={t('Переписка')}>
    {loadError ? <><Notice tone="error">{loadError}</Notice><Button variant="secondary" onClick={() => setRefresh((value) => value + 1)}>{t('Повторить')}</Button></> : <Spinner />}
  </section>;

  const isActive = chat.status === 'ACTIVE';
  const currentTelegram = loadError ? null : chat.telegram;
  const mayReview = isActive && !chat.hasReview && (chat.canReview ?? (messages.some((message) => message.senderId === userId) && messages.some((message) => message.senderId !== userId)));
  const partnersPlace = [chat.partner.city, countryName(chat.partner.country, locale)].filter(Boolean).join(', ');
  const partnerRating = typeof chat.partner.rating === 'number' ? new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(chat.partner.rating) : null;

  return <section className="panel chat-conversation" aria-label={t('Чат с {name}', { name: chat.partner.nickname })}>
    <header className="chat-conversation-header">
      <Avatar name={chat.partner.nickname} />
      <div className="chat-conversation-heading">
        <h2>{chat.partner.nickname}</h2>
        <div className="chat-partner-details">
          {partnersPlace && <span>{partnersPlace}</span>}
          {partnerRating && chat.partner.ratingCount > 0
            ? <span className="chat-partner-rating" role="img" aria-label={t('Рейтинг {rating} из 5, оценок: {count}', { rating: partnerRating, count: chat.partner.ratingCount })}><span aria-hidden="true">★ {partnerRating} ({chat.partner.ratingCount})</span></span>
            : <span>{t('Пока без отзывов')}</span>}
        </div>
        {chat.listing.status === 'ACTIVE' ? <Link to={`/listings/${chat.listing.id}`}>{chat.listing.title}</Link> : <span className="muted">{chat.listing.title}</span>}
      </div>
      <div className="chat-actions">
        {mayReview && <Button variant="ghost" disabled={pending} aria-expanded={form === 'review'} onClick={() => { setActionError(''); setForm(form === 'review' ? null : 'review'); }}>{t('Оставить отзыв')}</Button>}
        {!chat.hasReport && <Button variant="ghost" disabled={pending} aria-expanded={form === 'report'} onClick={() => { setActionError(''); setForm(form === 'report' ? null : 'report'); }}>{t('Пожаловаться')}</Button>}
      </div>
    </header>

    <div className="chat-notices">
      {chat.telegramChanged && <TelegramChangeNotice change={chat.telegramChanged} />}
      {!loadError && <TelegramPanel chat={chat} userId={userId} pending={pending} reveal={reveal} />}
      {!isActive && <Notice>{t('Переписка ограничена. Новые сообщения и обмен Telegram недоступны.')}</Notice>}
      {banner && <Notice tone="success">{banner}</Notice>}
      {loadError && <Notice tone="error">{loadError}</Notice>}
      {actionError && <Notice tone="error">{actionError}</Notice>}
    </div>

    {form === 'review' && mayReview && <ReviewForm pending={pending} close={() => setForm(null)} submit={(rating, comment) => void action(async () => {
      await api(`/chats/${id}/reviews`, { method: 'POST', body: { rating, comment } });
      setChat((previous) => previous && { ...previous, hasReview: true });
      setForm(null);
      setBanner(t('Отзыв отправлен.'));
    })} />}
    {form === 'report' && !chat.hasReport && <ReportForm pending={pending} close={() => setForm(null)} allowTelegram={chat.canReportTelegram ?? Boolean(currentTelegram)} submit={(reason, scope, details) => void action(async () => {
      await api(`/chats/${id}/reports`, { method: 'POST', body: { reason, scope, details } });
      setChat((previous) => previous && { ...previous, hasReport: true });
      setForm(null);
      setBanner(t('Жалоба отправлена модератору.'));
    })} />}

    <div className="chat-messages" ref={scroll} onScroll={() => {
      const viewport = scroll.current;
      if (viewport) follow.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
    }} aria-label={t('История сообщений')} tabIndex={0}>
      {olderAvailable && <div className="chat-load-older"><Button variant="secondary" onClick={() => void loadOlder()} disabled={loadingOlder}>{t('Предыдущие сообщения')}</Button></div>}
      {messages.length === 0 && <div className="chat-no-messages"><p>{t('Сообщений пока нет')}</p>{isActive && <p className="muted">{t('Начните с вопроса об объявлении.')}</p>}</div>}
      <ol className="chat-message-list" aria-live="polite" aria-relevant="additions">
        {messages.map((message) => {
          const own = message.senderId === userId;
          return <li key={message.id} className={`chat-message${own ? ' chat-message-own' : ''}`}>
            <span className="chat-sr-only">{own ? t('Вы') : chat.partner.nickname}</span>
            <div className="chat-bubble">
              <p>{message.body}</p>
              <time dateTime={message.createdAt} title={messageTime(message.createdAt, locale, true)}>{messageTime(message.createdAt, locale)}</time>
            </div>
            {message.contactWarning && <p className="chat-contact-warning"><Icon name="triangle-alert" size={17} /> <span>{t(CONTACT_WARNING)}</span></p>}
          </li>;
        })}
      </ol>
    </div>

    {isActive && <form className="chat-composer" onSubmit={send}>
      {hasUnverifiedContact(messageBody, currentTelegram) && <div className="chat-composer-warning"><Notice>{t(CONTACT_WARNING)}</Notice></div>}
      <label className="chat-sr-only" htmlFor="chat-message-input">{t('Сообщение')}</label>
      <textarea id="chat-message-input" placeholder={t('Напишите сообщение…')} rows={2} value={messageBody} maxLength={MESSAGE_MAX_LENGTH} onChange={(event) => setMessageBody(event.target.value)} />
      <Button type="submit" disabled={pending || !messageBody.trim()}><Icon name="send" size={17} /> {t('Отправить')}</Button>
    </form>}
  </section>;
}

function TelegramChangeNotice({ change }: { change: NonNullable<Chat['telegramChanged']> }) {
  const { t } = useI18n();
  let message = 'Имя пользователя в Telegram изменилось.';
  if (change.mine && change.partner) message = 'Вы оба изменили имена пользователей в Telegram.';
  else if (change.mine) message = 'Вы изменили имя пользователя в Telegram.';
  else if (change.partner) message = 'Собеседник изменил имя пользователя в Telegram.';
  return <Notice>{t(message)} {t('Для повторного обмена контактами нужно новое согласие.')}</Notice>;
}

function TelegramPanel({ chat, userId, pending, reveal }: { chat: Chat; userId: string; pending: boolean; reveal: (action: RevealAction) => void }) {
  const { t } = useI18n();
  if (chat.status !== 'ACTIVE') return null;
  if (chat.revealState === 'ACCEPTED' && chat.telegram) {
    const partner = telegramName(chat.telegram.partner);
    return <div className="chat-telegram chat-telegram-accepted">
      <Icon name="check" size={18} />
      <div className="chat-telegram-copy" role="status">
        <strong>{t('Telegram открыт для обоих')}</strong>
        <span>{t('Ваш Telegram: @{handle}', { handle: telegramName(chat.telegram.mine) })}</span>
      </div>
      <a className="button button-secondary" href={`https://t.me/${encodeURIComponent(partner)}`} target="_blank" rel="noopener noreferrer">@{partner}</a>
    </div>;
  }
  if (chat.revealState === 'REQUESTED') {
    const outgoing = chat.revealRequestedBy === userId;
    return <div className="chat-telegram">
      <Icon name="lock" size={18} />
      <div className="chat-telegram-copy" role="status">
        <strong>{outgoing ? t('Запрос на обмен Telegram отправлен') : t('Собеседник предлагает обменяться Telegram')}</strong>
        <span>{outgoing ? t('Когда собеседник согласится, вы оба увидите контакты во всех ваших чатах.') : t('При согласии вы оба увидите контакты из профилей во всех ваших чатах.')}</span>
      </div>
      {!outgoing && <div className="chat-telegram-actions">
        <Button variant="ghost" disabled={pending || !chat.revealRequestId} onClick={() => reveal('DECLINE')}>{t('Отклонить')}</Button>
        <Button variant="secondary" disabled={pending || !chat.revealRequestId} onClick={() => reveal('ACCEPT')}>{t('Согласиться')}</Button>
      </div>}
    </div>;
  }
  return <div className="chat-telegram">
    <Icon name="lock" size={18} />
    <div className="chat-telegram-copy" role="status">
      <strong>{chat.revealState === 'DECLINED' ? t('Запрос на обмен Telegram отклонён') : t('Telegram скрыт')}</strong>
      {!chat.telegramChanged && <span>{t('По взаимному согласию контакты откроются во всех ваших чатах с этим собеседником.')}</span>}
    </div>
    <Button variant="secondary" disabled={pending} onClick={() => reveal('REQUEST')}>{chat.telegramChanged ? t('Предложить обмен заново') : t('Предложить обмен')}</Button>
  </div>;
}

function ReviewForm({ pending, close, submit }: { pending: boolean; close: () => void; submit: (rating: number, comment?: string) => void }) {
  const { t } = useI18n();
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');

  return <form className="chat-action-form" onSubmit={(event) => {
    event.preventDefault();
    if (rating > 0) submit(rating, comment.trim() || undefined);
  }}>
    <h3>{t('Отзыв о собеседнике')}</h3>
    <fieldset className="chat-star-field">
      <legend>{t('Оценка')}</legend>
      {[1, 2, 3, 4, 5].map((star) => <label className="chat-star" key={star} data-filled={star <= rating}>
        <input type="radio" name="rating" value={star} checked={rating === star} onChange={() => setRating(star)} aria-label={t('{stars} из 5', { stars: star })} required />
        <span aria-hidden="true">{star <= rating ? '★' : '☆'}</span>
      </label>)}
    </fieldset>
    <Field label={t('Комментарий (необязательно)')}>
      <textarea rows={3} maxLength={REVIEW_MAX_LENGTH} value={comment} onChange={(event) => setComment(event.target.value)} />
    </Field>
    <div className="chat-form-actions">
      <Button type="button" variant="ghost" disabled={pending} onClick={close}>{t('Отмена')}</Button>
      <Button type="submit" disabled={pending || rating === 0}>{t('Отправить отзыв')}</Button>
    </div>
  </form>;
}

function ReportForm({ pending, close, allowTelegram, submit }: { pending: boolean; close: () => void; allowTelegram: boolean; submit: (reason: ReportReason, scope: ReportScope, details: string) => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState<ReportReason | ''>('');
  const [scope, setScope] = useState<ReportScope>('ON_PLATFORM');
  const [details, setDetails] = useState('');

  return <form className="chat-action-form" onSubmit={(event) => {
    event.preventDefault();
    if (reason && details.trim().length >= 10) submit(reason, allowTelegram ? scope : 'ON_PLATFORM', details.trim());
  }}>
    <h3>{t('Жалоба на собеседника')}</h3>
    <p className="muted">{t('Мы рассматриваем жалобы на переписку на площадке и общение по Telegram, раскрытому в чате. Переписка по другим контактам остаётся ответственностью собеседников.')}</p>
    <div className="form-grid">
      <Field label={t('Причина')}>
        <select required value={reason} onChange={(event) => setReason(event.target.value as ReportReason | '')}>
          <option value="">{t('Выберите причину')}</option>
          <option value="FRAUD">{t('Мошенничество')}</option>
          <option value="ABUSE">{t('Оскорбления или спам')}</option>
          <option value="OTHER">{t('Другая причина')}</option>
        </select>
      </Field>
      {allowTelegram && <Field label={t('Где это произошло')}>
        <select value={scope} onChange={(event) => setScope(event.target.value as ReportScope)}>
          <option value="ON_PLATFORM">{t('В чате hwforai')}</option>
          <option value="VERIFIED_TELEGRAM">{t('В Telegram, раскрытом на площадке')}</option>
        </select>
      </Field>}
    </div>
    <Field label={t('Что произошло')} hint={t('Не менее 10 символов')}>
      <textarea rows={3} required minLength={10} maxLength={REPORT_MAX_LENGTH} value={details} onChange={(event) => setDetails(event.target.value)} />
    </Field>
    <div className="chat-form-actions">
      <Button type="button" variant="ghost" onClick={close} disabled={pending}>{t('Отмена')}</Button>
      <Button type="submit" disabled={pending || !reason || details.trim().length < 10}>{t('Отправить жалобу')}</Button>
    </div>
  </form>;
}
