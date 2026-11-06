-- Eventify registration notification outbox.
-- Any error aborts this transaction; do not commit an aborted transaction.
BEGIN;

-- Validate the existing schema and object names before adding anything.
DO $$
DECLARE
  missing_columns text;
  incompatible_columns text;
  conflicting_objects text;
BEGIN
  SELECT string_agg(format('%I.%I', required.table_name, required.column_name), ', ')
  INTO missing_columns
  FROM (VALUES
    ('profiles', 'id'),
    ('profiles', 'role'),
    ('profiles', 'full_name'),
    ('profiles', 'email'),
    ('events', 'id'),
    ('events', 'title'),
    ('events', 'venue'),
    ('events', 'event_date'),
    ('registrations', 'id'),
    ('registrations', 'participant_id'),
    ('registrations', 'event_id'),
    ('registrations', 'status'),
    ('registrations', 'registered_at')
  ) AS required(table_name, column_name)
  LEFT JOIN information_schema.columns AS existing
    ON existing.table_schema = 'public'
    AND existing.table_name = required.table_name
    AND existing.column_name = required.column_name
  WHERE existing.column_name IS NULL;

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'Eventify notification migration is incompatible with this database; missing public columns: %',
      missing_columns;
  END IF;

  SELECT string_agg(format('%I.%I has type %s (expected %s)',
      required.table_name, required.column_name, existing.data_type, required.expected_type), ', ')
  INTO incompatible_columns
  FROM (VALUES
    ('profiles', 'id', 'identifier'),
    ('profiles', 'role', 'text_or_enum'),
    ('profiles', 'full_name', 'text'),
    ('profiles', 'email', 'text'),
    ('events', 'id', 'identifier'),
    ('events', 'title', 'text'),
    ('events', 'venue', 'text'),
    ('events', 'event_date', 'date_or_timestamp_or_text'),
    ('registrations', 'id', 'identifier'),
    ('registrations', 'participant_id', 'identifier'),
    ('registrations', 'event_id', 'identifier'),
    ('registrations', 'status', 'text_or_enum'),
    ('registrations', 'registered_at', 'timestamp_or_date_or_text')
  ) AS required(table_name, column_name, expected_type)
  JOIN information_schema.columns AS existing
    ON existing.table_schema = 'public'
    AND existing.table_name = required.table_name
    AND existing.column_name = required.column_name
  LEFT JOIN pg_catalog.pg_type AS column_type
    ON column_type.typname = existing.udt_name
  LEFT JOIN pg_catalog.pg_namespace AS type_schema
    ON type_schema.oid = column_type.typnamespace
    AND type_schema.nspname = existing.udt_schema
  WHERE NOT CASE required.expected_type
    WHEN 'identifier' THEN existing.data_type IN (
      'uuid', 'text', 'character varying', 'character',
      'smallint', 'integer', 'bigint'
    )
    WHEN 'text' THEN existing.data_type IN ('text', 'character varying', 'character')
    WHEN 'text_or_enum' THEN
      existing.data_type IN ('text', 'character varying', 'character')
      OR (
        column_type.typtype = 'e'
        AND type_schema.nspname = existing.udt_schema
      )
    WHEN 'date_or_timestamp_or_text' THEN existing.data_type IN (
      'date', 'timestamp without time zone', 'timestamp with time zone',
      'text', 'character varying', 'character'
    )
    WHEN 'timestamp_or_date_or_text' THEN existing.data_type IN (
      'date', 'timestamp without time zone', 'timestamp with time zone',
      'text', 'character varying', 'character'
    )
    ELSE false
  END;

  IF incompatible_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'Eventify notification migration is incompatible with this database; incompatible public column types: %',
      incompatible_columns;
  END IF;

  SELECT string_agg(conflict.object_name, ', ')
  INTO conflicting_objects
  FROM (
    SELECT 'table public.registration_notification_outbox' AS object_name
    WHERE pg_catalog.to_regclass('public.registration_notification_outbox') IS NOT NULL
    UNION ALL
    SELECT 'function public.' || expected.function_name
    FROM (VALUES
      ('enqueue_registration_notification'),
      ('claim_registration_notification'),
      ('get_registration_notification_details'),
      ('complete_registration_notification')
    ) AS expected(function_name)
    WHERE EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS existing_function
      JOIN pg_catalog.pg_namespace AS existing_schema
        ON existing_schema.oid = existing_function.pronamespace
      WHERE existing_schema.nspname = 'public'
        AND existing_function.proname = expected.function_name
    )
    UNION ALL
    SELECT 'trigger public.registrations.' || expected.trigger_name
    FROM (VALUES
      ('registrations_enqueue_notification_after_insert'),
      ('registrations_enqueue_notification_after_status_update')
    ) AS expected(trigger_name)
    WHERE EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS existing_trigger
      WHERE existing_trigger.tgrelid = 'public.registrations'::regclass
        AND existing_trigger.tgname = expected.trigger_name
        AND NOT existing_trigger.tgisinternal
    )
    UNION ALL
    SELECT 'index public.registration_notification_outbox_due_idx'
    WHERE EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS existing_index
      JOIN pg_catalog.pg_namespace AS existing_schema
        ON existing_schema.oid = existing_index.relnamespace
      WHERE existing_schema.nspname = 'public'
        AND existing_index.relname = 'registration_notification_outbox_due_idx'
    )
  ) AS conflict;

  IF conflicting_objects IS NOT NULL THEN
    RAISE EXCEPTION
      'Eventify notification migration found existing object name conflicts: %',
      conflicting_objects;
  END IF;
