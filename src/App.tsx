import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { supabase } from "./lib/supabase"

type UserRole = "participant" | "organizer"
type OrganizerStatus = "not_requested" | "pending" | "approved" | "rejected"
type EventStatus = "draft" | "published" | "completed" | "cancelled"
type Page = "home" | "explore" | "details" | "login" | "participant-login" | "organizer-login" | "signup" | "organizer-signup" | "participant-signup" | "register" | "review" | "confirmation" | "dashboard" | "profile" | "organizer" | "admin" | "notifications"

type UserProfile = {
  fullName: string
  email: string
  phone: string
  organization: string
  role: UserRole
  organizerStatus: OrganizerStatus
}

type ProfileDetails = Partial<Pick<UserProfile, "fullName" | "phone" | "organization">>

type AuthenticationResult =
  | { status: "authenticated" }
  | {
      status: "confirmation" | "organizer-confirmation"
      email: string
      accountAlreadyExists: boolean
    }

const verificationResendCooldownSeconds = 60

function emailConfirmationRedirectTo() {
  return new URL("/?email_confirmation=1", window.location.origin).toString()
}

function profileInitials(profile: UserProfile | null) {
  const name = profile?.fullName || profile?.email || "Account"
  return name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("") || "AC"
}

type RegistrationStatus = "Pending" | "Approved" | "Rejected" | "Cancelled"

type RegistrationRecord = {
  id: string
  eventId: string
  participantId: string
  participant: string
  email: string
  phone: string
  organization: string
  event: string
  eventDate: string
  venue: string
  date: string
  createdAt: string
  status: RegistrationStatus
}

type EventItem = {
  id: number | string
  title: string
  date: string
  time: string
  endTime?: string
  location: string
  category: string
  price: string
  seats: number
  registeredCount?: number
  image: string
  imageUrl?: string
  status?: EventStatus
  description?: string
  ownerEmail?: string
  eventDate?: string
  registrationDeadline?: string
  startTimeValue?: string
  endTimeValue?: string
  people?: EventPerson[]
}

type EventPersonRole = "mentor" | "speaker"

type EventPerson = {
  id?: string
  clientId: string
  name: string
  role: EventPersonRole
  designation: string
  bio: string
}

type EventSaveResult = {
  eventId: string
  imageUrl: string | null
  status: EventStatus
  people: EventPerson[]
}

class EventPeopleSaveError extends Error {
  constructor(
    message: string,
    readonly savedEventId: string,
    readonly savedImageUrl: string | null,
    readonly savedStatus: EventStatus,
  ) {
    super(message)
    this.name = "EventPeopleSaveError"
  }
}

async function fetchEventPeople(eventId: string): Promise<EventPerson[]> {
  const { data, error } = await supabase
    .from("event_people")
    .select("id, event_id, name, role, designation, bio, display_order")
    .eq("event_id", eventId)
    .order("display_order", { ascending: true })
  if (error) throw new Error(`Could not load event mentors and speakers: ${error.message}`)
  return (data || []).map((value) => {
    const row = value as unknown as Record<string, unknown>
    if (
      typeof row.id !== "string" ||
      typeof row.name !== "string" ||
      (row.role !== "mentor" && row.role !== "speaker") ||
      (row.designation !== null && typeof row.designation !== "string") ||
      (row.bio !== null && typeof row.bio !== "string")
    ) {
      throw new Error("Supabase returned an invalid mentor or speaker record.")
    }
    return {
      id: row.id,
      clientId: row.id,
      name: row.name,
      role: row.role,
      designation: typeof row.designation === "string" ? row.designation : "",
      bio: typeof row.bio === "string" ? row.bio : "",
    }
  })
}

async function saveEventPeople(eventId: string, people: EventPerson[]): Promise<EventPerson[]> {
  const completePeople = people.filter((person) =>
    person.name.trim() || person.designation.trim() || person.bio.trim(),
  )
  const incompletePerson = completePeople.find((person) => !person.name.trim())
  if (incompletePerson) {
    throw new Error("Enter a name for each mentor or speaker, or remove the empty entry.")
  }

  const { data: existingRows, error: existingError } = await supabase
    .from("event_people")
    .select("id")
    .eq("event_id", eventId)
  if (existingError) throw new Error(`Could not inspect saved mentors and speakers: ${existingError.message}`)

  const retainedIds = new Set(completePeople.flatMap((person) => person.id ? [person.id] : []))
  if (completePeople.length) {
    const rows = completePeople.map((person, display_order) => ({
      ...(person.id ? { id: person.id } : {}),
      event_id: eventId,
      name: person.name.trim(),
      role: person.role,
      designation: person.designation.trim() || null,
      bio: person.bio.trim() || null,
      display_order,
    }))
    const { error } = await supabase.from("event_people").upsert(rows)
    if (error) throw new Error(`Could not save mentors and speakers: ${error.message}`)
  }
  const removedIds = ((existingRows || []) as { id: string }[])
    .map((row) => row.id)
    .filter((id) => !retainedIds.has(id))
  if (removedIds.length) {
    const { error } = await supabase
      .from("event_people")
      .delete()
      .eq("event_id", eventId)
      .in("id", removedIds)
    if (error) throw new Error(`Could not remove mentors and speakers: ${error.message}`)
  }
  return fetchEventPeople(eventId)
}

type EventRecord = {
  id: string
  title: string
  description: string | null
  venue: string
  event_date: string
  registration_deadline: string
  capacity: number
  organizer_id: string
  status: string
  start_time: string | null
  end_time: string | null
  image?: string | null
  image_url?: string | null
}

type RegistrationRow = {
  id: string
  event_id: string
  participant_id: string
  status: string
  registered_at: string
}

type OrganizerRegistrationRow = {
  registration_id: string
  participant_id: string
  participant_name: string | null
  participant_email: string | null
  participant_phone: string | null
  participant_organization: string | null
  event_id: string
  event_name: string
  venue: string
  event_date: string
  registered_at: string
  registration_status: string
}

type NewEventInput = {
  title: string
  description: string
  venue: string
  eventDate: string
  registrationDeadline: string
  capacity: number
  startTime: string
  endTime: string
}

type EventFormField = keyof NewEventInput | "status"

type EventRegistrationCount = {
  event_id: string
  capacity: number
  registered_count: number
}

const eventFormFields: (keyof NewEventInput)[] = [
  "title",
  "description",
  "venue",
  "eventDate",
  "registrationDeadline",
  "capacity",
  "startTime",
  "endTime",
]

type EventImageColumn = "image" | "image_url"

