import assert from 'node:assert/strict';
import { test } from 'node:test';
import { laneAt, reorder, snapCandidates, snapStart } from '../src/renderer/audio/arrange.js';

test('reorder : vers le bas, vers le haut, bornes', () => {
  assert.deepEqual(reorder(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(reorder(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(reorder(['a', 'b', 'c'], 1, 99), ['a', 'c', 'b']);
  assert.deepEqual(reorder(['a', 'b'], 5, 0), ['a', 'b']);
});

test('snapStart : aimanté au point proche, libre sinon', () => {
  assert.deepEqual(snapStart(2.03, 4, [0, 2, 10], 0.05), { time: 2, snappedTo: 2 });
  assert.deepEqual(snapStart(2.2, 4, [0, 2, 10], 0.05), { time: 2.2, snappedTo: null });
});

test('snapStart : la fin du clip s’aligne aussi', () => {
  // Clip de 4 s qui finirait à 9,98 : aimanté pour finir pile à 10.
  const r = snapStart(5.98, 4, [10], 0.05);
  assert.ok(Math.abs(r.time - 6) < 1e-9);
  assert.equal(r.snappedTo, 10);
});

test('snapStart : jamais avant 0', () => {
  assert.equal(snapStart(-1, 2, [], 0.05).time, 0);
});

test('snapCandidates : 0, tête, bords des autres clips, grille', () => {
  const c = snapCandidates({ position: 3.3, otherClips: [{ start: 1, end: 5 }], gridStep: 2, near: 4.7 });
  assert.deepEqual(c, [0, 3.3, 1, 5, 4, 6]);
});

test('laneAt', () => {
  assert.equal(laneAt(10, 92, 3), 0);
  assert.equal(laneAt(200, 92, 3), 2);
  assert.equal(laneAt(999, 92, 3), 2);
  assert.equal(laneAt(-5, 92, 3), 0);
  assert.equal(laneAt(10, 92, 0), -1);
});
