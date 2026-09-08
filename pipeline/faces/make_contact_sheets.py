#!/usr/bin/env python3
"""Build contact-sheet montages for the biggest face clusters, plus a
label template with per-cluster metadata (date range, top GPS places).

Reads photos.jsonl, dets_clustered.jsonl, clusters.json. Writes:
  clusters/cluster_<id>.png            montage of up to 9 exemplar faces
  face-labels.template.json            [{cluster_id,n_faces,montage,date_range,top_places,label:""}]
  ../../face-labels.json               seeded from the template IF it does not already exist

Env:
  FACES_DIR        default <repo>/pipeline/output/faces
  FACE_LABEL_MIN   min cluster size to surface (default 8)
  FACE_LABEL_TOP   cap on number of clusters (default 60)
"""
import os, json
from collections import defaultdict
from pathlib import Path
from PIL import Image
import pillow_heif; pillow_heif.register_heif_opener()

FACES_DIR = Path(os.environ.get("FACES_DIR", str(Path(__file__).resolve().parent.parent / "output" / "faces")))
LABELS_TRACKED = Path(__file__).resolve().parent.parent / "face-labels.json"  # pipeline/face-labels.json
MIN = int(os.environ.get("FACE_LABEL_MIN", "8"))
TOP = int(os.environ.get("FACE_LABEL_TOP", "60"))
THUMB, COLS, MAX = 112, 3, 9
DTHUMB, DCOLS, DETAIL_MAX = 120, 6, 24  # detail montage for click-to-expand

def main():
    photos = {}
    for l in open(FACES_DIR / "photos.jsonl"):
        if l.strip():
            p = json.loads(l); photos[p["photo_id"]] = p
    detbb = {}
    for l in open(FACES_DIR / "dets_clustered.jsonl"):
        if l.strip():
            d = json.loads(l); detbb[d["det_id"]] = d
    clusters = json.load(open(FACES_DIR / "clusters.json"))["clusters"]
    top = [c for c in clusters if c["n_faces"] >= MIN][:TOP]
    out_dir = FACES_DIR / "clusters"; out_dir.mkdir(parents=True, exist_ok=True)

    template = []
    for c in top:
        thumbs = []
        for det_id in c["exemplar_det_ids"][:MAX]:
            d = detbb.get(det_id); p = photos.get(d["photo_id"]) if d else None
            if not p:
                continue
            try:
                im = Image.open(p["asset_path"]).convert("RGB")
                x1, y1, x2, y2 = d["bbox"]
                pw, ph = (x2 - x1) * 0.3, (y2 - y1) * 0.3  # 30% pad
                box = (max(0, int(x1 - pw)), max(0, int(y1 - ph)),
                       min(im.width, int(x2 + pw)), min(im.height, int(y2 + ph)))
                thumbs.append(im.crop(box).resize((THUMB, THUMB)))
            except Exception:
                continue
        rows = max(1, (len(thumbs) + COLS - 1) // COLS)
        sheet = Image.new("RGB", (COLS * THUMB, rows * THUMB), (20, 20, 20))
        for i, t in enumerate(thumbs):
            sheet.paste(t, ((i % COLS) * THUMB, (i // COLS) * THUMB))
        sheet.save(out_dir / f"cluster_{c['cluster_id']}.png")

        # detail montage: more crops, larger — for the click-to-expand view
        dthumbs = []
        for det_id in c["det_ids"][:DETAIL_MAX]:
            d = detbb.get(det_id); p = photos.get(d["photo_id"]) if d else None
            if not p:
                continue
            try:
                im = Image.open(p["asset_path"]).convert("RGB")
                x1, y1, x2, y2 = d["bbox"]
                pw, ph = (x2 - x1) * 0.3, (y2 - y1) * 0.3
                box = (max(0, int(x1 - pw)), max(0, int(y1 - ph)),
                       min(im.width, int(x2 + pw)), min(im.height, int(y2 + ph)))
                dthumbs.append(im.crop(box).resize((DTHUMB, DTHUMB)))
            except Exception:
                continue
        drows = max(1, (len(dthumbs) + DCOLS - 1) // DCOLS)
        dsheet = Image.new("RGB", (DCOLS * DTHUMB, drows * DTHUMB), (20, 20, 20))
        for i, t in enumerate(dthumbs):
            dsheet.paste(t, ((i % DCOLS) * DTHUMB, (i // DCOLS) * DTHUMB))
        dsheet.save(out_dir / f"cluster_{c['cluster_id']}_detail.png")

        pids = [detbb[did]["photo_id"] for did in c["det_ids"] if did in detbb]
        ts = [photos[pid]["ts"] for pid in pids if pid in photos and photos[pid].get("ts")]
        places = defaultdict(int)
        for pid in pids:
            p = photos.get(pid)
            if p and p.get("city"):
                places[(p["city"], p.get("country"))] += 1
        top_places = sorted(places.items(), key=lambda kv: -kv[1])[:3]
        template.append({
            "cluster_id": c["cluster_id"], "n_faces": c["n_faces"],
            "montage": f"clusters/cluster_{c['cluster_id']}.png",
            "detail": f"clusters/cluster_{c['cluster_id']}_detail.png",
            "date_range": [min(ts) if ts else None, max(ts) if ts else None],
            "top_places": [{"city": k[0], "country": k[1], "n": v} for k, v in top_places],
            "label": "",  # FILL: an existing person's name, or "skip"
        })

    doc = {"clusters": template}
    (FACES_DIR / "face-labels.template.json").write_text(json.dumps(doc, indent=2))
    if not LABELS_TRACKED.exists():
        LABELS_TRACKED.write_text(json.dumps(doc, indent=2))
        print(f"seeded {LABELS_TRACKED} — edit `label` per cluster")
    print(f"wrote {len(top)} contact sheets -> {out_dir}", flush=True)

if __name__ == "__main__":
    main()
