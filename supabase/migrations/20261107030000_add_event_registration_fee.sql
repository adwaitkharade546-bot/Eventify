BEGIN;

DO $migration$
DECLARE
  existing_type text;
BEGIN
  IF to_regclass('public.events') IS NULL THEN
    RAISE EXCEPTION 'Cannot add event registration fees because public.events does not exist.';
  END IF;

  SELECT data_type
  INTO existing_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'events'
    AND column_name = 'price';

  IF existing_type IS NOT NULL AND existing_type <> 'numeric' THEN
    RAISE EXCEPTION
      'public.events.price has type %, expected numeric. Inspect existing fee data before migrating.',
      existing_type;
  END IF;
END;
$migration$;

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS price numeric(10, 2) DEFAULT 0;

UPDATE public.events
SET price = 0
WHERE price IS NULL;

DO $constraints$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.events
    WHERE price < 0
  ) THEN
    RAISE EXCEPTION 'Existing event registration fees cannot be negative.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.events'::regclass
      AND conname = 'events_price_nonnegative_check'
  ) THEN
    ALTER TABLE public.events
      ADD CONSTRAINT events_price_nonnegative_check CHECK (price >= 0);
  END IF;
END;
$constraints$;

ALTER TABLE public.events
  ALTER COLUMN price SET DEFAULT 0,
  ALTER COLUMN price SET NOT NULL;

GRANT SELECT (price) ON TABLE public.events TO anon;

COMMIT;