const defaultEventImage = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#f0edfa"/><stop offset="1" stop-color="#ded8f2"/></linearGradient></defs><rect width="1200" height="675" fill="url(#g)"/><circle cx="600" cy="290" r="72" fill="#7452e8" opacity=".16"/><path d="M470 430l92-105 70 72 49-54 90 87H470z" fill="#7452e8" opacity=".3"/><text x="600" y="510" fill="#625d70" font-family="Arial,sans-serif" font-size="30" text-anchor="middle">Event image</text></svg>',
)}`

function formatEventTime(time: string | null) {
  if (!time) return ""
  const [hours, minutes] = time.split(":").map(Number)
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return ""
  return new Date(Date.UTC(2000, 0, 1, hours, minutes)).toLocaleTimeString(
    "en-US",
    { hour: "numeric", minute: "2-digit", timeZone: "UTC" },
  )
}

function dateInputValue(value: string | null | undefined) {
  const normalized = value?.trim() || ""
  const isoDate = normalized.match(/^(\d{4}-\d{2}-\d{2})/)
  if (isoDate) return isoDate[1]
  if (!normalized) return ""
  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) return ""
  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, "0")
  const day = String(parsed.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function timeInputValue(value: string | null | undefined) {
  const normalized = value?.trim() || ""
  const timeOnly = normalized.match(/^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/)
  if (timeOnly) return `${timeOnly[1].padStart(2, "0")}:${timeOnly[2]}`
  if (!normalized) return ""
  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) return ""
  return `${String(parsed.getHours()).padStart(2, "0")}:${String(parsed.getMinutes()).padStart(2, "0")}`
}

function eventStatusFromRecord(status: string): EventStatus {
  const normalizedStatus = status.trim().toLowerCase()
  if (
    normalizedStatus === "draft" ||
    normalizedStatus === "published" ||
    normalizedStatus === "completed" ||
    normalizedStatus === "cancelled"
  ) {
    return normalizedStatus
  }
  throw new Error(`Unsupported event status in Supabase: ${status || "(empty)"}`)
}

function eventFromRecord(record: EventRecord): EventItem {
  const eventDate = dateInputValue(record.event_date)
  const startTimeValue = timeInputValue(record.start_time)
  const endTimeValue = timeInputValue(record.end_time)
  const startTime = formatEventTime(startTimeValue)
  const endTime = formatEventTime(endTimeValue)
  const imageUrl = record.image_url || record.image || ""
  return {
    id: record.id,
    title: record.title,
    date: eventDate
      ? new Date(`${eventDate}T00:00:00`).toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
        })
      : record.event_date,
    time: [startTime, endTime].filter(Boolean).join(" – "),
    location: record.venue,
    category: "Event",
    price: "Free",
    seats: record.capacity,
    image: imageUrl || defaultEventImage,
    imageUrl: imageUrl || undefined,
    status: eventStatusFromRecord(record.status),
    description: record.description || "",
    eventDate,
    registrationDeadline: dateInputValue(record.registration_deadline),
    startTimeValue,
    endTimeValue,
  }
}

function eventRecordFromRow(value: unknown): EventRecord {
  if (typeof value !== "object" || value === null) {
    throw new Error("Supabase returned an invalid event record.")
  }
  const row = value as Record<string, unknown>
  const requiredString = (field: string) => {
    const fieldValue = row[field]
    if (typeof fieldValue !== "string") {
      throw new Error(`Supabase returned an invalid event ${field} value.`)
    }
    return fieldValue
  }
  const nullableString = (field: string) => {
    const fieldValue = row[field]
    if (fieldValue !== null && typeof fieldValue !== "string") {
      throw new Error(`Supabase returned an invalid event ${field} value.`)
    }
    return fieldValue
  }
  if (typeof row.capacity !== "number") {
    throw new Error("Supabase returned an invalid event capacity.")
  }
  const record: EventRecord = {
    id: requiredString("id"),
    title: requiredString("title"),
    description: nullableString("description"),
    venue: requiredString("venue"),
    event_date: requiredString("event_date"),
    registration_deadline: requiredString("registration_deadline"),
    capacity: row.capacity,
    organizer_id: requiredString("organizer_id"),
    status: requiredString("status"),
    start_time: nullableString("start_time"),
    end_time: nullableString("end_time"),
  }
  if ("image" in row) record.image = nullableString("image")
  if ("image_url" in row) record.image_url = nullableString("image_url")
  return record
}

async function fetchEventRegistrationCounts(eventIds: string[]) {
  if (!eventIds.length) return new Map<string, { capacity: number; registeredCount: number }>()
  const { data, error } = await supabase.rpc("get_event_registration_counts", {
    p_event_ids: eventIds.map((eventId) => String(eventId)),
  })
  if (error) {
    throw new Error(`Could not load event registration counts: ${error.message}`)
  }
  const countRows = (data || []) as EventRegistrationCount[]
  const counts = new Map<string, { capacity: number; registeredCount: number }>()
  for (const row of countRows) {
    const capacity = Number(row.capacity)
    const registeredCount = Number(row.registered_count)
    if (!Number.isSafeInteger(capacity) || !Number.isSafeInteger(registeredCount)) {
      throw new Error("Supabase returned an invalid event registration count.")
    }
    counts.set(row.event_id, { capacity, registeredCount })
  }
  return counts
}

async function loadEventRegistrationCounts(events: EventItem[]) {
  if (!events.length) return events
  const counts = await fetchEventRegistrationCounts(events.map((event) => String(event.id)))
  return events.map((event) => {
    const count = counts.get(String(event.id))
    if (!count) {
      throw new Error(`Could not load a valid registration count for ${event.title}.`)
    }
    return {
      ...event,
      seats: count.capacity,
      registeredCount: count.registeredCount,
    }
  })
}

function registrationDeadlinePassed(deadline?: string) {
  if (!deadline) return false
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  return deadline < today
}

function registrationFromRows(
  row: RegistrationRow,
  eventRecord: EventRecord,
  participant: { full_name?: string | null; email?: string | null; phone?: string | null; organization?: string | null },
): RegistrationRecord {
  const status = row.status.toLowerCase()
  if (!["pending", "approved", "rejected", "cancelled", "canceled"].includes(status)) {
    throw new Error(`Unsupported registration status: ${row.status}`)
  }
  return {
    id: row.id,
    eventId: row.event_id,
    participantId: row.participant_id,
    participant: participant.full_name || "Participant",
    email: participant.email || "",
    phone: participant.phone || "",
    organization: participant.organization || "",
    event: eventRecord.title,
    eventDate: eventRecord.event_date,
    venue: eventRecord.venue,
    date: new Date(row.registered_at).toLocaleDateString(),
    createdAt: row.registered_at,
    status: status === "pending"
      ? "Pending"
      : status === "approved"
        ? "Approved"
        : status === "rejected"
          ? "Rejected"
          : "Cancelled",
  }
}

function registrationStatusMessage(status: RegistrationStatus) {
  switch (status) {
    case "Pending":
      return "You are already registered for this event. Your approval is pending."
    case "Approved":
      return "You are already registered for this event. Your registration is verified."
    case "Rejected":
      return "Your registration was rejected."
    case "Cancelled":
      return "Your registration was cancelled."
  }
}

function organizerRegistrationFromRow(row: OrganizerRegistrationRow): RegistrationRecord {
  const status = row.registration_status.toLowerCase()
  if (!["pending", "approved", "rejected", "cancelled", "canceled"].includes(status)) {
    throw new Error(`Unsupported registration status: ${row.registration_status}`)
  }
  return {
    id: row.registration_id,
    eventId: row.event_id,
    participantId: row.participant_id,
    participant: row.participant_name || "Participant",
    email: row.participant_email || "",
    phone: row.participant_phone || "",
    organization: row.participant_organization || "",
    event: row.event_name,
    eventDate: row.event_date,
    venue: row.venue,
    date: new Date(row.registered_at).toLocaleDateString(),
    createdAt: row.registered_at,
    status: status === "pending"
      ? "Pending"
      : status === "approved"
        ? "Approved"
        : status === "rejected"
          ? "Rejected"
          : "Cancelled",
  }
}

const photos = {
  hackathon:
    "https://images.unsplash.com/photo-1504384764586-bb4cdc1707b0?auto=format&fit=crop&w=1200&q=85",
  conference:
    "https://images.unsplash.com/photo-1559223607-a43c990c692c?auto=format&fit=crop&w=1200&q=85",
  workshop:
    "https://images.unsplash.com/photo-1524178232363-1fb2b075b655?auto=format&fit=crop&w=1200&q=85",
  music:
    "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1200&q=85",
  seminar:
    "https://images.unsplash.com/photo-1758270705067-0d7edee57af0?auto=format&fit=crop&w=1200&q=85",
  teams:
    "https://images.unsplash.com/flagged/photo-1564445477052-8a3787406bbf?auto=format&fit=crop&w=1200&q=85",
}

const categories = [
  ["</>", "Technology"],
  ["✦", "Workshops"],
  ["⌘", "Hackathons"],
  ["◈", "Cultural Events"],
  ["♫", "Music & Entertainment"],
  ["◎", "Sports"],
  ["↗", "Business"],
  ["▤", "Seminars"],
]

const navItems = [
  ["home", "Home"],
  ["explore", "Explore Events"],
  ["categories", "Categories"],
  ["dashboard", "My Registrations"],
] as const

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </>
    ),
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M16 3v4M8 3v4M3 10h18" />
      </>
    ),
    pin: (
      <>
        <path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" />
        <circle cx="12" cy="10" r="2.5" />
      </>
    ),
    users: (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </>
    ),
    arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    heart: (
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5a5.5 5.5 0 0 0 1-8.9Z" />
    ),
    share: (
      <>
        <circle cx="18" cy="5" r="3" />
        <circle cx="6" cy="12" r="3" />
        <circle cx="18" cy="19" r="3" />
        <path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4" />
      </>
    ),
    bell: (
      <>
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
        <path d="M10 21h4" />
      </>
    ),
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    close: <path d="M18 6 6 18M6 6l12 12" />,
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" />
        <rect x="14" y="3" width="7" height="7" />
        <rect x="3" y="14" width="7" height="7" />
        <rect x="14" y="14" width="7" height="7" />
      </>
    ),
    list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
    ticket: (
      <>
        <path d="M2 9a3 3 0 0 0 0 6v3h20v-3a3 3 0 0 0 0-6V6H2Z" />
        <path d="M13 6v2M13 11v2M13 16v2" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    download: <path d="M12 3v12m0 0 5-5m-5 5-5-5M5 21h14" />,
    home: (
      <>
        <path d="m3 11 9-8 9 8" />
        <path d="M5 10v11h14V10M9 21v-7h6v7" />
      </>
    ),
    logout: <path d="M10 17l5-5-5-5M15 12H3M15 3h6v18h-6" />,
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
      </>
    ),
    chevron: <path d="m7 10 5 5 5-5" />,
  }
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name] || paths.arrow}
    </svg>
  )
}

function Button({
  children,
  onClick,
  variant = "primary",
  type = "button",
  disabled = false,
  className = "",
  value,
}: {
  children: ReactNode
  onClick?: () => void
  variant?: "primary" | "secondary" | "ghost" | "dark" | "danger"
  type?: "button" | "submit"
  disabled?: boolean
  className?: string
  value?: string
}) {
  return (
    <button
      className={`btn btn-${variant} ${className}`}
      onClick={onClick}
      type={type}
      disabled={disabled}
      value={value}
    >
      {children}
    </button>
  )
}

function Logo({ go }: { go: (page: Page) => void }) {
  return (
    <button
      className="logo"
      onClick={() => go("home")}
      aria-label="Eventify home"
    >
      <span className="logo-mark">
        <span />
      </span>
      <span>Eventify</span>
    </button>
  )
}

function Header({
  go,
  active,
  notifications,
  profile,
  onLogout,
}: {
  go: (page: Page) => void
  active: Page
  notifications: number
  profile: UserProfile | null
  onLogout: () => void
}) {
  const [open, setOpen] = useState(false)
  const navigate = (page: Page) => {
    go(page)
    setOpen(false)
  }
  const visibleNavItems = navItems.filter(([page]) => {
    if (page === "dashboard") return profile?.role === "participant"
    return true
  })
  const profilePage: Page = profile?.role === "organizer"
    ? "organizer"
    : profile?.role === "participant"
      ? "profile"
      : "login"
  const accountMenu = profile ? (
    <details className="nav-account">
      <summary aria-label={`Account menu for ${profile.fullName || profile.email}`}>
        <span className="nav-account-avatar">{profileInitials(profile)}</span>
        <span className="nav-account-name">{profile.fullName || profile.email}</span>
        <Icon name="chevron" size={16} />
      </summary>
      <div className="nav-account-menu">
        <div className="nav-account-meta">
          <strong>{profile.fullName || "Eventify member"}</strong>
          <span>{profile.email}</span>
          <small>{profile.role === "organizer" ? "Organizer" : "Participant"}</small>
        </div>
        <button type="button" onClick={() => navigate(profilePage)}>
          <Icon name="users" size={16} /> My Profile
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            onLogout()
          }}
        >
          <Icon name="logout" size={16} /> Log out
        </button>
      </div>
    </details>
  ) : (
    <>
      <Button variant="ghost" onClick={() => navigate("login")}>Login</Button>
      <Button variant="secondary" onClick={() => navigate("signup")}>Sign Up</Button>
    </>
  )
  return (
    <header className="topbar">
      <div className="container nav-wrap">
        <Logo go={navigate} />
        <nav className={open ? "main-nav open" : "main-nav"}>
          {visibleNavItems.map(([page, label]) => (
            <button
              key={page}
              className={active === page || (page === "dashboard" && active === "profile") ? "nav-link active" : "nav-link"}
              onClick={() =>
                page === "categories"
                  ? (go("home"),
                    setTimeout(
                      () =>
                        document
                          .getElementById("categories")
                          ?.scrollIntoView({ behavior: "smooth" }),
                      10,
                    ))
                  : navigate(page)
              }
            >
              {label}
            </button>
          ))}
          <div className="mobile-actions">
            {profile ? accountMenu : (
              <>
                <Button variant="ghost" onClick={() => navigate("login")}>Login</Button>
                <Button onClick={() => navigate("signup")}>Sign Up</Button>
              </>
            )}
          </div>
        </nav>
        <div className="nav-actions">
          <button
            className="icon-btn notify-btn"
            aria-label="Notifications"
            onClick={() => go("notifications")}
          >
            <Icon name="bell" />
            {notifications > 0 && <span>{notifications}</span>}
          </button>
          {accountMenu}
          <Button onClick={() => go(profile?.role === "organizer" ? "organizer" : "explore")}>
            {profile?.role === "organizer" ? "Organizer Dashboard" : "Explore Events"}{" "}
            <Icon name="arrow" size={17} />
          </Button>
        </div>
        <button
          className="menu-btn"
          onClick={() => setOpen(!open)}
          aria-label="Open menu"
        >
          <Icon name={open ? "close" : "menu"} />
        </button>
      </div>
    </header>
  )
}

function SectionHeading({
  eyebrow,
  title,
  text,
  action,
}: {
  eyebrow?: string
  title: string
  text?: string
  action?: ReactNode
}) {
  return (
    <div className="section-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
        {text && <p>{text}</p>}
      </div>
      {action}
    </div>
  )
}

function EventCard({
  event,
  go,
  selectEvent,
  saved,
  toggleSave,
  compact = false,
}: {
  event: EventItem
  go: (page: Page) => void
  selectEvent?: (id: EventItem["id"]) => void
  saved: EventItem["id"][]
  toggleSave: (id: EventItem["id"]) => void
  compact?: boolean
}) {
  const registeredCount = event.registeredCount ?? 0
  const availableSeats = Math.max(0, event.seats - registeredCount)
  const fullyBooked = availableSeats === 0
  return (
    <article className={compact ? "event-card compact" : "event-card"}>
      <div className="event-image">
        <EventImage src={event.image} alt={`${event.title} event`} />
        <span className="category-badge">{event.category}</span>
        <button
          className={saved.includes(event.id) ? "save-btn saved" : "save-btn"}
          onClick={() => toggleSave(event.id)}
          aria-label="Save event"
        >
          <Icon name="heart" size={18} />
        </button>
      </div>
      <div className="event-content">
        <div className="event-topline">
          <span className="date-label">{event.date}</span>
          <strong className={event.price === "Free" ? "price free" : "price"}>
            {event.price}
          </strong>
        </div>
        <h3>{event.title}</h3>
        <div className="event-meta">
          <span>
            <Icon name="clock" size={16} /> {event.time}
          </span>
          <span>
            <Icon name="pin" size={16} /> {event.location}
          </span>
        </div>
        <div className="card-footer">
          <span className="seats">
            <Icon name="users" size={17} /> {registeredCount} / {event.seats} registered · {fullyBooked
              ? "Fully Booked"
              : `${availableSeats} seats left`}
          </span>
          <div className="card-actions">
            <Button
              variant="ghost"
              onClick={() => {
                selectEvent?.(event.id)
                go("details")
              }}
            >
              Details
            </Button>
            <Button
              disabled={fullyBooked || registrationDeadlinePassed(event.registrationDeadline)}
              onClick={() => {
                selectEvent?.(event.id)
                go("register")
              }}
            >
              Register
            </Button>
          </div>
        </div>
      </div>
    </article>
  )
}

function EventImage({
  src,
  alt,
  className,
}: {
  src?: string
  alt: string
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  return (
    <img
      className={className}
      src={!src || failed ? defaultEventImage : src}
      alt={alt}
      onError={() => setFailed(true)}
    />
  )
}

function Footer({ go }: { go: (page: Page) => void }) {
  return (
    <footer className="footer">
      <div className="container footer-compact">
        <div className="footer-brand">
          <Logo go={go} />
          <p>Connecting Students Through Campus Events.</p>
        </div>
        <div className="footer-bottom">
          <span>© {new Date().getFullYear()} Eventify. All rights reserved.</span>
        </div>
      </div>
    </footer>
  )
}

function Home({
  go,
  eventList,
  selectEvent,
  saved,
  toggleSave,
  continueAs,
  profile,
  eventsLoading,
  eventsError,
}: {
  go: (page: Page) => void
  eventList: EventItem[]
  selectEvent: (id: EventItem["id"]) => void
  saved: EventItem["id"][]
  toggleSave: (id: EventItem["id"]) => void
  continueAs: (role: UserRole) => void
  profile: UserProfile | null
  eventsLoading: boolean
  eventsError: string
}) {
  const [query, setQuery] = useState("")
  const highlightedEvent = eventList[0]
  const isParticipant = profile?.role === "participant"
  const isOrganizer = profile?.role === "organizer"
  const search = (e: FormEvent) => {
    e.preventDefault()
    go("explore")
  }
  return (
    <>
      <main>
        <section className="hero">
          <div className="hero-glow glow-one" />
          <div className="hero-glow glow-two" />
          <div className="container hero-grid">
            <div className="hero-copy">
              <span className="hero-pill">
                <span /> Campus experiences, all in one place
              </span>
              <h1>
                Discover events.
                <br />
                <em>Create experiences.</em>
              </h1>
              <p>
                Find exciting events, register in seconds, and connect with
                people who share your interests.
              </p>
              <div className="hero-actions">
                <Button onClick={() => go("explore")}>
                  Explore Events <Icon name="arrow" size={18} />
                </Button>
                {!isParticipant && (
                  <Button variant="secondary" onClick={() => go("organizer")}>
                    {isOrganizer ? "Organizer Dashboard" : "Create an Event"}
                  </Button>
                )}
              </div>
              <div className="hero-proof">
                <div className="avatars">
                  {eventList.slice(0, 3).map((event) => (
                    <EventImage src={event.image} key={event.id} alt="" />
                  ))}
                </div>
                <div>
                  <strong>{eventList.length} published event{eventList.length === 1 ? "" : "s"}</strong>
                  <span>Listed on Eventify</span>
                </div>
              </div>
            </div>
            <div className="hero-visual">
              <div className="hero-photo">
                <EventImage
                  src={highlightedEvent?.image}
                  alt={highlightedEvent ? highlightedEvent.title : "Event image placeholder"}
                />
              </div>
              <div className="floating-card date-card">
                <span className="float-icon">
                  <Icon name="calendar" />
                </span>
                <div>
                  <small>{highlightedEvent ? "Featured event" : "Eventify"}</small>
                  <strong>{highlightedEvent?.title || "Discover campus events"}</strong>
                  <span>
                    {highlightedEvent
                      ? [highlightedEvent.date, highlightedEvent.time, highlightedEvent.location]
                          .filter(Boolean)
                          .join(" · ")
                      : "Published events will appear here"}
                  </span>
                </div>
              </div>
              <div className="floating-card attendees-card">
                <span className="float-icon"><Icon name="ticket" /></span>
                <div>
                  <strong>{highlightedEvent?.category || "Campus events"}</strong>
                  <span>{highlightedEvent?.price || "Explore what's happening"}</span>
                </div>
              </div>
            </div>
          </div>
          <form className="container search-panel" onSubmit={search}>
            <label className="search-main">
              <Icon name="search" />
              <span>
                <small>Search events</small>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Event name or category"
                />
              </span>
            </label>
            <label>
              <Icon name="pin" />
              <span>
                <small>Location</small>
                <select defaultValue="all">
                  <option value="all">All locations</option>
                  <option>On campus</option>
                  <option>Online</option>
                </select>
              </span>
            </label>
            <label>
              <Icon name="calendar" />
              <span>
                <small>Date</small>
                <select defaultValue="any">
                  <option value="any">Any date</option>
                  <option>This week</option>
                  <option>This month</option>
                </select>
              </span>
            </label>
            <Button type="submit">Search</Button>
          </form>
        </section>

        <section className="experience-section section">
          <div className="container">
            <div className="experience-heading">
              <span className="eyebrow">Your Eventify journey</span>
              <h2>Choose Your Experience</h2>
              <p>
                Whether you're here to discover events or organize them,
                Eventify has you covered.
              </p>
            </div>
            <div className={`experience-grid ${isParticipant || isOrganizer ? "single-experience" : ""}`}>
              {!isOrganizer && <article className="experience-card participant">
                <span className="experience-icon">
                  <Icon name="ticket" size={24} />
                </span>
                <span className="eyebrow">For attendees</span>
                <h3>Participant Portal</h3>
                <p>
                  Discover exciting campus events, register for your favorites,
                  and manage all your event bookings in one place.
                </p>
                <ul>
                  {[
                    "Explore upcoming events",
                    "Register for events",
                    "Track registration status",
                    "View your registered events and tickets",
                  ].map((feature) => (
                    <li key={feature}>
                      <Icon name="check" size={17} />
                      {feature}
                    </li>
                  ))}
                </ul>
                <Button
                  className="experience-button"
                  onClick={() => continueAs("participant")}
                >
                  Continue as Participant <Icon name="arrow" size={17} />
                </Button>
              </article>}
              {!isParticipant && <article className="experience-card organizer">
                <span className="experience-icon">
                  <Icon name="calendar" size={24} />
                </span>
                <span className="eyebrow">For event teams</span>
                <h3>Organizer Dashboard</h3>
                <p>
                  Create amazing campus events, manage registrations, verify
                  participant entries, and keep track of your event activities.
                </p>
                <ul>
                  {[
                    "Create and publish events",
                    "Manage existing events",
                    "Review participant registrations",
                    "Verify entries and track attendance",
                  ].map((feature) => (
                    <li key={feature}>
                      <Icon name="check" size={17} />
                      {feature}
                    </li>
                  ))}
                </ul>
                <Button
                  className="experience-button"
                  onClick={() => continueAs("organizer")}
                >
                  Continue as Organizer <Icon name="arrow" size={17} />
                </Button>
              </article>}
            </div>
          </div>
        </section>

        <section className="section container">
          <SectionHeading
            eyebrow="Curated for you"
            title="Featured events"
            text="Published events happening across campus."
            action={
              <Button variant="ghost" onClick={() => go("explore")}>
                View all events <Icon name="arrow" size={17} />
              </Button>
            }
          />
          <div className="event-grid">
            {eventsError && <p className="error-text" role="alert">{eventsError}</p>}
            {eventsLoading && <p role="status">Loading published events and availability…</p>}
            {eventList.slice(0, 3).map((event) => (
              <EventCard
                event={event}
                key={event.id}
                go={go}
                selectEvent={selectEvent}
                saved={saved}
                toggleSave={toggleSave}
              />
            ))}
            {!eventsLoading && !eventsError && !eventList.length && (
              <p className="empty-events">No published events yet. Check back soon.</p>
            )}
          </div>
        </section>

        <section className="section soft-section" id="categories">
          <div className="container">
            <SectionHeading
              eyebrow="Find your space"
              title="Explore by category"
              text="Whatever inspires you, there’s an event waiting."
            />
            <div className="category-grid">
              {categories.map(([icon, name]) => (
                <button
                  className="category-card"
                  key={name}
                  onClick={() => go("explore")}
                >
                  <span className="category-icon">{icon}</span>
                  <span>
                    <strong>{name}</strong>
                    <small>Explore events</small>
                  </span>
                  <Icon name="arrow" size={18} />
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="section container">
          <div className="split-heading">
            <div>
              <span className="eyebrow">Coming soon</span>
              <h2>Don’t miss what’s next</h2>
            </div>
            <div className="filter-pills">
              {["All", "This week", "This month", "Free"].map(
                (filter, index) => (
                  <button className={index === 0 ? "active" : ""} key={filter}>
                    {filter}
                  </button>
                ),
              )}
            </div>
          </div>
          <div className="upcoming-list">
            {eventsError && <p className="error-text" role="alert">{eventsError}</p>}
            {eventList.slice(3, 6).map((event) => (
              <article
                key={event.id}
                onClick={() => {
                  selectEvent(event.id)
                  go("details")
                }}
              >
                <div className="date-block">
                  <strong>{event.date.match(/\d+/)?.[0]}</strong>
                  <span>{event.date.split(" ")[0].slice(0, 3)}</span>
                </div>
                <EventImage src={event.image} alt="" />
                <div className="upcoming-info">
                  <span>{event.category}</span>
                  <h3>{event.title}</h3>
                  <p>
                    <Icon name="clock" size={16} /> {event.time} <b>·</b>{" "}
                    <Icon name="pin" size={16} /> {event.location}
                  </p>
                </div>
                <strong className="upcoming-price">{event.price}</strong>
                <span className="round-arrow">
                  <Icon name="arrow" />
                </span>
              </article>
            ))}
            {!eventsLoading && !eventsError && eventList.length <= 3 && (
              <p className="empty-events">
                {eventList.length
                  ? "More published events will appear here."
                  : "No published events yet. Check back soon."}
              </p>
            )}
          </div>
        </section>

        <section className="section why-section">
          <div className="container">
            <SectionHeading
              eyebrow="Built for better events"
              title="Why choose Eventify?"
              text="Everything you need to discover, join, and remember campus experiences."
            />
            <div className="feature-grid">
              {[
                [
                  "ticket",
                  "Easy online registration",
                  "Reserve your place in seconds with a simple, guided process.",
                ],
                [
                  "search",
                  "Discover exciting events",
                  "Explore experiences tailored to your interests and campus.",
                ],
                [
                  "calendar",
                  "Manage your bookings",
                  "Keep every ticket, update, and event detail in one place.",
                ],
                [
                  "bell",
                  "Receive event updates",
                  "Get timely reminders and never miss an important change.",
                ],
              ].map(([icon, title, text], index) => (
                <article className="feature-card" key={title}>
                  <span className={`feature-icon tone-${index + 1}`}>
                    <Icon name={icon} />
                  </span>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {!isParticipant && <section className="container cta-section">
          <div>
            <span className="eyebrow light">For campus organizers</span>
            <h2>Have an idea worth gathering for?</h2>
            <p>
              Create your event, reach the right audience, and manage
              registrations effortlessly.
            </p>
          </div>
          <Button variant="dark" onClick={() => go("organizer")}>
            {isOrganizer ? "Organizer Dashboard" : "Start creating"} <Icon name="arrow" size={18} />
          </Button>
        </section>}
      </main>
      <Footer go={go} />
    </>
  )
}

function Explore({
  go,
  eventList,
  selectEvent,
  saved,
  toggleSave,
  eventsLoading,
  eventsError,
}: {
  go: (page: Page) => void
  eventList: EventItem[]
  selectEvent: (id: EventItem["id"]) => void
  saved: EventItem["id"][]
  toggleSave: (id: EventItem["id"]) => void
  eventsLoading: boolean
  eventsError: string
}) {
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState("All")
  const [view, setView] = useState<"grid" | "list">("grid")
  const [loading, setLoading] = useState(false)
  const filtered = useMemo(
    () =>
      eventList.filter(
        (event) =>
          (category === "All" || event.category === category) &&
          event.title.toLowerCase().includes(query.toLowerCase()),
      ),
    [query, category, eventList],
  )
  const applyFilters = () => {
    setLoading(true)
    setTimeout(() => setLoading(false), 700)
  }
  return (
    <main className="page-main">
      <section className="page-hero">
        <div className="container">
          <span className="eyebrow">Find your next experience</span>
          <h1>Explore events</h1>
          <p>
            From inspiring talks to unforgettable festivals—find where you
            belong.
          </p>
          <div className="wide-search">
            <Icon name="search" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search events, categories, or venues"
            />
            <Button onClick={applyFilters}>Search events</Button>
          </div>
        </div>
      </section>
      <section className="container discovery-layout">
        <aside className="filters">
          <div className="filter-title">
            <h3>Filters</h3>
            <button
              onClick={() => {
                setCategory("All")
                setQuery("")
              }}
            >
              Clear all
            </button>
          </div>
          <FilterGroup title="Category">
            {[
              "All",
              "Technology",
              "Hackathon",
              "Workshop",
              "Cultural",
              "Business",
            ].map((item) => (
              <label className="check-row" key={item}>
                <input
                  type="radio"
                  name="category"
                  checked={category === item}
                  onChange={() => setCategory(item)}
                />
                <span>{item}</span>
              </label>
            ))}
          </FilterGroup>
          <FilterGroup title="Date">
            <select>
              <option>Any date</option>
              <option>Today</option>
              <option>This week</option>
              <option>This month</option>
            </select>
          </FilterGroup>
          <FilterGroup title="Location">
            <label className="field-inline">
              <Icon name="pin" size={17} />
              <input placeholder="City or campus" />
            </label>
          </FilterGroup>
          <FilterGroup title="Price">
            {["Free events", "Paid events"].map((item) => (
              <label className="check-row" key={item}>
                <input type="checkbox" />
                <span>{item}</span>
              </label>
            ))}
          </FilterGroup>
          <Button className="full-width" onClick={applyFilters}>
            Apply filters
          </Button>
        </aside>
        <div className="results">
          <div className="results-bar">
            <div>
              <h2>{filtered.length} events found</h2>
              <p>Showing the best experiences for you</p>
            </div>
            <div className="results-controls">
              <select>
                <option>Sort: Most popular</option>
                <option>Date: Soonest</option>
                <option>Price: Low to high</option>
              </select>
              <div className="view-toggle">
                <button
                  className={view === "grid" ? "active" : ""}
                  onClick={() => setView("grid")}
                >
                  <Icon name="grid" size={18} />
                </button>
                <button
                  className={view === "list" ? "active" : ""}
                  onClick={() => setView("list")}
                >
                  <Icon name="list" size={19} />
                </button>
              </div>
            </div>
          </div>
          {eventsError ? (
            <div className="error-text" role="alert">{eventsError}</div>
          ) : loading || eventsLoading ? (
            <div className="skeleton-grid">
              {[1, 2, 3, 4].map((i) => (
                <div className="skeleton" key={i}>
                  <span />
                  <i />
                  <i />
                  <b />
                </div>
              ))}
            </div>
          ) : filtered.length ? (
            <div
              className={view === "grid" ? "event-grid two-col" : "event-list"}
            >
              {filtered.map((event) => (
                <EventCard
                  event={event}
                  key={event.id}
                  go={go}
                  selectEvent={selectEvent}
                  saved={saved}
                  toggleSave={toggleSave}
                  compact={view === "list"}
                />
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <span>
                <Icon name="search" size={32} />
              </span>
              <h3>No events found</h3>
              <p>Try adjusting your search or clearing a few filters.</p>
              <Button
                onClick={() => {
                  setQuery("")
                  setCategory("All")
                }}
              >
                Clear filters
              </Button>
            </div>
          )}
          <div className="pagination">
            <button disabled>‹</button>
            <button className="active">1</button>
            <button>2</button>
            <button>3</button>
            <button>›</button>
          </div>
        </div>
      </section>
    </main>
  )
}

function FilterGroup({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <div className="filter-group">
      <h4>{title}</h4>
      {children}
    </div>
  )
}

function Details({
  go,
  eventList,
  event,
  participantRegistration,
  registrationLoading,
  registrationError,
  selectEvent,
  saved,
  toggleSave,
}: {
  go: (page: Page) => void
  eventList: EventItem[]
  event: EventItem
  participantRegistration?: RegistrationRecord
  registrationLoading: boolean
  registrationError: string
  selectEvent: (id: EventItem["id"]) => void
  saved: EventItem["id"][]
  toggleSave: (id: EventItem["id"]) => void
}) {
  const registeredCount = event.registeredCount ?? 0
  const availableSeats = Math.max(0, event.seats - registeredCount)
  const fullyBooked = availableSeats === 0
  const [eventPeople, setEventPeople] = useState<EventPerson[]>([])
  const [peopleLoading, setPeopleLoading] = useState(true)
  const [peopleError, setPeopleError] = useState("")
  const [peopleLiveError, setPeopleLiveError] = useState("")
  const eventId = String(event.id)
  useEffect(() => {
    let active = true
    const loadPeople = async () => {
      try {
        const people = await fetchEventPeople(eventId)
        if (active) {
          setEventPeople(people)
          setPeopleError("")
        }
      } catch (error) {
        if (!active) return
        const message = error instanceof Error
          ? error.message
          : "Could not load event mentors and speakers."
        setPeopleError(message)
      } finally {
        if (active) setPeopleLoading(false)
      }
    }
    setEventPeople([])
    setPeopleLoading(true)
    setPeopleError("")
    setPeopleLiveError("")
    const channel = supabase
      .channel(`event-people:${eventId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "event_people",
        },
        () => { void loadPeople() },
      )
      .subscribe((status) => {
        if (!active) return
        if (status === "SUBSCRIBED") {
          setPeopleLiveError("")
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setPeopleLiveError("Live mentor and speaker updates are unavailable. Reload the page to try again.")
        }
      })
    void loadPeople()
    return () => {
      active = false
      void supabase.removeChannel(channel)
    }
  }, [eventId])
  return (
    <main className="page-main detail-page">
      <div className="container breadcrumbs">
        <button onClick={() => go("home")}>Home</button>
        <span>/</span>
        <button onClick={() => go("explore")}>Events</button>
        <span>/</span>
        <strong>{event.title}</strong>
      </div>
      <section className="container cover">
        <EventImage src={event.image} alt={`${event.title} event`} />
        <div className="cover-overlay">
          <span className="category-badge">{event.category}</span>
          <span className="cover-status">
            <i /> {fullyBooked ? "Fully booked" : "Registration open"}
          </span>
        </div>
      </section>
      <section className="container details-grid">
        <div className="details-main">
          <div className="detail-heading">
            <div>
              <span className="eyebrow">{event.category} event</span>
              <h1>{event.title}</h1>
              <p>{event.description || "Join this campus event and connect with your community."}</p>
            </div>
            <div className="share-actions">
              <button
                onClick={() => toggleSave(event.id)}
                className={saved.includes(event.id) ? "saved" : ""}
              >
                <Icon name="heart" />
              </button>
              <button>
                <Icon name="share" />
              </button>
            </div>
          </div>
          <div className="detail-facts">
            <Fact icon="calendar" label="Date" value={event.date} />
            <Fact icon="clock" label="Time" value={event.time} />
            <Fact icon="pin" label="Venue" value={event.location} />
          </div>
          <DetailSection title="About this event">
            <p>
              {event.description || `${event.title} brings the campus community together for a memorable ${event.category.toLowerCase()} experience.`}
            </p>
            <p>
              Register to reserve your place and receive updates from the organizer.
            </p>
          </DetailSection>
          <DetailSection title="Event agenda">
            <div className="timeline">
              {[
                [
                  "09:00 AM",
                  "Opening & team formation",
                  "Welcome address, challenge reveal, and team matching.",
                ],
                [
                  "11:00 AM",
                  "Building begins",
                  "Mentor rooms and technical support open.",
                ],
                [
                  "07:00 PM",
                  "Founder fireside chat",
                  "Ideas, resilience, and building for real users.",
                ],
                [
                  "Next day · 03:00 PM",
                  "Final demos & awards",
                  "Top teams pitch to our judging panel.",
                ],
              ].map(([time, title, text], index) => (
                <div key={title}>
                  <span>{index + 1}</span>
                  <time>{time}</time>
                  <div>
                    <h4>{title}</h4>
                    <p>{text}</p>
                  </div>
                </div>
              ))}
            </div>
          </DetailSection>
          {peopleLoading && <p className="detail-people-state" role="status">Loading mentors and speakers…</p>}
          {peopleError && <p className="error-text" role="alert">{peopleError}</p>}
          {peopleLiveError && <p className="detail-people-state" role="status">{peopleLiveError}</p>}
          {!peopleLoading && !peopleError && (["mentor", "speaker"] as const).map((role) => {
            const people = eventPeople.filter((person) => person.role === role)
            if (!people.length) return null
            return (
              <DetailSection
                title={role === "mentor" ? "Mentors" : "Speakers"}
                key={role}
              >
                <div className="event-people-grid">
                  {people.map((person) => (
                    <article key={person.id || person.clientId}>
                      <h3>{person.name}</h3>
                      {person.designation && <span>{person.designation}</span>}
                      {person.bio && <p>{person.bio}</p>}
                    </article>
                  ))}
                </div>
              </DetailSection>
            )
          })}
          <DetailSection title="Eligibility & contact">
            <ul className="check-list">
              <li>
                <Icon name="check" size={17} /> Open to all currently enrolled
                college students
              </li>
              <li>
                <Icon name="check" size={17} /> Teams of 2–4 participants
              </li>
              <li>
                <Icon name="check" size={17} /> Bring a valid student ID and
                your laptop
              </li>
            </ul>
            <div className="contact-line">
              <strong>Need help?</strong>
              <span>codestorm@eventify.edu</span>
              <span>+91 98765 43210</span>
            </div>
          </DetailSection>
          <DetailSection title="Related events">
            <div className="related-grid">
              {eventList.filter((item) => item.id !== event.id).slice(0, 2).map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    selectEvent(item.id)
                    go("details")
                  }}
                >
                  <EventImage src={item.image} alt="" />
                  <span>
                    <small>{item.category}</small>
                    <strong>{item.title}</strong>
                    <em>{item.date}</em>
                  </span>
                </button>
              ))}
            </div>
          </DetailSection>
        </div>
        <aside className="ticket-card">
          <span className="ticket-label">Participation</span>
          <div className="ticket-price">
            <strong>{event.price}</strong>
            <span>
              {event.price === "Free" ? "for verified students" : "set by organizer"}
            </span>
          </div>
          <div className="capacity">
            <div>
              <span>
                <Icon name="users" size={17} /> {registeredCount} of {event.seats} seats filled · {availableSeats} remaining
              </span>
              <b>{event.seats ? Math.min(100, Math.round((registeredCount / event.seats) * 100)) : 0}% filled</b>
            </div>
            <div className="progress">
              <span style={{ width: `${event.seats ? Math.min(100, (registeredCount / event.seats) * 100) : 0}%` }} />
            </div>
          </div>
          <div className="ticket-row">
            <span>Registration deadline</span>
            <strong>{event.registrationDeadline || "Not specified"}</strong>
          </div>
          <div className="ticket-row">
            <span>Team size</span>
            <strong>2–4 members</strong>
          </div>
          <div className="ticket-row">
            <span>Organizer</span>
            <strong>Campus Tech Society</strong>
          </div>
          <Button
            className="full-width large-btn"
            onClick={() => go("register")}
            disabled={
              Boolean(participantRegistration) ||
              fullyBooked ||
              registrationDeadlinePassed(event.registrationDeadline)
            }
          >
            {registrationLoading && !participantRegistration
              ? "Checking registration…"
              : participantRegistration
                ? "Already registered"
                : fullyBooked
              ? "Fully Booked"
              : registrationDeadlinePassed(event.registrationDeadline)
                ? "Registration closed"
                : <>Register now <Icon name="arrow" size={18} /></>}
          </Button>
          {registrationError && <p className="error-text" role="alert">{registrationError}</p>}
          {participantRegistration && (
            <p className="registration-status-message" role="status">
              {registrationStatusMessage(participantRegistration.status)}
            </p>
          )}
          <p className="secure-note">
            <Icon name="check" size={15} /> Free participation · Organizer approval required
          </p>
          <button className="share-link">
            <Icon name="share" size={17} /> Share this event
          </button>
        </aside>
      </section>
    </main>
  )
}

