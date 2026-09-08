#!/usr/bin/env node
// launchd installer for the crm-mcp HTTP server (homelab mode).
// Mirrors install-launchd.js. MCP_TOKEN must be set when installing —
// sourced from .sync.env by the npm script.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, '..');
const TMPL = path.join(__dirname, 'com.demouser.crm-mcp.plist.tmpl');
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.demouser.crm-mcp.plist');
const LOG_DIR = path.join(PROJECT_DIR, 'pipeline', 'output', 'logs');
const SERVER_PATH = path.join(PROJECT_DIR, 'pipeline', 'mcp-server.js');

const cmd = process.argv[2];
if (cmd === 'install') {
  if (!process.env.MCP_TOKEN) {
    console.error('MCP_TOKEN not set. Add it to .sync.env (openssl rand -hex 32) and retry.');
    process.exit(1);
  }
  fs.mkdirSync(LOG_DIR, { recursive: true });
  let tmpl = fs.readFileSync(TMPL, 'utf8');
  tmpl = tmpl
    .replaceAll('{{NODE_PATH}}', process.execPath)
    .replaceAll('{{SERVER_PATH}}', SERVER_PATH)
    .replaceAll('{{PROJECT_DIR}}', PROJECT_DIR)
    .replaceAll('{{LOG_DIR}}', LOG_DIR)
    .replaceAll('{{MCP_HTTP_PORT}}', process.env.MCP_HTTP_PORT || '8770')
    .replaceAll('{{MCP_TOKEN}}', process.env.MCP_TOKEN)
    // On the homelab pipeline/output is a symlink to an immutable release that
    // sync:push swaps out — the annotation store must live OUTSIDE it (same
    // reason face-labels.json sits at pipeline/ level).
    .replaceAll('{{MCP_CRM_DB_PATH}}', process.env.MCP_CRM_DB_PATH || path.join(PROJECT_DIR, 'pipeline', 'crm.sqlite'));
  fs.writeFileSync(PLIST_PATH, tmpl, { mode: 0o600 });
  try { execSync(`launchctl bootout gui/${process.getuid()} ${PLIST_PATH}`, { stdio: 'ignore' }); } catch {}
  execSync(`launchctl bootstrap gui/${process.getuid()} ${PLIST_PATH}`, { stdio: 'inherit' });
  console.log(`installed: ${PLIST_PATH}`);
} else if (cmd === 'uninstall') {
  try { execSync(`launchctl bootout gui/${process.getuid()} ${PLIST_PATH}`, { stdio: 'inherit' }); } catch {}
  if (fs.existsSync(PLIST_PATH)) fs.unlinkSync(PLIST_PATH);
  console.log('uninstalled');
} else {
  console.error('usage: install-mcp-launchd.js <install|uninstall>');
  process.exit(1);
}
