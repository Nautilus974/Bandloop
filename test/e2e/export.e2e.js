// Tests de bout en bout de l'export du mix et des erreurs de fichiers, dans Electron.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { parseWav } from '../../src/renderer/project/wav.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bandloop-export-'));
const CEILING = Math.pow(10, -1 / 20); // -1 dBFS
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let app;
let win;

const menu = (id) => app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu().getMenuItemById(itemId).click(), id);
const stubSaveDialog = (file) =>
  app.evaluate(({ dialog }, f) => (dialog.showSaveDialog = async () => ({ canceled: false, filePath: f })), file);
const stubOpenDialog = (files) =>
  app.evaluate(({ dialog }, f) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: f })), files);

/** Énergie d'une fréquence (Goertzel), pour vérifier ce qui est audible dans le mix. */
function energyAt(samples, sampleRate, hz) {
  const k = (2 * Math.PI * hz) / sampleRate;
  const coeff = 2 * Math.cos(k);
  let s1 = 0;
  let s2 = 0;
  for (const x of samples) {
    const s = x + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / samples.length;
}
const peak = (chs) => chs.reduce((m, c) => c.reduce((n, v) => Math.max(n, Math.abs(v)), m), 0);

before(async () => {
  const electronPath = (await import('electron')).default;
  app = await electron.launch({
    executablePath: electronPath,
    args: [
      ROOT,
      '--no-sandbox',
      `--user-data-dir=${path.join(TMP, 'userdata')}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  win = await app.firstWindow();
  await win.waitForFunction(() => window.project && window.engine);
  // Pistes de test : 220 Hz forte, 440 Hz muette, et 110 Hz + 1 kHz avec le preset
  // « Combiné » (passe-bande téléphone : 110 Hz hors bande, 1 kHz dans la bande).
  await win.evaluate(() => {
    const sr = engine.ctx.sampleRate;
    const sine = (hz, amp, seconds, hz2 = 0) => {
      const b = engine.ctx.createBuffer(1, seconds * sr, sr);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) {
        d[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr) + (hz2 ? amp * Math.sin((2 * Math.PI * hz2 * i) / sr) : 0);
      }
      return b;
    };
    const a = engine.addBufferTrack('la220', sine(220, 0.9, 4));
    const b = engine.addBufferTrack('la440', sine(440, 0.9, 4));
    const c = engine.addBufferTrack('tel', sine(110, 0.3, 4, 1000));
    engine.setVolume(a.id, 6); // somme volontairement au-dessus de 0 dBFS
    engine.setMuted(b.id, true);
    hub.setSettings(c.id, presets.settingsOf('combine'), { presetId: 'combine' });
  });
});

after(async () => {
  // Fermeture forcée : sinon la confirmation « Enregistrer les modifications ? » attendrait une réponse.
  await app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy())).catch(() => {});
  await app?.close().catch(() => {});
});

async function exportVia(format, option) {
  await menu('export');
  await win.waitForSelector('.export-dialog');
  await win.locator('.format-card', { hasText: format === 'wav' ? 'Qualité studio' : 'Partage' }).click();
  if (option) await win.getByRole('radio', { name: option }).click();
  const file = path.join(TMP, `mix.${format}`);
  await stubSaveDialog(file);
  await win.getByRole('button', { name: 'Exporter…' }).click();
  await win.waitForSelector('.export-dialog >> text=Mix exporté', { timeout: 60000 });
  const info = await win.locator('.export-dialog').innerText();
  await win.getByRole('button', { name: 'Fermer' }).click();
  return { file, info };
}

test('export WAV 24 bits : fichier valide, effets et mute respectés, aucune saturation', async () => {
  const { file, info } = await exportVia('wav', '24 bits');
  assert.match(info, /crêtes réduites/, 'le limiteur a travaillé (somme > 0 dBFS)');
  const wav = parseWav(fs.readFileSync(file));
  assert.equal(wav.bitDepth, 24);
  assert.equal(wav.channels.length, 2);
  const sr = wav.sampleRate;
  const seconds = wav.channels[0].length / sr;
  assert.ok(seconds >= 4 && seconds < 5.5, `durée ${seconds}`);
  assert.ok(peak(wav.channels) <= CEILING + 1e-6, `crête ${peak(wav.channels)}`);
  // Écrêtage = plateaux (plusieurs échantillons consécutifs bloqués au plafond).
  // Un sommet d'onde amené au plafond par le limiteur n'en est pas un.
  let plateaus = 0;
  for (const ch of wav.channels) {
    for (let i = 2; i < ch.length; i++) {
      if ([ch[i], ch[i - 1], ch[i - 2]].every((v) => Math.abs(v) >= CEILING - 1e-6)) plateaus++;
    }
  }
  assert.equal(plateaus, 0, `${plateaus} plateaux d’écrêtage`);
  const mid = wav.channels[0].subarray(sr, 3 * sr);
  const e220 = energyAt(mid, sr, 220);
  assert.ok(e220 > 0.01, 'piste audible présente');
  assert.ok(energyAt(mid, sr, 440) < e220 * 1e-4, 'piste muette absente');
  // « Combiné » (passe-bande 500 Hz – 3 kHz) : à niveau d'origine égal, le 110 Hz
  // ressort au moins 30 dB sous le 1 kHz de la même piste.
  const ratio = energyAt(mid, sr, 110) / energyAt(mid, sr, 1000);
  assert.ok(ratio < 1e-3, `effet appliqué à l’export (rapport 110 Hz / 1 kHz = ${ratio})`);
});

test('export MP3 320 kb/s : fichier valide et non saturé', { skip: !hasFfmpeg && 'ffmpeg absent' }, async () => {
  const { file } = await exportVia('mp3', '320 kb/s');
  const probe = execFileSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_name,channels,bit_rate:format=duration',
    '-of',
    'json',
    file,
  ]).toString();
  const meta = JSON.parse(probe);
  assert.equal(meta.streams[0].codec_name, 'mp3');
  assert.equal(meta.streams[0].channels, 2);
  assert.equal(Number(meta.streams[0].bit_rate), 320000);
  assert.ok(Math.abs(Number(meta.format.duration) - 4.4) < 0.8, `durée ${meta.format.duration}`);
  // Décodage stéréo entrelacé (sans réduction en mono, qui additionnerait les canaux).
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-'], { maxBuffer: 256 * 1024 * 1024 });
  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
  // Le MP3 peut légèrement dépasser la crête d'origine (-1 dBFS) : marge pour rester < 0 dBFS.
  assert.ok(peak([samples]) < 1, `crête décodée ${peak([samples])}`);
  assert.ok(peak([samples]) > 0.3, 'non silencieux');
});

test('« Fermer » puis « Exporter » aussitôt : la boîte se rouvre (régression)', async () => {
  for (let i = 0; i < 5; i++) {
    await menu('export');
    await win.waitForSelector('.export-dialog[open]', { timeout: 2000 });
    await win.getByRole('button', { name: 'Annuler', exact: true }).click();
  }
  await menu('export');
  await win.waitForSelector('.export-dialog[open]', { timeout: 2000 });
  await win.keyboard.press('Escape');
  await win.waitForSelector('.export-dialog', { state: 'detached' });
});

test('annuler un export : aucun fichier écrit', async () => {
  await win.evaluate(() => {
    const sr = engine.ctx.sampleRate;
    engine.addBufferTrack('long', engine.ctx.createBuffer(1, 240 * sr, sr)); // 4 min de silence
  });
  await menu('export');
  await win.locator('.format-card', { hasText: 'Qualité studio' }).click();
  const file = path.join(TMP, 'annule.wav');
  await stubSaveDialog(file);
  await win.getByRole('button', { name: 'Exporter…' }).click();
  await win.waitForSelector('.progress');
  await win.getByRole('button', { name: 'Annuler l’export' }).click();
  await win.waitForSelector('.export-dialog', { state: 'detached' });
  assert.equal(fs.existsSync(file), false);
  assert.match(await win.locator('#status').innerText(), /annulé/);
  await win.evaluate(() => engine.removeTrack(engine.tracks.at(-1).id));
});

test('ouvrir un fichier corrompu ou étranger : message clair', async () => {
  // Projet courant enregistré : l'ouverture ne demande pas de confirmation.
  const good = path.join(TMP, 'bon.bandloop');
  await stubSaveDialog(good);
  await menu('save-as');
  await win.waitForFunction(() => !project.dirty, null, { timeout: 30000 });
  const fake = path.join(TMP, 'faux.bandloop');
  fs.writeFileSync(fake, 'ceci n’est pas un projet');
  await stubOpenDialog([fake]);
  await menu('open');
  await win.waitForSelector('dialog[open]');
  assert.match(
    await win.locator('dialog[open]').innerText(),
    /Impossible d’ouvrir le projet[\s\S]*pas un projet Bandloop|endommagé/,
  );
  await win.getByRole('button', { name: 'OK' }).click();
  assert.equal(await win.evaluate(() => engine.tracks.length), 3, 'le projet courant est intact');

  // Projet valide tronqué (copie partielle, clé USB arrachée…).
  const truncated = path.join(TMP, 'tronque.bandloop');
  const bytes = fs.readFileSync(good);
  fs.writeFileSync(truncated, bytes.subarray(0, bytes.length - 100));
  await stubOpenDialog([truncated]);
  await menu('open');
  await win.waitForSelector('dialog[open]');
  assert.match(await win.locator('dialog[open]').innerText(), /endommagé/);
  await win.getByRole('button', { name: 'OK' }).click();

  // Fichier supprimé entre-temps.
  await stubOpenDialog([path.join(TMP, 'disparu.bandloop')]);
  await menu('open');
  await win.waitForSelector('dialog[open]');
  assert.match(await win.locator('dialog[open]').innerText(), /introuvable/);
  await win.getByRole('button', { name: 'OK' }).click();
});

/** Monte un petit disque (tmpfs) pour provoquer de vraies erreurs système ; null si impossible. */
function mountTiny(dir, options) {
  fs.mkdirSync(dir, { recursive: true });
  try {
    execFileSync('mount', ['-t', 'tmpfs', '-o', options, 'tmpfs', dir], { stdio: 'ignore' });
    return dir;
  } catch {
    return null;
  }
}

test('disque plein : message clair, aucun fichier partiel', async (t) => {
  const dir = mountTiny(path.join(TMP, 'plein'), 'size=64k');
  if (!dir) return t.skip('montage impossible (droits administrateur requis)');
  try {
    await stubSaveDialog(path.join(dir, 'gros.bandloop'));
    await menu('save-as');
    await win.waitForSelector('dialog[open]', { timeout: 30000 });
    assert.match(await win.locator('dialog[open]').innerText(), /Disque plein/);
    await win.getByRole('button', { name: 'OK' }).click();
    assert.deepEqual(fs.readdirSync(dir), [], 'ni projet tronqué ni fichier temporaire');
  } finally {
    execFileSync('umount', [dir]);
  }
});

test('emplacement en lecture seule : message clair', async (t) => {
  const dir = mountTiny(path.join(TMP, 'lecture-seule'), 'size=1m,ro');
  if (!dir) return t.skip('montage impossible (droits administrateur requis)');
  try {
    await stubSaveDialog(path.join(dir, 'mix.wav'));
    await menu('export');
    await win.locator('.format-card', { hasText: 'Qualité studio' }).click();
    await win.getByRole('button', { name: 'Exporter…' }).click();
    await win.waitForSelector('.export-dialog >> text=L’export a échoué', { timeout: 60000 });
    assert.match(await win.locator('.export-dialog').innerText(), /lecture seule/);
    await win.getByRole('button', { name: 'Fermer' }).click();
  } finally {
    execFileSync('umount', [dir]);
  }
});
