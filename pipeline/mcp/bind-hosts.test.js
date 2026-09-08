import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bindHosts, TAILNET_ENV } from './bind-hosts.js';

const ip = () => '100.88.155.3';

test('loopback only by default — the tailnet bind is opt-in', () => {
  assert.deepEqual(bindHosts({ env: {}, resolveTailscaleIp: ip }), ['127.0.0.1']);
});

test('binds the tailnet address when explicitly opted in', () => {
  assert.deepEqual(
    bindHosts({ env: { [TAILNET_ENV]: '1' }, resolveTailscaleIp: ip }),
    ['127.0.0.1', '100.88.155.3'],
  );
});

test('any value other than "1" is not opting in', () => {
  for (const v of ['0', 'true', 'yes', '', 'TRUE']) {
    assert.deepEqual(
      bindHosts({ env: { [TAILNET_ENV]: v }, resolveTailscaleIp: ip }),
      ['127.0.0.1'],
      `value ${JSON.stringify(v)} must not opt in`,
    );
  }
});

test('opted in but tailscale is absent — starts loopback-only instead of failing', () => {
  assert.deepEqual(
    bindHosts({ env: { [TAILNET_ENV]: '1' }, resolveTailscaleIp: () => '' }),
    ['127.0.0.1'],
  );
});

test('opted in but resolving the IP throws — still starts', () => {
  assert.deepEqual(
    bindHosts({
      env: { [TAILNET_ENV]: '1' },
      resolveTailscaleIp: () => { throw new Error('tailscale not running'); },
    }),
    ['127.0.0.1'],
  );
});

test('never duplicates loopback if tailscale reports it', () => {
  assert.deepEqual(
    bindHosts({ env: { [TAILNET_ENV]: '1' }, resolveTailscaleIp: () => '127.0.0.1' }),
    ['127.0.0.1'],
  );
});
