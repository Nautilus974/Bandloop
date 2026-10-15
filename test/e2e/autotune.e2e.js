// Tests de bout en bout de la section « Correction de voix » du panneau FX,
// dans la vraie application Electron : réglages manuels, presets (« modifié »,
// revenir au preset, enregistrer comme preset personnel), écoute A/B, tonalité
// propre à une piste, harmonies, affichage des notes, annulation, blocage
// pendant un enregistrement, et conservation après enregistrement → relance → réouverture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bandloop-autotune-'));
const PROJECT = path.join(TMP, 'Autotune.bandloop');

let app;
let win;

async function launch() {
  const electronPath = (await import('electron')).default;
  app = await electron.launch({
    executablePath: electronPath,
    args: [ROOT, '--no-sandbox', `--user-data-dir=${path.join(TMP, 'userdata')}`],
  });
  win = await app.firstWindow();
  await win.waitForFunction(() => window.project && window.engine);
}

async function quit() {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()));
  await app.close();
}

const menu = (id) => app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu().getMenuItemById(itemId).click(), id);
/** Annuler / rétablir par le menu natif, en attendant que la commande (IPC) soit traitée. */
async function menuHistory(id) {
  const n = await win.evaluate(() => editHistory.undoStack.length);
  await menu(id);
  await win.waitForFunction((m) => editHistory.undoStack.length === m, n + (id === 'undo' ? -1 : 1));
}

const voiceId = () => win.evaluate(() => engine.tracks[0].id);
const vocal = () =>
  win.evaluate(() => {
    const s = hub.getState(engine.tracks[0].id);
    return {
      presetId: s.presetId,
      pitch: s.settings.pitch,
      harmony: s.settings.harmony,
      tonality: s.tonality,
      song: hub.tonality,
      compareRaw: s.compareRaw,
      signature: s.signature,
    };
  });
const idle = () => win.evaluate(() => hub.whenIdle());
const section = () => win.locator('[data-section="pitch"]');
/** Place un curseur à une position 0..1 (comme un glisser de l'utilisateur). */
const setSlider = (label, t) =>
  section()
    .locator(`.param-slider[aria-label="${label}"]`)
    .fill(String(Math.round(t * 1000)));

before(async () => {
  await launch();
  await app.evaluate(
    ({ dialog }, f) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })),
    path.join(ROOT, 'samples', 'voix.wav'),
  );
  await win.click('#btn-import');
  await win.waitForFunction(() => engine.tracks.length === 1);
  await win.locator('.track .btn-fx').click();
  await win.waitForSelector('#fx-panel:not([hidden])');
});

