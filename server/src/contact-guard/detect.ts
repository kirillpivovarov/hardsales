export type ContactKind = 'PHONE' | 'EMAIL' | 'TELEGRAM' | 'MESSENGER' | 'LINK' | 'SPLIT'

const sameShape = new Map(Array.from('аеорсхуктмвн').map((letter, index) => [letter, 'aeopcxyktmbh'[index]]))
const foldLatin = (text: string) => text.replace(/[аеорсхуктмвн]/gu, letter => sameShape.get(letter)!)
const normalize = (text: string) => text.split('№').map(part => part.normalize('NFKC')).join('№').toLowerCase().replace(/\p{Cf}/gu, '')

const zones = 'ru|com|net|org|io|uz|kz|cn|ae|me|tech|pro|info|biz|su|pф'
const domain = `[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?\\.(?:${zones})(?![\\p{L}\\p{N}_])`
const mailLocal = "[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]"
const email = new RegExp(`(?<!${mailLocal})${mailLocal}+@(?:[a-z0-9-]+\\.)+[\\p{L}]{2,}(?![\\p{L}\\p{N}_])`, 'u')
const links = new RegExp(`(?:https?:\\/\\/|www\\.|(?<![\\p{L}\\p{N}_])${domain})`, 'u')
const telegramUri = /(?:\b(?:t\.me|telegram\.(?:me|dog))\s*\/|\btg\s*:\/\/)/u
const mention = /(?<![\p{L}\p{N}._%+\-])@[a-z0-9_]{5,32}(?![\p{L}\p{N}_])/u

const telegramLabels = foldLatin('телеграмм?|телега|телеге|телегу|тг|tg|telegram')
const messengerLabels = foldLatin('whatsapp|ватсап|вотсап|вацап|viber|вайбер|wechat|вичат|weixin|signal|сигнал|skype|скайп|вк|instagram|инста|facebook|linkedin|zoom|google[ .]+meet|discord|line|kakaotalk|qq')
const labels = new RegExp(`(?<![\\p{L}\\p{N}_])(?:(?<telegram>${telegramLabels})|(?<messenger>${messengerLabels}))(?![\\p{L}\\p{N}_])`, 'gu')
const messengerUri = /(?:\b(?:wa\.me|vk\.com|whatsapp\.com|discord\.gg|line\.me)\s*\/)/u
const handle = /(?<![\p{L}\p{N}_])[a-z][a-z0-9_]{4,31}(?![\p{L}\p{N}_])/u

const words = new Map<string, number>()
function numberWords(offset: number, step: number, names: string) {
  names.split(' ').forEach((variants, index) => {
    for (const word of variants.split('|')) words.set(word, offset + index * step)
  })
}
numberWords(0, 1, 'ноль|нуль|zero|oh один|одна|one два|две|two три|three четыре|four пять|five шесть|six семь|seven восемь|eight девять|nine')
numberWords(10, 1, 'десять|ten одиннадцать|eleven двенадцать|twelve тринадцать|thirteen четырнадцать|fourteen пятнадцать|fifteen шестнадцать|sixteen семнадцать|seventeen восемнадцать|eighteen девятнадцать|nineteen')
numberWords(20, 10, 'двадцать|twenty тридцать|thirty сорок|forty пятьдесят|fifty шестьдесят|sixty семьдесят|seventy восемьдесят|eighty девяносто|ninety')
numberWords(100, 100, 'сто двести триста четыреста пятьсот шестьсот семьсот восемьсот девятьсот')
const separators = /^[\s.()_\p{Pd}/]*$/u
const phoneParts = /[\p{L}]+|\d+/gu
const units = /[₽$€¥₸£]|(?<![\p{L}\p{N}_])(?:руб(?:лей|ля)?|rur|rub|usd|eur|kzt|aed|cny|шт|единиц[аы]?|гб|тб|мб|gb|tb|mb|вт|квт|мм|см|кг|w|kw|mm|kg)(?![\p{L}\p{N}_])|№/gu

function phoneWords(text: string) {
  let result = ''
  let cursor = 0
  let group: number | undefined
  let lastRank = 0
  const flush = () => {
    if (group !== undefined) result += group
    group = undefined
    lastRank = 0
  }
  for (const token of text.matchAll(phoneParts)) {
    const gap = text.slice(cursor, token.index)
    const word = token[0]
    const number = words.get(word)
    cursor = token.index + word.length
    if (group === undefined || !separators.test(gap) || (number === undefined && word !== 'hundred')) {
      flush()
      result += gap
    }
    if (word === 'hundred' && group !== undefined && group >= 1 && group <= 9) {
      group *= 100
      lastRank = 3
    } else if (number !== undefined) {
      const rank = number >= 100 ? 3 : number >= 10 ? 2 : 1
      if (rank >= lastRank) {
        flush()
        if (separators.test(gap)) result += ' '
      }
      group = (group ?? 0) + number
      lastRank = rank
    } else {
      result += word
    }
  }
  flush()
  return result + text.slice(cursor)
}

