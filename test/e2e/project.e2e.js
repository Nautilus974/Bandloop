// Tests de bout en bout : sauvegarde / réouverture de projet et export du mix,
// dans la vraie application Electron (relancée entre la sauvegarde et la réouverture).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { readZip } from '../../src/renderer/project/zip.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLES = path.join(ROOT, 'samples');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bandloop-project-'));
const USER_DATA = path.join(TMP, 'userdata');
const PROJECT = path.join(TMP, 'Mon morceau.bandloop');

let app;
let win;

async function launch() {
  const electronPath = (await import('electron')).default;
  app = await electron.launch({
    executablePath: electronPath,
    args: [
      ROOT,
      '--no-sandbox',
      `--user-data-dir=${USER_DATA}`,
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${path.join(SAMPLES, 'voix.wav')}`,
    ],
  });
  win = await app.firstWindow();
  await win.waitForFunction(() => window.project && window.engine); // application prête
}

/** Clique un élément du menu natif de l'application (comme l'utilisateur). */
const menu = (id) => app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu().getMenuItemById(itemId).click(), id);
const stubSaveDialog = (file) =>
  app.evaluate(({ dialog }, f) => (dialog.showSaveDialog = async () => ({ canceled: false, filePath: f })), file);
const stubOpenDialog = (files) =>
  app.evaluate(({ dialog }, f) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: f })), files);
const windowTitle = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());

/** Photographie complète de l'état du projet, audio compris (empreintes des échantillons). */
function snapshot() {
  return win.evaluate(() => {
    const hash = (buffer, quantize) => {
      let h = 2166136261;
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const d = buffer.getChannelData(c);
        const u = new Uint32Array(d.buffer, d.byteOffset, d.length);
        for (let i = 0; i < d.length; i++) {
          const v = quantize ? Math.round(d[i] * 8388608) | 0 : u[i];
          h = Math.imul(h ^ v, 16777619) >>> 0;
        }
      }
      return h;
    };
    return {
      name: project.name,
      tempo: Number(document.querySelector('#tempo').value),
      zoom: Number(document.querySelector('#zoom').value),
      tonality: hub.tonality,
      tracks: engine.tracks.map((t) => {
        const s = hub.getState(t.id);
        return {
          name: t.name,
          color: t.color,
          startTime: t.startTime,
          volumeDb: t.volumeDb,
          pan: t.pan,
          muted: t.muted,
          solo: t.solo,
          origin: t.origin?.kind,
          presetId: s.presetId,
          bypass: s.bypass,
          settings: JSON.stringify({
            ...s.settings,
            chain: s.settings.chain.map(({ type, enabled, params }) => ({ type, enabled, params })),
          }),
          frames: t.buffer.length,
          channels: t.buffer.numberOfChannels,
          // Fichier importé : échantillons identiques au bit près.
          // Prise micro (FLAC 24 bits) : identiques après quantification 24 bits.
          audio: hash(t.buffer, t.origin?.kind === 'take'),
        };
      }),
    };
  });
}

after(async () => {
  // Fermeture forcée : sinon la confirmation « Enregistrer les modifications ? » attendrait une réponse.
  await app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy())).catch(() => {});
  await app?.close().catch(() => {});
});

let before;

test('sauvegarde : projet complet (fichiers importés, prise micro, presets, mixage)', async () => {
  await launch();
  await stubOpenDialog(['voix.wav', 'drums.wav'].map((f) => path.join(SAMPLES, f)));
  await win.click('#btn-import');
  await win.waitForFunction(() => engine.tracks.length === 2);

  // Prise micro de ~2 s.
  await win.evaluate(() => recorder.setPrefs({ countdown: 0 }));
  await win.evaluate(() => engine.seek(1));
  await win.click('#btn-record');
  await win.waitForFunction(() => recorder.state === 'recording', null, { timeout: 10000 });
  await win.waitForTimeout(2200);
  await win.keyboard.press('Space');
  await win.waitForFunction(() => engine.tracks.length === 3);

  // Réglages variés sur les pistes et le projet.
  await win.evaluate(async () => {
    const [voix, drums, take] = engine.tracks;
    engine.setVolume(voix.id, -4.5);
    engine.setPan(voix.id, -0.35);
    engine.setTrackStart(voix.id, 0.75);
    engine.setMuted(drums.id, true);
    engine.setSolo(take.id, true);
    engine.setPan(take.id, 0.6);
    hub.setTonality({ key: 9, scale: 'minor' });
    hub.setSettings(voix.id, presets.settingsOf('combine'), { presetId: 'combine' });
    hub.setSettings(take.id, presets.settingsOf('chorale'), { presetId: 'chorale' });
    // Preset personnel : il doit voyager avec le projet.
    const mine = await presets.create('Ma voix maison', presets.settingsOf('flow'));
    hub.setSettings(drums.id, presets.settingsOf(mine.id), { presetId: mine.id });
    hub.setBypass(drums.id, true);
    engine.moveTrack(take.id, 0);
  });
  await win.fill('#tempo', '96');
  await win.locator('#tempo').dispatchEvent('change');
  await win.fill('#zoom', '120');
  await win.locator('#zoom').dispatchEvent('input');
  await win.fill('#project-name', 'Mon morceau');
  await win.locator('#project-name').dispatchEvent('change');

  assert.match(await windowTitle(), /^Mon morceau \* — Bandloop$/, 'astérisque si modifié');
  before = await snapshot();

  await stubSaveDialog(PROJECT);
  await menu('save');
  await win.waitForFunction(() => !project.dirty, null, { timeout: 30000 });
  assert.equal(await windowTitle(), 'Mon morceau — Bandloop', 'plus d’astérisque après enregistrement');
  assert.ok(fs.existsSync(PROJECT));
  assert.equal(fs.readdirSync(TMP).filter((f) => f.includes('.tmp')).length, 0, 'pas de fichier temporaire');

  // L'archive est un ZIP standard : project.json + audio (fichiers d'origine + FLAC de la prise).
  const files = readZip(new Uint8Array(fs.readFileSync(PROJECT)));
  assert.deepEqual(
    [...files.keys()],
    ['project.json', 'audio/01-prise-1.flac', 'audio/02-voix.wav', 'audio/03-drums.wav'],
  );
  assert.deepEqual(
    files.get('audio/02-voix.wav'),
    new Uint8Array(fs.readFileSync(path.join(SAMPLES, 'voix.wav'))),
    'fichier importé embarqué tel quel',
  );
});

test('réouverture après relance de l’application : projet identique', async () => {
  await app.close();
  // Le preset personnel est supprimé de la machine : il doit revenir avec le projet.
  fs.rmSync(path.join(USER_DATA, 'presets.json'), { force: true });
  await launch();
  assert.equal(await win.evaluate(() => engine.tracks.length), 0);
  await stubOpenDialog([PROJECT]);
  await menu('open');
  await win.waitForFunction(() => engine.tracks.length === 3, null, { timeout: 30000 });
  const after = await snapshot();
  assert.deepEqual(after, before);
  assert.equal(await windowTitle(), 'Mon morceau — Bandloop');
  assert.equal(await win.evaluate(() => project.dirty), false);
  assert.equal(await win.evaluate(() => presets.user.map((p) => p.name).join()), 'Ma voix maison');
});

test('modification puis « Nouveau » : confirmation, Annuler conserve le projet', async () => {
  await win.evaluate(() => engine.setVolume(engine.tracks[0].id, -10));
  assert.match(await windowTitle(), /\*/);
  await menu('new');
  await win.waitForSelector('dialog[open]');
  assert.match(await win.locator('dialog[open]').innerText(), /Enregistrer les modifications de « Mon morceau »/);
  await win.getByRole('button', { name: 'Annuler', exact: true }).click();
  assert.equal(await win.evaluate(() => engine.tracks.length), 3);
  await menu('new');
  await win.getByRole('button', { name: 'Ne pas enregistrer' }).click();
  await win.waitForFunction(() => engine.tracks.length === 0);
  assert.equal(await windowTitle(), 'Projet sans titre — Bandloop');
});

test('fermeture de la fenêtre avec modifications : boîte de confirmation native', async () => {
  await stubOpenDialog([PROJECT]);
  await menu('open');
  await win.waitForFunction(() => engine.tracks.length === 3, null, { timeout: 30000 });
  await win.evaluate(() => engine.setPan(engine.tracks[0].id, 0.1));
  // « Annuler » : la fenêtre reste ouverte.
  await app.evaluate(({ dialog }) => (dialog.showMessageBox = async () => ({ response: 2 })));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await win.waitForTimeout(300);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  // « Enregistrer » : le projet est enregistré, puis la fenêtre se ferme.
  await app.evaluate(({ dialog }) => (dialog.showMessageBox = async () => ({ response: 0 })));
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  app = null;
  await launch();
  await stubOpenDialog([PROJECT]);
  await menu('open');
  await win.waitForFunction(() => engine.tracks.length === 3, null, { timeout: 30000 });
  assert.equal(await win.evaluate(() => engine.tracks[0].pan), 0.1, 'modification enregistrée à la fermeture');
});