function Fact({
  icon,
  label,
  value,
}: {
  icon: string
  label: string
  value: string
}) {
  return (
    <div>
      <span>
        <Icon name={icon} />
      </span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </div>
  )
}

function DetailSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="detail-section">
      <h2>{title}</h2>
      {children}
    </section>
  )
}

function RoleLoginCard({
  role,
  go,
  onSignIn,
  onResendVerification,
  verificationIssue,
}: {
  role: UserRole
  go: (page: Page) => void
  onSignIn: (email: string, password: string, role: UserRole) => Promise<void>
  onResendVerification: (email: string) => Promise<void>
  verificationIssue: boolean
}) {
  const [show, setShow] = useState(false)
  const [resetSent, setResetSent] = useState(false)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [verificationNeeded, setVerificationNeeded] = useState(verificationIssue)
  const [resending, setResending] = useState(false)
  const [resendCooldown, setResendCooldown] = useState(0)
  const [resendMessage, setResendMessage] = useState("")
  const organizer = role === "organizer"
  useEffect(() => {
    if (resendCooldown <= 0) return
    const timer = window.setTimeout(
      () => setResendCooldown((remaining) => remaining - 1),
      1000,
    )
    return () => window.clearTimeout(timer)
  }, [resendCooldown])
  useEffect(() => {
    if (verificationIssue) setVerificationNeeded(true)
  }, [verificationIssue])
  return (
    <section className={`role-login-card ${role}`}>
      <span className="role-card-icon">
        <Icon name={organizer ? "calendar" : "users"} />
      </span>
      <span className="eyebrow">
        {organizer ? "Host experiences" : "Join experiences"}
      </span>
      <h2>
        {organizer ? "Are you an Event Organizer?" : "Are you a Participant?"}
      </h2>
      <p>
        {organizer
          ? "Create events, manage registrations, verify participant details, and approve or reject entries."
          : "Explore events, register for your favorite events, and track your registration and approval status."}
      </p>
      {resetSent && (
        <div className="form-success">
          <Icon name="check" size={17} /> Password reset instructions sent.
        </div>
      )}
      <form
        onSubmit={async (event) => {
          event.preventDefault()
          if (loading) return
          setLoading(true)
          setError("")
          try {
            await onSignIn(email, password, role)
          } catch (signInError) {
            const message = signInError instanceof Error ? signInError.message : "Unable to sign in."
            setError(message)
            if (/email[_ ]not[_ ]confirmed/i.test(message)) {
              setVerificationNeeded(true)
              setError("Please verify your email before signing in. You can request a new verification email below.")
            }
          } finally {
            setLoading(false)
          }
        }}
      >
        <FormField
          label="Email address"
          placeholder={organizer ? "organizer@college.edu" : "you@college.edu"}
          type="email"
          value={email}
          onChange={setEmail}
          required
        />
        {verificationNeeded && (
          <div className="verification-resend">
            {resendMessage && <div className="form-success" role="status">{resendMessage}</div>}
            <Button
              type="button"
              variant="secondary"
              disabled={resending || resendCooldown > 0}
              onClick={async () => {
                setResending(true)
                setResendMessage("")
                setError("")
                setResendCooldown(verificationResendCooldownSeconds)
                try {
                  await onResendVerification(email)
                  setResendMessage(`If ${email.trim()} has an unverified account, Supabase accepted a new verification email request. Check your inbox and spam folder.`)
                } catch (resendError) {
                  setError(resendError instanceof Error ? resendError.message : "Unable to request a verification email.")
                } finally {
                  setResending(false)
                }
              }}
            >
              {resending
                ? "Requesting email…"
                : resendCooldown > 0
                  ? `Resend available in ${resendCooldown}s`
                  : "Resend Verification Email"}
            </Button>
          </div>
        )}
        <div className="form-field">
          <label>Password</label>
          <div className="password-field">
            <input
              type={show ? "text" : "password"}
              placeholder="Enter your password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            <button type="button" onClick={() => setShow(!show)}>
              {show ? "Hide" : "Show"}
            </button>
          </div>
        </div>
        {error && <div className="error-text" role="alert">{error}</div>}
        <div className="form-options role-options">
          <label className="check-row">
            <input type="checkbox" />
            <span>Remember me</span>
          </label>
          <button type="button" onClick={() => setResetSent(true)}>
            Forgot password?
          </button>
        </div>
        <Button
          type="submit"
          className="full-width auth-submit"
          variant={organizer ? "primary" : "dark"}
          disabled={loading}
        >
          {loading ? "Signing in…" : organizer ? "Organizer Login" : "Participant Login"}{" "}
          <Icon name="arrow" size={17} />
        </Button>
      </form>
      <div className="auth-switch">
        New to Eventify?{" "}
        <button
          onClick={() =>
            go(organizer ? "organizer-signup" : "participant-signup")
          }
        >
          {organizer ? "Request Organizer Access" : "Create Participant Account"}
        </button>
      </div>
    </section>
  )
}

function RoleGateway({
  go,
  onSignIn,
  onResendVerification,
  selectedRole,
  error,
  verificationIssue = false,
}: {
  go: (page: Page) => void
  onSignIn: (email: string, password: string, role: UserRole) => Promise<void>
  onResendVerification: (email: string) => Promise<void>
  selectedRole?: UserRole
  error?: string
  verificationIssue?: boolean
}) {
  return (
    <main className="role-gateway">
      <header className="role-gateway-header">
        <Logo go={() => go("login")} />
        <button onClick={() => go(selectedRole ? "login" : "home")}>
          {selectedRole ? "Choose another role" : "Explore Eventify"}{" "}
          <Icon name="arrow" size={16} />
        </button>
      </header>
      <div className="role-gateway-intro">
        <span className="eyebrow light">Welcome to Eventify</span>
        <h1>
          {selectedRole
            ? `Continue as ${selectedRole === "organizer" ? "an" : "a"} ${selectedRole}.`
            : "One platform. Two ways to create memorable experiences."}
        </h1>
        <p>
          {selectedRole
            ? "Sign in or create an account to continue to your dedicated workspace."
            : "Choose how you use Eventify and continue to your dedicated workspace."}
        </p>
      </div>
      {error && <div className="error-text" role="alert">{error}</div>}
      <div className={selectedRole ? "role-login-grid single" : "role-login-grid"}>
        {(selectedRole ? [selectedRole] : ["organizer", "participant"] as UserRole[]).map(
          (role) => (
            <RoleLoginCard
              key={role}
              role={role}
              go={go}
              onSignIn={onSignIn}
              onResendVerification={onResendVerification}
              verificationIssue={verificationIssue}
            />
          ),
        )}
      </div>
      <p className="role-security-note">
        <Icon name="check" size={15} /> Role permissions must be validated by
        the application server in production.
      </p>
    </main>
  )
}

function AuthPage({
  mode,
  go,
  onAuthenticate,
  onResendVerification,
  role = "participant",
}: {
  mode: "login" | "signup"
  go: (page: Page) => void
  onAuthenticate: (
    email: string,
    password: string,
    details: ProfileDetails,
    role: UserRole,
    mode: "login" | "signup",
  ) => Promise<AuthenticationResult>
  onResendVerification: (email: string) => Promise<void>
  role?: UserRole
}) {
  const isLogin = mode === "login"
  const organizer = role === "organizer"
  const [submitted, setSubmitted] = useState(false)
  const [show, setShow] = useState(false)
  const [fullName, setFullName] = useState("")
  const [email, setEmail] = useState("")
  const [phone, setPhone] = useState("")
  const [organization, setOrganization] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [successMessage, setSuccessMessage] = useState("")
  const [verificationEmail, setVerificationEmail] = useState("")
  const [resending, setResending] = useState(false)
  const [resendCooldown, setResendCooldown] = useState(0)
  useEffect(() => {
    if (resendCooldown <= 0) return
    const timer = window.setTimeout(
      () => setResendCooldown((remaining) => remaining - 1),
      1000,
    )
    return () => window.clearTimeout(timer)
  }, [resendCooldown])
  const invalidEmail = submitted && !email.includes("@")
  const mismatch = submitted && !isLogin && password !== confirm
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
    if (loading) return
    if (
      email.includes("@") &&
      password.length >= 6 &&
      (isLogin || password === confirm)
    ) {
      setLoading(true)
      setError("")
      setSuccessMessage("")
      setVerificationEmail("")
      setResendCooldown(0)
      try {
        const result = await onAuthenticate(
          email,
          password,
          { fullName, phone, organization },
          role,
          mode,
        )
        if (result.status === "confirmation" || result.status === "organizer-confirmation") {
          setVerificationEmail(result.email)
          setResendCooldown(verificationResendCooldownSeconds)
          setSuccessMessage(result.accountAlreadyExists
            ? `An account may already exist for ${result.email}. Try signing in, or request a new verification email if it is not verified.`
            : result.status === "organizer-confirmation"
              ? `Your organizer application is pending approval. Eventify requested email verification for ${result.email}. Verify your email before signing in.`
              : `Account request received. Eventify requested email verification for ${result.email}. Verify your email before signing in.`)
        }
      } catch (authError) {
        setError(authError instanceof Error ? authError.message : "Unable to complete authentication.")
      } finally {
        setLoading(false)
      }
    }
  }
  return (
    <main className="auth-page">
      <div className="auth-brand">
        <Logo go={go} />
        <div className="auth-message">
          <span className="eyebrow light">Experiences begin here</span>
          <h1>
            {isLogin
              ? "Welcome back to your campus community."
              : "Your next great experience is one click away."}
          </h1>
          <p>
            Discover, register, and keep every memorable campus moment in one
            beautiful place.
          </p>
        </div>
        <div className="auth-event">
          <img src={photos.music} alt="" />
          <div>
            <small>Trending this week</small>
            <strong>Euphoria Cultural Night</strong>
            <span>1,248 students interested</span>
          </div>
        </div>
      </div>
      <div className="auth-form-wrap">
        <div className="auth-form">
          <button className="back-link" onClick={() => go("login")}>
            ← Back to role login
          </button>
          <span className="eyebrow">
            {isLogin ? "Welcome back" : "Join Eventify"}
          </span>
          <h2>{isLogin ? "Log in to your account" : "Create your account"}</h2>
          <p>
            {isLogin
              ? "Enter your details to access your events."
              : "Start discovering incredible campus events today."}
          </p>
          {successMessage && (
            <div className="form-success" role="status">
              <Icon name="check" size={18} /> {successMessage}
            </div>
          )}
          {verificationEmail && (
            <div className="verification-resend">
              <p>
                Check {verificationEmail}, including the spam or Promotions
                folder. The email provider confirms when it accepts a message,
                not whether it reaches your inbox.
              </p>
              <Button
                type="button"
                variant="secondary"
                disabled={resending || resendCooldown > 0}
                onClick={async () => {
                  setResending(true)
                  setError("")
                  setResendCooldown(verificationResendCooldownSeconds)
                  try {
                    await onResendVerification(verificationEmail)
                    setSuccessMessage(`If ${verificationEmail} has an unverified account, Supabase accepted a new verification email request. Check your inbox, spam, or Promotions folder.`)
                  } catch (resendError) {
                    setError(resendError instanceof Error ? resendError.message : "Unable to request a verification email.")
                  } finally {
                    setResending(false)
                  }
                }}
              >
                {resending
                  ? "Requesting email…"
                  : resendCooldown > 0
                    ? `Resend available in ${resendCooldown}s`
                    : "Resend Verification Email"}
              </Button>
            </div>
          )}
          {error && <div className="error-text" role="alert">{error}</div>}
          <form onSubmit={submit}>
            {!isLogin && (
              <FormField
                label="Full name"
                placeholder="Enter your full name"
                value={fullName}
                onChange={setFullName}
                required
              />
            )}
            {!isLogin && organizer && (
              <FormField
                label="College or organization name"
                placeholder="Your institution or organization"
                value={organization}
                onChange={setOrganization}
                required
              />
            )}
            <FormField
              label="Email address"
              placeholder="you@college.edu"
              type="email"
              value={email}
              onChange={setEmail}
              error={
                invalidEmail
                  ? "Enter a valid college email address."
                  : undefined
              }
              required
            />
            {!isLogin && (
              <FormField
                label="Phone number"
                placeholder="+91 98765 43210"
                value={phone}
                onChange={setPhone}
                required
              />
            )}
            {!isLogin && !organizer && (
              <FormField
                label="College or organization name"
                placeholder="Your institution or organization"
                value={organization}
                onChange={setOrganization}
                required
              />
            )}
            <div className="form-field">
              <label>Password</label>
              <div className="password-field">
                <input
                  type={show ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimum 6 characters"
                  required
                />
                <button type="button" onClick={() => setShow(!show)}>
                  {show ? "Hide" : "Show"}
                </button>
              </div>
              {submitted && password.length < 6 && (
                <span className="error-text">
                  Password must be at least 6 characters.
                </span>
              )}
            </div>
            {!isLogin && (
              <FormField
                label="Confirm password"
                placeholder="Re-enter your password"
                type="password"
                value={confirm}
                onChange={setConfirm}
                error={mismatch ? "Passwords do not match." : undefined}
                required
              />
            )}
            {isLogin && (
              <div className="form-options">
                <label className="check-row">
                  <input type="checkbox" />
                  <span>Remember me</span>
                </label>
                <button
                  type="button"
                  onClick={() =>
                    alert("Password reset link sent. Check your inbox.")
                  }
                >
                  Forgot password?
                </button>
              </div>
            )}
            <Button type="submit" className="full-width auth-submit" disabled={loading}>
              {isLogin
                ? loading ? "Logging in…" : "Log in"
                : loading ? "Creating account…" : "Create Participant Account"}{" "}
              <Icon name="arrow" size={17} />
            </Button>
          </form>
          <div className="auth-switch">
            {isLogin ? "Don't have an account?" : "Already have an account?"}{" "}
            <button onClick={() => go("login")}>
              {isLogin ? "Sign up" : "Return to role login"}
            </button>
          </div>
          <p className="legal-copy">
            By continuing, you agree to our Terms of Service and Privacy Policy.
          </p>
        </div>
      </div>
    </main>
  )
}

function FormField({
  label,
  placeholder,
  type = "text",
  value,
  onChange,
  error,
  required,
  min,
}: {
  label: string
  placeholder?: string
  type?: string
  value?: string
  onChange?: (value: string) => void
  error?: string
  required?: boolean
  min?: number
}) {
  return (
    <div className={error ? "form-field has-error" : "form-field"}>
      <label>
        {label}
        {required && <span>*</span>}
      </label>
      <input
        type={type}
        placeholder={placeholder}
        value={value}
        required={required}
        min={min}
        onChange={(e) => onChange?.(e.target.value)}
      />
      {error && <span className="error-text">{error}</span>}
    </div>
  )
}

function Stepper({ step }: { step: number }) {
  return (
    <div className="stepper">
      {["Your details", "Review", "Confirmed"].map((label, index) => (
        <div className={index + 1 <= step ? "active" : ""} key={label}>
          <span>
            {index + 1 < step ? <Icon name="check" size={15} /> : index + 1}
          </span>
          <strong>{label}</strong>
          {index < 2 && <i />}
        </div>
      ))}
    </div>
  )
}

type RegistrationDraft = { name: string; email: string; phone: string; college: string; studentId: string; teamSize: string; role: string; idea: string }

