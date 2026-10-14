// Limiteur de crête « brickwall » à anticipation, appliqué au mix exporté.
//
// Hors temps réel, on peut regarder l'avenir : le gain nécessaire à chaque
// échantillon (plafond / crête) est d'abord étendu vers l'arrière sur la durée
// d'anticipation (minimum glissant), puis lissé par une moyenne glissante de même
// longueur. Mathématiquement, le gain lissé reste sous le gain nécessaire à chaque
// crête : aucun échantillon ne dépasse le plafond, sans écrêtage brutal. Le gain
// remonte ensuite doucement (relâchement).

/** Crête absolue (tous canaux). */
export function peakOf(channels) {
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  return peak;
}

/**
 * Limite en place les crêtes au-dessus de `ceiling`.
 * @returns {{ reductionDb: number }}  réduction de gain maximale appliquée
 */
export function limitPeaks(
  channels,
  sampleRate,
  { ceiling = Math.pow(10, -1 / 20), lookaheadMs = 5, releaseMs = 80 } = {},
) {
  const n = channels[0].length;
  if (peakOf(channels) <= ceiling) return { reductionDb: 0 };
  const L = Math.max(1, Math.round((lookaheadMs / 1000) * sampleRate));

  // 1. Gain nécessaire par échantillon.
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const ch of channels) p = Math.max(p, Math.abs(ch[i]));
    need[i] = p > ceiling ? ceiling / p : 1;
  }
  // 2. Minimum sur la fenêtre [i, i + L] (file monotone, O(n)), en remontant le temps.
  const minAhead = new Float32Array(n);
  const deque = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (tail > head && need[deque[tail - 1]] >= need[i]) tail--;
    deque[tail++] = i;
    while (deque[head] > i + L) head++;
    minAhead[i] = need[deque[head]];
  }
  // 3. Moyenne glissante sur [i - L + 1, i] (avant le début : on prolonge le
  //    premier gain), puis relâchement progressif quand le gain remonte.
  const release = 1 - Math.exp(-1 / ((releaseMs / 1000) * sampleRate));
  let sum = 0;
  let g = 1;
  let minGain = 1;
  for (let i = 0; i < n; i++) {
    sum += minAhead[i];
    if (i >= L) sum -= minAhead[i - L];
    const smooth = (sum + Math.max(0, L - 1 - i) * minAhead[0]) / L;
    g = smooth < g ? smooth : g + (smooth - g) * release;
    minGain = Math.min(minGain, g);
    for (const ch of channels) {
      const v = ch[i] * g;
      // Garde-fou contre les arrondis flottants.
      ch[i] = v > ceiling ? ceiling : v < -ceiling ? -ceiling : v;
    }
  }
  return { reductionDb: 20 * Math.log10(minGain) };
}
