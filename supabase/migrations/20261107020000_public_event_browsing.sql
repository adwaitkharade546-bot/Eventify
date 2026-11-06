BEGIN;

-- =========================================================
-- 1. VALIDATE EXISTING DATABASE STRUCTURE AND SECURITY
-- =========================================================

DO $migration$
DECLARE
    events_rls_enabled boolean;
    event_people_rls_enabled boolean;
    missing_columns text;
    incompatible_columns text;
    unsafe_public_grant boolean;
BEGIN

    -- Check required tables
    IF to_regclass('public.events') IS NULL THEN
        RAISE EXCEPTION
            'Public event browsing requires public.events.';
    END IF;

    IF to_regclass('public.event_people') IS NULL THEN
        RAISE EXCEPTION
            'Apply the event_people migration before public event browsing.';
    END IF;

    -- Ensure RLS is enabled on events
    SELECT relrowsecurity
    INTO events_rls_enabled
    FROM pg_class
    WHERE oid = 'public.events'::regclass;

    IF NOT events_rls_enabled THEN
        RAISE EXCEPTION
            'public.events RLS is disabled. Inspect existing policies before enabling it.';
    END IF;

    -- Ensure RLS is enabled on event_people
    SELECT relrowsecurity
    INTO event_people_rls_enabled
    FROM pg_class
    WHERE oid = 'public.event_people'::regclass;

    IF NOT event_people_rls_enabled THEN
        RAISE EXCEPTION
            'public.event_people RLS must remain enabled.';
    END IF;

    -- Verify existing event_people SELECT policy
    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'event_people'
          AND policyname =
              'Published event people and owning organizers can read'
          AND cmd = 'SELECT'
    ) THEN
        RAISE EXCEPTION
            'Expected event_people SELECT policy was not found.';
    END IF;

    -- Prevent duplicate Eventify policies
    IF EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'events'
          AND policyname IN (
              'eventify_public_published_events_read',
              'eventify_public_published_events_only'
          )
    ) THEN
        RAISE EXCEPTION
            'An Eventify public-event policy already exists. Inspect it before continuing.';
    END IF;

    -- Check required event columns
    SELECT string_agg(required.column_name, ', ')
    INTO missing_columns
    FROM unnest(ARRAY[
        'id',
        'title',
        'description',
        'venue',
        'event_date',
        'registration_deadline',
        'capacity',
        'status',
        'organizing_department',
        'target_departments',
        'start_time',
        'end_time'
    ]) AS required(column_name)
    LEFT JOIN information_schema.columns AS existing
        ON existing.table_schema = 'public'
       AND existing.table_name = 'events'
       AND existing.column_name = required.column_name
    WHERE existing.column_name IS NULL;

    IF missing_columns IS NOT NULL THEN
        RAISE EXCEPTION
            'Required event columns are missing: %',
            missing_columns;
    END IF;

    -- Validate actual database column types
    -- event_date and registration_deadline are TIMESTAMPTZ.

    SELECT string_agg(
        format('%I has type %s', column_name, data_type),
        ', '
    )
    INTO incompatible_columns
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'events'
      AND (
        (
            column_name IN (
                'title',
                'description',
                'venue',
                'category',
                'organizing_department'
            )
            AND data_type NOT IN (
                'text',
                'character varying',
                'character'
            )
        )
        OR (
            column_name = 'target_departments'
            AND (
                data_type <> 'ARRAY'
                OR udt_name <> '_text'
            )
        )
        OR (
            column_name IN ('start_time', 'end_time')
            AND data_type <> 'time without time zone'
        )
        OR (
            column_name IN (
                'event_date',
                'registration_deadline'
            )
            AND data_type <> 'timestamp with time zone'
        )
    );

    IF incompatible_columns IS NOT NULL THEN
        RAISE EXCEPTION
            'Event browsing found incompatible column types: %',
            incompatible_columns;
    END IF;

    -- Prevent broad PUBLIC access to private event columns
    SELECT EXISTS (
        SELECT 1
        FROM pg_class AS relation
        CROSS JOIN LATERAL aclexplode(
            COALESCE(
                relation.relacl,
                acldefault('r', relation.relowner)
            )
        ) AS privilege
        WHERE relation.oid = 'public.events'::regclass
          AND privilege.grantee = 0
          AND privilege.privilege_type = 'SELECT'
    )
    OR EXISTS (
        SELECT 1
        FROM pg_attribute AS attribute
        CROSS JOIN LATERAL aclexplode(attribute.attacl)
            AS privilege
        WHERE attribute.attrelid = 'public.events'::regclass
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND attribute.attname NOT IN (
              'id',
              'title',
              'description',
              'category',
              'venue',
              'event_date',
              'start_time',
              'end_time',
              'registration_deadline',
              'capacity',
              'status',
              'organizing_department',
              'target_departments',
              'image',
              'image_url'
          )
          AND privilege.grantee = 0
          AND privilege.privilege_type = 'SELECT'
    )
    INTO unsafe_public_grant;

    IF unsafe_public_grant THEN
        RAISE EXCEPTION
            'PUBLIC has broad or private-column SELECT access to events. Review existing grants first.';
    END IF;

