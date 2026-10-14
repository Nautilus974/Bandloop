// Formatage du temps et graduations de la règle.

/** 83.456 -> "1:23.456" */
export function formatTime(seconds) {
  const s = Math.max(0, seconds);
  const minutes = Math.floor(s / 60);
  const rest = s - minutes * 60;
  return `${minutes}:${rest.toFixed(3).padStart(6, '0')}`;
}

const RULER_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

/** Plus petit pas de graduation (s) laissant au moins `minPx` pixels entre deux repères. */
export function rulerStep(pixelsPerSecond, minPx = 70) {
  return RULER_STEPS.find((step) => step * pixelsPerSecond >= minPx) ?? RULER_STEPS.at(-1);
}

/** Libellé court pour la règle : "0:05", "1:30", "0:02.5". */
export function formatRulerLabel(seconds, step) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  const secs =
    step < 1
      ? rest.toFixed(step < 0.5 ? 2 : 1).padStart(step < 0.5 ? 5 : 4, '0')
      : String(Math.round(rest)).padStart(2, '0');
  return `${minutes}:${secs}`;
}
