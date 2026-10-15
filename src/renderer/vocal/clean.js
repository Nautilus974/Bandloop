// Réglages du NETTOYAGE de la voix d'une piste (réduction de bruit, passe-haut,
// noise gate, de-esser).
//
// Le nettoyage dépend de la prise (le bruit de CE micro dans CETTE pièce), pas
// d'un style de voix : il est réglé par piste et ne fait pas partie des presets
// vocaux. Il est appliqué AVANT l'étage de hauteur (correction, harmonies…).
import { normalizeValue } from './settings.js';

export const CLEAN_PARAMS = {
  noise: [
    { key: 'enabled', label: 'Bruit de fond', type: 'bool', default: true },
    { key: 'amount', label: 'Intensité', type: 'number', min: 0, max: 100, step: 1, default: 50, unit: '%' },
  ],
  highpass: [
    { key: 'enabled', label: 'Passe-haut', type: 'bool', default: true },
    {
      key: 'freq',
      label: 'Fréquence',
      type: 'number',
      min: 20,
      max: 300,
      step: 1,
      default: 80,
      unit: 'Hz',
      scale: 'log',
    },
  ],
  gate: [
    { key: 'enabled', label: 'Noise gate', type: 'bool', default: false },
    { key: 'threshold', label: 'Seuil', type: 'number', min: -80, max: -20, step: 1, default: -50, unit: 'dB' },
  ],
  deesser: [
    { key: 'enabled', label: 'De-esser', type: 'bool', default: false },
    { key: 'amount', label: 'Intensité', type: 'number', min: 0, max: 100, step: 1, default: 40, unit: '%' },
  ],
};

/** Durée minimale d'une empreinte de bruit choisie à la main (secondes). */
export const MIN_PROFILE_SECONDS = 0.15;

const params = (list, raw = {}) => Object.fromEntries(list.map((p) => [p.key, normalizeValue(p, raw?.[p.key])]));

/**
 * Empreinte du bruit : null = automatique (silences détectés dans la prise),
 * ou { start, end } en secondes DANS L'AUDIO de la piste (pas sur la timeline).
 */
function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const start = Number(raw.start);
  const end = Number(raw.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < MIN_PROFILE_SECONDS) return null;
  return { start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 };
}

export function normalizeClean(raw = {}) {
  raw = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: raw.enabled === true,
    noise: { ...params(CLEAN_PARAMS.noise, raw.noise), profile: normalizeProfile(raw.noise?.profile) },
    highpass: params(CLEAN_PARAMS.highpass, raw.highpass),
    gate: params(CLEAN_PARAMS.gate, raw.gate),
    deesser: params(CLEAN_PARAMS.deesser, raw.deesser),
  };
}

export const defaultClean = () => normalizeClean({});

/** Le nettoyage modifie-t-il le son ? */
export function cleanActive(c) {
  return (
    !!c?.enabled &&
    ((c.noise.enabled && c.noise.amount > 0) ||
      c.highpass.enabled ||
      c.gate.enabled ||
      (c.deesser.enabled && c.deesser.amount > 0))
  );
}

/** Empreinte de ce qui demande un nouveau calcul. */
export function cleanSignature(c) {
  return cleanActive(c) ? JSON.stringify(c) : 'off';
}
