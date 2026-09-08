#!/usr/bin/env bash
# Delete old releases, always keeping the active one and the N most recent.
#   bash scripts/prune-releases.sh              # dry run
#   bash scripts/prune-releases.sh --apply      # delete
#   KEEP=5 bash scripts/prune-releases.sh --apply
set -euo pipefail
cd "$(dirname "$0")/.."
RELEASES="pipeline/releases"
KEEP="${KEEP:-3}"
APPLY="${1:-}"
[ -d "$RELEASES" ] || { echo "no releases directory"; exit 0; }

ACTIVE=""
[ -L pipeline/output ] && ACTIVE="$(basename "$(readlink pipeline/output)")"
echo "active: ${ACTIVE:-<none>} | keeping newest $KEEP"

mapfile -t ALL < <(ls -1 "$RELEASES" | sort -r)
i=0; freed=0
for r in "${ALL[@]}"; do
  [ -d "$RELEASES/$r" ] || continue
  i=$((i+1))
  if [ "$r" = "$ACTIVE" ] || [ "$i" -le "$KEEP" ]; then printf '  keep   %s\n' "$r"; continue; fi
  sz="$(du -sk "$RELEASES/$r" | awk '{print $1}')"; freed=$((freed+sz))
  if [ "$APPLY" = "--apply" ]; then rm -rf "$RELEASES/$r"; printf '  DELETED %s\n' "$r"
  else printf '  would delete %s (%s MB)\n' "$r" "$((sz/1024))"; fi
done
printf '%s %s MB\n' "$([ "$APPLY" = "--apply" ] && echo freed || echo 'would free')" "$((freed/1024))"
