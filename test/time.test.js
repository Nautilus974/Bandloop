import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatRulerLabel, formatTime, rulerStep } from '../src/renderer/ui/time.js';

test('formatTime', () => {
  assert.equal(formatTime(0), '0:00.000');
  assert.equal(formatTime(83.456), '1:23.456');
  assert.equal(formatTime(-2), '0:00.000');
});

test('rulerStep garde au moins 70 px entre les graduations', () => {
  assert.equal(rulerStep(50), 2);
  assert.equal(rulerStep(400), 0.25);
  assert.equal(rulerStep(10), 10);
});

test('formatRulerLabel', () => {
  assert.equal(formatRulerLabel(90, 10), '1:30');
  assert.equal(formatRulerLabel(2.5, 0.5), '0:02.5');
  assert.equal(formatRulerLabel(0.25, 0.25), '0:00.25');
});
