import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzePitch } from '../src/renderer/vocal/dsp/pitch.js';
import { medianF0, sine, SR, voiceLike } from './helpers/signals.js';

const close = (a, b, tolPct) => Math.abs(a - b) / b < tolPct / 100;

test('YIN détecte une sinusoïde à 220 Hz', () => {
  const a = analyzePitch(sine(220, 1), SR);
  assert.ok(close(medianF0(a), 220, 0.5), `f0=${medianF0(a)}`);
});

test('YIN détecte la fondamentale d’un signal riche (pas une harmonique)', () => {
  for (const hz of [98, 147.3, 311, 523.25]) {
    const a = analyzePitch(voiceLike(hz, 1), SR);
    assert.ok(close(medianF0(a), hz, 0.6), `${hz} Hz -> ${medianF0(a)}`);
  }
});

test('YIN : précision < 5 cents sur 440 Hz', () => {
  const a = analyzePitch(voiceLike(440, 1), SR);
  const cents = 1200 * Math.log2(medianF0(a) / 440);
  assert.ok(Math.abs(cents) < 5, `${cents} cents`);
});

test('silence et bruit -> non voisé', () => {
  const silence = analyzePitch(new Float32Array(SR), SR);
  assert.equal(silence.f0.filter((v) => v > 0).length, 0);
  let seed = 1;
  const noise = Float32Array.from(
    { length: SR },
    () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.5,
  );
  const a = analyzePitch(noise, SR);
  const voiced = a.f0.filter((v) => v > 0).length / a.f0.length;
  assert.ok(voiced < 0.1, `voiced ratio ${voiced}`);
});

test('analyse cadencée par hop et alignée sur le signal', () => {
  const a = analyzePitch(sine(200, 0.5), SR);
  assert.equal(a.hop, 256);
  assert.equal(a.f0.length, Math.ceil((0.5 * SR) / 256));
});
