import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  generateImpulse,
  makeDistortionCurve,
  makeQuantizeCurve,
  mixGains,
  quantize,
} from '../src/renderer/vocal/fx/curves.js';

const energy = (x, from, to) => x.slice(from, to).reduce((s, v) => s + v * v, 0);

test('réponse impulsionnelle : durée, décroissance, stéréo, reproductible', () => {
  const sr = 44100;
  const [l, r] = generateImpulse(sr, { decay: 2, brightness: 6000, seed: 3 });
  assert.equal(l.length, Math.round(2.2 * sr));
  const n = l.length;
  assert.ok(energy(l, 0, n / 10) > 1000 * energy(l, n - n / 10, n), 'la queue doit être bien plus faible');
  assert.notDeepEqual(l.slice(0, 1000), r.slice(0, 1000));
  const [l2] = generateImpulse(sr, { decay: 2, brightness: 6000, seed: 3 });
  assert.deepEqual(l, l2);
});

test('courbes de distorsion bornées et monotones', () => {
  for (const c of ['soft', 'hard', 'amp']) {
    for (const drive of [0, 50, 100]) {
      const curve = makeDistortionCurve(c, drive);
      assert.ok(
        curve.every((v) => v >= -1 && v <= 1),
        `${c} ${drive} borné`,
      );
      for (let i = 1; i < curve.length; i++) assert.ok(curve[i] >= curve[i - 1] - 1e-9, `${c} ${drive} monotone`);
    }
  }
});

test('saturation douce symétrique, ampli asymétrique', () => {
  const soft = makeDistortionCurve('soft', 60);
  const amp = makeDistortionCurve('amp', 60);
  const last = soft.length - 1;
  assert.ok(Math.abs(soft[0] + soft[last]) < 1e-6);
  assert.ok(Math.abs(amp[0] + amp[last]) > 0.1);
});

test('plus de drive = plus de compression du signal faible', () => {
  const at = (curve, x) => curve[Math.round(((x + 1) / 2) * (curve.length - 1))];
  assert.ok(at(makeDistortionCurve('soft', 80), 0.2) > at(makeDistortionCurve('soft', 10), 0.2));
});

test('quantize : nombre de niveaux selon les bits', () => {
  assert.equal(quantize(0.3, 2), 0.5);
  assert.equal(quantize(0.2, 2), 0);
  assert.equal(new Set(makeQuantizeCurve(3)).size, 9); // -4..4 / 4
  assert.ok(Math.abs(quantize(0.123456, 16) - 0.123456) < 1e-4);
});

test('mixGains : puissance constante', () => {
  for (const m of [0, 25, 50, 100]) {
    const [d, w] = mixGains(m);
    assert.ok(Math.abs(d * d + w * w - 1) < 1e-9);
  }
  assert.deepEqual(mixGains(0), [1, 0]);
});
