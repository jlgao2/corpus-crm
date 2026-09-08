#!/usr/bin/env bash
# Runs on the homelab. Verifies the staged DuckDB, atomically switches the
# pipeline/output symlink, then asks launchd to restart the portrait service.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <release-id> <expected-db-sha256>   (set RESTART_CMD to restart your server)" >&2
  exit 2
fi

RELEASE_ID="$1"
EXPECTED_SHA="$2"
# How to restart the viewer after the swap. Leave RESTART_CMD unset to skip
# (e.g. if you just run `node pipeline/serve.js` in a terminal and restart by hand).
RESTART_CMD="${RESTART_CMD:-}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8765/}"
restart_service() {
  [ -n "$RESTART_CMD" ] || { echo "  (RESTART_CMD unset — restart the server yourself to pick up $RELEASE_ID)"; return 0; }
  eval "$RESTART_CMD"
}
case "$RELEASE_ID" in
  *[!A-Za-z0-9._-]*|'') echo "unsafe release id" >&2; exit 2 ;;
esac
case "$EXPECTED_SHA" in
  *[!a-f0-9]*|'') echo "unsafe SHA-256" >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.."
RELEASE="pipeline/releases/$RELEASE_ID"
PART="$RELEASE/raw/messages.duckdb.new"
DB="$RELEASE/raw/messages.duckdb"
MANIFEST="$RELEASE/sync-manifest.json"
OUTPUT="pipeline/output"
NEXT="pipeline/.output.next"
PREVIOUS_TARGET=""

[ -d "$RELEASE" ] || { echo "missing staged release: $RELEASE" >&2; exit 1; }
[ -f "$PART" ] || { echo "missing staged database: $PART" >&2; exit 1; }
[ -f "$MANIFEST" ] || { echo "missing staged manifest: $MANIFEST" >&2; exit 1; }

MANIFEST_SHA="$(${NODE:-node} -e '
  const fs = require("fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(manifest.database.sha256);
' "$MANIFEST")"
[ "$MANIFEST_SHA" = "$EXPECTED_SHA" ] || {
  echo "manifest SHA mismatch: expected $EXPECTED_SHA, found $MANIFEST_SHA" >&2
  exit 1
}

echo "verifying staged DuckDB ($RELEASE_ID)"
ACTUAL_SHA="$(shasum -a 256 "$PART" | awk '{print $1}')"
[ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] || {
  echo "database SHA mismatch: expected $EXPECTED_SHA, found $ACTUAL_SHA" >&2
  exit 1
}
mv -f "$PART" "$DB"

rm -f "$NEXT"
ln -s "releases/$RELEASE_ID" "$NEXT"
if [ -L "$OUTPUT" ]; then
  PREVIOUS_TARGET="$(readlink "$OUTPUT")"
elif [ -e "$OUTPUT" ]; then
  LEGACY="pipeline/releases/legacy-$(date -u +%Y%m%dT%H%M%SZ)"
  echo "preserving previous output as $LEGACY"
  mv "$OUTPUT" "$LEGACY"
  PREVIOUS_TARGET="releases/${LEGACY##*/}"
fi
if mv -h "$NEXT" "$OUTPUT" 2>/dev/null; then :; else rm -rf "$OUTPUT"; mv "$NEXT" "$OUTPUT"; fi
printf '%s\n' "$RELEASE_ID" > "$RELEASE/.active-release"

restart_service
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null; then
    echo "activated $RELEASE_ID; server healthy at $HEALTH_URL"
    exit 0
  fi
  sleep 1
done

echo "release health check failed at $HEALTH_URL" >&2
if [ -n "$PREVIOUS_TARGET" ]; then
  echo "rolling back to $PREVIOUS_TARGET" >&2
  rm -f "$NEXT"
  ln -s "$PREVIOUS_TARGET" "$NEXT"
  if mv -h "$NEXT" "$OUTPUT" 2>/dev/null; then :; else rm -rf "$OUTPUT"; mv "$NEXT" "$OUTPUT"; fi
  restart_service
fi
exit 1
