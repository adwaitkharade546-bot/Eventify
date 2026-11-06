BEGIN;

-- =========================================================
-- 1. CREATE NOTIFICATIONS TABLE
-- =========================================================

CREATE TABLE IF NOT EXISTS public.notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id uuid NOT NULL
        REFERENCES auth.users(id) ON DELETE CASCADE,

    event_id text,
    registration_id text,

    event_title text NOT NULL,
    title text NOT NULL,
    message text NOT NULL,

    type text NOT NULL CHECK (
        type IN (
            'registration_success',
            'registration_approved',
            'registration_rejected',
            'event_reminder',
            'event_updated',
            'event_cancelled',
            'registration_deadline',
            'event_completed',
            'new_registration',
            'registration_activity',
            'event_activity'
        )
    ),

    is_read boolean NOT NULL DEFAULT false,

    dedupe_key text UNIQUE,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);


-- =========================================================
-- 2. INDEXES
-- =========================================================

CREATE INDEX IF NOT EXISTS notifications_user_created_idx
ON public.notifications (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
ON public.notifications (user_id, is_read)
WHERE is_read = false;


-- =========================================================
-- 3. ROW LEVEL SECURITY
-- =========================================================

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.notifications REPLICA IDENTITY FULL;

DROP POLICY IF EXISTS "Users can view own notifications"
ON public.notifications;

CREATE POLICY "Users can view own notifications"
ON public.notifications
FOR SELECT
TO authenticated
USING (user_id = auth.uid());


DROP POLICY IF EXISTS "Users can update own notifications"
ON public.notifications;

CREATE POLICY "Users can update own notifications"
ON public.notifications
FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());


DROP POLICY IF EXISTS "Users can delete own notifications"
ON public.notifications;

CREATE POLICY "Users can delete own notifications"
ON public.notifications
FOR DELETE
TO authenticated
USING (user_id = auth.uid());


REVOKE ALL ON public.notifications FROM PUBLIC, anon;

GRANT SELECT, DELETE ON public.notifications TO authenticated;
GRANT UPDATE (is_read) ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;


-- =========================================================
-- 4. UPDATED_AT FUNCTION
-- =========================================================

CREATE OR REPLACE FUNCTION public.update_notification_timestamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS update_notification_timestamp_trigger
ON public.notifications;

CREATE TRIGGER update_notification_timestamp_trigger
BEFORE UPDATE ON public.notifications
FOR EACH ROW
EXECUTE FUNCTION public.update_notification_timestamp();


-- =========================================================
-- 5. AUTOMATIC REGISTRATION AND EVENT NOTIFICATIONS
-- =========================================================

CREATE OR REPLACE FUNCTION public.enqueue_eventify_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_event record;
    v_participant_id uuid;
    v_organizer_id uuid;
    v_event_id text;
    v_registration_id text;
