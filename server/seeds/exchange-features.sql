-- Optional fixtures for the isolated maxv demo profile.
UPDATE platform_settings SET value='true'::jsonb
WHERE key IN ('feature_invites','feature_actuality','feature_disclosure_journal','feature_representation',
  'feature_matching','feature_trust_rating') AND updated_by IS NULL;
UPDATE platform_settings SET value='"INVITE"'::jsonb WHERE key='registration_mode' AND updated_by IS NULL;
UPDATE platform_settings SET value='1'::jsonb WHERE key='disclosure_min_level' AND updated_by IS NULL;

INSERT INTO users (id,username,display_name,email,password_hash,role,participant_type,company_name,city,country,telegram,
  email_verified_at,onboarding_state,representation_mode,rules_accepted_version,rules_accepted_at,verification_level)
VALUES
  ('00000000-0000-4000-8000-000000000004','testagent','Север','testagent@example.test',
    'scrypt$ae3df5b06e353b8ca49adc83b784fe81$b954912cd5fb6073f1aa502583a89dbcc5004e89c8a64b6f6aa8a007e34122499d9c979e71da27e9a3b7fe1df7b4adbb7d28414402ce97d29f5008151bfc5831','SELLER','COMPANY','Демо представительство','Казань','RU','maxv_demo_agent',now(),'DONE','AGENT','1.0',now(),1),
  ('00000000-0000-4000-8000-000000000005','testmod','Модератор maxv','testmod@example.test',
    'scrypt$a546c443873045c7db91cdb0fa2369bf$b642ef676e6d440c67c5db69418685ac75b60757540b3f778a7f393fa2ac16e9553957ab0a8f585ab068c19ff6a800728011ee2126f5f212c7e1819abbff33ed','MODERATOR',NULL,NULL,NULL,NULL,NULL,now(),'EXEMPT','DIRECT',NULL,NULL,0)
ON CONFLICT DO NOTHING;

INSERT INTO user_principals (id,user_id,number,name,company)
SELECT '00000000-0000-4000-9001-000000000004',id,1,'Демо представитель','Демо поставщик'
FROM users WHERE id='00000000-0000-4000-8000-000000000004'
ON CONFLICT DO NOTHING;

UPDATE users SET verification_level=greatest(verification_level,1)
WHERE id IN ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002');

UPDATE listings l SET model_id=v.model, analog_model_ids=v.analogs
FROM (VALUES
  ('00000000-0000-4000-8110-000000000001'::uuid,'h100-sxm',ARRAY[]::text[]),
  ('00000000-0000-4000-8110-000000000002','h200-sxm',ARRAY[]::text[]),
  ('00000000-0000-4000-8110-000000000003','l40s',ARRAY[]::text[]),
  ('00000000-0000-4000-8110-000000000004','hgx-h100-8',ARRAY[]::text[]),
  ('00000000-0000-4000-8110-000000000011','h100-sxm',ARRAY[]::text[]),
  ('00000000-0000-4000-8110-000000000012','l40s',ARRAY['l40']),
  ('00000000-0000-4000-8110-000000000013','hgx-h200-8',ARRAY[]::text[])
) AS v(id,model,analogs)
WHERE l.id=v.id AND l.model_id IS NULL AND EXISTS (
  SELECT 1 FROM hardware_models h JOIN categories c ON c.slug=h.category_slug
  WHERE h.id=v.model AND c.id=l.category_id
);

INSERT INTO price_corridors(model_id,basis,min_usd,max_usd)
SELECT id,'SELLER_WAREHOUSE',low,high FROM (VALUES
  ('hgx-h100-8',210000,250000),('hgx-h200-8',285000,330000),('hgx-b200-8',380000,440000),
  ('hgx-b300-8',470000,540000),('mi300x-8',215000,265000),('srv-l40s-8',75000,95000),
  ('rtx-pro-6000',8000,9600),('h200-nvl',28500,34000),('h100-pcie',22000,27000),('l40s',7200,8600)
) AS v(id,low,high) WHERE EXISTS (SELECT 1 FROM hardware_models h WHERE h.id=v.id)
ON CONFLICT DO NOTHING;

UPDATE listings SET asked_at=now()-interval '3 hours'
WHERE id='00000000-0000-4000-8110-000000000001' AND status='ACTIVE' AND asked_at IS NULL;
INSERT INTO listing_actuality_asks(listing_id,owner_id,local_date,asked_at)
SELECT id,owner_id,(asked_at AT TIME ZONE 'Europe/Moscow')::date,asked_at
FROM listings WHERE id='00000000-0000-4000-8110-000000000001' AND asked_at IS NOT NULL
ON CONFLICT DO NOTHING;
UPDATE listings SET status='HIDDEN',hidden_reason='NO_ANSWER',hidden_at=now()-interval '2 days'
WHERE id='00000000-0000-4000-8110-000000000008' AND status='ACTIVE';

INSERT INTO job_runs (job,slot,status,finished_at,stats)
SELECT 'actuality.ask',(now() AT TIME ZONE (value#>>'{}'))::date::text,'SKIPPED',now(),'{"reason":"demo-activation"}'
FROM platform_settings WHERE key='timezone'
ON CONFLICT DO NOTHING;
