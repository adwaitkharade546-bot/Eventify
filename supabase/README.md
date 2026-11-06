# Registration email notifications

This backend addition queues participant registration confirmations and organizer approval/rejection notices without changing the existing registration workflows or RLS policies.

## Database compatibility and migration

Review `migrations/20261105123000_registration_notification_outbox.sql` and compare it with the live database schema before running it manually in the Supabase SQL Editor. It checks the required columns and accepted type categories, and checks for existing table, function, trigger, and index name conflicts before creating objects. The statements are wrapped in a transaction; if any statement fails, PostgreSQL marks the transaction aborted and none of its changes can be committed. Roll back the failed SQL Editor transaction before retrying. It creates only the private outbox, its queue-processing RPCs, and registration triggers. It does not alter existing tables, registration permissions, or RLS policies.

The outbox stores the registration identifier, notification type, delivery state, retry metadata, and timestamps. Participant and event details are joined from the existing tables only when the Edge Function processes a queued notification. The outbox has RLS enabled, no direct grants, and is not readable by `anon` or `authenticated`.

The triggers enqueue:

- `registration_confirmation` for an insert whose profile role is `participant` and whose status is `pending`.
- `registration_approved` for a `pending` to `approved` status transition.
- `registration_rejected` for a `pending` to `rejected` status transition.

The unique `(registration_id, notification_type)` constraint and atomic claim RPC suppress repeated queue events and concurrent processing. Failed sends are rescheduled with exponential backoff; after eight attempts the record is marked failed.

## Supabase Auth email confirmation and SMTP

The local Supabase config keeps email confirmation enabled and documents the same Brevo SMTP settings for local Supabase runs. It reads the SMTP login, SMTP key, and verified sender address from `BREVO_SMTP_LOGIN`, `BREVO_SMTP_KEY`, and `BREVO_FROM_EMAIL`; these are server-side/local Supabase secrets and must never be added to Vite `VITE_*` variables. The hosted Supabase project does not automatically inherit this file.

Signup stores the email in the Auth user and sends `account_type`, `full_name`, `phone`, and `organization` as Auth user metadata. This repository does not define the existing Auth-user-to-`profiles` trigger or the profiles schema. Before production, verify in the live database that its existing trigger maps `new.email` and those metadata fields to `profiles.email`, `role`, `full_name`, `phone`, and `organization`; the app requires that profile row for role-based access. Do not add a duplicate trigger without first checking the live schema.

Configure the hosted project manually in Supabase Dashboard:

1. Under **Authentication > Providers > Email**, keep Email provider enabled and turn **Confirm email** on.
2. Under **Authentication > SMTP Settings**, enable custom SMTP and set host `smtp-relay.brevo.com`, port `465`, and secure/TLS connection enabled. Use the Brevo SMTP login as the username and the Brevo SMTP key (not the API key) as the password. Set the sender email to an address verified in Brevo and the sender name to `Eventify`.
3. Under **Authentication > URL Configuration**, set the Site URL to the deployed Eventify origin. Add the exact redirect URLs for each deployed environment, including `https://your-eventify-host/` and `https://your-eventify-host/?email_confirmation=1`; add the corresponding local development URLs while testing. Signup and resend construct the redirect from `window.location.origin`.
4. Under **Authentication > Email Templates > Confirm signup**, use the Eventify HTML in `templates/confirmation.html`. The link/button must use `{{ .ConfirmationURL }}`. Paste the template into the Dashboard because changes to the local template are not automatically pushed to hosted Auth.

Brevo's `Delivered` status generally means the recipient mail server accepted the message; it does not guarantee inbox placement. Check Gmail Spam, Promotions, All Mail, filters, blocked senders, and the exact recipient address. Also check Brevo event details and sender/domain authentication (SPF/DKIM) if messages are filtered. The `BREVO_*` Edge Function secrets below are for registration notifications and do not configure Supabase Auth SMTP.

## Organizer event workflow

The app uses the existing lowercase event statuses `draft`, `published`, `completed`, and `cancelled`; participants query only `published` events, while organizer event queries are scoped to the current organizer ID. The organizer workflow relies on Supabase RLS to enforce those owner/public access rules. This repository does not include the existing `events` table policies, so inspect the live policies before changing them; do not disable RLS.

Before deploying the frontend changes, apply `migrations/20261105150000_add_event_times.sql` to the existing database. It only adds nullable `start_time` and `end_time` columns to `public.events`, preserving all existing events and registrations. Existing rows remain valid with no times recorded; new and edited event times are stored in those columns.

## Event mentors and speakers

Before deploying the frontend changes, review and run `migrations/20261106090000_create_event_people.sql` in the intended project's Supabase SQL Editor. The migration derives `event_people.event_id` from the existing `events.id` column type, adds a foreign key with cascading cleanup when an event is deleted, and creates the `event_people` table with role validation and display ordering. It stops before making changes if `public.events` or `public.profiles` is missing, or if an `event_people` table already exists; inspect any existing table rather than dropping or replacing it.

