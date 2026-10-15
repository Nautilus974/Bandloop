import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FX_CATALOG, FX_TYPES } from '../src/renderer/vocal/fx/catalog.js';
import {
  createModule,
  defaultSettings,
  isNeutral,
  normalizeSettings,
  normalizeTonality,
  pitchStageActive,
  pitchStageSignature,
  sameSettings,
} from '../src/renderer/vocal/settings.js';

test('réglages par défaut : neutres', () => {
  const s = defaultSettings();
  assert.ok(isNeutral(s));
  assert.equal(pitchStageSignature(s, { key: 0, scale: 'major' }), 'off');
});

test('normalizeSettings borne, arrondit et complète', () => {
  const s = normalizeSettings({ pitch: { correct: true, speed: 9999, strength: 'abc', shift: 3.4 } });
  assert.equal(s.pitch.correct, true);
  assert.equal(s.pitch.speed, 400);
  assert.equal(s.pitch.strength, 100);
  assert.equal(s.pitch.shift, 3);
  assert.equal(s.pitch.formant, 0);
  assert.ok(pitchStageActive(s));
});

test('chaîne : types inconnus ignorés, ordre et paramètres conservés', () => {
  const s = normalizeSettings({
    chain: [
      { type: 'reverb', params: { decay: 4 } },
      { type: 'inconnu' },
      { type: 'delay', enabled: false, params: { time: 5 } },
    ],
  });
  assert.deepEqual(
    s.chain.map((m) => m.type),
    ['reverb', 'delay'],
  );
  assert.equal(s.chain[0].params.decay, 4);
  assert.equal(s.chain[0].params.mix, 25); // défaut
  assert.equal(s.chain[1].params.time, 20); // borné
  assert.equal(s.chain[1].enabled, false);
  assert.ok(isNeutral(s) === false);
});

test('harmonies limitées à 4 voix, valeurs par défaut', () => {
  const s = normalizeSettings({ harmony: { enabled: true, voices: Array(6).fill({ interval: 4 }) } });
  assert.equal(s.harmony.voices.length, 4);
  assert.equal(s.harmony.voices[0].level, -6);
  assert.equal(s.harmony.mode, 'diatonic');
});

test('chaque type d’effet du catalogue a des paramètres valides', () => {
  for (const type of FX_TYPES) {
    const m = createModule(type);
    for (const p of FX_CATALOG[type].params) {
      assert.ok(p.key in m.params, `${type}.${p.key}`);
      if (p.type === 'number')
        assert.ok(p.default >= p.min && p.default <= p.max, `${type}.${p.key} défaut hors bornes`);
    }
    assert.ok(FX_CATALOG[type].bricks.length > 10, `${type} : briques documentées`);
  }
});

test('la signature change avec la tonalité seulement si l’étage de hauteur est actif', () => {
  const s = normalizeSettings({ pitch: { correct: true } });
  assert.notEqual(
    pitchStageSignature(s, { key: 0, scale: 'major' }),
    pitchStageSignature(s, { key: 2, scale: 'major' }),
  );
  const chainOnly = normalizeSettings({ chain: [{ type: 'reverb' }] });
  assert.equal(pitchStageSignature(chainOnly, { key: 0 }), pitchStageSignature(chainOnly, { key: 5 }));
});

test('sameSettings ignore les identifiants de modules', () => {
  const a = normalizeSettings({ chain: [{ type: 'reverb' }] });
  const b = normalizeSettings({ chain: [{ type: 'reverb' }] });
  assert.notEqual(a.chain[0].id, b.chain[0].id);
  assert.ok(sameSettings(a, b));
});

test('normalizeTonality', () => {
  assert.deepEqual(normalizeTonality({ key: 9, scale: 'minor' }), { key: 9, scale: 'minor' });
  assert.deepEqual(normalizeTonality({ key: 14, scale: 'x' }), { key: 0, scale: 'major' });
});

test('nouveaux réglages : vibrato et niveau des harmonies, avec valeurs par défaut pour les anciens projets', () => {
  const old = normalizeSettings({ pitch: { correct: true }, harmony: { enabled: true, voices: [{ interval: 2 }] } });
  assert.equal(old.pitch.keepVibrato, false);
  assert.equal(old.harmony.level, 0);
  const s = normalizeSettings({ pitch: { keepVibrato: true }, harmony: { level: -99 } });
  assert.equal(s.pitch.keepVibrato, true);
  assert.equal(s.harmony.level, -40);
});