function Registration({
  page,
  go,
  event,
  onSubmit,
  latestRegistrationId,
  registrationError,
}: {
  page: "register" | "review" | "confirmation"
  go: (page: Page) => void
  event: EventItem
  onSubmit: (draft: RegistrationDraft, event: EventItem) => Promise<string>
  latestRegistrationId: string
  registrationError?: string
}) {
  const [draft, setDraft] = useState<RegistrationDraft>({ name: "", email: "", phone: "", college: "", studentId: "", teamSize: "1", role: "", idea: "" })
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState("")
  const step = page === "register" ? 1 : page === "review" ? 2 : 3
  if (page === "confirmation") {
    return (
      <main className="registration-page">
        <div className="container narrow-container">
          <Stepper step={step} />
          <section className="confirmation-card">
            <span className="success-icon">
              <Icon name="check" size={34} />
            </span>
            <span className="eyebrow">Registration submitted</span>
            <h1>Your request is under review.</h1>
            <p>
              Your {event.title} registration was sent to the organizer for
              verification and approval. We’ll notify you when its status
              changes.
            </p>
            <div className="registration-id">
              <span>Registration ID</span>
              <strong>{latestRegistrationId || "Pending"}</strong>
              <button
                onClick={() => navigator.clipboard?.writeText(latestRegistrationId)}
              >
                Copy
              </button>
            </div>
            <div className="confirmation-event">
              <EventImage src={event.image} alt="" />
              <div>
                <span className="status-badge warning">Pending Review</span>
                <h3>{event.title}</h3>
                <p>
                  <Icon name="calendar" size={16} /> {event.date} · {event.time}
                </p>
                <p>
                  <Icon name="pin" size={16} /> {event.location}
                </p>
              </div>
            </div>
            <div className="participant-summary">
              <div>
                <span>Participant</span>
                <strong>{draft.name || "Participant"}</strong>
              </div>
              <div>
                <span>Ticket type</span>
                <strong>Student · {event.price}</strong>
              </div>
              <div>
                <span>Approval status</span>
                <strong>Pending organizer review</strong>
              </div>
            </div>
            <div className="confirmation-actions">
              <Button onClick={() => go("dashboard")}>
                <Icon name="clock" size={18} /> View approval status
              </Button>
              <Button variant="secondary" onClick={() => go("dashboard")}>
                My registrations
              </Button>
              <Button variant="ghost" onClick={() => go("home")}>
                Return home
              </Button>
            </div>
          </section>
        </div>
      </main>
    )
  }
  if (page === "review") {
    return (
      <main className="registration-page">
        <div className="container narrow-container">
          <Stepper step={step} />
          <div className="registration-heading">
            <span className="eyebrow">Almost there</span>
            <h1>Review your registration</h1>
            <p>Make sure everything looks right before confirming your spot.</p>
          </div>
          <section className="review-card">
            <div className="review-event">
              <EventImage src={event.image} alt="" />
              <div>
                <span>Registering for</span>
                <h3>{event.title}</h3>
                <p>{event.date} · {event.time}</p>
              </div>
            </div>
            <ReviewSection
              title="Participant details"
              edit={() => go("register")}
              rows={[
                ["Full name", draft.name],
                ["Email", draft.email],
                ["Phone", draft.phone],
                ["College", draft.college],
                ["Student ID", draft.studentId],
              ]}
            />
            <ReviewSection
              title="Ticket summary"
              rows={[
                ["Ticket type", "Student participant"],
                ["Team size", `${draft.teamSize} participant${draft.teamSize === "1" ? "" : "s"}`],
                [
                  "Participation",
                  event.price === "Free"
                    ? "No payment required"
                    : `Ticket price: ${event.price}`,
                ],
              ]}
            />
            <label className="terms-box">
              <input type="checkbox" defaultChecked />
              <span>
                I confirm that the details above are correct and agree to the
                event terms and code of conduct.
              </span>
            </label>
            <div className="review-actions">
              <Button variant="secondary" onClick={() => go("register")}>
                Edit details
              </Button>
              <Button
                onClick={async () => {
                  if (submitting) return
                  setSubmitting(true)
                  setSubmitError("")
                  try {
                    await onSubmit(draft, event)
                    go("confirmation")
                  } catch (error) {
                    setSubmitError(error instanceof Error ? error.message : "Could not submit registration.")
                  } finally {
                    setSubmitting(false)
                  }
                }}
                disabled={submitting}
              >
                {submitting ? "Submitting…" : "Submit for organizer approval"} <Icon name="arrow" size={18} />
              </Button>
            </div>
            {(submitError || registrationError) && <div className="error-text" role="alert">{submitError || registrationError}</div>}
          </section>
        </div>
      </main>
    )
  }
  return (
    <main className="registration-page">
      <div className="container registration-container">
        <Stepper step={step} />
        <div className="registration-heading">
          <span className="eyebrow">Secure your spot</span>
          <h1>Register for {event.title}</h1>
          <p>Tell us a little about yourself. It only takes a minute.</p>
        </div>
        <div className="registration-layout">
          <form
            className="registration-form"
            onSubmit={(e) => {
              e.preventDefault()
              go("review")
            }}
          >
            <div className="form-section">
              <div className="form-section-title">
                <span>01</span>
                <div>
                  <h3>Participant information</h3>
                  <p>Your contact and campus details.</p>
                </div>
              </div>
              <div className="form-grid">
                <FormField
                  label="Full name"
                  placeholder="Riya Sharma"
                  value={draft.name}
                  onChange={(value) => setDraft((current) => ({ ...current, name: value }))}
                  required
                />
                <FormField
                  label="Email address"
                  placeholder="riya.sharma@college.edu"
                  type="email"
                  value={draft.email}
                  onChange={(value) => setDraft((current) => ({ ...current, email: value }))}
                  required
                />
                <FormField
                  label="Phone number"
                  placeholder="+91 98765 43210"
                  value={draft.phone}
                  onChange={(value) => setDraft((current) => ({ ...current, phone: value }))}
                  required
                />
                <FormField
                  label="College / organization"
                  placeholder="Your institution"
                  value={draft.college}
                  onChange={(value) => setDraft((current) => ({ ...current, college: value }))}
                  required
                />
                <FormField
                  label="Student ID"
                  placeholder="e.g. NIT2024CS084"
                  value={draft.studentId}
                  onChange={(value) => setDraft((current) => ({ ...current, studentId: value }))}
                  required
                />
                <div className="form-field">
                  <label>
                    Number of participants<span>*</span>
                  </label>
                  <select value={draft.teamSize} onChange={(e) => setDraft((current) => ({ ...current, teamSize: e.target.value }))}>
                    <option>1</option>
                    <option>2</option>
                    <option>3</option>
                    <option>4</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="form-section">
              <div className="form-section-title">
                <span>02</span>
                <div>
                  <h3>A few more details</h3>
                  <p>Help organizers plan a better experience.</p>
                </div>
              </div>
              <div className="form-field">
                <label>Primary skill / role</label>
                <select value={draft.role} onChange={(e) => setDraft((current) => ({ ...current, role: e.target.value }))}>
                  <option value="" disabled>
                    Select your primary role
                  </option>
                  <option>Developer</option>
                  <option>Designer</option>
                  <option>Product / Business</option>
                  <option>Other</option>
                </select>
              </div>
              <div className="form-field">
                <label>What would you like to build?</label>
                <textarea placeholder="Share a short idea (optional)" value={draft.idea} onChange={(e) => setDraft((current) => ({ ...current, idea: e.target.value }))} />
              </div>
              <label className="terms-box">
                <input type="checkbox" required />
                <span>
                  I agree to the event terms, participation rules, and code of
                  conduct.
                </span>
              </label>
            </div>
            <div className="form-bottom">
              <Button variant="ghost" onClick={() => go("details")}>
                Cancel
              </Button>
              <Button type="submit">
                Continue to review <Icon name="arrow" size={18} />
              </Button>
            </div>
          </form>
          <aside className="registration-summary">
            <EventImage src={event.image} alt="" />
            <div className="summary-body">
              <span className="category-badge">{event.category}</span>
              <h3>{event.title}</h3>
              <p>
                <Icon name="calendar" size={17} /> {event.date}
              </p>
              <p>
                <Icon name="clock" size={17} /> {event.time}
              </p>
              <p>
                <Icon name="pin" size={17} /> {event.location}
              </p>
              <div className="summary-total">
                <span>Ticket price</span>
                <strong>{event.price}</strong>
              </div>
              <small>
                {event.price === "Free"
                  ? "Participation is free. Submit your details and wait for organizer approval."
                  : "Submit your details and wait for organizer approval. Payment is handled outside this demo."}
              </small>
            </div>
          </aside>
        </div>
      </div>
    </main>
  )
}

function ReviewSection({
  title,
  rows,
  edit,
}: {
  title: string
  rows: string[][]
  edit?: () => void
}) {
  return (
    <section className="review-section">
      <div className="review-title">
        <h3>{title}</h3>
        {edit && <button onClick={edit}>Edit</button>}
      </div>
      <div className="review-rows">
        {rows.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
    </section>
  )
}

const userNav = [
  ["dashboard", "grid", "Dashboard"],
  ["explore", "search", "Explore events"],
  ["registrations", "ticket", "My registrations"],
  ["pending", "clock", "Pending approvals"],
  ["approved", "check", "Approved registrations"],
  ["rejected", "close", "Rejected registrations"],
  ["tickets", "ticket", "My tickets"],
  ["profile", "settings", "Profile settings"],
]

function Dashboard({
  go,
  onLogout,
  initialTab = "dashboard",
  saved,
  toggleSave,
  registrations,
  profile,
  saveProfile,
  publishedEvents,
  eventsLoading,
  eventsError,
  registrationsLoading,
  registrationsError,
  onRegister,
}: {
  go: (page: Page) => void
  onLogout: () => void
  initialTab?: string
  saved: EventItem["id"][]
  toggleSave: (id: EventItem["id"]) => void
  registrations: RegistrationRecord[]
  profile: UserProfile | null
  saveProfile: (profile: UserProfile) => void
  publishedEvents: EventItem[]
  eventsLoading: boolean
  eventsError: string
  registrationsLoading: boolean
  registrationsError: string
  onRegister: (event: EventItem) => Promise<void>
}) {
  const [tab, setTab] = useState(initialTab)
  const [cancelOpen, setCancelOpen] = useState(false)
  useEffect(() => setTab(initialTab), [initialTab])
  return (
    <main className="dashboard-shell">
      <DashboardSidebar
        title="My Eventify"
        nav={userNav}
        active={tab}
        select={(id) => (id === "explore" ? go("explore") : setTab(id))}
        go={go}
        onLogout={onLogout}
        profile={profile}
      />
      <div className="dashboard-content">
        <DashboardTop
          title={
            tab === "dashboard"
              ? "Dashboard"
              : userNav.find((item) => item[0] === tab)?.[2] || ""
          }
          go={go}
          profile={profile}
        />
        <div className="dashboard-inner">
          {tab === "dashboard" && (
            <UserOverview
              go={go}
              openRegistrations={() => setTab("registrations")}
              publishedEvents={publishedEvents}
              registrations={registrations}
              eventsLoading={eventsLoading}
              eventsError={eventsError}
              registrationsLoading={registrationsLoading}
              registrationsError={registrationsError}
              onRegister={onRegister}
            />
          )}
          {tab === "registrations" && (
            <Registrations
              registrations={registrations}
              openCancel={() => setCancelOpen(true)}
              go={go}
              loading={registrationsLoading}
              error={registrationsError}
            />
          )}
          {["pending", "approved", "rejected", "tickets"].includes(tab) && (
            <Registrations
              registrations={registrations}
              filter={tab}
              openCancel={() => setCancelOpen(true)}
              go={go}
              loading={registrationsLoading}
              error={registrationsError}
            />
          )}
          {tab === "profile" && (
            <ProfileSettings profile={profile} onSave={saveProfile} />
          )}
        </div>
      </div>
      {cancelOpen && (
        <ConfirmModal
          title="Cancel registration?"
          text="Your place will be released and this action cannot be undone."
          confirm="Yes, cancel"
          close={() => setCancelOpen(false)}
        />
      )}
    </main>
  )
}

function DashboardSidebar({
  title,
  nav,
  active,
  select,
  go,
  onLogout,
  admin = false,
  profile = null,
}: {
  title: string
  nav: string[][]
  active: string
  select: (id: string) => void
  go: (page: Page) => void
  onLogout: () => void
  admin?: boolean
  profile?: UserProfile | null
}) {
  const organizerProfile = title === "Organizer studio"
  return (
    <aside
      className={
        admin ? "dashboard-sidebar admin-sidebar" : "dashboard-sidebar"
      }
    >
      <Logo go={go} />
      <div className="sidebar-label">{title}</div>
      <nav>
        {nav.map(([id, icon, label]) => (
          <button
            className={active === id ? "active" : ""}
            key={id}
            onClick={() => select(id)}
          >
            <Icon name={icon} size={19} /> {label}
          </button>
        ))}
      </nav>
      <button className="sidebar-logout" onClick={onLogout}>
        <Icon name="logout" size={19} /> Log out
      </button>
      <div className="sidebar-profile">
        <span>{profileInitials(profile)}</span>
        <div>
          <strong>{profile?.fullName || profile?.email || "Your account"}</strong>
          <small>{profile?.email || (organizerProfile ? "Organizer account" : "Participant account")}</small>
        </div>
      </div>
    </aside>
  )
}

function DashboardTop({
  title,
  go,
  profile = null,
}: {
  title: string
  go: (page: Page) => void
  profile?: UserProfile | null
}) {
  return (
    <header className="dashboard-top">
      <div>
        <h1>{title}</h1>
        <p>Sunday, March 29, 2026</p>
      </div>
      <div>
        <button className="icon-btn" onClick={() => go("notifications")}>
          <Icon name="bell" />
        </button>
        <span className="dash-avatar">{profileInitials(profile)}</span>
      </div>
    </header>
  )
}

function UserOverview({
  go,
  openRegistrations,
  publishedEvents,
  registrations,
  eventsLoading,
  eventsError,
  registrationsLoading,
  registrationsError,
  onRegister,
}: {
  go: (page: Page) => void
  openRegistrations: () => void
  publishedEvents: EventItem[]
  registrations: RegistrationRecord[]
  eventsLoading: boolean
  eventsError: string
  registrationsLoading: boolean
  registrationsError: string
  onRegister: (event: EventItem) => Promise<void>
}) {
  const [registeringEventId, setRegisteringEventId] = useState<string | number | null>(null)
  const [registerMessage, setRegisterMessage] = useState("")
  const [registerError, setRegisterError] = useState("")
  const registeredEventIds = new Set(registrations.map((item) => item.eventId))
  const register = async (event: EventItem) => {
    setRegisteringEventId(event.id)
    setRegisterMessage("")
    setRegisterError("")
    try {
      await onRegister(event)
      setRegisterMessage(`Registration submitted for ${event.title}.`)
    } catch (error) {
      setRegisterError(error instanceof Error ? error.message : "Could not register for this event.")
    } finally {
      setRegisteringEventId(null)
    }
  }
  return (
    <>
      <section className="welcome-banner">
        <div>
          <span className="eyebrow light">Your Eventify account</span>
          <h2>{registrations.length ? "Your event registrations are here." : "Discover your next campus event."}</h2>
          <p>{registrations.length ? `${registrations.filter((item) => item.status === "Pending").length} registration(s) pending review.` : "Register for a published event to track its status."}</p>
          <Button variant="dark" onClick={openRegistrations}>
            Track approval <Icon name="arrow" size={17} />
          </Button>
        </div>
        <div className="welcome-art">
          <span>{publishedEvents.length}</span>
          <small>published events</small>
        </div>
      </section>
      <div className="stat-grid">
        {[
          [String(registrations.length), "Total registrations", "Your registration history"],
          [String(registrations.filter((item) => item.status === "Pending").length), "Pending", "Awaiting organizer review"],
          [String(registrations.filter((item) => item.status === "Approved").length), "Approved", "Confirmed registrations"],
          [String(registrations.filter((item) => item.status === "Rejected").length), "Rejected", "Registration decisions"],
        ].map(([value, label, note], index) => (
          <article className="stat-card" key={label}>
            <span className={`stat-icon tone-${index + 1}`}>
              <Icon
                name={
                  index === 0
                    ? "ticket"
                    : index === 1
                      ? "calendar"
                      : index === 2
                        ? "check"
                        : "close"
                }
              />
            </span>
            <div>
              <strong>{value}</strong>
              <span>{label}</span>
              <small>{note}</small>
            </div>
          </article>
        ))}
      </div>
      <section className="dash-section">
        <div className="dash-section-title">
          <div>
            <h2>Published events</h2>
            <p>Explore events and register before the deadline.</p>
          </div>
          <button onClick={() => go("explore")}>
            Explore all <Icon name="arrow" size={16} />
          </button>
        </div>
        {(eventsError || registerError) && <div className="error-text" role="alert">{eventsError || registerError}</div>}
        {registerMessage && <div className="form-success" role="status">{registerMessage}</div>}
        {eventsLoading && <p>Loading published events…</p>}
        <div className="dash-event-list">
          {publishedEvents.map((event) => {
            const isPastDeadline = registrationDeadlinePassed(event.registrationDeadline)
            const availableSeats = Math.max(0, event.seats - (event.registeredCount ?? 0))
            return (
            <article key={event.id}>
              <EventImage src={event.image} alt="" />
              <div>
                <h3>{event.title}</h3>
                <p>{event.description}</p>
                <p>{event.location} · {event.date}</p>
                <p>
                  Registered: {event.registeredCount ?? 0} / {event.seats} ·
                  Available seats: {availableSeats}
                </p>
              </div>
              <Button
                variant="secondary"
                onClick={() => void register(event)}
                disabled={
                  registeringEventId !== null ||
                  registeredEventIds.has(String(event.id)) ||
                  isPastDeadline ||
                  availableSeats === 0
                }
              >
                {registeredEventIds.has(String(event.id))
                  ? "Registered"
                  : availableSeats === 0
                    ? "Fully Booked"
                  : isPastDeadline
                    ? "Registration closed"
                    : registeringEventId === event.id
                      ? "Registering…"
                      : "Register"}
              </Button>
            </article>
          )})}
          {!eventsLoading && !eventsError && publishedEvents.length === 0 && <p>No published events are available right now.</p>}
        </div>
      </section>
      <section className="dash-section">
        <div className="dash-section-title">
          <div>
            <h2>Registration history</h2>
            <p>Track your registration decisions.</p>
          </div>
          <button onClick={openRegistrations}>
            View all <Icon name="arrow" size={16} />
          </button>
        </div>
        {registrationsError && <div className="error-text" role="alert">{registrationsError}</div>}
        {registrationsLoading && <p>Loading registration history…</p>}
        {!registrationsLoading && registrations.length === 0 && <p>No registrations yet.</p>}
        {registrations.slice(0, 3).map((registration) => (
          <div className="dash-event-list" key={registration.id}>
            <article><div><h3>{registration.event}</h3><p>{registration.eventDate} · {registration.venue}</p></div><StatusBadge status={registration.status} /></article>
          </div>
        ))}
      </section>
    </>
  )
}

import { jsPDF } from "jspdf";

function downloadTicket(record: RegistrationRecord) {
  if (record.status !== "Approved") {
    alert("Your ticket is available only after registration approval.");
    return;
  }

  const pdf = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
  });

  // Background
  pdf.setFillColor(248, 250, 255);
  pdf.rect(0, 0, 210, 297, "F");

  // Ticket border
  pdf.setDrawColor(35, 85, 160);
  pdf.setLineWidth(1.2);
  pdf.roundedRect(12, 12, 186, 273, 5, 5);

  // Eventify header
  pdf.setFillColor(35, 85, 160);
  pdf.roundedRect(12, 12, 186, 42, 5, 5, "F");

  pdf.setTextColor(255, 255, 255);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(26);
  pdf.text("EVENTIFY", 105, 32, { align: "center" });

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(10);
  pdf.text("OFFICIAL PARTICIPATION TICKET", 105, 43, {
    align: "center",
  });

  // Ticket heading
  pdf.setTextColor(35, 85, 160);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(17);
  pdf.text("EVENT REGISTRATION TICKET", 105, 75, {
    align: "center",
  });

  pdf.setDrawColor(210, 210, 210);
  pdf.line(25, 83, 185, 83);

  // Registration details
  const details: [string, string][] = [
    ["Event Name", String(record.event || "-")],
    ["Participant Name", String(record.participant || "-")],
    ["Email Address", String(record.email || "-")],
    ["Registration ID", String(record.id || "-")],
    ["Registration Date", String(record.date || "-")],
    ["Approval Status", String(record.status || "-")],
  ];

  let y = 103;

  details.forEach(([label, value]) => {
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(11);
    pdf.setTextColor(90, 90, 90);
    pdf.text(label, 27, y);

    pdf.setFont("helvetica", "normal");
    pdf.setTextColor(30, 30, 30);

    const lines = pdf.splitTextToSize(value, 100);
    pdf.text(lines, 85, y);

    y += Math.max(17, lines.length * 6);
  });

  // Approval status
  pdf.setFillColor(225, 245, 232);
  pdf.roundedRect(27, y + 3, 156, 20, 3, 3, "F");

  pdf.setTextColor(25, 125, 65);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(13);
  pdf.text("REGISTRATION APPROVED", 105, y + 16, {
    align: "center",
  });

  // Footer
  pdf.setTextColor(100, 100, 100);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(10);

  pdf.text(
    "Please carry this ticket and a valid ID to the event.",
    105,
    260,
    { align: "center" }
  );

  pdf.text(
    "Thank you for choosing Eventify!",
    105,
    269,
    { align: "center" }
  );

  // Download PDF
  pdf.save(`Eventify-Ticket-${record.id}.pdf`);
}

