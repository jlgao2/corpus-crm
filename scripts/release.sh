#!/usr/bin/env bash
# Publish the freshly built pipeline/output as an immutable, activated release.
#
# Single machine: build in place, then swap atomically so a running server
# never observes a half-written corpus. The previous release is kept and is
# restored automatically if the new one fails its health check.
#
#   bash scripts/release.sh              # publish + activate
#   bash scripts/release.sh --no-verify  # skip the corpus-regression gate
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="pipeline/output"
DB="$OUT/raw/messages.duckdb"
RELEASES="pipeline/releases"
[ -f "$DB" ] || { echo "no corpus at $DB — run 'npm run build-db' first" >&2; exit 1; }

# Prefer the repo-local node; fall back to PATH.
NODE="${NODE:-$(command -v node)}"
SHA256="$(command -v sha256sum || command -v shasum)"
sha_of() { case "$SHA256" in *sha256sum) sha256sum "$1" | awk '{print $1}';; *) shasum -a 256 "$1" | awk '{print $1}';; esac; }

RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=12 HEAD 2>/dev/null || echo nogit)"
STAGE="$RELEASES/$RELEASE_ID"

echo "[1/5] manifest"
"$NODE" scripts/generate-sync-manifest.mjs --release "$RELEASE_ID"
DB_SHA="$(sha_of "$DB")"

echo "[2/5] corpus-regression gate"
PREV_MANIFEST="$OUT/sync-manifest.json"
if [ "${1:-}" != "--no-verify" ] && [ -L "$OUT" ] && [ -f "$PREV_MANIFEST" ]; then
  cp "$PREV_MANIFEST" /tmp/prev-manifest.$$.json
  "$NODE" scripts/verify-corpus-gate.mjs --baseline /tmp/prev-manifest.$$.json --candidate "$OUT/sync-manifest.json" || {
    rm -f /tmp/prev-manifest.$$.json; echo "corpus went backwards — re-run with --no-verify to override" >&2; exit 1; }
  rm -f /tmp/prev-manifest.$$.json
else
  echo "  (no previous release to compare against — skipping)"
fi

echo "[3/5] stage $RELEASE_ID"
mkdir -p "$STAGE/raw"
# Build-only artifacts stay behind; the release carries what the server reads.
rsync -a --delete \
  --exclude 'raw/messages.duckdb*' --exclude 'faces/dets*.jsonl' \
  --exclude 'faces/embeddings*' --exclude 'faces/extract.done' \
  "$OUT"/ "$STAGE"/
cp "$DB" "$STAGE/raw/messages.duckdb.new"

echo "[4/5] verify + activate"
bash scripts/host-activate-release.sh "$RELEASE_ID" "$DB_SHA"

echo "[5/5] done — $RELEASE_ID active"
echo "     older releases remain in $RELEASES (prune with: bash scripts/prune-releases.sh --apply)"
