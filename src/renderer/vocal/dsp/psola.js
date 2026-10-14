// Transposition de la voix par TD-PSOLA (Time-Domain Pitch-Synchronous Overlap-Add).
//
// Principe : on découpe la voix en « grains » de deux périodes centrés sur chaque
// cycle glottique (marques d'analyse), puis on les recolle avec un espacement
// différent : plus serrés = voix plus aiguë, plus espacés = plus grave. La durée
// est inchangée et, contrairement à un simple changement de vitesse de lecture,
// l'enveloppe spectrale (les formants, donc le timbre) est conservée.
//
// Décalage de formants : on ré-échantillonne chaque grain (compressé = formants
// plus aigus, voix « chipmunk » ; étiré = formants plus graves, voix plus ronde).
//
// Bonne qualité sur une voix seule et sèche ; dégradation sur les sources
// polyphoniques, très soufflées ou réverbérées, et au-delà d'environ ±1 octave.

import { curveAt } from './synth.js';

const UNVOICED_PERIOD_S = 0.005; // espacement des grains sur les sons non voisés
const HANN_SIZE = 2048;
const HANN = Float32Array.from(
  { length: HANN_SIZE + 1 },
  (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / HANN_SIZE),
);

/**
 * Place les marques d'analyse : une par période sur les zones voisées, calées sur
 * le pic d'amplitude du cycle, et un pas fixe sur les zones non voisées.
 * @returns {{ marks: Int32Array, periods: Float32Array }}
 */
export function findPitchMarks(signal, analysis) {
  const { f0, hop, sampleRate } = analysis;
  const n = signal.length;
  const marks = [];
  const periods = [];
  const unvoicedPeriod = Math.round(UNVOICED_PERIOD_S * sampleRate);
  let t = 0;
  let wasVoiced = false;
  while (t < n) {
    const frame = Math.min(f0.length - 1, Math.round(t / hop));
    const hz = f0[frame];
    if (!hz) {
      marks.push(t);
      periods.push(unvoicedPeriod);
      t += unvoicedPeriod;
      wasVoiced = false;
      continue;
    }
    const period = sampleRate / hz;
    // Recherche du pic : sur une période entière au début d'une zone voisée,
    // puis dans une petite fenêtre autour de la position attendue (stabilité).
    const radius = wasVoiced ? Math.round(period * 0.2) : Math.round(period / 2);
    const center = wasVoiced ? t : t + Math.round(period / 2);
    let best = center;
    let bestVal = -Infinity;
    for (let j = Math.max(0, center - radius); j <= Math.min(n - 1, center + radius); j++) {
      if (signal[j] > bestVal) {
        bestVal = signal[j];
        best = j;
      }
    }
    if (marks.length && best <= marks[marks.length - 1]) best = marks[marks.length - 1] + Math.round(period);
    marks.push(best);
    periods.push(period);
    t = best + Math.round(period);
    wasVoiced = true;
  }
  return { marks: Int32Array.from(marks), periods: Float32Array.from(periods) };
}

/**
 * @param {Float32Array} signal       Voix mono
 * @param {object} analysis           Résultat d'analyzePitch
 * @param {Float32Array} ratioCurve   Rapport de transposition par trame (2 = +1 octave)
 * @param {object} [opts]
 * @param {number} [opts.formant=1]   Facteur de formants (>1 = timbre plus aigu)
 * @param {{marks: Int32Array, periods: Float32Array}} [opts.pitchMarks]  Marques pré-calculées
 * @returns {Float32Array} voix transposée, même durée
 */
export function psola(signal, analysis, ratioCurve, { formant = 1, pitchMarks } = {}) {
  const n = signal.length;
  const { marks, periods } = pitchMarks ?? findPitchMarks(signal, analysis);
  const out = new Float32Array(n);
  const weight = new Float32Array(n);
  if (!marks.length) return out;
  const { hop } = analysis;

  let k = 0; // marque d'analyse courante
  let ts = marks[0]; // position de synthèse
  while (ts < n) {
    // Marque d'analyse la plus proche de la position de synthèse (durée conservée).
    while (k + 1 < marks.length && Math.abs(marks[k + 1] - ts) <= Math.abs(marks[k] - ts)) k++;
    const ta = marks[k];
    const period = periods[k];
    const ratio = Math.min(4, Math.max(0.25, curveAt(ratioCurve, hop, ts)));
    // Espacement réel entre marques (et non la période théorique) : à rapport 1,
    // les grains sont recollés exactement à leur place d'origine.
    const spacing = k + 1 < marks.length ? marks[k + 1] - marks[k] : period;

    // Grain de deux périodes (fenêtre de Hann), raccourci si les formants montent.
    const half = period / formant;
    const halfInt = Math.ceil(half);
    const hannScale = HANN_SIZE / (2 * half);
    for (let j = -halfInt; j <= halfInt; j++) {
      const o = ts + j;
      if (o < 0 || o >= n) continue;
      const wi = (j + half) * hannScale;
      if (wi < 0 || wi > HANN_SIZE) continue;
      const w = HANN[Math.round(wi)];
      // Lecture du grain, ré-échantillonné d'un facteur `formant`.
      const src = ta + j * formant;
      const s0 = Math.floor(src);
      if (s0 < 0 || s0 + 1 >= n) continue;
      const frac = src - s0;
      out[o] += w * (signal[s0] * (1 - frac) + signal[s0 + 1] * frac);
      weight[o] += w;
    }
    ts += Math.max(1, Math.round(spacing / ratio));
  }

  // Quand les grains se chevauchent davantage (voix plus aiguë), leur somme gonfle :
  // on divise par le recouvrement. Quand ils s'espacent (voix plus grave), on ne
  // remplit pas les creux : chaque grain est une impulsion glottique qui s'éteint.
  for (let i = 0; i < n; i++) if (weight[i] > 1) out[i] /= weight[i];
  return out;
}
