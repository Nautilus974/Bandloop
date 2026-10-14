// Calculs purs de l'arrangement : déplacement des clips dans le temps (avec
// magnétisme) et réordonnancement des pistes.

/** Déplace l'élément d'indice `from` à l'indice `to` (nouvelle liste). */
export function reorder(list, from, to) {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const target = Math.max(0, Math.min(out.length - 1, to));
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item);
  return out;
}

/**
 * Points d'accroche pour le début d'un clip : 0, tête de lecture, débuts et fins
 * des autres clips, et graduations de la grille autour de la position visée.
 * @param {{ position: number, otherClips: Array<{start: number, end: number}>, gridStep: number, near: number }} p
 */
export function snapCandidates({ position, otherClips, gridStep, near }) {
  const points = [0, position];
  for (const c of otherClips) points.push(c.start, c.end);
  if (gridStep > 0) {
    const base = Math.floor(near / gridStep) * gridStep;
    points.push(base, base + gridStep);
  }
  return points;
}

/**
 * Aimante un début de clip sur le point le plus proche, s'il est à moins de
 * `threshold` secondes. On teste aussi l'alignement de la FIN du clip (durée).
 * @returns {{ time: number, snappedTo: number|null }}
 */
export function snapStart(start, duration, candidates, threshold) {
  let best = null;
  let bestDist = threshold;
  for (const point of candidates) {
    for (const [value, edgeOffset] of [
      [start, 0],
      [start + duration, duration],
    ]) {
      const d = Math.abs(value - point);
      if (d <= bestDist) {
        bestDist = d;
        best = { time: point - edgeOffset, snappedTo: point };
      }
    }
  }
  if (!best) return { time: Math.max(0, start), snappedTo: null };
  return { time: Math.max(0, best.time), snappedTo: best.snappedTo };
}

/** Indice de piste sous une ordonnée (relative au haut de la première piste). */
export function laneAt(y, laneHeight, count) {
  if (count <= 0) return -1;
  return Math.max(0, Math.min(count - 1, Math.floor(y / laneHeight)));
}
