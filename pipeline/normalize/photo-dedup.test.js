import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hashFile, mergeDuplicates, canonicalIdFor } from './photo-dedup.js';

test('hashFile returns deterministic SHA-256 hex', async () => {
  const tmp = path.join(os.tmpdir(), `dedup-test-${Date.now()}.bin`);
  fs.writeFileSync(tmp, Buffer.from('hello world'));
  try {
    const h1 = await hashFile(tmp);
    const h2 = await hashFile(tmp);
    assert.equal(h1, h2);
    assert.equal(h1, 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('canonicalIdFor prefers Apple UUID, falls back to hash', () => {
  assert.equal(
    canonicalIdFor({ apple_uuid: 'AAAA-BBBB', hash_sha256: 'deadbeef' }),
    'AAAA-BBBB',
  );
  assert.equal(
    canonicalIdFor({ apple_uuid: null, hash_sha256: 'deadbeef' }),
    'sha256:deadbeef',
  );
  assert.throws(
    () => canonicalIdFor({ apple_uuid: null, hash_sha256: null }),
    /requires apple_uuid or hash_sha256/,
  );
});

test('mergeDuplicates folds same-hash photos from different sources', () => {
  const photos = [
    { id: 'sha256:h1', hash_sha256: 'h1', source: 'imessage', source_ref: 'imsg:thread1', ts: 100 },
    { id: 'AAAA',      hash_sha256: 'h1', source: 'apple_photos', source_ref: null, ts: 100 },
    { id: 'sha256:h2', hash_sha256: 'h2', source: 'imessage', source_ref: 'imsg:thread2', ts: 200 },
  ];
  const merged = mergeDuplicates(photos);
  // Apple UUID wins as canonical
  assert.equal(merged.length, 2);
  const found = merged.find(m => m.id === 'AAAA');
  assert.ok(found, 'photo with apple uuid should be present');
  // Other source refs preserved as alt_refs
  assert.deepEqual(found.alt_refs.sort(), [{ source: 'imessage', source_ref: 'imsg:thread1' }].sort((a,b)=>a.source.localeCompare(b.source)));
});
