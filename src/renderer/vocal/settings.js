// Schéma des réglages vocaux d'une piste, valeurs par défaut et validation.
//
// Deux étages :
//  - l'étage de HAUTEUR (pitch, voice, harmony, vocoder, drone) est rendu hors
//    temps réel dans un Worker, à partir de l'analyse de hauteur de la piste ;
//  - la CHAÎNE (chain) est une liste ordonnée d'effets temps réel Web Audio.
// La tonalité (key, scale) est réglée au niveau du morceau et n'est pas incluse
// dans les presets.
import { clamp } from '../audio/scheduling.js';
import { FX_CATALOG } from './fx/catalog.js';
import { SCALES } from './theory.js';

export const DEFAULT_TONALITY = { key: 0, scale: 'major' };

export const PITCH_PARAMS = [
  { key: 'correct', label: 'Correction', type: 'bool', default: false },
  { key: 'speed', label: 'Vitesse de calage', type: 'number', min: 0, max: 400, step: 1, default: 60, unit: 'ms' },
  { key: 'strength', label: 'Intensité', type: 'number', min: 0, max: 100, step: 1, default: 100, unit: '%' },
  { key: 'shift', label: 'Transposition', type: 'number', min: -24, max: 24, step: 1, default: 0, unit: 'dt' },
  { key: 'formant', label: 'Formants', type: 'number', min: -12, max: 12, step: 0.5, default: 0, unit: 'dt' },
];

export const VOICE_PARAMS = [
  { key: 'level', label: 'Voix principale', type: 'number', min: -60, max: 6, step: 0.5, default: 0, unit: 'dB' },
];

export const HARMONY_VOICE_PARAMS = [
  { key: 'interval', label: 'Intervalle', type: 'number', min: -24, max: 24, step: 1, default: 2 },
  { key: 'level', label: 'Niveau', type: 'number', min: -40, max: 6, step: 0.5, default: -6, unit: 'dB' },
  { key: 'pan', label: 'Pan', type: 'number', min: -100, max: 100, step: 1, default: 0, unit: '' },
  { key: 'detune', label: 'Désaccord', type: 'number', min: -50, max: 50, step: 1, default: 0, unit: 'ct' },
  { key: 'delay', label: 'Décalage', type: 'number', min: 0, max: 80, step: 1, default: 0, unit: 'ms' },
];
export const MAX_HARMONY_VOICES = 4;

export const VOCODER_CHORDS = {
  unison: { label: 'Unisson', notes: [0] },
  octave: { label: 'Octaves', notes: [-12, 0] },
  fifth: { label: 'Quinte', notes: [0, 7] },
  power: { label: 'Accord puissant', notes: [-12, 0, 7] },
  triad: { label: 'Accord (dans la gamme)', notes: [0, 'third', 'fifth'] },
};

export const VOCODER_PARAMS = [
  { key: 'enabled', label: 'Vocodeur', type: 'bool', default: false },
  { key: 'mix', label: 'Dosage', type: 'number', min: 0, max: 100, step: 1, default: 70, unit: '%' },
  { key: 'bands', label: 'Bandes', type: 'number', min: 8, max: 40, step: 1, default: 20 },
  {
    key: 'chord',
    label: 'Porteuse',
    type: 'choice',
    default: 'unison',
    options: Object.entries(VOCODER_CHORDS).map(([k, v]) => [k, v.label]),
  },
  { key: 'noise', label: 'Souffle', type: 'number', min: 0, max: 100, step: 1, default: 35, unit: '%' },
];

export const DRONE_CHORDS = {
  root: { label: 'Tonique', notes: [0] },
  fifth: { label: 'Tonique + quinte', notes: [0, 7] },
  open: { label: 'Quinte + octave', notes: [0, 7, 12] },
  minor: { label: 'Accord mineur', notes: [0, 3, 7] },
  major: { label: 'Accord majeur', notes: [0, 4, 7] },
};

export const DRONE_PARAMS = [
  { key: 'enabled', label: 'Bourdon', type: 'bool', default: false },
  { key: 'level', label: 'Niveau', type: 'number', min: -40, max: 0, step: 0.5, default: -14, unit: 'dB' },
  {
    key: 'chord',
    label: 'Notes',
    type: 'choice',
    default: 'fifth',
    options: Object.entries(DRONE_CHORDS).map(([k, v]) => [k, v.label]),
  },
  { key: 'octave', label: 'Octave', type: 'number', min: -2, max: 1, step: 1, default: -1 },
  { key: 'attack', label: 'Attaque', type: 'number', min: 0.05, max: 6, step: 0.05, default: 1.2, unit: 's' },
  { key: 'release', label: 'Tenue', type: 'number', min: 0.2, max: 12, step: 0.1, default: 4, unit: 's' },
  { key: 'brightness', label: 'Brillance', type: 'number', min: 200, max: 6000, step: 10, default: 1400, unit: 'Hz' },
];

