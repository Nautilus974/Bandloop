import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeSourceSchedule, dbToGain, MIN_DB } from '../src/renderer/audio/scheduling.js';

test('clip qui commence au début : démarre à when avec offset = playhead', () => {
  assert.deepEqual(computeSourceSchedule({ clipStart: 0, clipDuration: 10, playhead: 3, when: 100 }), {
    when: 100,
    offset: 3,
  });
});

test('clip qui commence plus tard : programmé dans le futur, offset 0', () => {
  assert.deepEqual(computeSourceSchedule({ clipStart: 5, clipDuration: 10, playhead: 2, when: 100 }), {
    when: 103,
    offset: 0,
  });
});

test('clip déjà terminé : rien à jouer', () => {
  assert.equal(computeSourceSchedule({ clipStart: 0, clipDuration: 4, playhead: 4, when: 100 }), null);
  assert.equal(computeSourceSchedule({ clipStart: 0, clipDuration: 4, playhead: 9, when: 100 }), null);
});

test('dbToGain', () => {
  assert.equal(dbToGain(0), 1);
  assert.ok(Math.abs(dbToGain(-6) - 0.501) < 0.001);
  assert.ok(Math.abs(dbToGain(6) - 1.995) < 0.001);
  assert.equal(dbToGain(MIN_DB), 0);
});
