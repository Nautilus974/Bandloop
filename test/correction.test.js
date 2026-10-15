import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHarmonyRatio, buildLeadCurve, voicingEnvelope } from '../src/renderer/vocal/dsp/correction.js';
import { midiToHz } from '../src/renderer/vocal/theory.js';

const SR = 44100;
const HOP = 256;
/** Analyse fictive : une liste de hauteurs MIDI (null = non voisé). */
const fakeAnalysis = (midis) => ({
  sampleRate: SR,
  hop: HOP,
  f0: Float32Array.from(midis, (m) => (m == null ? 0 : midiToHz(m))),
});
const C_MAJOR = { key: 0, scale: 'major' };
const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

test('vitesse 0 + intensité 100 % : calage exact sur la note (robot)', () => {
  const a = fakeAnalysis(Array(50).fill(60.3));
  const c = buildLeadCurve(a, { correct: true, ...C_MAJOR, speed: 0, strength: 1, shift: 0 });
  assert.ok(c.outMidi.every((m) => near(m, 60)));
  assert.ok(near(c.leadRatio[10], Math.pow(2, -0.3 / 12)));
});

test('vitesse lente : la correction arrive progressivement', () => {
  const a = fakeAnalysis(Array(200).fill(60.4));
  const c = buildLeadCurve(a, { correct: true, ...C_MAJOR, speed: 100, strength: 1, shift: 0 });
  assert.ok(c.outMidi[0] > 60.3, `début peu corrigé : ${c.outMidi[0]}`);
  assert.ok(near(c.outMidi[199], 60, 0.01), `fin calée : ${c.outMidi[199]}`);
  // Après une constante de temps (~17 trames de 5,8 ms), ~63 % de la correction.
  const i = Math.round(0.1 / (HOP / SR));
  assert.ok(Math.abs(c.outMidi[i] - (60.4 - 0.4 * 0.63)) < 0.03, `${c.outMidi[i]}`);
});

test('intensité 50 % : moitié de la correction', () => {
  const c = buildLeadCurve(fakeAnalysis(Array(20).fill(60.4)), {
    correct: true,
    ...C_MAJOR,
    speed: 0,
    strength: 0.5,
    shift: 0,
  });
  assert.ok(near(c.outMidi[5], 60.2));
});

test('correction désactivée : seule la transposition s’applique, partout', () => {
  const c = buildLeadCurve(fakeAnalysis([60.4, null, 62.1]), {
    correct: false,
    ...C_MAJOR,
    speed: 0,
    strength: 1,
    shift: 12,
  });
  assert.ok(near(c.outMidi[0], 72.4));
  assert.ok(Number.isNaN(c.outMidi[1]));
  assert.ok(near(c.leadRatio[1], 2)); // non voisé : transposé aussi
});

test('la note cible suit la gamme et résiste aux oscillations (hystérésis)', () => {
  // Mi♭ en Do majeur : n'existe pas, doit aller vers Ré ou Mi selon le côté.
  const c = buildLeadCurve(fakeAnalysis([63.2, 63.0, 62.95, 63.05]), {
    correct: true,
    ...C_MAJOR,
    speed: 0,
    strength: 1,
    shift: 0,
  });
  assert.equal(c.noteMidi[0], 64);
  // Juste sous le milieu (62.95) : on reste sur Mi grâce à l'hystérésis.
  assert.equal(c.noteMidi[2], 64);
});

test('harmonie diatonique à la tierce : majeure sur Do, mineure sur Ré', () => {
  const a = fakeAnalysis([60, 62]);
  const lead = buildLeadCurve(a, { correct: true, ...C_MAJOR, speed: 0, strength: 1, shift: 0 });
  const r = buildHarmonyRatio(lead, { interval: 2, mode: 'diatonic' }, C_MAJOR);
  assert.ok(near(r[0], Math.pow(2, 4 / 12)));
  assert.ok(near(r[1], Math.pow(2, 3 / 12)));
});

test('harmonie chromatique + désaccord en cents', () => {
  const lead = buildLeadCurve(fakeAnalysis([60, null]), {
    correct: false,
    ...C_MAJOR,
    speed: 0,
    strength: 1,
    shift: 0,
  });
  const r = buildHarmonyRatio(lead, { interval: 7, detune: 10, mode: 'chromatic' }, C_MAJOR);
  assert.ok(near(r[0], Math.pow(2, 7.1 / 12)));
  assert.equal(r[1], 1);
});

test('enveloppe de voisement : monte sur le voisé, retombe sur le silence', () => {
  const env = voicingEnvelope(fakeAnalysis([...Array(40).fill(60), ...Array(80).fill(null)]));
  assert.equal(env[0] > 0, true);
  assert.ok(env[39] > 0.95);
  assert.ok(env[119] < 0.05);
});

test('préserver le vibrato : la note est recentrée mais l’oscillation reste', () => {
  // Note tenue 30 cents trop haut avec un vibrato de ±40 cents à 5,5 Hz.
  const hopSec = HOP / SR;
  const midis = Array.from({ length: 600 }, (_, i) => 60.3 + 0.4 * Math.sin(2 * Math.PI * 5.5 * i * hopSec));
  const opts = { correct: true, ...C_MAJOR, speed: 0, strength: 1, shift: 0 };
  const flat = buildLeadCurve(fakeAnalysis(midis), opts);
  const kept = buildLeadCurve(fakeAnalysis(midis), { ...opts, keepVibrato: true });
  const tail = (c) => Array.from(c.outMidi.subarray(300));
  const range = (xs) => Math.max(...xs) - Math.min(...xs);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(range(tail(flat)) < 0.01, 'sans l’option, robot : vibrato effacé');
  assert.ok(range(tail(kept)) > 0.6, `avec l’option, vibrato conservé (${range(tail(kept))})`);
  assert.ok(Math.abs(mean(tail(kept)) - 60) < 0.05, `centre ramené sur Do (${mean(tail(kept))})`);
});

test('intensité 0 % : voix brute, quelle que soit la vitesse', () => {
  const c = buildLeadCurve(fakeAnalysis([60.4, 61.7, 63.2]), {
    correct: true,
    ...C_MAJOR,
    speed: 0,
    strength: 0,
    shift: 0,
  });
  assert.ok(c.outMidi.every((m, i) => near(m, c.inMidi[i])));
  assert.ok(c.leadRatio.every((r) => near(r, 1)));
});
