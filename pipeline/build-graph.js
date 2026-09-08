#!/usr/bin/env node
/**
 * Build the connection-graph JSON used by /graph.
 *
 * Nodes: Demo's top ~80 contacts by 1-on-1 message volume.
 * Edges: pairwise co-occurrence — shared groups + cross-mentions in
 *        Demo's 1-on-1 threads. Weight = total co-occurrences.
 */

import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'pipeline', 'output', 'raw', 'messages.duckdb');
const OUT_PATH = path.join(ROOT, 'pipeline', 'output', 'graph.json');

const SELF_NAME = 'Demo User';
let SELF_ID = 'id-751';  // resolved from SELF_NAME at runtime — survives canonical_id renumbers
const TOP_N = 80;
const MIN_MESSAGES = 100;
const MIN_EDGE_WEIGHT = 12;       // sparser graph → cleaner cohort separation
const CO_MIN = 2;                 // Phase 6: min shared photos for a co-presence edge

// First-name forms that are also common English words / verbs / etc — when the
// mention extractor matches one of these, it's frequently a false positive
// (e.g. "Will Jenkin" inflated by every "will" modal-verb). Filter these
// at graph-build time. Multi-token forms ("Will Jenkin") still count.
const AMBIGUOUS_NAME_FORMS = new Set([
  'will', 'mark', 'grace', 'hope', 'faith', 'joy', 'pat', 'daisy', 'rose',
  'lily', 'holly', 'sam', 'bob', 'kit', 'frank', 'drew', 'tim', 'jack',
  'art', 'rich', 'wade', 'penny', 'star', 'may', 'ray', 'pearl', 'angel',
  'crystal', 'rocky', 'ace', 'win', 'reed', 'lance', 'major', 'brave',
  'tom', 'jay', 'don', 'rod', 'olive', 'sandy', 'sunny', 'rain', 'storm',
]);

