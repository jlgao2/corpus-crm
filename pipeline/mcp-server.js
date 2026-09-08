#!/usr/bin/env node
// crm-mcp — MCP server over the life-corpus.
// Read side: pipeline/output/raw/messages.duckdb (always READ_ONLY, opened per call).
// Write side: pipeline/output/crm.sqlite (annotations only).
//
// Default transport is stdio (Claude Desktop launches it directly). Setting
// MCP_HTTP_PORT serves Streamable HTTP instead, gated by MCP_TOKEN.
//
// HTTP mode binds 127.0.0.1 only. Add MCP_BIND_TAILNET=1 to ALSO publish on
// this host's Tailscale address — needed on the homelab, where Excalibur's
// `crm` spellbook reaches it; not wanted on the laptop, whose instance is
// local-only. See pipeline/mcp/bind-hosts.js.
// See docs/superpowers/specs/2026-07-26-crm-mcp-design.md.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDb } from './crm-server/db.js';
import { tailscaleIp } from './crm-server/tailscale.js';
import { createCorpus } from './mcp/corpus.js';
import { createAnnotations } from './mcp/annotations.js';
import { buildServer } from './mcp/server.js';
import { startHttpServer } from './mcp/http.js';
import { bindHosts } from './mcp/bind-hosts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DUCKDB_PATH = process.env.MCP_DUCKDB_PATH || path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const CRM_DB_PATH = process.env.MCP_CRM_DB_PATH || path.join(__dirname, 'output', 'crm.sqlite');
const PORTRAITS_DIR = process.env.MCP_PORTRAITS_DIR || path.join(__dirname, 'output', 'portraits');

const crmDb = openDb(CRM_DB_PATH);
const corpus = createCorpus({ dbPath: DUCKDB_PATH, portraitsDir: PORTRAITS_DIR });
const annotations = createAnnotations({ db: crmDb, lookupIdentity: corpus.getIdentity });

const httpPort = parseInt(process.env.MCP_HTTP_PORT || '', 10);
if (Number.isFinite(httpPort)) {
  const hosts = bindHosts({ resolveTailscaleIp: tailscaleIp });
  await startHttpServer({ corpus, annotations, token: process.env.MCP_TOKEN, port: httpPort, hosts });
} else {
  const server = buildServer({ corpus, annotations });
  await server.connect(new StdioServerTransport());
}

process.on('SIGTERM', () => { crmDb.close(); process.exit(0); });
process.on('SIGINT',  () => { crmDb.close(); process.exit(0); });
