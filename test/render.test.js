import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fft } from '../src/renderer/vocal/dsp/fft.js';
import { analyzePitch } from '../src/renderer/vocal/dsp/pitch.js';
import { renderVoice } from '../src/renderer/vocal/dsp/render.js';
import { normalizeSettings } from '../src/renderer/vocal/settings.js';
import { hzToMidi, midiToHz } from '../src/renderer/vocal/theory.js';
import { medianF0, SR, voiceLike } from './helpers/signals.js';

const C_MAJOR = { key: 0, scale: 'major' };
const peak = (x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const finite = (x) => x.every(Number.isFinite);

test('FFT puis FFT inverse = identité', () => {
  const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i) + 0.3 * Math.cos(3 * i));
  const im = new Float64Array(64);
  const orig = Float64Array.from(re);
  fft(re, im);
  fft(re, im, true);
  assert.ok(re.every((v, i) => Math.abs(v - orig[i]) < 1e-9));
});

test('FFT : une sinusoïde tombe dans le bon bin', () => {
  const re = Float64Array.from({ length: 256 }, (_, i) => Math.cos((2 * Math.PI * 10 * i) / 256));
  const im = new Float64Array(256);
  fft(re, im);
  const mags = Array.from(re, (r, i) => Math.hypot(r, im[i]));
  assert.equal(mags.indexOf(Math.max(...mags.slice(0, 128))), 10);
});

// Voix « fausse » : un Mi tenu chanté 35 cents trop bas, avec vibrato.
const offPitch = voiceLike((t) => midiToHz(63.65 + 0.15 * Math.sin(2 * Math.PI * 5.5 * t)), 1.5);
const analysis = analyzePitch(offPitch, SR);

test('réglages neutres : la voix ressort intacte, au centre', () => {
  const { left, right } = renderVoice(offPitch, analysis, normalizeSettings({}), C_MAJOR);
  assert.ok(left.every((v, i) => v === offPitch[i] && right[i] === v));
});

test('correction instantanée : la voix est recalée sur Mi (64)', () => {
  const s = normalizeSettings({ pitch: { correct: true, speed: 0 } });
  const { left } = renderVoice(offPitch, analysis, s, C_MAJOR);
  const out = hzToMidi(medianF0(analyzePitch(left, SR), 0.1, 0.9));
  assert.ok(Math.abs(out - 64) < 0.08, `MIDI ${out}`);
});

test('transposition +12 : une octave au-dessus', () => {
  const s = normalizeSettings({ pitch: { shift: 12 } });
  const { left } = renderVoice(offPitch, analysis, s, C_MAJOR);
  const out = hzToMidi(medianF0(analyzePitch(left, SR), 0.1, 0.9));
  assert.ok(Math.abs(out - 75.65) < 0.2, `MIDI ${out}`);
});

test('harmonie panoramiquée : présente à droite seulement', () => {
  const s = normalizeSettings({
    voice: { level: -60 }, // voix principale coupée pour isoler l'harmonie
    pitch: { correct: true, speed: 0 },
    harmony: { enabled: true, voices: [{ interval: 2, level: 0, pan: 100 }] },
  });
  const { left, right } = renderVoice(offPitch, analysis, s, C_MAJOR);
  assert.ok(peak(left) < 1e-6, `gauche ${peak(left)}`);
  const out = hzToMidi(medianF0(analyzePitch(right, SR), 0.1, 0.9));
  // Tierce au-dessus de Mi en Do majeur = Sol (67).
  assert.ok(Math.abs(out - 67) < 0.1, `MIDI ${out}`);
});

test('vocodeur et bourdon : sortie finie, audible, sans saturation excessive', () => {
  const s = normalizeSettings({
    pitch: { correct: true, speed: 0 },
    vocoder: { enabled: true, mix: 100, chord: 'triad' },
    drone: { enabled: true, level: -12 },
  });
  const { left, right } = renderVoice(offPitch, analysis, s, C_MAJOR);
  assert.ok(finite(left) && finite(right));
  assert.ok(peak(left) > 0.05 && peak(left) < 2.5, `crête ${peak(left)}`);
  assert.notDeepEqual(left, right); // bourdon stéréo
});

test('vocodeur : la sortie suit l’enveloppe de la voix (silence -> silence)', async () => {
  const { vocode, synthCarrier } = await import('../src/renderer/vocal/dsp/vocoder.js');
  const voice = voiceLike(200, 1);
  voice.fill(0, SR / 2); // deuxième moitié muette
  const a = analyzePitch(voice, SR);
  const carrier = synthCarrier(
    voice.length,
    SR,
    a.hop,
    new Float32Array(a.f0.length).fill(57),
    new Float32Array(a.f0.length).fill(1),
    [0],
    0,
  );
  const out = vocode(voice, carrier, SR, 20);
  const energy = (from, to) => out.slice(from, to).reduce((s, v) => s + v * v, 0);
  const during = energy(0.1 * SR, 0.4 * SR);
  const after = energy(0.65 * SR, 0.95 * SR); // après le court relâchement du lissage
  assert.ok(during > 0.1, 'audible pendant la voix');
  assert.ok(after < during * 1e-6, `silencieux ensuite (${after} vs ${during})`);
});
