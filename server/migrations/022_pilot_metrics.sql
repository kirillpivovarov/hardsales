INSERT INTO platform_settings (key, value) VALUES
  ('pilot_period', '{"from":"2026-11-25","to":"2026-12-08"}'),
  ('stop_rule', '{"date":"2026-12-08","minLiveMatches":3}'),
  ('pilot_targets', '{"confirmedPerDay":15,"matches":10,"liveMatches":3,"disclosures":3,"dealsAgreed":1,"onTimeShare":0.7}'),
  ('pilot_excluded_users', '[]');

CREATE TABLE pilot_daily_snapshots (
  local_date date PRIMARY KEY,
  taken_at timestamptz NOT NULL DEFAULT now(),
  late boolean NOT NULL DEFAULT false,
  listings_visible_sell integer NOT NULL,
  listings_visible_buy integer NOT NULL,
  listings_hidden integer NOT NULL,
  participants_by_level jsonb NOT NULL
);

ALTER TABLE deals ADD COLUMN agreed_at timestamptz;
UPDATE deals SET agreed_at = updated_at WHERE status IN ('AGREED', 'EXECUTED');