END;
$migration$;


-- =========================================================
-- 2. ADD CATEGORY COLUMN IF IT DOES NOT EXIST
-- =========================================================

ALTER TABLE public.events
ADD COLUMN IF NOT EXISTS category text;


-- =========================================================
-- 3. GIVE ANONYMOUS VISITORS ACCESS ONLY TO PUBLIC COLUMNS
-- =========================================================

REVOKE ALL PRIVILEGES
ON TABLE public.events
FROM anon;

DO $grants$
DECLARE
    event_column record;

    public_columns text :=
        'id, title, description, category, venue, event_date, '
        || 'organizing_department, target_departments, start_time, '
        || 'end_time, registration_deadline, capacity, status';

    image_columns text;
BEGIN

    -- Remove any previous column-level grants to anon
    FOR event_column IN
        SELECT attname
        FROM pg_attribute
        WHERE attrelid = 'public.events'::regclass
          AND attnum > 0
          AND NOT attisdropped
    LOOP

        EXECUTE format(
            'REVOKE SELECT (%I) ON TABLE public.events FROM anon',
            event_column.attname
        );

    END LOOP;

    -- Include whichever image column exists
    SELECT string_agg(
        format('%I', column_name),
        ', '
    )
    INTO image_columns
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'events'
      AND column_name IN ('image', 'image_url');

    -- Grant access only to public event information
    EXECUTE format(
        'GRANT SELECT (%s%s) ON TABLE public.events TO anon',
        public_columns,
        CASE
            WHEN image_columns IS NULL THEN ''
            ELSE ', ' || image_columns
        END
    );

END;
$grants$;


-- =========================================================
-- 4. ALLOW ANONYMOUS VISITORS TO READ PUBLISHED EVENTS ONLY
-- =========================================================

CREATE POLICY eventify_public_published_events_read
ON public.events
AS PERMISSIVE
FOR SELECT
TO anon
USING (
    lower(btrim(COALESCE(status::text, ''))) = 'published'
);


CREATE POLICY eventify_public_published_events_only
ON public.events
AS RESTRICTIVE
FOR SELECT
TO anon
USING (
    lower(btrim(COALESCE(status::text, ''))) = 'published'
);


-- =========================================================
-- 5. CREATE SECURE EVENT PEOPLE READ FUNCTION
-- =========================================================

CREATE OR REPLACE FUNCTION public.eventify_can_read_event_people(
    p_event_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$

    SELECT EXISTS (
        SELECT 1
        FROM public.events AS event
        WHERE event.id::text = p_event_id
          AND (
              lower(
                  btrim(
                      COALESCE(event.status::text, '')
                  )
              ) = 'published'

              OR (

                  event.organizer_id::text = auth.uid()::text

                  AND EXISTS (
                      SELECT 1
                      FROM public.profiles AS profile
                      WHERE profile.id = auth.uid()
                        AND profile.role::text = 'organizer'
                        AND profile.organizer_status::text = 'approved'
                  )

              )
          )
    );

$$;


-- Restrict function execution permissions
REVOKE ALL
ON FUNCTION public.eventify_can_read_event_people(text)
FROM PUBLIC, anon, authenticated;


GRANT EXECUTE
ON FUNCTION public.eventify_can_read_event_people(text)
TO anon, authenticated;


-- =========================================================
-- 6. UPDATE EVENT PEOPLE READ POLICY
-- =========================================================

DROP POLICY
IF EXISTS "Published event people and owning organizers can read"
ON public.event_people;


CREATE POLICY "Published event people and owning organizers can read"
ON public.event_people
FOR SELECT
TO anon, authenticated
USING (
    public.eventify_can_read_event_people(event_id::text)
);


-- =========================================================
-- 7. ENABLE EVENTS REALTIME
-- =========================================================

DO $realtime$
BEGIN

    IF NOT EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'events'
    ) THEN

        IF NOT EXISTS (
            SELECT 1
            FROM pg_publication
            WHERE pubname = 'supabase_realtime'
        ) THEN

            RAISE EXCEPTION
                'Supabase Realtime publication supabase_realtime does not exist.';

        END IF;

        ALTER PUBLICATION supabase_realtime
        ADD TABLE public.events;

    END IF;

END;
$realtime$;


-- =========================================================
-- 8. COMPLETE MIGRATION
-- =========================================================

COMMIT;