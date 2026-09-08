function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Absolute asset path → the base64url key serve.js's /thumb and /photo routes take. */
export function photoKey(assetPath) {
  return Buffer.from(String(assetPath)).toString('base64url');
}

/** Stills can be thumbnailed; these can't. */
export function isVideo(assetPath) {
  return /\.(mov|mp4|m4v|avi|3gp|mkv)$/i.test(String(assetPath));
}

/**
 * @param {Object} event - { event_id, start_ts, end_ts, place_name, participants, summary? }
 * @param {Array} photos - sorted by ts: { id, asset_path, ts, place_name? }
 * @param {Array} messages - sorted by ts: { ts, from_me, sender_name, body }
 * @param {Object} idLookup - canonical_id -> display_name map (for participants)
 */
export function renderEventPage({ event, photos, messages, idLookup = {} }) {
  const startISO = new Date(Number(event.start_ts)).toISOString().slice(0, 16).replace('T', ' ');
  const endISO = new Date(Number(event.end_ts)).toISOString().slice(0, 16).replace('T', ' ');
  const title = event.summary || event.place_name || event.event_id;
  const participantLinks = (event.participants || []).map(id =>
    `<a href="/person?id=${encodeURIComponent(id)}">${escapeHtml(idLookup[id] || id)}</a>`);

  // Time-merged stream of photos and messages
  const stream = [
    ...photos.map(p => ({ kind: 'photo', ts: Number(p.ts), data: p })),
    ...messages.map(m => ({ kind: 'message', ts: Number(m.ts), data: m })),
  ].sort((a, b) => a.ts - b.ts);

  const items = stream.map(item => {
    const time = new Date(item.ts).toISOString().slice(11, 16);
    if (item.kind === 'photo') {
      const p = item.data;
      const place = p.place_name ? `<div class="caption-place">${escapeHtml(p.place_name)}</div>` : '';
      // Served URLs, not file:// — asset paths contain spaces ("Google Photos"),
      // which the old HTML-level file:// rewrite truncated, breaking every src.
      // Videos can't be thumbnailed (sips is stills-only), so they get a link
      // rather than a permanently broken <img>.
      const img = !p.asset_path ? ''
        : isVideo(p.asset_path)
          ? `<a class="video-item" href="/photo/${photoKey(p.asset_path)}" target="_blank">▶ ${escapeHtml(p.asset_path.split('/').pop())}</a>`
          : `<a href="/photo/${photoKey(p.asset_path)}" target="_blank"><img src="/thumb/${photoKey(p.asset_path)}" loading="lazy" /></a>`;
      return `<div class="item photo-item">
        <div class="time">${time}</div>
        ${img}
        ${place}
      </div>`;
    } else {
      const m = item.data;
      const speaker = m.from_me ? 'You' : escapeHtml(m.sender_name || 'them');
      const body = escapeHtml(m.body || '').replace(/\n/g, '<br>');
      return `<div class="item msg-item ${m.from_me ? 'from-me' : 'from-them'}">
        <div class="time">${time}</div>
        <div class="speaker">${speaker}</div>
        <div class="body">${body}</div>
      </div>`;
    }
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} — ${escapeHtml(event.event_id)}</title>
<style>
  :root { --bg:#fafaf7; --fg:#1c1c1c; --muted:#6a6a6a; --rule:#e0ddd5; --quote:#f1ede4; --accent:#5a5044; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14130f; --fg:#e8e6e0; --muted:#a09b8e; --rule:#2a2825; --quote:#1d1b16; --accent:#c8bea8; } }
  body { font-family: 'Iowan Old Style', Georgia, serif; max-width: 760px; margin: 3rem auto; padding: 0 2rem 6rem; background: var(--bg); color: var(--fg); line-height: 1.6; }
  h1 { font-size: 1.6rem; margin: 0 0 0.4rem; }
  .meta { color: var(--muted); font-size: 0.9rem; margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid var(--rule); }
  .item { display: grid; grid-template-columns: 5em 1fr; gap: 0.8rem; margin: 0.8rem 0; }
  .time { color: var(--muted); font-family: ui-monospace, monospace; font-size: 0.78rem; padding-top: 0.2rem; }
  .photo-item img { max-width: 100%; border-radius: 4px; display: block; }
  .video-item { display: inline-block; padding: 0.5rem 0.8rem; background: var(--quote); border: 1px solid var(--rule); border-radius: 4px; font-family: ui-monospace, monospace; font-size: 0.8rem; text-decoration: none; color: var(--accent); }
  .caption-place { color: var(--muted); font-size: 0.78rem; margin-top: 0.2rem; }
  .msg-item .speaker { font-weight: 600; color: var(--accent); }
  .msg-item .body { padding: 0.4rem 0.8rem; background: var(--quote); border-radius: 4px; margin-top: 0.2rem; }
  .from-me .body { background: #d8e8d8; }
  @media (prefers-color-scheme: dark) { .from-me .body { background: #2a3829; } }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">
    ${event.summary && event.place_name ? `${escapeHtml(event.place_name)}<br>` : ''}
    ${event.summary && event.summary_match === 'time' ? `facebook event matched by start time only — unverified<br>` : ''}
    ${startISO} → ${endISO}
    ${(event.details || []).map(d => `<br>${escapeHtml(d)}`).join('')}
    ${photos.length || messages.length ? `<br>${photos.length} photos · ${messages.length} messages` : ''}
    ${participantLinks.length ? `<br>With: ${participantLinks.join(', ')}` : ''}
    ${event.url ? `<br><a href="${escapeHtml(event.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(event.url)}</a>` : ''}
  </div>
  ${items}
</body>
</html>`;
}
