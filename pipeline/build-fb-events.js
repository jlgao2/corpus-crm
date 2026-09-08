import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';
import { loadFacebookEvents } from './ingest/facebook-events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const OUT = path.join(__dirname, 'output', 'fb-events.json');
const FB_ROOT = fs.existsSync(path.join(__dirname, '..', 'inputs', 'messenger'))
  ? fs.realpathSync(path.join(__dirname, '..', 'inputs', 'messenger')) : null;
const esc = s => s == null ? 'NULL' : "'" + String(s).replace(/'/g, "''") + "'";
const num = n => (n == null || Number.isNaN(Number(n))) ? 'NULL' : Number(n);

const STOP = new Set(('the a an and or of to in on at for with party night live show event'
  + ' you your we our me my is are be a &').split(/\s+/));

export function deriveTopics(events, minN = 3) {
  const freq = new Map(), samples = new Map();
  for (const e of events) {
    if (e.response === 'declined' || e.response === 'invited') continue;
    const toks = (e.name + ' ' + (e.description || '')).toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
    for (const t of new Set(toks)) {
      if (STOP.has(t)) continue;
      freq.set(t, (freq.get(t) || 0) + 1);
      if (!samples.has(t)) samples.set(t, []);
      const s = samples.get(t);
      if (s.length < 3 && !s.includes(e.name)) s.push(e.name);
    }
  }
  return [...freq.entries()].filter(([, n]) => n >= minN).sort((a, b) => b[1] - a[1]).slice(0, 50)
    .map(([topic, n]) => ({ topic, n, sample_events: samples.get(topic) }));
}

export async function buildFbEvents(conn, events) {
  await conn.run(`
    DROP TABLE IF EXISTS fb_events;
    DROP TABLE IF EXISTS fb_event_topics;
    CREATE TABLE fb_events (event_key VARCHAR PRIMARY KEY, fbid VARCHAR, name VARCHAR, start_ts BIGINT, end_ts BIGINT,
      place_name VARCHAR, lat DOUBLE, lng DOUBLE, address VARCHAR, description VARCHAR, response VARCHAR, response_time BIGINT);
    CREATE TABLE fb_event_topics (topic VARCHAR, n INTEGER, sample_events VARCHAR[]);
  `);
  for (const e of events) {
    const k = e.fbid || `${(e.name || '').trim().toLowerCase()}|${e.start_ts}`;
    await conn.run(`INSERT INTO fb_events VALUES (${esc(k)}, ${esc(e.fbid)}, ${esc(e.name)}, ${num(e.start_ts)}, ${num(e.end_ts)},
      ${esc(e.place_name)}, ${num(e.lat)}, ${num(e.lng)}, ${esc(e.address)}, ${esc(e.description)}, ${esc(e.response)}, ${num(e.response_time)}) ON CONFLICT DO NOTHING`);
  }
  const topics = deriveTopics(events);
  for (const t of topics) {
    const ex = t.sample_events.map(esc).join(',');
    await conn.run(`INSERT INTO fb_event_topics VALUES (${esc(t.topic)}, ${t.n}, [${ex}])`);
  }
  return { events: events.length, topics: topics.length };
}

async function main() {
  const events = FB_ROOT ? loadFacebookEvents(FB_ROOT) : [];
  const conn = await (await DuckDBInstance.create(DB_PATH)).connect();
  const r = await buildFbEvents(conn, events);
  const topicRows = (await conn.runAndReadAll('SELECT topic, n, sample_events FROM fb_event_topics ORDER BY n DESC')).getRowObjectsJson();
  fs.writeFileSync(OUT, JSON.stringify({ events, topics: topicRows }, null, 2));
  console.log(`[fb-events] ${r.events} events, ${r.topics} topics -> fb_events + ${path.relative(path.join(__dirname, '..'), OUT)}`);
  await conn.disconnectSync();
}
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main().catch(e => { console.error('Fatal:', e); process.exit(1); });
