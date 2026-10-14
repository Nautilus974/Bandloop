// Web Worker : encodage FLAC des prises micro, hors du thread de l'interface.
import { encodeFlac, floatToInt } from './flac.js';

self.onmessage = ({ data }) => {
  try {
    const ints = data.channels.map((c) => floatToInt(c, data.bits));
    const bytes = encodeFlac(ints, { sampleRate: data.sampleRate, bitsPerSample: data.bits });
    self.postMessage({ id: data.id, ok: true, bytes }, [bytes.buffer]);
  } catch (err) {
    self.postMessage({ id: data.id, ok: false, error: String(err?.message ?? err) });
  }
};
