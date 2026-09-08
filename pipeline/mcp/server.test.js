import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb } from '../crm-server/db.js';
import { createCorpus } from './corpus.js';
import { createAnnotations } from './annotations.js';
import { buildServer } from './server.js';

let dir, crmDb, client;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-server-test-'));
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
  const server = buildServer({ corpus, annotations });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

after(() => {
  crmDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lists all nine tools', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['get_conversation_window', 'log_interaction', 'on_this_day', 'person_summary',
     'query', 'resolve_person', 'schema', 'search_messages', 'set_follow_up'],
  );
});

test('resolve_person round-trips through the protocol', async () => {
  const res = await client.callTool({ name: 'resolve_person', arguments: { query: 'maya' } });
  const out = JSON.parse(res.content[0].text);
  assert.equal(out[0].canonical_id, 'id-1242');
});

test('log_interaction writes through to crm.sqlite', async () => {
  const res = await client.callTool({
    name: 'log_interaction',
    arguments: { person_id: 'id-1242', kind: 'note', body: 'from the smoke test' },
  });
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.kind, 'note');
  const row = crmDb.prepare('SELECT * FROM interactions WHERE id = ?').get(out.id);
  assert.equal(row.body, 'from the smoke test');
});

test('tool errors surface as isError, not protocol failures', async () => {
  const res = await client.callTool({ name: 'query', arguments: { sql: 'DROP TABLE messages' } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /read-only/i);
});
