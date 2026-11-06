BEGIN;

DO $migration$
DECLARE
  invalid_columns text;
BEGIN
  IF to_regclass('public.events') IS NULL THEN
    RAISE EXCEPTION 'Cannot add event departments because public.events does not exist.';
  END IF;

  SELECT string_agg(
    format('%I has type %s', column_name, data_type),
    ', '
  )
  INTO invalid_columns
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'events'
    AND (
      (column_name = 'organizing_department'
        AND data_type NOT IN ('text', 'character varying', 'character'))
      OR
      (column_name = 'target_departments'
        AND (data_type <> 'ARRAY' OR udt_name <> '_text'))
    );

  IF invalid_columns IS NOT NULL THEN
    RAISE EXCEPTION 'Event department migration found incompatible columns: %', invalid_columns;
  END IF;
END;
$migration$;

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS organizing_department text,
  ADD COLUMN IF NOT EXISTS target_departments text[] NOT NULL DEFAULT ARRAY[]::text[];

UPDATE public.events
SET target_departments = ARRAY[]::text[]
WHERE target_departments IS NULL;

ALTER TABLE public.events
  ALTER COLUMN target_departments SET DEFAULT ARRAY[]::text[],
  ALTER COLUMN target_departments SET NOT NULL;

COMMIT;