/** Valeurs par défaut d'une liste de descripteurs. */
export function defaults(params) {
  return Object.fromEntries(params.map((p) => [p.key, p.default]));
}

/** Valide une valeur selon son descripteur (bornes, arrondi, options). */
export function normalizeValue(param, value) {
  if (param.type === 'bool') return typeof value === 'boolean' ? value : param.default;
  if (param.type === 'choice') return param.options.some(([v]) => v === value) ? value : param.default;
  const n = Number(value);
  if (!Number.isFinite(n)) return param.default;
  const stepped = Math.round(n / param.step) * param.step;
  return clamp(Number(stepped.toFixed(6)), param.min, param.max);
}

export function normalizeParams(params, raw = {}) {
  return Object.fromEntries(params.map((p) => [p.key, normalizeValue(p, raw?.[p.key])]));
}

let moduleCounter = 0;
export const newModuleId = () => `m${Date.now().toString(36)}${(moduleCounter++).toString(36)}`;

/** Crée un module d'effet temps réel avec ses réglages par défaut (et des surcharges). */
export function createModule(type, params = {}, enabled = true) {
  return { id: newModuleId(), type, enabled, params: normalizeParams(FX_CATALOG[type].params, params) };
}

export function defaultSettings() {
  return normalizeSettings({});
}

/**
 * Complète et borne des réglages arbitraires (preset, fichier, interface).
 * Les types d'effets inconnus sont ignorés, l'ordre de la chaîne est conservé.
 */
export function normalizeSettings(raw = {}) {
  const harmony = raw.harmony ?? {};
  return {
    pitch: normalizeParams(PITCH_PARAMS, raw.pitch),
    voice: normalizeParams(VOICE_PARAMS, raw.voice),
    harmony: {
      enabled: harmony.enabled === true,
      mode: harmony.mode === 'chromatic' ? 'chromatic' : 'diatonic',
      voices: (Array.isArray(harmony.voices) ? harmony.voices : [])
        .slice(0, MAX_HARMONY_VOICES)
        .map((v) => normalizeParams(HARMONY_VOICE_PARAMS, v)),
    },
    vocoder: normalizeParams(VOCODER_PARAMS, raw.vocoder),
    drone: normalizeParams(DRONE_PARAMS, raw.drone),
    chain: (Array.isArray(raw.chain) ? raw.chain : [])
      .filter((m) => m && FX_CATALOG[m.type])
      .map((m) => ({
        id: typeof m.id === 'string' ? m.id : newModuleId(),
        type: m.type,
        enabled: m.enabled !== false,
        params: normalizeParams(FX_CATALOG[m.type].params, m.params),
      })),
  };
}

export function normalizeTonality(raw = {}) {
  const key = Number.isInteger(raw.key) && raw.key >= 0 && raw.key < 12 ? raw.key : DEFAULT_TONALITY.key;
  const scale = SCALES[raw.scale] ? raw.scale : DEFAULT_TONALITY.scale;
  return { key, scale };
}

/** L'étage de hauteur modifie-t-il le son ? Sinon on lit l'audio d'origine. */
export function pitchStageActive(s) {
  return (
    s.pitch.correct ||
    s.pitch.shift !== 0 ||
    s.pitch.formant !== 0 ||
    s.voice.level !== 0 ||
    (s.harmony.enabled && s.harmony.voices.length > 0) ||
    s.vocoder.enabled ||
    s.drone.enabled
  );
}

/** Empreinte de tout ce qui nécessite un nouveau rendu hors temps réel. */
export function pitchStageSignature(s, tonality) {
  if (!pitchStageActive(s)) return 'off';
  return JSON.stringify([s.pitch, s.voice, s.harmony, s.vocoder, s.drone, tonality]);
}

/** Réglages sans le moindre effet ? */
export function isNeutral(s) {
  return !pitchStageActive(s) && !s.chain.some((m) => m.enabled);
}

/** Comparaison de réglages en ignorant les identifiants internes des modules. */
export function sameSettings(a, b) {
  const strip = (s) => ({ ...s, chain: s.chain.map(({ type, enabled, params }) => ({ type, enabled, params })) });
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}
