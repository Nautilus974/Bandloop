// Signaux de test synthétiques.
export const SR = 44100;

/** Onde « vocale » simple : dents de scie filtrée (riche en harmoniques comme une voix). */
export function voiceLike(hzAt, seconds, sampleRate = SR) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  let phase = 0;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const hz = typeof hzAt === 'function' ? hzAt(i / sampleRate) : hzAt;
    phase += hz / sampleRate;
    phase -= Math.floor(phase);
    const saw = 2 * phase - 1;
    lp += 0.25 * (saw - lp);
    out[i] = 0.5 * lp;
  }
  return out;
}

export function sine(hz, seconds, sampleRate = SR, amp = 0.5) {
  const n = Math.round(seconds * sampleRate);
  return Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sampleRate));
}

/** Médiane des f0 voisés d'une analyse. */
export function medianF0(analysis, from = 0, to = 1) {
  const n = analysis.f0.length;
  const vals = [...analysis.f0.slice(Math.floor(n * from), Math.floor(n * to))]
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  return vals.length ? vals[vals.length >> 1] : 0;
}
