import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanActive, cleanSignature, normalizeClean } from '../src/renderer/vocal/clean.js';
import { cleanVoice, estimateNoise, highpassZeroPhase, noiseGate } from '../src/renderer/vocal/dsp/denoise.js';
import { SR, sine, voiceLike } from './helpers/signals.js';

const rmsDb = (x, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / Math.max(1, to - from) + 1e-20);
};
const sec = (t) => Math.round(t * SR);
/** Bruit blanc déterministe. */
function noise(n, amp, seed = 1) {
  const out = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 16807) % 2147483647;
    out[i] = amp * (s / 1073741823.5 - 1);
  }
  return out;
}
/** Prise type : 0,5 s de silence, 1 s de voix, 0,5 s de silence, 1 s de voix, 0,5 s de silence. */
function take(noiseSignal) {
  const v = voiceLike(220, 1);
  const x = Float32Array.from(noiseSignal);
  for (const at of [0.5, 2]) for (let i = 0; i < v.length; i++) x[sec(at) + i] += v[i];
  return {
    x,
    voice: (() => {
      const c = new Float32Array(x.length);
      for (const at of [0.5, 2]) c.set(v, sec(at));
      return c;
    })(),
  };
}
const clean = (over) => normalizeClean({ enabled: true, highpass: { enabled: false }, ...over });

test('réglages : valeurs par défaut, bornes, empreinte manuelle', () => {
  const d = normalizeClean({});
  assert.equal(d.enabled, false);
  assert.equal(cleanActive(d), false);
  assert.equal(cleanSignature(d), 'off');
  const c = normalizeClean({
    enabled: true,
    highpass: { freq: 5 },
    gate: { threshold: 0 },
    noise: { profile: { start: 1, end: 1.05 } },
  });
  assert.equal(c.highpass.freq, 20);
  assert.equal(c.gate.threshold, -20);
  assert.equal(c.noise.profile, null, 'zone trop courte ignorée');
  assert.deepEqual(normalizeClean({ noise: { profile: { start: 0.2, end: 0.9 } } }).noise.profile, {
    start: 0.2,
    end: 0.9,
  });
  assert.equal(cleanActive(normalizeClean({ enabled: true })), true, 'bruit + passe-haut par défaut');
});

test('passe-haut à phase nulle : ronflement 50 Hz enlevé, voix intacte et non décalée', () => {
  const hum = sine(50, 1, SR, 0.3);
  assert.ok(rmsDb(highpassZeroPhase(hum, SR, 120), sec(0.2), sec(0.8)) - rmsDb(hum) < -20);
  const tone = sine(1000, 1, SR, 0.3);
  const out = highpassZeroPhase(tone, SR, 120);
  assert.ok(Math.abs(rmsDb(out, sec(0.2), sec(0.8)) - rmsDb(tone, sec(0.2), sec(0.8))) < 0.1);
  // Phase nulle : mêmes échantillons au milieu, pas de décalage.
  let err = 0;
  for (let i = sec(0.3); i < sec(0.7); i++) err = Math.max(err, Math.abs(out[i] - tone[i]));
  assert.ok(err < 0.005, `écart ${err}`);
});

test('bruit de fond (souffle) : −10 dB au moins dans les silences, voix préservée', () => {
  const { x, voice } = take(noise(sec(3), 0.01)); // souffle ≈ −45 dBFS
  const { signal, info } = cleanVoice(x, SR, clean({ noise: { amount: 50 } }));
  assert.equal(info.source, 'auto');
  assert.ok(info.seconds > 0.5, `silences trouvés : ${info.seconds} s`);
  assert.equal(info.uncertain, false);
  assert.ok(Math.abs(info.noiseDb - rmsDb(noise(sec(3), 0.01))) < 2, `bruit estimé ${info.noiseDb}`);
  assert.ok(info.residualDb < info.noiseDb - 8, `bruit restant ${info.residualDb} (avant ${info.noiseDb})`);
  const before = rmsDb(x, sec(1.6), sec(1.9));
  const after = rmsDb(signal, sec(1.6), sec(1.9));
  assert.ok(after - before < -10, `silence : ${before.toFixed(1)} → ${after.toFixed(1)} dB`);
  const vb = rmsDb(voice, sec(0.7), sec(1.3));
  const va = rmsDb(signal, sec(0.7), sec(1.3));
  assert.ok(Math.abs(va - vb) < 1, `voix : ${vb.toFixed(1)} → ${va.toFixed(1)} dB`);
  assert.equal(signal.length, x.length);
  assert.ok(signal.every(Number.isFinite));
});

