#!/usr/bin/env node
// launchd installer for the nightly refresh. Third copy of the install
// pattern (crm, mcp) — if a fourth appears, extract the shared installer.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, '..');
const TMPL = path.join(__dirname, 'com.demouser.refresh.plist.tmpl');
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.demouser.refresh.plist');
const LOG_DIR = path.join(PROJECT_DIR, 'pipeline', 'output', 'logs');
const SERVER_PATH = path.join(PROJECT_DIR, 'pipeline', 'refresh.js');

const cmd = process.argv[2];
if (cmd === 'install') {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  let tmpl = fs.readFileSync(TMPL, 'utf8');
  tmpl = tmpl
    .replaceAll('{{NODE_PATH}}', process.execPath)
    .replaceAll('{{SERVER_PATH}}', SERVER_PATH)
    .replaceAll('{{PROJECT_DIR}}', PROJECT_DIR)
    .replaceAll('{{LOG_DIR}}', LOG_DIR);
  fs.writeFileSync(PLIST_PATH, tmpl);
  try { execSync(`launchctl bootout gui/${process.getuid()} ${PLIST_PATH}`, { stdio: 'ignore' }); } catch {}
  execSync(`launchctl bootstrap gui/${process.getuid()} ${PLIST_PATH}`, { stdio: 'inherit' });
  console.log(`installed: ${PLIST_PATH} (nightly 03:30)`);
} else if (cmd === 'uninstall') {
  try { execSync(`launchctl bootout gui/${process.getuid()} ${PLIST_PATH}`, { stdio: 'inherit' }); } catch {}
  if (fs.existsSync(PLIST_PATH)) fs.unlinkSync(PLIST_PATH);
  console.log('uninstalled');
} else {
  console.error('usage: install-refresh-launchd.js <install|uninstall>');
  process.exit(1);
}
