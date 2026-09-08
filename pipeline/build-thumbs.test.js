import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { thumbPathFor, planMissing } from './build-thumbs.js';

test('thumbPathFor matches serve.js cache naming (sha1 of the absolute path)', () => {
  const p = thumbPathFor('/a/b/IMG_1.JPG', '/cache');
  assert.match(p, /^\/cache\/[0-9a-f]{40}\.jpg$/);
  assert.equal(p, thumbPathFor('/a/b/IMG_1.JPG', '/cache'), 'deterministic');
  assert.notEqual(p, thumbPathFor('/a/b/IMG_2.JPG', '/cache'));
});

test('planMissing skips already-generated thumbs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbs-'));
  const a = '/x/a.jpg', b = '/x/b.jpg';
  fs.writeFileSync(thumbPathFor(a, dir), 'done');
  const plan = planMissing([a, b], dir);
  assert.deepEqual(plan.map(t => t.asset), [b]);
  assert.equal(plan[0].out, thumbPathFor(b, dir));
});