after(async () => {
  if (app) await quit();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('section « Correction de voix » : réglages visibles, A/B indisponible tant que rien n’est calculé', async () => {
  await section().waitFor();
  const labels = await section().locator('.param-label').allInnerTexts();
  for (const l of ['Écoute', 'Vitesse de calage', 'Intensité (dosage)', 'Préserver le vibrato', 'Harmonies'])
    assert.ok(labels.includes(l), `${l} présent (${labels.join(', ')})`);
  assert.deepEqual(await section().locator('.param-ticks span').allInnerTexts(), [
    'ROBOT',
    'RAPIDE',
    'NATUREL',
    'DOUX',
  ]);
  assert.match(await section().locator('.pitch-readout').innerText(), /Active la correction/);
  assert.equal(await section().getByRole('radio', { name: /Brute/ }).isDisabled(), true);
});

test('un preset remplit les réglages ; les modifier affiche « modifié » ; « Revenir au preset »', async () => {
  await win.evaluate(() => hub.setTonality({ key: 9, scale: 'minor' })); // la voix de démo est en La mineur
  await win.locator('.preset-card', { hasText: 'Studio' }).click();
  const studio = await win.evaluate(() => presets.settingsOf('studio').pitch);
  assert.deepEqual((await vocal()).pitch, studio);
  assert.match(
    await section().locator('.param-hero .param-value').first().innerText(),
    new RegExp(`${studio.speed} ms`),
  );
  assert.equal(await win.locator('.preset-bar .badge').count(), 0);

  await setSlider('Intensité (dosage)', 0.5);
  assert.equal((await vocal()).pitch.strength, 50);
  assert.equal(await win.locator('.preset-bar .badge').innerText(), 'modifié');
  await win.getByRole('button', { name: 'Revenir au preset' }).click();
  assert.deepEqual((await vocal()).pitch, studio);
  assert.equal(await win.locator('.preset-bar .badge').count(), 0);
});

test('vitesse : échelle fine près de « robot », repères, et un glisser = une seule annulation', async () => {
  const before = (await vocal()).pitch.speed;
  const undoBefore = await win.evaluate(() => editHistory.undoStack.length);
  await setSlider('Vitesse de calage', 0.3);
  await setSlider('Vitesse de calage', 0.2236); // ≈ 20 ms (échelle racine)
  assert.equal((await vocal()).pitch.speed, 20);
  assert.match(await section().locator('.param-hero .param-value').first().innerText(), /Rapide · 20 ms/);
  assert.equal(await win.evaluate(() => editHistory.undoStack.length), undoBefore + 1, 'mouvements fusionnés');
  assert.match(await win.locator('#btn-undo').getAttribute('title'), /Vitesse de calage/);
  await menuHistory('undo');
  assert.equal((await vocal()).pitch.speed, before);
  await menuHistory('redo');
  assert.equal((await vocal()).pitch.speed, 20);
  await setSlider('Vitesse de calage', 0);
  assert.match(await section().locator('.param-hero .param-value').first().innerText(), /Robot · instantané/);
});

test('note chantée et note visée affichées à la tête de lecture, dans la gamme', async () => {
  await idle();
  // Trouver un instant chanté, puis y placer la tête.
  const t = await win.evaluate(() => {
    const s = hub.getState(engine.tracks[0].id);
    const f = s.curves.inMidi.findIndex((m, i) => !Number.isNaN(m) && i > 200);
    return (f * s.curves.hop) / engine.tracks[0].sampleRate;
  });
  await win.evaluate((x) => engine.seek(x), t);
  await win.waitForFunction(() => /Chantée/.test(document.querySelector('.pitch-readout').textContent));
  const text = await section().locator('.pitch-readout').textContent();
  const m = text.match(/Chantée\s*(\S+?)\s*([+−±]\d+) ct\s*→\s*Visée\s*(\S+)/);
  assert.ok(m, text);
  const laMinor = ['La', 'Si', 'Do', 'Ré', 'Mi', 'Fa', 'Sol'];
  assert.ok(laMinor.includes(m[3].replace(/\d+$/, '')), `note visée ${m[3]} dans La mineur`);
  assert.ok(await section().locator('canvas.pitch-view').isVisible());
});

test('A/B : B fait entendre la voix brute, A la voix corrigée ; ni l’export ni l’historique ne changent', async () => {
  await idle();
  const undoBefore = await win.evaluate(() => editHistory.undoStack.length);
  await section().getByRole('radio', { name: /Brute/ }).click();
  let r = await win.evaluate(() => {
    const t = engine.tracks[0];
    return { raw: t.playbackBuffer === t.buffer, exportRendered: hub.exportBuffer(t.id) !== t.buffer };
  });
  assert.deepEqual(r, { raw: true, exportRendered: true });
  assert.equal((await vocal()).compareRaw, true);
  await section()
    .getByRole('radio', { name: /Corrigée/ })
    .click();
  r = await win.evaluate(() => engine.tracks[0].playbackBuffer !== engine.tracks[0].buffer);
  assert.equal(r, true);
  assert.equal(await win.evaluate(() => editHistory.undoStack.length), undoBefore, 'A/B n’est pas une modification');
});

test('tonalité propre à la piste : indépendante du morceau, utilisée pour le calcul, annulable', async () => {
  const box = section().locator('.tonality-block');
  await box.getByLabel('Tonalité propre à cette piste').check();
  assert.deepEqual((await vocal()).tonality, { key: 9, scale: 'minor' }, 'part de la tonalité du morceau');
  await box.getByLabel('Gamme de la piste').selectOption('majorPentatonic');
  await box.getByLabel('Tonique de la piste').selectOption({ label: 'Do' });
  const v = await vocal();
  assert.deepEqual(v.tonality, { key: 0, scale: 'majorPentatonic' });
  assert.deepEqual(v.song, { key: 9, scale: 'minor' }, 'le morceau ne change pas');
  await idle();
  // Toutes les notes visées sont dans Do pentatonique majeur (Do Ré Mi Sol La).
  const outside = await win.evaluate(() => {
    const { noteMidi } = hub.getState(engine.tracks[0].id).curves;
    return [...noteMidi].filter((m) => !Number.isNaN(m) && ![0, 2, 4, 7, 9].includes(((m % 12) + 12) % 12)).length;
  });
  assert.equal(outside, 0);
  await menuHistory('undo'); // tonique
  await menuHistory('undo'); // gamme
  await menuHistory('undo'); // case
  assert.equal((await vocal()).tonality, null, 'suit de nouveau le morceau');
  await menuHistory('redo');
  await menuHistory('redo');
  await menuHistory('redo');
  assert.deepEqual((await vocal()).tonality, { key: 0, scale: 'majorPentatonic' });
});

test('harmonies : activation (une voix ajoutée), niveau global, vibrato', async () => {
  await section().getByRole('switch', { name: 'Activer les harmonies' }).click();
  let v = await vocal();
  assert.equal(v.harmony.enabled, true);
  assert.equal(v.harmony.voices.length, 1);
  await setSlider('Niveau des harmonies', 0.5);
  v = await vocal();
  assert.ok(v.harmony.level < 0, `niveau ${v.harmony.level}`);
  await section().getByRole('switch', { name: 'Préserver le vibrato' }).click();
  assert.equal((await vocal()).pitch.keepVibrato, true);
  await idle();
  const stereo = await win.evaluate(() => {
    const b = engine.tracks[0].playbackBuffer;
    const [l, r] = [b.getChannelData(0), b.getChannelData(1)];
    let d = 0;
    for (let i = 0; i < l.length; i += 64) d = Math.max(d, Math.abs(l[i] - r[i]));
    return d;
  });
  assert.ok(stereo > 0.01, 'l’harmonie panoramiquée est dans le rendu');
});

test('enregistrer comme nouveau preset personnel', async () => {
  await win.getByRole('button', { name: 'Enregistrer sous…' }).click();
  await win.locator('dialog[open] input').fill('Mon autotune');
  await win.keyboard.press('Enter');
  await win.waitForFunction(() => presets.categories.some((c) => c.presets.some((p) => p.name === 'Mon autotune')));
  const v = await vocal();
  const saved = await win.evaluate((id) => presets.settingsOf(id), v.presetId);
  assert.equal(await win.evaluate((id) => presets.get(id).name, v.presetId), 'Mon autotune');
  assert.deepEqual(saved.pitch, v.pitch);
  assert.equal(saved.harmony.level, v.harmony.level);
  assert.equal(await win.locator('.preset-bar .badge').count(), 0);
});

test('pendant un enregistrement : réglages bloqués, annulation refusée', async () => {
  const before = await vocal();
  await win.evaluate(() => {
    engine.locked = true;
    fxPanel.render();
  });
  assert.equal(await win.locator('fieldset.fx-body').evaluate((el) => el.disabled), true);
  assert.match(await win.locator('.fx-locked').innerText(), /Enregistrement en cours/);
  assert.equal(await section().locator('.param-slider').first().isDisabled(), true);
  await menu('undo');
  await win.waitForFunction(() => /impossible/i.test(document.querySelector('#status').textContent));
  assert.deepEqual(await vocal(), before);
  await win.evaluate(() => {
    engine.locked = false;
    fxPanel.render();
  });
  assert.equal(await win.locator('fieldset.fx-body').evaluate((el) => el.disabled), false);
});

test('réglages manuels et tonalité de piste conservés : enregistrer → relancer → rouvrir', async () => {
  await setSlider('Intensité (dosage)', 0.73);
  const saved = await vocal();
  await app.evaluate(
    ({ dialog }, f) => (dialog.showSaveDialog = async () => ({ canceled: false, filePath: f })),
    PROJECT,
  );
  await menu('save');
  await win.waitForFunction(() => !project.dirty);
  await quit();
  await launch();
  await app.evaluate(
    ({ dialog }, f) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })),
    PROJECT,
  );
  await menu('open');
  await win.waitForFunction(() => engine.tracks.length === 1);
  const reopened = await vocal();
  assert.deepEqual(reopened.pitch, saved.pitch);
  assert.deepEqual(reopened.harmony, saved.harmony);
  assert.deepEqual(reopened.tonality, { key: 0, scale: 'majorPentatonic' });
  assert.deepEqual(reopened.song, { key: 9, scale: 'minor' });
  assert.equal(reopened.presetId, saved.presetId, 'preset personnel retrouvé');
  assert.equal(reopened.compareRaw, false, 'l’écoute A/B n’est pas enregistrée');
  assert.ok(await voiceId());
});