END;
$$;

CREATE TABLE public.registration_notification_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  registration_id text NOT NULL,
  notification_type text NOT NULL
    CHECK (notification_type IN (
      'registration_confirmation',
      'registration_approved',
      'registration_rejected'
    )),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  last_error text,
  CONSTRAINT registration_notification_outbox_once
    UNIQUE (registration_id, notification_type)
);

CREATE INDEX registration_notification_outbox_due_idx
  ON public.registration_notification_outbox (available_at, created_at)
  WHERE status IN ('pending', 'processing');

ALTER TABLE public.registration_notification_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.registration_notification_outbox
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enqueue_registration_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1
      FROM public.profiles AS participant
      WHERE participant.id::text = NEW.participant_id::text
        AND participant.role::text = 'participant'
    )
      AND lower(NEW.status::text) = 'pending'
    THEN
      INSERT INTO public.registration_notification_outbox (
        registration_id,
        notification_type
      )
      VALUES (NEW.id::text, 'registration_confirmation')
      ON CONFLICT (registration_id, notification_type) DO NOTHING;
    END IF;

    RETURN NEW;
  END IF;

  IF lower(OLD.status::text) = 'pending'
    AND lower(NEW.status::text) IN ('approved', 'rejected')
    AND EXISTS (
      SELECT 1
      FROM public.profiles AS participant
      WHERE participant.id::text = NEW.participant_id::text
        AND participant.role::text = 'participant'
    )
  THEN
    INSERT INTO public.registration_notification_outbox (
      registration_id,
      notification_type
    )
    VALUES (
      NEW.id::text,
      CASE lower(NEW.status::text)
        WHEN 'approved' THEN 'registration_approved'
        ELSE 'registration_rejected'
      END
    )
    ON CONFLICT (registration_id, notification_type) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_registration_notification()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER registrations_enqueue_notification_after_insert
AFTER INSERT ON public.registrations
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_registration_notification();

CREATE TRIGGER registrations_enqueue_notification_after_status_update
AFTER UPDATE OF status ON public.registrations
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.enqueue_registration_notification();

CREATE OR REPLACE FUNCTION public.claim_registration_notification()
RETURNS TABLE (
  notification_id bigint,
  notification_type text,
  registration_id text,
  attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.registration_notification_outbox AS outbox
  SET status = 'failed',
      locked_until = NULL,
      last_error = COALESCE(outbox.last_error, 'Maximum delivery attempts exceeded.')
  WHERE outbox.attempts >= 8
    AND (
      outbox.status = 'pending'
      OR (outbox.status = 'processing' AND outbox.locked_until <= now())
    );

  RETURN QUERY
  WITH next_notification AS (
    SELECT outbox.id
    FROM public.registration_notification_outbox AS outbox
    WHERE outbox.attempts < 8
      AND outbox.available_at <= now()
      AND (
        outbox.status = 'pending'
        OR (outbox.status = 'processing' AND outbox.locked_until <= now())
      )
    ORDER BY outbox.created_at, outbox.id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE public.registration_notification_outbox AS outbox
  SET status = 'processing',
      attempts = outbox.attempts + 1,
      locked_until = now() + interval '10 minutes'
  FROM next_notification
  WHERE outbox.id = next_notification.id
  RETURNING
    outbox.id,
    outbox.notification_type,
    outbox.registration_id,
    outbox.attempts;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_registration_notification_details(
  p_notification_id bigint
)
RETURNS TABLE (
  notification_type text,
  participant_email text,
  participant_name text,
  event_name text,
  venue text,
  event_date text,
  registration_date text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    outbox.notification_type,
    participant.email::text,
    participant.full_name::text,
    event.title::text,
    event.venue::text,
    event.event_date::text,
    registration.registered_at::text
  FROM public.registration_notification_outbox AS outbox
  JOIN public.registrations AS registration
    ON registration.id::text = outbox.registration_id
  JOIN public.profiles AS participant
    ON participant.id::text = registration.participant_id::text
    AND participant.role::text = 'participant'
  JOIN public.events AS event
    ON event.id::text = registration.event_id::text
  WHERE outbox.id = p_notification_id
    AND outbox.status = 'processing';
$$;

CREATE OR REPLACE FUNCTION public.complete_registration_notification(
  p_notification_id bigint,
  p_error text DEFAULT NULL,
  p_retry_delay_seconds integer DEFAULT 60
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.registration_notification_outbox AS outbox
  SET status = CASE
        WHEN p_error IS NULL THEN 'sent'
        WHEN outbox.attempts >= 8 THEN 'failed'
        ELSE 'pending'
      END,
      sent_at = CASE WHEN p_error IS NULL THEN now() ELSE NULL END,
      available_at = CASE
        WHEN p_error IS NULL THEN outbox.available_at
        ELSE now() + make_interval(
          secs => GREATEST(1, LEAST(COALESCE(p_retry_delay_seconds, 60), 3600))
        )
      END,
      locked_until = NULL,
      last_error = CASE
        WHEN p_error IS NULL THEN NULL
        ELSE left(p_error, 2000)
      END
  WHERE outbox.id = p_notification_id
    AND outbox.status = 'processing';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Notification % is not currently claimed.', p_notification_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_registration_notification()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_registration_notification_details(bigint)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_registration_notification(bigint, text, integer)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_registration_notification() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_registration_notification_details(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_registration_notification(bigint, text, integer)
  TO service_role;

COMMIT;
