BEGIN;

-- =========================================================
-- 1. VERIFY REQUIRED TABLES AND COLUMNS
-- =========================================================

DO $$
DECLARE
    missing_columns text;
BEGIN
    SELECT string_agg(
        required.table_name || '.' || required.column_name,
        ', '
    )
    INTO missing_columns
    FROM (VALUES
        ('events', 'id'),
        ('events', 'capacity'),
        ('events', 'organizer_id'),
        ('events', 'status'),
        ('registrations', 'id'),
        ('registrations', 'event_id'),
        ('registrations', 'participant_id'),
        ('registrations', 'status')
    ) AS required(table_name, column_name)
    LEFT JOIN information_schema.columns AS existing
        ON existing.table_schema = 'public'
        AND existing.table_name = required.table_name
        AND existing.column_name = required.column_name
    WHERE existing.column_name IS NULL;

    IF missing_columns IS NOT NULL THEN
        RAISE EXCEPTION
            'Missing required database columns: %',
            missing_columns;
    END IF;

    IF pg_catalog.to_regprocedure(
        'realtime.send(jsonb,text,text,boolean)'
    ) IS NULL THEN
        RAISE EXCEPTION
            'Required Supabase Realtime broadcast function was not found.';
    END IF;
END;
$$;


-- =========================================================
-- 2. PREVENT DUPLICATE REGISTRATIONS AND OVERBOOKING
-- =========================================================

CREATE OR REPLACE FUNCTION public.enforce_event_registration_capacity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    event_capacity bigint;
    active_registrations bigint;
BEGIN

    -- Only pending and approved registrations consume seats.
    IF lower(btrim(COALESCE(NEW.status::text, '')))
        NOT IN ('pending', 'approved') THEN
        RETURN NEW;
    END IF;

    -- Lock the event row to serialize registration attempts.
    SELECT event.capacity::bigint
    INTO event_capacity
    FROM public.events AS event
    WHERE event.id = NEW.event_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'The event for this registration does not exist.'
            USING ERRCODE = '23503';
    END IF;

    IF event_capacity IS NULL OR event_capacity < 0 THEN
        RAISE EXCEPTION
            'The event capacity is invalid.'
            USING ERRCODE = '23514';
    END IF;

    -- Prevent duplicate active registrations.
    IF EXISTS (
        SELECT 1
        FROM public.registrations AS existing
        WHERE existing.event_id = NEW.event_id
          AND existing.participant_id = NEW.participant_id
          AND existing.id IS DISTINCT FROM NEW.id
          AND lower(btrim(COALESCE(existing.status::text, '')))
              IN ('pending', 'approved')
    ) THEN
        RAISE EXCEPTION
            'This participant already has an active registration for this event.'
            USING ERRCODE = '23505';
    END IF;

    -- Count distinct active participants, excluding this row on UPDATE.
    SELECT count(DISTINCT existing.participant_id)
    INTO active_registrations
    FROM public.registrations AS existing
    WHERE existing.event_id = NEW.event_id
      AND existing.id IS DISTINCT FROM NEW.id
      AND lower(btrim(COALESCE(existing.status::text, '')))
          IN ('pending', 'approved');

    IF active_registrations >= event_capacity THEN
        RAISE EXCEPTION
            'EVENT_FULL: This event has reached its registration capacity.'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION
    public.enforce_event_registration_capacity()
    FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS registrations_enforce_event_capacity
    ON public.registrations;

CREATE TRIGGER registrations_enforce_event_capacity
BEFORE INSERT OR UPDATE ON public.registrations
FOR EACH ROW
EXECUTE FUNCTION public.enforce_event_registration_capacity();


-- =========================================================
-- 3. PREVENT CAPACITY REDUCTION BELOW ACTIVE REGISTRATIONS
-- =========================================================