BEGIN

    -- -----------------------------------------------------
    -- REGISTRATION INSERT
    -- -----------------------------------------------------

    IF TG_TABLE_NAME = 'registrations' AND TG_OP = 'INSERT' THEN

        IF lower(NEW.status::text) <> 'pending' THEN
            RETURN NEW;
        END IF;

        SELECT
            id,
            organizer_id,
            title
        INTO v_event
        FROM public.events
        WHERE id::text = NEW.event_id::text;

        IF NOT FOUND THEN
            RETURN NEW;
        END IF;

        v_participant_id := NEW.participant_id;
        v_organizer_id := v_event.organizer_id;
        v_event_id := v_event.id::text;
        v_registration_id := NEW.id::text;

        -- Participant registration confirmation

        INSERT INTO public.notifications (
            user_id,
            event_id,
            registration_id,
            event_title,
            title,
            message,
            type,
            dedupe_key
        )
        VALUES (
            v_participant_id,
            v_event_id,
            v_registration_id,
            v_event.title,
            'Registration successful',
            format(
                'Your registration for %s has been submitted successfully.',
                v_event.title
            ),
            'registration_success',
            'registration-success:' || v_registration_id
        )
        ON CONFLICT (dedupe_key) DO NOTHING;

        -- Organizer receives new registration notification

        INSERT INTO public.notifications (
            user_id,
            event_id,
            registration_id,
            event_title,
            title,
            message,
            type,
            dedupe_key
        )
        VALUES (
            v_organizer_id,
            v_event_id,
            v_registration_id,
            v_event.title,
            'New registration',
            format(
                'A participant has registered for %s.',
                v_event.title
            ),
            'new_registration',
            'new-registration:' || v_registration_id
        )
        ON CONFLICT (dedupe_key) DO NOTHING;

        RETURN NEW;
    END IF;


    -- -----------------------------------------------------
    -- REGISTRATION STATUS UPDATE
    -- -----------------------------------------------------

    IF TG_TABLE_NAME = 'registrations' AND TG_OP = 'UPDATE' THEN

        IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
            RETURN NEW;
        END IF;

        SELECT
            id,
            organizer_id,
            title
        INTO v_event
        FROM public.events
        WHERE id::text = NEW.event_id::text;

        IF NOT FOUND THEN
            RETURN NEW;
        END IF;

        v_event_id := v_event.id::text;
        v_registration_id := NEW.id::text;
        v_participant_id := NEW.participant_id;
        v_organizer_id := v_event.organizer_id;

        IF lower(NEW.status::text) = 'approved' THEN

            INSERT INTO public.notifications (
                user_id,
                event_id,
                registration_id,
                event_title,
                title,
                message,
                type,
                dedupe_key
            )
            VALUES (
                v_participant_id,
                v_event_id,
                v_registration_id,
                v_event.title,
                'Registration approved',
                format(
                    'Your registration for %s has been approved.',
                    v_event.title
                ),
                'registration_approved',
                'registration-approved:' || v_registration_id
            )
            ON CONFLICT (dedupe_key) DO NOTHING;

        ELSIF lower(NEW.status::text) = 'rejected' THEN

            INSERT INTO public.notifications (
                user_id,
                event_id,
                registration_id,
                event_title,
                title,
                message,
                type,
                dedupe_key
            )
            VALUES (
                v_participant_id,
                v_event_id,
                v_registration_id,
                v_event.title,
                'Registration rejected',
                format(
                    'Your registration for %s was rejected.',
                    v_event.title
                ),
                'registration_rejected',
                'registration-rejected:' || v_registration_id
            )
            ON CONFLICT (dedupe_key) DO NOTHING;

        END IF;

        -- Organizer registration activity

        INSERT INTO public.notifications (
            user_id,
            event_id,
            registration_id,
            event_title,
            title,
            message,
            type,
            dedupe_key
        )
        VALUES (
            v_organizer_id,
            v_event_id,
            v_registration_id,
            v_event.title,
            'Registration updated',
            format(
                'A registration for %s has been updated to %s.',
                v_event.title,
                NEW.status::text
            ),
            'registration_activity',
            format(
                'registration-activity:%s:%s',
                v_registration_id,
                NEW.status::text
            )
        )
        ON CONFLICT (dedupe_key) DO NOTHING;

        RETURN NEW;
    END IF;


    -- -----------------------------------------------------
    -- EVENT INSERT
    -- -----------------------------------------------------

    IF TG_TABLE_NAME = 'events' AND TG_OP = 'INSERT' THEN

        IF NEW.status::text IN ('published', 'draft') THEN

            INSERT INTO public.notifications (
                user_id,
                event_id,
                event_title,
                title,
                message,
                type,
                dedupe_key
            )
            VALUES (
                NEW.organizer_id,
                NEW.id::text,
                NEW.title,
                'Event created',
                format(
                    'Your event %s has been created.',
                    NEW.title
                ),
                'event_activity',
                'event-created:' || NEW.id::text
            )
            ON CONFLICT (dedupe_key) DO NOTHING;

        END IF;

        RETURN NEW;
    END IF;


    -- -----------------------------------------------------
    -- EVENT UPDATE
    -- -----------------------------------------------------

    IF TG_TABLE_NAME = 'events' AND TG_OP = 'UPDATE' THEN

        -- Notify participants when an event is cancelled.

        IF lower(NEW.status::text) = 'cancelled'
           AND lower(OLD.status::text) <> 'cancelled' THEN

            INSERT INTO public.notifications (
                user_id,
                event_id,
                event_title,
                title,
                message,
                type,
                dedupe_key
            )
            SELECT
                registration.participant_id,
                NEW.id::text,
                NEW.title,
                'Event cancelled',
                format(
                    '%s has been cancelled.',
                    NEW.title
                ),
                'event_cancelled',
                format(
                    'event-cancelled:%s:%s',
                    NEW.id::text,
                    registration.participant_id::text
                )
            FROM public.registrations AS registration
            WHERE registration.event_id::text = NEW.id::text
              AND lower(registration.status::text) IN ('pending', 'approved')
            ON CONFLICT (dedupe_key) DO NOTHING;

        -- Notify participants when an event is completed.

        ELSIF lower(NEW.status::text) = 'completed'
          AND lower(OLD.status::text) <> 'completed' THEN

            INSERT INTO public.notifications (
                user_id,
                event_id,
                event_title,
                title,
                message,
                type,
                dedupe_key
            )
            SELECT
                registration.participant_id,
                NEW.id::text,
                NEW.title,
                'Event completed',
                format(
                    '%s has been marked as completed.',
                    NEW.title
                ),
                'event_completed',
                format(
                    'event-completed:%s:%s',
                    NEW.id::text,
                    registration.participant_id::text
                )
            FROM public.registrations AS registration
            WHERE registration.event_id::text = NEW.id::text
              AND lower(registration.status::text) IN ('pending', 'approved')
            ON CONFLICT (dedupe_key) DO NOTHING;

        -- Notify participants when published event details change.

        ELSIF lower(NEW.status::text) = 'published'
          AND (
              NEW.title IS DISTINCT FROM OLD.title
              OR NEW.description IS DISTINCT FROM OLD.description
              OR NEW.venue IS DISTINCT FROM OLD.venue
              OR NEW.event_date IS DISTINCT FROM OLD.event_date
              OR NEW.start_time IS DISTINCT FROM OLD.start_time
              OR NEW.end_time IS DISTINCT FROM OLD.end_time
              OR NEW.registration_deadline IS DISTINCT FROM OLD.registration_deadline
          ) THEN

            INSERT INTO public.notifications (
                user_id,
                event_id,
                event_title,
                title,
                message,
                type,
                dedupe_key
            )
            SELECT
                registration.participant_id,
                NEW.id::text,
                NEW.title,
                'Event updated',
                format(
                    'Details for %s have been updated.',
                    NEW.title
                ),
                'event_updated',
                format(
                    'event-updated:%s:%s:%s',
                    NEW.id::text,
                    registration.participant_id::text,
                    NEW.updated_at::text
                )
            FROM public.registrations AS registration
            WHERE registration.event_id::text = NEW.id::text
              AND lower(registration.status::text) IN ('pending', 'approved')
            ON CONFLICT (dedupe_key) DO NOTHING;

        END IF;

        -- Organizer activity

        IF (
            NEW.title IS DISTINCT FROM OLD.title
            OR NEW.description IS DISTINCT FROM OLD.description
            OR NEW.venue IS DISTINCT FROM OLD.venue
            OR NEW.event_date IS DISTINCT FROM OLD.event_date
            OR NEW.status IS DISTINCT FROM OLD.status
        ) THEN

            INSERT INTO public.notifications (
                user_id,
                event_id,
                event_title,
                title,
                message,
                type,
                dedupe_key
            )
            VALUES (
                NEW.organizer_id,
                NEW.id::text,
                NEW.title,
                'Event activity',
                format(
                    'Your event %s has been updated.',
                    NEW.title
                ),
                'event_activity',
                format(
                    'event-activity:%s:%s',
                    NEW.id::text,
                    NEW.updated_at::text
                )
            )
            ON CONFLICT (dedupe_key) DO NOTHING;

        END IF;

        RETURN NEW;
    END IF;

    RETURN NULL;
