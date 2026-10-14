// Encodeur FLAC (Free Lossless Audio Codec) : compression SANS PERTE de l'audio
// enregistré au micro, pour les fichiers de projet.
//
// Implémentation volontairement simple mais conforme à la spécification :
// blocs de 4096 échantillons, canaux indépendants, prédicteurs « fixes »
// d'ordre 0 à 4 (on garde celui qui laisse le plus petit résidu), résidu codé en
// Rice partitionné (paramètre par partition), CRC-8 / CRC-16 par trame.
// Taux typique sur une voix : 50 à 65 % de la taille d'un WAV équivalent.
// Lu nativement par Chromium (decodeAudioData), VLC, Audacity, ffmpeg, etc.

const BLOCK_SIZE = 4096;
const MAX_PARTITION_ORDER = 6;

class BitWriter {
  constructor(size = 1 << 16) {
    this.buf = new Uint8Array(size);
    this.pos = 0;
    this.cur = 0;
    this.nbits = 0;
  }

  #grow(extra) {
    if (this.pos + extra <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + extra));
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }

  /** Écrit `bits` bits de `value` (entier non signé, jusqu'à 36 bits). */
  write(value, bits) {
    this.#grow(6);
    let remaining = bits;
    while (remaining > 0) {
      const take = Math.min(8 - this.nbits, remaining);
      const shift = remaining - take;
      const chunk = Math.floor(value / 2 ** shift) & ((1 << take) - 1);
      this.cur = (this.cur << take) | chunk;
      this.nbits += take;
      remaining -= take;
      if (this.nbits === 8) {
        this.buf[this.pos++] = this.cur;
        this.cur = 0;
        this.nbits = 0;
      }
    }
  }

  /** `q` zéros suivis d'un 1 (code unaire). */
  unary(q) {
    this.#grow((q >> 3) + 2);
    while (q > 0 && this.nbits !== 0) {
      this.write(0, 1);
      q--;
    }
    while (q >= 8) {
      this.buf[this.pos++] = 0;
      q -= 8;
    }
    if (q > 0) this.write(0, q);
    this.write(1, 1);
  }

  alignByte() {
    if (this.nbits) this.write(0, 8 - this.nbits);
  }

  bytes() {
    return this.buf.subarray(0, this.pos);
  }
}

const CRC8 = Uint8Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  return c;
});
const CRC16 = Uint16Array.from({ length: 256 }, (_, n) => {
  let c = n << 8;
  for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
  return c;
});

export function crc8(bytes) {
  let c = 0;
  for (const b of bytes) c = CRC8[c ^ b];
  return c;
}

export function crc16(bytes) {
  let c = 0;
  for (const b of bytes) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b];
  return c;
}

/** Numéro de trame au format « UTF-8 étendu » de FLAC. */
function writeUtf8Number(w, n) {
  if (n < 0x80) return w.write(n, 8);
  let bytes = 2;
  while (n >= 2 ** (5 * bytes + 1)) bytes++;
  const lead = (0xff00 >> bytes) & 0xff;
  w.write(lead | Math.floor(n / 2 ** (6 * (bytes - 1))), 8);
  for (let i = bytes - 2; i >= 0; i--) w.write(0x80 | (Math.floor(n / 2 ** (6 * i)) & 0x3f), 8);
}

/** Résidu d'un prédicteur fixe d'ordre `order`. */
function fixedResidual(x, order, out) {
  const n = x.length;
  for (let i = order; i < n; i++) {
    switch (order) {
      case 0:
        out[i - order] = x[i];
        break;
      case 1:
        out[i - order] = x[i] - x[i - 1];
        break;
      case 2:
        out[i - order] = x[i] - 2 * x[i - 1] + x[i - 2];
        break;
      case 3:
        out[i - order] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3];
        break;
      default:
        out[i - order] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
    }
  }
  return n - order;
}

const zigzag = (r) => (r >= 0 ? 2 * r : -2 * r - 1);

/** Meilleur paramètre de Rice pour une somme de valeurs zigzag (estimation en bits). */
function bestRice(sum, count) {
  let best = 0;
  let bestBits = Infinity;
  for (let k = 0; k <= 30; k++) {
    const bits = count * (k + 1) + Math.floor(sum / 2 ** k);
    if (bits < bestBits) {
      bestBits = bits;
      best = k;
    }
  }
  return { k: best, bits: bestBits };
}

/** Choisit l'ordre de partition et les paramètres de Rice qui minimisent la taille. */
function planResidual(residual, count, blockSize, order) {
  const u = new Float64Array(count);
  for (let i = 0; i < count; i++) u[i] = zigzag(residual[i]);
  let best = null;
  for (let p = 0; p <= MAX_PARTITION_ORDER; p++) {
    const parts = 1 << p;
    if (blockSize % parts !== 0 || blockSize / parts <= order) break;
    const per = blockSize / parts;
    let bits = 0;
    const params = [];
    let start = 0;
    for (let part = 0; part < parts; part++) {
      const len = part === 0 ? per - order : per;
      let sum = 0;
      for (let i = start; i < start + len; i++) sum += u[i];
      const r = bestRice(sum, len);
      params.push(r.k);
      bits += 5 + r.bits;
      start += len;
    }
    if (!best || bits < best.bits) best = { order: p, params, bits };
  }
  return { ...best, u };
}

