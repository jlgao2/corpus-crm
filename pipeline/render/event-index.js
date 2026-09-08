function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Render the events index page.
 *
 * @param {Array} events - { event_id, start_ts, end_ts, place_name, summary?, source?, participants_names, n_photos, n_messages, thumb_path? }
 */
export function renderEventIndex(events) {
  const sorted = [...events].sort((a, b) => Number(b.start_ts) - Number(a.start_ts));
  // mevt_* ids embed the Demo-local day the event was bucketed by — use it,
  // else an evening meetup shows the next (UTC) day.
  const dayOf = (e) => /^mevt_\d{4}-\d{2}-\d{2}_/.test(e.event_id)
    ? e.event_id.slice(5, 15)
    : new Date(Number(e.start_ts)).toISOString().slice(0, 10);
  const dataJson = JSON.stringify(sorted.map(e => ({
    id: e.event_id,
    date: dayOf(e),
    year: Number(dayOf(e).slice(0, 4)),
    place: e.place_name || '',
    summary: e.summary || '',
    inferred: e.source === 'messages',
    participants: e.participants_names || [],
    n_photos: e.n_photos,
    n_messages: e.n_messages,
    // Encoded server-side: the client can't build this, and a raw file://
    // path here would be truncated at the spaces in "Google Photos".
    thumb: e.thumb_path ? '/thumb/' + Buffer.from(String(e.thumb_path)).toString('base64url') : null,
  }))).replace(/</g, '\\u003c'); // keep summaries/places from closing the <script>

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Events</title>
<style>
  :root { --bg:#fafaf7; --fg:#1c1c1c; --muted:#6a6a6a; --rule:#e0ddd5; --accent:#5a5044; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14130f; --fg:#e8e6e0; --muted:#a09b8e; --rule:#2a2825; --accent:#c8bea8; } }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1.5rem 4rem; background: var(--bg); color: var(--fg); }
  h1 { margin: 0 0 1rem; }
  .filters { display: flex; gap: 0.6rem; margin-bottom: 1.2rem; flex-wrap: wrap; }
  .filters input, .filters select { padding: 0.4rem 0.6rem; border: 1px solid var(--rule); border-radius: 4px; background: var(--bg); color: var(--fg); font-size: 0.9rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1rem; }
  .card { display: block; padding: 0.8rem; border: 1px solid var(--rule); border-radius: 6px; text-decoration: none; color: var(--fg); transition: background 0.15s; }
  .card:hover { background: rgba(127,127,127,0.06); }
  .card img { width: 100%; aspect-ratio: 4/3; object-fit: cover; border-radius: 4px; background: var(--rule); }
  .card .title { font-weight: 600; margin-top: 0.5rem; font-size: 0.95rem; }
  .card .sub { color: var(--muted); font-size: 0.8rem; margin-top: 0.15rem; }
  .empty { color: var(--muted); padding: 2rem; text-align: center; }
</style>
</head>
<body>
<h1>Events</h1>
<div class="filters">
  <input id="q" type="search" placeholder="Search place or person..." />
  <select id="year">
    <option value="">All years</option>
  </select>
  <select id="person">
    <option value="">All people</option>
  </select>
  <span id="count" class="sub" style="margin-left:auto;align-self:center;color:var(--muted);font-size:0.85rem"></span>
</div>
<div id="grid" class="grid"></div>

<script>
const DATA = ${dataJson};
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const grid = document.getElementById('grid');
const $q = document.getElementById('q');
const $year = document.getElementById('year');
const $person = document.getElementById('person');
const $count = document.getElementById('count');

const years = [...new Set(DATA.map(e => e.year))].sort((a,b) => b-a);
for (const y of years) $year.append(new Option(y, y));
const people = [...new Set(DATA.flatMap(e => e.participants))].sort();
for (const p of people) $person.append(new Option(p, p));

function render() {
  const q = $q.value.toLowerCase().trim();
  const year = $year.value;
  const person = $person.value;
  const filtered = DATA.filter(e =>
    (!year || String(e.year) === year) &&
    (!person || e.participants.includes(person)) &&
    (!q || e.place.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q) || e.participants.some(p => p.toLowerCase().includes(q)))
  );
  grid.innerHTML = filtered.map(e => \`
    <a class="card" href="\${encodeURIComponent(e.id)}.html">
      \${e.thumb ? \`<img src="\${e.thumb}" loading="lazy" />\` : '<div style="width:100%;aspect-ratio:4/3;background:var(--rule);border-radius:4px"></div>'}
      <div class="title">\${esc(e.summary || e.place || e.id)}</div>
      <div class="sub">\${e.date}\${e.summary && e.place ? ' · ' + esc(e.place) : ''} · \${e.inferred ? \`\${e.n_messages} msgs · inferred\` : \`\${e.n_photos} photos · \${e.n_messages} msgs\`}</div>
      \${e.participants.length ? \`<div class="sub">\${esc(e.participants.join(', '))}</div>\` : ''}
    </a>
  \`).join('');
  $count.textContent = filtered.length + ' / ' + DATA.length;
  if (filtered.length === 0) grid.innerHTML = '<div class="empty">No events match.</div>';
}
$q.oninput = $year.onchange = $person.onchange = render;
render();
</script>
</body>
</html>`;
}
