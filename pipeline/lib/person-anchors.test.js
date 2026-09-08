import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnchor, resolveAnchor } from './person-anchors.js';

const IDENTITIES = [
  { canonical_id: 'id-753', display_name: 'Demo User', aliases: ['Demo User', '+155501001'] },
  { canonical_id: 'id-1242', display_name: 'Maya Torres', aliases: ['Maya', 'Maya 🌱', '+155501002'] },
  { canonical_id: 'id-2784', display_name: 'Priya Sharma', aliases: ['Priya Sharma', 'terri', '+155501003'] },
  { canonical_id: 'id-60', display_name: 'Angie', aliases: ['Angie'] },
  { canonical_id: 'id-61', display_name: 'angie', aliases: ['angie'] },
];

test('buildAnchor separates names from handles', () => {
  const a = buildAnchor(IDENTITIES[1]);
  assert.deepEqual(a.names, ['Maya Torres', 'Maya', 'Maya 🌱']);
  assert.deepEqual(a.handles, ['+155501002']);
});

test('buildAnchor treats emails as handles', () => {
  const a = buildAnchor({ canonical_id: 'x', display_name: 'JB', aliases: ['JB', 'jordan.blake@example.com'] });
  assert.deepEqual(a.handles, ['jordan.blake@example.com']);
});

test('resolveAnchor matches by unique display_name first', () => {
  assert.equal(resolveAnchor({ names: ['Maya Torres'], handles: [] }, IDENTITIES), 'id-1242');
});

test('resolveAnchor falls back to a unique alias name', () => {
  assert.equal(resolveAnchor({ names: ['terri'], handles: [] }, IDENTITIES), 'id-2784');
});

test('resolveAnchor falls back to a unique handle', () => {
  assert.equal(resolveAnchor({ names: ['Someone Renamed'], handles: ['+155501001'] }, IDENTITIES), 'id-753');
});

test('resolveAnchor returns null on ambiguity instead of guessing', () => {
  // 'angie' matches two identities case-insensitively
  assert.equal(resolveAnchor({ names: ['angie'], handles: [] }, IDENTITIES), null);
});

test('resolveAnchor returns null when nothing matches', () => {
  assert.equal(resolveAnchor({ names: ['Nobody'], handles: ['+155501004'] }, IDENTITIES), null);
});
