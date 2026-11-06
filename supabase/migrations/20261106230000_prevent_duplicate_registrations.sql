BEGIN;

DO $migration$
DECLARE
  missing_columns text;
  nullable_columns text;
  duplicates text;
  registrations_rls_enabled boolean;
BEGIN
  SELECT string_agg(required.column_name, ', ')
  INTO missing_columns
  FROM (VALUES
    ('event_id'),
    ('participant_id')
  ) AS required(column_name)
  LEFT JOIN information_schema.columns AS existing
    ON existing.table_schema = 'public'
    AND existing.table_name = 'registrations'
    AND existing.column_name = required.column_name
  WHERE existing.column_name IS NULL;

  IF to_regclass('public.registrations') IS NULL THEN
    RAISE EXCEPTION 'Required table public.registrations does not exist.';
  END IF;

  SELECT relation.relrowsecurity
  INTO registrations_rls_enabled
  FROM pg_class AS relation
  WHERE relation.oid = 'public.registrations'::regclass;

  IF registrations_rls_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'Row Level Security is not enabled on public.registrations. Review and secure the existing registration permissions before applying this migration.';
  END IF;

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'Required columns are missing from public.registrations: %',
      missing_columns;
  END IF;

  SELECT string_agg(existing.column_name, ', ')
  INTO nullable_columns
  FROM information_schema.columns AS existing
  WHERE existing.table_schema = 'public'
    AND existing.table_name = 'registrations'
    AND existing.column_name IN ('event_id', 'participant_id')
    AND existing.is_nullable <> 'NO';

  IF nullable_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot guarantee registration uniqueness because these columns allow NULL: %. Make them NOT NULL only after reviewing existing data.',
      nullable_columns;
  END IF;

  SELECT string_agg(
    format(
      'event_id=%s, participant_id=%s, duplicate_rows=%s',
      duplicate.event_id,
      duplicate.participant_id,
      duplicate.row_count
    ),
    E'\n'
    ORDER BY duplicate.event_id, duplicate.participant_id
  )
  INTO duplicates
  FROM (
    SELECT event_id, participant_id, count(*) AS row_count
    FROM public.registrations
    GROUP BY event_id, participant_id
    HAVING count(*) > 1
    ORDER BY event_id, participant_id
  ) AS duplicate;

  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION
      'Duplicate registrations exist. No changes were made; resolve these records manually and rerun the migration.'
      USING DETAIL = duplicates;
  END IF;
END
$migration$;

CREATE POLICY registrations_insert_own_participant_guard
  ON public.registrations
  AS RESTRICTIVE
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    participant_id::text = (SELECT auth.uid())::text
    AND EXISTS (
      SELECT 1
      FROM public.profiles AS profile
      WHERE profile.id::text = (SELECT auth.uid())::text
        AND profile.role = 'participant'
    )
  );

CREATE UNIQUE INDEX registrations_event_participant_unique
  ON public.registrations (event_id, participant_id);

DO $realtime$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication
    WHERE pubname = 'supabase_realtime'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'registrations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.registrations;
  END IF;
END
$realtime$;

COMMIT;
