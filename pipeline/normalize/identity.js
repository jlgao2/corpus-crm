/**
 * Cross-channel identity resolution.
 *
 * Given threads from multiple sources and a vcf-derived name map, fold them
 * into canonical Identity records. The same person across iMessage / Instagram
 * / WhatsApp / Messenger gets one canonical record.
 *
 * Resolution rules:
 * - iMessage threads: filename is phone or email. Look up in vcf.
 * - Instagram threads: participant name is the IG display name (often emoji).
 *   Match to vcf names by exact display-name match if available, else keep as-is.
 * - WhatsApp/Messenger: same approach as Instagram.
 *
 * Two identities merge if any alias matches (case-insensitive). Display name
 * preference order: vcf-resolved name > IG display name > raw alias.
 */

function digitsOnly(s) {
  return (s || '').replace(/\D/g, '');
}

function normalizeAlias(alias, source) {
  if (alias == null) return { kind: 'name', value: '(unknown)' };
  const a = String(alias).trim();
  if (!a) return { kind: 'name', value: '(unknown)' };
  if (source === 'imessage' || source === 'gmail') {
    // Phone: normalize to +<digits>
    if (/^\+?\d/.test(a)) {
      const d = digitsOnly(a);
      if (d.length >= 7) return { kind: 'phone', value: '+' + d };
    }
    // Email
    if (a.includes('@')) return { kind: 'email', value: a.toLowerCase() };
  }
  return { kind: 'name', value: a };
}

// Match key is case-insensitive so name-variants ("Marcus Chen" / "Marcus Chen")
// resolve to the same identity. (email is already lowercased; phone is digits.)
function aliasKey(alias) {
  return `${alias.kind}:${String(alias.value).toLowerCase()}`;
}

export function resolveIdentities(threads, contacts) {
  // identityMap: aliasKey -> identity object (shared by reference for merged ones)
  const aliasMap = new Map();
  const identities = [];

  function addAlias(identity, alias) {
    const k = aliasKey(alias);
    if (!aliasMap.has(k)) aliasMap.set(k, identity);
    // Keep the surface form (including alternate-case variants) for display-name selection.
    if (!identity.aliases.includes(alias.value)) identity.aliases.push(alias.value);
  }

  function findOrCreate(aliases, source) {
    // Look for existing identity that shares any alias
    for (const al of aliases) {
      const k = aliasKey(al);
      if (aliasMap.has(k)) {
        const existing = aliasMap.get(k);
        if (!existing.sources.includes(source)) existing.sources.push(source);
        for (const a of aliases) addAlias(existing, a);
        return existing;
      }
    }
    // Create new
    const id = {
      canonicalId: `id-${identities.length + 1}`,
      displayName: null,
      aliases: [],
      sources: [source],
    };
    for (const a of aliases) addAlias(id, a);
    identities.push(id);
    return id;
  }

  // First pass: build identities from 1-on-1 threads
  for (const thread of threads) {
    if (thread.isGroup) continue;
    if (!thread.participants || thread.participants.length === 0) continue;
    const otherName = thread.participants[0];
    if (!otherName) continue;
    const aliases = [normalizeAlias(otherName, thread.sources[0])];

    // For iMessage and Gmail: try contacts lookup to add a resolved name alias.
    if (thread.sources[0] === 'imessage' || thread.sources[0] === 'gmail') {
      const phoneAlias = aliases.find(a => a.kind === 'phone');
      const emailAlias = aliases.find(a => a.kind === 'email');
      let resolved = null;
      if (phoneAlias && contacts.phones[phoneAlias.value]) resolved = contacts.phones[phoneAlias.value];
      else if (emailAlias && contacts.emails[emailAlias.value]) resolved = contacts.emails[emailAlias.value];
      if (resolved) aliases.push({ kind: 'name', value: resolved });
      // Gmail also carries the sender's display name from the email header — add it
      // as a name alias so the person merges with the same name on other channels.
      if (thread.sources[0] === 'gmail' && thread.otherDisplayName) {
        aliases.push({ kind: 'name', value: thread.otherDisplayName });
      }
    }

    findOrCreate(aliases, thread.sources[0]);
  }

  // Display name resolution
  for (const id of identities) {
    // Prefer a real-looking name (letters, spaces, no digits) over phone/email/emoji
    const namelike = id.aliases
      .filter(a => /\p{L}/u.test(a) && !/^\+?\d/.test(a) && !a.includes('@'));
    // Prefer a full name (Latin letters + a space); among candidates prefer a
    // properly-cased (uppercase-initial) variant over an all-lowercase one.
    const fullNames = namelike.filter(a => /\s/.test(a) && /^[A-Za-z]/.test(a));
    const fullName = fullNames.find(a => /^[A-Z]/.test(a)) || fullNames[0];
    id.displayName = fullName || namelike.find(a => /^[A-Z]/.test(a)) || namelike[0] || id.aliases[0];
  }

  // Attach identity reference to each 1-on-1 thread
  for (const thread of threads) {
    if (thread.isGroup) continue;
    const otherName = thread.participants[0];
    const al = normalizeAlias(otherName, thread.sources[0]);
    const k = aliasKey(al);
    thread.other = aliasMap.get(k) || null;
  }

  return { identities, aliasMap };
}

export function mergeThreadsByIdentity(threads) {
  // For 1-on-1 threads belonging to the same identity, combine their messages
  // into a single virtual "person view" while keeping per-source threads separate.
  const byIdentity = new Map();
  for (const t of threads) {
    if (t.isGroup || !t.other) continue;
    const id = t.other.canonicalId;
    if (!byIdentity.has(id)) {
      byIdentity.set(id, {
        identity: t.other,
        threads: [],
        allMessages: [],
        sources: new Set(),
      });
    }
    const entry = byIdentity.get(id);
    entry.threads.push(t);
    entry.allMessages.push(...t.messages);
    for (const s of t.sources) entry.sources.add(s);
  }
  for (const entry of byIdentity.values()) {
    entry.allMessages.sort((a, b) => a.ts - b.ts);
    entry.sources = [...entry.sources];
  }
  return byIdentity;
}
