import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { clusterEvents, haversineKm } from './events.js';

const ms = (iso) => new Date(iso).getTime();

test('haversineKm computes distance correctly', () => {
  // Sydney to Melbourne ≈ 714km
  const d = haversineKm({ lat: -33.8688, lng: 151.2093 }, { lat: -37.8136, lng: 144.9631 });
  assert.ok(d > 700 && d < 730, `expected ~714km, got ${d}`);
  // Same point = 0
  assert.equal(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 0 }), 0);
});

test('clusterEvents groups photos within time window', () => {
  const photos = [
    { id: 'a', ts: ms('2024-06-01T10:00:00Z'), lat: 40.7, lng: -74.0 },
    { id: 'b', ts: ms('2024-06-01T11:00:00Z'), lat: 40.7, lng: -74.0 },
    { id: 'c', ts: ms('2024-06-01T12:00:00Z'), lat: 40.7, lng: -74.0 },
    { id: 'd', ts: ms('2024-06-15T10:00:00Z'), lat: 40.7, lng: -74.0 },
    { id: 'e', ts: ms('2024-06-15T11:00:00Z'), lat: 40.7, lng: -74.0 },
    { id: 'f', ts: ms('2024-06-15T12:00:00Z'), lat: 40.7, lng: -74.0 },
  ];
  const events = clusterEvents(photos, { timeGapHours: 6, locationKm: 1, minPhotos: 3 });
  assert.equal(events.length, 2);
  assert.equal(events[0].photos.length, 3);
  assert.equal(events[1].photos.length, 3);
});

test('clusterEvents splits clusters when location jumps', () => {
  const photos = [
    { id: 'a', ts: ms('2024-06-01T10:00:00Z'), lat: 40.7, lng: -74.0 }, // NYC
    { id: 'b', ts: ms('2024-06-01T11:30:00Z'), lat: 40.7, lng: -74.0 }, // NYC
    { id: 'c', ts: ms('2024-06-01T13:00:00Z'), lat: 40.7, lng: -74.0 }, // NYC
    { id: 'd', ts: ms('2024-06-01T14:30:00Z'), lat: 51.5, lng: -0.1 },  // London
    { id: 'e', ts: ms('2024-06-01T16:00:00Z'), lat: 51.5, lng: -0.1 },  // London
    { id: 'f', ts: ms('2024-06-01T17:30:00Z'), lat: 51.5, lng: -0.1 },  // London
  ];
  const events = clusterEvents(photos, { timeGapHours: 6, locationKm: 1, minPhotos: 3 });
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].photos.map(p => p.id), ['a', 'b', 'c']);
  assert.deepEqual(events[1].photos.map(p => p.id), ['d', 'e', 'f']);
});

test('clusterEvents drops clusters under minPhotos', () => {
  const photos = [
    { id: 'a', ts: ms('2024-06-01T10:00:00Z'), lat: 40.7, lng: -74.0 },
    { id: 'b', ts: ms('2024-06-15T10:00:00Z'), lat: 40.7, lng: -74.0 },
    { id: 'c', ts: ms('2024-06-15T11:00:00Z'), lat: 40.7, lng: -74.0 },
    { id: 'd', ts: ms('2024-06-15T12:00:00Z'), lat: 40.7, lng: -74.0 },
  ];
  const events = clusterEvents(photos, { timeGapHours: 6, locationKm: 1, minPhotos: 3 });
  assert.equal(events.length, 1);
  assert.equal(events[0].photos.length, 3);
});

test('clusterEvents handles photos with no GPS gracefully', () => {
  const photos = [
    { id: 'a', ts: ms('2024-06-01T10:00:00Z'), lat: null, lng: null },
    { id: 'b', ts: ms('2024-06-01T11:00:00Z'), lat: null, lng: null },
    { id: 'c', ts: ms('2024-06-01T12:00:00Z'), lat: null, lng: null },
  ];
  const events = clusterEvents(photos, { timeGapHours: 6, locationKm: 1, minPhotos: 3 });
  assert.equal(events.length, 1);
  assert.equal(events[0].photos.length, 3);
});
