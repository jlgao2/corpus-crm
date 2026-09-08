import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSidecar } from './google-photos.js';

const WITH_GPS = JSON.stringify({
  title: 'IMG_1.HEIC',
  photoTakenTime: { timestamp: '1722801279', formatted: '4 Aug 2024, 19:54:39 UTC' },
  geoData: { latitude: -37.81, longitude: 144.96, altitude: 0.0 },
});
const NO_GPS = JSON.stringify({
  title: 'IMG_2.PNG',
  photoTakenTime: { timestamp: '1700000000', formatted: 'x' },
  geoData: { latitude: 0.0, longitude: 0.0, altitude: 0.0 },
});

test('parseSidecar resolves asset_path via the media index; id is basename-keyed', () => {
  // media lives in a DIFFERENT dir than the sidecar — index maps basename → real path
  const idx = new Map([['img_1.heic', '/OTHER/Takeout-7/Google Photos/album/IMG_1.HEIC']]);
  const r = parseSidecar(WITH_GPS, { sidecarPath: '/T/Google Photos/Photos from 2024/IMG_1.HEIC.supplemental-metadata.json', mediaIndex: idx });
  assert.equal(r.photo.source, 'gphotos');
  assert.equal(r.photo.id, 'gphotos:IMG_1.HEIC@1722801279');            // basename + photoTakenTime
  assert.equal(r.photo.asset_path, '/OTHER/Takeout-7/Google Photos/album/IMG_1.HEIC'); // resolved cross-root
  assert.equal(r.photo.ts, 1722801279 * 1000);
  assert.equal(r.photo.has_named_face, false);
  assert.deepEqual(r.faces, []);
  assert.deepEqual(r.place, { lat: -37.81, lng: 144.96 });
});

test('parseSidecar falls back to the sidecar-adjacent path when not indexed', () => {
  const r = parseSidecar(NO_GPS, { sidecarPath: '/T/Google Photos/x/IMG_2.PNG.supplemental-metadata.json', mediaIndex: new Map() });
  assert.equal(r.place, null);                                          // 0,0 geoData → no place
  assert.equal(r.photo.id, 'gphotos:IMG_2.PNG@1700000000');
  assert.equal(r.photo.asset_path, '/T/Google Photos/x/IMG_2.PNG');     // derived fallback
});

test('parseSidecar handles the (N) dedup-suffix sidecar variant', () => {
  const r = parseSidecar(WITH_GPS, { sidecarPath: '/T/IMG_1.HEIC.supplemental-metadata(1).json', mediaIndex: new Map() });
  assert.equal(r.photo.id, 'gphotos:IMG_1.HEIC@1722801279');
  assert.equal(r.photo.asset_path, '/T/IMG_1.HEIC');
});

test('parseSidecar returns null on invalid JSON or missing photoTakenTime', () => {
  assert.equal(parseSidecar('not json', { sidecarPath: '/T/a.json', mediaIndex: new Map() }), null);
  assert.equal(parseSidecar(JSON.stringify({ title: 'x' }), { sidecarPath: '/T/x.HEIC.supplemental-metadata.json', mediaIndex: new Map() }), null);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMediaIndex, loadGooglePhotos, findGooglePhotosRoots } from './google-photos.js';

test('buildMediaIndex maps lowercased media basenames across roots, skipping json', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gpidx-'));
  const r1 = path.join(base, 'Takeout-4', 'Google Photos', 'Photos from 2024');
  const r2 = path.join(base, 'Takeout-5', 'Google Photos', 'album');
  fs.mkdirSync(r1, { recursive: true }); fs.mkdirSync(r2, { recursive: true });
  fs.writeFileSync(path.join(r1, 'A.HEIC.supplemental-metadata.json'), '{}'); // sidecar, not media
  fs.writeFileSync(path.join(r2, 'A.HEIC'), 'bytes');                          // the real media, other root
  fs.writeFileSync(path.join(r2, 'B.JPG'), 'bytes');
  const idx = buildMediaIndex([path.join(base, 'Takeout-4', 'Google Photos'), path.join(base, 'Takeout-5', 'Google Photos')]);
  assert.equal(idx.get('a.heic'), path.join(r2, 'A.HEIC'));
  assert.equal(idx.get('b.jpg'), path.join(r2, 'B.JPG'));
  assert.equal(idx.has('a.heic.supplemental-metadata.json'), false); // json excluded
});

