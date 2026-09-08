# Face recognition sidecar (Phase 4b)

First-time setup:
```bash
python3 -m venv pipeline/faces/.venv
pipeline/faces/.venv/bin/pip install -r pipeline/faces/requirements.txt
```

Full run (from repo root; needs `messages.duckdb` built):
```bash
npm run faces:export          # DuckDB -> pipeline/output/faces/photos.jsonl  (gphotos only)
npm run faces:extract         # detect + embed (parallel, CoreML). Env: FACE_WORKERS, FACE_LIMIT
npm run faces:cluster         # HDBSCAN -> clusters.json + dets_clustered.jsonl
npm run faces:sheets          # montages -> output/faces/clusters/*.png + seed pipeline/face-labels.json
# (optional) npm run faces:caption   # Qwen suggestions -> face-labels.suggested.json  (needs locallmm up)
#  --> open the contact sheets, fill `label` per cluster in pipeline/face-labels.json
#      (an existing person's display_name, or "skip")
npm run build-faces           # resolve labeled clusters -> photo_faces, flip has_named_face
```

Notes:
- Tunables: `FACE_WORKERS` (pool size), `FACE_LIMIT` (sample N), `FACE_MIN_CLUSTER_SIZE`,
  `FACE_DET_SCORE_MIN`, `FACE_LABEL_MIN`/`FACE_LABEL_TOP` (which clusters get sheets).
- `faces:extract` is resumable (re-run to continue; tracks `extract.done`).
- Only labels matching an existing `identities.display_name` enter `photo_faces`; unmatched
  labels stay in `face_clusters.label`. Co-presence graph edges are Phase 6.
