// Person anchors — rebuild-proof identity signatures.
//
// Canonical ids renumber on every build-db (ordinal assignment) and folds
// vanish until merges re-apply. Names and handles survive. An anchor is the
// durable signature of a person captured at annotation time; resolveAnchor
// re-finds their current canonical_id after a rebuild. Ambiguity returns
// null — a detached annotation is recoverable, a mis-attached one is not.

const HANDLE_RE = /^(\+?[\d\s()-]{6,}|[^@\s]+@[^@\s]+\.[^@\s]+)$/;

/** True for phone/email-shaped strings — an identity displayed as a bare
 * handle is someone (or something) known by no name. */
export function isHandle(s) {
  return HANDLE_RE.test(String(s ?? ''));
}

function toArray(v) {
  return Array.isArray(v) ? v : (v?.items ?? []);
}

/** Split an identity row into name-like and handle-like (phone/email) parts. */
export function buildAnchor(identity) {
  const seen = new Set();
  const names = [];
  const handles = [];
  for (const value of [identity.display_name, ...toArray(identity.aliases)]) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    (HANDLE_RE.test(value) ? handles : names).push(value);
  }
  return { names, handles };
}

function uniqueMatch(candidates) {
  const ids = [...new Set(candidates)];
  return ids.length === 1 ? ids[0] : null;
}

/**
 * Resolve an anchor against the live identities list.
 * Priority: unique display_name → unique alias → unique handle.
 * Every tier is case-insensitive; any ambiguity yields null.
 */
export function resolveAnchor(anchor, identities) {
  const lower = (s) => String(s).toLowerCase();
  const names = (anchor.names ?? []).map(lower);
  const handles = (anchor.handles ?? []).map(lower);

  const byDisplay = identities.filter((i) => names.includes(lower(i.display_name)));
  const displayHit = uniqueMatch(byDisplay.map((i) => i.canonical_id));
  if (displayHit) return displayHit;
  if (byDisplay.length > 1) return null;

  const byAlias = identities.filter((i) =>
    toArray(i.aliases).some((a) => names.includes(lower(a))));
  const aliasHit = uniqueMatch(byAlias.map((i) => i.canonical_id));
  if (aliasHit) return aliasHit;
  if (byAlias.length > 1) return null;

  const byHandle = identities.filter((i) =>
    toArray(i.aliases).some((a) => handles.includes(lower(a))));
  return uniqueMatch(byHandle.map((i) => i.canonical_id));
}