function writeSubframe(w, x, bps) {
  const n = x.length;
  // Bloc constant (silence numérique, par ex.).
  let constant = true;
  for (let i = 1; i < n && constant; i++) constant = x[i] === x[0];
  const toUnsigned = (v) => (v < 0 ? v + 2 ** bps : v);
  if (constant) {
    w.write(0, 1);
    w.write(0b000000, 6);
    w.write(0, 1);
    w.write(toUnsigned(x[0]), bps);
    return;
  }

  // Meilleur prédicteur fixe : somme des valeurs absolues du résidu la plus faible.
  const residual = new Float64Array(n);
  let bestOrder = 0;
  let bestSum = Infinity;
  for (let order = 0; order <= Math.min(4, n - 1); order++) {
    const count = fixedResidual(x, order, residual);
    let sum = 0;
    for (let i = 0; i < count; i++) sum += Math.abs(residual[i]);
    if (sum < bestSum) {
      bestSum = sum;
      bestOrder = order;
    }
  }
  const count = fixedResidual(x, bestOrder, residual);
  const plan = planResidual(residual, count, n, bestOrder);

  // Si le codage prédictif ne gagne rien (bruit pur), on stocke tel quel.
  if (plan.bits + bestOrder * bps >= n * bps) {
    w.write(0, 1);
    w.write(0b000001, 6);
    w.write(0, 1);
    for (let i = 0; i < n; i++) w.write(toUnsigned(x[i]), bps);
    return;
  }

  w.write(0, 1);
  w.write(0b001000 | bestOrder, 6);
  w.write(0, 1);
  for (let i = 0; i < bestOrder; i++) w.write(toUnsigned(x[i]), bps);
  w.write(0b01, 2); // Rice avec paramètres sur 5 bits
  w.write(plan.order, 4);
  const parts = 1 << plan.order;
  const per = n / parts;
  let idx = 0;
  for (let part = 0; part < parts; part++) {
    const k = plan.params[part];
    w.write(k, 5);
    const len = part === 0 ? per - bestOrder : per;
    const mask = 2 ** k;
    for (let i = 0; i < len; i++, idx++) {
      const v = plan.u[idx];
      w.unary(Math.floor(v / mask));
      if (k) w.write(v % mask, k);
    }
  }
}

/** Convertit des échantillons flottants (-1..1) en entiers sur `bits` bits (arrondi, écrêté). */
export function floatToInt(samples, bits) {
  const max = 2 ** (bits - 1);
  const out = new Int32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.round(samples[i] * max);
    out[i] = v >= max ? max - 1 : v < -max ? -max : v;
  }
  return out;
}

/**
 * @param {Int32Array[]} channels   Échantillons entiers (1 à 8 canaux, même longueur)
 * @param {{ sampleRate: number, bitsPerSample: number }} opts  16 ou 24 bits
 * @returns {Uint8Array} fichier .flac complet
 */
export function encodeFlac(channels, { sampleRate, bitsPerSample }) {
  const total = channels[0].length;
  const w = new BitWriter(Math.max(1 << 16, Math.round(total * channels.length * (bitsPerSample / 8) * 0.8)));

  // En-tête et bloc STREAMINFO (le seul bloc de métadonnées, marqué « dernier »).
  for (const c of 'fLaC') w.write(c.charCodeAt(0), 8);
  w.write(1, 1);
  w.write(0, 7);
  w.write(34, 24);
  w.write(BLOCK_SIZE, 16);
  w.write(BLOCK_SIZE, 16);
  w.write(0, 24); // taille de trame min. inconnue
  w.write(0, 24); // taille de trame max. inconnue
  w.write(sampleRate, 20);
  w.write(channels.length - 1, 3);
  w.write(bitsPerSample - 1, 5);
  w.write(total, 36);
  for (let i = 0; i < 16; i++) w.write(0, 8); // MD5 non calculé (autorisé)

  const sampleSizeCode = { 8: 0b001, 12: 0b010, 16: 0b100, 20: 0b101, 24: 0b110 }[bitsPerSample] ?? 0;
  let frame = 0;
  for (let start = 0; start < total; start += BLOCK_SIZE, frame++) {
    const size = Math.min(BLOCK_SIZE, total - start);
    const frameStart = w.pos;
    w.write(0b11111111111110, 14); // synchro
    w.write(0, 1);
    w.write(0, 1); // taille de bloc fixe
    w.write(0b0111, 4); // taille de bloc - 1 sur 16 bits, en fin d'en-tête
    w.write(0b0000, 4); // fréquence : voir STREAMINFO
    w.write(channels.length - 1, 4); // canaux indépendants
    w.write(sampleSizeCode, 3);
    w.write(0, 1);
    writeUtf8Number(w, frame);
    w.write(size - 1, 16);
    w.write(crc8(w.buf.subarray(frameStart, w.pos)), 8);

    for (const ch of channels) writeSubframe(w, ch.subarray(start, start + size), bitsPerSample);
    w.alignByte();
    w.write(crc16(w.buf.subarray(frameStart, w.pos)), 16);
  }
  return w.bytes().slice();
}
