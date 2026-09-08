import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDb } from '../crm-server/db.js';
import { createCorpus } from './corpus.js';
import { createAnnotations } from './annotations.js';
import { startHttpServer } from './http.js';

const TOKEN = 'test-token-123';
let dir, crmDb, server, baseUrl;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-http-test-'));
  const dbPath = path.join(dir, 'messages.duckdb');
  const inst = await DuckDBInstance.create(dbPath);
  const con = await inst.connect();
  await con.run(`
    CREATE TABLE identities (canonical_id VARCHAR, display_name VARCHAR, aliases VARCHAR[], sources VARCHAR[]);
    CREATE TABLE threads (thread_id VARCHAR, source VARCHAR, is_group BOOLEAN, participants VARCHAR[]);
    CREATE TABLE thread_identity (thread_id VARCHAR, canonical_id VARCHAR);
    CREATE TABLE messages (id VARCHAR, ts BIGINT, ts_iso VARCHAR, source VARCHAR, thread_id VARCHAR,
                           from_me BOOLEAN, sender_name VARCHAR, body VARCHAR, body_lower VARCHAR,
                           meaningful BOOLEAN, attachment_type VARCHAR);
    INSERT INTO identities VALUES ('id-1242', 'Maya Torres', ['Maya'], ['imessage']);
  `);
  con.closeSync();
  inst.closeSync();

  crmDb = openDb(path.join(dir, 'crm.sqlite'));
  const corpus = createCorpus({ dbPath });
  const annotations = createAnnotations({ db: crmDb, lookupIdentity: corpus.getIdentity });
  server = await startHttpServer({ corpus, annotations, token: TOKEN, port: 0, hosts: ['127.0.0.1'] });
  baseUrl = `http://127.0.0.1:${server.port}/mcp`;
});

after(async () => {
  await server.close();
  crmDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a port collision rejects with EADDRINUSE, not a half-started server', async (t) => {
  const { createServer } = await import('node:http');
  const blocker = await new Promise((resolve) => {
    const s = createServer(() => {});
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((r) => blocker.close(r)));
  const takenPort = blocker.address().port;
  await assert.rejects(
    () => startHttpServer({ corpus: {}, annotations: {}, token: 'x', port: takenPort, hosts: ['127.0.0.1'] }),
    /EADDRINUSE/,
  );
});

test('rejects requests without the bearer token', async () => {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }),
  });
  assert.equal(res.status, 401);
});

test('rejects a wrong token', async () => {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer nope' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }),
  });
  assert.equal(res.status, 401);
});

test('serves the full tool surface over HTTP with the token', async () => {
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 9);
  const res = await client.callTool({ name: 'resolve_person', arguments: { query: 'maya' } });
  assert.equal(JSON.parse(res.content[0].text)[0].canonical_id, 'id-1242');
  await client.close();
});
