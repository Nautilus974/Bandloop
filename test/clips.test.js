import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clipAt,
  clipEnd,
  computeFades,
  deleteRange,
  fullClip,
  planClip,
  rescaleClips,
  splitClip,
  splitClipRange,
  splitClipsAt,
  trimClip,
} from '../src/renderer/audio/clips.js';
import { EditHistory } from '../src/renderer/audio/history.js';

const SR = 1000; // 1 échantillon = 1 ms : calculs lisibles
const LEN = 10000; // 10 s d'audio
const strip = (clips) => clips.map(({ start, offset, length }) => ({ start, offset, length }));

test('découpe : deux morceaux bout à bout, coupe à l’échantillon', () => {
  const c = { ...fullClip(LEN), start: 2 };
  const [a, b] = splitClip(c, 5.0004, SR); // arrondi à l'échantillon : 3000 éch.
  assert.deepEqual(strip([a, b]), [
    { start: 2, offset: 0, length: 3000 },
    { start: 5, offset: 3000, length: 7000 },
  ]);
  assert.equal(a.id, c.id, 'le morceau de gauche garde l’identité du clip');
  assert.notEqual(b.id, c.id);
  assert.equal(clipEnd(a, SR), b.start, 'bout à bout');
  assert.equal(splitClip(c, 2, SR), null, 'pas de coupe sur un bord');
  assert.equal(splitClip(c, 12, SR), null);
});

test('splitClipsAt : seulement le clip visé', () => {
  const a = { id: 'a', start: 0, offset: 0, length: 4000 };
  const b = { id: 'b', start: 0, offset: 4000, length: 4000 }; // superposé
  assert.equal(splitClipsAt([a, b], 2, SR, 'b').clips.length, 3);
  assert.equal(splitClipsAt([a, b], 2, SR).clips.length, 4);
  assert.equal(splitClipsAt([a], 9, SR).changed, false);
});

test('suppression d’une portion : le reste se recolle', () => {
  const c = { id: 'x', start: 1, offset: 0, length: LEN }; // de 1 s à 11 s
  const { clips } = deleteRange([c], 3, 5, SR); // retire 2 s au milieu
  assert.deepEqual(strip(clips), [
    { start: 1, offset: 0, length: 2000 },
    { start: 3, offset: 4000, length: 6000 }, // recollé à 3 s, reprend à l'échantillon 4000
  ]);
  assert.equal(clipEnd(clips[1], SR), 9, 'le clip raccourcit de 2 s');
});

test('suppression sans recoller : un blanc reste', () => {
  const { clips } = deleteRange([{ id: 'x', start: 1, offset: 0, length: LEN }], 3, 5, SR, { ripple: false });
  assert.deepEqual(strip(clips), [
    { start: 1, offset: 0, length: 2000 },
    { start: 5, offset: 4000, length: 6000 },
  ]);
});

test('suppression au début, à la fin, du clip entier, hors clip', () => {
  const c = { id: 'x', start: 1, offset: 0, length: LEN };
  assert.deepEqual(strip(deleteRange([c], 0, 2, SR).clips), [{ start: 1, offset: 1000, length: 9000 }]);
  assert.deepEqual(strip(deleteRange([c], 10, 20, SR).clips), [{ start: 1, offset: 0, length: 9000 }]);
  assert.deepEqual(deleteRange([c], 0, 20, SR).clips, []);
  assert.equal(deleteRange([c], 15, 20, SR).changed, false);
  assert.equal(deleteRange([c], 3, 3, SR).changed, false);
});

