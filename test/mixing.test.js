import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effectiveGain, formatPan, meterLevel } from '../src/renderer/audio/mixing.js';

test('effectiveGain : volume seul', () => {
  assert.equal(effectiveGain({ volumeDb: 0, muted: false, solo: false }, false), 1);
});

test('effectiveGain : une piste en solo coupe les autres', () => {
  assert.equal(effectiveGain({ volumeDb: 0, muted: false, solo: false }, true), 0);
  assert.equal(effectiveGain({ volumeDb: 0, muted: false, solo: true }, true), 1);
});

test('effectiveGain : le mute l’emporte sur le solo', () => {
  assert.equal(effectiveGain({ volumeDb: 0, muted: true, solo: true }, true), 0);
});

test('formatPan', () => {
  assert.equal(formatPan(0), 'C');
  assert.equal(formatPan(-0.4), 'G 40');
  assert.equal(formatPan(0.251), 'D 25');
  assert.equal(formatPan(0.004), 'C');
});

test('meterLevel : échelle -48..0 dBFS', () => {
  assert.equal(meterLevel(0), 0);
  assert.equal(meterLevel(1), 1);
  assert.equal(meterLevel(2), 1);
  assert.ok(Math.abs(meterLevel(Math.pow(10, -24 / 20)) - 0.5) < 1e-9);
});
