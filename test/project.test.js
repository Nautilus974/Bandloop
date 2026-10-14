import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  audioExtension,
  buildManifest,
  packProject,
  parseManifest,
  ProjectError,
  slugify,
  unpackProject,
} from '../src/renderer/project/format.js';
import { createZip } from '../src/renderer/project/zip.js';
import { normalizeSettings } from '../src/renderer/vocal/settings.js';

const settings = normalizeSettings({
  pitch: { correct: true, speed: 20 },
  chain: [{ type: 'reverb', params: { decay: 3 } }],
});
const state = {
  name: 'Mon morceau',
  tempo: 92,
  zoom: 120,
  playhead: 4.5,
  tonality: { key: 9, scale: 'minor' },
  tracks: [
    {
      name: 'voix.wav',
      color: '#ff7a59',
      startTime: 1.25,
      volumeDb: -3.5,
      pan: -0.4,
      muted: false,
      solo: true,
      audio: { path: 'audio/01-voix.wav', origin: 'file', codec: 'wav', originalName: 'voix.wav', frames: 1000 },
      vocal: { presetId: 'studio', presetName: 'Studio', bypass: false, settings },
    },
    {
      name: 'Prise 1',
      color: '#2fd4b5',
      startTime: 0,
      volumeDb: 0,
      pan: 0.5,
      muted: true,
      solo: false,
      audio: { path: 'audio/02-prise-1.flac', origin: 'take', codec: 'flac', originalName: 'Prise 1', frames: 2000 },
      vocal: { presetId: null, presetName: null, bypass: true, settings: normalizeSettings({}) },
    },
  ],
};
const audio = new Map([
  ['audio/01-voix.wav', Uint8Array.from([1, 2, 3])],
  ['audio/02-prise-1.flac', Uint8Array.from([4, 5, 6, 7])],
]);

test('aller-retour complet : manifeste et audio identiques', () => {
  const bytes = packProject(buildManifest(state), audio);
  const { project, audio: files } = unpackProject(bytes);
  assert.equal(project.name, 'Mon morceau');
  assert.equal(project.tempo, 92);
  assert.equal(project.zoom, 120);
  assert.equal(project.playhead, 4.5);
  assert.deepEqual(project.tonality, { key: 9, scale: 'minor' });
  for (const [i, t] of state.tracks.entries()) {
    const r = project.tracks[i];
    for (const k of ['name', 'color', 'startTime', 'volumeDb', 'pan', 'muted', 'solo']) assert.equal(r[k], t[k], k);
    assert.equal(r.audio.path, t.audio.path);
    assert.equal(r.audio.origin, t.audio.origin);
    assert.deepEqual(r.vocal, { ...t.vocal, settings: t.vocal.settings });
  }
  assert.deepEqual(files.get('audio/02-prise-1.flac'), Uint8Array.from([4, 5, 6, 7]));
});

test('fichier qui n’est pas un projet', () => {
  assert.throws(
    () => unpackProject(new TextEncoder().encode('bonjour')),
    (e) => e instanceof ProjectError && e.code === 'corrupt',
  );
  const notProject = createZip([{ name: 'readme.txt', data: new Uint8Array(3) }]);
  assert.throws(
    () => unpackProject(notProject),
    (e) => e.code === 'not-project',
  );
  const wrongFormat = createZip([{ name: 'project.json', data: new TextEncoder().encode('{"format":"autre"}') }]);
  assert.throws(
    () => unpackProject(wrongFormat),
    (e) => e.code === 'not-project',
  );
});

test('projet tronqué ou JSON corrompu', () => {
  const bytes = packProject(buildManifest(state), audio);
  assert.throws(
    () => unpackProject(bytes.subarray(0, bytes.length - 30)),
    (e) => e.code === 'corrupt',
  );
  const badJson = createZip([
    { name: 'project.json', data: new TextEncoder().encode('{"format": "bandloop-project", ') },
  ]);
  assert.throws(() => unpackProject(badJson), /project.json illisible/);
});

test('audio manquant dans l’archive', () => {
  const bytes = packProject(buildManifest(state), new Map([['audio/01-voix.wav', new Uint8Array(1)]]));
  assert.throws(
    () => unpackProject(bytes),
    (e) => e.code === 'missing-audio' && /Prise 1/.test(e.message),
  );
});

test('version plus récente refusée avec un message clair', () => {
  assert.throws(
    () => parseManifest({ format: 'bandloop-project', version: 99, tracks: [] }),
    (e) => e.code === 'too-new' && /plus récente/.test(e.message),
  );
});

test('valeurs aberrantes bornées, réglages vocaux re-validés', () => {
  const p = parseManifest({
    format: 'bandloop-project',
    version: 1,
    tempo: 9999,
    zoom: -5,
    tonality: { key: 40 },
    tracks: [
      {
        name: '',
        color: 'red',
        volumeDb: 80,
        pan: 7,
        audio: { path: 'audio/x.wav' },
        vocal: { settings: { pitch: { speed: 1e9 } } },
      },
    ],
  });
  assert.equal(p.tempo, 300);
  assert.equal(p.zoom, 10);
  assert.deepEqual(p.tonality, { key: 0, scale: 'major' });
  const t = p.tracks[0];
  assert.equal(t.name, 'Piste 1');
  assert.equal(t.color, null);
  assert.equal(t.volumeDb, 6);
  assert.equal(t.pan, 1);
  assert.equal(t.vocal.settings.pitch.speed, 400);
});

test('slugify et extension', () => {
  assert.equal(slugify('Prise é 1.wav'), 'prise-e-1');
  assert.equal(slugify('***'), 'piste');
  assert.equal(audioExtension('Mon Son.MP3'), 'mp3');
  assert.equal(audioExtension('sans-extension'), 'bin');
});