test('rognage : début et fin, bornés par l’audio disponible et 10 ms minimum', () => {
  const c = { id: 'x', start: 2, offset: 1000, length: 4000 }; // audio 1-5 s, posé à 2 s
  assert.deepEqual(strip([trimClip(c, 'start', 3, SR, LEN)]), [{ start: 3, offset: 2000, length: 3000 }]);
  // On ne peut pas révéler plus d'audio qu'il n'en existe avant l'offset (1 s).
  assert.deepEqual(strip([trimClip(c, 'start', 0, SR, LEN)]), [{ start: 1, offset: 0, length: 5000 }]);
  assert.deepEqual(strip([trimClip(c, 'start', 99, SR, LEN)]), [{ start: 5.99, offset: 4990, length: 10 }]);
  assert.deepEqual(strip([trimClip(c, 'end', 4, SR, LEN)]), [{ start: 2, offset: 1000, length: 2000 }]);
  assert.deepEqual(strip([trimClip(c, 'end', 99, SR, LEN)]), [{ start: 2, offset: 1000, length: 9000 }]);
  // Début rogné vers la gauche : jamais avant 0:00.
  const early = { id: 'y', start: 0.5, offset: 3000, length: 1000 };
  assert.equal(trimClip(early, 'start', -2, SR, LEN).start, 0);
});

test('fondus : seulement aux jointures discontinues', () => {
  const whole = fullClip(LEN);
  assert.deepEqual(computeFades([whole], SR, LEN).get(whole.id), { fadeIn: false, fadeOut: false });
  // Coupe restée en place : continuité parfaite, aucun fondu.
  const [a, b] = splitClip(whole, 4, SR);
  const f1 = computeFades([a, b], SR, LEN);
  assert.deepEqual(
    [f1.get(a.id), f1.get(b.id)],
    [
      { fadeIn: false, fadeOut: false },
      { fadeIn: false, fadeOut: false },
    ],
  );
  // Portion supprimée et recollée : fondus de part et d'autre de la jointure.
  const { clips } = deleteRange([whole], 4, 6, SR);
  const f2 = computeFades(clips, SR, LEN);
  assert.deepEqual(
    [f2.get(clips[0].id), f2.get(clips[1].id)],
    [
      { fadeIn: false, fadeOut: true },
      { fadeIn: true, fadeOut: false },
    ],
  );
});

test('planClip : lecture depuis le début, en cours de clip, clip passé', () => {
  const c = { id: 'x', start: 2, offset: 3000, length: 4000 }; // joue l'audio 3-7 s, de 2 à 6 s
  assert.deepEqual(planClip(c, SR, 0, 100), { when: 102, offset: 3, duration: 4, fromStart: true });
  assert.deepEqual(planClip(c, SR, 3, 100), { when: 100, offset: 4, duration: 3, fromStart: false });
  assert.equal(planClip(c, SR, 6, 100), null);
});

test('clipAt et rescaleClips', () => {
  const a = { id: 'a', start: 0, offset: 0, length: 3000 };
  const b = { id: 'b', start: 2, offset: 0, length: 3000 };
  assert.equal(clipAt([a, b], 1, SR).id, 'a');
  assert.equal(clipAt([a, b], 2.5, SR).id, 'b', 'le clip au-dessus l’emporte');
  assert.equal(clipAt([a, b], 9, SR), null);
  assert.deepEqual(strip(rescaleClips([{ id: 'a', start: 1, offset: 441, length: 4410 }], 44100, 48000, 100000)), [
    { start: 1, offset: 480, length: 4800 },
  ]);
});

test('historique : annuler / rétablir, opérations sans effet ignorées', () => {
  let state = { clips: [1] };
  const h = new EditHistory({ capture: () => structuredClone(state), restore: (s) => (state = structuredClone(s)) });
  h.perform('Découper', () => (state.clips = [1, 2]));
  h.perform('Rien', () => {});
  h.perform('Supprimer', () => (state.clips = [2]));
  assert.equal(h.undoLabel, 'Supprimer');
  assert.equal(h.undo(), 'Supprimer');
  assert.deepEqual(state.clips, [1, 2]);
  assert.equal(h.undo(), 'Découper');
  assert.deepEqual(state.clips, [1]);
  assert.equal(h.undo(), null);
  assert.equal(h.redo(), 'Découper');
  assert.deepEqual(state.clips, [1, 2]);
  h.perform('Autre', () => (state.clips = [3]));
  assert.equal(h.canRedo, false, 'une nouvelle opération efface « Rétablir »');
});

