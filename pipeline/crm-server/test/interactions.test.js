import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db.js';
import { peopleRouter } from '../routes-people.js';
import { interactionsRouter } from '../routes-interactions.js';

function makeApp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-int-'));
  const db = openDb(path.join(tmp, 'test.sqlite'));
  const app = express();
  app.use(express.json());
  app.use('/api', peopleRouter(db));
  app.use('/api', interactionsRouter(db));
  return { app, db, cleanup: () => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

async function call(app, method, url, body) {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = request({ hostname: '127.0.0.1', port, path: url, method, headers: { 'content-type':'application/json' } }, (res) => {
        let buf = ''; res.on('data', c => buf += c);
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }); });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

test('POST interaction, then person detail returns it', async () => {
  const { app, cleanup } = makeApp();
  try {
    const p = await call(app, 'POST', '/api/people', { name: 'Maya' });
    const i = await call(app, 'POST', `/api/people/${p.body.id}/interactions`, {
      kind: 'note', body: 'coffee', occurred_at: 1700000000000,
    });
    assert.equal(i.status, 201);
    assert.equal(i.body.kind, 'note');
    const detail = await call(app, 'GET', `/api/people/${p.body.id}`);
    assert.equal(detail.body.interactions.length, 1);
    assert.equal(detail.body.interactions[0].body, 'coffee');
  } finally { cleanup(); }
});

test('PATCH and DELETE interaction', async () => {
  const { app, cleanup } = makeApp();
  try {
    const p = await call(app, 'POST', '/api/people', { name: 'Leo' });
    const i = await call(app, 'POST', `/api/people/${p.body.id}/interactions`, { kind:'call', body:'old', occurred_at: 1 });
    const u = await call(app, 'PATCH', `/api/interactions/${i.body.id}`, { body: 'updated' });
    assert.equal(u.body.body, 'updated');
    const d = await call(app, 'DELETE', `/api/interactions/${i.body.id}`);
    assert.equal(d.status, 204);
    const detail = await call(app, 'GET', `/api/people/${p.body.id}`);
    assert.equal(detail.body.interactions.length, 0);
  } finally { cleanup(); }
});