The migration enables RLS. Visitors and signed-in participants can read profiles only for published events. Approved organizers can read and manage profiles for their own events, including drafts. It grants no service-role access to the frontend. The table is added to the existing `supabase_realtime` publication so the selected event details view can refresh profiles when rows change. The subscription listens to authorized table changes and reloads only the currently viewed event's profiles.

To test after the migration:

1. Sign in with an approved organizer account, open Create Event or edit an existing event, add one Mentor and one Speaker, and save/publish. Confirm emptying the section is also allowed.
2. Refresh the organizer page and edit that event again. Confirm the saved entries load, then edit one and remove the other; save and verify those changes persist.
3. Open the published event as a participant or visitor. Confirm the Mentors and Speakers sections show the saved data and that an empty role has no section.
4. Keep the participant event details page open while the organizer changes a profile. Confirm the details refresh without a manual page reload.
5. In **Database > Policies**, verify the four `event_people` policies exist and RLS remains enabled. Test that an unapproved or different organizer cannot alter the rows.

## Registration capacity and live participant counts

Before deploying the frontend that displays counts, review and run `migrations/20261105225000_event_registration_capacity_counts.sql` in the intended project's Supabase SQL Editor. The migration verifies the required existing table columns and Supabase Realtime broadcast function; it does not change or disable RLS. If its checks fail, stop and compare the live schema before changing anything.

The migration adds a `BEFORE INSERT OR UPDATE` trigger that locks the event row and limits active registrations (`pending` and `approved`) to `events.capacity`. It rejects duplicate active registrations by the same participant. A second trigger prevents an organizer from reducing capacity below the existing active count. The read-only `get_event_registration_counts(text[])` RPC returns only aggregate counts for published events or events owned by the signed-in organizer; it exposes no participant details. Registration inserts, status changes, and deletes emit Realtime broadcasts containing only the event ID, prompting clients to refresh the aggregate RPC.

The app's existing registration `INSERT` and organizer status-update requests are protected by the database trigger, so the capacity guarantee also applies to concurrent requests and direct client inserts that pass the existing RLS policies. `pending` and `approved` reserve seats; `rejected` and other non-active statuses do not. Existing registration RLS policies remain unchanged. Review those policies in **Database > Policies** in the live project; this repository does not include them, and they could not be inspected from this workspace. Apply the migration before using the updated frontend. Supabase Dashboard SQL Editor is sufficient; no service-role key or schema reset is needed.

## Prevent duplicate participant registrations

Before deploying the frontend changes, review and run `migrations/20261106230000_prevent_duplicate_registrations.sql` in the intended project's Supabase SQL Editor. It checks that `event_id` and `participant_id` exist and are non-nullable, that RLS is enabled, and reports every repeated pair found. It aborts without deleting or changing existing registrations if duplicates exist. If the check reports duplicates, resolve them manually only after reviewing the affected records, then rerun the migration. On success it adds the unique index `registrations_event_participant_unique`, which enforces one record per `(event_id, participant_id)` across every status, including cancelled and rejected registrations. PostgreSQL uniqueness handles simultaneous attempts; duplicate attempts return SQLSTATE `23505` and do not create a second row or consume a seat. The migration adds a restrictive INSERT policy that requires the authenticated user's ID and a participant profile; it does not replace existing policies or change the capacity triggers. It also adds `registrations` to `supabase_realtime` when that publication exists and the table is not already included.

The frontend gets `participant_id` from the current Supabase Auth session, checks for an existing registration to provide a quick message, and handles database unique violations for racing requests. Check the live `registrations` RLS policies before deployment; this repository does not contain them and cannot verify the hosted policies. The migration's restrictive INSERT guard ensures `participant_id = auth.uid()` and that the caller has a participant profile, in addition to the existing permissive policy requirements. Inspect policies with:

```sql
SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'registrations'
ORDER BY policyname;
```

Remember that permissive RLS policies are combined with OR; the added restrictive policy is ANDed with those policies, so the existing workflow's permissive INSERT policy must still allow valid participant registrations. Do not disable RLS or replace existing policies.

Participant event details checks the signed-in participant's real registration, disables a repeat registration, and shows the database status. Pending is labeled “Approval Pending,” approved “Verified,” rejected “Rejected,” and cancelled “Cancelled.” The participant dashboard continues to fetch registration history on entry and subscribes to changes for the authenticated participant so organizer approval/rejection updates are refreshed without manual reload. If Realtime is unavailable, the dashboard displays the fetch/realtime error and still fetches again on revisit.

## Event image uploads

The organizer UI probes the existing `public.events` schema for `image_url` first and then `image`, and reads/writes whichever column exists. It does not create or require a second image column. Event images are uploaded through the authenticated Supabase client to the existing `event-images` bucket before the event row is saved. The bucket must be public for participant pages to load the generated public URLs.

Verify in **Storage > Buckets** that `event-images` exists and has public access enabled. Review the existing `storage.objects` RLS policies before adding any. The required access is:

- Public/anonymous `SELECT` only for objects whose `bucket_id` is `event-images`.
- Authenticated organizer `INSERT` and cleanup `DELETE` only for objects whose first storage path folder equals `auth.uid()` and whose matching `public.profiles` row has `role = 'organizer'` and `organizer_status = 'approved'`.
- No service-role key or frontend secret is needed. The frontend uploads beneath the authenticated organizer's UUID folder.

The live database and bucket settings were not inspectable from this workspace, so confirm the image column, bucket, and policies in the target project. The app reports an error instead of guessing or adding a duplicate column if neither supported image column exists. If upload or storage access fails, review the Supabase Storage error shown by the form and the bucket/policies above.

## Brevo and Edge Function setup

1. In Supabase Dashboard > Edge Function Secrets, set:
   - `EVENTIFY_SERVICE_ROLE_KEY` — the project service-role key. It is used only by this server-side function for its restricted database RPC calls. Use this custom name because Supabase reserves the `SUPABASE_` prefix.
   - `NOTIFICATION_FUNCTION_SECRET` — a long, random bearer secret used to authorize the scheduled worker.
   - `BREVO_SMTP_LOGIN` — the SMTP login shown in Brevo.
   - `BREVO_SMTP_KEY` — the SMTP key from Brevo (not a Brevo API key).
   - `BREVO_FROM_EMAIL` — a sender address verified in Brevo.
   - `BREVO_FROM_NAME` — optional sender display name; defaults to `Eventify`.

   Supabase provides `SUPABASE_URL` to Edge Functions. Do not put these credentials in frontend environment variables or source files.
2. Link the Supabase CLI to the intended project, then deploy `send-registration-notification` with JWT verification disabled because the worker authenticates using its own bearer secret:

   ```text
   supabase link --project-ref <project-ref>
   supabase functions deploy send-registration-notification --no-verify-jwt
   ```

   The function checks `NOTIFICATION_FUNCTION_SECRET` itself and rejects requests without the exact bearer value. Nodemailer is imported as an npm dependency using the function's `deno.json`. Deno documents `node:net` and `node:tls` compatibility, which Nodemailer uses for SMTP; Supabase permits npm dependencies and documents that outbound SMTP ports 25 and 587 are blocked. The function therefore uses explicit TLS on port 465. Still validate the actual SMTP handshake and delivery in a staging Edge Function before production; a local type check cannot validate Brevo credentials, network access, or the hosted runtime's SMTP path.
   To type-check locally, run `deno check index.ts` from `supabase/functions/send-registration-notification`; `deno.lock` pins the resolved npm dependencies. This check is not a substitute for sending a staging email.
3. Configure a one-minute scheduled POST to:

   ```text
   https://<project-ref>.supabase.co/functions/v1/send-registration-notification
   ```

   Include a bearer authorization header using the same worker secret configured in Edge Function Secrets, plus `Content-Type: application/json` and `{}` as the request body. Use Supabase Cron with `pg_net`/Vault or another trusted scheduler, and store the worker secret in Vault rather than in a committed SQL file. Enable the `pg_cron`, `pg_net`, and Vault extensions if they are not already enabled. Add the project URL to Vault as `eventify_supabase_url` and the same function secret as `eventify_notification_function_secret`. A Cron job can then invoke the worker every minute with:

   ```sql
   SELECT cron.schedule(
     'eventify-registration-notification-worker',
     '* * * * *',
     $$
       SELECT net.http_post(
         url := (
           SELECT decrypted_secret
           FROM vault.decrypted_secrets
           WHERE name = 'eventify_supabase_url'
         ) || '/functions/v1/send-registration-notification',
         headers := jsonb_build_object(
           'Content-Type', 'application/json',
           'Authorization', 'Bearer ' || (
             SELECT decrypted_secret
             FROM vault.decrypted_secrets
             WHERE name = 'eventify_notification_function_secret'
           )
         ),
         body := '{}'::jsonb
       );
     $$
   );
   ```

   Add both Vault entries through Supabase Vault before scheduling; do not put the bearer secret directly in the SQL text. Each run processes at most three due notifications to stay within Edge Function runtime limits; later runs continue the queue and retries.

## Operational notes

- The SQL migration is not automatically executed and the Edge Function is not automatically deployed by this project.
- A notification is considered sent after Brevo accepts the SMTP message. SMTP cannot guarantee exactly-once delivery: if a process fails after SMTP acceptance but before the sent state is saved, the message may be retried. The outbox prevents duplicate queue rows and concurrent sends, and uses a deterministic `Message-ID`, but that ID is not a provider idempotency guarantee.
- Check the outbox through the Supabase SQL Editor when diagnosing delivery. Rows that exhaust all attempts have `status = 'failed'` and a `last_error`; repair configuration and manually requeue only after confirming whether the message was accepted by Brevo.
- The notification worker uses database tables and columns named in the migration compatibility check. If the live database differs, do not run the migration until it has been reviewed and adapted to the actual schema.