function Registrations({
  openCancel,
  go,
  registrations,
  filter = "all",
  loading,
  error,
}: {
  openCancel: () => void;
  go: (page: Page) => void;
  registrations: RegistrationRecord[];
  loading: boolean;
  error: string;
  filter?: string;
}) {
  const [editing, setEditing] = useState<RegistrationRecord | null>(null);

  const visible = registrations.filter((record) => {
    if (filter === "pending") return record.status === "Pending";
    if (filter === "approved" || filter === "tickets") {
      return record.status === "Approved";
    }
    if (filter === "rejected") return record.status === "Rejected";
    return true;
  });

  const title =
    filter === "tickets"
      ? "My tickets"
      : filter === "all"
        ? "My registrations"
        : `${filter[0].toUpperCase()}${filter.slice(1)} registrations`;

  return (
    <section className="dash-section standalone">
      <div className="dash-section-title">
        <div>
          <h2>{title}</h2>
          <p>
            Track verification, approval decisions, and download your event
            tickets.
          </p>
        </div>

        <div className="table-actions">
          <label>
            <Icon name="search" size={17} />
            <input placeholder="Search registrations" />
          </label>

          <select>
            <option>All statuses</option>
            <option>Pending Review</option>
            <option>Verified</option>
            <option>Approved</option>
            <option>Rejected</option>
            <option>Correction Required</option>
          </select>
        </div>
      </div>

      <div className="responsive-table">
        {error && (
          <div className="error-text" role="alert">
            {error}
          </div>
        )}

        {loading && <p>Loading your registration history...</p>}

        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Registration ID</th>
              <th>Registration date</th>
              <th>Status</th>
              <th>Ticket</th>
            </tr>
          </thead>

          <tbody>
            {visible.map((record) => (
              <tr key={record.id}>
                <td>
                  <div className="table-event">
                    <strong>{record.event}</strong>
                  </div>
                </td>

                <td>{record.id}</td>

                <td>{record.date}</td>

                <td>
                  <StatusBadge status={record.status} />
                </td>

                <td>
                  {record.status === "Approved" ? (
                    <Button
                      type="button"
                      onClick={() => downloadTicket(record)}
                    >
                      Download PDF
                    </Button>
                  ) : (
                    <span>Not available</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && !error && visible.length === 0 && (
          <div className="empty-state">
            <h3>No registrations yet</h3>
            <p>Your event registration history will appear here.</p>
          </div>
        )}
      </div>

      {editing && (
        <RegistrationDetailModal
          record={editing}
          close={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: RegistrationStatus }) {
  const tone =
    status === "Approved"
      ? "success"
      : status === "Rejected" || status === "Cancelled"
        ? "danger"
        : "warning"
  const label = status === "Pending"
    ? "Approval Pending"
    : status === "Approved"
      ? "Verified"
      : status
  return <span className={`status-badge ${tone}`}>{label}</span>
}

function RegistrationDetailModal({
  record,
  close,
}: {
  record: RegistrationRecord
  close: () => void
}) {
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="detail-modal"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">Registration details</span>
            <h2>{record.event}</h2>
          </div>
          <button onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-status-row">
          <StatusBadge status={record.status} />
        </div>
        <div className="detail-list">
          <div>
            <span>Registration ID</span>
            <strong>{record.id}</strong>
          </div>
          <div>
            <span>Participant</span>
            <strong>{record.participant}</strong>
          </div>
          <div>
            <span>Email address</span>
            <strong>{record.email}</strong>
          </div>
          <div>
            <span>Phone number</span>
            <strong>{record.phone || "Not provided"}</strong>
          </div>
          <div>
            <span>Organization</span>
            <strong>{record.organization || "Not provided"}</strong>
          </div>
          <div>
            <span>Event date and venue</span>
            <strong>{record.eventDate} · {record.venue}</strong>
          </div>
        </div>
        {record.status === "Approved" && <Button className="full-width" onClick={() => downloadTicket(record)}>Download ticket</Button>}
      </div>
    </div>
  )
}

function SavedEvents({
  go,
  saved,
  toggleSave,
}: {
  go: (page: Page) => void
  saved: EventItem["id"][]
  toggleSave: (id: EventItem["id"]) => void
}) {
  const items: EventItem[] = []
  return (
    <section className="dash-section standalone">
      <div className="dash-section-title">
        <div>
          <h2>Saved events</h2>
          <p>Your wishlist of experiences to revisit.</p>
        </div>
      </div>
      {items.length ? (
        <div className="event-grid two-col">
          {items.map((event) => (
            <EventCard
              event={event}
              go={go}
              saved={saved}
              toggleSave={toggleSave}
              key={event.id}
            />
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <span>
            <Icon name="heart" size={32} />
          </span>
          <h3>No saved events yet</h3>
          <p>Tap the heart on any event to save it here.</p>
          <Button onClick={() => go("explore")}>Explore events</Button>
        </div>
      )}
    </section>
  )
}

function ProfileSettings({
  profile,
  onSave,
}: {
  profile: UserProfile | null
  onSave: (profile: UserProfile) => void
}) {
  const [saved, setSaved] = useState(false)
  const [fullName, setFullName] = useState(profile?.fullName || "")
  const [email, setEmail] = useState(profile?.email || "")
  const [phone, setPhone] = useState(profile?.phone || "")
  const [organization, setOrganization] = useState(profile?.organization || "")
  return (
    <section className="settings-layout">
      <div className="settings-nav">
        <button className="active">Personal information</button>
        <button>Security</button>
        <button>Notifications</button>
      </div>
      <form
        className="settings-card"
        onSubmit={(e) => {
          e.preventDefault()
          onSave({
            fullName: fullName.trim(),
            email: email.trim(),
            phone: phone.trim(),
            organization: organization.trim(),
            role: profile?.role || "participant",
            organizerStatus: profile?.organizerStatus || "not_requested",
          })
          setSaved(true)
        }}
      >
        <h2>Personal information</h2>
        <p>Update your account details and contact information.</p>
        {saved && (
          <div className="form-success">
            <Icon name="check" size={17} /> Profile changes saved.
          </div>
        )}
        <div className="profile-photo">
          <span>
            {profileInitials({
              fullName,
              email,
              phone,
              organization,
              role: profile?.role || "participant",
              organizerStatus: profile?.organizerStatus || "not_requested",
            })}
          </span>
          <div>
            <strong>{fullName || "Your profile"}</strong>
            <small>{email || "Add your email address"}</small>
          </div>
        </div>
        <div className="form-grid">
          <FormField
            label="Full name"
            placeholder="Enter your full name"
            value={fullName}
            onChange={setFullName}
            required
          />
          <FormField
            label="Email address"
            placeholder="you@college.edu"
            type="email"
            value={email}
            onChange={setEmail}
            required
          />
          <FormField
            label="Phone number"
            placeholder="Add your phone number"
            value={phone}
            onChange={setPhone}
          />
          <FormField
            label="College or organization"
            placeholder="Add your college or organization"
            value={organization}
            onChange={setOrganization}
          />
        </div>
        <div className="notification-options">
          <h3>Notification preferences</h3>
          {[
            "Event reminders",
            "Registration updates",
            "Recommended events",
          ].map((item) => (
            <label key={item}>
              <span>
                <strong>{item}</strong>
                <small>Receive timely {item.toLowerCase()}.</small>
              </span>
              <input type="checkbox" defaultChecked />
            </label>
          ))}
        </div>
        <Button type="submit">Save changes</Button>
      </form>
    </section>
  )
}

function Organizer({
  go,
  onLogout,
  registrations,
  updateRegistration,
  profile,
  saveProfile,
  selectEvent,
  onPublishEvent,
  onPublishDraft,
  onCompleteEvent,
  ownEvents,
  eventsLoading,
  eventsError,
  onCancelEvent,
  registrationsLoading,
  registrationsError,
}: {
  go: (page: Page) => void
  onLogout: () => void
  registrations: RegistrationRecord[]
  updateRegistration: (id: string, status: RegistrationStatus) => Promise<void>
  profile: UserProfile | null
  saveProfile: (profile: UserProfile) => void
  selectEvent: (id: EventItem["id"]) => void
  onPublishEvent: (
    event: NewEventInput,
    status: EventStatus,
    eventId?: string,
    imageFile?: File | null,
    removeImage?: boolean,
    changedFields?: EventFormField[],
    people?: EventPerson[],
  ) => Promise<EventSaveResult>
  onPublishDraft: (event: EventItem) => Promise<void>
  onCompleteEvent: (event: EventItem) => Promise<void>
  ownEvents: EventItem[]
  eventsLoading: boolean
  eventsError: string
  onCancelEvent: (event: EventItem) => Promise<void>
  registrationsLoading: boolean
  registrationsError: string
}) {
  const nav = [
    ["overview", "grid", "Dashboard overview"],
    ["create", "calendar", "Create event"],
    ["manage", "ticket", "My events"],
    ["participants", "users", "Registration requests"],
    ["approved", "check", "Approved participants"],
    ["rejected", "close", "Rejected registrations"],
    ["settings", "settings", "Profile settings"],
    ["participant", "users", "Switch to participant"],
  ]
  const [tab, setTab] = useState("overview")
  const [eventToCancel, setEventToCancel] = useState<EventItem | null>(null)
  const [editingEvent, setEditingEvent] = useState<EventItem | null>(null)
  const [eventActionError, setEventActionError] = useState("")
  const cancelEvent = async () => {
    if (!eventToCancel) return
    try {
      await onCancelEvent(eventToCancel)
      setEventToCancel(null)
      setEventActionError("")
    } catch (error) {
      setEventActionError(error instanceof Error ? error.message : "Could not cancel this event.")
    }
  }
  return (
    <main className="dashboard-shell">
      <DashboardSidebar
        title="Organizer studio"
        nav={nav}
        active={tab}
        select={(id) => (id === "participant" ? go("dashboard") : setTab(id))}
        go={go}
        onLogout={onLogout}
        profile={profile}
      />
      <div className="dashboard-content">
        <DashboardTop
          title={nav.find((item) => item[0] === tab)?.[2] || ""}
          go={go}
          profile={profile}
        />
        <div className="dashboard-inner">
          {tab === "overview" && (
            <OrganizerOverview
              setTab={setTab}
              registrations={registrations}
              loading={registrationsLoading}
              error={registrationsError}
              ownEvents={ownEvents}
            />
          )}
          {tab === "create" && (
            <CreateEvent
              key={editingEvent?.id || "new-event"}
              setTab={setTab}
              onPublish={onPublishEvent}
              editEvent={editingEvent || undefined}
            />
          )}
          {tab === "manage" && (
            <ManageEvents
              cancel={setEventToCancel}
              publish={onPublishDraft}
              complete={onCompleteEvent}
              edit={(event) => {
                setEditingEvent(event)
                setTab("create")
              }}
              setTab={setTab}
              go={go}
              ownEvents={ownEvents}
              loading={eventsLoading}
              error={eventActionError || eventsError}
              selectEvent={selectEvent}
            />
          )}
          {["participants", "approved", "rejected"].includes(tab) && (
            <Participants
              registrations={registrations}
              updateRegistration={updateRegistration}
              initialFilter={tab}
              loading={registrationsLoading}
              error={registrationsError}
            />
          )}
          {tab === "settings" && (
            <ProfileSettings profile={profile} onSave={saveProfile} />
          )}
        </div>
      </div>
      {eventToCancel && (
        <ConfirmModal
          title="Cancel this event?"
          text="Registered participants will be notified. This action should only be used when the event cannot proceed."
          confirm="Cancel event"
          close={() => setEventToCancel(null)}
          onConfirm={() => void cancelEvent()}
        />
      )}
    </main>
  )
}

function OrganizerOverview({
  setTab,
  registrations = [],
  loading = false,
  error = "",
  ownEvents = [],
}: {
  setTab: (tab: string) => void
  registrations?: RegistrationRecord[]
  loading?: boolean
  error?: string
  ownEvents?: EventItem[]
}) {
  const today = new Date().toISOString().slice(0, 10)
  const monthlyRegistrations = Array.from({ length: 7 }, (_, index) => {
    const month = new Date()
    month.setDate(1)
    month.setMonth(month.getMonth() - 6 + index)
    const key = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`
    return {
      key,
      label: month.toLocaleDateString("en-US", { month: "short" }),
      count: registrations.filter((record) => record.createdAt.slice(0, 7) === key).length,
    }
  })
  const maxMonthlyRegistrations = Math.max(1, ...monthlyRegistrations.map((item) => item.count))
  const upcomingEvents = ownEvents.filter((event) => event.status === "published" && (event.eventDate || "") >= today).length
  const completedEvents = ownEvents.filter((event) => Boolean(event.eventDate && event.eventDate < today)).length
  return (
    <>
      <section className="dash-section intro-section">
        <div>
          <span className="eyebrow">Organizer workspace</span>
          <h2>Bring your next campus idea to life.</h2>
          <p>Create a polished listing and start accepting registrations.</p>
        </div>
        <Button onClick={() => setTab("create")}>
          Create new event <Icon name="arrow" size={17} />
        </Button>
      </section>
      <div className="stat-grid">
        {[
          [String(ownEvents.length), "Total events", "Created by you"],
          [String(registrations.length), "Total registrations", "Across your events"],
          [String(upcomingEvents), "Upcoming events", "Published events"],
          [String(completedEvents), "Completed events", "Past events"],
        ].map(([value, label, note], index) => (
          <article className="stat-card" key={label}>
            <span className={`stat-icon tone-${index + 1}`}>
              <Icon name={index === 1 ? "users" : "calendar"} />
            </span>
            <div>
              <strong>{value}</strong>
              <span>{label}</span>
              <small>{note}</small>
            </div>
          </article>
        ))}
      </div>
      <section className="dash-section">
        <div className="dash-section-title">
          <div>
            <h2>Registration momentum</h2>
            <p>Registrations across your published events.</p>
          </div>
          <select>
            <option>Last 30 days</option>
          </select>
        </div>
        <div className="chart">
          <div className="chart-y">
            <span>{maxMonthlyRegistrations}</span>
            <span>{Math.round(maxMonthlyRegistrations * 2 / 3)}</span>
            <span>{Math.round(maxMonthlyRegistrations / 3)}</span>
            <span>0</span>
          </div>
          <div className="bars">
            {monthlyRegistrations.map((month) => (
              <div key={month.key}>
                <span style={{ height: `${month.count ? Math.max(8, month.count / maxMonthlyRegistrations * 100) : 0}%` }} />
                <small>{month.label}</small>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="dash-section">
        <div className="dash-section-title">
          <div>
            <h2>Recent registrations</h2>
            <p>Your newest participants.</p>
          </div>
          <button onClick={() => setTab("participants")}>
            View all <Icon name="arrow" size={16} />
          </button>
        </div>
        <ParticipantTable registrations={registrations.slice(0, 4)} loading={loading} error={error} />
      </section>
    </>
  )
}

function CreateEvent({
  setTab,
  onPublish,
  editEvent,
}: {
  setTab: (tab: string) => void
  onPublish: (
    event: NewEventInput,
    status: EventStatus,
    eventId?: string,
    imageFile?: File | null,
    removeImage?: boolean,
    changedFields?: EventFormField[],
    people?: EventPerson[],
  ) => Promise<EventSaveResult>
  editEvent?: EventItem
}) {
  const [form, setForm] = useState({
    title: editEvent?.title || "",
    description: editEvent?.description || "",
    category: editEvent?.category === "Event" ? "" : editEvent?.category || "",
    date: editEvent?.eventDate || "",
    startTime: editEvent?.startTimeValue || "",
    endTime: editEvent?.endTimeValue || "",
    venue: editEvent?.location || "",
    registrationDeadline: editEvent?.registrationDeadline || "",
    capacity: String(editEvent?.seats ?? 100),
    price: "0",
  })
  const [people, setPeople] = useState<EventPerson[]>(editEvent?.people || [])
  const [peopleBaseline, setPeopleBaseline] = useState<EventPerson[]>(editEvent?.people || [])
  const [peopleLoading, setPeopleLoading] = useState(Boolean(editEvent?.id))
  const [peopleLoadError, setPeopleLoadError] = useState("")
  const [persistedEventId, setPersistedEventId] = useState<string>()
  const [persistedBaseline, setPersistedBaseline] = useState<NewEventInput | null>(null)
  const [persistedStatus, setPersistedStatus] = useState<EventStatus>()
  const [saving, setSaving] = useState(false)
  const [selectedImageFile, setSelectedImageFile] = useState<File | null>(null)
  const [removeExistingImage, setRemoveExistingImage] = useState(false)
  const [existingImageUrl, setExistingImageUrl] = useState(editEvent?.imageUrl || "")
  const [imagePreviewUrl, setImagePreviewUrl] = useState("")
  const [imageError, setImageError] = useState("")
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")
  const formEventId = persistedEventId ||
    (typeof editEvent?.id === "string" ? editEvent.id : undefined)
  const isEditing = Boolean(formEventId)
  useEffect(() => {
    if (!editEvent || typeof editEvent.id !== "string") {
      setPeople([])
      setPeopleLoading(false)
      return
    }
    let active = true
    setPeopleLoading(true)
    setPeopleLoadError("")
    void fetchEventPeople(editEvent.id)
      .then((loadedPeople) => {
        if (active) {
          setPeople(loadedPeople)
          setPeopleBaseline(loadedPeople)
        }
      })
      .catch((loadError: unknown) => {
        if (!active) return
        const message = loadError instanceof Error
          ? loadError.message
          : "Could not load event mentors and speakers."
        setPeopleLoadError(message)
      })
      .finally(() => {
        if (active) setPeopleLoading(false)
      })
    return () => { active = false }
  }, [editEvent?.id])
  useEffect(() => {
    if (!selectedImageFile) {
      setImagePreviewUrl("")
      return
    }
    const objectUrl = URL.createObjectURL(selectedImageFile)
    setImagePreviewUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [selectedImageFile])
  const updateForm = (key: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [key]: value }))
  const publishEvent = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (saving) return
    if (peopleLoading || peopleLoadError) {
      setError(peopleLoadError || "Wait for the saved mentors and speakers to finish loading.")
      return
    }
    if (imageError) {
      setError(imageError)
      return
    }
    const submitter = (e.nativeEvent as SubmitEvent).submitter
    const action = submitter instanceof HTMLButtonElement
      ? submitter.value
      : persistedStatus || editEvent?.status || "draft"
    const status: EventStatus =
      action === "published"
        ? "published"
        : action === "draft"
          ? "draft"
          : persistedStatus || editEvent?.status || "draft"
    const eventValues: NewEventInput = {
      title: form.title.trim(),
      description: form.description.trim(),
      venue: form.venue.trim(),
      eventDate: form.date,
      registrationDeadline: form.registrationDeadline,
      capacity: Number(form.capacity),
      startTime: form.startTime,
      endTime: form.endTime,
    }
    const originalValues: NewEventInput | null = editEvent
      ? {
          title: editEvent.title,
          description: editEvent.description || "",
          venue: editEvent.location,
          eventDate: dateInputValue(editEvent.eventDate),
          registrationDeadline: dateInputValue(editEvent.registrationDeadline),
          capacity: editEvent.seats,
          startTime: timeInputValue(editEvent.startTimeValue),
          endTime: timeInputValue(editEvent.endTimeValue),
        }
      : persistedBaseline
    const changedFields: EventFormField[] = isEditing
      ? eventFormFields.filter(
          (field) => eventValues[field] !== originalValues?.[field],
        )
      : [...eventFormFields]
    if (isEditing && status !== (persistedStatus || editEvent?.status)) changedFields.push("status")
    const imageChanged = Boolean(selectedImageFile || removeExistingImage)
    const peopleChanged =
      JSON.stringify(people.map(({ id, name, role, designation, bio }) => ({ id, name, role, designation, bio }))) !==
      JSON.stringify(peopleBaseline.map(({ id, name, role, designation, bio }) => ({ id, name, role, designation, bio })))
    if (isEditing && changedFields.length === 0 && !imageChanged && !peopleChanged) {
      setSuccess("There are no changes to save.")
      return
    }
    if (!selectedImageFile && !editEvent?.imageUrl && !removeExistingImage) {
      setImageError("")
    }
    setSaving(true)
    setError("")
    setSuccess("")
    try {
      const savedEvent = await onPublish(
        eventValues,
        status,
        formEventId,
        selectedImageFile,
        removeExistingImage,
        changedFields,
        people,
      )
      setPersistedEventId(savedEvent.eventId)
      setPersistedStatus(savedEvent.status)
      setPersistedBaseline(eventValues)
      setPeople(savedEvent.people)
      setPeopleBaseline(savedEvent.people)
      setExistingImageUrl(savedEvent.imageUrl || "")
      setSelectedImageFile(null)
      setRemoveExistingImage(false)
      setSuccess(
        status === "published"
          ? "Event published successfully."
          : status === "draft"
            ? "Event saved as a draft."
            : "Event changes saved.",
      )
    } catch (saveError) {
      if (saveError instanceof EventPeopleSaveError) {
        setPersistedEventId(saveError.savedEventId)
        setPersistedStatus(saveError.savedStatus)
        setPersistedBaseline(eventValues)
        setExistingImageUrl(saveError.savedImageUrl || "")
        setSelectedImageFile(null)
        setRemoveExistingImage(false)
      }
      setError(saveError instanceof Error ? saveError.message : "Could not save this event.")
    } finally {
      setSaving(false)
    }
  }
  return (
    <form
      className="create-event-form"
      onSubmit={publishEvent}
    >
      <div className="form-page-heading">
        <div>
          <span className="eyebrow">{isEditing ? "Edit event" : "New event"}</span>
          <h2>{isEditing ? "Update your event" : "Create an experience"}</h2>
          <p>
            Share the essentials now. You can refine details before publishing.
          </p>
        </div>
        <div>
          {isEditing && (
            <Button
              variant="secondary"
              type="submit"
              disabled={saving || peopleLoading || Boolean(peopleLoadError)}
              value="keep"
            >
              Save changes
            </Button>
          )}
          <Button
            variant="secondary"
            type="submit"
            disabled={saving || peopleLoading || Boolean(peopleLoadError)}
            value="draft"
          >
            Save as draft
          </Button>
          <Button type="submit" disabled={saving || peopleLoading || Boolean(peopleLoadError)} value="published">
            {saving
              ? "Saving…"
              : (persistedStatus || editEvent?.status) === "published"
                ? "Save & publish"
                : "Publish event"}
          </Button>
        </div>
      </div>
      {error && <div className="error-text" role="alert">{error}</div>}
      {success && <div className="form-success" role="status">{success}</div>}
      <div className="creator-grid">
        <div>
          <section className="form-section">
            <div className="form-section-title">
              <span>01</span>
              <div>
                <h3>Event basics</h3>
                <p>Name, category, and a compelling description.</p>
              </div>
            </div>
            <FormField
              label="Event title"
              placeholder="Give your event a clear, memorable name"
              value={form.title}
              onChange={(value) => updateForm("title", value)}
              required
            />
            <div className="form-field">
              <label>
                Event description<span>*</span>
              </label>
              <textarea
                placeholder="Tell participants what makes this event worth attending…"
                value={form.description}
                onChange={(e) => updateForm("description", e.target.value)}
                required
              />
            </div>
            <div className="form-grid">
              <div className="form-field">
                <label>
                  Category<span>*</span>
                </label>
                <select
                  value={form.category}
                  onChange={(e) => updateForm("category", e.target.value)}
                  required={!editEvent}
                >
                  <option value="">Select category</option>
                  <option>Technology</option>
                  <option>Hackathon</option>
                  <option>Workshop</option>
                  <option>Cultural</option>
                  <option>Business</option>
                </select>
              </div>
              <div className="form-field">
                <label>
                  Event format<span>*</span>
                </label>
                <select>
                  <option>In person</option>
                  <option>Online</option>
                  <option>Hybrid</option>
                </select>
              </div>
            </div>
          </section>
          <section className="form-section">
            <div className="form-section-title">
              <span>02</span>
              <div>
                <h3>Date & location</h3>
                <p>When and where participants should arrive.</p>
              </div>
            </div>
            <div className="form-grid">
              <FormField
                label="Event date"
                type="date"
                value={form.date}
                onChange={(value) => updateForm("date", value)}
                required
              />
              <FormField
                label="Start time"
                type="time"
                value={form.startTime}
                onChange={(value) => updateForm("startTime", value)}
                required={!editEvent}
              />
              <FormField
                label="End time"
                type="time"
                value={form.endTime}
                onChange={(value) => updateForm("endTime", value)}
                required={!editEvent}
              />
              <FormField
                label="Venue"
                placeholder="Building or venue name"
                value={form.venue}
                onChange={(value) => updateForm("venue", value)}
                required
              />
            </div>
            <FormField
              label="Full address / meeting details"
              placeholder="Campus address or online meeting instructions"
            />
          </section>
          <section className="form-section">
            <div className="form-section-title">
              <span>03</span>
              <div>
                <h3>Registration settings</h3>
                <p>Capacity, pricing, and participant rules.</p>
              </div>
            </div>
            <div className="form-grid">
              <FormField label="Registration opens" type="date" />
              <FormField
                label="Registration deadline"
                type="date"
                value={form.registrationDeadline}
                onChange={(value) => updateForm("registrationDeadline", value)}
                required
              />
              <FormField
                label="Maximum capacity"
                type="number"
                placeholder="100"
                value={form.capacity}
                onChange={(value) => updateForm("capacity", value)}
                min={1}
                required
              />
              <FormField
                label="Ticket price"
                type="number"
                placeholder="0 for free"
                value={form.price}
                onChange={(value) => updateForm("price", value)}
                min={0}
              />
            </div>
            <FormField
              label="Eligibility criteria"
              placeholder="e.g. Open to all college students"
            />
            <FormField
              label="Contact details"
              placeholder="organizer@college.edu"
            />
          </section>
          <section className="form-section">
            <div className="form-section-title">
              <span>04</span>
              <div>
                <h3>Mentors & Speakers</h3>
                <p>Add optional people participating in your event.</p>
              </div>
            </div>
            {peopleLoading && <p role="status">Loading saved mentors and speakers…</p>}
            {peopleLoadError && <div className="error-text" role="alert">{peopleLoadError}</div>}
            {!peopleLoading && !peopleLoadError && people.map((person, index) => (
              <div className="event-person-editor" key={person.clientId}>
                <div className="event-person-editor-heading">
                  <strong>Person {index + 1}</strong>
                  <button
                    type="button"
                    className="danger-link"
                    onClick={() => setPeople((current) =>
                      current.filter((item) => item.clientId !== person.clientId),
                    )}
                  >
                    Remove
                  </button>
                </div>
                <div className="form-grid">
                  <div className="form-field">
                    <label htmlFor={`person-role-${person.clientId}`}>Role</label>
                    <select
                      id={`person-role-${person.clientId}`}
                      value={person.role}
                      onChange={(event) => setPeople((current) =>
                        current.map((item) => item.clientId === person.clientId
                          ? { ...item, role: event.target.value as EventPersonRole }
                          : item),
                      )}
                    >
                      <option value="mentor">Mentor</option>
                      <option value="speaker">Speaker</option>
                    </select>
                  </div>
                  <FormField
                    label="Full name"
                    placeholder="Name"
                    value={person.name}
                    onChange={(value) => setPeople((current) =>
                      current.map((item) => item.clientId === person.clientId
                        ? { ...item, name: value }
                        : item),
                    )}
                  />
                </div>
                <FormField
                  label="Designation or profession"
                  placeholder="e.g. Researcher, Designer, Faculty"
                  value={person.designation}
                  onChange={(value) => setPeople((current) =>
                    current.map((item) => item.clientId === person.clientId
                      ? { ...item, designation: value }
                      : item),
                  )}
                />
                <div className="form-field">
                  <label htmlFor={`person-bio-${person.clientId}`}>Short biography</label>
                  <textarea
                    id={`person-bio-${person.clientId}`}
                    value={person.bio}
                    onChange={(event) => setPeople((current) =>
                      current.map((item) => item.clientId === person.clientId
                        ? { ...item, bio: event.target.value }
                        : item),
                    )}
                  />
                </div>
              </div>
            ))}
            <Button
              type="button"
              variant="secondary"
              disabled={peopleLoading || Boolean(peopleLoadError)}
              onClick={() => setPeople((current) => [...current, {
                clientId: crypto.randomUUID(),
                name: "",
                role: "mentor",
                designation: "",
                bio: "",
              }])}
            >
              Add Person
            </Button>
          </section>
        </div>
        <aside className="upload-panel">
          <h3>Event banner</h3>
          <p>Choose a JPG, JPEG, PNG, or WEBP image for your event.</p>
          <label className="upload-box">
            <input
              type="file"
              accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ""
                if (!file) return
                const extension = file.name.split(".").pop()?.toLowerCase()
                const allowedTypes: Record<string, string[]> = {
                  jpg: ["image/jpeg"],
                  jpeg: ["image/jpeg"],
                  png: ["image/png"],
                  webp: ["image/webp"],
                }
                const acceptedTypes = extension ? allowedTypes[extension] : undefined
                if (!acceptedTypes || (file.type && !acceptedTypes.includes(file.type))) {
                  setImageError("Choose a valid JPG, JPEG, PNG, or WEBP image.")
                  return
                }
                setImageError("")
                setSelectedImageFile(file)
                setRemoveExistingImage(false)
                setSuccess("")
              }}
            />
            {imagePreviewUrl || (!removeExistingImage && existingImageUrl) ? (
              <>
                <img
                  className="upload-preview"
                  src={imagePreviewUrl || existingImageUrl}
                  alt="Event image preview"
                />
                <span className="upload-change-hint">Click to change image</span>
              </>
            ) : (
              <>
                <Icon name="download" />
                <strong>Click to upload an event image</strong>
                <span>JPG, JPEG, PNG or WEBP</span>
              </>
            )}
          </label>
          {(selectedImageFile || existingImageUrl) && !removeExistingImage && (
            <div className="upload-image-actions">
              <span>{selectedImageFile?.name || "Current event image"}</span>
              <button
                type="button"
                onClick={() => {
                  setSelectedImageFile(null)
                  setRemoveExistingImage(Boolean(existingImageUrl))
                  setImageError("")
                }}
              >
                Remove image
              </button>
            </div>
          )}
          {removeExistingImage && (
            <div className="upload-image-actions">
              <span>Image removed; save the event to apply this change.</span>
              <button
                type="button"
                onClick={() => setRemoveExistingImage(false)}
              >
                Keep current image
              </button>
            </div>
          )}
          {imageError && <div className="error-text" role="alert">{imageError}</div>}
          {saving && selectedImageFile && (
            <p className="upload-progress" role="status">Uploading image and saving event…</p>
          )}
          {error && <div className="error-text" role="alert">{error}</div>}
          <div className="publish-checklist">
            <h4>Before publishing</h4>
            {[
              "Clear event title",
              "Accurate date and venue",
              "Registration deadline",
              "Organizer contact",
            ].map((item, index) => (
              <span key={item}>
                <Icon name={index < 2 ? "check" : "clock"} size={16} /> {item}
              </span>
            ))}
          </div>
        </aside>
      </div>
    </form>
  )
}

function ManageEvents({
  cancel,
  edit,
  publish,
  complete,
  setTab,
  go,
  ownEvents,
  loading,
  error,
  selectEvent,
}: {
  cancel: (event: EventItem) => void
  edit: (event: EventItem) => void
  publish: (event: EventItem) => Promise<void>
  complete: (event: EventItem) => Promise<void>
  setTab: (tab: string) => void
  go: (page: Page) => void
  ownEvents: EventItem[]
  loading: boolean
  error: string
  selectEvent: (id: EventItem["id"]) => void
}) {
  const [filter, setFilter] = useState<EventStatus | "all">("all")
  const [publishingId, setPublishingId] = useState<EventItem["id"] | null>(null)
  const [actionError, setActionError] = useState("")
  const [actionSuccess, setActionSuccess] = useState("")
  const statuses: EventStatus[] = ["published", "draft", "completed", "cancelled"]
  const filteredEvents = filter === "all"
    ? ownEvents
    : ownEvents.filter((event) => event.status === filter)
  const publishDraft = async (event: EventItem) => {
    setPublishingId(event.id)
    setActionError("")
    setActionSuccess("")
    try {
      await publish(event)
      setActionSuccess(`${event.title} published successfully.`)
    } catch (publishError) {
      setActionError(publishError instanceof Error ? publishError.message : "Could not publish this draft.")
    } finally {
      setPublishingId(null)
    }
  }
  const markCompleted = async (event: EventItem) => {
    setActionError("")
    setActionSuccess("")
    try {
      await complete(event)
      setActionSuccess(`${event.title} marked as completed.`)
    } catch (completionError) {
      setActionError(completionError instanceof Error ? completionError.message : "Could not update this event.")
    }
  }
  return (
    <section className="dash-section standalone">
      <div className="dash-section-title">
        <div>
          <h2>Manage events</h2>
          <p>Edit listings, review participation, and track status.</p>
        </div>
        <Button onClick={() => setTab("create")}>Create event</Button>
      </div>
      <div className="management-tabs">
        <button
          className={filter === "all" ? "active" : ""}
          onClick={() => setFilter("all")}
        >
          All ({ownEvents.length})
        </button>
        {statuses.map((status) => (
          <button
            className={filter === status ? "active" : ""}
            key={status}
            onClick={() => setFilter(status)}
          >
            {status[0].toUpperCase() + status.slice(1)} ({ownEvents.filter((event) => event.status === status).length})
          </button>
        ))}
      </div>
      <div className="manage-list">
        {(actionError || error) && <div className="error-text" role="alert">{actionError || error}</div>}
        {actionSuccess && <div className="form-success" role="status">{actionSuccess}</div>}
        {loading && <p>Loading your events…</p>}
        {filteredEvents.map((event) => (
          <article key={event.id}>
            <EventImage src={event.image} alt="" />
            <div className="manage-info">
              <div>
                <span className={`status-badge ${event.status === "published" ? "success" : ""}`}>
                  {event.status || "Draft"}
                </span>
                <small>{event.category}</small>
              </div>
              <h3>{event.title}</h3>
              <p>
                {event.date}{event.time ? ` · ${event.time}` : ""} · {event.location}
              </p>
              <div className="manage-progress">
                <span>
                  <i style={{ width: `${event.seats ? Math.min(100, ((event.registeredCount ?? 0) / event.seats) * 100) : 0}%` }} />
                </span>
                <small>
                  Registered: {event.registeredCount ?? 0} / {event.seats} · Available seats: {Math.max(0, event.seats - (event.registeredCount ?? 0))} · {event.seats ? Math.min(100, Math.round(((event.registeredCount ?? 0) / event.seats) * 100)) : 0}% full
                </small>
              </div>
            </div>
            <div className="manage-actions">
              <Button variant="secondary" onClick={() => edit(event)}>
                Edit event
              </Button>
              <Button variant="ghost" onClick={() => setTab("participants")}>
                Registrations
              </Button>
              {event.status === "draft" && (
                <Button
                  disabled={publishingId === event.id}
                  onClick={() => void publishDraft(event)}
                >
                  {publishingId === event.id ? "Publishing…" : "Publish event"}
                </Button>
              )}
              {event.status === "published" && (
                <Button
                  variant="ghost"
                  onClick={() => void markCompleted(event)}
                >
                  Mark completed
                </Button>
              )}
              {event.status !== "cancelled" && event.status !== "completed" && (
                <button className="danger-link" onClick={() => cancel(event)}>
                  Cancel event
                </button>
              )}
              {event.status === "published" && (
                <button
                  onClick={() => {
                    selectEvent(event.id)
                    go("details")
                  }}
                >
                  View live page
                </button>
              )}
            </div>
          </article>
        ))}
        {!loading && !error && filteredEvents.length === 0 && (
          <div className="empty-state">
            <h3>{filter === "all" ? "No events created yet" : `No ${filter} events`}</h3>
            <p>{filter === "all" ? "Create an event to see it in your organizer dashboard." : "Events in this status will appear here."}</p>
            {filter === "all" && <Button onClick={() => setTab("create")}>Create your first event</Button>}
          </div>
        )}
      </div>
    </section>
  )
}

function Participants({
  registrations,
  updateRegistration,
  initialFilter = "participants",
  loading,
  error,
}: {
  registrations: RegistrationRecord[]
  updateRegistration: (id: string, status: RegistrationStatus) => Promise<void>
  initialFilter?: string
  loading: boolean
  error: string
}) {
  const [filter, setFilter] = useState(
    initialFilter === "approved"
      ? "Approved"
      : initialFilter === "rejected"
        ? "Rejected"
        : "All Registrations",
  )
  const [selected, setSelected] = useState<RegistrationRecord | null>(null)
  const [notice, setNotice] = useState("")
  const [actionError, setActionError] = useState("")
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const visible = registrations.filter((record) => {
    if (filter === "All Registrations") return true
    if (filter === "Pending Review") return record.status === "Pending"
    return record.status === filter
  })
  const setStatus = async (record: RegistrationRecord, status: RegistrationStatus) => {
    setUpdatingId(record.id)
    setActionError("")
    setNotice("")
    try {
      await updateRegistration(record.id, status)
      setNotice(`Registration ${status.toLowerCase()} successfully.`)
    } catch (updateError) {
      setActionError(updateError instanceof Error ? updateError.message : "Could not update registration status.")
    } finally {
      setUpdatingId(null)
    }
  }
  return (
    <section className="dash-section standalone">
      <div className="dash-section-title">
        <div>
          <h2>Registration requests</h2>
          <p>
            Review participant and event details, then approve or reject registrations.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => alert("Demo CSV export prepared.")}
        >
          <Icon name="download" size={17} /> Export CSV
        </Button>
      </div>
      <div className="table-actions wide">
        <label>
          <Icon name="search" size={17} />
          <input placeholder="Search by name, email, event, or ID" />
        </label>
        <select
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          {[
            "All Registrations",
            "Pending Review",
            "Approved",
            "Rejected",
          ].map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </div>
      {(error || actionError) && (
        <div className="error-text" role="alert">{actionError || error}</div>
      )}
      {notice && (
        <div className="form-success workflow-notice">
          <Icon name="check" size={17} /> {notice}
        </div>
      )}
      <div className="responsive-table registration-review-table">
        {loading && <p>Loading registrations…</p>}
        <table>
          <thead>
            <tr>
              <th>Registration ID</th>
              <th>Participant name</th>
              <th>Email address</th>
              <th>Phone</th>
              <th>Organization</th>
              <th>Event name</th>
              <th>Venue</th>
              <th>Registration date</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((record) => (
              <tr key={record.id}>
                <td>{record.id}</td>
                <td>
                  <strong>{record.participant}</strong>
                </td>
                <td>{record.email}</td>
                <td>{record.phone || "—"}</td>
                <td>{record.organization || "—"}</td>
                <td>{record.event}<br /><small>{record.eventDate}</small></td>
                <td>{record.venue}</td>
                <td>{record.date}</td>
                <td><StatusBadge status={record.status} /></td>
                <td>
                  <div className="workflow-actions">
                    <button onClick={() => setSelected(record)}>View details</button>
                    <button onClick={() => setStatus(record, "Approved")} disabled={record.status !== "Pending" || updatingId !== null}>
                      {updatingId === record.id ? "Updating…" : "Approve"}
                    </button>
                    <button className="danger-link" onClick={() => setStatus(record, "Rejected")} disabled={record.status !== "Pending" || updatingId !== null}>
                      Reject
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && !error && !actionError && visible.length === 0 && (
        <div className="empty-state"><h3>No registrations found</h3></div>
      )}
      {selected && <RegistrationDetailModal record={selected} close={() => setSelected(null)} />}
    </section>
  )
}

function ParticipantTable({
  registrations,
  loading,
  error,
}: {
  registrations: RegistrationRecord[]
  loading: boolean
  error: string
}) {
  return (
    <div className="responsive-table">
      {error && <div className="error-text" role="alert">{error}</div>}
      {loading && <p>Loading registrations…</p>}
      <table>
        <thead>
          <tr>
            <th>Participant</th>
            <th>Event</th>
            <th>Registered</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {registrations.map((record) => (
            <tr key={record.id}>
              <td>
                <div className="person-cell">
                  <span>
                    {record.participant
                      .split(" ")
                      .map((n) => n[0])
                      .join("")}
                  </span>
                  <div>
                    <strong>{record.participant}</strong>
                    <small>{record.email}</small>
                  </div>
                </div>
              </td>
              <td>{record.event}</td>
              <td>{record.date}</td>
              <td>
                <StatusBadge status={record.status} />
              </td>
              <td>
                <button>•••</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!loading && !error && registrations.length === 0 && <p>No registrations for your events yet.</p>}
    </div>
  )
}

function Admin({ go, onLogout }: { go: (page: Page) => void; onLogout: () => void }) {
  const nav = [
    ["overview", "grid", "Platform overview"],
    ["users", "users", "Manage users"],
    ["approvals", "check", "Event approvals"],
    ["events", "calendar", "All events"],
    ["categories", "list", "Categories"],
    ["statistics", "arrow", "Statistics"],
  ]
  const [tab, setTab] = useState("overview")
  const [modal, setModal] = useState(false)
  return (
    <main className="dashboard-shell admin-shell">
      <DashboardSidebar
        title="Platform admin"
        nav={nav}
        active={tab}
        select={setTab}
        go={go}
        onLogout={onLogout}
        admin
      />
      <div className="dashboard-content">
        <DashboardTop
          title={nav.find((n) => n[0] === tab)?.[2] || ""}
          go={go}
        />
        <div className="dashboard-inner">
          {tab === "overview" && <AdminOverview setTab={setTab} />}
          {tab === "approvals" && <Approvals remove={() => setModal(true)} />}
          {tab === "users" && (
            <AdminTable type="users" remove={() => setModal(true)} />
          )}
          {tab === "events" && (
            <AdminTable type="events" remove={() => setModal(true)} />
          )}
          {tab === "categories" && <CategoriesAdmin />}
          {tab === "statistics" && <OrganizerOverview setTab={setTab} />}
        </div>
      </div>
      {modal && (
        <ConfirmModal
          title="Confirm destructive action"
          text="This action affects live platform data in a real implementation and cannot be automatically reversed."
          confirm="Confirm removal"
          close={() => setModal(false)}
        />
      )}
    </main>
  )
}

function AdminOverview({ setTab }: { setTab: (tab: string) => void }) {
  return (
    <>
      <div className="admin-alert">
        <div>
          <span>
            <Icon name="bell" />
          </span>
          <div>
            <strong>6 events are waiting for review</strong>
            <p>
              Keep the campus calendar fresh by reviewing pending submissions.
            </p>
          </div>
        </div>
        <Button variant="dark" onClick={() => setTab("approvals")}>
          Review now
        </Button>
      </div>
      <div className="stat-grid">
        {[
          ["8,492", "Total users", "+124 this week"],
          ["386", "Total events", "+18 this month"],
          ["24,851", "Registrations", "+12.8% growth"],
          ["6", "Pending approvals", "Needs attention"],
        ].map(([value, label, note], index) => (
          <article className="stat-card" key={label}>
            <span className={`stat-icon tone-${index + 1}`}>
              <Icon
                name={
                  index === 0
                    ? "users"
                    : index === 1
                      ? "calendar"
                      : index === 2
                        ? "ticket"
                        : "clock"
                }
              />
            </span>
            <div>
              <strong>{value}</strong>
              <span>{label}</span>
              <small>{note}</small>
            </div>
          </article>
        ))}
      </div>
      <div className="admin-overview-grid">
        <section className="dash-section">
          <div className="dash-section-title">
            <div>
              <h2>Platform activity</h2>
              <p>Registrations over the last 7 months.</p>
            </div>
            <select>
              <option>Registrations</option>
            </select>
          </div>
          <div className="chart admin-chart">
            <div className="bars">
              {[45, 52, 48, 68, 72, 88, 96].map((height, i) => (
                <div key={i}>
                  <span style={{ height: `${height}%` }} />
                  <small>
                    {["Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"][i]}
                  </small>
                </div>
              ))}
            </div>
          </div>
        </section>
        <section className="dash-section activity-feed">
          <div className="dash-section-title">
            <div>
              <h2>Recent activity</h2>
              <p>Live platform actions.</p>
            </div>
          </div>
          {[
            [
              "check",
              "Event approved",
              "AI Summit 2026 was published",
              "4 min",
            ],
            ["users", "New organizer", "Campus Arts Council joined", "18 min"],
            [
              "calendar",
              "Event submitted",
              "FinTech Foundry awaits review",
              "42 min",
            ],
            ["close", "Report resolved", "Duplicate listing removed", "1 hr"],
          ].map(([icon, title, text, time]) => (
            <div key={text}>
              <span>
                <Icon name={icon} size={17} />
              </span>
              <div>
                <strong>{title}</strong>
                <p>{text}</p>
              </div>
              <small>{time}</small>
            </div>
          ))}
        </section>
      </div>
    </>
  )
}

function Approvals({ remove }: { remove: () => void }) {
  return (
    <section className="dash-section standalone">
      <div className="dash-section-title">
        <div>
          <h2>Pending event approvals</h2>
          <p>Review submitted events before they appear publicly.</p>
        </div>
      </div>
      <div className="approval-list">
        <div className="empty-state"><h3>No pending event approvals</h3><p>Events submitted for review will appear here.</p><Button variant="ghost" onClick={remove}>Close</Button></div>
      </div>
    </section>
  )
}

function AdminTable({
  type,
  remove,
}: {
  type: "users" | "events"
  remove: () => void
}) {
  return (
    <section className="dash-section standalone">
      <div className="dash-section-title">
        <div>
          <h2>{type === "users" ? "Manage users" : "All events"}</h2>
          <p>Search, review, and manage platform records.</p>
        </div>
        <div className="table-actions">
          <label>
            <Icon name="search" size={17} />
            <input placeholder={`Search ${type}`} />
          </label>
          <select>
            <option>All statuses</option>
          </select>
        </div>
      </div>
      <div className="empty-state"><h3>No records loaded</h3></div>
      <div className="admin-danger-zone">
        <span>Administrative action</span>
        <Button variant="danger" onClick={remove}>
          Remove selected record
        </Button>
      </div>
    </section>
  )
}

function CategoriesAdmin() {
  return (
    <section className="dash-section standalone">
      <div className="dash-section-title">
        <div>
          <h2>Event categories</h2>
          <p>Manage the categories organizers can assign.</p>
        </div>
        <Button>Add category</Button>
      </div>
      <div className="category-admin-grid">
        {categories.map(([icon, name, count]) => (
          <article key={name}>
            <span>{icon}</span>
            <div>
              <strong>{name}</strong>
              <small>{count}</small>
            </div>
            <button>Edit</button>
          </article>
        ))}
      </div>
    </section>
  )
}

function Notifications() {
  const [filter, setFilter] = useState("All")
  const notices = [
    [
      "ticket",
      "Registration successful",
      "Your spot at CodeStorm 2026 is confirmed.",
      "Just now",
      true,
    ],
    [
      "clock",
      "Event reminder",
      "Future of AI Summit begins tomorrow at 10:30 AM.",
      "2 hours ago",
      true,
    ],
    [
      "calendar",
      "Event updated",
      "The venue for Design Thinking Workshop has changed.",
      "Yesterday",
      false,
    ],
    [
      "close",
      "Event cancelled",
      "Campus Cricket League has been cancelled by the organizer.",
      "2 days ago",
      false,
    ],
    [
      "bell",
      "Deadline approaching",
      "Registration for Robotics Build League closes in 2 days.",
      "3 days ago",
      false,
    ],
  ]
  return (
    <main className="page-main notification-page">
      <section className="container">
        <div className="notification-heading">
          <div>
            <span className="eyebrow">Stay in the loop</span>
            <h1>Notifications</h1>
            <p>Important updates about your events and registrations.</p>
          </div>
          <button>Mark all as read</button>
        </div>
        <div className="notification-tabs">
          {["All", "Unread", "Updates"].map((item) => (
            <button
              key={item}
              className={filter === item ? "active" : ""}
              onClick={() => setFilter(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="notification-list">
          {notices
            .filter((n) => filter !== "Unread" || n[4])
            .map(([icon, title, text, time, unread]) => (
              <article className={unread ? "unread" : ""} key={String(title)}>
                <span className="notification-icon">
                  <Icon name={String(icon)} />
                </span>
                <div>
                  <div>
                    <h3>{title}</h3>
                    {unread && <i />}
                  </div>
                  <p>{text}</p>
                  <small>{time}</small>
                </div>
                <button>•••</button>
              </article>
            ))}
        </div>
      </section>
    </main>
  )
}

function ConfirmModal({
  title,
  text,
  confirm,
  close,
  onConfirm,
}: {
  title: string
  text: string
  confirm: string
  close: () => void
  onConfirm?: () => void
}) {
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="confirm-modal" onMouseDown={(e) => e.stopPropagation()}>
        <span className="modal-icon">
          <Icon name="close" />
        </span>
        <h2>{title}</h2>
        <p>{text}</p>
        <div>
          <Button variant="secondary" onClick={close}>
            Keep it
          </Button>
          <Button variant="danger" onClick={onConfirm || close}>
            {confirm}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const [page, setPage] = useState<Page>("login")
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [authError, setAuthError] = useState("")
  const [verificationIssue, setVerificationIssue] = useState(false)
  const profileRef = useRef(profile)
  const authSequence = useRef(0)
  const eventImageColumn = useRef<EventImageColumn | null>(null)
  const getEventImageColumn = async (): Promise<EventImageColumn> => {
    if (eventImageColumn.current) return eventImageColumn.current
    for (const column of ["image_url", "image"] as const) {
      const { error } = await supabase.from("events").select(column).limit(0)
      if (!error) {
        eventImageColumn.current = column
        return column
      }
      if (
        error.code !== "42703" &&
        !/column .* does not exist|could not find .*column|schema cache/i.test(error.message)
      ) {
        throw new Error(`Could not inspect the event image field: ${error.message}`)
      }
    }
    throw new Error(
      "The events table has no image or image_url field. Add or identify its existing image field before saving event images.",
    )
  }
  const eventSelectColumns = async () => {
    const imageColumn = await getEventImageColumn()
    return [
      "id",
      "title",
      "description",
      "venue",
      "event_date",
      "start_time",
      "end_time",
      "registration_deadline",
      "capacity",
      "organizer_id",
      "status",
      imageColumn,
    ].join(", ")
  }
  const fetchProfile = async (userId: string): Promise<UserProfile> => {
    const { data, error } = await supabase
      .from("profiles")
      .select("full_name, email, phone, organization, role, organizer_status")
      .eq("id", userId)
      .maybeSingle()
    if (error) throw new Error(`Could not load your profile: ${error.message}`)
    if (!data) throw new Error("Your account profile was not found. Please contact support.")
    if (data.role !== "participant" && data.role !== "organizer") {
      throw new Error("Your account has an unsupported role. Please contact support.")
    }
    if (
      data.organizer_status !== "not_requested" &&
      data.organizer_status !== "pending" &&
      data.organizer_status !== "approved" &&
      data.organizer_status !== "rejected"
    ) {
      throw new Error("Your organizer application status is invalid. Please contact support.")
    }
    return {
      fullName: data.full_name || "",
      email: data.email || "",
      phone: data.phone || "",
      organization: data.organization || "",
      role: data.role,
      organizerStatus: data.organizer_status,
    }
  }
  const isApprovedOrganizer = (userProfile: UserProfile | null) =>
    userProfile?.role === "organizer" && userProfile.organizerStatus === "approved"
  const organizerAccessMessage = (userProfile: UserProfile) => {
    if (userProfile.organizerStatus === "pending") {
      return "Your organizer application is pending approval."
    }
    if (userProfile.organizerStatus === "rejected") {
      return "Your organizer application has been rejected. Please contact the administrator."
    }
    return "You do not have organizer access."
  }
  const getApprovedOrganizerId = async () => {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
    if (sessionError) throw new Error(`Could not verify your session: ${sessionError.message}`)
    if (!sessionData.session) throw new Error("Please sign in again before managing events.")
    const organizerId = sessionData.session.user.id
    const { data: organizerProfile, error: profileError } = await supabase
      .from("profiles")
      .select("role, organizer_status")
      .eq("id", organizerId)
      .maybeSingle()
    if (profileError) throw new Error(`Could not verify organizer approval: ${profileError.message}`)
    if (
      organizerProfile?.role !== "organizer" ||
      organizerProfile.organizer_status !== "approved"
    ) {
      throw new Error("Only approved organizers can manage events.")
    }
    return organizerId
  }
  useEffect(() => {
    let active = true
    const searchParams = new URLSearchParams(window.location.search)
    const hashParams = new URLSearchParams(window.location.hash.slice(1))
    const callbackErrorCode =
      searchParams.get("error_code") || hashParams.get("error_code")
    const callbackError =
      searchParams.get("error_description") ||
      hashParams.get("error_description") ||
      searchParams.get("error") ||
      hashParams.get("error")
    const confirmationCallback =
      !(callbackErrorCode || callbackError) &&
      (searchParams.get("email_confirmation") === "1" ||
        hashParams.get("type") === "signup")
    const removeCallbackErrorFromUrl = () => {
      for (const params of [searchParams, hashParams]) {
        params.delete("error")
        params.delete("error_code")
        params.delete("error_description")
        params.delete("email_confirmation")
      }
      const query = searchParams.toString()
      const hash = hashParams.toString()
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${query ? `?${query}` : ""}${hash ? `#${hash}` : ""}`,
      )
    }
    if (callbackErrorCode || callbackError) {
      const normalizedError = `${callbackErrorCode || ""} ${callbackError || ""}`.toLowerCase()
      setPage("login")
      setVerificationIssue(true)
      setAuthError(
        /expired|invalid|already used|otp_disabled/.test(normalizedError)
          ? "This verification link is invalid, expired, or already used. Request a fresh verification email below."
          : `Email verification could not be completed: ${callbackError || callbackErrorCode}. Request a fresh verification email below.`,
      )
      removeCallbackErrorFromUrl()
    } else if (searchParams.has("email_confirmation")) {
      searchParams.delete("email_confirmation")
      const query = searchParams.toString()
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
      )
    }
    const restoreProfile = async (
      userId: string,
      navigate: boolean,
    ) => {
      const sequence = ++authSequence.current
      try {
        const nextProfile = await fetchProfile(userId)
        if (!active || sequence !== authSequence.current) return
        profileRef.current = nextProfile
        setProfile(nextProfile)
        setAuthError("")
        setVerificationIssue(false)
        if (navigate) {
          if (nextProfile.role === "organizer" && nextProfile.organizerStatus !== "approved") {
            setPage("organizer-login")
            setAuthError(organizerAccessMessage(nextProfile))
          } else {
            setPage(nextProfile.role === "organizer" ? "organizer" : "dashboard")
          }
        }
      } catch (error) {
        if (!active || sequence !== authSequence.current) return
        const message = error instanceof Error ? error.message : "Could not load your profile."
        console.error(message, error)
        profileRef.current = null
        setProfile(null)
        setAuthError(message)
        if (navigate) setPage("login")
      }
    }
    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (!session) {
        authSequence.current += 1
        if (active) {
          profileRef.current = null
          setProfile(null)
          if (event === "SIGNED_OUT") setPage("login")
        }
        return
      }
      if (event === "INITIAL_SESSION") {
        void restoreProfile(session.user.id, true)
      } else {
        void restoreProfile(
          session.user.id,
          confirmationCallback &&
            event === "SIGNED_IN" &&
            Boolean(session.user.email_confirmed_at),
        )
      }
    })
    void supabase.auth.getSession().then(({ data, error }) => {
      if (error) throw error
      if (data.session) {
        return restoreProfile(data.session.user.id, true)
      }
      return undefined
    }).catch((error: unknown) => {
      if (!active) return
      const message = error instanceof Error ? error.message : "Could not restore your session."
      console.error("Could not restore the Eventify session.", error)
      setAuthError(message)
    })
    return () => {
      active = false
      authSequence.current += 1
      authListener.subscription.unsubscribe()
    }
  }, [])
  const [saved, setSaved] = useState<EventItem["id"][]>([])
  const [publishedEvents, setPublishedEvents] = useState<EventItem[]>([])
  const [publishedEventsLoading, setPublishedEventsLoading] = useState(false)
  const [publishedEventsError, setPublishedEventsError] = useState("")
  const [ownEvents, setOwnEvents] = useState<EventItem[]>([])
  const [eventsLoading, setEventsLoading] = useState(false)
  const [eventsError, setEventsError] = useState("")
  const eventList = useMemo(() => publishedEvents, [publishedEvents])
  const refreshRegistrationCounts = async (eventIds: string[]) => {
    const counts = await fetchEventRegistrationCounts([...new Set(eventIds)])
    const applyCounts = (events: EventItem[]) =>
      events.map((event) => {
        const count = counts.get(String(event.id))
        return count
          ? { ...event, seats: count.capacity, registeredCount: count.registeredCount }
          : event
      })
    setPublishedEvents(applyCounts)
    setOwnEvents(applyCounts)
    setPublishedEventsError("")
    setEventsError("")
  }
  const refreshRegistrationCountsRef = useRef(refreshRegistrationCounts)
  refreshRegistrationCountsRef.current = refreshRegistrationCounts
  const updateEventLists = (updatedEvent: EventItem) => {
    setOwnEvents((current) => {
      const exists = current.some((event) => event.id === updatedEvent.id)
      return exists
        ? current.map((event) => event.id === updatedEvent.id
            ? { ...updatedEvent, registeredCount: updatedEvent.registeredCount ?? event.registeredCount }
            : event)
        : [{ ...updatedEvent, registeredCount: updatedEvent.registeredCount ?? 0 }, ...current]
    })
    setPublishedEvents((current) => {
      if (updatedEvent.status !== "published") {
        return current.filter((event) => event.id !== updatedEvent.id)
      }
      const exists = current.some((event) => event.id === updatedEvent.id)
      const next = exists
        ? current.map((event) => event.id === updatedEvent.id
            ? { ...updatedEvent, registeredCount: updatedEvent.registeredCount ?? event.registeredCount }
            : event)
        : [...current, { ...updatedEvent, registeredCount: updatedEvent.registeredCount ?? 0 }]
      return next.sort((left, right) =>
        (left.eventDate || "").localeCompare(right.eventDate || ""),
      )
    })
  }
  const [selectedEventId, setSelectedEventId] = useState<EventItem["id"] | null>(null)
  const selectedEvent =
    eventList.find((event) => event.id === selectedEventId) ||
    ownEvents.find((event) => event.id === selectedEventId) ||
    eventList[0]
  const [participantRegistrations, setParticipantRegistrations] = useState<RegistrationRecord[]>([])
  const [participantRegistrationsLoading, setParticipantRegistrationsLoading] = useState(false)
  const [participantRegistrationsError, setParticipantRegistrationsError] = useState("")
  const [detailRegistrationLoading, setDetailRegistrationLoading] = useState(false)
  const [organizerRegistrations, setOrganizerRegistrations] = useState<RegistrationRecord[]>([])
  const [organizerRegistrationsLoading, setOrganizerRegistrationsLoading] = useState(false)
  const [organizerRegistrationsError, setOrganizerRegistrationsError] = useState("")
  const [latestRegistrationId, setLatestRegistrationId] = useState("")
  const [notifications] = useState(0)
  useEffect(() => {
    let active = true
    const loadPublishedEvents = async () => {
      setPublishedEventsLoading(true)
      setPublishedEventsError("")
      setPublishedEvents([])
      try {
        const selectColumns = await eventSelectColumns()
        const { data, error } = await supabase
          .from("events")
          .select(selectColumns)
          .eq("status", "published")
          .order("event_date", { ascending: true })
        if (error) throw error
        const events = await loadEventRegistrationCounts(
          (data || []).map((record) => eventFromRecord(eventRecordFromRow(record))),
        )
        if (active) setPublishedEvents(events)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not load published events."
        console.error("Could not load published events.", error)
        if (active) setPublishedEventsError(message)
      } finally {
        if (active) setPublishedEventsLoading(false)
      }
    }
    void loadPublishedEvents()
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (page !== "organizer" || !isApprovedOrganizer(profile)) return
    let active = true
    const loadOwnEvents = async () => {
      setEventsLoading(true)
      setEventsError("")
      setOwnEvents([])
      setOrganizerRegistrationsLoading(true)
      setOrganizerRegistrationsError("")
      setOrganizerRegistrations([])
      try {
        const organizerId = await getApprovedOrganizerId()
        const selectColumns = await eventSelectColumns()
        const { data, error } = await supabase
          .from("events")
          .select(selectColumns)
          .eq("organizer_id", organizerId)
          .order("event_date", { ascending: true })
        if (error) throw error
        const eventRecords = (data || []).map(eventRecordFromRow)
        const organizerEvents = await loadEventRegistrationCounts(
          eventRecords.map(eventFromRecord),
        )
        if (active) setOwnEvents(organizerEvents)
        const { data: registrationRows, error: registrationError } = await supabase.rpc("get_organizer_registrations")
        if (registrationError) throw registrationError
        const mapped = ((registrationRows || []) as OrganizerRegistrationRow[]).map(organizerRegistrationFromRow)
        if (active) setOrganizerRegistrations(mapped)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not load your events."
        console.error("Could not load organizer events.", error)
        if (active) {
          setEventsError(message)
          setOrganizerRegistrationsError(message)
        }
      } finally {
        if (active) {
          setEventsLoading(false)
          setOrganizerRegistrationsLoading(false)
        }
      }
    }
    setOrganizerRegistrationsLoading(true)
    setOrganizerRegistrationsError("")
    void loadOwnEvents()
    return () => {
      active = false
    }
  }, [page, profile])
  const eventCountChannelKey = useMemo(
    () => [...new Set([...publishedEvents, ...ownEvents].map((event) => String(event.id)))].join("|"),
    [publishedEvents, ownEvents],
  )
  useEffect(() => {
    if (!eventCountChannelKey) return
    const channels = eventCountChannelKey.split("|").map((eventId) =>
      supabase
        .channel(`event-registration-counts:${eventId}`)
        .on("broadcast", { event: "registration_changed" }, () => {
          void refreshRegistrationCountsRef.current([eventId]).catch((error: unknown) => {
            const message = error instanceof Error
              ? error.message
              : "Could not refresh event registration counts."
            console.error(message, error)
            setPublishedEventsError(message)
            setEventsError(message)
          })
        })
        .subscribe((status) => {
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            const message = `Realtime registration counts are unavailable for event ${eventId}.`
            console.error(message)
            setPublishedEventsError(message)
            setEventsError(message)
          }
        }),
    )
    return () => {
      channels.forEach((channel) => {
        void supabase.removeChannel(channel)
      })
    }
  }, [eventCountChannelKey])
  useEffect(() => {
    if (
      (page !== "dashboard" && page !== "details") ||
      profile?.role !== "participant"
    ) {
      setDetailRegistrationLoading(false)
      return
    }
    let active = true
    let registrationChannel: ReturnType<typeof supabase.channel> | undefined
    const loadParticipantRegistrations = async (participantId: string) => {
      setParticipantRegistrationsLoading(true)
      setParticipantRegistrationsError("")
      try {
        const { data: registrationRows, error: registrationError } = await supabase
          .from("registrations")
          .select("id, event_id, participant_id, status, registered_at")
          .eq("participant_id", participantId)
          .order("registered_at", { ascending: false })
        if (registrationError) throw registrationError
        const rows = (registrationRows || []) as RegistrationRow[]
        const eventIds = [...new Set(rows.map((row) => row.event_id))]
        const { data: eventRecords, error: eventsError } = eventIds.length
          ? await supabase
              .from("events")
              .select("id, title, description, venue, event_date, start_time, end_time, registration_deadline, capacity, organizer_id, status")
              .in("id", eventIds)
          : { data: [], error: null }
        if (eventsError) throw eventsError
        const eventMap = new Map((eventRecords || []).map((record) => {
          const eventRecord = eventRecordFromRow(record)
          return [eventRecord.id, eventRecord]
        }))
        const currentProfile = profileRef.current
        const participantData = {
          full_name: currentProfile?.fullName,
          email: currentProfile?.email,
          phone: currentProfile?.phone,
          organization: currentProfile?.organization,
        }
        const mapped = rows.flatMap((row) => {
          const eventRecord = eventMap.get(row.event_id)
          return eventRecord ? [registrationFromRows(row, eventRecord, participantData)] : []
        })
        if (active) setParticipantRegistrations(mapped)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not load your registration history."
        console.error("Could not load participant registrations.", error)
        if (active) setParticipantRegistrationsError(message)
      } finally {
        if (active) {
          setParticipantRegistrationsLoading(false)
          setDetailRegistrationLoading(false)
        }
      }
    }
    const initializeParticipantRegistrations = async () => {
      setDetailRegistrationLoading(true)
      try {
        const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
        if (sessionError) throw sessionError
        if (!sessionData.session) throw new Error("Please sign in again to view your registrations.")
        if (profileRef.current?.role !== "participant") {
          throw new Error("Only participant accounts can view registration history.")
        }
        const participantId = sessionData.session.user.id
        registrationChannel = supabase
          .channel(`participant-registrations:${participantId}`)
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "registrations",
              filter: `participant_id=eq.${participantId}`,
            },
            () => { void loadParticipantRegistrations(participantId) },
          )
          .subscribe((status) => {
            if (!active) return
            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
              const message = "Live registration status updates are unavailable. Your status will refresh when you revisit this page."
              console.error(message)
              setParticipantRegistrationsError(message)
            }
          })
        await loadParticipantRegistrations(participantId)
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : "Could not verify your participant session."
        if (active) {
          setParticipantRegistrationsError(message)
          setDetailRegistrationLoading(false)
          setParticipantRegistrationsLoading(false)
        }
      }
    }
    void initializeParticipantRegistrations()
    return () => {
      active = false
      if (registrationChannel) void supabase.removeChannel(registrationChannel)
    }
  }, [page, profile])
  const authenticate = async (
    email: string,
    password: string,
    details: ProfileDetails = {},
    role: UserRole = "participant",
    mode: "login" | "signup" = "login",
  ): Promise<AuthenticationResult> => {
    const normalizedEmail = email.trim().toLowerCase()
    setAuthError("")
    if (mode === "signup") {
      const { data, error } = await supabase.auth.signUp({
        email: normalizedEmail,
        password,
        options: {
          emailRedirectTo: emailConfirmationRedirectTo(),
          data: {
            account_type: role,
            full_name: details.fullName?.trim() || "",
            phone: details.phone?.trim() || "",
            organization: details.organization?.trim() || "",
          },
        },
      })
      if (error) throw new Error(error.message)
      if (!data.user) throw new Error("Account creation did not return a user.")
      if (!data.session) {
        return {
          status: role === "organizer" ? "organizer-confirmation" : "confirmation",
          email: normalizedEmail,
          accountAlreadyExists: Array.isArray(data.user.identities) &&
            data.user.identities.length === 0,
        }
      }
      const nextProfile = await fetchProfile(data.user.id)
      profileRef.current = nextProfile
      setProfile(nextProfile)
      setAuthError("")
      if (nextProfile.role === "organizer" && nextProfile.organizerStatus !== "approved") {
        setPage("organizer-login")
        setAuthError(organizerAccessMessage(nextProfile))
      } else {
        setPage(nextProfile.role === "organizer" ? "organizer" : "dashboard")
      }
      window.scrollTo({ top: 0, behavior: "smooth" })
      return { status: "authenticated" }
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    })
    if (error) throw new Error(error.message)
    if (!data.user) throw new Error("Sign in did not return an authenticated user.")
    const nextProfile = await fetchProfile(data.user.id)
    if (role === "organizer" && nextProfile.organizerStatus === "pending") {
      const statusMessage = "Your organizer application is pending approval."
      setAuthError(statusMessage)
      const { error: signOutError } = await supabase.auth.signOut()
      if (signOutError) {
        throw new Error(`${statusMessage} Sign-out also failed: ${signOutError.message}`)
      }
      throw new Error(statusMessage)
    }
    if (role === "organizer" && nextProfile.organizerStatus === "rejected") {
      const statusMessage = "Your organizer application has been rejected. Please contact the administrator."
      setAuthError(statusMessage)
      const { error: signOutError } = await supabase.auth.signOut()
      if (signOutError) {
        throw new Error(`${statusMessage} Sign-out also failed: ${signOutError.message}`)
      }
      throw new Error(statusMessage)
    }
    if (role === "organizer" && (nextProfile.role !== "organizer" || nextProfile.organizerStatus !== "approved")) {
      const accessMessage = "You do not have organizer access."
      setAuthError(accessMessage)
      const { error: signOutError } = await supabase.auth.signOut()
      if (signOutError) {
        throw new Error(`${accessMessage} Sign-out also failed: ${signOutError.message}`)
      }
      throw new Error(accessMessage)
    }
    if (role === "participant" && nextProfile.role !== "participant") {
      const mismatchMessage = "This account is registered as an organizer. Please use the organizer login portal."
      setAuthError(mismatchMessage)
      const { error: signOutError } = await supabase.auth.signOut()
      if (signOutError) {
        throw new Error(`${mismatchMessage} Sign-out also failed: ${signOutError.message}`)
      }
      throw new Error(mismatchMessage)
    }
    profileRef.current = nextProfile
    setProfile(nextProfile)
    setAuthError("")
    setVerificationIssue(false)
    setPage(nextProfile.role === "organizer" ? "organizer" : "dashboard")
    window.scrollTo({ top: 0, behavior: "smooth" })
    return { status: "authenticated" }
  }
  const resendVerificationEmail = async (email: string) => {
    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new Error("Enter a valid email address before requesting verification.")
    }
    const { error } = await supabase.auth.resend({
      type: "signup",
      email: normalizedEmail,
      options: { emailRedirectTo: emailConfirmationRedirectTo() },
    })
    if (error) {
      if (/rate limit|too many requests/i.test(error.message)) {
        throw new Error("Supabase is temporarily limiting verification emails. Wait a minute before trying again.")
      }
      throw new Error(`Unable to request a verification email: ${error.message}`)
    }
  }
  const saveProfile = (nextProfile: UserProfile) => {
    const currentProfile = profileRef.current
    if (!currentProfile) return
    const safeProfile = {
      ...nextProfile,
      role: currentProfile.role,
      organizerStatus: currentProfile.organizerStatus,
    }
    profileRef.current = safeProfile
    setProfile(safeProfile)
  }
  const logout = async () => {
    const { error } = await supabase.auth.signOut()
    if (error) {
      const message = `Unable to log out: ${error.message}`
      setAuthError(message)
      console.error(message)
      return
    }
    profileRef.current = null
    setProfile(null)
    setPage("login")
    setAuthError("")
  }
  const go = (next: Page) => {
    const currentProfile = profileRef.current
    let destination = next
    if (next === "organizer" && !isApprovedOrganizer(currentProfile)) {
      destination = "organizer-login"
      if (currentProfile) setAuthError(organizerAccessMessage(currentProfile))
    } else if (next === "profile" && currentProfile?.role !== "participant") {
      destination = "participant-login"
    } else if (
      next === "dashboard" &&
      currentProfile?.role !== "participant" &&
      !isApprovedOrganizer(currentProfile)
    ) {
      destination = "participant-login"
    }
    setPage(destination)
    window.scrollTo({ top: 0, behavior: "smooth" })
  }
  useEffect(() => {
    if (page === "organizer" && !isApprovedOrganizer(profile)) {
      setPage("organizer-login")
      if (profile) setAuthError(organizerAccessMessage(profile))
    } else if (page === "profile" && profile?.role !== "participant") {
      setPage("participant-login")
    } else if (
      page === "dashboard" &&
      profile?.role !== "participant" &&
      !isApprovedOrganizer(profile)
    ) {
      setPage("participant-login")
    }
  }, [page, profile])
  const toggleSave = (id: EventItem["id"]) =>
    setSaved((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    )
  const publishEvent = async (
      event: NewEventInput,
      status: EventStatus,
      eventId?: string,
      imageFile?: File | null,
      removeImage = false,
      changedFields?: EventFormField[],
      people: EventPerson[] = [],
  ) => {
      const organizerId = await getApprovedOrganizerId()
      const imageColumn = await getEventImageColumn()
      let uploadedImagePath: string | null = null
      let imageUrl: string | null = null
      if (imageFile) {
        const extension = imageFile.name.split(".").pop()?.toLowerCase()
        const mimeTypeByExtension: Record<string, string> = {
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          png: "image/png",
          webp: "image/webp",
        }
        const mimeType = extension ? mimeTypeByExtension[extension] : undefined
        if (!extension || !mimeType || (imageFile.type && imageFile.type !== mimeType)) {
          throw new Error("Choose a valid JPG, JPEG, PNG, or WEBP image.")
        }
        uploadedImagePath = `${organizerId}/${crypto.randomUUID()}.${extension}`
        const { error: uploadError } = await supabase.storage
          .from("event-images")
          .upload(uploadedImagePath, imageFile, {
            cacheControl: "3600",
            contentType: mimeType,
            upsert: false,
          })
        if (uploadError) {
          uploadedImagePath = null
          throw new Error(`Could not upload the event image: ${uploadError.message}`)
        }
        imageUrl = supabase.storage
          .from("event-images")
          .getPublicUrl(uploadedImagePath).data.publicUrl
        if (!imageUrl) {
          const { error: cleanupError } = await supabase.storage
            .from("event-images")
            .remove([uploadedImagePath])
          uploadedImagePath = null
          throw new Error(
            cleanupError
              ? `Could not create the event image URL, and upload cleanup failed: ${cleanupError.message}`
              : "Could not create a public URL for the uploaded event image.",
          )
        }
      }
      const eventValuesByColumn: Record<string, unknown> = {
        title: event.title,
        description: event.description,
        venue: event.venue,
        event_date: event.eventDate,
        start_time: event.startTime || null,
        end_time: event.endTime || null,
        registration_deadline: event.registrationDeadline,
        capacity: event.capacity,
      }
      const fieldColumns: Record<keyof NewEventInput, string> = {
        title: "title",
        description: "description",
        venue: "venue",
        eventDate: "event_date",
        registrationDeadline: "registration_deadline",
        capacity: "capacity",
        startTime: "start_time",
        endTime: "end_time",
      }
      const changedValues: Record<string, unknown> = eventId
        ? {}
        : { ...eventValuesByColumn, status }
      if (eventId) {
        for (const field of changedFields ?? eventFormFields) {
          if (field === "status") {
            changedValues.status = status
          } else {
            const column = fieldColumns[field]
            changedValues[column] = eventValuesByColumn[column]
          }
        }
      }
      const valuesWithImage: Record<string, unknown> = {
        ...changedValues,
        ...(imageFile || removeImage
          ? { [imageColumn]: imageFile ? imageUrl : null }
          : {}),
      }
      let savedEvent: EventItem | null = null
      try {
        const selectColumns = await eventSelectColumns()
        if (eventId && Object.keys(valuesWithImage).length === 0) {
          const { data, error } = await supabase
            .from("events")
            .select(selectColumns)
            .eq("id", eventId)
            .eq("organizer_id", organizerId)
            .single()
          if (error) throw new Error(`Could not reload the event: ${error.message}`)
          savedEvent = eventFromRecord(eventRecordFromRow(data))
        } else {
          const request = eventId
            ? supabase
                .from("events")
                .update(valuesWithImage)
                .eq("id", eventId)
                .eq("organizer_id", organizerId)
            : supabase.from("events").insert({
                ...valuesWithImage,
                organizer_id: organizerId,
              })
          const { data, error } = await request
            .select(selectColumns)
            .single()
          if (error) throw new Error(`Could not ${eventId ? "update" : "save"} the event: ${error.message}`)
          savedEvent = eventFromRecord(eventRecordFromRow(data))
        }
        updateEventLists(savedEvent)
      } catch (saveError) {
        if (uploadedImagePath) {
          const { error: cleanupError } = await supabase.storage
            .from("event-images")
            .remove([uploadedImagePath])
          const message = saveError instanceof Error ? saveError.message : "Could not save event."
          if (cleanupError) {
            throw new Error(`${message} The uploaded image could not be cleaned up: ${cleanupError.message}`)
          }
          throw new Error(`${message} The uploaded image was cleaned up.`)
        }
        throw saveError
      }
      if (!savedEvent || typeof savedEvent.id !== "string") {
        throw new Error("Supabase saved the event but returned no valid event ID.")
      }
      let savedPeople: EventPerson[]
      try {
        savedPeople = await saveEventPeople(savedEvent.id, people)
      } catch (peopleError) {
        const message = peopleError instanceof Error
          ? peopleError.message
          : "Could not save mentors and speakers."
        throw new EventPeopleSaveError(
          `Event saved, but ${message} Retry to finish saving these profiles.`,
          savedEvent.id,
          savedEvent.imageUrl || null,
          savedEvent.status || status,
        )
      }
      return {
        eventId: savedEvent.id,
        imageUrl: savedEvent.imageUrl || null,
        status: savedEvent.status || status,
        people: savedPeople,
      }
  }
  const updateEventStatus = async (event: EventItem, status: EventStatus) => {
    if (typeof event.id !== "string") throw new Error("This event cannot be updated.")
    const organizerId = await getApprovedOrganizerId()
    const selectColumns = await eventSelectColumns()
    const { data, error } = await supabase
      .from("events")
      .update({ status })
      .eq("id", event.id)
      .eq("organizer_id", organizerId)
      .select(selectColumns)
      .single()
    if (error) throw new Error(`Could not update event status: ${error.message}`)
    updateEventLists(eventFromRecord(eventRecordFromRow(data)))
  }
  const cancelEvent = async (event: EventItem) => {
    try {
      await updateEventStatus(event, "cancelled")
    } catch (error) {
      throw new Error(`Could not cancel the event: ${error instanceof Error ? error.message : "unknown error"}`)
    }
  }
  const dashboardPage =
    page === "dashboard" || page === "profile" || page === "organizer" || page === "admin"
  const authPage =
    page === "login" ||
    page === "participant-login" ||
    page === "organizer-login" ||
    page === "signup" ||
    page === "organizer-signup" ||
    page === "participant-signup"
  const getParticipantId = async () => {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
    if (sessionError) throw new Error(`Could not verify your session: ${sessionError.message}`)
    if (!sessionData.session) throw new Error("Please sign in before registering for an event.")
    const participantId = sessionData.session.user.id
    const { data: participantProfile, error: profileError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", participantId)
      .maybeSingle()
    if (profileError) throw new Error(`Could not verify your account: ${profileError.message}`)
    if (participantProfile?.role !== "participant") {
      throw new Error("Only participant accounts can register for events.")
    }
    return participantId
  }
  const registerForEvent = async (event: EventItem): Promise<string> => {
    if (typeof event.id !== "string" || event.status !== "published") {
      throw new Error("This event is not available for registration.")
    }
    if ((event.registeredCount ?? 0) >= event.seats) {
      throw new Error("This event is fully booked.")
    }
    if (registrationDeadlinePassed(event.registrationDeadline)) {
      throw new Error("The registration deadline for this event has passed.")
    }
    const participantId = await getParticipantId()
    const { data: existingRegistration, error: existingError } = await supabase
      .from("registrations")
      .select("id")
      .eq("event_id", event.id)
      .eq("participant_id", participantId)
      .limit(1)
      .maybeSingle()
    if (existingError) throw new Error(`Could not check your existing registration: ${existingError.message}`)
    if (existingRegistration) throw new Error("You have already registered for this event.")
    const { data, error } = await supabase
      .from("registrations")
      .insert({
        event_id: event.id,
        participant_id: participantId,
        status: "pending",
      })
      .select("id, event_id, participant_id, status, registered_at")
      .single()
    if (error) {
      if (error.code === "23505") throw new Error("You have already registered for this event.")
      if (error.code === "23514" && /EVENT_FULL/i.test(error.message)) {
        throw new Error("This event has just reached capacity. No additional registrations are available.")
      }
      throw new Error(`Could not submit your registration: ${error.message}`)
    }
    const currentProfile = profileRef.current
    const eventRecord: EventRecord = {
      id: event.id,
      title: event.title,
      description: event.description || null,
      venue: event.location,
      event_date: event.eventDate || "",
      start_time: null,
      end_time: null,
      registration_deadline: event.registrationDeadline || "",
      capacity: event.seats,
      organizer_id: "",
      status: event.status,
    }
    const newRegistration = registrationFromRows(data as RegistrationRow, eventRecord, {
      full_name: currentProfile?.fullName,
      email: currentProfile?.email,
      phone: currentProfile?.phone,
      organization: currentProfile?.organization,
    })
    setParticipantRegistrations((current) => [newRegistration, ...current])
    const incrementCount = (events: EventItem[]) =>
      events.map((item) => item.id === event.id
        ? { ...item, registeredCount: (item.registeredCount ?? 0) + 1 }
        : item)
    setPublishedEvents(incrementCount)
    setOwnEvents(incrementCount)
    void refreshRegistrationCounts([event.id]).catch((countError: unknown) => {
      const message = countError instanceof Error
        ? countError.message
        : "Could not refresh event registration counts."
      console.error(message, countError)
      setPublishedEventsError(message)
      setEventsError(message)
    })
    setLatestRegistrationId(data.id)
    return data.id
  }
  const submitRegistration = async (_draft: RegistrationDraft, event: EventItem) =>
    registerForEvent(event)
  const updateRegistration = async (id: string, status: RegistrationStatus) => {
    const organizerId = await getApprovedOrganizerId()
    const { data: organizerEventsData, error: organizerEventsError } = await supabase
      .from("events")
      .select("id")
      .eq("organizer_id", organizerId)
    if (organizerEventsError) throw new Error(`Could not verify event ownership: ${organizerEventsError.message}`)
    const eventIds = (organizerEventsData || []).map((item) => item.id)
    if (!eventIds.length) throw new Error("No organizer events are available for this registration.")
    const { data, error } = await supabase
      .from("registrations")
      .update({ status: status.toLowerCase() })
      .eq("id", id)
      .in("event_id", eventIds)
      .select("id, event_id, participant_id, status, registered_at")
      .single()
    if (error) throw new Error(`Could not update registration status: ${error.message}`)
    const existing = organizerRegistrations.find((record) => record.id === id)
    if (!existing) throw new Error("This registration is not part of your events.")
    setOrganizerRegistrations((current) =>
      current.map((record) => record.id === id ? { ...record, status: data.status === "approved" ? "Approved" : data.status === "rejected" ? "Rejected" : "Pending" } : record),
    )
    void refreshRegistrationCounts([data.event_id]).catch((countError: unknown) => {
      const message = countError instanceof Error
        ? countError.message
        : "Could not refresh event registration counts."
      console.error(message, countError)
      setEventsError(message)
    })
  }
  return (
    <div className="app">
      {!dashboardPage && !authPage && (
        <Header
          go={go}
          active={page}
          notifications={notifications}
          profile={profile}
          onLogout={logout}
        />
      )}
      {page === "home" && (
        <Home
          go={go}
          eventList={eventList}
          selectEvent={setSelectedEventId}
          saved={saved}
          toggleSave={toggleSave}
          profile={profile}
          eventsLoading={publishedEventsLoading}
          eventsError={publishedEventsError}
          continueAs={(role) => go(role === "organizer" ? "organizer" : "dashboard")}
        />
      )}
      {page === "explore" && (
        <Explore
          go={go}
          eventList={eventList}
          selectEvent={setSelectedEventId}
          saved={saved}
          toggleSave={toggleSave}
          eventsLoading={publishedEventsLoading}
          eventsError={publishedEventsError}
        />
      )}
      {page === "details" && selectedEvent && (
        <Details
          go={go}
          eventList={eventList}
          event={selectedEvent}
          participantRegistration={profile?.role === "participant"
            ? participantRegistrations.find(
                (registration) => String(registration.eventId) === String(selectedEvent.id),
              )
            : undefined}
          registrationLoading={
            profile?.role === "participant" &&
            (detailRegistrationLoading || participantRegistrationsLoading)
          }
          registrationError={
            profile?.role === "participant" ? participantRegistrationsError : ""
          }
          selectEvent={setSelectedEventId}
          saved={saved}
          toggleSave={toggleSave}
        />
      )}
      {(page === "login" ||
        page === "participant-login" ||
        page === "organizer-login") && (
        <RoleGateway
          go={go}
          selectedRole={
            page === "organizer-login"
              ? "organizer"
              : page === "participant-login"
                ? "participant"
                : undefined
          }
          onSignIn={async (email, password, role) => {
            await authenticate(email, password, {}, role, "login")
          }}
          onResendVerification={resendVerificationEmail}
          error={authError || undefined}
          verificationIssue={verificationIssue}
        />
      )}
      {page === "signup" && (
        <AuthPage
          mode="signup"
          go={go}
          onAuthenticate={authenticate}
          onResendVerification={resendVerificationEmail}
          role="participant"
        />
      )}
      {page === "organizer-signup" && (
        <AuthPage
          mode="signup"
          go={go}
          onAuthenticate={authenticate}
          onResendVerification={resendVerificationEmail}
          role="organizer"
        />
      )}
      {page === "participant-signup" && (
        <AuthPage
          mode="signup"
          go={go}
          onAuthenticate={authenticate}
          onResendVerification={resendVerificationEmail}
          role="participant"
        />
      )}
      {(page === "register" ||
        page === "review" ||
        page === "confirmation") && selectedEvent && (
        <Registration
          page={page}
          go={go}
          event={selectedEvent}
          onSubmit={submitRegistration}
          latestRegistrationId={latestRegistrationId}
          registrationError={participantRegistrationsError}
        />
      )}
      {(page === "register" || page === "review" || page === "confirmation") && !selectedEvent && (
        <main className="registration-page">
          <div className="container narrow-container empty-state">
            <h2>Event unavailable</h2>
            <p>This event is no longer available for registration.</p>
            <Button onClick={() => go("explore")}>Browse published events</Button>
          </div>
        </main>
      )}
      {(page === "dashboard" || page === "profile") &&
        (profile?.role === "participant" || (page === "dashboard" && isApprovedOrganizer(profile))) && (
        <Dashboard
          go={go}
          onLogout={logout}
          initialTab={page === "profile" ? "profile" : "dashboard"}
          saved={saved}
          toggleSave={toggleSave}
          registrations={participantRegistrations}
          profile={profile}
          saveProfile={saveProfile}
          publishedEvents={publishedEvents}
          eventsLoading={publishedEventsLoading}
          eventsError={publishedEventsError}
          registrationsLoading={participantRegistrationsLoading}
          registrationsError={participantRegistrationsError}
          onRegister={async (event) => { await registerForEvent(event) }}
        />
      )}
      {page === "organizer" && isApprovedOrganizer(profile) && (
        <Organizer
          go={go}
          onLogout={logout}
          registrations={organizerRegistrations}
          updateRegistration={updateRegistration}
          profile={profile}
          saveProfile={saveProfile}
          selectEvent={setSelectedEventId}
          onPublishEvent={publishEvent}
          onPublishDraft={(event) => updateEventStatus(event, "published")}
          onCompleteEvent={(event) => updateEventStatus(event, "completed")}
          ownEvents={ownEvents}
          eventsLoading={eventsLoading}
          eventsError={eventsError}
          onCancelEvent={cancelEvent}
          registrationsLoading={organizerRegistrationsLoading}
          registrationsError={organizerRegistrationsError}
        />
      )}
      {page === "admin" && <Admin go={go} onLogout={logout} />}
      {page === "notifications" && <Notifications />}
    </div>
  )
}
