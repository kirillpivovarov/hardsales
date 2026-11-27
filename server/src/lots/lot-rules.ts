export type LotOffer = { id: string; ownerId: string; usdPerUnit: string; modelId: string }
export type PrincipalEvidence = {
  listingId: string
  ownerId: string
  membershipRole: string
  representation: string
  confirmedAt: Date | null
  principalUserId: string | null
  principalLegalName: string | null
  ownerCompany: string | null
  exclusiveMandate: boolean | null
  mandateStatus: string | null
  listingStatus: string
}

export const lotResolutions = ['EXCLUSIVE_MANDATE', 'FIRST_CONFIRMED', 'PRINCIPAL_OWN', 'OPERATOR'] as const
const sameKey = (name: string | null) => name?.trim().toLowerCase().replaceAll('ё', 'е').replace(/\s+/g, ' ') || null

function fixedPrice(input: string) {
  const [whole, fractional = ''] = input.split('.')
  return BigInt(whole + fractional.padEnd(10, '0'))
}

export function lotComponents(offers: LotOffer[], exclusions: { listingA: string; listingB: string }[], tolerance: number) {
  const indexed = offers.map(offer => ({ offer, price: fixedPrice(offer.usdPerUnit) })).sort((a, b) =>
    a.price < b.price ? -1 : a.price > b.price ? 1 : a.offer.id.localeCompare(b.offer.id))
  const forbidden = new Map<string, Set<string>>()
  for (const { listingA, listingB } of exclusions) {
    for (const [a, b] of [[listingA, listingB], [listingB, listingA]]) {
      if (!forbidden.has(a)) forbidden.set(a, new Set())
      forbidden.get(a)!.add(b)
    }
  }
  const clusters = new Map(indexed.map(({ offer }) => [offer.id, new Set([offer])]))
  const scale = 100000000n
  const limit = BigInt(Math.round(tolerance * Number(scale)))
  for (let index = 0; index < indexed.length; index++) {
    const a = indexed[index]
    for (let right = index + 1; right < indexed.length; right++) {
      const b = indexed[right]
      if ((b.price - a.price) * scale > a.price * limit) break
      if (a.offer.ownerId === b.offer.ownerId) continue
      const leftCluster = clusters.get(a.offer.id)!
      const rightCluster = clusters.get(b.offer.id)!
      if (leftCluster === rightCluster) continue
      // An operator's explicit exclusion wins even when a third offer connects both sides.
      const conflicts = [...leftCluster].some(left => [...rightCluster].some(right => forbidden.get(left.id)?.has(right.id)))
      if (conflicts) continue
      for (const member of rightCluster) {
        leftCluster.add(member)
        clusters.set(member.id, leftCluster)
      }
    }
  }
  return [...new Set(clusters.values())].filter(cluster => cluster.size > 1).map(cluster => [...cluster])
}

export function recommendLotPrimary(members: PrincipalEvidence[], sharedOverride: boolean | null, principalOwnerListingId: string | null) {
  const active = members.filter(member => member.membershipRole === 'MEMBER' && member.listingStatus === 'ACTIVE')
  const linkedUsers = active.map(member => member.representation === 'DIRECT' ? member.ownerId : member.principalUserId)
  const legalNames = active.map(member => sameKey(member.representation === 'DIRECT' ? member.ownerCompany : member.principalLegalName))
  const shared = sharedOverride ?? Boolean(
    active.length > 1 && (linkedUsers.every(value => value && value === linkedUsers[0])
      || legalNames.every(value => value && value === legalNames[0]))
  )
  if (!shared) return null
  const agents = active.filter(member => member.representation === 'AGENT')
  const exclusive = agents.filter(member => member.exclusiveMandate && member.mandateStatus === 'APPROVED')
  if (exclusive.length > 1) return null
  if (exclusive.length === 1) return { listingId: exclusive[0].listingId, resolution: 'EXCLUSIVE_MANDATE' as const }
  const confirmed = agents.filter(member => member.confirmedAt).sort((a, b) =>
    a.confirmedAt!.getTime() - b.confirmedAt!.getTime() || a.listingId.localeCompare(b.listingId))
  if (confirmed.length) return { listingId: confirmed[0].listingId, resolution: 'FIRST_CONFIRMED' as const }
  const owner = active.find(member => member.representation === 'DIRECT' &&
    (member.listingId === principalOwnerListingId || agents.some(agent => agent.principalUserId === member.ownerId)))
  return owner ? { listingId: owner.listingId, resolution: 'PRINCIPAL_OWN' as const } : null
}
