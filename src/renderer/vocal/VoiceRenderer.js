// Moteur de rendu de l'étage de hauteur, sans dépendance au DOM : utilisé tel
// quel dans le Web Worker (voice-worker.js) ou, à défaut, sur le thread principal.
// Garde en cache, par piste, la voix mono, son analyse de hauteur et ses marques
// PSOLA : seuls les réglages changent d'un rendu à l'autre.
import { analyzePitch } from './dsp/pitch.js';
import { findPitchMarks } from './dsp/psola.js';
import { renderVoice } from './dsp/render.js';

export class VoiceRenderer {
  constructor() {
    this.tracks = new Map();
  }

  load(trackId, mono, sampleRate) {
    this.tracks.set(trackId, { mono, sampleRate, analysis: null, marks: null });
  }

  unload(trackId) {
    this.tracks.delete(trackId);
  }

  /** Analyse de hauteur (mise en cache) : la partie la plus coûteuse, faite une fois par piste. */
  analyze(trackId) {
    const entry = this.tracks.get(trackId);
    if (!entry) throw new Error(`Piste ${trackId} inconnue du moteur vocal`);
    if (!entry.analysis) {
      entry.analysis = analyzePitch(entry.mono, entry.sampleRate);
      entry.marks = findPitchMarks(entry.mono, entry.analysis);
    }
    return entry;
  }

  render(trackId, settings, tonality) {
    const entry = this.analyze(trackId);
    return renderVoice(entry.mono, entry.analysis, settings, tonality, entry.marks);
  }
}
