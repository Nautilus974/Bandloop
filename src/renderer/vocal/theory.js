// Théorie musicale minimale : notes, tonalités, gammes, intervalles.
// Les hauteurs sont exprimées en numéros MIDI (69 = La 440 Hz), éventuellement fractionnaires.

export const NOTE_NAMES = ['Do', 'Do♯', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Fa♯', 'Sol', 'La♭', 'La', 'Si♭', 'Si'];

/** Gammes : intervalles en demi-tons depuis la tonique. */
export const SCALES = {
  major: { label: 'Majeur', steps: [0, 2, 4, 5, 7, 9, 11] },
  minor: { label: 'Mineur naturel', steps: [0, 2, 3, 5, 7, 8, 10] },
  harmonicMinor: { label: 'Mineur harmonique', steps: [0, 2, 3, 5, 7, 8, 11] },
  dorian: { label: 'Dorien', steps: [0, 2, 3, 5, 7, 9, 10] },
  majorPentatonic: { label: 'Pentatonique majeure', steps: [0, 2, 4, 7, 9] },
  minorPentatonic: { label: 'Pentatonique mineure', steps: [0, 3, 5, 7, 10] },
  blues: { label: 'Blues', steps: [0, 3, 5, 6, 7, 10] },
  chromatic: { label: 'Chromatique', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
};

export const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
export const midiToHz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
export const semitonesToRatio = (st) => Math.pow(2, st / 12);

const mod12 = (n) => ((n % 12) + 12) % 12;

/** La classe de hauteur `note` appartient-elle à la gamme ? */
export function inScale(note, key, scale) {
  return SCALES[scale].steps.includes(mod12(Math.round(note) - key));
}

/**
 * Note de la gamme la plus proche d'une hauteur (fractionnaire).
 * @param {number} midi
 * @param {number} key    Tonique, 0 = Do … 11 = Si
 * @param {string} scale  Clé de SCALES
 */
export function nearestScaleNote(midi, key, scale) {
  let best = Math.round(midi);
  let bestDist = Infinity;
  for (let n = Math.floor(midi) - 3; n <= Math.ceil(midi) + 3; n++) {
    if (!inScale(n, key, scale)) continue;
    const d = Math.abs(n - midi);
    if (d < bestDist) {
      bestDist = d;
      best = n;
    }
  }
  return best;
}

/**
 * Déplace une note de `degrees` degrés dans la gamme (ex. +2 = tierce au-dessus,
 * majeure ou mineure selon la note). La note est d'abord ramenée dans la gamme.
 */
export function diatonicShift(note, degrees, key, scale) {
  const steps = SCALES[scale].steps;
  const base = nearestScaleNote(note, key, scale);
  const rel = base - key;
  const octave = Math.floor(rel / 12);
  const index = steps.indexOf(mod12(rel));
  const target = index + degrees;
  const wrapOctave = Math.floor(target / steps.length);
  const targetIndex = ((target % steps.length) + steps.length) % steps.length;
  return key + (octave + wrapOctave) * 12 + steps[targetIndex];
}

/** Libellés des intervalles diatoniques (en degrés) pour l'interface. */
export const DIATONIC_INTERVALS = [
  [-7, 'Octave ↓'],
  [-5, 'Sixte ↓'],
  [-4, 'Quinte ↓'],
  [-3, 'Quarte ↓'],
  [-2, 'Tierce ↓'],
  [-1, 'Seconde ↓'],
  [0, 'Unisson'],
  [1, 'Seconde ↑'],
  [2, 'Tierce ↑'],
  [3, 'Quarte ↑'],
  [4, 'Quinte ↑'],
  [5, 'Sixte ↑'],
  [6, 'Septième ↑'],
  [7, 'Octave ↑'],
];
