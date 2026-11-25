import { BadRequestException } from '@nestjs/common'
import type { Queryable } from '../database/database.service'

const transliteration: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

function words(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/[а-яё]/g, letter => transliteration[letter])
    .split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 4)
}

export async function assertCompanyAlias(
  db: Queryable, companyName: string | null | undefined, ...nicknames: (string | null | undefined)[]
) {
  const aliases = nicknames.filter((name): name is string => Boolean(name))
  if (!companyName || !aliases.length) return
  const { rows: [result] } = await db.query<{ enabled: boolean; matches: boolean }>(`
    SELECT EXISTS (SELECT 1 FROM platform_settings WHERE key = 'feature_disclosure_journal' AND value = 'true'::jsonb) AS enabled,
      EXISTS (
        SELECT 1 FROM unnest($2::text[]) AS aliases(alias)
        WHERE cardinality(ARRAY(SELECT w FROM unnest(market_search_words($1)) AS w WHERE length(w) >= 4)) > 0
          AND ARRAY(SELECT w FROM unnest(market_search_words($1)) AS w WHERE length(w) >= 4) <@
            market_search_words(aliases.alias)
      ) AS matches
  `, [companyName, aliases])
  if (!result.enabled) return
  const companyWords = words(companyName)
  if (result.matches || (companyWords.length && aliases.some(alias => {
    const aliasWords = new Set(words(alias))
    return companyWords.every(word => aliasWords.has(word))
  }))) throw new BadRequestException('Ник не должен содержать название компании')
}
