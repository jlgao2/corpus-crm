import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db.js';
import { peopleRouter } from '../routes-people.js';
import { connectionsRouter } from '../routes-connections.js';

function makeApp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-conn-'));
  const db = openDb(path.join(tmp, 'test.sqlite'));
  const app = express();
  app.use(express.json());
  app.use('/api', peopleRouter(db));
  app.use('/api', connectionsRouter(db));
  return { app, db, cleanup: () => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

async function call(app, method, url, body) {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = request({ hostname:'127.0.0.1', port, path:url, method, headers:{'content-type':'application/json'} }, (res) => {
        let buf=''; res.on('data', c => buf+=c);
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: buf?JSON.parse(buf):null }); });
      });
      req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
    });
  });
}

test('PUT connection upserts; GET lists all', async () => {
  const { app, cleanup } = makeApp();
  try {
    const a = (await call(app, 'POST', '/api/people', { name:'A' })).body.id;
    const b = (await call(app, 'POST', '/api/people', { name:'B' })).body.id;
    const r1 = await call(app, 'PUT', `/api/connections/${a}/${b}`, { strength: 3 });
    assert.equal(r1.status, 200);
    const list = await call(app, 'GET', '/api/connections');
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].strength, 3);
    const r2 = await call(app, 'PUT', `/api/connections/${a}/${b}`, { strength: 5 });
    assert.equal(r2.body.strength, 5);
  } finally { cleanup(); }
});
