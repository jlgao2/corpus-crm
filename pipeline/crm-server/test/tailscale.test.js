import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTailscaleIp } from '../tailscale.js';

test('parses a plain IPv4 line', () => {
  assert.equal(parseTailscaleIp('100.88.155.3\n'), '100.88.155.3');
});

test('takes the first line of multi-line output', () => {
  assert.equal(parseTailscaleIp('100.88.155.3\nfd7a:115c::1\n'), '100.88.155.3');
});

test('rejects the logged-out error message (the homelab crash)', () => {
  assert.equal(parseTailscaleIp('no current Tailscale IPs; state: NeedsLogin'), null);
});

test('rejects empty and null output', () => {
  assert.equal(parseTailscaleIp(''), null);
  assert.equal(parseTailscaleIp(null), null);
});
