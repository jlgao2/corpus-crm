import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';

// macOS CallHistory.storedata is Core Data SQLite. ZDATE is seconds since the
// Apple/Core-Data epoch (2001-01-01); convert to unix seconds by adding this.
const APPLE_EPOCH = 978307200;

// Read call records from a CallHistory SQLite snapshot. Returns normalized rows
// (ts unix ms, duration seconds, direction in/out, answered/missed, service).
export function loadCalls(dbPath) {
  if (!fs.existsSync(dbPath)) { console.warn(`[calls] no DB at ${dbPath}`); return []; }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rows;
  try {
    rows = db.prepare(`
      SELECT Z_PK pk, ZUNIQUE_ID uid, ZDATE date, ZDURATION dur, ZORIGINATED orig,
             ZANSWERED ans, ZADDRESS addr, ZNAME nm, ZSERVICE_PROVIDER svc
      FROM ZCALLRECORD WHERE ZDATE IS NOT NULL`).all();
  } finally { db.close(); }
  return rows.map(r => {
    const dur = Number(r.dur) || 0;
    const answered = Number(r.ans) === 1;
    return {
      call_id: r.uid || ('call:' + r.pk),
      ts: Math.round((Number(r.date) + APPLE_EPOCH) * 1000),
      duration_s: dur,
      direction: Number(r.orig) === 1 ? 'out' : 'in',
      answered,
      missed: !answered && dur === 0,
      service: /FaceTime/i.test(r.svc || '') ? 'facetime' : 'phone',
      address: r.addr || null,
      name: r.nm || null,
    };
  });
}
