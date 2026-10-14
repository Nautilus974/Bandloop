// Bourdon : accord tenu sur la tonique du morceau, qui s'ouvre quand la voix
// chante et retombe lentement après (attaque et tenue longues).
//
// Synthèse : par note, deux dents de scie désaccordées (±7 cents, une par canal,
// effet de largeur) + une sinusoïde à l'octave inférieure, filtrées par un
// passe-bas du premier ordre. L'enveloppe suit la présence de la voix.
import { midiToHz } from '../theory.js';
import { curveAt, polyBlep } from './synth.js';

/**
 * @param {object} analysis   Analyse de hauteur (pour savoir quand la voix chante)
 * @param {number} length
 * @param {object} p          { key, notes, octave, attack, release, brightness }
 * @returns {{ left: Float32Array, right: Float32Array }}
 */
export function synthDrone(analysis, length, { key, notes, octave, attack, release, brightness }) {
  const { sampleRate, hop, rms } = analysis;
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const root = 48 + key + 12 * octave; // Do3 + tonique

  // Présence de la voix par trame : énergie au-dessus du bruit de fond.
  let peak = 0;
  for (const v of rms) peak = Math.max(peak, v);
  const presence = Float32Array.from(rms, (v) => (v > peak * 0.05 ? 1 : 0));

  const up = 1 - Math.exp(-1 / (attack * sampleRate));
  const down = 1 - Math.exp(-1 / (release * sampleRate));
  const lpCoef = 1 - Math.exp((-2 * Math.PI * brightness) / sampleRate);
  const voices = notes.map((n) => midiToHz(root + n));
  const detune = Math.pow(2, 7 / 1200);
  const phases = voices.map(() => [0, 0.5, 0]);
  const gain = 0.35 / Math.sqrt(voices.length);
  let env = 0;
  let lpL = 0;
  let lpR = 0;

  for (let i = 0; i < length; i++) {
    const target = curveAt(presence, hop, i);
    env += (target > env ? up : down) * (target - env);
    let l = 0;
    let r = 0;
    for (let v = 0; v < voices.length; v++) {
      const ph = phases[v];
      const dtL = voices[v] / detune / sampleRate;
      const dtR = (voices[v] * detune) / sampleRate;
      ph[0] = (ph[0] + dtL) % 1;
      ph[1] = (ph[1] + dtR) % 1;
      ph[2] = (ph[2] + voices[v] / 2 / sampleRate) % 1;
      const sub = 0.6 * Math.sin(2 * Math.PI * ph[2]);
      l += 2 * ph[0] - 1 - polyBlep(ph[0], dtL) + sub;
      r += 2 * ph[1] - 1 - polyBlep(ph[1], dtR) + sub;
    }
    lpL += lpCoef * (l - lpL);
    lpR += lpCoef * (r - lpR);
    left[i] = lpL * gain * env;
    right[i] = lpR * gain * env;
  }
  return { left, right };
}
