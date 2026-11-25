/** A Telegram mention or link is allowed in chat after both participants share it. */
export function withContact(value: string, confirmed: (string | null)[] = []): boolean {
  const handles = confirmed.map(name => name?.toLowerCase());
  const references = value.matchAll(/(?:^|[^\p{L}\p{N}._%+-])@([a-z0-9_]{5,32})\b|\b(?:(?:t\.me|telegram\.me|telegram\.dog)\/|tg:\/\/)([^\s<>]*)/giu);
  return Array.from(references).some(match => {
    const target = match[2]?.replace(/[.,!?;:)\]}]+$/, '') ?? '';
    const name = match[1] ?? (match[0].toLowerCase().startsWith('tg:') ? /^resolve[?/]+domain=([a-z0-9_]+)$/i.exec(target)?.[1] : target);
    return !name || !handles.includes(name.toLowerCase());
  });
}

export function outsideContact(value: string): boolean {
  return withContact(value) || /(?:https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.\w{2,}|\+\d(?:[ ().-]*\d){9,14}\b|\b\d{3}[ .-]\d{3}[ .-]\d{2}[ .-]\d{2}\b)/i.test(value);
}

export function isSingleLine(value: string): boolean {
  return value.length > 0 && !/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(value);
}

export function isPublicProfileText(value: string): boolean {
  return isSingleLine(value) && !value.includes('@') && !outsideContact(value);
}