END;
$$;


-- =========================================================
-- 6. REGISTRATION TRIGGERS
-- =========================================================

DROP TRIGGER IF EXISTS eventify_registration_insert_notification
ON public.registrations;

CREATE TRIGGER eventify_registration_insert_notification
AFTER INSERT ON public.registrations
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_eventify_notification();


DROP TRIGGER IF EXISTS eventify_registration_update_notification
ON public.registrations;

CREATE TRIGGER eventify_registration_update_notification
AFTER UPDATE OF status ON public.registrations
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_eventify_notification();


-- =========================================================
-- 7. EVENT TRIGGERS
-- =========================================================

DROP TRIGGER IF EXISTS eventify_event_insert_notification
ON public.events;

CREATE TRIGGER eventify_event_insert_notification
AFTER INSERT ON public.events
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_eventify_notification();


DROP TRIGGER IF EXISTS eventify_event_update_notification
ON public.events;

CREATE TRIGGER eventify_event_update_notification
AFTER UPDATE OF
    title,
    description,
    venue,
    event_date,
    registration_deadline,
    start_time,
    end_time,
    status
ON public.events
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_eventify_notification();


-- =========================================================
-- 8. SCHEDULED EVENT REMINDERS AND DEADLINE REMINDERS
-- =========================================================

