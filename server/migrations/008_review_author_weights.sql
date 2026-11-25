-- Keep every review for moderation, with one current rating per author in the public profile.
CREATE INDEX reviews_public_author_idx ON reviews (subject_id, author_id, created_at DESC, id DESC)
  INCLUDE (rating) WHERE status = 'ACTIVE';
DROP INDEX reviews_public_idx;
