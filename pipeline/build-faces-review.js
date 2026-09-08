import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';

// Generate a self-contained HTML page for reviewing + labeling face clusters.
// Reads face-labels.template.json (+ optional face-labels.suggested.json + dets_clustered.jsonl)
// and the montage PNGs (referenced by URL), and writes pipeline/output/faces/review.html.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const FACES_DIR = process.env.FACES_DIR || path.join(__dirname, 'output', 'faces');
const TEMPLATE = path.join(FACES_DIR, 'face-labels.template.json');
const SUGGESTED = path.join(FACES_DIR, 'face-labels.suggested.json');
const DETS_CL = path.join(FACES_DIR, 'dets_clustered.jsonl');
const LABELS = path.join(__dirname, 'face-labels.json');
const OUT = path.join(FACES_DIR, 'review.html');
const LOW_SCORE = parseFloat(process.env.FACE_LOW_SCORE || '0.70'); // mean det_score below this => auto-skip as low-quality

const escHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtMonth = (ms) => (ms == null ? '?' : new Date(Number(ms)).toISOString().slice(0, 7));

async function main() {
  if (!fs.existsSync(TEMPLATE)) {
    console.error(`No ${TEMPLATE} — run 'npm run faces:sheets' first.`);
    process.exit(1);
  }
  const tmpl = JSON.parse(fs.readFileSync(TEMPLATE, 'utf-8'));

  const existing = fs.existsSync(LABELS) ? JSON.parse(fs.readFileSync(LABELS, 'utf-8')) : { clusters: [] };
  const labelByCluster = new Map((existing.clusters || []).map(c => [Number(c.cluster_id), c.label || '']));
  // Unlabeled clusters first (the "next batch" to do), then by size; already named/skipped sink to the bottom.
  const decided = (cid) => ((labelByCluster.get(Number(cid)) || '').trim() ? 1 : 0);
  const clusters = (tmpl.clusters || []).slice()
    .sort((a, b) => decided(a.cluster_id) - decided(b.cluster_id) || b.n_faces - a.n_faces);

  const sugByCluster = new Map();
  if (fs.existsSync(SUGGESTED)) {
    const s = JSON.parse(fs.readFileSync(SUGGESTED, 'utf-8'));
    for (const c of s.clusters || []) sugByCluster.set(Number(c.cluster_id), c.suggested || '');
  }

  // mean detection score per cluster — objective low-quality/junk signal
  const sumByC = new Map(), cntByC = new Map();
  if (fs.existsSync(DETS_CL)) {
    for (const line of fs.readFileSync(DETS_CL, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      const d = JSON.parse(line);
      if (d.cluster_id < 0) continue;
      sumByC.set(d.cluster_id, (sumByC.get(d.cluster_id) || 0) + d.det_score);
      cntByC.set(d.cluster_id, (cntByC.get(d.cluster_id) || 0) + 1);
    }
  }
  const meanScore = (cid) => (cntByC.get(cid) ? sumByC.get(cid) / cntByC.get(cid) : 1);

  let names = [];
  if (fs.existsSync(DB_PATH)) {
    const conn = await (await DuckDBInstance.create(DB_PATH, { access_mode: 'READ_ONLY' })).connect();
    names = (await conn.runAndReadAll(
      `SELECT DISTINCT display_name FROM identities WHERE display_name IS NOT NULL ORDER BY display_name`
    )).getRows().map(r => r[0]);
    await conn.disconnectSync();
  }

  let nLow = 0;
  const cards = clusters.map(c => {
    const cid = Number(c.cluster_id);
    const ms = meanScore(cid);
    const lowq = ms < LOW_SCORE;
    if (lowq) nLow++;
    const existingLabel = labelByCluster.get(cid) || '';
    const prefill = escHtml(existingLabel || (lowq ? 'skip' : ''));  // pre-skip low-quality clusters
    const places = (c.top_places || []).map(p => escHtml(p.city)).filter(Boolean).join(', ') || '—';
    const dr = c.date_range || [null, null];
    const sug = sugByCluster.get(cid);
    const badge = lowq ? ` · <span class="badge">⚠ low-q ${ms.toFixed(2)}</span>` : '';
    return `<div class="card${lowq ? ' lowq' : ''}">
      <img loading="lazy" src="${c.montage}" data-detail="${c.detail || ''}" alt="cluster ${cid}" title="click to see more faces">
      <div class="meta"><b>#${cid}</b> · ${c.n_faces} faces · ${fmtMonth(dr[0])}–${fmtMonth(dr[1])}${badge}<br>
        <span class="places">${places}</span>${sug ? `<br><span class="sug">🤖 ${escHtml(sug)}</span>` : ''}</div>
      <input data-cid="${cid}" value="${prefill}" placeholder="name · skip · blank" autocomplete="off" autocapitalize="words" spellcheck="false">
    </div>`;
  }).join('\n');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Face clusters — label</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{font:14px/1.45 system-ui,-apple-system,sans-serif;margin:0;background:#0f1115;color:#e8e8ea}
  header{position:sticky;top:0;background:#171a21f2;backdrop-filter:blur(6px);padding:14px 18px;border-bottom:1px solid #2a2f3a;z-index:10}
  header h1{margin:0 0 4px;font-size:16px}
  header p{margin:0;color:#9aa0ac;font-size:12px;max-width:900px}
  header code{background:#0f1115;border:1px solid #2a2f3a;border-radius:4px;padding:1px 5px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px;padding:18px 18px 130px}
  .card{background:#171a21;border:1px solid #2a2f3a;border-radius:10px;overflow:hidden;display:flex;flex-direction:column}
  .card.lowq{opacity:.66}
  .card img{width:100%;display:block;background:#000;cursor:zoom-in}
  .meta{padding:8px 10px;font-size:12px;color:#c7ccd6}
  .places{color:#8b93a3}
  .sug{color:#7aa2f7}
  .badge{color:#e0a030;font-weight:600}
  .card input{margin:0 10px 10px;padding:7px 9px;border:1px solid #2a2f3a;border-radius:6px;background:#0f1115;color:#e8e8ea;font-size:13px;width:calc(100% - 20px)}
  .card input:focus{outline:none;border-color:#7aa2f7}
  .card input.set{border-color:#3fb950;background:#10261a}
  .card input.skip{opacity:.5;border-color:#3a3f4a}
  footer{position:fixed;bottom:0;left:0;right:0;background:#171a21f2;backdrop-filter:blur(6px);border-top:1px solid #2a2f3a;padding:12px 18px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  button{padding:8px 14px;border:0;border-radius:6px;background:#7aa2f7;color:#0f1115;font-weight:600;cursor:pointer;font-size:13px}
  button.ghost{background:#2a2f3a;color:#e8e8ea}
  #status{color:#9aa0ac;font-size:12px;margin-left:auto}
  #ac{position:fixed;z-index:1000;display:none;background:#1b1f29;border:1px solid #3a4150;border-radius:6px;max-height:260px;overflow:auto;box-shadow:0 10px 28px #000a}
  .ac-item{padding:6px 10px;cursor:pointer;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ac-item:hover,.ac-item.sel{background:#2a3550}
  #modal{display:none;position:fixed;inset:0;background:#000d;z-index:2000;align-items:center;justify-content:center;padding:16px;cursor:zoom-out}
  #modal img{max-width:100%;max-height:100%;border-radius:8px}
</style></head><body>
<header>
  <h1>Face clusters — label the people you recognize</h1>
  <p>Type a name; the dropdown is your existing contacts, so a match links the cluster to that person. <b>Low-quality clusters</b> (statues, blurry, mixed — dimmed, ⚠) are pre-marked <code>skip</code>; clear it if one is actually someone. <b>Click any montage</b> to see more faces. Type <code>skip</code>/blank to ignore. <b>💾 Save to server</b> when done, then tell me to ingest.</p>
</header>
<div class="grid">${cards}</div>
<footer>
  <button onclick="save()">💾 Save to server</button>
  <button onclick="dl()">⬇ Download face-labels.json</button>
  <button class="ghost" onclick="cp()">⧉ Copy JSON</button>
  <span id="status"></span>
</footer>
<div id="modal" onclick="this.style.display='none'"><img id="modalimg" alt="cluster detail"></div>
<script>
  const NAMES = ${JSON.stringify(names)};
  const inputs=[...document.querySelectorAll('.card input')];
  const norm=v=>v.trim();
  const build=()=>({clusters:inputs.map(i=>({cluster_id:Number(i.dataset.cid),label:norm(i.value)})).filter(c=>c.label)});
  const refresh=()=>{let n=0;inputs.forEach(i=>{const v=norm(i.value).toLowerCase();i.classList.toggle('skip',v==='skip');i.classList.toggle('set',!!v&&v!=='skip');if(v&&v!=='skip')n++;});document.getElementById('status').textContent=n+' people labeled';};

  // ---- custom autocomplete ----
  const ac=document.createElement('div'); ac.id='ac'; document.body.appendChild(ac);
  let acInput=null, acItems=[], acIdx=-1;
  const hideAc=()=>{ac.style.display='none';acInput=null;acIdx=-1;};
  function showAc(input){
    const q=norm(input.value).toLowerCase();
    let m = q ? NAMES.filter(n=>n.toLowerCase().includes(q)) : NAMES.slice();
    m.sort((a,b)=>(a.toLowerCase().startsWith(q)?0:1)-(b.toLowerCase().startsWith(q)?0:1));
    acItems=m.slice(0,12);
    if(!acItems.length){hideAc();return;}
    ac.innerHTML=acItems.map((n,i)=>'<div class="ac-item'+(i===acIdx?' sel':'')+'" data-i="'+i+'">'+n.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</div>').join('');
    const r=input.getBoundingClientRect();
    ac.style.left=r.left+'px'; ac.style.top=(r.bottom+2)+'px'; ac.style.width=r.width+'px'; ac.style.display='block';
    acInput=input;
  }
  const pick=i=>{ if(acInput&&acItems[i]!=null){acInput.value=acItems[i];refresh();} hideAc(); };
  inputs.forEach(input=>{
    input.addEventListener('focus',()=>{acIdx=-1;showAc(input);});
    input.addEventListener('input',()=>{acIdx=-1;showAc(input);refresh();});
    input.addEventListener('blur',()=>setTimeout(hideAc,150));
    input.addEventListener('keydown',e=>{
      if(ac.style.display==='none')return;
      if(e.key==='ArrowDown'){e.preventDefault();acIdx=Math.min(acIdx+1,acItems.length-1);showAc(input);}
      else if(e.key==='ArrowUp'){e.preventDefault();acIdx=Math.max(acIdx-1,0);showAc(input);}
      else if(e.key==='Enter'&&acIdx>=0){e.preventDefault();pick(acIdx);}
      else if(e.key==='Escape'){hideAc();}
    });
  });
  ac.addEventListener('mousedown',e=>{const it=e.target.closest('.ac-item');if(!it)return;e.preventDefault();pick(+it.dataset.i);});
  window.addEventListener('scroll',()=>{if(acInput)showAc(acInput);},true);
  window.addEventListener('resize',()=>{if(acInput)hideAc();});

  // ---- detail view (click montage -> larger crop sheet) ----
  const modal=document.getElementById('modal'), modalimg=document.getElementById('modalimg');
  document.querySelectorAll('.card img').forEach(im=>im.addEventListener('click',()=>{const d=im.dataset.detail;if(d){modalimg.src=d;modal.style.display='flex';}}));
  document.addEventListener('keydown',e=>{if(e.key==='Escape')modal.style.display='none';});

  refresh();

  function save(){
    fetch('/api/face-labels',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(build())})
      .then(r=>r.json()).then(d=>{document.getElementById('status').textContent=d.ok?'saved '+d.n+' people ✓':'save failed (download instead)';})
      .catch(()=>{document.getElementById('status').textContent='save failed (download instead)';});
  }
  // restore prior server-side labels (silently no-op for file://)
  fetch('/api/face-labels').then(r=>r.json()).then(d=>{
    const m=new Map((d.clusters||[]).map(c=>[Number(c.cluster_id),c.label]));
    inputs.forEach(i=>{const v=m.get(Number(i.dataset.cid));if(v)i.value=v;});
    refresh();
  }).catch(()=>{});
  function dl(){const b=new Blob([JSON.stringify(build(),null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='face-labels.json';a.click();}
  function cp(){navigator.clipboard.writeText(JSON.stringify(build(),null,2)).then(()=>document.getElementById('status').textContent='copied to clipboard');}
</script></body></html>`;

  fs.writeFileSync(OUT, html);
  console.log(`wrote ${OUT}\n  ${clusters.length} clusters (${nLow} auto-skipped low-quality), ${names.length} contact names`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
