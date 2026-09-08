#!/usr/bin/env python3
"""Cluster face embeddings (HDBSCAN, cosine via unit-vector euclidean).

Reads dets.jsonl, writes:
  clusters.json         {n_clusters, n_dets, n_noise, clusters:[{cluster_id,n_faces,det_ids,exemplar_det_ids,exemplar_photo_ids}]}  (sorted by size desc)
  dets_clustered.jsonl  {det_id, photo_id, bbox, det_score, cluster_id}  (no embeddings; -1 = noise)

Env:
  FACES_DIR               default <repo>/pipeline/output/faces
  FACE_MIN_CLUSTER_SIZE   HDBSCAN min_cluster_size (default 5)
  FACE_DET_SCORE_MIN      drop detections below this score before clustering (default 0.5)
"""
import os, json
from collections import defaultdict
from pathlib import Path
import numpy as np
from sklearn.cluster import HDBSCAN

FACES_DIR = Path(os.environ.get("FACES_DIR", str(Path(__file__).resolve().parent.parent / "output" / "faces")))
DETS = FACES_DIR / "dets.jsonl"
CLUSTERS = FACES_DIR / "clusters.json"
DETS_CL = FACES_DIR / "dets_clustered.jsonl"
MIN_CLUSTER = int(os.environ.get("FACE_MIN_CLUSTER_SIZE", "5"))
SCORE_MIN = float(os.environ.get("FACE_DET_SCORE_MIN", "0.5"))
MERGE_COS = float(os.environ.get("FACE_MERGE_COS", "0.5"))  # merge clusters whose centroid cosine >= this (set 1.0 to disable)

def main():
    dets, embs, keep = [], [], []
    seen = set()
    for line in open(DETS):
        if not line.strip():
            continue
        d = json.loads(line)
        if d["det_id"] in seen:        # defend against resume-duplication
            continue
        seen.add(d["det_id"])
        dets.append(d)
        embs.append(d["embedding"])
        keep.append(d["det_score"] >= SCORE_MIN)
    if not dets:
        raise SystemExit("no dets.jsonl rows — run face_extract.py first")
    X = np.asarray(embs, dtype=np.float32)
    keep = np.asarray(keep)
    labels = np.full(len(dets), -1, dtype=int)
    if keep.sum() >= MIN_CLUSTER:
        cl = HDBSCAN(min_cluster_size=MIN_CLUSTER, metric="euclidean")
        labels[np.where(keep)[0]] = cl.fit_predict(X[keep])   # normed embeddings: euclidean ~ cosine

    # Merge over-split clusters: the same person often lands in several HDBSCAN
    # clusters. Union any two clusters whose (normalized) mean-embedding cosine
    # similarity >= MERGE_COS, then renumber contiguously.
    if MERGE_COS < 1.0:
        uniq = sorted({int(l) for l in labels if l >= 0})
        if len(uniq) > 1:
            cents = []
            for cid in uniq:
                v = X[np.where(labels == cid)[0]].mean(axis=0)
                nrm = np.linalg.norm(v)
                cents.append(v / nrm if nrm else v)
            sims = np.stack(cents) @ np.stack(cents).T   # cosine (unit vectors)
            parent = list(range(len(uniq)))
            def find(a):
                while parent[a] != a:
                    parent[a] = parent[parent[a]]; a = parent[a]
                return a
            for i in range(len(uniq)):
                for j in range(i + 1, len(uniq)):
                    if sims[i, j] >= MERGE_COS:
                        parent[find(j)] = find(i)
            roots = sorted({find(i) for i in range(len(uniq))})
            renum = {r: n for n, r in enumerate(roots)}
            remap = {uniq[i]: renum[find(i)] for i in range(len(uniq))}
            labels = np.array([remap[int(l)] if l >= 0 else -1 for l in labels])
            if len(roots) < len(uniq):
                print(f"merged {len(uniq)} -> {len(roots)} clusters (centroid cos >= {MERGE_COS})", flush=True)

    members = defaultdict(list)
    for i, lab in enumerate(labels):
        if lab >= 0:
            members[int(lab)].append(i)
    clusters = []
    for cid, idxs in members.items():
        idxs.sort(key=lambda i: -dets[i]["det_score"])   # best detections first
        ex = idxs[:9]
        clusters.append({
            "cluster_id": cid,
            "n_faces": len(idxs),
            "det_ids": [dets[i]["det_id"] for i in idxs],
            "exemplar_det_ids": [dets[i]["det_id"] for i in ex],
            "exemplar_photo_ids": [dets[i]["photo_id"] for i in ex],
        })
    clusters.sort(key=lambda c: -c["n_faces"])
    CLUSTERS.write_text(json.dumps({
        "n_clusters": len(clusters), "n_dets": len(dets),
        "n_noise": int((labels < 0).sum()), "clusters": clusters}))
    with open(DETS_CL, "w") as f:
        for i, d in enumerate(dets):
            f.write(json.dumps({"det_id": d["det_id"], "photo_id": d["photo_id"],
                "bbox": d["bbox"], "det_score": d["det_score"], "cluster_id": int(labels[i])}) + "\n")
    print(f"{len(dets)} dets -> {len(clusters)} clusters, {int((labels<0).sum())} noise", flush=True)

if __name__ == "__main__":
    main()
