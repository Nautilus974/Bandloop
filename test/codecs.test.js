import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { encodeFlac, floatToInt } from '../src/renderer/project/flac.js';
import { limitPeaks, peakOf } from '../src/renderer/project/limiter.js';
import { encodeWav, parseWav } from '../src/renderer/project/wav.js';
import { crc32, createZip, readZip, ZipError } from '../src/renderer/project/zip.js';
import { decodeFlac } from './helpers/flacDecode.js';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function rng(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
}

/** Signal de test : voix synthétique + silence + bruit (cas faciles et difficiles). */
function testSignal(n, sr = 48000, seed = 1) {
  const r = rng(seed);
  return Float32Array.from({ length: n }, (_, i) => {
    if (i > n * 0.4 && i < n * 0.5) return 0; // silence -> sous-trames constantes
    if (i > n * 0.8) return r() * 0.3; // bruit -> peu compressible
    return 0.6 * Math.sin((2 * Math.PI * 220 * i) / sr) + 0.2 * Math.sin((2 * Math.PI * 660 * i) / sr) + 0.01 * r();
  });
}

test('CRC32 : valeur de référence', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('ZIP : aller-retour, noms UTF-8, intégrité vérifiée', () => {
  const a = new TextEncoder().encode('{"é":1}');
  const b = Uint8Array.from({ length: 5000 }, (_, i) => i % 251);
  const zip = createZip([
    { name: 'project.json', data: a },
    { name: 'audio/01 Prise é.flac', data: b },
  ]);
  const files = readZip(zip);
  assert.deepEqual([...files.keys()], ['project.json', 'audio/01 Prise é.flac']);
  assert.deepEqual(files.get('audio/01 Prise é.flac'), b);
  // Un octet modifié -> CRC invalide.
  const broken = zip.slice();
  broken[30 + 'project.json'.length] ^= 0xff; // premier octet des données du 1er fichier
  assert.throws(() => readZip(broken), ZipError);
  assert.throws(() => readZip(new Uint8Array(10)), /tronqué/);
  assert.throws(() => readZip(new TextEncoder().encode('x'.repeat(100))), /pas un projet/);
});

for (const [bits, channels] of [
  [24, 1],
  [16, 2],
]) {
  test(`FLAC ${bits} bits, ${channels} canal(aux) : décodage identique à l’échantillon près`, () => {
    const n = 48000 * 2 + 1234; // dernière trame incomplète
    const ints = Array.from({ length: channels }, (_, c) => floatToInt(testSignal(n, 48000, c + 1), bits));
    const flac = encodeFlac(ints, { sampleRate: 48000, bitsPerSample: bits });
    const decoded = decodeFlac(flac);
    assert.equal(decoded.sampleRate, 48000);
    assert.equal(decoded.bps, bits);
    assert.equal(decoded.total, n);
    for (let c = 0; c < channels; c++) assert.deepEqual(decoded.channels[c], ints[c]);
    const raw = n * channels * (bits / 8);
    assert.ok(flac.length < raw * 0.85, `taux ${(flac.length / raw).toFixed(2)}`);
  });
}

test('FLAC : silence complet, valeurs extrêmes, très court', () => {
  for (const samples of [
    new Int32Array(10000),
    Int32Array.from([8388607, -8388608, 0, 8388607]),
    Int32Array.from([5]),
  ]) {
    const decoded = decodeFlac(encodeFlac([samples], { sampleRate: 44100, bitsPerSample: 24 }));
    assert.deepEqual(decoded.channels[0], samples);
  }
});

test('FLAC : lisible par ffmpeg (décodeur de référence)', { skip: !hasFfmpeg && 'ffmpeg absent' }, () => {
  const n = 44100 * 3;
  const ints = floatToInt(testSignal(n, 44100), 24);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flac-'));
  const file = path.join(dir, 't.flac');
  fs.writeFileSync(file, encodeFlac([ints], { sampleRate: 44100, bitsPerSample: 24 }));
  // ffmpeg décode en entiers 32 bits (échantillon 24 bits << 8) : comparaison exacte.
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 's32le', '-']);
  const decoded = new Int32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
  assert.equal(decoded.length, n);
  for (let i = 0; i < n; i++) if (decoded[i] >> 8 !== ints[i]) assert.fail(`écart à l’échantillon ${i}`);
});

