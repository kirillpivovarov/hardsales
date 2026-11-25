import { BadRequestException } from '@nestjs/common'

export const catalogSources = ['PCI_IDS', 'NVIDIA_PAGES', 'WIKIPEDIA_DGX'] as const
export type CatalogSource = typeof catalogSources[number]
export const MAX_CATALOG_BYTES = 5 * 1024 * 1024

const hosts: Record<CatalogSource, ReadonlySet<string>> = {
  PCI_IDS: new Set(['pci-ids.ucw.cz', 'raw.githubusercontent.com']),
  NVIDIA_PAGES: new Set(['www.nvidia.com', 'docs.nvidia.com']),
  WIKIPEDIA_DGX: new Set(['en.wikipedia.org']),
}

export function sourceUrl(source: CatalogSource, raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 1000) throw invalidUrl()
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || !hosts[source].has(url.hostname) || url.port || url.username || url.password || url.hash) {
      throw invalidUrl()
    }
    return url.href
  } catch {
    throw invalidUrl()
  }
}

function invalidUrl() {
  return new BadRequestException('Разрешены только HTTPS-адреса из списка доменов источника, без реквизитов и фрагмента')
}

export class CatalogPayloadError extends Error {}

export async function readCatalogBody(response: Response): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > MAX_CATALOG_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new CatalogPayloadError('Ответ больше 5 МиБ')
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const parts: Buffer[] = []
  let bytes = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) return Buffer.concat(parts, bytes)
      bytes += result.value.byteLength
      if (bytes > MAX_CATALOG_BYTES) {
        await reader.cancel().catch(() => {})
        throw new CatalogPayloadError('Ответ больше 5 МиБ')
      }
      parts.push(Buffer.from(result.value))
    }
  } finally {
    reader.releaseLock()
  }
}

const includePci = [
  /^(GH200|H100|H100L|H200|H300|H800|H20)\b/, /^(B100|B200|B300|GB200|GB300)\b/,
  /^(A100|A800|A40|A30|A16|A10G?|A2)\b/, /^(L40S|L40|L20|L4|L2)\b/, /^Tesla T4\b/,
  /^RTX PRO \d{4}\b/, /^RTX \d{4} Ada\b/, /^RTX A\d{4}\b/, /^GeForce RTX (4090|5090)( D)?\b/,
  /^(Rubin|R100|R200|VR200)\b/,
]
const excludePci = /(Mobile|Laptop|Max-Q|Notebook|Embedded|Engineering Sample|Lite Hash Rate|LHR|\bM\d?\b|\bES\b)/i

interface PciDevice { id: string; vendor: string; codename: string | null; names: string[] }

/** Count every unique device row for integrity, then apply the allowlist to its individual names. */
export function parsePciIds(text: string, vendors: string[]): Map<string, PciDevice> {
  const devices = new Map<string, PciDevice>()
  let vendor = ''
  for (const row of text.split(/\r?\n/)) {
    if (row.startsWith('C ')) break
    if (!row || row[0] === '#' || row.startsWith('\t\t')) continue
    const header = /^([0-9a-f]{4})  .+$/i.exec(row)
    if (header) {
      vendor = header[1].toLowerCase()
      continue
    }
    if (!vendors.includes(vendor)) continue
    const device = /^\t([0-9a-f]{4})  (.+)$/i.exec(row)
    if (!device) continue
    const id = `${vendor}:${device[1].toLowerCase()}`
    const details = /^(\S+)\s+\[(.+)\]$/.exec(device[2].trim())
    const names = (details?.[2].split(' / ') ?? []).map(name => cleanSourceText(name, 120)).filter(Boolean)
    const codename = details ? cleanSourceText(details[1], 80) || null : null
    devices.set(id, { id, vendor, codename, names: [...new Set([...(devices.get(id)?.names ?? []), ...names])] })
  }
  return devices
}

export function eligiblePciName(name: string): boolean {
  return !excludePci.test(name) && includePci.some(pattern => pattern.test(name))
}

const serverLine = [
  /\b(?:HGX|DGX)\s+(?:(?:GB|B|H|R)\d{2,3}|Rubin)(?:\s+(?:NVL\s*\d+|\d+[-\s]GPU))?\b/gi,
  /\b(?:GB|GR|VR)\d{3}\s+NVL\s*\d+\b/gi,
  /\bVera\s+Rubin(?:\s+NVL\s*\d+)?\b/gi,
  /\bRubin\s+(?:Ultra\s+)?NVL\s*\d+\b/gi,
]

export function serverSignals(source: CatalogSource, text: string): string[] {
  let content: string
  if (source === 'WIKIPEDIA_DGX') {
    let parsed: { parse?: { wikitext?: { '*'?: unknown } | string } }
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new CatalogPayloadError('Некорректный ответ Википедии')
    }
    const raw = parsed?.parse?.wikitext
    const value = typeof raw === 'string' ? raw : raw?.['*']
    if (typeof value !== 'string') throw new CatalogPayloadError('Ответ Википедии не содержит текста статьи')
    content = value
  } else {
    content = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/&(nbsp|#160|#xA0);/gi, ' ').replace(/&(ndash|mdash|#8211|#8212);/gi, '-')
  }
  const names = new Set<string>()
  for (const pattern of serverLine) {
    for (const match of content.matchAll(pattern)) {
      const value = cleanSourceText(match[0], 120)
      if (value) names.add(value)
      if (names.size >= 250) return [...names]
    }
  }
  return [...names]
}

function cleanSourceText(text: string, limit: number): string {
  return text.replace(/[\x00-\x20\x7f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit)
}

export function retryDelay(value: string | null, now: Date): number | null {
  if (!value) return null
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now.getTime()
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.min(milliseconds, 7 * 86400 * 1000) : null
}

export function calendarWeek(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7))
  const year = date.getUTCFullYear()
  const week = Math.ceil(((date.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}
