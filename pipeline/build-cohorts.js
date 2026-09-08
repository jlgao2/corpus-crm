#!/usr/bin/env node
/**
 * Build cohort, bridge, and graduation datasets from group_membership.
 *
 *   npm run build-cohorts
 *
 * Outputs:
 *   pipeline/output/cohorts.json
 *
 * Computes:
 *   1. cohorts: groups of people who share ≥ 2 group threads (transitive cluster, weighted by shared count)
 *   2. bridges: people who appear in ≥ 3 of your group threads (the connective tissue)
 *   3. graduation: for each person who's in a group, did they later get a 1-on-1 with you, and when?
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const OUT = path.join(__dirname, 'output', 'cohorts.json');

async function main() {
  const inst = await DuckDBInstance.create(DB_PATH);
  const conn = await inst.connect();

  // 1. Load group_membership joined to identities (each group's resolved members).
  // Restrict to groups with at least 50 meaningful messages and at least 3 distinct senders (real groups).
  const realGroupsQ = (await conn.runAndReadAll(`
    WITH per AS (
      SELECT t.thread_id,
             COUNT(*) FILTER (WHERE m.body IS NOT NULL AND m.body <> '') AS msgs,
             COUNT(DISTINCT m.sender_name) AS distinct_senders,
             MIN(m.ts) AS first_ts, MAX(m.ts) AS last_ts
      FROM threads t LEFT JOIN messages m ON m.thread_id = t.thread_id
      WHERE t.is_group GROUP BY t.thread_id
    )
    SELECT thread_id, msgs, distinct_senders, first_ts, last_ts
    FROM per WHERE msgs >= 50 AND distinct_senders BETWEEN 3 AND 10
  `)).getRows();
  const groupSet = new Set(realGroupsQ.map(r => r[0]));
  const groupMeta = new Map(realGroupsQ.map(r => [r[0], { msgs: Number(r[1]), distinct: Number(r[2]), first: Number(r[3]), last: Number(r[4]) }]));
  console.log(`real groups: ${groupSet.size}`);

  // For each group, who messaged in it (resolved by sender_name → identity)
  const memberRows = (await conn.runAndReadAll(`
    SELECT m.thread_id, m.sender_name, COUNT(*) AS n
    FROM messages m
    WHERE m.thread_id IN (${[...groupSet].map(g => `'${g.replace(/'/g, "''")}'`).join(',')})
      AND m.body IS NOT NULL AND m.body <> '' AND m.sender_name IS NOT NULL AND m.sender_name <> ''
    GROUP BY m.thread_id, m.sender_name
  `)).getRows();

  // Resolve sender_names → canonical_ids in batch
  const allSenders = new Set();
  for (const r of memberRows) allSenders.add(r[1]);
  const idResolveRows = (await conn.runAndReadAll(`
    SELECT canonical_id, display_name, aliases::VARCHAR FROM identities
  `)).getRows();
  const nameToCid = new Map();
  for (const [cid, dn, aliasesStr] of idResolveRows) {
    if (dn) nameToCid.set(dn, cid);
    const aliases = (aliasesStr || '').replace(/[\[\]"']/g, '').split(',').map(s => s.trim()).filter(Boolean);
    for (const a of aliases) if (!nameToCid.has(a)) nameToCid.set(a, cid);
  }

  // Build group → [{cid, name, msgs}]
  const groupMembers = new Map();
  for (const [tid, sender, n] of memberRows) {
    const cid = nameToCid.get(sender) || null;
    if (!groupMembers.has(tid)) groupMembers.set(tid, []);
    groupMembers.get(tid).push({ canonical_id: cid, sender_name: sender, msgs: Number(n) });
  }

  // 2. cohorts: people who share ≥ 2 groups together
  // Build co-occurrence matrix: cid → cid → shared group count
  const coGroups = new Map(); // a -> b -> count
  const personGroups = new Map(); // cid -> Set(thread_id)
  for (const [tid, members] of groupMembers) {
    const cids = members.map(m => m.canonical_id).filter(Boolean);
    const unique = [...new Set(cids)];
    for (const cid of unique) {
      if (!personGroups.has(cid)) personGroups.set(cid, new Set());
      personGroups.get(cid).add(tid);
    }
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const [a, b] = unique[i] < unique[j] ? [unique[i], unique[j]] : [unique[j], unique[i]];
        if (!coGroups.has(a)) coGroups.set(a, new Map());
        coGroups.get(a).set(b, (coGroups.get(a).get(b) || 0) + 1);
      }
    }
  }

  // Connected components via union-find on edges with weight ≥ 3
  const SHARED_THRESHOLD = 3;
  const parent = new Map();
  function find(x) {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) === x) return x;
    const r = find(parent.get(x));
    parent.set(x, r); return r;
  }
  function union(x, y) { parent.set(find(x), find(y)); }

  const edges = [];
  for (const [a, m] of coGroups) {
    for (const [b, count] of m) {
      if (count >= SHARED_THRESHOLD) {
        edges.push([a, b, count]);
        union(a, b);
      }
    }
  }

  const cohortsByRoot = new Map();
  for (const cid of personGroups.keys()) {
    const r = find(cid);
    if (!cohortsByRoot.has(r)) cohortsByRoot.set(r, []);
    cohortsByRoot.get(r).push(cid);
  }

  // Display name lookup
  const cidToName = new Map();
  for (const [cid, dn] of idResolveRows) cidToName.set(cid, dn);

  // Cohorts = each intimate group IS a cohort. People who appear together in any
  // ≤ 10-person group form a cohort. Connected-components on this collapses too
  // aggressively, so we just expose the groups directly as cohort-units, with
  // each person tagged by the group where they have the highest msg count
  // (= their "primary" cohort).
  const SELF_FILTER = new Set(['Demo User', 'demo']);
  const groupNameLookup = new Map();
  for (const [tid, members] of groupMembers) {
    const known = members.filter(m => m.canonical_id && !SELF_FILTER.has(cidToName.get(m.canonical_id) || ''));
    const top = known.slice().sort((a, b) => b.msgs - a.msgs).slice(0, 4)
      .map(m => cidToName.get(m.canonical_id) || m.sender_name);
    groupNameLookup.set(tid, top.join(', '));
  }

  // Per-person primary cohort = the group where they have the most messages
  const personPrimary = new Map();
  for (const [tid, members] of groupMembers) {
    for (const m of members) {
      if (!m.canonical_id) continue;
      const cur = personPrimary.get(m.canonical_id);
      if (!cur || m.msgs > cur.msgs) personPrimary.set(m.canonical_id, { thread_id: tid, msgs: m.msgs });
    }
  }

  // Build cohort list (one entry per intimate group), with members sorted by msgs
  const cohorts = [];
  for (const [tid, members] of groupMembers) {
    const realMembers = members
      .filter(m => m.canonical_id && !SELF_FILTER.has(cidToName.get(m.canonical_id) || ''))
      .sort((a, b) => b.msgs - a.msgs)
      .map(m => ({
        canonical_id: m.canonical_id,
        display_name: cidToName.get(m.canonical_id) || m.sender_name,
        msgs_in_group: m.msgs,
        is_primary: personPrimary.get(m.canonical_id)?.thread_id === tid,
      }));
    if (realMembers.length < 3) continue;
    cohorts.push({
      thread_id: tid,
      cohort_label: groupNameLookup.get(tid),
      total_msgs: groupMeta.get(tid).msgs,
      first: new Date(groupMeta.get(tid).first).toISOString().slice(0, 10),
      last: new Date(groupMeta.get(tid).last).toISOString().slice(0, 10),
      member_count: realMembers.length,
      members: realMembers,
    });
  }
  cohorts.sort((a, b) => b.total_msgs - a.total_msgs);

  // 3. bridges: people in many groups (excluding 'Demo User' = self)
  const SELF_NAMES = new Set(['Demo User', 'demo']);
  const bridges = [];
  for (const [cid, groups] of personGroups) {
    if (cid === null) continue;
    const dn = cidToName.get(cid) || cid;
    if (SELF_NAMES.has(dn)) continue;
    if (groups.size >= 3) {
      bridges.push({
        canonical_id: cid,
        display_name: dn,
        group_count: groups.size,
        groups: [...groups].slice(0, 10),
      });
    }
  }
  bridges.sort((a, b) => b.group_count - a.group_count);

  // 4. graduation: for each (cid in any group), did a 1-on-1 thread emerge later?
  //    For each cid in personGroups, find earliest 1-on-1 message and earliest group message.
  //    If 1-on-1 first_ts > all-groups first_ts, they "graduated" from group → 1-on-1.
  //    Compute lag in days.
  const graduationRows = (await conn.runAndReadAll(`
    WITH grp AS (
      SELECT m.sender_name, MIN(m.ts) AS first_group_ts
      FROM messages m JOIN threads t ON t.thread_id = m.thread_id
      WHERE t.is_group AND m.body IS NOT NULL AND m.body <> ''
      GROUP BY m.sender_name
    ),
    one_on_one AS (
      SELECT ti.canonical_id, MIN(m.ts) AS first_1on1_ts
      FROM messages m JOIN thread_identity ti ON ti.thread_id = m.thread_id
      JOIN threads t ON t.thread_id = m.thread_id
      WHERE NOT t.is_group AND m.body IS NOT NULL AND m.body <> ''
      GROUP BY ti.canonical_id
    )
    SELECT i.canonical_id, i.display_name, grp.first_group_ts, one_on_one.first_1on1_ts
    FROM identities i
    LEFT JOIN grp ON grp.sender_name = i.display_name
    LEFT JOIN one_on_one ON one_on_one.canonical_id = i.canonical_id
    WHERE grp.first_group_ts IS NOT NULL AND one_on_one.first_1on1_ts IS NOT NULL
  `)).getRows();
  const graduation = graduationRows.filter(r => !SELF_FILTER.has(r[1])).map(([cid, dn, firstGroup, first1on1]) => {
    const fg = Number(firstGroup), f1 = Number(first1on1);
    const lag_days = Math.round((f1 - fg) / 86400000);
    return {
      canonical_id: cid,
      display_name: dn,
      first_group: new Date(fg).toISOString().slice(0, 10),
      first_1on1: new Date(f1).toISOString().slice(0, 10),
      lag_days,
      sequence: lag_days > 7 ? 'group_first' : (lag_days < -7 ? '1on1_first' : 'concurrent'),
    };
  }).sort((a, b) => b.lag_days - a.lag_days);

  fs.writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(),
    cohorts,
    bridges,
    graduation,
    stats: {
      real_groups: groupSet.size,
      cohorts: cohorts.length,
      largest_cohort_size: cohorts[0]?.size || 0,
      bridges: bridges.length,
      graduated_to_1on1: graduation.filter(g => g.sequence === 'group_first').length,
    },
  }, null, 2));

  console.log(`cohorts.json:`);
  console.log(`  ${cohorts.length} cohorts (largest: ${cohorts[0]?.size || 0} people)`);
  console.log(`  ${bridges.length} bridges (people in ≥ 3 groups)`);
  console.log(`  ${graduation.length} group-members with both group + 1on1 history`);
  console.log(`    of which ${graduation.filter(g => g.sequence === 'group_first').length} started in a group, then graduated to 1on1`);

  await conn.disconnectSync();
}

main().catch(e => { console.error(e); process.exit(1); });
