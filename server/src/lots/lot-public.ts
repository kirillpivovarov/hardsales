export const lotGroupsEnabledSql = "EXISTS (SELECT 1 FROM platform_settings WHERE key='feature_lot_groups' AND value='true'::jsonb)"

export const lotMembershipJoin = `
  LEFT JOIN lot_group_members lm ON lm.listing_id=l.id AND lm.role='MEMBER'
  LEFT JOIN lot_groups lg ON lg.id=lm.group_id AND lg.status='OPEN' AND lg.lot_key=l.lot_key
`

export const ownLotFields = `
  l.duplicate_of IS NOT NULL AS "isDuplicate",
  CASE WHEN ${lotGroupsEnabledSql} THEN EXISTS (
    SELECT 1 FROM lot_group_members lm JOIN lot_groups lg ON lg.id=lm.group_id
    WHERE lm.listing_id=l.id AND lm.role='MEMBER' AND lg.status='OPEN' AND lg.lot_key=l.lot_key
  ) ELSE false END AS "similarLot",
  EXISTS(SELECT 1 FROM lot_duplicate_appeals a WHERE a.listing_id=l.id AND a.resolved_at IS NULL) AS "duplicateAppealed"
`
