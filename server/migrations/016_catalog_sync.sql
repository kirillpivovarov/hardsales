CREATE TABLE catalog_sync_sources (
  code text PRIMARY KEY CHECK (code IN ('PCI_IDS', 'NVIDIA_PAGES', 'WIKIPEDIA_DGX')),
  urls text[] NOT NULL CHECK (cardinality(urls) BETWEEN 1 AND 5),
  etag text,
  last_modified text,
  content_sha256 char(64),
  content_bytes integer,
  last_checked_at timestamptz,
  last_changed_at timestamptz,
  last_status text CHECK (last_status IN ('OK', 'NOT_MODIFIED', 'FAILED', 'REJECTED')),
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_failure_day date,
  last_successful_slot text
);

INSERT INTO catalog_sync_sources (code, urls) VALUES
  ('PCI_IDS', ARRAY['https://pci-ids.ucw.cz/v2.2/pci.ids', 'https://raw.githubusercontent.com/pciutils/pciids/master/pci.ids']),
  ('NVIDIA_PAGES', ARRAY['https://www.nvidia.com/en-us/data-center/products/', 'https://www.nvidia.com/en-us/data-center/hgx/', 'https://docs.nvidia.com/dgx-systems/index.html']),
  ('WIKIPEDIA_DGX', ARRAY['https://en.wikipedia.org/w/api.php?action=parse&page=Nvidia_DGX&prop=wikitext&format=json']);

CREATE TABLE catalog_sync_urls (
  source text NOT NULL REFERENCES catalog_sync_sources(code) ON DELETE CASCADE,
  url text NOT NULL,
  etag text,
  last_modified text,
  content_sha256 char(64),
  content_bytes integer,
  last_checked_at timestamptz,
  last_status text CHECK (last_status IN ('OK', 'NOT_MODIFIED', 'FAILED', 'REJECTED')),
  last_error text,
  request_day date,
  requests integer NOT NULL DEFAULT 0 CHECK (requests BETWEEN 0 AND 4),
  retry_at timestamptz,
  last_successful_slot text,
  PRIMARY KEY (source, url)
);

CREATE TABLE catalog_sync_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL REFERENCES catalog_sync_sources(code),
  kind text NOT NULL CHECK (kind IN ('NEW_MODEL', 'LINK_PCI', 'RENAMED', 'GONE', 'SIGNAL')),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  raw_name text NOT NULL CHECK (length(raw_name) BETWEEN 1 AND 200),
  codename text,
  model_id text REFERENCES hardware_models(id),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  note text,
  UNIQUE (source, kind, external_id)
);
CREATE INDEX catalog_sync_items_queue_idx ON catalog_sync_items (first_seen_at, id) WHERE status = 'PENDING';

CREATE TABLE catalog_sync_pci_observations (
  pci_id text PRIMARY KEY CHECK (pci_id ~ '^[0-9a-f]{4}:[0-9a-f]{4}$'),
  raw_name text,
  missing_since timestamptz
);

ALTER TABLE hardware_models ADD COLUMN pci_last_seen_at timestamptz;
