// Web Worker (classique) : encodage MP3 avec lamejs, hors du thread de l'interface.
// lamejs est chargé comme un script séparé (LGPL : bibliothèque remplaçable).
/* global lamejs */
importScripts('../vendor/lamejs/lame.min.js');

const FRAME = 1152;

self.onmessage = ({ data }) => {
  try {
    const { channels, sampleRate, kbps } = data;
    const n = channels[0].length;
    const encoder = new lamejs.Mp3Encoder(channels.length, sampleRate, kbps);
    // Flottant -> 16 bits avec dither triangulaire (évite la distorsion de quantification).
    let seed = 1234567;
    const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
    const ints = channels.map((ch) => {
      const out = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        const v = Math.round(ch[i] * 32767 + rand() - rand());
        out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
      }
      return out;
    });
    const parts = [];
    let size = 0;
    const step = FRAME * 32;
    for (let i = 0; i < n; i += step) {
      const chunk = ints.map((c) => c.subarray(i, i + step));
      const mp3 = channels.length === 2 ? encoder.encodeBuffer(chunk[0], chunk[1]) : encoder.encodeBuffer(chunk[0]);
      if (mp3.length) {
        parts.push(mp3);
        size += mp3.length;
      }
      self.postMessage({ progress: Math.min(1, (i + step) / n) });
    }
    const tail = encoder.flush();
    if (tail.length) {
      parts.push(tail);
      size += tail.length;
    }
    const bytes = new Uint8Array(size);
    let pos = 0;
    for (const p of parts) {
      bytes.set(p, pos);
      pos += p.length;
    }
    self.postMessage({ done: true, bytes }, [bytes.buffer]);
  } catch (err) {
    self.postMessage({ error: String(err?.message ?? err) });
  }
};
