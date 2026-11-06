BEGIN;

DO $$
DECLARE
  invalid_columns text;
BEGIN
  IF to_regclass('public.events') IS NULL THEN
    RAISE EXCEPTION 'Cannot add event times because public.events does not exist.';
  END IF;

  SELECT string_agg(format('%I has type %s (expected time without time zone)', column_name, data_type), ', ')
  INTO invalid_columns
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'events'
    AND column_name IN ('start_time', 'end_time')
    AND data_type <> 'time without time zone';

  IF invalid_columns IS NOT NULL THEN
    RAISE EXCEPTION 'Event time migration found incompatible columns: %', invalid_columns;
  END IF;
END;
$$;

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS start_time time without time zone,
  ADD COLUMN IF NOT EXISTS end_time time without time zone;

COMMIT;
