// Calculs de planification purs (sans Web Audio) pour pouvoir les tester sous Node.

/**
 * Détermine quand et à partir d'où démarrer la lecture d'un clip.
 *
 * @param {object} p
 * @param {number} p.clipStart     Position du clip sur la timeline (s)
 * @param {number} p.clipDuration  Durée du clip (s)
 * @param {number} p.playhead      Position de la tête de lecture au démarrage (s)
 * @param {number} p.when          Instant AudioContext auquel la tête est à `playhead`
 * @returns {{when: number, offset: number} | null}  null si le clip est déjà terminé
 */
export function computeSourceSchedule({ clipStart, clipDuration, playhead, when }) {
  const clipEnd = clipStart + clipDuration;
  if (playhead >= clipEnd) return null;
  if (playhead <= clipStart) {
    // Le clip commence plus tard : on le programme dans le futur, depuis son début.
    return { when: when + (clipStart - playhead), offset: 0 };
  }
  // La tête est au milieu du clip : on démarre tout de suite, décalé dans le buffer.
  return { when, offset: playhead - clipStart };
}

/** Convertit des décibels en gain linéaire. En dessous de MIN_DB on coupe le son. */
export const MIN_DB = -60;
export const MAX_DB = 6;

export function dbToGain(db) {
  if (db <= MIN_DB) return 0;
  return Math.pow(10, db / 20);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
