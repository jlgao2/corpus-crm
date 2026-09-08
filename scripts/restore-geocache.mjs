// Restore the coordinate-keyed reverse-geocode cache from a pre-build backup DB
// into the freshly rebuilt DB, so build-gphotos doesn't re-hit Nominatim for
// thousands of coords. The cache is keyed by rounded lat/lng (id-independent),
// so it is fully portable across rebuilds. Also calls ensurePhotoSchema so the
// photo-layer tables exist before build-gphotos runs.
//
//   node scripts/restore-geocache.mjs [path-to-backup-db]
import { DuckDBInstance } from '@duckdb/node-api';
import { ensurePhotoSchema } from '../pipeline/normalize/photo-schema.js';

const DB = 'pipeline/output/raw/messages.duckdb';
const BAK = process.argv[2] || 'pipeline/output/raw/messages.duckdb.prebuild.bak';

const c = await (await DuckDBInstance.create(DB)).connect();
await ensurePhotoSchema(c);
await c.run(`ATTACH '${BAK}' AS old (READ_ONLY)`);
const n = Number((await c.runAndReadAll('SELECT COUNT(*) FROM old.reverse_geocode_cache')).getRows()[0][0]);
await c.run('INSERT INTO reverse_geocode_cache (lat_round, lng_round, place_name, city, region, country) SELECT lat_round, lng_round, place_name, city, region, country FROM old.reverse_geocode_cache ON CONFLICT DO NOTHING');
await c.run('DETACH old');
await c.disconnectSync();
console.log(`geocache restored: ${n} rows`);
