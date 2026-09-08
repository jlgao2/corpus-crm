// Partiful email parser — invites/updates arrive by mail; the event id is
// the partiful.com/e/<id> link. Field extraction is deliberately loose
// (subjects and bodies shift); the event id + email timestamp are the only
// hard requirements. Validated against real mail on first fetch — extend
// the patterns as real samples land.

const EVENT_URL_RE = /https:\/\/partiful\.com\/e\/([A-Za-z0-9_-]+)/;

/**
 * Public event pages embed the full event object in __NEXT_DATA__ — title,
 * start/end, timezone, description, hosts, guest counts — no auth needed.
 * (Discovered via cerebralvalley/partiful-api; their cheerio selectors are
 * fragile, the Next data blob is not.)
 */
export function parsePartifulEventPage(html, eventId) {
  const m = String(html ?? '').match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>(.*?)<\/script>/s);
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch { return null; }
  const pageProps = data?.props?.pageProps;
  const event = pageProps?.event;
  if (!event?.title) return null;
  const counts = event.guestStatusCounts ?? {};
  return {
    event_id: `partiful:${eventId}`,
    url: `https://partiful.com/e/${eventId}`,
    name: event.title,
    start_ts: event.startDate ? Date.parse(event.startDate) : null,
    end_ts: event.endDate ? Date.parse(event.endDate) : null,
    timezone: event.timezone ?? null,
    description: (event.description ?? '').slice(0, 500) || null,
    // pageProps.hosts is null on public fetches (the host list renders
    // client-side behind auth), but ownerIds is always present — stable
    // per-person ids that group a host's events even before a name is known.
    host: pageProps.hosts?.[0]?.name ?? null,
    owner_ids: Array.isArray(event.ownerIds) ? event.ownerIds : [],
    going: counts.GOING ?? null,
    maybe: counts.MAYBE ?? null,
    declined: counts.DECLINED ?? null,
    waitlist: counts.WAITLIST ?? null,
    interested: counts.INTERESTED ?? null,
    attended: event.attendedGuestCount ?? null,
    // Whether a guest list exists to fetch at all, and whether the host
    // chose to show it — the authed guest-list pass reads these first.
    has_guests: event.hasGuests ?? null,
    show_guest_list: event.showGuestList ?? null,
    visibility: event.visibility ?? null,
    status: event.status ?? null,
    kind: 'page',
    email_ts: Date.now(),
  };
}

export function parsePartifulEmail({ from, subject, date, text }) {
  if (!/partiful\.com/i.test(String(from ?? ''))) return null;
  const urlMatch = String(text ?? '').match(EVENT_URL_RE);
  if (!urlMatch) return null;

  const subj = String(subject ?? '').trim();
  let kind = 'other';
  let name = subj;
  let match;
  if ((match = subj.match(/^You're invited to (.+)$/i))) { kind = 'invite'; name = match[1]; }
  else if ((match = subj.match(/^Update for (.+)$/i))) { kind = 'update'; name = match[1]; }
  else if ((match = subj.match(/^Reminder: (.+)$/i))) { kind = 'reminder'; name = match[1]; }

  const hostMatch = String(text ?? '').match(/^(\S+) invited you to /m);

  return {
    event_id: `partiful:${urlMatch[1]}`,
    url: `https://partiful.com/e/${urlMatch[1]}`,
    name: name.trim(),
    host: hostMatch ? hostMatch[1] : null,
    kind,
    email_ts: Date.parse(date) || Date.now(),
  };
}