test('intensité : « fort » enlève plus que « léger »', () => {
  const { x } = take(noise(sec(3), 0.01));
  const at = (amount) => rmsDb(cleanVoice(x, SR, clean({ noise: { amount } })).signal, sec(1.6), sec(1.9));
  assert.ok(at(100) < at(20) - 6, `${at(20).toFixed(1)} / ${at(100).toFixed(1)}`);
});

test('ronflement stationnaire (50 Hz + harmoniques) : fortement réduit dans les silences', () => {
  const n = sec(3);
  const hum = new Float32Array(n);
  for (let i = 0; i < n; i++)
    hum[i] =
      0.01 *
      (Math.sin((2 * Math.PI * 50 * i) / SR) +
        0.6 * Math.sin((2 * Math.PI * 150 * i) / SR) +
        0.4 * Math.sin((2 * Math.PI * 250 * i) / SR));
  const { x } = take(hum);
  const { signal } = cleanVoice(
    x,
    SR,
    normalizeClean({ enabled: true, noise: { amount: 60 }, highpass: { freq: 80 } }),
  );
  const gain = rmsDb(signal, sec(1.6), sec(1.9)) - rmsDb(x, sec(1.6), sec(1.9));
  assert.ok(gain < -15, `ronflement : ${gain.toFixed(1)} dB`);
});

test('empreinte manuelle : marche sur une prise sans vrai silence, l’auto signale son incertitude', () => {
  // Voix continue sur 3 s avec souffle ; seulement 0,2 s de bruit seul au début.
  const n = sec(3);
  const x = noise(n, 0.01, 7);
  const v = voiceLike(200, 2.8);
  for (let i = 0; i < v.length; i++) x[sec(0.2) + i] += v[i];
  assert.equal(estimateNoise(x, SR).uncertain, true, 'auto : pas assez de silence');
  const manual = cleanVoice(x, SR, clean({ noise: { amount: 60, profile: { start: 0, end: 0.18 } } }));
  assert.equal(manual.info.source, 'manual');
  assert.ok(Math.abs(manual.info.noiseDb - rmsDb(x, 0, sec(0.15))) < 3, `${manual.info.noiseDb}`);
  assert.ok(rmsDb(manual.signal, sec(0.03), sec(0.15)) - rmsDb(x, sec(0.03), sec(0.15)) < -10);
});

test('noise gate : silences coupés, voix intacte, attaque préservée', () => {
  const { x } = take(noise(sec(3), 0.003)); // ≈ −55 dBFS
  const out = noiseGate(x, SR, -45);
  // Après le maintien (60 ms) et la fermeture (80 ms), le silence est coupé.
  const cut = rmsDb(out, sec(1.8), sec(1.95)) - rmsDb(x, sec(1.8), sec(1.95));
  assert.ok(cut < -30, `silence : ${cut.toFixed(1)} dB`);
  assert.ok(Math.abs(rmsDb(out, sec(0.7), sec(1.3)) - rmsDb(x, sec(0.7), sec(1.3))) < 0.1, 'voix intacte');
  // Premières 10 ms de la phrase : la porte est déjà ouverte (anticipation).
  assert.ok(rmsDb(out, sec(0.5), sec(0.51)) - rmsDb(x, sec(0.5), sec(0.51)) > -3);
});

