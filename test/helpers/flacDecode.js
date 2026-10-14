// Décodeur FLAC de test, écrit indépendamment de l'encodeur (sous-ensemble :
// STREAMINFO, sous-trames constante / brute / fixe, résidu Rice et Rice2).
import { crc16, crc8 } from '../../src/renderer/project/flac.js';

class BitReader {
  constructor(bytes) {
    this.b = bytes;
    this.pos = 0; // en bits
  }
  read(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const bit = (this.b[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
      v = v * 2 + bit;
      this.pos++;
    }
    return v;
  }
  signed(n) {
    const v = this.read(n);
    return v >= 2 ** (n - 1) ? v - 2 ** n : v;
  }
  unary() {
    let q = 0;
    while (this.read(1) === 0) q++;
    return q;
  }
  align() {
    this.pos = (this.pos + 7) & ~7;
  }
}

export function decodeFlac(bytes) {
  const r = new BitReader(bytes);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'fLaC') throw new Error('signature');
  r.pos = 32;
  let info = null;
  for (let last = 0; !last; ) {
    last = r.read(1);
    const type = r.read(7);
    const len = r.read(24);
    const start = r.pos;
    if (type === 0) {
      r.read(16);
      r.read(16);
      r.read(24);
      r.read(24);
      info = { sampleRate: r.read(20), channels: r.read(3) + 1, bps: r.read(5) + 1, total: r.read(36) };
    }
    r.pos = start + len * 8;
  }
  const out = Array.from({ length: info.channels }, () => new Int32Array(info.total));
  let done = 0;
  while (done < info.total) {
    const frameStart = r.pos >> 3;
    if (r.read(14) !== 0b11111111111110) throw new Error('synchro');
    r.read(2);
    const bsCode = r.read(4);
    r.read(4);
    const chanCode = r.read(4);
    r.read(4);
    // numéro de trame UTF-8
    let first = r.read(8);
    let extra = 0;
    while (first & (0x80 >> extra)) extra++;
    for (let i = 1; i < extra; i++) r.read(8);
    if (bsCode !== 0b0111) throw new Error('taille de bloc');
    const size = r.read(16) + 1;
    const headerCrc = r.read(8);
    if (crc8(bytes.subarray(frameStart, (r.pos >> 3) - 1)) !== headerCrc) throw new Error('crc8');
    if (chanCode !== info.channels - 1) throw new Error('canaux');
    for (let c = 0; c < info.channels; c++) {
      r.read(1);
      const type = r.read(6);
      r.read(1);
      const dst = out[c].subarray(done, done + size);
      if (type === 0) dst.fill(r.signed(info.bps));
      else if (type === 1) for (let i = 0; i < size; i++) dst[i] = r.signed(info.bps);
      else if ((type & 0b111000) === 0b001000) {
        const order = type & 7;
        for (let i = 0; i < order; i++) dst[i] = r.signed(info.bps);
        const method = r.read(2);
        const paramBits = method === 1 ? 5 : 4;
        const porder = r.read(4);
        const parts = 1 << porder;
        let i = order;
        for (let p = 0; p < parts; p++) {
          const k = r.read(paramBits);
          const len = (size >> porder) - (p === 0 ? order : 0);
          for (let j = 0; j < len; j++, i++) {
            const u = r.unary() * 2 ** k + (k ? r.read(k) : 0);
            const res = u % 2 === 0 ? u / 2 : -(u + 1) / 2;
            const x = (n) => dst[i - n];
            const pred = [0, x(1), 2 * x(1) - x(2), 3 * x(1) - 3 * x(2) + x(3), 4 * x(1) - 6 * x(2) + 4 * x(3) - x(4)][
              order
            ];
            dst[i] = pred + res;
          }
        }
      } else throw new Error(`sous-trame ${type}`);
    }
    r.align();
    const footer = r.read(16);
    if (crc16(bytes.subarray(frameStart, (r.pos >> 3) - 2)) !== footer) throw new Error('crc16');
    done += size;
  }
  return { ...info, channels: out };
}
