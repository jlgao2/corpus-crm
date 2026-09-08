import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from './build-email-summary.js';

test('summarize aggregates totals, categories, and top correspondents', () => {
  const correspondents = [
    { addr: 'a@x.com', display_name: 'A', domain: 'x.com', kind: 'bulk', n_messages: 10, list_unsubscribe: true },
    { addr: 'b@y.com', display_name: 'B', domain: 'y.com', kind: 'automated', n_messages: 3, list_unsubscribe: false },
    { addr: 'c@x.com', display_name: 'C', domain: 'x.com', kind: 'bulk', n_messages: 7, list_unsubscribe: true },
  ];
  const categoryRows = [
    { category: 'promotions', n: 12 },
    { category: 'updates', n: 8 },
    { category: null, n: 5 },
  ];
  const s = summarize(correspondents, categoryRows, 2);
  assert.equal(s.total_correspondents, 3);
  assert.equal(s.total_bulk_messages, 20);   // 10+3+7
  assert.deepEqual(s.by_category, { promotions: 12, updates: 8, uncategorized: 5 });
  // top domains by message volume
  assert.deepEqual(s.top_domains, [{ domain: 'x.com', n_messages: 17 }, { domain: 'y.com', n_messages: 3 }]);
  // top correspondents capped at limit (2), sorted by n_messages desc
  assert.equal(s.top_correspondents.length, 2);
  assert.equal(s.top_correspondents[0].addr, 'a@x.com');
  assert.equal(s.top_correspondents[1].addr, 'c@x.com');
});
