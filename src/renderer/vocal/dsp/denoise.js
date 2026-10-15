// Nettoyage de la voix, hors temps réel, à partir de techniques classiques du
// traitement du signal (aucun apprentissage, aucun code tiers) :
//
//   voix ─ passe-haut à phase nulle ─ STFT ─┬ soustraction spectrale (bruit stationnaire)
//                                            └ de-esser (bande 5-10 kHz) ─ ISTFT ─ noise gate ─ voix nettoyée
//
// - Passe-haut : biquad de Butterworth (2e ordre) appliqué dans un sens puis
//   dans l'autre : pente de 24 dB/octave, AUCUN déphasage. La voix nettoyée
//   reste alignée échantillon par échantillon sur l'originale (les marques de
//   hauteur de la correction, calculées sur l'originale, restent valables).
// - Soustraction spectrale (Boll, 1979) avec plancher de gain et lissage
//   temporel et fréquentiel du gain, pour limiter le « bruit musical ».
//   L'empreinte du bruit est le spectre moyen des passages les plus calmes de
//   la prise (mode auto) ou d'une zone choisie à la main.
// - De-esser : quand l'énergie des sifflantes (5-10 kHz) dépasse nettement
//   celle du cœur de la voix (300 Hz-3 kHz), cette bande est atténuée.
// - Noise gate : enveloppe RMS (5 ms), hystérésis, maintien et anticipation de
//   5 ms (possible hors temps réel) pour ne pas couper les attaques.
import { fft } from './fft.js';

const LOG10 = Math.log(10);
const toDb = (power) => (10 * Math.log(Math.max(power, 1e-20))) / LOG10;
const dbToGain = (db) => Math.pow(10, db / 20);

// ------------------------------------------------------------------ passe-haut