test('loadGooglePhotos resolves asset_path cross-root via the index and dedups by basename', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos-'));
  const scDir = path.join(base, 'Takeout-4', 'Google Photos', 'Photos from 2024');
  const mediaDir = path.join(base, 'Takeout-7', 'Google Photos', 'Photos from 2024');
  fs.mkdirSync(scDir, { recursive: true }); fs.mkdirSync(mediaDir, { recursive: true });
  // sidecar in Takeout-4; its media in Takeout-7 (the real-data pattern)
  fs.writeFileSync(path.join(scDir, 'A.HEIC.supplemental-metadata.json'),
    JSON.stringify({ photoTakenTime: { timestamp: '1722801279' }, geoData: { latitude: -37.8, longitude: 144.9 } }));
  fs.writeFileSync(path.join(mediaDir, 'A.HEIC'), 'bytes');
  // a no-GPS sidecar whose media is genuinely absent → metadata-only, fallback path
  fs.writeFileSync(path.join(scDir, 'B.PNG.supplemental-metadata.json'),
    JSON.stringify({ photoTakenTime: { timestamp: '1700000000' }, geoData: { latitude: 0, longitude: 0 } }));
  fs.writeFileSync(path.join(scDir, 'metadata.json'), '{}'); // album metadata → not a sidecar

  const roots = [path.join(base, 'Takeout-4', 'Google Photos'), path.join(base, 'Takeout-7', 'Google Photos')];
  const recs = loadGooglePhotos(roots);
  assert.equal(recs.length, 2);
  const a = recs.find(r => r.photo.id.startsWith('gphotos:A.HEIC@'));
  assert.equal(a.photo.asset_path, path.join(mediaDir, 'A.HEIC'));        // resolved cross-root
  assert.deepEqual(a.place, { lat: -37.8, lng: 144.9 });
  const b = recs.find(r => r.photo.id.startsWith('gphotos:B.PNG@'));
  assert.equal(b.place, null);
  assert.ok(b.photo.asset_path.endsWith('B.PNG'));                        // fallback (absent media)
});

test('loadGooglePhotos collapses a TRUE duplicate (same basename AND same timestamp)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gpdup-'));
  const d1 = path.join(base, 'Takeout-4', 'Google Photos'); const d2 = path.join(base, 'Takeout-5', 'Google Photos');
  fs.mkdirSync(d1, { recursive: true }); fs.mkdirSync(d2, { recursive: true });
  const sc = JSON.stringify({ photoTakenTime: { timestamp: '1722801279' }, geoData: { latitude: 1, longitude: 2 } });
  fs.writeFileSync(path.join(d1, 'DUP.JPG.supplemental-metadata.json'), sc);
  fs.writeFileSync(path.join(d2, 'DUP.JPG.supplemental-metadata.json'), sc); // same photo, second export
  fs.writeFileSync(path.join(d1, 'DUP.JPG'), 'bytes');
  const recs = loadGooglePhotos([d1, d2]);
  assert.equal(recs.length, 1);                                          // one record, not two
  assert.equal(recs[0].photo.id, 'gphotos:DUP.JPG@1722801279');
});

test('loadGooglePhotos KEEPS two different photos that share a basename (different timestamps)', () => {
  // The real-data bug: IMG_0001.HEIC from two phones/years are DIFFERENT photos.
  // basename@timestamp keying keeps both (basename-only silently dropped ~6,400 of these).
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gpcollide-'));
  const d1 = path.join(base, 'Takeout-4', 'Google Photos'); const d2 = path.join(base, 'Takeout-5', 'Google Photos');
  fs.mkdirSync(d1, { recursive: true }); fs.mkdirSync(d2, { recursive: true });
  fs.writeFileSync(path.join(d1, 'IMG_0001.HEIC.supplemental-metadata.json'),
    JSON.stringify({ photoTakenTime: { timestamp: '1400000000' }, geoData: { latitude: 1, longitude: 2 } }));
  fs.writeFileSync(path.join(d2, 'IMG_0001.HEIC.supplemental-metadata.json'),
    JSON.stringify({ photoTakenTime: { timestamp: '1700000000' }, geoData: { latitude: 3, longitude: 4 } }));
  const recs = loadGooglePhotos([d1, d2]);
  assert.equal(recs.length, 2);                                          // both kept (NOT merged)
  assert.deepEqual([...recs.map(r => r.photo.id)].sort(),
    ['gphotos:IMG_0001.HEIC@1400000000', 'gphotos:IMG_0001.HEIC@1700000000']);
});

test('findGooglePhotosRoots returns existing Takeout-*/Google Photos dirs', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gproots-'));
  fs.mkdirSync(path.join(base, 'Takeout-4', 'Google Photos'), { recursive: true });
  fs.mkdirSync(path.join(base, 'Takeout-5', 'Google Photos'), { recursive: true });
  fs.mkdirSync(path.join(base, 'Takeout-2', 'Mail'), { recursive: true }); // no Google Photos → excluded
  const roots = findGooglePhotosRoots(base);
  assert.equal(roots.length, 2);
  assert.ok(roots.every(r => r.endsWith('Google Photos')));
});

test('parseSidecar keeps coords where ONE axis is exactly 0 (equator/prime meridian)', () => {
  const equator = JSON.stringify({ photoTakenTime: { timestamp: '1700000000' }, geoData: { latitude: 0.0, longitude: -78.5 } });
  const r = parseSidecar(equator, { sidecarPath: '/T/Q.JPG.supplemental-metadata.json', mediaIndex: new Map() });
  assert.deepEqual(r.place, { lat: 0, lng: -78.5 });   // Quito — must NOT be dropped
  const greenwich = JSON.stringify({ photoTakenTime: { timestamp: '1700000000' }, geoData: { latitude: 51.48, longitude: 0.0 } });
  const r2 = parseSidecar(greenwich, { sidecarPath: '/T/G.JPG.supplemental-metadata.json', mediaIndex: new Map() });
  assert.deepEqual(r2.place, { lat: 51.48, lng: 0 });  // prime meridian — must NOT be dropped
});