test('WAV : aller-retour 16, 24 bits et flottant', () => {
  const ch = [testSignal(5000), testSignal(5000, 48000, 7)];
  for (const [bitDepth, tol] of [
    [16, 2 / 32768],
    [24, 1 / 8388608],
    [32, 0],
  ]) {
    const wav = parseWav(encodeWav(ch, 48000, { bitDepth }));
    assert.equal(wav.sampleRate, 48000);
    assert.equal(wav.channels.length, 2);
    for (let c = 0; c < 2; c++)
      for (let i = 0; i < 5000; i++)
        assert.ok(Math.abs(wav.channels[c][i] - ch[c][i]) <= tol + 1e-9, `${bitDepth} bits`);
  }
});

test('WAV : valeurs hors plage écrêtées proprement', () => {
  const wav = parseWav(encodeWav([Float32Array.from([2, -2, 1, -1])], 44100, { bitDepth: 24 }));
  assert.ok(wav.channels[0].every((v) => v <= 1 && v >= -1));
});

test('limiteur : aucune crête au-dessus du plafond, signal faible intact', () => {
  const sr = 44100;
  const ceiling = Math.pow(10, -1 / 20);
  // Crête dès le premier échantillon, crêtes isolées et passage fort.
  const loud = Float32Array.from({ length: sr }, (_, i) =>
    i === 0 ? 1.8 : i % 9000 === 0 ? 2.5 : 1.3 * Math.sin((2 * Math.PI * 100 * i) / sr),
  );
  const quiet = Float32Array.from({ length: sr }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 100 * i) / sr));
  const quietCopy = quiet.slice();
  const res = limitPeaks([loud], sr, { ceiling });
  assert.ok(peakOf([loud]) <= ceiling + 1e-7, `crête ${peakOf([loud])}`);
  assert.ok(res.reductionDb < -3);
  // Pas d'écrêtage brutal : le garde-fou ne doit presque jamais servir.
  const clipped = loud.filter((v) => Math.abs(v) >= ceiling - 1e-7).length;
  assert.ok(clipped < 20, `${clipped} échantillons au plafond`);
  assert.deepEqual(limitPeaks([quiet], sr, { ceiling }), { reductionDb: 0 });
  assert.deepEqual(quiet, quietCopy);
});

test('erreurs disque : messages clairs (disque plein, permission, introuvable)', async () => {
  const { describeFsError } = await import('../src/main/fs-errors.js');
  assert.match(describeFsError({ code: 'ENOSPC' }, 'save').message, /Disque plein/);
  assert.match(describeFsError({ code: 'EACCES' }, 'save').message, /Permission refusée.*écrire/);
  assert.match(describeFsError({ code: 'EPERM' }, 'open').message, /lire/);
  assert.match(describeFsError({ code: 'ENOENT' }, 'open').message, /introuvable/);
  assert.match(describeFsError({ code: 'EWHAT', message: 'boum' }, 'export').message, /EWHAT.*boum/);
});

test('export : traîne de réverb/delay et coupe du silence final', async () => {
  const { tailSeconds, trimmedLength } = await import('../src/renderer/export/mixdown.js');
  assert.equal(tailSeconds([[]]), 0.5);
  assert.ok(
    Math.abs(tailSeconds([[{ type: 'reverb', enabled: true, params: { decay: 4, preDelay: 100 } }]]) - 4.5) < 1e-9,
  );
  assert.equal(tailSeconds([[{ type: 'reverb', enabled: false, params: { decay: 4, preDelay: 0 } }]]), 0.5);
  assert.ok(tailSeconds([[{ type: 'delay', enabled: true, params: { time: 500, feedback: 50 } }]]) > 4.9);
  assert.equal(tailSeconds([[{ type: 'reverb', enabled: true, params: { decay: 60, preDelay: 0 } }]]), 12);
  const sr = 1000;
  const ch = new Float32Array(5000);
  ch[3000] = 0.5;
  assert.equal(trimmedLength([ch], sr, 1000), 3250);
  assert.equal(trimmedLength([new Float32Array(5000)], sr, 2000), 2000);
});
