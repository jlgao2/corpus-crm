import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../db.js';
import { peopleRouter } from '../routes-people.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeApp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-people-'));
  const db = openDb(path.join(tmp, 'test.sqlite'));
  const app = express();
  app.use(express.json());
  app.use('/api', peopleRouter(db));
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

test('POST /api/people creates a person and GET returns it', async () => {
  const { app, cleanup } = makeApp();
  try {
    const created = await call(app, 'POST', '/api/people', { name: 'Maya', relationship: 'friend', tags: ['hiking'] });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'Maya');
    assert.deepEqual(created.body.tags, ['hiking']);
    const list = await call(app, 'GET', '/api/people');
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].name, 'Maya');
  } finally { cleanup(); }
});

test('PATCH /api/people/:id updates fields and tags', async () => {
  const { app, cleanup } = makeApp();
  try {
    const c = await call(app, 'POST', '/api/people', { name: 'Leo' });
    const id = c.body.id;
    const u = await call(app, 'PATCH', `/api/people/${id}`, { notes: 'caught up', tags: ['gym','college'] });
    assert.equal(u.status, 200);
    assert.equal(u.body.notes, 'caught up');
    assert.deepEqual(u.body.tags.sort(), ['college','gym']);
  } finally { cleanup(); }
});

test('DELETE /api/people/:id soft-deletes', async () => {
  const { app, cleanup } = makeApp();
  try {
    const c = await call(app, 'POST', '/api/people', { name: 'Jordan' });
    const d = await call(app, 'DELETE', `/api/people/${c.body.id}`);
    assert.equal(d.status, 204);
    const list = await call(app, 'GET', '/api/people');
    assert.equal(list.body.length, 0);
  } finally { cleanup(); }
});
