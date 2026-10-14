// Petites briques de synthèse : générateur pseudo-aléatoire, dent de scie
// anti-repliement (PolyBLEP), suivi de courbes par trame.

/** Générateur pseudo-aléatoire déterministe (mulberry32) : rendus reproductibles. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Correction PolyBLEP : adoucit la discontinuité de la dent de scie (moins d'aliasing). */
export function polyBlep(t, dt) {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** Valeur interpolée d'une courbe par trame à la position `pos` (en échantillons). */
export function curveAt(curve, hop, pos) {
  const f = pos / hop;
  const i = Math.floor(f);
  if (i >= curve.length - 1) return curve[curve.length - 1];
  if (i < 0) return curve[0];
  const t = f - i;
  return curve[i] * (1 - t) + curve[i + 1] * t;
}
