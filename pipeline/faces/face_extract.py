#!/usr/bin/env python3
"""Detect + embed faces in Google Photos with InsightFace buffalo_l.

Reads photos.jsonl ({photo_id, asset_path}), runs detection + 512-d
embedding across a multiprocessing pool (each worker uses CoreML on Apple
silicon), appends one line per detected face to dets.jsonl, and records
processed photo_ids in extract.done for resumability.

Env:
  FACES_DIR     output dir (default: <repo>/pipeline/output/faces)
  FACE_WORKERS  pool size (default: os.cpu_count())
  FACE_LIMIT    process only the first N todo photos (sampling/validation)
  FACE_DET_SIZE detector input size (default 640)
"""
import os, sys, json, multiprocessing as mp
from pathlib import Path
import numpy as np

FACES_DIR = Path(os.environ.get("FACES_DIR", str(Path(__file__).resolve().parent.parent / "output" / "faces")))
PHOTOS = FACES_DIR / "photos.jsonl"
DETS = FACES_DIR / "dets.jsonl"
DONE = FACES_DIR / "extract.done"
WORKERS = int(os.environ.get("FACE_WORKERS", os.cpu_count() or 4))
LIMIT = int(os.environ.get("FACE_LIMIT", "0"))
DET_SIZE = int(os.environ.get("FACE_DET_SIZE", "640"))

_app = None

def _init():
    global _app
    import pillow_heif; pillow_heif.register_heif_opener()
    import onnxruntime as ort
    from insightface.app import FaceAnalysis
    avail = ort.get_available_providers()
    provs = (["CoreMLExecutionProvider"] if "CoreMLExecutionProvider" in avail else []) + ["CPUExecutionProvider"]
    _app = FaceAnalysis(name="buffalo_l", providers=provs)
    _app.prepare(ctx_id=0, det_size=(DET_SIZE, DET_SIZE))

def _process(item):
    global _app
    from PIL import Image
    pid, ap = item["photo_id"], item["asset_path"]
    try:
        img = Image.open(ap).convert("RGB")
        arr = np.asarray(img)[:, :, ::-1]  # RGB -> BGR
        faces = _app.get(arr)
        out = []
        for i, f in enumerate(faces):
            x1, y1, x2, y2 = [round(float(v), 1) for v in f.bbox]
            out.append({
                "det_id": f"{pid}#{i}",
                "photo_id": pid,
                "bbox": [x1, y1, x2, y2],
                "det_score": float(f.det_score),
                "embedding": [round(float(v), 6) for v in f.normed_embedding],
            })
        return (pid, out, None)
    except Exception as e:
        return (pid, None, str(e)[:160])

def main():
    FACES_DIR.mkdir(parents=True, exist_ok=True)
    photos = [json.loads(l) for l in PHOTOS.read_text().splitlines() if l.strip()]
    done = set(DONE.read_text().split()) if DONE.exists() else set()
    todo = [p for p in photos if p["photo_id"] not in done]
    IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.heic', '.heif', '.gif', '.webp', '.tiff', '.bmp'}
    n_before = len(todo)
    todo = [p for p in todo if Path(p["asset_path"]).suffix.lower() in IMAGE_EXTS]
    print(f"skipped {n_before - len(todo)} non-image files", flush=True)
    if LIMIT:
        todo = todo[:LIMIT]
    print(f"{len(photos)} photos, {len(done)} done, {len(todo)} todo, {WORKERS} workers", flush=True)
    if not todo:
        print("nothing to do", flush=True); return
    dets_f = open(DETS, "a")
    done_f = open(DONE, "a")
    n_faces = n_err = n_done = 0
    with mp.Pool(WORKERS, initializer=_init) as pool:
        for pid, out, err in pool.imap_unordered(_process, todo, chunksize=4):
            n_done += 1
            if err is not None:
                n_err += 1
                sys.stderr.write(f"ERR {pid}: {err}\n")
            else:
                for d in out:
                    dets_f.write(json.dumps(d) + "\n")
                n_faces += len(out)
            dets_f.flush()            # flush dets BEFORE marking the photo done
            done_f.write(pid + "\n")
            done_f.flush()
            if n_done % 500 == 0:
                print(f"  {n_done}/{len(todo)} photos, {n_faces} faces, {n_err} errors", flush=True)
    dets_f.close(); done_f.close()
    print(f"DONE: {n_done} photos, {n_faces} faces, {n_err} errors -> {DETS}", flush=True)

if __name__ == "__main__":
    mp.set_start_method("spawn", force=True)  # avoid fork issues w/ onnxruntime/CoreML
    main()