CREATE OR REPLACE FUNCTION public.process_eventify_scheduled_notifications()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    inserted_count integer := 0;
    current_count integer := 0;
BEGIN

    -- EVENT REMINDERS:
    -- Event starts within the next 24 hours.
    -- Event date is interpreted as an Indian calendar date.
    -- Start time is interpreted as Indian local time.

    WITH event_times AS (
        SELECT
            event.*,
            (
                (
                    (event.event_date AT TIME ZONE 'UTC')::date
                    + COALESCE(event.start_time, time '09:00')
                )
                AT TIME ZONE 'Asia/Kolkata'
            ) AS event_starts_at
        FROM public.events AS event
    )

    INSERT INTO public.notifications (
        user_id,
        event_id,
        registration_id,
        event_title,
        title,
        message,
        type,
        dedupe_key
    )

    SELECT
        participant.id,
        event.id::text,
        registration.id::text,
        event.title::text,
        'Event reminder',
        format(
            '%s begins within the next 24 hours.',
            event.title::text
        ),
        'event_reminder',
        format(
            'event-reminder:%s:%s:%s:%s',
            event.id::text,
            registration.id::text,
            (event.event_date AT TIME ZONE 'UTC')::date::text,
            COALESCE(event.start_time::text, '09:00')
        )

    FROM event_times AS event

    JOIN public.registrations AS registration
        ON registration.event_id::text = event.id::text
        AND lower(registration.status::text) IN ('pending', 'approved')

    JOIN public.profiles AS participant
        ON participant.id::text = registration.participant_id::text
        AND participant.role::text = 'participant'

    WHERE lower(event.status::text) = 'published'
      AND event.event_date IS NOT NULL
      AND event.event_starts_at > now()
      AND event.event_starts_at <= now() + interval '24 hours'

    ON CONFLICT (dedupe_key) DO NOTHING;


    GET DIAGNOSTICS current_count = ROW_COUNT;
    inserted_count := inserted_count + current_count;


    -- REGISTRATION DEADLINE REMINDERS:
    -- Registration closes at 11:59 PM IST on the selected date.
    -- The next midnight is used as the exclusive deadline.

    WITH event_deadlines AS (
        SELECT
            event.*,
            (
                (
                    (event.registration_deadline AT TIME ZONE 'UTC')::date
                    + 1
                )::timestamp
                AT TIME ZONE 'Asia/Kolkata'
            ) AS deadline_at

        FROM public.events AS event
    )

    INSERT INTO public.notifications (
        user_id,
        event_id,
        registration_id,
        event_title,
        title,
        message,
        type,
        dedupe_key
    )

    SELECT
        participant.id,
        event.id::text,
        registration.id::text,
        event.title::text,
        'Registration deadline approaching',

        format(
            'Registration for %s closes on %s at 11:59 PM IST.',
            event.title::text,
            to_char(
                (event.registration_deadline AT TIME ZONE 'UTC')::date,
                'DD Mon YYYY'
            )
        ),

        'registration_deadline',

        format(
            'registration-deadline:%s:%s:%s',
            event.id::text,
            registration.id::text,
            (event.registration_deadline AT TIME ZONE 'UTC')::date::text
        )

    FROM event_deadlines AS event

    JOIN public.registrations AS registration
        ON registration.event_id::text = event.id::text
        AND lower(registration.status::text) IN ('pending', 'approved')

    JOIN public.profiles AS participant
        ON participant.id::text = registration.participant_id::text
        AND participant.role::text = 'participant'

    WHERE lower(event.status::text) = 'published'
      AND event.registration_deadline IS NOT NULL
      AND event.deadline_at > now()
      AND event.deadline_at <= now() + interval '24 hours'

    ON CONFLICT (dedupe_key) DO NOTHING;


    GET DIAGNOSTICS current_count = ROW_COUNT;
    inserted_count := inserted_count + current_count;

    RETURN inserted_count;

END;
$$;


-- =========================================================
-- 9. FUNCTION PERMISSIONS
-- =========================================================

REVOKE ALL ON FUNCTION public.enqueue_eventify_notification()
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.update_notification_timestamp()
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.process_eventify_scheduled_notifications()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.process_eventify_scheduled_notifications()
TO service_role;


-- =========================================================
-- 10. ADD NOTIFICATIONS TO SUPABASE REALTIME
-- =========================================================

DO $$
BEGIN

    IF NOT EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'notifications'
    ) THEN

        ALTER PUBLICATION supabase_realtime
        ADD TABLE public.notifications;

    END IF;

END;
$$;


COMMIT;