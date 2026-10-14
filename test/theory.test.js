import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diatonicShift, hzToMidi, inScale, midiToHz, nearestScaleNote } from '../src/renderer/vocal/theory.js';

const C = 0;
const A = 9;

test('conversions Hz <-> MIDI', () => {
  assert.equal(hzToMidi(440), 69);
  assert.ok(Math.abs(midiToHz(60) - 261.6256) < 1e-3);
  assert.ok(Math.abs(hzToMidi(midiToHz(63.37)) - 63.37) < 1e-9);
});

test('inScale', () => {
  assert.ok(inScale(64, C, 'major')); // Mi
  assert.ok(!inScale(63, C, 'major')); // Mi♭
  assert.ok(inScale(63, C, 'minor'));
  assert.ok(inScale(61, C, 'chromatic'));
});

test('nearestScaleNote cale sur la gamme', () => {
  assert.equal(nearestScaleNote(60.3, C, 'major'), 60);
  assert.equal(nearestScaleNote(61.2, C, 'major'), 62); // Do♯+ -> Ré
  assert.equal(nearestScaleNote(63.4, C, 'major'), 64); // Mi♭ -> Mi
  assert.equal(nearestScaleNote(63.4, C, 'minor'), 63); // reste Mi♭ en mineur
  assert.equal(nearestScaleNote(61.4, C, 'chromatic'), 61);
  // Pentatonique mineure de La : La Do Ré Mi Sol
  assert.equal(nearestScaleNote(70.6, A, 'minorPentatonic'), 72); // Si+ -> Do
});

test('diatonicShift : tierces majeures et mineures selon le degré', () => {
  assert.equal(diatonicShift(60, 2, C, 'major'), 64); // Do -> Mi (tierce majeure)
  assert.equal(diatonicShift(62, 2, C, 'major'), 65); // Ré -> Fa (tierce mineure)
  assert.equal(diatonicShift(71, 2, C, 'major'), 74); // Si -> Ré, octave suivante
  assert.equal(diatonicShift(60, -2, C, 'major'), 57); // Do -> La en dessous
  assert.equal(diatonicShift(60, 7, C, 'major'), 72); // octave
  assert.equal(diatonicShift(60, 4, C, 'major'), 67); // quinte juste
  assert.equal(diatonicShift(71, 4, C, 'major'), 77); // Si -> Fa (quinte diminuée, dans la gamme)
});
