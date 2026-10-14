// Calculs purs pour les effets temps réel (testables sans Web Audio) :
// réponse impulsionnelle de réverbération, courbes de distorsion, quantification.
// Aussi importé par l'AudioWorklet de bitcrush : pas de dépendance au DOM ici.

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Réponse impulsionnelle stéréo synthétique pour le ConvolverNode.
 * Bruit blanc à décroissance exponentielle (-60 dB à `decay`), filtré par un
 * passe-bas dont la coupure baisse au fil de la queue (les aigus s'éteignent
 * plus vite, comme dans une vraie salle), précédé de quelques réflexions précoces.
 * Canaux gauche/droite décorrélés pour la largeur stéréo.
 * @returns {[Float32Array, Float32Array]}
 */
export function generateImpulse(sampleRate, { decay = 2, brightness = 7000, seed = 1 } = {}) {
  const length = Math.max(1, Math.round(Math.min(decay * 1.1, 14) * sampleRate));
  const channels = [new Float32Array(length), new Float32Array(length)];
  channels.forEach((data, ch) => {
    const random = rng(seed * 2 + ch);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const progress = i / length;
      const cutoff = brightness * (1 - 0.75 * progress);
      const coef = 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
      lp += coef * (random() * 2 - 1 - lp);
      const envelope = Math.exp((-6.91 * t) / decay); // -60 dB à t = decay
      const fadeIn = Math.min(1, t / 0.002);
      data[i] = lp * envelope * fadeIn;
    }
    // Réflexions précoces (premiers ~60 ms).
    for (let r = 0; r < 6; r++) {
      const at = Math.round((0.007 + random() * 0.055) * sampleRate);
      if (at < length) data[at] += (random() < 0.5 ? -1 : 1) * (0.5 - r * 0.06);
    }
  });
  return channels;
}

/**
 * Courbe de transfert pour le WaveShaperNode.
 * - soft : tangente hyperbolique (saturation à lampe, harmoniques impairs doux) ;
 * - hard : écrêtage net (fuzz) ;
 * - amp  : asymétrique (alternances positives/négatives traitées différemment,
 *          d'où des harmoniques pairs, typiques d'un étage d'ampli).
 * @param {number} drive  0..100
 */
export function makeDistortionCurve(character, drive, size = 2048) {
  const curve = new Float32Array(size);
  const k = 1 + (drive / 100) * 30;
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    if (character === 'hard') {
      curve[i] = Math.max(-1, Math.min(1, x * (1 + (drive / 100) * 12))) * 0.9;
    } else if (character === 'amp') {
      curve[i] = x >= 0 ? Math.tanh(k * x) / Math.tanh(k) : (0.8 * Math.tanh(k * 0.6 * x)) / Math.tanh(k * 0.6);
    } else {
      curve[i] = Math.tanh(k * x) / Math.tanh(k);
    }
  }
  return curve;
}

/** Quantifie un échantillon sur `bits` bits (bitcrush). */
export function quantize(x, bits) {
  const levels = Math.pow(2, bits - 1);
  return Math.max(-1, Math.min(1, Math.round(x * levels) / levels));
}

/** Courbe de quantification pour WaveShaper (repli si l'AudioWorklet est indisponible). */
export function makeQuantizeCurve(bits, size = 4096) {
  return Float32Array.from({ length: size }, (_, i) => quantize((i / (size - 1)) * 2 - 1, bits));
}

/** Fondu à puissance constante : [gain sec, gain traité] pour un dosage 0..100. */
export function mixGains(mixPercent) {
  const m = Math.max(0, Math.min(1, mixPercent / 100));
  return [Math.cos((m * Math.PI) / 2), Math.sin((m * Math.PI) / 2)];
}
