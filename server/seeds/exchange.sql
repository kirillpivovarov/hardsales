INSERT INTO invites (id, code, note, preset_role, created_by, expires_at, used_by, used_at)
VALUES
  ('00000000-0000-4000-9000-000000000001', 'K7PQ-M2XA', 'Приглашение для демо-покупателя', 'BUYER',
    '00000000-0000-4000-8000-000000000003', now() + interval '30 days', NULL, NULL),
  ('00000000-0000-4000-9000-000000000002', 'H3BC-X5LM', 'Приглашение для демо-продавца', 'SELLER',
    '00000000-0000-4000-8000-000000000003', now() + interval '30 days', NULL, NULL),
  ('00000000-0000-4000-9000-000000000003', 'N4DP-F6ZX', 'Использованное приглашение', 'SELLER',
    '00000000-0000-4000-8000-000000000003', now() + interval '30 days',
    '00000000-0000-4000-8000-000000000001', now())
ON CONFLICT DO NOTHING;

UPDATE users
SET onboarding_state = 'DONE',
  onboarding_submitted_at = now(),
  rules_accepted_version = '1.0',
  rules_accepted_at = now(),
  invite_id = (SELECT id FROM invites WHERE used_by = users.id)
WHERE id IN ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002')
  AND onboarding_state = 'EXEMPT';
