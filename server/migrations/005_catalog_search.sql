-- Both stored documents and queries use the same normalizer. Keep future
-- dictionary changes in a new migration that rebuilds the affected documents.
CREATE FUNCTION market_search_words(source text) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  value text := normalize(coalesce(source, ''), NFKC);
  token text;
  words text[] := '{}';
BEGIN
  value := translate(value, U&'\00AD\200B\200C\200D\2060\FEFF', '');
  -- Match explicit bytes/second before folding case, which otherwise merges
  -- technical notation GB/s (bytes) with Gb/s (bits).
  value := regexp_replace(value, '(\m[0-9]+(?:[.,][0-9]+)?)[[:space:]-]*(GB[[:space:]]*/[[:space:]]*[sS]|GBps|ГБ[[:space:]]*/[[:space:]]*[сС])\M', '\1gbyteps', 'g');
  value := lower(value);
  value := translate(value, 'ЁАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯІЇЄ', 'ёабвгдежзийклмнопрстуфхцчшщъыьэюяіїє');
  value := translate(value, 'ё‐‑‒–—−', 'е------');
  value := regexp_replace(value, '([0-9]),([0-9])', '\1.\2', 'g');
  value := regexp_replace(value, '(\m[0-9]+\.[0-9]*[1-9])0+(?![0-9.])', '\1', 'g');
  value := regexp_replace(value, '(\m[0-9]+)\.0+(?![0-9.])', '\1', 'g');

  -- Equipment families, common brand spellings, and interface names.
  value := regexp_replace(value, '\m(нвидиа|нвидия|энвидиа|энвидия)\M', 'nvidia', 'g');
  value := regexp_replace(value, '\mамд\M', 'amd', 'g');
  value := regexp_replace(value, '\m(эпик|эпиц|эпык)\M', 'epyc', 'g');
  value := regexp_replace(value, '\mинтел\M', 'intel', 'g');
  value := regexp_replace(value, '\m(ксеон|зеон)\M', 'xeon', 'g');
  value := regexp_replace(value, '\m(делл|дел)\M', 'dell', 'g');
  value := regexp_replace(value, '\m(power[[:space:]-]*edge|пауэр[[:space:]-]*эдж|повер[[:space:]-]*эдж)\M', 'poweredge', 'g');
  value := regexp_replace(value, '\m(super[[:space:]-]*micro|супер[[:space:]-]*микро)\M', 'supermicro', 'g');
  value := regexp_replace(value, '\m(think[[:space:]-]*system|синк[[:space:]-]*систем|тинк[[:space:]-]*систем)\M', 'thinksystem', 'g');
  value := regexp_replace(value, '\m(hewlett[[:space:]-]+packard(?:[[:space:]-]+enterprise)?|хп[еэ]|аш[[:space:]-]*пи[[:space:]-]*и)\M', 'hpe', 'g');
  value := regexp_replace(value, '\m(инфинибенд|инфинибанд|infini[[:space:]-]*band)\M', 'infiniband', 'g');
  value := regexp_replace(value, '\m(pci[[:space:]-]*(express|e)|пси[[:space:]-]*экспресс|пи[[:space:]-]*си[[:space:]-]*ай[[:space:]-]*экспресс)\M', 'pcie', 'g');
  value := regexp_replace(value, '\m(nv[[:space:]-]*me|нвме)\M', 'nvme', 'g');
  value := regexp_replace(value, '\m(схм|схэм)\M', 'sxm', 'g');
  value := regexp_replace(value, '\m(ge[[:space:]-]*force|ге[[:space:]-]*форс|дже[[:space:]-]*форс)\M', 'geforce', 'g');
  value := regexp_replace(value, '\mgeforce[[:space:]-]+((?:20|30|40|50)[0-9]{2}(?:ti|super)?)\M', 'geforce rtx\1', 'g');
  value := regexp_replace(value, '\mртх(?=[[:space:]0-9-]|$)', 'rtx', 'g');
  value := regexp_replace(value, '\mгтх(?=[[:space:]0-9-]|$)', 'gtx', 'g');
  value := regexp_replace(value, '\mрх(?=[[:space:]0-9-]|$)', 'rx', 'g');
  value := regexp_replace(value, '\m(самсунг|самсонг)\M', 'samsung', 'g');
  value := regexp_replace(value, '\mленово\M', 'lenovo', 'g');

  -- Match category names and abbreviations used in editable descriptions/specs.
  value := regexp_replace(value, '\m(гпу|джипиу|видеокарт[а-я]*|графическ[а-я]+[[:space:]-]+ускорител[а-я]*)\M', 'gpu', 'g');
  value := regexp_replace(value, '\m(цпу|процессор[а-я]*)\M', 'cpu', 'g');
  value := regexp_replace(value, '\m(озу|оперативн[а-я]+[[:space:]-]+памят[а-я]+)\M', 'ram', 'g');
  value := regexp_replace(value, '\m(ссд|твердотельн[а-я]+[[:space:]-]+накопител[а-я]*)\M', 'ssd', 'g');
  value := regexp_replace(value, '\m(видеопамят[а-я]+|графическ[а-я]+[[:space:]-]+памят[а-я]+)\M', 'vram', 'g');

  -- Equivalent unit spellings keep the actual numeric value and unit distinct.
  value := regexp_replace(value, '(\m[0-9]+(?:\.[0-9]+)?)[[:space:]-]*(gb[[:space:]]*/[[:space:]]*s|gbit[[:space:]]*/[[:space:]]*s|gbps|гбит[[:space:]]*/[[:space:]]*(с|сек))\M', '\1gbps', 'g');
  value := regexp_replace(value, '(\m[0-9]+(?:\.[0-9]+)?)[[:space:]-]*(gb|гб|гбайт[а-я]*|гигабайт[а-я]*|gigabytes?)\M', '\1gb', 'g');
  value := regexp_replace(value, '(\m[0-9]+(?:\.[0-9]+)?)[[:space:]-]*(tb|тб|тбайт[а-я]*|терабайт[а-я]*|terabytes?)\M', '\1tb', 'g');
  value := regexp_replace(value, '(\m[0-9]+(?:\.[0-9]+)?)[[:space:]-]*(mb|мб|мбайт[а-я]*|мегабайт[а-я]*|megabytes?)\M', '\1mb', 'g');
  value := regexp_replace(value, '(\m[0-9]+(?:\.[0-9]+)?)[[:space:]-]*(mhz|мгц|мегагерц[а-я]*)\M', '\1mhz', 'g');
  value := regexp_replace(value, '(\m[0-9]+(?:\.[0-9]+)?)[[:space:]-]*(ghz|ггц|гигагерц[а-я]*)\M', '\1ghz', 'g');
  value := regexp_replace(value, '(\m[0-9]+)[[:space:]-]*(u|юнит[а-я]*)\M', '\1u', 'g');

  -- Preserve equipment model identifiers, with predictable separators/suffixes.
  value := regexp_replace(value, '\ms[xх][mм][[:space:]-]+([0-9])\M', 'sxm\1', 'g');
  value := regexp_replace(value,
    '\m([ahlbrpqtvkmанлвбрпктм]|m[iіи]|м[iіи]|[rр][tт][xх]|[gг][tт][xх]|[rр][xх]|dl|sr|sp|ddr|hbm)[[:space:]-]+([0-9]+(?:xa|ti|xtx|xt|x|s|p|super)?)\M',
    '\1\2', 'g');
  value := regexp_replace(value, '\m([a-zа-яі]{1,8})-([0-9][a-zа-яі0-9]*)\M', '\1\2', 'g');
  value := regexp_replace(value, '\m([a-zа-яі]{1,3}[0-9]{2,5})[[:space:]-]+(xa|ti|xt|x|s|p|super)\M', '\1\2', 'g');
  value := regexp_replace(value, '\m([a-zа-яі]{1,3}[0-9]{2,5})(sxm[0-9]*|pcie|nvl)\M', '\1 \2', 'g');
  value := regexp_replace(value, '\m(epyc|xeon)([0-9][a-z0-9]*)\M', '\1 \2', 'g');

  FOR token IN
    SELECT match[1] FROM regexp_matches(value, '([0-9]+(?:\.[0-9]+)?[а-яіїє[:alnum:]]*|[а-яіїє[:alnum:]]+)', 'g') AS match
  LOOP
    IF token ~ '^[a-zа-яіїє]+[0-9]' OR (token ~ '[a-z]' AND token ~ '[а-яіїє]') THEN
      -- Cyrillic characters copied into Latin model codes are visual equivalents.
      token := translate(token, 'авекмнорстухі', 'abekmhopctyxi');
    END IF;

    token := replace(replace(replace(replace(token, 'ж', 'zh'), 'ч', 'ch'), 'ш', 'sh'), 'щ', 'sch');
    token := replace(replace(replace(replace(token, 'ц', 'ts'), 'ю', 'yu'), 'я', 'ya'), 'ї', 'yi');
    token := translate(token, 'абвгдезийклмнопрстуфхыеэієъь', 'abvgdeziyklmnoprstufxyeeie');
    IF token <> '' THEN words := array_append(words, token); END IF;
  END LOOP;
  RETURN words;
