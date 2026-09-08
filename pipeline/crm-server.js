#!/usr/bin/env node
import express from 'express';
import https from 'node:https';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from './crm-server/db.js';
import { tailscaleIp } from './crm-server/tailscale.js';
import { peopleRouter } from './crm-server/routes-people.js';
import { interactionsRouter } from './crm-server/routes-interactions.js';
import { connectionsRouter } from './crm-server/routes-connections.js';
import { syncRouter } from './crm-server/routes-sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.CRM_DB_PATH || path.join(__dirname, 'output', 'crm.sqlite');
const PORT = parseInt(process.env.CRM_PORT || '8766', 10);

const db = openDb(DB_PATH);
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, now: Date.now() });
});

app.use('/api', peopleRouter(db));
app.use('/api', interactionsRouter(db));
app.use('/api', connectionsRouter(db));
app.use('/api', syncRouter(db));

const DIST_DIR = path.join(__dirname, '..', 'dist');
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  // SPA fallback for client-side routing
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(DIST_DIR, 'index.html')));
}

const CERT = process.env.CRM_CERT;
const KEY = process.env.CRM_KEY;

function listen(host) {
  if (CERT && KEY) {
    https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, app)
      .listen(PORT, host, () => console.log(`[crm-server] https://${host}:${PORT}`));
  } else {
    app.listen(PORT, host, () => console.log(`[crm-server] http://${host}:${PORT}`));
  }
}

const ts = tailscaleIp();
const binds = ['127.0.0.1', ts].filter(Boolean);

for (const host of (binds.length ? binds : ['127.0.0.1'])) listen(host);

process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('SIGINT',  () => { db.close(); process.exit(0); });
