// Moteur de rendu de l'étage de hauteur, sans dépendance au DOM : utilisé tel
// quel dans le Web Worker (voice-worker.js) ou, à défaut, sur le thread principal.
// Garde en cache, par piste, la voix mono, son analyse de hauteur et ses marques
// PSOLA : seuls les réglages changent d'un rendu à l'autre.
import { cleanActive } from './clean.js';
import { cleanVoice } from './dsp/denoise.js';
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

  /**
   * Nettoyage (s'il est actif) PUIS étage de hauteur sur la voix nettoyée.
   * L'analyse de hauteur et les marques PSOLA restent celles de la voix
   * d'origine : le nettoyage est à phase nulle, la voix nettoyée y reste alignée
   * échantillon par échantillon, et on évite de refaire l'analyse (la partie
   * la plus longue) à chaque réglage de nettoyage.
   */
  render(trackId, settings, tonality, clean = null) {
    const entry = this.analyze(trackId);
    let source = entry.mono;
    let cleanInfo = null;
    if (clean && cleanActive(clean)) {
      const signature = JSON.stringify(clean);
      if (entry.cleanSignature !== signature) {
        const result = cleanVoice(entry.mono, entry.sampleRate, clean);
        Object.assign(entry, { cleanSignature: signature, cleaned: result.signal, cleanInfo: result.info });
      }
      source = entry.cleaned;
      cleanInfo = entry.cleanInfo;
    }
    return { ...renderVoice(source, entry.analysis, settings, tonality, entry.marks), cleanInfo };
  }
}
