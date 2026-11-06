import nodemailer from "nodemailer";
import { createClient } from "npm:@supabase/supabase-js@2";

const MAX_NOTIFICATIONS_PER_RUN = 3;

type ClaimedNotification = {
  notification_id: number;
  notification_type: "registration_confirmation" | "registration_approved" | "registration_rejected";
  registration_id: string;
  attempt_count: number;
};

type NotificationDetails = {
  notification_type: ClaimedNotification["notification_type"];
  participant_email: string | null;
  participant_name: string | null;
  event_name: string | null;
  venue: string | null;
  event_date: string | null;
  registration_date: string | null;
};

function requiredSecret(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required Edge Function secret: ${name}`);
  return value;
}

const notificationSecret = requiredSecret("NOTIFICATION_FUNCTION_SECRET");
const supabaseUrl = requiredSecret("SUPABASE_URL");
const serviceRoleKey = requiredSecret("EVENTIFY_SERVICE_ROLE_KEY");
const smtpLogin = requiredSecret("BREVO_SMTP_LOGIN");
const smtpKey = requiredSecret("BREVO_SMTP_KEY");
const senderEmail = requiredSecret("BREVO_FROM_EMAIL");
const senderName = Deno.env.get("BREVO_FROM_NAME") || "Eventify";

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

const transporter = nodemailer.createTransport({
  host: "smtp-relay.brevo.com",
  port: 465,
  secure: true,
  auth: {
    user: smtpLogin,
    pass: smtpKey,
  },
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
});

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return false;

  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function notificationCopy(type: ClaimedNotification["notification_type"]) {
  switch (type) {
    case "registration_confirmation":
      return {
        subject: "We received your Eventify registration",
        message: "Your registration is pending review by the event organizer.",
      };
    case "registration_approved":
      return {
        subject: "Your Eventify registration was approved",
        message: "The event organizer approved your registration.",
      };
    case "registration_rejected":
      return {
        subject: "Your Eventify registration was rejected",
        message: "The event organizer was unable to approve your registration.",
      };
  }
}

function retryDelaySeconds(attempt: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempt - 1), 3600);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown email delivery error.";
  return message.slice(0, 2000);
}

async function completeNotification(
  notificationId: number,
  error?: string,
  retryDelay = 60,
): Promise<void> {
  const { error: completionError } = await supabase.rpc(
    "complete_registration_notification",
    {
      p_notification_id: notificationId,
      p_error: error ?? null,
      p_retry_delay_seconds: retryDelay,
    },
  );
  if (completionError) {
    throw new Error(`Could not record notification delivery state: ${completionError.message}`);
  }
}

async function sendNotification(
  notification: ClaimedNotification,
): Promise<void> {
  const { data, error } = await supabase.rpc(
    "get_registration_notification_details",
    { p_notification_id: notification.notification_id },
  );
  if (error) throw new Error(`Could not load notification details: ${error.message}`);

  const details = (data as NotificationDetails[] | null)?.[0];
  if (!details) throw new Error("Notification details were not available.");
  if (details.notification_type !== notification.notification_type) {
    throw new Error("Notification type did not match its queued event.");
  }
  if (!details.participant_email?.trim()) {
    throw new Error("The participant profile does not have an email address.");
  }

  const copy = notificationCopy(notification.notification_type);
  const name = details.participant_name?.trim() || "Participant";
  const eventName = details.event_name?.trim() || "Event";
  const venue = details.venue?.trim() || "To be announced";
  const eventDate = details.event_date?.trim() || "To be announced";
  const registrationDate = details.registration_date?.trim() || "Not available";
  const safeName = escapeHtml(name);
  const safeEventName = escapeHtml(eventName);
  const safeVenue = escapeHtml(venue);
  const safeEventDate = escapeHtml(eventDate);
  const senderDomain = senderEmail.split("@").at(-1) || "eventify.invalid";

  await transporter.sendMail({
    from: { address: senderEmail, name: senderName },
    to: details.participant_email,
    subject: copy.subject,
    messageId: `<eventify-notification-${notification.notification_id}@${senderDomain}>`,
    text: [
      `Hello ${name},`,
      "",
      copy.message,
      "",
      `Event: ${eventName}`,
      `Venue: ${venue}`,
      `Date: ${eventDate}`,
      `Registration submitted: ${registrationDate}`,
      `Registration ID: ${notification.registration_id}`,
    ].join("\n"),
    html: [
      `<p>Hello ${safeName},</p>`,
      `<p>${escapeHtml(copy.message)}</p>`,
      `<p><strong>Event:</strong> ${safeEventName}<br>`,
      `<strong>Venue:</strong> ${safeVenue}<br>`,
      `<strong>Date:</strong> ${safeEventDate}<br>`,
      `<strong>Registration submitted:</strong> ${escapeHtml(registrationDate)}<br>`,
      `<strong>Registration ID:</strong> ${escapeHtml(notification.registration_id)}</p>`,
    ].join(""),
  });
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }

  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  if (!constantTimeEqual(bearer, notificationSecret)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  let processed = 0;
  let sent = 0;
  let retryScheduled = 0;

  try {
    while (processed < MAX_NOTIFICATIONS_PER_RUN) {
      const { data, error } = await supabase.rpc("claim_registration_notification");
      if (error) throw new Error(`Could not claim a notification: ${error.message}`);

      const notification = (data as ClaimedNotification[] | null)?.[0];
      if (!notification) break;

      processed += 1;
      try {
        await sendNotification(notification);
      } catch (deliveryError) {
        const message = errorMessage(deliveryError);
        await completeNotification(
          notification.notification_id,
          message,
          retryDelaySeconds(notification.attempt_count),
        );
        retryScheduled += 1;
        console.error("Registration notification delivery failed.", {
          notificationId: notification.notification_id,
          attempt: notification.attempt_count,
          error: message,
        });
        continue;
      }

      await completeNotification(notification.notification_id);
      sent += 1;
    }

    return Response.json({ processed, sent, retryScheduled });
  } catch (error) {
    const message = errorMessage(error);
    console.error("Registration notification worker failed.", message);
    return Response.json({ error: "Notification processing failed." }, { status: 500 });
  }
});
