import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeTakePlacement,
  describeMicError,
  estimateLatency,
  levelHint,
  makeClick,
  measureLoopbackLatency,
  takeName,
} from '../src/renderer/record/latency.js';

const SR = 48000;

test('placement : la prise est avancée de la latence', () => {
  assert.deepEqual(computeTakePlacement({ startPosition: 4, latency: 0.03, sampleRate: SR }), {
    startTime: 3.97,
    trimSamples: 0,
  });
});

test('placement : début de prise avant 0:00 -> rogné', () => {
  const p = computeTakePlacement({ startPosition: 0, latency: 0.025, sampleRate: SR });
  assert.equal(p.startTime, 0);
  assert.equal(p.trimSamples, 1200);
  const q = computeTakePlacement({ startPosition: 0.01, latency: 0.025, sampleRate: SR });
  assert.equal(q.trimSamples, 720);
});

test('placement : latence négative ignorée', () => {
  assert.deepEqual(computeTakePlacement({ startPosition: 2, latency: -1, sampleRate: SR }), {
    startTime: 2,
    trimSamples: 0,
  });
});

test('estimation de latence : sortie + entrée, valeurs par défaut sûres', () => {
  assert.ok(Math.abs(estimateLatency({ outputLatency: 0.02, inputLatency: 0.008 }) - 0.028) < 1e-12);
  assert.ok(Math.abs(estimateLatency({ outputLatency: 0, baseLatency: 0.01 }) - 0.03) < 1e-12);
  assert.ok(estimateLatency({}) > 0);
});

/** Simule une prise « boucle » : clics joués puis entendus avec retard, filtrés, bruités. */
function loopback(delaySec, clickFrames, { gain = 0.4, noise = 0.003, seconds = 3 } = {}) {
  const rec = new Float32Array(seconds * SR);
  const click = makeClick(SR);
  const delay = Math.round(delaySec * SR);
  for (const f of clickFrames) click.forEach((v, k) => (rec[f + delay + k] += v * gain));
  // Petite réverbération de pièce et passe-bas (micro/haut-parleur imparfaits).
  for (let i = rec.length - 1; i >= 600; i--) rec[i] += 0.25 * rec[i - 600];
  let lp = 0;
  let seed = 9;
  for (let i = 0; i < rec.length; i++) {
    lp += 0.6 * (rec[i] - lp);
    seed = (seed * 16807) % 2147483647;
    rec[i] = lp + (seed / 2147483647 - 0.5) * 2 * noise;
  }
  return rec;
}

test('mesure de latence par intercorrélation : à 1 ms près', () => {
  const clicks = [24000, 48000, 72000, 96000, 120000];
  for (const delay of [0.012, 0.037, 0.154]) {
    const r = measureLoopbackLatency(loopback(delay, clicks), SR, clicks);
    assert.ok(r.ok, r.reason);
    assert.ok(Math.abs(r.latency - delay) < 0.001, `attendu ${delay}, mesuré ${r.latency}`);
  }
});

test('mesure de latence : échec clair si les clics ne sont pas entendus', () => {
  const clicks = [24000, 48000, 72000];
  const r = measureLoopbackLatency(loopback(0.03, clicks, { gain: 0, noise: 0.002 }), SR, clicks);
  assert.equal(r.ok, false);
  assert.match(r.reason, /haut-parleurs/);
});

test('takeName : premier numéro libre', () => {
  assert.equal(takeName([]), 'Prise 1');
  assert.equal(takeName(['voix.wav', 'Prise 1', 'Prise 3']), 'Prise 2');
});

test('levelHint', () => {
  assert.equal(levelHint(0).level, 'none');
  assert.equal(levelHint(0.02).level, 'low');
  assert.equal(levelHint(0.3).level, 'good');
  assert.equal(levelHint(0.85).level, 'hot');
  assert.equal(levelHint(1).level, 'clip');
});

test('describeMicError : messages clairs selon l’erreur et le système', () => {
  const mac = describeMicError({ name: 'NotAllowedError' }, 'darwin');
  assert.equal(mac.title, 'Accès au micro refusé');
  assert.match(mac.text, /Réglages Système/);
  assert.ok(mac.canOpenSettings);
  assert.match(describeMicError({ name: 'SystemDenied' }, 'win32').text, /applications de bureau/);
  assert.equal(describeMicError({ name: 'NotFoundError' }, 'darwin').title, 'Aucun micro détecté');
  assert.match(describeMicError({ name: 'NotReadableError' }, 'win32').text, /autre application/);
  assert.equal(describeMicError({ name: 'NotAllowedError' }, 'web').canOpenSettings, false);
  assert.equal(describeMicError({ name: 'NotSupportedError' }, 'web').title, 'Micro non disponible ici');
  assert.equal(describeMicError(new Error('boum'), 'darwin').text, 'boum');
});