test('de-esser : sifflantes atténuées, voyelles intactes', () => {
  const n = sec(2);
  const vowel = voiceLike(220, 2);
  const hiss = highpassZeroPhase(noise(n, 0.25, 3), SR, 5500);
  const x = Float32Array.from(vowel);
  for (let i = sec(1); i < sec(1.2); i++) x[i] = hiss[i] + 0.2 * vowel[i]; // un « s »
  const out = cleanVoice(
    x,
    SR,
    normalizeClean({
      enabled: true,
      noise: { enabled: false },
      highpass: { enabled: false },
      deesser: { enabled: true, amount: 100 },
    }),
  ).signal;
  const s = rmsDb(out, sec(1.05), sec(1.15)) - rmsDb(x, sec(1.05), sec(1.15));
  const v = rmsDb(out, sec(0.3), sec(0.8)) - rmsDb(x, sec(0.3), sec(0.8));
  assert.ok(s < -5, `sifflante : ${s.toFixed(1)} dB`);
  assert.ok(Math.abs(v) < 0.5, `voyelle : ${v.toFixed(2)} dB`);
});

test('nettoyage désactivé ou neutre : signal identique', () => {
  const x = voiceLike(220, 0.5);
  const off = cleanVoice(
    x,
    SR,
    normalizeClean({ enabled: true, noise: { enabled: false }, highpass: { enabled: false } }),
  );
  assert.deepEqual(Array.from(off.signal), Array.from(x));
  assert.notEqual(off.signal, x, 'copie, pas le même tableau');
});

test('limite assumée : les clics (bruits impulsionnels) ne sont PAS enlevés', () => {
  const x = noise(sec(1), 0.002, 5);
  x[sec(0.5)] += 0.6;
  x[sec(0.5) + 1] -= 0.4;
  const out = cleanVoice(x, SR, normalizeClean({ enabled: true, noise: { amount: 100 } })).signal;
  let peak = 0;
  for (let i = sec(0.5) - 50; i < sec(0.5) + 50; i++) peak = Math.max(peak, Math.abs(out[i]));
  // Un clic n'est pas « stationnaire » : il ne fait pas partie de l'empreinte du bruit.
  assert.ok(peak > 0.5, `crête du clic après nettoyage : ${peak.toFixed(2)}`);
});

test('chaîne complète : nettoyage PUIS correction (moteur du Worker)', async () => {
  const { VoiceRenderer } = await import('../src/renderer/vocal/VoiceRenderer.js');
  const { normalizeSettings } = await import('../src/renderer/vocal/settings.js');
  const { analyzePitch } = await import('../src/renderer/vocal/dsp/pitch.js');
  const { hzToMidi, midiToHz } = await import('../src/renderer/vocal/theory.js');
  const { medianF0 } = await import('./helpers/signals.js');
  // Mi chanté 35 cents trop bas, entre deux silences, avec un souffle constant.
  const v = voiceLike(midiToHz(63.65), 1);
  const x = noise(sec(2), 0.01, 11);
  for (let i = 0; i < v.length; i++) x[sec(0.5) + i] += v[i];
  const r = new VoiceRenderer();
  r.load(1, x, SR);
  const settings = normalizeSettings({ pitch: { correct: true, speed: 0 } });
  const C = { key: 0, scale: 'major' };
  const corrected = r.render(1, settings, C, null);
  const both = r.render(1, settings, C, normalizeClean({ enabled: true, noise: { amount: 60 } }));
  assert.equal(corrected.cleanInfo, null);
  assert.equal(both.cleanInfo.source, 'auto');
  // Le souffle des silences a baissé…
  assert.ok(rmsDb(both.left, sec(1.7), sec(1.95)) - rmsDb(corrected.left, sec(1.7), sec(1.95)) < -8);
  // … et la voix est toujours recalée sur Mi (64).
  const out = hzToMidi(medianF0(analyzePitch(both.left.subarray(sec(0.5), sec(1.5)), SR), 0.2, 0.8));
  assert.ok(Math.abs(out - 64) < 0.1, `MIDI ${out}`);
  // Nettoyage seul (étage de hauteur neutre) : la voix nettoyée, à la même place.
  const cleanOnly = r.render(1, normalizeSettings({}), C, normalizeClean({ enabled: true, noise: { amount: 60 } }));
  assert.equal(cleanOnly.left.length, x.length);
});
