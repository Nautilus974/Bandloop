// Conteneur ZIP minimal (méthode « stocké », sans compression) pour les projets
// .bandloop : un fichier projet = un ZIP lisible par n'importe quel outil.
// L'audio y est déjà compressé (FLAC, MP3…) : recompresser ne ferait rien gagner.
// Limites : 4 Gio et 65 535 fichiers (pas de ZIP64).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

const MAX_SIZE = 0xffffffff;

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * @param {Array<{ name: string, data: Uint8Array }>} entries
 * @returns {Uint8Array}
 */
export function createZip(entries, date = new Date()) {
  const encoder = new TextEncoder();
  const { time, day } = dosDateTime(date);
  const files = entries.map((e) => ({ name: encoder.encode(e.name), data: e.data, crc: crc32(e.data) }));
  let size = 22;
  for (const f of files) size += 30 + f.name.length + f.data.length + 46 + f.name.length;
  if (size > MAX_SIZE || files.length > 0xffff) throw new ZipError('Projet trop volumineux (limite 4 Gio).');

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let pos = 0;
  const offsets = [];
  for (const f of files) {
    offsets.push(pos);
    view.setUint32(pos, 0x04034b50, true);
    view.setUint16(pos + 4, 20, true); // version nécessaire
    view.setUint16(pos + 6, 0x0800, true); // noms en UTF-8
    view.setUint16(pos + 8, 0, true); // stocké
    view.setUint16(pos + 10, time, true);
    view.setUint16(pos + 12, day, true);
    view.setUint32(pos + 14, f.crc, true);
    view.setUint32(pos + 18, f.data.length, true);
    view.setUint32(pos + 22, f.data.length, true);
    view.setUint16(pos + 26, f.name.length, true);
    view.setUint16(pos + 28, 0, true);
    out.set(f.name, pos + 30);
    out.set(f.data, pos + 30 + f.name.length);
    pos += 30 + f.name.length + f.data.length;
  }
  const centralStart = pos;
  files.forEach((f, i) => {
    view.setUint32(pos, 0x02014b50, true);
    view.setUint16(pos + 4, 20, true);
    view.setUint16(pos + 6, 20, true);
    view.setUint16(pos + 8, 0x0800, true);
    view.setUint16(pos + 10, 0, true);
    view.setUint16(pos + 12, time, true);
    view.setUint16(pos + 14, day, true);
    view.setUint32(pos + 16, f.crc, true);
    view.setUint32(pos + 20, f.data.length, true);
    view.setUint32(pos + 24, f.data.length, true);
    view.setUint16(pos + 28, f.name.length, true);
    view.setUint32(pos + 42, offsets[i], true);
    out.set(f.name, pos + 46);
    pos += 46 + f.name.length;
  });
  view.setUint32(pos, 0x06054b50, true);
  view.setUint16(pos + 8, files.length, true);
  view.setUint16(pos + 10, files.length, true);
  view.setUint32(pos + 12, pos - centralStart, true);
  view.setUint32(pos + 16, centralStart, true);
  return out;
}

/**
 * Lit un ZIP « stocké » et vérifie l'intégrité (CRC) de chaque fichier.
 * @returns {Map<string, Uint8Array>}
 */
export function readZip(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 22) throw new ZipError('Fichier vide ou tronqué.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipError('Ce n’est pas un projet Bandloop (structure illisible).');
  const count = view.getUint16(end + 10, true);
  let pos = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (pos + 46 > bytes.length || view.getUint32(pos, true) !== 0x02014b50)
      throw new ZipError('Index du projet endommagé.');
    const method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const size = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const local = view.getUint32(pos + 42, true);
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    if (method !== 0) throw new ZipError(`« ${name} » est compressé d’une façon non prise en charge.`);
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50)
      throw new ZipError(`« ${name} » est endommagé.`);
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (dataStart + size > bytes.length) throw new ZipError(`« ${name} » est tronqué.`);
    const data = bytes.subarray(dataStart, dataStart + size);
    if (crc32(data) !== crc) throw new ZipError(`« ${name} » est corrompu (somme de contrôle invalide).`);
    files.set(name, data);
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
