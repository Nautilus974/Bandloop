// Vocodeur à canaux, calculé hors temps réel par transformée de Fourier à court terme.
//
// Principe : la voix (modulateur) impose son enveloppe spectrale — ce qui rend
// les voyelles et consonnes intelligibles — à un synthétiseur (porteuse). Ici la
// porteuse est un accord de dents de scie qui SUIT la mélodie corrigée de la voix,
// plus un souffle de bruit pour les consonnes. Pour chaque trame :
//   1. FFT de la voix et de la porteuse ;
//   2. énergie par bande (bandes espacées logarithmiquement de 80 Hz à ~10 kHz) ;
//   3. gain par bande = enveloppe voix / enveloppe porteuse, appliqué au spectre de
//      la porteuse (interpolé entre les bandes) ;
//   4. FFT inverse et addition-recouvrement.
import { midiToHz } from '../theory.js';
import { fft } from './fft.js';
import { curveAt, polyBlep, rng } from './synth.js';

const FFT_SIZE = 1024;
const HOP = FFT_SIZE / 2;

/**
 * Porteuse : accord de dents de scie suivant la courbe de hauteur (MIDI par trame,
 * NaN = non voisé, on garde alors la dernière note), + bruit sur les non-voisés.
 * @param {Float32Array} midiCurve
 * @param {Float32Array} voicing     Enveloppe de voisement 0..1 par trame
 * @param {number[]} offsets         Décalages en demi-tons (ou fonctions note -> décalage)
 */
export function synthCarrier(length, sampleRate, hop, midiCurve, voicing, offsets, noise = 0.35, seed = 7) {
  // Courbe sans trous : on prolonge la dernière note voisée (ou la première à venir).
  const filled = Float32Array.from(midiCurve);
  let last = filled.find((v) => !Number.isNaN(v));
  if (last === undefined) last = 57;
  for (let i = 0; i < filled.length; i++) {
    if (Number.isNaN(filled[i])) filled[i] = last;
    else last = filled[i];
  }
  // Fréquences par trame et par voix, calculées une fois (et non à chaque échantillon).
  const freqs = offsets.map((off) =>
    Float32Array.from(filled, (midi) => midiToHz(midi + (typeof off === 'function' ? off(midi) : off))),
  );
  const out = new Float32Array(length);
  const phases = offsets.map((_, i) => i * 0.37);
  const random = rng(seed);
  const gain = 0.6 / Math.sqrt(offsets.length);
  for (let i = 0; i < length; i++) {
    let v = 0;
    for (let o = 0; o < freqs.length; o++) {
      const dt = Math.min(0.45, curveAt(freqs[o], hop, i) / sampleRate);
      phases[o] += dt;
      if (phases[o] >= 1) phases[o] -= 1;
      v += 2 * phases[o] - 1 - polyBlep(phases[o], dt);
    }
    const unvoiced = 1 - curveAt(voicing, hop, i);
    out[i] = v * gain + (random() * 2 - 1) * noise * (0.15 + 0.85 * unvoiced);
  }
  return out;
}

function bandEdges(bands, sampleRate) {
  const lo = 80;
  const hi = Math.min(10000, sampleRate * 0.45);
  const binHz = sampleRate / FFT_SIZE;
  const edges = [];
  for (let b = 0; b <= bands; b++) edges.push(Math.round((lo * Math.pow(hi / lo, b / bands)) / binHz));
  return edges;
}

/**
 * @param {Float32Array} modulator  Voix
 * @param {Float32Array} carrier    Porteuse (même longueur)
 * @returns {Float32Array}
 */
export function vocode(modulator, carrier, sampleRate, bands = 20) {
  const n = modulator.length;
  const out = new Float32Array(n);
  // Racine de Hann en analyse et en synthèse : avec 50 % de recouvrement, le
  // produit des deux fenêtres somme exactement à 1 (reconstruction parfaite).
  const win = Float64Array.from({ length: FFT_SIZE }, (_, i) => Math.sin((Math.PI * i) / FFT_SIZE));
  const edges = bandEdges(bands, sampleRate);
  const centers = edges.slice(0, -1).map((e, b) => (e + edges[b + 1]) / 2);
  const zRe = new Float64Array(FFT_SIZE);
  const zIm = new Float64Array(FFT_SIZE);
  const mRe = new Float64Array(FFT_SIZE);
  const mIm = new Float64Array(FFT_SIZE);
  const cRe = new Float64Array(FFT_SIZE);
  const cIm = new Float64Array(FFT_SIZE);
  const gains = new Float64Array(bands);
  const smoothed = new Float64Array(bands);
  // Pour chaque bin : bande de gauche et poids d'interpolation (calculés une fois).
  const half = FFT_SIZE / 2;
  const binBand = new Int32Array(half + 1).fill(-1);
  const binT = new Float64Array(half + 1);
  for (let k = edges[0]; k < Math.min(edges[bands], half + 1); k++) {
    let b = 0;
    while (b < bands - 1 && centers[b + 1] <= k) b++;
    binBand[k] = b;
    binT[k] = k <= centers[0] || b >= bands - 1 ? 0 : (k - centers[b]) / (centers[b + 1] - centers[b]);
  }

  for (let start = -FFT_SIZE / 2; start < n; start += HOP) {
    // Deux FFT réelles pour le prix d'une : voix en partie réelle, porteuse en
    // partie imaginaire, puis séparation par symétrie hermitienne.
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = start + i;
      const inside = idx >= 0 && idx < n;
      zRe[i] = inside ? modulator[idx] * win[i] : 0;
      zIm[i] = inside ? carrier[idx] * win[i] : 0;
    }
    fft(zRe, zIm);
    for (let k = 0; k <= half; k++) {
      const j = (FFT_SIZE - k) % FFT_SIZE;
      mRe[k] = (zRe[k] + zRe[j]) / 2;
      mIm[k] = (zIm[k] - zIm[j]) / 2;
      cRe[k] = (zIm[k] + zIm[j]) / 2;
      cIm[k] = (zRe[j] - zRe[k]) / 2;
    }

    for (let b = 0; b < bands; b++) {
      let em = 0;
      let ec = 0;
      for (let k = edges[b]; k < Math.max(edges[b + 1], edges[b] + 1); k++) {
        em += mRe[k] * mRe[k] + mIm[k] * mIm[k];
        ec += cRe[k] * cRe[k] + cIm[k] * cIm[k];
      }
      gains[b] = Math.sqrt(em / (ec + 1e-9));
      // Léger lissage temporel pour éviter le « gazouillis » entre trames.
      smoothed[b] = 0.35 * smoothed[b] + 0.65 * gains[b];
    }

    // Gain par bin : interpolation linéaire entre centres de bandes, 0 hors plage.
    for (let k = 0; k <= half; k++) {
      const b = binBand[k];
      const g =
        b < 0 ? 0 : b >= bands - 1 ? smoothed[bands - 1] : smoothed[b] * (1 - binT[k]) + smoothed[b + 1] * binT[k];
      cRe[k] *= g;
      cIm[k] *= g;
      if (k > 0 && k < half) {
        cRe[FFT_SIZE - k] = cRe[k];
        cIm[FFT_SIZE - k] = -cIm[k];
      }
    }
    cIm[0] = 0;
    cIm[half] = 0;
    fft(cRe, cIm, true);
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = start + i;
      if (idx >= 0 && idx < n) out[idx] += cRe[i] * win[i];
    }
  }
  return out;
}
