import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computePeaks, peakRange } from '../src/renderer/audio/peaks.js';

test('computePeaks : min/max par tranche, tous canaux confondus', () => {
  const left = Float32Array.from([0.1, -0.5, 0.3, 0.2, -0.1]);
  const right = Float32Array.from([0.9, 0, 0, -0.8, 0]);
  const peaks = computePeaks([left, right], 2);
  assert.equal(peaks.max.length, 3);
  assert.deepEqual(
    [...peaks.max].map((v) => +v.toFixed(2)),
    [0.9, 0.3, 0],
  );
  assert.deepEqual(
    [...peaks.min].map((v) => +v.toFixed(2)),
    [-0.5, -0.8, -0.1],
  );
});

test('peakRange agrège plusieurs pics et reste dans les bornes', () => {
  const peaks = { min: Float32Array.from([-0.1, -0.7, -0.2]), max: Float32Array.from([0.2, 0.4, 0.6]) };
  const r = peakRange(peaks, 0, 2);
  assert.ok(Math.abs(r.min + 0.7) < 1e-6 && Math.abs(r.max - 0.4) < 1e-6);
  const beyond = peakRange(peaks, 10, 12);
  assert.deepEqual(beyond, { min: 0, max: 0 });
  // Zoom fort : moins d'un pic par pixel, on prend quand même le pic courant.
  assert.ok(Math.abs(peakRange(peaks, 2.2, 2.4).max - 0.6) < 1e-6);
});