function phoneNumber(text: string) {
  const candidates = phoneWords(text)
    .replace(/(?<!\d)(?:\d{4}-\d{2}-\d{2}|\d{1,2}([./-])\d{1,2}\1\d{4})(?!\d)/gu, ' дата ')
    .replace(/(?<=\d)(?:[\s.()_\p{Pd}/]*[оoзl])+[\s.()_\p{Pd}/]*(?=\d)/gu,
      part => part.replace(/[оo]/gu, '0').replace(/з/gu, '3').replace(/l/gu, '1'))
  const measures = Array.from(candidates.matchAll(units), match => ({ start: match.index, end: match.index + match[0].length }))
  for (const number of candidates.matchAll(/(?<![\p{L}\p{N}])(?:\+\s*)?\d(?:[\s.()_\p{Pd}/]*\d){8,}(?![\p{L}\p{N}])/gu)) {
    const start = number.index
    const end = start + number[0].length
    const measured = measures.some(unit => (unit.end <= start && start - unit.end <= 12) || (unit.start >= end && unit.start - end <= 12))
    if (!measured) return true
  }
  return false
}

function contactText(text: string) {
  return foldLatin(text
    .replace(/\s*(?:\(\s*at\s*\)|\[\s*at\s*\]|(?<![\p{L}\p{N}])(?:собака|at)(?![\p{L}\p{N}]))\s*/gu, '@')
    .replace(/\s*(?:\(\s*dot\s*\)|\[\s*\.\s*\]|(?<![\p{L}\p{N}])(?:точка|dot)(?![\p{L}\p{N}]))\s*/gu, '.'))
    .replace(/\bte1egram(?=[\s.:/]|$)/gu, 'telegram')
    .replace(/\.c0m(?![\p{L}\p{N}_])/gu, '.com')
}

export function detectContacts(body: string): ContactKind[] {
  const raw = normalize(body)
  const text = contactText(raw)
  const kinds = new Set<ContactKind>()
  if (phoneNumber(raw)) kinds.add('PHONE')
  if (email.test(text)) kinds.add('EMAIL')
  if (telegramUri.test(text) || mention.test(text)) kinds.add('TELEGRAM')
  if (messengerUri.test(text)) kinds.add('MESSENGER')
  // The nearest service name owns the contact. Stopping at the next marker avoids
  // labelling a WhatsApp number as Telegram when both names appear in a sentence.
  const markers = Array.from(text.matchAll(labels))
  for (const [index, marker] of markers.entries()) {
    const end = marker.index + marker[0].length
    const nearby = text.slice(end, Math.min(end + 40, markers[index + 1]?.index ?? text.length))
    if (handle.test(nearby) || links.test(nearby) || /\d(?:[\s+()._\p{Pd}/]*\d){4}/u.test(nearby)) {
      kinds.add(marker.groups?.telegram ? 'TELEGRAM' : 'MESSENGER')
    }
  }
  const independentLinks = text.replace(new RegExp(email.source, 'gu'), ' ')
  if (links.test(independentLinks) && !telegramUri.test(text) && !messengerUri.test(text)) kinds.add('LINK')
  return [...kinds]
}

export function detectSplitContact(previous: string[], body: string): ContactKind[] {
  for (let start = previous.length - 1; start >= 0; start--) {
    const suffix = previous.slice(start)
    for (const separator of ['\n', '']) {
      const prefix = suffix.join(separator)
      const alreadyPresent = new Set(detectContacts(prefix))
      const kinds = detectContacts(prefix + separator + body).filter(kind => !alreadyPresent.has(kind))
      if (kinds.length) return [...kinds, 'SPLIT']
    }
  }
  return []
}

export function requestsOutsideChat(body: string): boolean {
  const raw = normalize(body)
  return /(?:давай|давайте|перейд[её]м|напиши(?:те)?|пиши(?:те)?|ответь(?:те)?|свяжись|свяжитесь|удобнее|лучше|write|message|let['’]?s)\s[^.!?]{0,50}(?:\b(?:telegram|whatsapp|signal|discord|tg|viber|dm)\b|телеграм|телег[ауе]|ватсап|вотсап|вайбер|мессенджер|личку|вне чата)/u.test(raw)
}
