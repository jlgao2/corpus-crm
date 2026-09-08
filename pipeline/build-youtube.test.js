import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTopics, summarizeYoutube } from './build-youtube.js';

test('deriveTopics derives multi-facet interests (category/topic/channel/artist)', () => {
  const videos = [{ category: 'Comedy' }, { category: 'Comedy' }, { category: 'Music' }, { category: null }];
  const watch = Array.from({ length: 6 }, (_, i) => ({ title: `cooking recipe ${i}`, channel_name: 'Food Channel' }));
  const songs = [{ artists: ['alt-J'] }, { artists: ['alt-J', 'SBTRKT'] }];
  const topics = deriveTopics({ videos, watch, songs });
  const byKind = k => topics.filter(t => t.kind === k);

  const cat = byKind('category').find(t => t.topic === 'comedy');
  assert.ok(cat && cat.count === 2, 'category comedy counted');
  assert.ok(byKind('topic').some(t => t.topic === 'cooking'), 'keyword topic from watch titles (>= min 5)');
  assert.ok(byKind('channel').some(t => t.topic === 'Food Channel'), 'most-watched channel (>= min 3)');
  assert.ok(byKind('artist').some(t => t.topic === 'alt-J'), 'top music artist (>= min 2)');
  assert.ok(topics.every(t => typeof t.kind === 'string' && typeof t.count === 'number' && typeof t.weight === 'number'), 'shape');
});

test('deriveTopics is empty-safe', () => {
  assert.deepEqual(deriveTopics({}), []);
  assert.deepEqual(deriveTopics(), []);
});

test('summarizeYoutube splits top_topics / channels / artists by kind', () => {
  const topics = [
    { kind: 'category', topic: 'comedy', count: 2, weight: 1 },
    { kind: 'topic', topic: 'cooking', count: 6, weight: 0.5 },
    { kind: 'channel', topic: 'Food Channel', count: 6, weight: 1 },
    { kind: 'artist', topic: 'alt-J', count: 2, weight: 1 },
  ];
  const s = summarizeYoutube({
    channels: [{ is_self: true }], subscriptions: [{}, {}], videos: [{}],
    songs: [{}, {}, {}], playlists: [{}], comments: [{}],
    watch: [{}, {}], search: [{}], topics,
  });
  assert.equal(s.subscriptions, 2);
  assert.equal(s.watch_entries, 2);
  assert.ok(s.top_topics.some(t => t.topic === 'cooking') && s.top_topics.some(t => t.topic === 'comedy'), 'topic+category in top_topics');
  assert.ok(s.top_channels.some(t => t.topic === 'Food Channel'), 'channel facet');
  assert.ok(s.top_artists.some(t => t.topic === 'alt-J'), 'artist facet');
  assert.ok(!s.top_topics.some(t => t.kind === 'channel'), 'channels not mixed into top_topics');
});