test('historique : limite de taille', () => {
  let n = 0;
  const h = new EditHistory({ capture: () => n, restore: (s) => (n = s), limit: 3 });
  for (let i = 0; i < 5; i++) h.perform(`op${i}`, () => n++);
  let undone = 0;
  while (h.undo()) undone++;
  assert.equal(undone, 3);
  assert.equal(n, 2);
});

test('splitClipRange : la sélection devient un clip, ses voisins restent en place', () => {
  const c = { id: 'a', start: 1, offset: 100, length: 6000 }; // 1 s → 7 s
  const { clips, middleId } = splitClipRange([c], 'a', 1.25, 1.5, SR);
  assert.equal(clips.length, 3);
  const mid = clips.find((x) => x.id === middleId);
  assert.deepEqual([mid.start, mid.offset, mid.length], [1.25, 350, 250]);
  assert.equal(
    clips.reduce((n, x) => n + x.length, 0),
    6000,
    'aucun échantillon perdu ni dupliqué',
  );
  // Sélection touchant un bord : une seule coupe.
  const edge = splitClipRange([c], 'a', 1, 1.5, SR);
  assert.equal(edge.clips.length, 2);
  assert.equal(edge.middleId, 'a');
});

test('historique : instantané « avant » fourni par un geste en cours', () => {
  let state = { v: 1 };
  const h = new EditHistory({ capture: () => ({ ...state }), restore: (s) => (state = { ...s }) });
  const before = h.capture();
  state.v = 2; // modifié en direct pendant le geste
  h.perform('Déplacer', () => (state.v = 3), before);
  h.undo();
  assert.equal(state.v, 1);
});

test('historique : commandes (annuler / refaire) mêlées aux instantanés', () => {
  let state = { clips: [1] };
  let name = 'Voix';
  const h = new EditHistory({ capture: () => structuredClone(state), restore: (s) => (state = structuredClone(s)) });
  h.perform('Découper', () => (state.clips = [1, 2]));
  name = 'Chant';
  h.push({ label: 'Renommer la piste', undo: () => (name = 'Voix'), redo: () => (name = 'Chant') });
  assert.equal(h.undoLabel, 'Renommer la piste');
  assert.equal(h.undo(), 'Renommer la piste');
  assert.equal(name, 'Voix');
  assert.deepEqual(state.clips, [1, 2], 'le montage n’est pas touché');
  assert.equal(h.undo(), 'Découper');
  assert.equal(h.redo(), 'Découper');
  assert.equal(h.redo(), 'Renommer la piste');
  assert.equal(name, 'Chant');
  h.undo();
  h.push({ label: 'Couleur', undo: () => {}, redo: () => {} });
  assert.equal(h.canRedo, false, 'une nouvelle commande efface « Rétablir »');
});

test('historique : un geste continu (même clé, rapproché) donne une seule entrée', () => {
  let v = 0;
  const h = new EditHistory({ capture: () => null, restore: () => {} });
  const set = (from, to, now, mergeKey = 'speed') =>
    h.push({ label: 'Vitesse', undo: () => (v = from), redo: () => (v = to) }, { mergeKey, now });
  v = 10;
  set(0, 10, 1000);
  v = 20;
  set(10, 20, 1100);
  v = 35;
  set(20, 35, 1300);
  assert.equal(h.undoStack.length, 1);
  h.undo();
  assert.equal(v, 0, 'retour à la valeur d’avant le geste');
  h.redo();
  assert.equal(v, 35, 'rétablir donne la valeur finale');
  set(35, 40, 9000); // longtemps après : nouvelle entrée
  set(40, 50, 9100, 'strength'); // autre réglage : nouvelle entrée
  assert.equal(h.undoStack.length, 3);
});
