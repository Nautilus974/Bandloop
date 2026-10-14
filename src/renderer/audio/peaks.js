// Pré-calcul de la forme d'onde : min/max par tranche d'échantillons.
// On le fait une seule fois au chargement ; l'affichage ré-agrège selon le zoom.

export const PEAKS_PER_SECOND = 200;

/**
 * @param {Float32Array[]} channels  Données PCM de chaque canal
 * @param {number} bucketSize        Nombre d'échantillons par pic
 * @returns {{min: Float32Array, max: Float32Array}}
 */
export function computePeaks(channels, bucketSize) {
  const length = channels.length ? channels[0].length : 0;
  const count = Math.ceil(length / bucketSize);
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  for (let b = 0; b < count; b++) {
    const from = b * bucketSize;
    const to = Math.min(from + bucketSize, length);
    let lo = 0;
    let hi = 0;
    for (const data of channels) {
      for (let i = from; i < to; i++) {
        const v = data[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { min, max };
}

/** Agrège les pics compris dans [from, to[ (indices de pics). */
export function peakRange(peaks, from, to) {
  const start = Math.max(0, Math.floor(from));
  const end = Math.min(peaks.max.length, Math.max(start + 1, Math.ceil(to)));
  let lo = 0;
  let hi = 0;
  for (let i = start; i < end; i++) {
    if (peaks.min[i] < lo) lo = peaks.min[i];
    if (peaks.max[i] > hi) hi = peaks.max[i];
  }
  return { min: lo, max: hi };
}
