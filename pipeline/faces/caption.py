#!/usr/bin/env python3
"""OPTIONAL: suggest names for face clusters via the local MLX model
(through locallmm's OpenAI-compatible proxy). Off by default.

Reads face-labels.template.json. Writes face-labels.suggested.json with a
`suggested` field per cluster (you copy good ones into pipeline/face-labels.json).

Modes (env FACE_CAPTION_MODE):
  text   (default) — send each cluster's metadata (date range, top places); works with a text model.
  vision           — also send the montage PNG as an image_url data-URL; needs a VL model served.

Env:
  FACE_CAPTION_URL    default http://127.0.0.1:8100/v1/chat/completions
  FACE_CAPTION_MODEL  optional model id (server default if empty)
  FACE_CAPTION_MODE   text | vision
  FACE_KNOWN_NAMES    optional comma-separated candidate names to bias suggestions
"""
import os, json, base64, urllib.request
from pathlib import Path

FACES_DIR = Path(os.environ.get("FACES_DIR", str(Path(__file__).resolve().parent.parent / "output" / "faces")))
URL = os.environ.get("FACE_CAPTION_URL", "http://127.0.0.1:8100/v1/chat/completions")
MODEL = os.environ.get("FACE_CAPTION_MODEL", "")
MODE = os.environ.get("FACE_CAPTION_MODE", "text")
KNOWN = [n.strip() for n in os.environ.get("FACE_KNOWN_NAMES", "").split(",") if n.strip()]

def ask(content):
    payload = {"messages": [{"role": "user", "content": content}], "stream": False}
    if MODEL:
        payload["model"] = MODEL
    req = urllib.request.Request(URL, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=900) as r:
        return json.load(r)["choices"][0]["message"]["content"].strip()

def prompt_text(c):
    dr = c.get("date_range") or [None, None]
    places = ", ".join(f"{p['city']}" for p in c.get("top_places", [])) or "unknown"
    hint = f" Candidate names: {', '.join(KNOWN)}." if KNOWN else ""
    return (f"A recurring person appears in {c['n_faces']} of my photos, taken around "
            f"{dr[0]}..{dr[1]} (unix ms), mostly in {places}. Based only on this, guess a short "
            f"role/label (e.g. 'family', 'colleague', 'partner').{hint} Reply with just the label.")

def prompt_vision(c):
    hint = f" If the person resembles one of these, name which: {', '.join(KNOWN)}." if KNOWN else ""
    return ("These are face crops of ONE person from my photo library. In 8 words or fewer, describe "
            "them so I can recognize who it is: apparent age range, gender, and one or two distinguishing "
            "features (e.g. 'young woman, long dark hair, glasses')." + hint +
            " Reply with ONLY the short description.")

def main():
    tmpl = json.load(open(FACES_DIR / "face-labels.template.json"))
    for c in tmpl["clusters"]:
        try:
            if MODE == "vision":
                img = base64.b64encode((FACES_DIR / c["montage"]).read_bytes()).decode()
                content = [{"type": "text", "text": prompt_vision(c)},
                           {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img}"}}]
            else:
                content = prompt_text(c)
            c["suggested"] = ask(content)
        except Exception as e:
            c["suggested"] = f"(caption failed: {str(e)[:120]})"
    (FACES_DIR / "face-labels.suggested.json").write_text(json.dumps(tmpl, indent=2))
    print(f"wrote suggestions for {len(tmpl['clusters'])} clusters -> face-labels.suggested.json", flush=True)

if __name__ == "__main__":
    main()
