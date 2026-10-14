// Fichiers WAV : écriture (PCM 16 / 24 bits, ou flottant 32 bits) et lecture.

/**
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {{ bitDepth?: 16 | 24 | 32, dither?: boolean }} [opts]  32 = flottant IEEE
 * @returns {Uint8Array}
 */
export function encodeWav(channels, sampleRate, { bitDepth = 24, dither = bitDepth === 16 } = {}) {
  const frames = channels[0].length;
  const nch = channels.length;
  const bytesPerSample = bitDepth / 8;
  const dataSize = frames * nch * bytesPerSample;
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);
  const ascii = (pos, s) => [...s].forEach((c, i) => (out[pos + i] = c.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true); // 3 = flottant, 1 = PCM
  view.setUint16(22, nch, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * nch * bytesPerSample, true);
  view.setUint16(32, nch * bytesPerSample, true);
  view.setUint16(34, bitDepth, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);

  const max = 2 ** (bitDepth - 1);
  let pos = 44;
  // Bruit de dither triangulaire (TPDF) en 16 bits : masque la distorsion de quantification.
  let seed = 22222;
  const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const s = channels[c][i];
      if (bitDepth === 32) {
        view.setFloat32(pos, s, true);
      } else {
        const noise = dither ? rand() - rand() : 0;
        let v = Math.round(s * max + noise);
        v = v >= max ? max - 1 : v < -max ? -max : v;
        if (bitDepth === 16) view.setInt16(pos, v, true);
        else {
          out[pos] = v & 0xff;
          out[pos + 1] = (v >> 8) & 0xff;
          out[pos + 2] = (v >> 16) & 0xff;
        }
      }
      pos += bytesPerSample;
    }
  }
  return out;
}

/** Lit un WAV PCM 16/24 bits ou flottant 32 bits. */
export function parseWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (pos) => String.fromCharCode(...bytes.subarray(pos, pos + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Pas un fichier WAV.');
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= bytes.length) {
    const id = tag(pos);
    const size = view.getUint32(pos + 4, true);
    if (id === 'fmt ') {
      fmt = {
        format: view.getUint16(pos + 8, true),
        channels: view.getUint16(pos + 10, true),
        sampleRate: view.getUint32(pos + 12, true),
        bitDepth: view.getUint16(pos + 22, true),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV sans en-tête de format.');
      const bps = fmt.bitDepth / 8;
      const frames = Math.floor(Math.min(size, bytes.length - pos - 8) / (bps * fmt.channels));
      const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
      let p = pos + 8;
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < fmt.channels; c++) {
          let v;
          if (fmt.format === 3) v = view.getFloat32(p, true);
          else if (fmt.bitDepth === 16) v = view.getInt16(p, true) / 32768;
          else v = (((bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16)) << 8) >> 8) / 8388608;
          channels[c][i] = v;
          p += bps;
        }
      }
      return { ...fmt, channels };
    }
    pos += 8 + size + (size & 1);
  }
  throw new Error('WAV sans données audio.');
}
