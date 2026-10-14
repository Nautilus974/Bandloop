// Web Worker : rendu de l'étage de hauteur hors du thread de l'interface.
// Messages reçus : { type: 'load' | 'unload' | 'render', ... } ; réponses : { id, ok, left, right | error }.
import { VoiceRenderer } from './VoiceRenderer.js';

const renderer = new VoiceRenderer();

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'load') {
      renderer.load(data.trackId, data.mono, data.sampleRate);
    } else if (data.type === 'unload') {
      renderer.unload(data.trackId);
    } else if (data.type === 'render') {
      self.postMessage({ id: data.id, phase: 'analyzing' });
      renderer.analyze(data.trackId);
      self.postMessage({ id: data.id, phase: 'rendering' });
      const { left, right } = renderer.render(data.trackId, data.settings, data.tonality);
      self.postMessage({ id: data.id, ok: true, left, right }, [left.buffer, right.buffer]);
    }
  } catch (err) {
    self.postMessage({ id: data.id, ok: false, error: String(err?.message ?? err) });
  }
};
