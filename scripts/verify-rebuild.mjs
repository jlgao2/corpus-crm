// Post-rebuild health check. Run AFTER scripts/full-rebuild.sh completes (DB
// must be unlocked / serve not holding it write-exclusively — opens READ_ONLY).
//   node scripts/verify-rebuild.mjs
import { DuckDBInstance } from '@duckdb/node-api';

const DB = 'pipeline/output/raw/messages.duckdb';
const c = await (await DuckDBInstance.create(DB, { access_mode: 'READ_ONLY' })).connect();
const one = async (q) => Number((await c.runAndReadAll(q)).getRows()[0][0]);
const rows = async (q) => (await c.runAndReadAll(q)).getRowObjectsJson();

// Baselines from the pre-rebuild DB (2026-06-07).
const base = { messages: 1412163, identities: 4371, gphotos: 25814, photo_faces: 3391, dets: 19820, places_geo: 13052, geocache: 3848, email: 3286 };
const pct = (n, b) => `${n} (baseline ${b}, ${b ? ((n / b - 1) * 100).toFixed(1) : '-'}%)`;
const flag = (ok) => (ok ? 'PASS' : '⚠️  CHECK');

console.log('=== scale vs baseline ===');
const msgs = await one('SELECT COUNT(*) FROM messages');
const ids = await one('SELECT COUNT(*) FROM identities');
console.log(`  messages:   ${pct(msgs, base.messages)}  ${flag(msgs >= base.messages * 0.97)}`);
console.log(`  identities: ${pct(ids, base.identities)}  ${flag(ids >= base.identities * 0.9 && ids <= base.identities * 1.05)}`);
console.log(`  gphotos:    ${pct(await one("SELECT COUNT(*) FROM photos WHERE source='gphotos'"), base.gphotos)}`);
console.log(`  email_corr: ${pct(await one('SELECT COUNT(*) FROM email_correspondents'), base.email)}`);

console.log('\n=== root-cause fix: case-variant identities ===');
const dups = await one(`SELECT COUNT(*) FROM (SELECT LOWER(TRIM(display_name)) n FROM identities WHERE display_name IS NOT NULL GROUP BY n HAVING COUNT(*)>1)`);
console.log(`  case-variant dup groups: ${dups}  ${flag(dups === 0)}`);

console.log('\n=== self resolution (dynamic SELF_ID) ===');
const selfs = await rows(`SELECT canonical_id, display_name FROM identities WHERE display_name='Demo User'`);
console.log(`  "Demo User" identities: ${selfs.length} ${flag(selfs.length === 1)}  ${JSON.stringify(selfs)}`);

console.log('\n=== faces re-ingested (from durable dets + name-keyed labels) ===');
const pf = await one('SELECT COUNT(*) FROM photo_faces');
const dets = await one('SELECT COUNT(*) FROM photo_face_dets');
console.log(`  photo_faces:     ${pct(pf, base.photo_faces)}  ${flag(pf >= base.photo_faces * 0.9)}`);
console.log(`  photo_face_dets: ${pct(dets, base.dets)}  ${flag(dets >= base.dets * 0.9)}`);
const orphanDets = await one('SELECT COUNT(*) FROM photo_face_dets d LEFT JOIN photos p ON p.id=d.photo_id WHERE p.id IS NULL');
console.log(`  orphan dets (photo_id not in photos): ${orphanDets}  ${flag(orphanDets === 0)}  <- proves photo_id stability`);
const namedPeople = await one('SELECT COUNT(DISTINCT canonical_id) FROM photo_faces');
console.log(`  distinct people in photo_faces: ${namedPeople}`);

console.log('\n=== geocode cache restored (no re-geocoding) ===');
const placesGeo = await one("SELECT COUNT(*) FROM places WHERE city IS NOT NULL");
const cache = await one('SELECT COUNT(*) FROM reverse_geocode_cache');
console.log(`  geocoded places: ${pct(placesGeo, base.places_geo)}  ${flag(placesGeo >= base.places_geo * 0.9)}`);
console.log(`  reverse_geocode_cache rows: ${pct(cache, base.geocache)}  ${flag(cache >= base.geocache * 0.9)}`);

console.log('\n=== youtube tables ===');
const yt = await rows(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'yt_%' ORDER BY 1`);
console.log(`  yt_* tables: ${yt.length} ${flag(yt.length >= 9)}`);

await c.disconnectSync();
console.log('\nIf all PASS: restart serve, refresh /graph, spot-check a co-edge + a labeled face.');