/** Coefficients RBJ d'un passe-haut de 2e ordre (Q = 1/√2 : Butterworth). */
function highpassCoefficients(freq, sampleRate) {
  const w0 = (2 * Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / Math.SQRT2;
  const a0 = 1 + alpha;
  return {
    b0: (1 + cos) / 2 / a0,
    b1: -(1 + cos) / a0,
    b2: (1 + cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function biquadPass(x, { b0, b1, b2, a1, a2 }, reverse) {
  const n = x.length;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  // Amorçage sur la première valeur : pas de « marche » au début du signal.
  const first = reverse ? x[n - 1] : x[0];
  x1 = x2 = first;
  y1 = y2 = 0;
  for (let k = 0; k < n; k++) {
    const i = reverse ? n - 1 - k : k;
    const v = x[i];
    const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
}

/**
 * Passe-haut à phase nulle (aller-retour). À `freq`, l'atténuation est de 6 dB.
 * @returns {Float32Array} nouveau signal
 */
export function highpassZeroPhase(signal, sampleRate, freq) {
  const out = Float32Array.from(signal);
  const c = highpassCoefficients(freq, sampleRate);
  biquadPass(out, c, false);
  biquadPass(out, c, true);
  return out;
}

// ------------------------------------------------------------------ STFT

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** Taille de trame : ~46 ms (2048 à 44,1/48 kHz). */
const frameSize = (sampleRate) => (sampleRate > 64000 ? 4096 : 2048);

/** Spectre de puissance (bins 0..N/2) de la trame commençant à `start`. */
function framePower(signal, start, window, re, im, out) {
  const n = window.length;
  for (let i = 0; i < n; i++) {
    const idx = start + i;
    re[i] = idx >= 0 && idx < signal.length ? signal[idx] * window[i] : 0;
    im[i] = 0;
  }
  fft(re, im);
  for (let k = 0; k <= n / 2; k++) out[k] = re[k] * re[k] + im[k] * im[k];
}

/**
 * Empreinte du bruit : spectre de puissance moyen sur les trames choisies.
 * Mode auto : les trames les plus calmes de la prise (10 % du bas, en ignorant
 * le silence numérique). Mode manuel : les trames de la zone [start, end] (s).
 * @returns {{ spectrum: Float64Array, noiseDb: number, seconds: number, uncertain: boolean, source: 'auto'|'manual', zones: Array<[number, number]> } | null}
 *   zones : échantillons [début, fin[ des trames retenues (pour mesurer le bruit restant après nettoyage)
 */
export function estimateNoise(signal, sampleRate, profile = null) {
  const n = frameSize(sampleRate);
  const hop = n / 4;
  const window = hann(n);
  const frames = Math.max(1, Math.ceil(signal.length / hop));
  // Énergie de chaque trame (domaine temporel, rapide).
  const energy = new Float64Array(frames);
  let wsum = 0;
  for (let i = 0; i < n; i++) wsum += window[i] * window[i];
  for (let f = 0; f < frames; f++) {
    const start = f * hop - n / 2;
    let e = 0;
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      if (idx >= 0 && idx < signal.length) e += (signal[idx] * window[i]) ** 2;
    }
    energy[f] = e / wsum; // puissance moyenne par échantillon
  }

  let chosen;
  let uncertain = false;
  if (profile) {
    const from = Math.floor((profile.start * sampleRate) / hop);
    const to = Math.floor((profile.end * sampleRate) / hop);
    chosen = [];
    for (let f = Math.max(0, from); f <= Math.min(frames - 1, to); f++) chosen.push(f);
  } else {
    const audible = [...energy.keys()].filter((f) => energy[f] > 1e-12);
    if (!audible.length) return null;
    const sorted = audible.map((f) => energy[f]).sort((a, b) => a - b);
    const p10 = sorted[Math.floor(sorted.length * 0.1)];
    const median = sorted[Math.floor(sorted.length * 0.5)];
    chosen = audible.filter((f) => energy[f] <= p10 * 1.5);
    // Moins de 8 dB entre les passages calmes et la moitié de la prise : il
    // n'y a sans doute pas de vrai silence, l'empreinte contient de la voix.
    uncertain = toDb(median) - toDb(p10) < 8;
  }
  if (!chosen.length) return null;

  const spectrum = new Float64Array(n / 2 + 1);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const p = new Float64Array(n / 2 + 1);
  let e = 0;
  for (const f of chosen) {
    framePower(signal, f * hop - n / 2, window, re, im, p);
    for (let k = 0; k < p.length; k++) spectrum[k] += p[k];
    e += energy[f];
  }
  for (let k = 0; k < spectrum.length; k++) spectrum[k] /= chosen.length;
  return {
    spectrum,
    noiseDb: toDb(e / chosen.length),
    seconds: (chosen.length * hop) / sampleRate,
    uncertain,
    source: profile ? 'manual' : 'auto',
    zones: chosen.map((f) => [Math.max(0, f * hop - hop / 2), Math.min(signal.length, f * hop + hop / 2)]),
  };
}

/**
 * Soustraction spectrale et de-esser, en une passe STFT (Hann, recouvrement 75 %).
 * @param {{ noise?: { amount: number, spectrum: Float64Array } | null, deesser?: { amount: number } | null }} opts
 *   amount en 0..1
 */
export function spectralClean(signal, sampleRate, { noise = null, deesser = null }) {
  const n = frameSize(sampleRate);
  const hop = n / 4;
  const bins = n / 2 + 1;
  const window = hann(n);
  const out = new Float64Array(signal.length + n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const gain = new Float64Array(bins);
  const prevGain = new Float64Array(bins).fill(1);
  const smooth = new Float64Array(bins);
  const binHz = sampleRate / n;

  // Soustraction : sur-soustraction 1 → 3,5 et plancher −6 → −30 dB selon l'intensité.
  const a = noise?.amount ?? 0;
  const beta = 1 + 2.5 * a;
  const floor = dbToGain(-6 - 24 * a);
  const floor2 = floor * floor;

  // De-esser : bandes de détection et d'action.
  const sib0 = Math.round(5000 / binHz);
  const sib1 = Math.min(bins - 1, Math.round(10000 / binHz));
  const act0 = Math.round(4500 / binHz);
  const voice0 = Math.round(300 / binHz);
  const voice1 = Math.round(3000 / binHz);
  const maxCutDb = 12 * (deesser?.amount ?? 0);
  let sibGain = 1;

  const frames = Math.ceil(signal.length / hop) + 1;
  for (let f = 0; f < frames; f++) {
    const start = f * hop - n / 2;
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      re[i] = idx >= 0 && idx < signal.length ? signal[idx] * window[i] : 0;
      im[i] = 0;
    }
    fft(re, im);

    for (let k = 0; k < bins; k++) gain[k] = 1;
    if (noise) {
      for (let k = 0; k < bins; k++) {
        const p = re[k] * re[k] + im[k] * im[k];
        const g2 = p > 0 ? 1 - (beta * noise.spectrum[k]) / p : 0;
        gain[k] = Math.sqrt(Math.max(floor2, g2));
      }
      // Lissage en fréquence (3 bins) puis en temps (ouverture rapide, fermeture
      // plus lente) : moins de « bruit musical » (gazouillis de bins isolés).
      for (let k = 0; k < bins; k++) {
        const l = gain[Math.max(0, k - 1)];
        const r = gain[Math.min(bins - 1, k + 1)];
        smooth[k] = 0.25 * l + 0.5 * gain[k] + 0.25 * r;
      }
      for (let k = 0; k < bins; k++) {
        const g = smooth[k] > prevGain[k] ? smooth[k] : prevGain[k] + 0.5 * (smooth[k] - prevGain[k]);
        prevGain[k] = g;
        gain[k] = g;
      }
    }

    if (deesser && maxCutDb > 0 && sib1 > sib0) {
      let es = 0;
      let ev = 0;
      for (let k = sib0; k <= sib1; k++) es += (re[k] * re[k] + im[k] * im[k]) * gain[k] * gain[k];
      for (let k = voice0; k <= voice1; k++) ev += (re[k] * re[k] + im[k] * im[k]) * gain[k] * gain[k];
      // Sifflante : bande aiguë à moins de 10 dB du cœur de la voix. Sur une
      // voyelle, elle est d'ordinaire 20 à 30 dB plus faible.
      const excessDb = toDb(es) - toDb(ev);
      const cutDb = Math.min(maxCutDb, Math.max(0, (excessDb + 10) * 0.7));
      const target = dbToGain(-cutDb);
      sibGain = target < sibGain ? target : sibGain + 0.3 * (target - sibGain);
      for (let k = act0; k < bins; k++) {
        // Transition douce sur 500 Hz.
        const t = Math.min(1, (k - act0) / Math.max(1, sib0 - act0));
        gain[k] *= 1 - t * (1 - sibGain);
      }
    }

    // Application du gain (spectre symétrique) puis synthèse.
    for (let k = 0; k < bins; k++) {
      re[k] *= gain[k];
      im[k] *= gain[k];
      if (k > 0 && k < n / 2) {
        re[n - k] *= gain[k];
        im[n - k] *= gain[k];
      }
    }
    fft(re, im, true);
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      if (idx >= 0 && idx < signal.length) out[idx] += re[i] * window[i];
    }
  }
  // Hann² avec recouvrement de 75 % : la somme vaut 1,5.
  const result = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) result[i] = out[i] / 1.5;
  return result;
}

// ------------------------------------------------------------------ noise gate

/**
 * Coupe (−60 dB) ce qui reste sous le seuil : silences entre les phrases.
 * Ouverture au-dessus du seuil, fermeture 4 dB plus bas (hystérésis), maintien
 * 60 ms, anticipation 5 ms, ouverture en 2 ms, fermeture en 80 ms.
 */
export function noiseGate(signal, sampleRate, thresholdDb) {
  const block = Math.max(1, Math.round(0.005 * sampleRate));
  const blocks = Math.ceil(signal.length / block);
  const open = new Uint8Array(blocks);
  const hold = Math.round(0.06 / 0.005);
  let isOpen = false;
  let held = 0;
  for (let b = 0; b < blocks; b++) {
    let e = 0;
    const from = b * block;
    const to = Math.min(signal.length, from + block);
    for (let i = from; i < to; i++) e += signal[i] * signal[i];
    const db = toDb(e / Math.max(1, to - from));
    if (db > thresholdDb) {
      isOpen = true;
      held = hold;
    } else if (db < thresholdDb - 4) {
      if (held > 0) held--;
      else isOpen = false;
    }
    open[b] = isOpen ? 1 : 0;
  }
  const closed = dbToGain(-60);
  const attack = 1 - Math.exp(-1 / (0.002 * sampleRate));
  const release = 1 - Math.exp(-1 / (0.08 * sampleRate));
  const out = new Float32Array(signal.length);
  let g = open[0] ? 1 : closed;
  for (let i = 0; i < signal.length; i++) {
    const b = Math.floor(i / block);
    // Anticipation d'un bloc : la porte est déjà ouverte quand l'attaque arrive.
    const target = open[b] || open[Math.min(blocks - 1, b + 1)] ? 1 : closed;
    g += (target > g ? attack : release) * (target - g);
    out[i] = signal[i] * g;
  }
  return out;
}

// ------------------------------------------------------------------ ensemble

/** Niveau moyen (dBFS) d'un signal sur des zones [début, fin[. */
function zonesDb(signal, zones) {
  let e = 0;
  let n = 0;
  for (const [a, b] of zones) {
    for (let i = a; i < b; i++) e += signal[i] * signal[i];
    n += b - a;
  }
  return toDb(e / Math.max(1, n));
}

/**
 * Nettoie une voix mono selon les réglages (clean.js).
 * @returns {{ signal: Float32Array, info: { noiseDb: number|null, residualDb: number|null, seconds: number, uncertain: boolean, source: string|null } }}
 *   noiseDb : bruit mesuré avant nettoyage ; residualDb : le même passage après
 *   passe-haut et réduction de bruit, juste avant le gate (pour régler son seuil).
 */
export function cleanVoice(mono, sampleRate, clean) {
  let x = mono;
  if (clean.highpass.enabled) x = highpassZeroPhase(x, sampleRate, clean.highpass.freq);
  const info = { noiseDb: null, residualDb: null, seconds: 0, uncertain: false, source: null };
  const reduce = clean.noise.enabled && clean.noise.amount > 0;
  // L'empreinte sert à la réduction de bruit, et au conseil de réglage du gate.
  const profile = reduce || clean.gate.enabled ? estimateNoise(mono, sampleRate, clean.noise.profile) : null;
  if (profile) {
    Object.assign(info, {
      noiseDb: profile.noiseDb,
      seconds: profile.seconds,
      uncertain: profile.uncertain,
      source: profile.source,
    });
  }
  // Spectre du bruit mesuré APRÈS le passe-haut : c'est ce qui reste à enlever.
  const spectrum = reduce && profile ? estimateNoise(x, sampleRate, clean.noise.profile)?.spectrum : null;
  const noise = spectrum ? { amount: clean.noise.amount / 100, spectrum } : null;
  const deesser = clean.deesser.enabled && clean.deesser.amount > 0 ? { amount: clean.deesser.amount / 100 } : null;
  if (noise || deesser) x = spectralClean(x, sampleRate, { noise, deesser });
  if (profile) info.residualDb = zonesDb(x, profile.zones);
  if (clean.gate.enabled) x = noiseGate(x, sampleRate, clean.gate.threshold);
  if (x === mono) x = Float32Array.from(mono);
  return { signal: x, info };
}
