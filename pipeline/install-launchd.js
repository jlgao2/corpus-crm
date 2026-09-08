#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, '..');
const TMPL = path.join(__dirname, 'com.demouser.crm.plist.tmpl');
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.demouser.crm.plist');
const LOG_DIR = path.join(PROJECT_DIR, 'pipeline', 'output', 'logs');
const SERVER_PATH = path.join(PROJECT_DIR, 'pipeline', 'crm-server.js');

const cmd = process.argv[2];
if (cmd === 'install') {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  let tmpl = fs.readFileSync(TMPL, 'utf8');
  tmpl = tmpl
    .replaceAll('{{NODE_PATH}}', process.execPath)
    .replaceAll('{{SERVER_PATH}}', SERVER_PATH)
    .replaceAll('{{PROJECT_DIR}}', PROJECT_DIR)
    .replaceAll('{{LOG_DIR}}', LOG_DIR)
    .replaceAll('{{CRM_CERT}}', process.env.CRM_CERT || '')
    .replaceAll('{{CRM_KEY}}',  process.env.CRM_KEY  || '');
  fs.writeFileSync(PLIST_PATH, tmpl);
  try { execSync(`launchctl bootout gui/${process.getuid()} ${PLIST_PATH}`, { stdio:'ignore' }); } catch {}
  execSync(`launchctl bootstrap gui/${process.getuid()} ${PLIST_PATH}`, { stdio: 'inherit' });
  console.log(`installed: ${PLIST_PATH}`);
} else if (cmd === 'uninstall') {
  try { execSync(`launchctl bootout gui/${process.getuid()} ${PLIST_PATH}`, { stdio: 'inherit' }); } catch {}
  if (fs.existsSync(PLIST_PATH)) fs.unlinkSync(PLIST_PATH);
  console.log('uninstalled');
} else {
  console.error('usage: install-launchd.js <install|uninstall>');
  process.exit(1);
}
