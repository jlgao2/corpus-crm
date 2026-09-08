#!/usr/bin/env node
// launchd installer for the Meta DYI jobs (HOMELAB): weekly request (Mon
// 04:00) + daily poll (04:30). Fourth+fifth copies of the install pattern —
// consolidation debt acknowledged; extract when it next itches.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, '..');
const LOG_DIR = path.join(PROJECT_DIR, 'pipeline', 'output', 'logs');
const SCRIPT = path.join(__dirname, 'meta-dyi.mjs');
const DATA_ROOT = path.resolve(process.env.META_DYI_DATA_ROOT
  || path.join(os.homedir(), 'Projects', 'Social Media Archive', '_repo-inputs', 'meta-dyi'));
if (DATA_ROOT === path.parse(DATA_ROOT).root) {
  throw new Error(`refusing unsafe META_DYI_DATA_ROOT: ${DATA_ROOT}`);
}
const INPUTS_DIR = path.join(DATA_ROOT, 'inputs');
const DROPS_DIR = path.join(DATA_ROOT, 'drops');
// process.execPath resolves to the versioned Cellar path, which dies on the
// next brew upgrade — prefer the stable symlink so launchd survives updates.
const NODE = fs.existsSync('/opt/homebrew/bin/node') ? '/opt/homebrew/bin/node' : process.execPath;

const JOBS = [
  { label: 'com.demouser.meta-request', arg: 'request', cal: '<key>Weekday</key><integer>1</integer><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer>' },
  { label: 'com.demouser.meta-poll', arg: 'poll', cal: '<key>Hour</key><integer>4</integer><key>Minute</key><integer>30</integer>' },
];

const plist = (j) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${j.label}</string>
  <key>ProgramArguments</key>
  <array><string>${NODE}</string><string>${SCRIPT}</string><string>${j.arg}</string></array>
  <key>WorkingDirectory</key><string>${PROJECT_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>META_DYI_INPUTS_DIR</key><string>${INPUTS_DIR}</string>
    <key>META_DYI_DROPS_DIR</key><string>${DROPS_DIR}</string>
  </dict>
  <key>StandardOutPath</key><string>${LOG_DIR}/${j.label}.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/${j.label}.log</string>
  <key>StartCalendarInterval</key><dict>${j.cal}</dict>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
`;

const cmd = process.argv[2];
for (const j of JOBS) {
  const p = path.join(os.homedir(), 'Library', 'LaunchAgents', `${j.label}.plist`);
  if (cmd === 'install') {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.mkdirSync(INPUTS_DIR, { recursive: true });
    fs.mkdirSync(DROPS_DIR, { recursive: true });
    fs.writeFileSync(p, plist(j));
    try { execSync(`launchctl bootout gui/${process.getuid()} ${p}`, { stdio: 'ignore' }); } catch {}
    execSync(`launchctl bootstrap gui/${process.getuid()} ${p}`, { stdio: 'inherit' });
    console.log(`installed: ${j.label} (durable data: ${DATA_ROOT})`);
  } else if (cmd === 'uninstall') {
    try { execSync(`launchctl bootout gui/${process.getuid()} ${p}`, { stdio: 'inherit' }); } catch {}
    if (fs.existsSync(p)) fs.unlinkSync(p);
    console.log(`uninstalled: ${j.label}`);
  } else {
    console.error('usage: install-meta-launchd.js <install|uninstall>');
    process.exit(1);
  }
}
