import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db.js';
import { peopleRouter } from '../routes-people.js';
import { interactionsRouter } from '../routes-interactions.js';
import { syncRouter } from '../routes-sync.js';

function makeApp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-sync-'));
  const db = openDb(path.join(tmp, 'test.sqlite'));
  const app = express();
  app.use(express.json());
  app.use('/api', peopleRouter(db));
  app.use('/api', interactionsRouter(db));
  app.use('/api', syncRouter(db));
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

test('sync replays add_person + add_interaction ops and returns deltas', async () => {
  const { app, cleanup } = makeApp();
  try {
    const ops = [
      { op_id: '1', kind: 'add_person', payload: { id: 'p1', name: 'Maya', tags: ['hiking'] }, created_at: 1 },
      { op_id: '2', kind: 'add_interaction', payload: { id: 'i1', person_id: 'p1', kind: 'note', body: 'coffee', occurred_at: 100 }, created_at: 2 },
    ];
    const r = await call(app, 'POST', '/api/sync', { since: 0, ops });
    assert.equal(r.status, 200);
    assert.ok(r.body.now > 0);
    assert.equal(r.body.people.length, 1);
    assert.equal(r.body.people[0].name, 'Maya');
    assert.equal(r.body.interactions.length, 1);
    assert.equal(r.body.interactions[0].body, 'coffee');
  } finally { cleanup(); }
});

test('sync since=t returns only items updated after t', async () => {
  const { app, cleanup } = makeApp();
  try {
    await call(app, 'POST', '/api/sync', { since: 0, ops: [
      { op_id:'a', kind:'add_person', payload:{ id:'p1', name:'A' }, created_at: 1 }
    ]});
    const checkpoint = Date.now();
    await new Promise(r => setTimeout(r, 5));
    await call(app, 'POST', '/api/sync', { since: checkpoint, ops: [
      { op_id:'b', kind:'add_person', payload:{ id:'p2', name:'B' }, created_at: 1 }
    ]});
    const r = await call(app, 'POST', '/api/sync', { since: checkpoint, ops: [] });
    const names = r.body.people.map(p => p.name).sort();
    assert.deepEqual(names, ['B']);
  } finally { cleanup(); }
});

test('sync update_person last-write-wins on field', async () => {
  const { app, cleanup } = makeApp();
  try {
    await call(app, 'POST', '/api/sync', { since: 0, ops: [
      { op_id:'1', kind:'add_person', payload:{ id:'p1', name:'X', notes:'old' }, created_at: 1 },
      { op_id:'2', kind:'update_person', payload:{ id:'p1', notes:'new' }, created_at: 2 },
    ]});
    const r = await call(app, 'POST', '/api/sync', { since: 0, ops: [] });
    assert.equal(r.body.people[0].notes, 'new');
  } finally { cleanup(); }
});

test('sync delete_person soft-deletes and is reflected in deltas', async () => {
  const { app, cleanup } = makeApp();
  try {
    await call(app, 'POST', '/api/sync', { since: 0, ops: [
      { op_id:'1', kind:'add_person', payload:{ id:'p1', name:'X' }, created_at: 1 },
      { op_id:'2', kind:'delete_person', payload:{ id:'p1' }, created_at: 2 },
    ]});
    const r = await call(app, 'POST', '/api/sync', { since: 0, ops: [] });
    assert.equal(r.body.people.length, 1);
    assert.ok(r.body.people[0].deleted_at);
  } finally { cleanup(); }
});
