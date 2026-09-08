import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCorpusManifests } from './verify-corpus-gate.mjs';

function manifest(sources) {
  const normalized = sources.map(([source, messages, newest_message]) => ({
    source,
    messages: String(messages),
    newest_message,
  }));
  return {
    database: {
      messages: String(normalized.reduce((sum, source) => sum + Number(source.messages), 0)),
      sources: normalized,
    },
  };
}

const baseline = manifest([
  ['messenger', 100, '2026-05-01T00:00:00.000Z'],
  ['whatsapp', 10, '2026-07-01T00:00:00.000Z'],
]);

test('passes when every existing source is monotonic', () => {
  const candidate = manifest([
    ['messenger', 105, '2026-08-01T00:00:00.000Z'],
    ['whatsapp', 10, '2026-07-01T00:00:00.000Z'],
    ['new-source', 3, '2026-08-01T00:00:00.000Z'],
  ]);
  assert.equal(compareCorpusManifests(candidate, baseline).ok, true);
});

test('fails when a source count falls', () => {
  const candidate = manifest([
    ['messenger', 99, '2026-08-01T00:00:00.000Z'],
    ['whatsapp', 10, '2026-07-01T00:00:00.000Z'],
  ]);
  const result = compareCorpusManifests(candidate, baseline);
  assert.equal(result.ok, false);
  assert.ok(result.regressions.some((item) => item.includes('messenger: count down 1')));
});

test('fails when newest data moves backward despite a nondecreasing count', () => {
  const candidate = manifest([
    ['messenger', 100, '2026-04-01T00:00:00.000Z'],
    ['whatsapp', 10, '2026-07-01T00:00:00.000Z'],
  ]);
  const result = compareCorpusManifests(candidate, baseline);
  assert.equal(result.ok, false);
  assert.ok(result.regressions.some((item) => item.includes('newest message moved backward')));
});

test('fails when a baseline source disappears', () => {
  const candidate = manifest([
    ['messenger', 110, '2026-08-01T00:00:00.000Z'],
  ]);
  const result = compareCorpusManifests(candidate, baseline);
  assert.equal(result.ok, false);
  assert.ok(result.regressions.some((item) => item.includes('whatsapp: source missing')));
});