async function main() {
  const instance = await DuckDBInstance.create(DB_PATH, { access_mode: 'READ_ONLY' });
  const conn = await instance.connect();

  // Resolve self dynamically (canonical_ids are renumbered on every build-db).
  const selfRow = (await conn.runAndReadAll(
    `SELECT canonical_id FROM identities WHERE display_name = '${SELF_NAME}' ORDER BY canonical_id LIMIT 1`
  )).getRows()[0];
  if (selfRow) SELF_ID = selfRow[0];
  else { console.warn(`[graph] WARNING: no identity named "${SELF_NAME}" — self filtering disabled`); SELF_ID = '__no_self__'; }

  // 1. Top contacts by message volume in 1-on-1 threads, excluding aggregator/system entities.
  const nodesReader = await conn.runAndReadAll(`
    SELECT
      i.canonical_id,
      i.display_name,
      i.sources,
      COUNT(*) AS msg_count,
      MIN(m.ts) AS first_ts,
      MAX(m.ts) AS last_ts
    FROM messages m
    JOIN threads t ON t.thread_id = m.thread_id
    JOIN thread_identity ti ON ti.thread_id = m.thread_id
    JOIN identities i ON i.canonical_id = ti.canonical_id
    WHERE t.is_group = FALSE
      AND ti.canonical_id != '${SELF_ID}'
      AND m.meaningful = TRUE
      AND i.display_name NOT ILIKE '%facebook user%'
      AND i.display_name NOT ILIKE '%instagram user%'
    GROUP BY i.canonical_id, i.display_name, i.sources
    HAVING msg_count >= ${MIN_MESSAGES}
    ORDER BY msg_count DESC
    LIMIT ${TOP_N}
  `);

  const nodes = nodesReader.getRowObjectsJson().map(r => ({
    id: r.canonical_id,
    name: r.display_name,
    sources: r.sources,
    msg_count: Number(r.msg_count),
    first_iso: r.first_ts ? new Date(Number(r.first_ts)).toISOString().slice(0, 10) : null,
    last_iso: r.last_ts ? new Date(Number(r.last_ts)).toISOString().slice(0, 10) : null,
  }));
  const nodeIds = new Set(nodes.map(n => n.id));

  // 2. Edge weights from shared group memberships.
  const groupEdges = new Map(); // "a||b" -> count
  const groupReader = await conn.runAndReadAll(`
    SELECT a.canonical_id AS a_id, b.canonical_id AS b_id, COUNT(DISTINCT a.thread_id) AS shared_groups
    FROM group_membership a
    JOIN group_membership b ON a.thread_id = b.thread_id AND a.canonical_id < b.canonical_id
    GROUP BY a.canonical_id, b.canonical_id
    HAVING shared_groups >= 1
  `);
  for (const r of groupReader.getRowObjectsJson()) {
    if (!nodeIds.has(r.a_id) || !nodeIds.has(r.b_id)) continue;
    const k = `${r.a_id}||${r.b_id}`;
    groupEdges.set(k, (groupEdges.get(k) || 0) + Number(r.shared_groups));
  }

  // 3. Edge weights from co-mentions in Demo's 1-on-1 threads:
  //    if person A is mentioned in Demo's 1-on-1 thread with person B, that's one
  //    co-occurrence directed B -> A. We treat the edge as undirected; sum both directions.
  const mentionEdges = new Map();
  // Pull mentioned_form alongside the count so we can filter ambiguous-name
  // false-positives ("Will" matching the modal verb, etc).
  const denyList = [...AMBIGUOUS_NAME_FORMS].map(s => `'${s}'`).join(', ');
  const mentionReader = await conn.runAndReadAll(`
    SELECT
      ti.canonical_id AS thread_owner,
      mn.mentioned_canonical_id AS mentioned_id,
      COUNT(*) AS co_mentions
    FROM mentions mn
    JOIN threads t ON t.thread_id = mn.thread_id
    JOIN thread_identity ti ON ti.thread_id = mn.thread_id
    WHERE t.is_group = FALSE
      AND ti.canonical_id != '${SELF_ID}'
      AND mn.mentioned_canonical_id != '${SELF_ID}'
      AND ti.canonical_id != mn.mentioned_canonical_id
      AND LOWER(mn.mentioned_form) NOT IN (${denyList})
    GROUP BY ti.canonical_id, mn.mentioned_canonical_id
    HAVING co_mentions >= 1
  `);
  for (const r of mentionReader.getRowObjectsJson()) {
    if (!nodeIds.has(r.thread_owner) || !nodeIds.has(r.mentioned_id)) continue;
    const [a, b] = [r.thread_owner, r.mentioned_id].sort();
    const k = `${a}||${b}`;
    mentionEdges.set(k, (mentionEdges.get(k) || 0) + Number(r.co_mentions));
  }

  // 4. Combine into final edge list with weight = group_count + mention_count.
  const edges = [];
  const allKeys = new Set([...groupEdges.keys(), ...mentionEdges.keys()]);
  for (const k of allKeys) {
    const [a, b] = k.split('||');
    const groupW = groupEdges.get(k) || 0;
    const mentionW = mentionEdges.get(k) || 0;
    const weight = groupW + mentionW;
    if (weight < MIN_EDGE_WEIGHT) continue;
    edges.push({ source: a, target: b, weight, group_overlap: groupW, mentions: mentionW });
  }

  // 4b. Co-presence edges from photo_faces (people in the same photo) — Phase 6.
  //     A SEPARATE layer (not mixed into the message-weight edges); only between
  //     people who are already graph nodes, so no dangling. Tune via CO_MIN.
  const coEdges = [];
  let extraNodes = [];
  try {
    const coReader = await conn.runAndReadAll(`
      SELECT pf1.canonical_id AS a, pf2.canonical_id AS b, COUNT(DISTINCT pf1.photo_id) AS shared
      FROM photo_faces pf1
      JOIN photo_faces pf2 ON pf1.photo_id = pf2.photo_id AND pf1.canonical_id < pf2.canonical_id
      GROUP BY a, b
      HAVING shared >= ${CO_MIN}
    `);
    const coPeople = new Set();
    for (const r of coReader.getRowObjectsJson()) {
      coEdges.push({ source: r.a, target: r.b, shared: Number(r.shared) });
      coPeople.add(r.a); coPeople.add(r.b);
    }
    // Phase 6 v2: co-present people who aren't already top-80 message nodes become
    // "photo-only" nodes. DEDUPE first: a co-person whose CASE-NORMALIZED name matches
    // an existing message node is the same person under a name/case variant (e.g.
    // "Marcus Chen" vs "Marcus Chen") — remap to that node rather than adding a duplicate.
    const norm = s => (s || '').trim().toLowerCase();
    const msgByName = new Map(nodes.map(n => [norm(n.name), n.id]));
    const remap = new Map();
    const missing = [...coPeople].filter(id => !nodeIds.has(id) && id !== SELF_ID);
    if (missing.length) {
      const inList = missing.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
      const extraReader = await conn.runAndReadAll(`
        SELECT canonical_id, display_name, sources FROM identities WHERE canonical_id IN (${inList})
      `);
      for (const r of extraReader.getRowObjectsJson()) {
        const existing = msgByName.get(norm(r.display_name));
        if (existing) {
          remap.set(r.canonical_id, existing);          // same person as a message node → don't duplicate
        } else {
          extraNodes.push({
            id: r.canonical_id, name: r.display_name, sources: r.sources,
            msg_count: 0, first_iso: null, last_iso: null, cluster_id: null, photo_only: true,
          });
        }
      }
    }
    // Apply the remap to co-edges, merging collapsed pairs + dropping self-edges.
    if (remap.size) {
      const merged = new Map();
      for (const e of coEdges) {
        const a = remap.get(e.source) || e.source;
        const b = remap.get(e.target) || e.target;
        if (a === b) continue;
        const [x, y] = [a, b].sort();
        merged.set(x + '||' + y, (merged.get(x + '||' + y) || 0) + e.shared);
      }
      coEdges.length = 0;
      for (const [k, shared] of merged) { const [x, y] = k.split('||'); coEdges.push({ source: x, target: y, shared }); }
    }
  } catch (e) {
    console.warn('[graph] co-presence layer skipped:', e.message);
  }

  conn.disconnectSync();

  // 5. Cluster detection via weighted label propagation. Each node starts with its own
  //    label; on each iteration, each node adopts the label maximising sum-of-incident-
  //    edge-weights from neighbours sharing that label. Iterate to convergence (or 25x).
  const adj = new Map(); // id -> [{nbr, weight}, ...]
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    adj.get(e.source).push({ nbr: e.target, w: e.weight });
    adj.get(e.target).push({ nbr: e.source, w: e.weight });
  }
  const label = new Map(nodes.map(n => [n.id, n.id]));
  const order = nodes.map(n => n.id);
  for (let iter = 0; iter < 25; iter++) {
    let changed = 0;
    // Shuffle order for stability
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const id of order) {
      const nbrs = adj.get(id);
      if (!nbrs.length) continue;
      const tally = new Map();
      for (const { nbr, w } of nbrs) {
        const lab = label.get(nbr);
        tally.set(lab, (tally.get(lab) || 0) + w);
      }
      let best = label.get(id), bestW = -1;
      for (const [lab, w] of tally) if (w > bestW) { bestW = w; best = lab; }
      if (best !== label.get(id)) { label.set(id, best); changed++; }
    }
    if (changed === 0) break;
  }
  // Renumber clusters as small ints; sort clusters by total weight (so the biggest cluster gets cluster_id=0).
  const clusterWeight = new Map();
  for (const n of nodes) {
    const lab = label.get(n.id);
    clusterWeight.set(lab, (clusterWeight.get(lab) || 0) + n.msg_count);
  }
  const sortedLabels = [...clusterWeight.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
  const labelToCluster = new Map(sortedLabels.map((lab, i) => [lab, i]));
  for (const n of nodes) n.cluster_id = labelToCluster.get(label.get(n.id));
  const n_clusters = labelToCluster.size;

  // Phase 6 v2: append photo-only nodes AFTER clustering (so they don't pollute the
  // message-cluster detection), then keep only co-edges whose endpoints are now nodes.
  for (const n of extraNodes) { nodes.push(n); nodeIds.add(n.id); }
  const coValid = coEdges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));

  // 6. Cluster summary — top-3 names per cluster, for the legend.
  const clusterSummaries = [];
  for (let cid = 0; cid < n_clusters; cid++) {
    const members = nodes.filter(n => n.cluster_id === cid).sort((a, b) => b.msg_count - a.msg_count);
    clusterSummaries.push({
      cluster_id: cid,
      size: members.length,
      total_msgs: members.reduce((s, n) => s + n.msg_count, 0),
      top_names: members.slice(0, 3).map(n => n.name),
    });
  }

  const out = {
    generated_at: new Date().toISOString(),
    self_id: SELF_ID,
    n_nodes: nodes.length,
    n_message_nodes: nodes.length - extraNodes.length,
    n_photo_only: extraNodes.length,
    n_edges: edges.length,
    n_co_present_edges: coValid.length,
    n_clusters,
    thresholds: { top_n: TOP_N, min_messages: MIN_MESSAGES, min_edge_weight: MIN_EDGE_WEIGHT, co_min_shared: CO_MIN },
    clusters: clusterSummaries,
    nodes,
    edges,
    co_present_edges: coValid,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`[graph] ${nodes.length} nodes (${extraNodes.length} photo-only), ${edges.length} edges, ${coValid.length} co-presence, ${n_clusters} clusters → ${path.relative(ROOT, OUT_PATH)}`);
}

main().catch(err => { console.error('[graph] fatal:', err); process.exit(1); });
