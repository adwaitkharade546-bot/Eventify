BEGIN;

DO $migration$
DECLARE
  event_id_type text;
BEGIN
  IF to_regclass('public.events') IS NULL THEN
    RAISE EXCEPTION 'Required table public.events does not exist.';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'Required table public.profiles does not exist.';
  END IF;
  IF to_regclass('public.event_people') IS NOT NULL THEN
    RAISE EXCEPTION 'public.event_people already exists; inspect it before running this migration.';
  END IF;

  SELECT format_type(attribute.atttypid, attribute.atttypmod)
  INTO event_id_type
  FROM pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.events'::regclass
    AND attribute.attname = 'id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF event_id_type IS NULL THEN
    RAISE EXCEPTION 'Could not determine the type of public.events.id.';
  END IF;

  EXECUTE format(
    'CREATE TABLE public.event_people (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       event_id %s NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
       name text NOT NULL CHECK (length(btrim(name)) > 0),
       role text NOT NULL CHECK (role IN (''mentor'', ''speaker'')),
       designation text,
       bio text,
       display_order integer NOT NULL DEFAULT 0,
       created_at timestamptz NOT NULL DEFAULT now()
     )',
    event_id_type
  );
END
$migration$;

CREATE INDEX event_people_event_order_idx
  ON public.event_people (event_id, display_order, created_at);

ALTER TABLE public.event_people ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.event_people FROM PUBLIC;
GRANT SELECT ON TABLE public.event_people TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.event_people TO authenticated;

CREATE POLICY "Published event people and owning organizers can read"
  ON public.event_people
  FOR SELECT
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.events AS event
      WHERE event.id = event_people.event_id
        AND (
          lower(btrim(event.status::text)) = 'published'
          OR (
            event.organizer_id = auth.uid()
            AND EXISTS (
              SELECT 1
              FROM public.profiles AS profile
              WHERE profile.id = auth.uid()
                AND profile.role = 'organizer'
                AND profile.organizer_status = 'approved'
            )
          )
        )
    )
  );

CREATE POLICY "Approved event owners can add people"
  ON public.event_people
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.events AS event
      JOIN public.profiles AS profile
        ON profile.id = auth.uid()
      WHERE event.id = event_people.event_id
        AND event.organizer_id = auth.uid()
        AND profile.role = 'organizer'
        AND profile.organizer_status = 'approved'
    )
  );

CREATE POLICY "Approved event owners can update people"
  ON public.event_people
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.events AS event
      JOIN public.profiles AS profile
        ON profile.id = auth.uid()
      WHERE event.id = event_people.event_id
        AND event.organizer_id = auth.uid()
        AND profile.role = 'organizer'
        AND profile.organizer_status = 'approved'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.events AS event
      JOIN public.profiles AS profile
        ON profile.id = auth.uid()
      WHERE event.id = event_people.event_id
        AND event.organizer_id = auth.uid()
        AND profile.role = 'organizer'
        AND profile.organizer_status = 'approved'
    )
  );

CREATE POLICY "Approved event owners can delete people"
  ON public.event_people
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.events AS event
      JOIN public.profiles AS profile
        ON profile.id = auth.uid()
      WHERE event.id = event_people.event_id
        AND event.organizer_id = auth.uid()
        AND profile.role = 'organizer'
        AND profile.organizer_status = 'approved'
    )
  );

ALTER TABLE public.event_people REPLICA IDENTITY FULL;

DO $realtime$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication
    WHERE pubname = 'supabase_realtime'
  ) THEN
    RAISE EXCEPTION 'Supabase Realtime publication supabase_realtime does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'event_people'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.event_people;
  END IF;
END
$realtime$;

COMMIT;