END;
$$;

CREATE FUNCTION market_search_document(words text[]) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT words || ARRAY(
    SELECT DISTINCT alias
    FROM unnest(words) AS word
    CROSS JOIN LATERAL (
      VALUES
        (substring(word FROM '^(?:rtx|gtx|rx)([0-9]{4})(?:ti|super|xt|xtx)?$')),
        (CASE WHEN word ~ '^(rtx(?:20|30|40|50)|gtx(?:10|16))[0-9]{2}(?:ti|super)?$' THEN 'geforce' END),
        (CASE WHEN word ~ '^sxm[0-9]+$' THEN 'sxm' END)
    ) AS aliases(alias)
    WHERE alias IS NOT NULL
  )
$$;

CREATE FUNCTION market_search_spelling_keys(words text[]) RETURNS integer[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  -- Shared deletion keys generate a shortlist for a separate edit check.
  -- Stable 32-bit keys keep the index compact. Collisions cannot pass the check.
  SELECT coalesce(array_agg(DISTINCT ('x' || left(md5(form), 8))::bit(32)::integer), '{}')
  FROM unnest(words) AS word
  CROSS JOIN LATERAL (
    SELECT word AS form
    UNION ALL
    SELECT substring(word FROM 1 FOR i - 1) || substring(word FROM i + 1)
    FROM generate_series(1, length(word)) AS i
  ) AS forms
  WHERE word ~ '^[a-z]{4,32}$'
$$;

CREATE FUNCTION market_search_one_edit(left_word text, right_word text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  left_size integer := length(left_word);
  right_size integer := length(right_word);
  first_diff integer := 1;
BEGIN
  IF abs(left_size - right_size) > 1 THEN RETURN false; END IF;
  WHILE first_diff <= least(left_size, right_size)
    AND substr(left_word, first_diff, 1) = substr(right_word, first_diff, 1)
  LOOP
    first_diff := first_diff + 1;
  END LOOP;
  IF left_size > right_size THEN
    RETURN substr(left_word, first_diff + 1) = substr(right_word, first_diff);
  ELSIF left_size < right_size THEN
    RETURN substr(left_word, first_diff) = substr(right_word, first_diff + 1);
  END IF;

  RETURN substr(left_word, first_diff + 1) = substr(right_word, first_diff + 1)
    OR (
      substr(left_word, first_diff, 1) = substr(right_word, first_diff + 1, 1)
      AND substr(left_word, first_diff + 1, 1) = substr(right_word, first_diff, 1)
      AND substr(left_word, first_diff + 2) = substr(right_word, first_diff + 2)
    );
END;
$$;

CREATE FUNCTION market_search_rank(query_words text[], title_words text[], listing_words text[], related_words text[])
RETURNS integer LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  term text;
  score integer := 0;
  word_pool text[] := listing_words || related_words;
BEGIN
  FOREACH term IN ARRAY query_words LOOP
    IF term = ANY(title_words) THEN
      score := score + 24;
    ELSIF term = ANY(listing_words) THEN
      score := score + 12;
    ELSIF term = ANY(related_words) THEN
      score := score + 8;
    ELSIF term ~ '^[a-z]{5,32}$' AND EXISTS (
      SELECT 1 FROM unnest(word_pool) AS word
      WHERE word ~ '^[a-z]{4,32}$' AND market_search_one_edit(term, word)
    ) THEN
      score := score + 1;
    ELSE
      RETURN NULL;
    END IF;
  END LOOP;

  IF cardinality(query_words) > 0 AND strpos(
    ' ' || array_to_string(title_words, ' ') || ' ',
    ' ' || array_to_string(query_words, ' ') || ' '
  ) > 0 THEN
    score := score + 32;
    IF query_words = title_words THEN score := score + 32; END IF;
  END IF;
  RETURN score;
END;
$$;

ALTER TABLE listings
  ADD COLUMN search_title_words text[] GENERATED ALWAYS AS (market_search_words(title)) STORED,
  ADD COLUMN search_words text[] GENERATED ALWAYS AS (
    market_search_document(
      market_search_words(title) || market_search_words(description)
      || market_search_words(specs::text) || market_search_words(stock_city)
    )
  ) STORED;

ALTER TABLE categories
  ADD COLUMN search_words text[] GENERATED ALWAYS AS (
    market_search_words(name) || market_search_words(short_name) || market_search_words(translations::text)
  ) STORED;

ALTER TABLE users
  ADD COLUMN search_city_words text[] GENERATED ALWAYS AS (market_search_words(city)) STORED,
  ADD COLUMN search_words text[] GENERATED ALWAYS AS (
    market_search_words(city) || market_search_words(display_name)
  ) STORED;

CREATE INDEX listings_search_words_idx ON listings USING gin (search_words);
CREATE INDEX listings_search_spelling_idx ON listings USING gin (market_search_spelling_keys(search_words));
CREATE INDEX listings_category_idx ON listings(category_id);
CREATE INDEX users_search_words_idx ON users USING gin (search_words);
CREATE INDEX users_search_spelling_idx ON users USING gin (market_search_spelling_keys(search_words));
