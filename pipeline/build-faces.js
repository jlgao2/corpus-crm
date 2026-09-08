import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';
import { ensurePhotoSchema } from './normalize/photo-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const FACES_DIR = process.env.FACES_DIR || path.join(__dirname, 'output', 'faces');

function esc(s) {
  if (s == null) return 'NULL';
  if (typeof s === 'number' || typeof s === 'bigint' || typeof s === 'boolean') return String(s);
  return "'" + String(s).replace(/'/g, "''") + "'";
}

export async function doExport(conn, facesDir) {
  const rows = (await conn.runAndReadAll(`
    SELECT p.id, p.asset_path, p.ts, p.ts_iso, pl.city, pl.country
    FROM photos p LEFT JOIN places pl ON pl.photo_id = p.id
    WHERE p.source = 'gphotos' AND p.asset_path IS NOT NULL`)).getRows();
  fs.mkdirSync(facesDir, { recursive: true });
  const out = rows.map(r => JSON.stringify({
    photo_id: r[0], asset_path: r[1],
    ts: r[2] == null ? null : Number(r[2]), ts_iso: r[3],
    city: r[4], country: r[5],
  })).join('\n');
  fs.writeFileSync(path.join(facesDir, 'photos.jsonl'), out + '\n');
  console.log(`exported ${rows.length} gphotos rows -> ${path.join(facesDir, 'photos.jsonl')}`);
  return rows.length;
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found at ${DB_PATH}. Run 'npm run build-db' first.`);
    process.exit(1);
  }
  const inst = await DuckDBInstance.create(DB_PATH);
  const conn = await inst.connect();
  await ensurePhotoSchema(conn);
  const mode = process.argv[2] === 'export' ? 'export' : 'ingest';
  if (mode === 'export') await doExport(conn, FACES_DIR);
  else await doIngest(conn, FACES_DIR, path.join(__dirname, 'face-labels.json'));
  await conn.disconnectSync();
}

function readJsonl(p) {
  return fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

export async function doIngest(conn, facesDir, labelsPath) {
  const detsPath = path.join(facesDir, 'dets_clustered.jsonl');
  const clustersPath = path.join(facesDir, 'clusters.json');
  for (const p of [detsPath, clustersPath]) {
    if (!fs.existsSync(p)) { console.error(`missing ${p} — run the sidecar (extract -> cluster) first`); process.exit(1); }
  }
  const dets = readJsonl(detsPath);
  const clustersDoc = JSON.parse(fs.readFileSync(clustersPath, 'utf-8'));
  const labels = (labelsPath && fs.existsSync(labelsPath)) ? JSON.parse(fs.readFileSync(labelsPath, 'utf-8')) : { clusters: [] };

  const labelMap = new Map();
  for (const c of labels.clusters || []) {
    const v = (c.label || '').trim();
    if (v && v.toLowerCase() !== 'skip') labelMap.set(Number(c.cluster_id), v);
  }
  const idRows = (await conn.runAndReadAll(`SELECT canonical_id, display_name FROM identities WHERE display_name IS NOT NULL`)).getRows();
  const nameToCanonical = new Map();
  for (const [cid, name] of idRows) nameToCanonical.set(String(name).toLowerCase(), cid);

  await conn.run('BEGIN TRANSACTION');
  await conn.run(`
    DELETE FROM photo_face_dets WHERE photo_id IN (SELECT id FROM photos WHERE source='gphotos');
    DELETE FROM face_clusters;
    DELETE FROM photo_faces WHERE photo_id IN (SELECT id FROM photos WHERE source='gphotos');
  `);

  for (const d of dets) {
    await conn.run(`INSERT OR IGNORE INTO photo_face_dets (det_id, photo_id, bbox, det_score, cluster_id) VALUES (${esc(d.det_id)}, ${esc(d.photo_id)}, ${esc(JSON.stringify(d.bbox))}, ${d.det_score}, ${d.cluster_id})`);
  }

  for (const c of clustersDoc.clusters) {
    const label = labelMap.get(Number(c.cluster_id)) || null;
    const cid = label ? (nameToCanonical.get(label.toLowerCase()) || null) : null;
    const ex = (c.exemplar_photo_ids || []).map(p => `'${String(p).replace(/'/g, "''")}'`).join(',');
    await conn.run(`INSERT OR IGNORE INTO face_clusters (cluster_id, n_faces, canonical_id, label, exemplar_photo_ids) VALUES (${c.cluster_id}, ${c.n_faces}, ${esc(cid)}, ${esc(label)}, [${ex}])`);
  }

  const clusterCanon = new Map();
  for (const c of clustersDoc.clusters) {
    const label = labelMap.get(Number(c.cluster_id));
    const cid = label && nameToCanonical.get(label.toLowerCase());
    if (cid) clusterCanon.set(Number(c.cluster_id), cid);
  }
  for (const d of dets) {
    const cid = clusterCanon.get(Number(d.cluster_id));
    if (!cid) continue;
    await conn.run(`INSERT OR IGNORE INTO photo_faces (photo_id, canonical_id, face_cluster) VALUES (${esc(d.photo_id)}, ${esc(cid)}, ${esc('gphotos:cluster:' + d.cluster_id)})`);
  }

  await conn.run(`UPDATE photos SET has_named_face = FALSE WHERE source='gphotos'`);
  await conn.run(`UPDATE photos SET has_named_face = TRUE WHERE source='gphotos' AND id IN (SELECT DISTINCT photo_id FROM photo_faces)`);
  await conn.run('COMMIT');

  const pfCount = Number((await conn.runAndReadAll(`SELECT COUNT(*) FROM photo_faces WHERE photo_id IN (SELECT id FROM photos WHERE source='gphotos')`)).getRows()[0][0]);
  console.log(`dets=${dets.length} clusters=${clustersDoc.clusters.length} labeled_matched=${clusterCanon.size} photo_faces_rows=${pfCount}`);
}

export { esc, FACES_DIR };

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main().catch(err => { console.error('Fatal:', err); process.exit(1); });
