// Détection de hauteur (f0) par l'algorithme YIN (de Cheveigné & Kawahara, 2002).
//
// Pour aller vite, le signal est d'abord décimé vers ~11 kHz (filtre passe-bas
// à réponse impulsionnelle finie puis sous-échantillonnage) : la voix chantée a
// sa fondamentale sous 1 kHz, la précision est rattrapée par interpolation
// parabolique. Résultat : une hauteur toutes les ~5,8 ms (hop de 256 échantillons à 44,1 kHz).

const DETECTION_RATE = 11025;
const FIR_TAPS = 63;

/** Filtre passe-bas (sinc fenêtré Blackman) + sous-échantillonnage d'un facteur `factor`. */
export function decimate(signal, factor) {
  if (factor <= 1) return Float32Array.from(signal);
  const cutoff = 0.45 / factor; // en fraction de la fréquence d'échantillonnage d'origine
  const half = (FIR_TAPS - 1) / 2;
  const taps = new Float32Array(FIR_TAPS);
  let sum = 0;
  for (let i = 0; i < FIR_TAPS; i++) {
    const n = i - half;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    const w =
      0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (FIR_TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (FIR_TAPS - 1));
    taps[i] = sinc * w;
    sum += taps[i];
  }
  for (let i = 0; i < FIR_TAPS; i++) taps[i] /= sum;

  const out = new Float32Array(Math.floor(signal.length / factor));
  for (let o = 0; o < out.length; o++) {
    const center = o * factor;
    let acc = 0;
    for (let i = 0; i < FIR_TAPS; i++) {
      const idx = center + i - half;
      if (idx >= 0 && idx < signal.length) acc += signal[idx] * taps[i];
    }
    out[o] = acc;
  }
  return out;
}

/**
 * Analyse la hauteur d'un signal mono.
 * @param {Float32Array} signal
 * @param {number} sampleRate
 * @param {object} [opts]
 * @returns {{ sampleRate: number, hop: number, f0: Float32Array, clarity: Float32Array, rms: Float32Array }}
 *   `hop` est en échantillons du signal d'origine ; la trame i est centrée sur i * hop.
 *   f0 vaut 0 pour les trames non voisées (silence, consonnes, souffle).
 */
export function analyzePitch(signal, sampleRate, { minHz = 70, maxHz = 1100, threshold = 0.15, hop = 256 } = {}) {
  const factor = Math.max(1, Math.floor(sampleRate / DETECTION_RATE));
  const x = decimate(signal, factor);
  const sr = sampleRate / factor;
  const minTau = Math.max(2, Math.floor(sr / maxHz));
  const maxTau = Math.ceil(sr / minHz);
  const W = Math.max(maxTau, Math.round(0.025 * sr)); // fenêtre d'intégration ~25 ms
  const frames = Math.ceil(signal.length / hop);
  const f0 = new Float32Array(frames);
  const clarity = new Float32Array(frames);
  const rms = new Float32Array(frames);
  const d = new Float32Array(maxTau + 2);

  // Énergie (RMS) sur ~20 ms autour de chaque trame, au taux d'origine.
  const rmsHalf = Math.round(0.01 * sampleRate);
  let peakRms = 0;
  for (let i = 0; i < frames; i++) {
    const c = i * hop;
    let acc = 0;
    let n = 0;
    for (let j = Math.max(0, c - rmsHalf); j < Math.min(signal.length, c + rmsHalf); j += 2) {
      acc += signal[j] * signal[j];
      n++;
    }
    rms[i] = n ? Math.sqrt(acc / n) : 0;
    if (rms[i] > peakRms) peakRms = rms[i];
  }
  const gate = Math.max(1e-4, peakRms * 0.03); // ~-30 dB sous le passage le plus fort

  for (let i = 0; i < frames; i++) {
    if (rms[i] < gate) continue;
    const start = Math.round((i * hop) / factor) - Math.floor((W + maxTau) / 2);
    if (start < 0 || start + W + maxTau + 1 >= x.length) continue;

    // Fonction de différence d(τ) puis différence moyenne normalisée cumulée (CMNDF).
    d[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= maxTau + 1; tau++) {
      let acc = 0;
      for (let j = 0; j < W; j++) {
        const diff = x[start + j] - x[start + j + tau];
        acc += diff * diff;
      }
      running += acc;
      d[tau] = running > 0 ? (acc * tau) / running : 1;
    }

    // Premier creux sous le seuil absolu, sinon le minimum global.
    let tau = -1;
    for (let t = minTau; t <= maxTau; t++) {
      if (d[t] < threshold) {
        while (t + 1 <= maxTau && d[t + 1] < d[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      let best = minTau;
      for (let t = minTau + 1; t <= maxTau; t++) if (d[t] < d[best]) best = t;
      if (d[best] > 0.35) continue; // trop apériodique : non voisé
      tau = best;
    }

    // Interpolation parabolique autour du creux pour une précision sub-échantillon.
    const a = d[tau - 1];
    const b = d[tau];
    const c = d[tau + 1];
    const denom = a - 2 * b + c;
    const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    f0[i] = sr / (tau + Math.max(-0.5, Math.min(0.5, shift)));
    clarity[i] = 1 - Math.min(1, b);
  }

  cleanPitchTrack(f0);
  return { sampleRate, hop, f0, clarity, rms };
}

/** Lisse les erreurs ponctuelles : médiane glissante (log) et suppression des îlots voisés trop courts. */
function cleanPitchTrack(f0) {
  const n = f0.length;
  const copy = Float32Array.from(f0);
  const win = [];
  for (let i = 0; i < n; i++) {
    if (!copy[i]) continue;
    win.length = 0;
    for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < n && copy[j]) win.push(copy[j]);
    win.sort((p, q) => p - q);
    f0[i] = win[win.length >> 1];
  }
  let i = 0;
  while (i < n) {
    if (!f0[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && f0[j]) j++;
    if (j - i < 4) f0.fill(0, i, j); // < ~23 ms
    i = j;
  }
}
