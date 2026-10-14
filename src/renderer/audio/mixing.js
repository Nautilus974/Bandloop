// Règles de mixage pures (testables sans Web Audio).
import { dbToGain } from './scheduling.js';

/**
 * Gain effectif d'une piste en tenant compte du mute et du solo.
 * Dès qu'au moins une piste est en solo, seules les pistes en solo sont audibles.
 * Le mute l'emporte sur le solo (comme dans la plupart des DAW).
 */
export function effectiveGain({ volumeDb, muted, solo }, anySolo) {
  if (muted) return 0;
  if (anySolo && !solo) return 0;
  return dbToGain(volumeDb);
}

/** -1..1 -> "G 40" / "C" / "D 25" */
export function formatPan(pan) {
  const v = Math.round(pan * 100);
  if (v === 0) return 'C';
  return v < 0 ? `G ${-v}` : `D ${v}`;
}

/** Niveau crête (0..1) -> position de VU-mètre (0..1) sur une échelle de -48 à 0 dBFS. */
export function meterLevel(peak, floorDb = -48) {
  if (peak <= 0) return 0;
  const db = 20 * Math.log10(peak);
  return Math.min(1, Math.max(0, 1 - db / floorDb));
}
