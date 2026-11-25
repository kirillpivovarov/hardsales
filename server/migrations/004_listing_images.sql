CREATE TABLE listing_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 10),
  width smallint NOT NULL CHECK (width BETWEEN 1 AND 900),
  height smallint NOT NULL CHECK (height BETWEEN 1 AND 900),
  mime_type text NOT NULL CHECK (mime_type = 'image/webp'),
  content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 2097152),
  UNIQUE (listing_id, position) DEFERRABLE INITIALLY IMMEDIATE
);
