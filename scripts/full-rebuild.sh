#!/usr/bin/env bash
# Full rebuild of pipeline/output/raw/messages.duckdb from inputs/, PRESERVING
# the expensive, id-independent artifacts so faces + places survive without
# re-extraction or re-geocoding:
#   - face embeddings/clusters live on disk (output/faces/*.jsonl, clusters.json)
#   - face labels are name-keyed (face-labels.json) -> re-resolved to new ids
#   - geocode cache is coordinate-keyed -> restored from the pre-build backup
#
# build-db DELETES the whole DB file and renumbers canonical_ids, so this also
# re-applies identity-aliases.json (merges/renames/splits) and the case-insensitive
# identity fix. Re-run after any inputs/ or identity-aliases.json change.
#
# ORDER NOTE: merge-case-variants runs BEFORE build-connections. A fresh build-db
# can produce duplicate same-name identities (e.g. two "Leo Reeves"); folding
# them first keeps build-connections' group_membership clean. (build-connections
# is also collision-tolerant, but merging first is cleaner.)
#
#   bash scripts/full-rebuild.sh        # leaves serve.js stopped; restart after verifying
set -eo pipefail
cd "$(dirname "$0")/.."

DB=pipeline/output/raw/messages.duckdb
BAK="$DB.prebuild.bak"

echo "[1/11] stop only processes holding this checkout's DuckDB"
DB_REAL="$(cd "$(dirname "$DB")" && pwd -P)/$(basename "$DB")"
PIDS="$(lsof -t "$DB_REAL" 2>/dev/null | sort -u || true)"
if [ -n "$PIDS" ]; then
  for PID in $PIDS; do kill "$PID"; done
  sleep 2
  echo "  stopped: $(printf '%s' "$PIDS" | tr '\n' ' ')"
else
  echo "  no process holds $DB_REAL"
fi

echo "[2/11] backup DB + hand labels (only undo path)"
cp "$DB" "$BAK"
cp pipeline/face-labels.json pipeline/face-labels.json.bak
echo "  -> $BAK + face-labels.json.bak"

echo "[3/11] build-db (wipe + re-ingest messages/identities/email; applies identity-aliases.json + case-insensitive fix)"
node --max-old-space-size=8192 pipeline/build-db.js
node pipeline/fix-misclassified-groups.js

echo "[4/11] merge-case-variants (fold duplicate same-name identities BEFORE connections)"
node pipeline/merge-case-variant-identities.js --apply

echo "[4b/11] apply-merges (saved identity-merges.json, id-independent; no-op if absent)"
node pipeline/apply-merges.js --apply

echo "[4c/11] apply-aliases (identity-aliases.json merges + thread SPLITS — build-db wipes thread_identity, so splits must be re-applied or ghost buckets like 'Instagram User' reabsorb their threads)"
node pipeline/apply-aliases.mjs

echo "[5/11] build-connections (group_membership/mentions/links)"
node pipeline/build-connections.js

echo "[6/11] restore geocode cache from backup (+ ensurePhotoSchema) before geocoding"
node scripts/restore-geocache.mjs "$BAK"

echo "[7/11] build-gphotos (photos + places; geocode now fully cached)"
node pipeline/build-gphotos-only.js

echo "[8/11] build-youtube (yt_* tables)"
node pipeline/build-youtube.js

echo "[8b/11] build-fb-events (Facebook events layer)"
node pipeline/build-fb-events.js

echo "[8c/11] build-calls (call history -> calls table, resolved to identities)"
node pipeline/build-calls.js

echo "[9/11] faces export (photos.jsonl) + ingest (dets_clustered + clusters + face-labels -> photo_faces, re-resolved)"
node pipeline/build-faces.js export
node pipeline/build-faces.js

echo "[9b/11] build-events (photo events: faces × places × messages × fb_events)"
node pipeline/build-events.js

echo "[9c/11] build-inferred-events (meetups from messages; needs locallmm — skipped if down)"
node pipeline/build-inferred-events.js || echo "  build-inferred-events did not complete (proxy down, or an error above) — continuing"

echo "[9c2/11] build-partiful-events (partiful invites -> events + pages; renders the shared index last)"
node pipeline/build-partiful-events.js

echo "[9d/11] build-rhythm (message texture grid for /rhythm)"
node pipeline/build-rhythm.js

echo "[9e/11] build-thumbs (shipped thumb cache — homelab serves photos without the archive)"
node pipeline/build-thumbs.js

echo "[10/11] build-email-summary (/email artifact)"
node pipeline/build-email-summary.js

echo "[11/11] build-graph (graph.json)"
node pipeline/build-graph.js

echo
echo "DONE. Verify (node scripts/verify-rebuild.mjs), then restart serve:"
echo "  nohup node pipeline/serve.js >/tmp/smg-serve.log 2>&1 & disown"