CREATE OR REPLACE FUNCTION public.prevent_event_capacity_below_registrations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    active_registrations bigint;
BEGIN

    IF NEW.capacity IS NOT DISTINCT FROM OLD.capacity THEN
        RETURN NEW;
    END IF;

    SELECT count(DISTINCT registration.participant_id)
    INTO active_registrations
    FROM public.registrations AS registration
    WHERE registration.event_id = NEW.id
      AND lower(btrim(COALESCE(registration.status::text, '')))
          IN ('pending', 'approved');

    IF NEW.capacity IS NULL
       OR NEW.capacity < active_registrations THEN

        RAISE EXCEPTION
            'Event capacity cannot be lower than its current active registration count (%).',
            active_registrations
            USING ERRCODE = '23514';
    END IF;

    IF NEW.capacity < 0 THEN
        RAISE EXCEPTION
            'Event capacity cannot be negative.'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION
    public.prevent_event_capacity_below_registrations()
    FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS events_prevent_capacity_below_registrations
    ON public.events;

CREATE TRIGGER events_prevent_capacity_below_registrations
BEFORE UPDATE OF capacity ON public.events
FOR EACH ROW
EXECUTE FUNCTION public.prevent_event_capacity_below_registrations();


-- =========================================================
-- 4. GET REAL REGISTRATION COUNTS
-- =========================================================

CREATE OR REPLACE FUNCTION public.get_event_registration_counts(
    p_event_ids text[]
)
RETURNS TABLE(
    event_id text,
    capacity bigint,
    registered_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT
        event.id::text,
        event.capacity::bigint,
        count(DISTINCT registration.participant_id)::bigint

    FROM public.events AS event

    LEFT JOIN public.registrations AS registration
        ON registration.event_id = event.id
        AND lower(btrim(COALESCE(registration.status::text, '')))
            IN ('pending', 'approved')

    WHERE event.id::text = ANY(
        COALESCE(p_event_ids, ARRAY[]::text[])
    )

    AND (
        lower(btrim(event.status::text)) = 'published'
        OR event.organizer_id = auth.uid()
    )

    GROUP BY event.id, event.capacity;
$$;

REVOKE ALL ON FUNCTION
    public.get_event_registration_counts(text[])
    FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
    public.get_event_registration_counts(text[])
    TO anon, authenticated;


-- =========================================================
-- 5. REALTIME REGISTRATION COUNT NOTIFICATIONS
-- =========================================================

CREATE OR REPLACE FUNCTION public.notify_event_registration_count_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    old_event_id text;
    new_event_id text;
BEGIN

    IF TG_OP <> 'INSERT' THEN
        old_event_id := OLD.event_id::text;
    END IF;

    IF TG_OP <> 'DELETE' THEN
        new_event_id := NEW.event_id::text;
    END IF;

    -- Ignore updates that cannot affect registration counts.
    IF TG_OP = 'UPDATE'
       AND OLD.status::text IS NOT DISTINCT FROM NEW.status::text
       AND OLD.event_id IS NOT DISTINCT FROM NEW.event_id
       AND OLD.participant_id IS NOT DISTINCT FROM NEW.participant_id
    THEN
        RETURN NEW;
    END IF;

    -- Notify subscribers of the old event.
    IF old_event_id IS NOT NULL THEN

        PERFORM realtime.send(
            jsonb_build_object('event_id', old_event_id),
            'registration_changed',
            'event-registration-counts:' || old_event_id,
            false
        );

    END IF;

    -- Notify subscribers of the new event when the event changes.
    IF new_event_id IS NOT NULL
       AND new_event_id IS DISTINCT FROM old_event_id
    THEN

        PERFORM realtime.send(
            jsonb_build_object('event_id', new_event_id),
            'registration_changed',
            'event-registration-counts:' || new_event_id,
            false
        );

    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    RETURN NEW;

END;
$$;

REVOKE ALL ON FUNCTION
    public.notify_event_registration_count_change()
    FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS registrations_broadcast_count_change
    ON public.registrations;

CREATE TRIGGER registrations_broadcast_count_change
AFTER INSERT OR UPDATE OR DELETE ON public.registrations
FOR EACH ROW
EXECUTE FUNCTION public.notify_event_registration_count_change();


-- =========================================================
-- 6. COMPLETE MIGRATION
-- =========================================================

COMMIT;