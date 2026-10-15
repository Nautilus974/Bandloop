// Rendu hors temps réel de l'étage de hauteur d'une piste vocale.
//
//   voix mono ─┬─ PSOLA (courbe de correction + transposition + formants) ─ voix principale ─┐
//              ├─ PSOLA par voix d'harmonie × enveloppe de voisement → retard → panoramique ─┤
//              ├─ vocodeur (porteuse qui suit la mélodie corrigée) ─ fondu avec la voix ─────┤→ stéréo
//              └─ bourdon (accord tenu sur la tonique) ──────────────────────────────────────┘
import { dbToGain } from '../../audio/scheduling.js';
import { DRONE_CHORDS, VOCODER_CHORDS } from '../settings.js';
import { diatonicShift, nearestScaleNote, semitonesToRatio } from '../theory.js';
import { buildHarmonyRatio, buildLeadCurve, voicingEnvelope } from './correction.js';
import { synthDrone } from './drone.js';
import { findPitchMarks, psola } from './psola.js';
import { curveAt } from './synth.js';
import { synthCarrier, vocode } from './vocoder.js';

/** Panoramique à puissance constante, normalisé pour valoir 1/1 au centre. */
function panGains(pan) {
  const angle = ((pan + 1) * Math.PI) / 4;
  return [Math.cos(angle) * Math.SQRT2, Math.sin(angle) * Math.SQRT2];
}

function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i += 4) s += x[i] * x[i];
  return Math.sqrt(s / Math.ceil(x.length / 4));
}

/** Décalages de la porteuse du vocodeur ; « third »/« fifth » suivent la gamme. */
function carrierOffsets(chord, { key, scale }) {
  return VOCODER_CHORDS[chord].notes.map((n) => {
    if (typeof n === 'number') return n;
    const degrees = n === 'third' ? 2 : 4;
    return (midi) => {
      const note = nearestScaleNote(midi, key, scale);
      return diatonicShift(note, degrees, key, scale) - note;
    };
  });
}

/**
 * @param {Float32Array} mono       Voix (mono)
 * @param {object} analysis         Résultat d'analyzePitch
 * @param {object} settings         Réglages normalisés (settings.js)
 * @param {{key: number, scale: string}} tonality
 * @param {object} [pitchMarks]     Marques PSOLA pré-calculées (réutilisées entre rendus)
 * @returns {{ left: Float32Array, right: Float32Array, curves: { hop: number, inMidi: Float32Array, noteMidi: Float32Array, outMidi: Float32Array } }}
 *   curves : hauteur chantée, note visée et hauteur corrigée par trame de `hop` échantillons (affichage)
 */
export function renderVoice(mono, analysis, settings, tonality, pitchMarks = findPitchMarks(mono, analysis)) {
  const n = mono.length;
  const { pitch, voice, harmony, vocoder, drone } = settings;
  const { sampleRate, hop } = analysis;
  const formant = semitonesToRatio(pitch.formant);
  const left = new Float32Array(n);
  const right = new Float32Array(n);

  const lead = buildLeadCurve(analysis, {
    correct: pitch.correct,
    key: tonality.key,
    scale: tonality.scale,
    speed: pitch.speed,
    strength: pitch.strength / 100,
    shift: pitch.shift,
    keepVibrato: pitch.keepVibrato,
  });

  // 1. Voix principale.
  const needsPsola = pitch.correct || pitch.shift !== 0 || pitch.formant !== 0;
  let main = needsPsola ? psola(mono, analysis, lead.leadRatio, { formant, pitchMarks }) : Float32Array.from(mono);

  // 2. Vocodeur, en fondu avec la voix principale.
  if (vocoder.enabled) {
    const voicing = voicingEnvelope(analysis);
    const carrier = synthCarrier(
      n,
      sampleRate,
      hop,
      lead.outMidi,
      voicing,
      carrierOffsets(vocoder.chord, tonality),
      vocoder.noise / 100,
    );
    const voc = vocode(mono, carrier, sampleRate, vocoder.bands);
    const match = rms(main) / (rms(voc) || 1); // même niveau perçu que la voix
    const wet = vocoder.mix / 100;
    for (let i = 0; i < n; i++) main[i] = main[i] * (1 - wet) + voc[i] * match * wet;
  }

  const mainGain = dbToGain(voice.level);
  for (let i = 0; i < n; i++) {
    left[i] = main[i] * mainGain;
    right[i] = left[i];
  }
  main = null;

  // 3. Harmonies : une transposition PSOLA par voix, coupée sur les non-voisés.
  if (harmony.enabled && harmony.voices.length) {
    const voicing = voicingEnvelope(analysis);
    for (const v of harmony.voices) {
      const ratio = buildHarmonyRatio(lead, { interval: v.interval, detune: v.detune, mode: harmony.mode }, tonality);
      const h = psola(mono, analysis, ratio, { formant, pitchMarks });
      const [gl, gr] = panGains(v.pan / 100);
      const g = dbToGain(v.level + harmony.level);
      const delay = Math.round((v.delay / 1000) * sampleRate);
      for (let i = 0; i + delay < n; i++) {
        const s = h[i] * g * curveAt(voicing, hop, i);
        left[i + delay] += s * gl;
        right[i + delay] += s * gr;
      }
    }
  }

  // 4. Bourdon.
  if (drone.enabled) {
    const d = synthDrone(analysis, n, {
      key: tonality.key,
      notes: DRONE_CHORDS[drone.chord].notes,
      octave: drone.octave,
      attack: drone.attack,
      release: drone.release,
      brightness: drone.brightness,
    });
    const g = dbToGain(drone.level);
    for (let i = 0; i < n; i++) {
      left[i] += d.left[i] * g;
      right[i] += d.right[i] * g;
    }
  }

  return { left, right, curves: { hop, inMidi: lead.inMidi, noteMidi: lead.noteMidi, outMidi: lead.outMidi } };
}
