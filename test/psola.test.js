import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzePitch } from '../src/renderer/vocal/dsp/pitch.js';
import { psola } from '../src/renderer/vocal/dsp/psola.js';
import { medianF0, SR, voiceLike } from './helpers/signals.js';

const cents = (a, b) => 1200 * Math.log2(a / b);
const rms = (x, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / (to - from));
};

function shiftAndMeasure(hz, ratio, opts) {
  const input = voiceLike(hz, 1);
  const analysis = analyzePitch(input, SR);
  const out = psola(input, analysis, new Float32Array(analysis.f0.length).fill(ratio), opts);
  return { input, out, f0: medianF0(analyzePitch(out, SR), 0.1, 0.9) };
}

test('rapport 1 : reconstruction quasi transparente', () => {
  const { input, out } = shiftAndMeasure(180, 1);
  let num = 0;
  let a = 0;
  let b = 0;
  for (let i = 2000; i < input.length - 2000; i++) {
    num += input[i] * out[i];
    a += input[i] ** 2;
    b += out[i] ** 2;
  }
  const correlation = num / Math.sqrt(a * b);
  assert.ok(correlation > 0.97, `corrélation ${correlation}`);
});

for (const [hz, ratio] of [
  [200, 1.5],
  [200, 2],
  [300, 0.75],
  [220, 0.5],
  [150, Math.pow(2, 3 / 12)],
]) {
  test(`transpose ${hz} Hz × ${ratio.toFixed(3)} à moins de 10 cents`, () => {
    const { f0 } = shiftAndMeasure(hz, ratio);
    assert.ok(Math.abs(cents(f0, hz * ratio)) < 10, `obtenu ${f0} Hz, attendu ${hz * ratio}`);
  });
}

test('durée et niveau conservés', () => {
  const { input, out } = shiftAndMeasure(200, 1.26);
  assert.equal(out.length, input.length);
  const ratio = rms(out, 4000, 40000) / rms(input, 4000, 40000);
  assert.ok(ratio > 0.7 && ratio < 1.3, `niveau ×${ratio}`);
});

test('le décalage de formants ne change pas la hauteur perçue', () => {
  const { f0 } = shiftAndMeasure(200, 1, { formant: 1.25 });
  assert.ok(Math.abs(cents(f0, 200)) < 10, `${f0} Hz`);
});
