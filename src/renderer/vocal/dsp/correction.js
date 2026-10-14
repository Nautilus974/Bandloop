// Calcul des courbes de hauteur cibles (voix principale et harmonies).
//
// Modèle « auto-tune » classique : pour chaque trame voisée, on calcule l'écart
// entre la hauteur chantée et la note de la gamme la plus proche, puis on applique
// cette correction LISSÉE dans le temps par un filtre du premier ordre dont la
// constante de temps est la « vitesse » :
//   - vitesse 0 ms   : correction immédiate, la voix saute de note en note,
//                      vibrato et glissandos sont effacés (effet robot) ;
//   - vitesse lente  : les mouvements rapides (vibrato, attaques) passent tels
//                      quels, seules les notes tenues sont ramenées vers la justesse.
import { diatonicShift, hzToMidi, nearestScaleNote, semitonesToRatio } from '../theory.js';

// Hystérésis (en demi-tons) pour éviter que la note cible oscille entre deux
// notes voisines quand le chanteur est pile entre les deux.
const HYSTERESIS = 0.15;

/**
 * @param {{ f0: Float32Array, hop: number, sampleRate: number }} analysis
 * @param {object} p
 * @param {boolean} p.correct       Correction de hauteur active
 * @param {number} p.key            Tonique (0-11)
 * @param {string} p.scale
 * @param {number} p.speed          Temps de calage en ms (0 = instantané)
 * @param {number} p.strength       Intensité de la correction, 0..1
 * @param {number} p.shift          Transposition globale en demi-tons
 * @returns {{ inMidi: Float32Array, outMidi: Float32Array, noteMidi: Float32Array, leadRatio: Float32Array }}
 *   Valeurs NaN pour les trames non voisées (sauf leadRatio, qui y vaut la transposition seule).
 */
export function buildLeadCurve(analysis, { correct, key, scale, speed, strength, shift }) {
  const n = analysis.f0.length;
  const inMidi = new Float32Array(n).fill(NaN);
  const outMidi = new Float32Array(n).fill(NaN);
  const noteMidi = new Float32Array(n).fill(NaN);
  const leadRatio = new Float32Array(n).fill(semitonesToRatio(shift));
  const hopSec = analysis.hop / analysis.sampleRate;
  const alpha = speed <= 0 ? 1 : 1 - Math.exp(-hopSec / (speed / 1000));

  let note = null;
  let correction = 0;
  for (let i = 0; i < n; i++) {
    const hz = analysis.f0[i];
    if (!hz) {
      note = null; // nouvelle phrase : on repart sans mémoire
      correction = 0;
      continue;
    }
    const midi = hzToMidi(hz);
    inMidi[i] = midi;

    const candidate = nearestScaleNote(midi, key, scale);
    if (note === null || Math.abs(midi - note) > Math.abs(midi - candidate) + HYSTERESIS) note = candidate;
    noteMidi[i] = note;

    if (correct) {
      const target = (note - midi) * strength;
      correction += alpha * (target - correction);
    } else {
      correction = 0;
    }
    outMidi[i] = midi + correction + shift;
    leadRatio[i] = semitonesToRatio(outMidi[i] - midi);
  }
  return { inMidi, outMidi, noteMidi, leadRatio };
}

/**
 * Courbe d'une voix d'harmonie. Elle suit la voix principale corrigée (vibrato compris)
 * décalée d'un intervalle :
 *   - mode « diatonic » : `interval` en degrés de la gamme (tierce = 2, quinte = 4),
 *     la taille réelle de l'intervalle s'adapte à la note (tierce majeure ou mineure) ;
 *   - mode « chromatic » : `interval` en demi-tons fixes.
 * @returns {Float32Array} rapport de transposition par trame (1 sur les trames non voisées)
 */
export function buildHarmonyRatio(lead, { interval, detune = 0, mode = 'diatonic' }, { key, scale }) {
  const n = lead.outMidi.length;
  const ratio = new Float32Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(lead.outMidi[i])) continue;
    let offset = interval;
    if (mode === 'diatonic') {
      // Note de la gamme sur laquelle est la voix principale (après transposition).
      const leadNote = nearestScaleNote(lead.outMidi[i], key, scale);
      offset = diatonicShift(leadNote, interval, key, scale) - leadNote;
    }
    ratio[i] = semitonesToRatio(lead.outMidi[i] + offset + detune / 100 - lead.inMidi[i]);
  }
  return ratio;
}

/**
 * Enveloppe de voisement lissée (0..1) par trame : sert à couper les harmonies
 * sur les consonnes et silences, où un doublage transposé sonne mal.
 */
export function voicingEnvelope(analysis, attackMs = 15, releaseMs = 60) {
  const n = analysis.f0.length;
  const env = new Float32Array(n);
  const hopMs = (analysis.hop / analysis.sampleRate) * 1000;
  const up = 1 - Math.exp(-hopMs / attackMs);
  const down = 1 - Math.exp(-hopMs / releaseMs);
  let v = 0;
  for (let i = 0; i < n; i++) {
    const target = analysis.f0[i] ? 1 : 0;
    v += (target > v ? up : down) * (target - v);
    env[i] = v;
  }
  return env;
}
