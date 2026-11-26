import { detectContacts } from './detect'

export type PublicProfileText = {
  nickname: string
  city: string | null
}

export type PublicListingText = {
  title: string
  description: string
  stockCity: string | null
  specs: Record<string, string>
  owner: PublicProfileText
}

const containsContact = (text: string) => detectContacts(text).length > 0

export function publicListingTitle(title: string) {
  return containsContact(title) ? 'Заголовок скрыт' : title
}

export function publicNickname(nickname: string) {
  return containsContact(nickname) ? 'Имя скрыто' : nickname
}

export function publicCity(city: string | null) {
  return city && containsContact(city) ? null : city
}

export function withoutLegacyProfileContacts<T extends PublicProfileText>(profile: T): T {
  return { ...profile, nickname: publicNickname(profile.nickname), city: publicCity(profile.city) }
}

// Older records can contain text that predates the stricter write checks.
// Keep originals available to their owners and staff; mask only peer-facing views.
export function withoutLegacyListingContacts<T extends PublicListingText>(listing: T): T {
  return {
    ...listing,
    title: publicListingTitle(listing.title),
    description: containsContact(listing.description) ? 'Описание скрыто: в нём были контакты' : listing.description,
    stockCity: publicCity(listing.stockCity),
    owner: withoutLegacyProfileContacts(listing.owner),
    specs: Object.fromEntries(Object.entries(listing.specs)
      .filter(([key]) => !containsContact(key))
      .map(([key, value]) => [key, containsContact(value) ? 'Значение скрыто' : value])),
  }
}
