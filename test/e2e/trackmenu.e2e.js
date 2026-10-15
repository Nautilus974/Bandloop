// Tests de bout en bout du menu d'actions d'une piste (bouton « … » et clic
// droit), dans la vraie application Electron : renommer, dupliquer, couleur,
// effets, ordre, supprimer, annulation, blocage pendant un enregistrement,
// et nom + couleur conservés après enregistrement → relance → réouverture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLES = path.join(ROOT, 'samples');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bandloop-trackmenu-'));
const PROJECT = path.join(TMP, 'Menu.bandloop');

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

const names = () => win.evaluate(() => engine.tracks.map((t) => t.name));
const selectedName = () => win.locator('.track.selected .track-name').innerText();
const exact = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const trackRow = (name) =>
  win.locator('.track[data-track-id]', { has: win.locator('.track-name', { hasText: exact(name) }) });
const openMenuOf = async (name) => {
  await trackRow(name).locator('.btn-more').click();
  await win.waitForSelector('.track-menu');
};
const menuItem = (title) => win.locator('.track-menu .menu-item', { hasText: title });
const menuHeading = () => win.locator('.track-menu .menu-heading').textContent();
const status = () => win.locator('#status').innerText();

before(async () => {
  await launch();
  await app.evaluate(
    ({ dialog }, f) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: f })),
    ['drums', 'bass', 'voix'].map((n) => path.join(SAMPLES, `${n}.wav`)),
  );
  await win.click('#btn-import');
  await win.waitForFunction(() => engine.tracks.length === 3);
  await win.evaluate(() => {
    const voix = engine.tracks[2];
    hub.setSettings(voix.id, presets.settingsOf('studio'), { presetId: 'studio' });
    engine.setVolume(voix.id, -4.5);
    engine.setPan(voix.id, 0.3);
  });
  // drums.wav sélectionnée : le menu doit pouvoir viser une AUTRE piste.
  await trackRow('drums.wav').locator('.track-index').click();
  assert.equal(await selectedName(), 'drums.wav');
});

after(async () => {
  if (app) await quit();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('« … » ouvre le menu de SA piste sans changer la sélection ; Échap et clic à côté le ferment', async () => {
  await openMenuOf('voix.wav');
  assert.equal(await menuHeading(), 'voix.wav');
  assert.equal(await selectedName(), 'drums.wav', 'la sélection ne bouge pas');
  assert.equal(await trackRow('voix.wav').locator('.btn-more').getAttribute('aria-expanded'), 'true');
  // Le focus est dans le menu, sur le premier élément.
  assert.match(await win.evaluate(() => document.activeElement.textContent), /Renommer/);
  await win.keyboard.press('Escape');
  assert.equal(await win.locator('.track-menu').count(), 0);
  assert.equal(
    await win.evaluate(() => document.activeElement.getAttribute('aria-label')),
    'Actions de la piste voix.wav',
    'le focus revient au bouton « … »',
  );
  await openMenuOf('voix.wav');
  await win.mouse.click(900, 700); // à côté
  assert.equal(await win.locator('.track-menu').count(), 0);
});

test('clavier : flèches, pastilles avec ← / →, Entrée ; « Renommer » vise la bonne piste', async () => {
  await openMenuOf('bass.wav');
  // ↓ Dupliquer, ↓ Couleur (pastille cochée), → pastille suivante, ↑ Dupliquer, ↑ Renommer
  await win.keyboard.press('ArrowDown');
  await win.keyboard.press('ArrowDown');
  const swatch = () => win.evaluate(() => document.activeElement.getAttribute('aria-label'));
  assert.equal(await swatch(), 'Turquoise', 'on entre sur la couleur actuelle');
  await win.keyboard.press('ArrowRight');
  assert.equal(await swatch(), 'Lavande');
  await win.keyboard.press('ArrowUp');
  await win.keyboard.press('ArrowUp');
  await win.keyboard.press('Enter'); // Renommer…
  await win.waitForSelector('dialog[open]');
  await win.locator('dialog[open] input').fill('  Basse   synthé  ');
  await win.keyboard.press('Enter');
  await win.waitForFunction(() => engine.tracks[1].name === 'Basse synthé');
  assert.deepEqual(await names(), ['drums.wav', 'Basse synthé', 'voix.wav']);
  assert.equal(await selectedName(), 'drums.wav');
  assert.match(await status(), /Piste renommée : « Basse synthé »/);
  await menuHistory('undo');
  assert.equal((await names())[1], 'bass.wav');
  await menuHistory('redo');
  assert.equal((await names())[1], 'Basse synthé');
});

test('couleur : choix dans la palette, visible dans le panneau, annulable', async () => {
  await openMenuOf('voix.wav');
  await win.locator('.track-menu .menu-swatch[aria-label="Ambre"]').click();
  assert.equal(await win.locator('.track-menu').count(), 0);
  const color = () => win.evaluate(() => engine.tracks[2].color);
  assert.equal(await color(), '#ffbf47');
  assert.equal(await trackRow('voix.wav').evaluate((el) => el.style.getPropertyValue('--track-color')), '#ffbf47');
  await menuHistory('undo');
  assert.equal(await color(), '#a78bfa');
  await menuHistory('redo');
  assert.equal(await color(), '#ffbf47');
});

test('dupliquer : copie juste en dessous avec audio, montage, preset et réglages', async () => {
  await openMenuOf('voix.wav');
  await menuItem('Dupliquer').click();
  await win.waitForFunction(() => engine.tracks.length === 4);
  assert.deepEqual(await names(), ['drums.wav', 'Basse synthé', 'voix.wav', 'voix.wav (copie)']);
  const cmp = await win.evaluate(() => {
    const [a, b] = [engine.tracks[2], engine.tracks[3]];
    const strip = (t) => t.clips.map(({ start, offset, length }) => ({ start, offset, length }));
    const [sa, sb] = [hub.getState(a.id), hub.getState(b.id)];
    return {
      sameAudio: a.buffer === b.buffer,
      clips: JSON.stringify(strip(a)) === JSON.stringify(strip(b)),
      mix: [b.volumeDb, b.pan, b.color],
      preset: sb.presetId,
      settings: JSON.stringify(sa.settings) === JSON.stringify(sb.settings),
      separateSettings: sa.settings !== sb.settings,
    };
  });
  assert.deepEqual(cmp, {
    sameAudio: true,
    clips: true,
    mix: [-4.5, 0.3, '#ffbf47'],
    preset: 'studio',
    settings: true,
    separateSettings: true,
  });
  assert.equal(await selectedName(), 'voix.wav (copie)', 'la copie est sélectionnée');
  await menuHistory('undo');
  assert.equal((await names()).length, 3);
  await menuHistory('redo');
  assert.deepEqual((await names()).at(-1), 'voix.wav (copie)');
  assert.equal(await win.evaluate(() => hub.getState(engine.tracks[3].id).presetId), 'studio');
});

test('monter / descendre : ordre changé, désactivé aux extrémités, annulable', async () => {
  await openMenuOf('drums.wav');
  assert.equal(await menuItem('Monter').isDisabled(), true);
  await menuItem('Descendre').click();
  assert.deepEqual((await names()).slice(0, 2), ['Basse synthé', 'drums.wav']);
  await openMenuOf('voix.wav (copie)');
  assert.equal(await menuItem('Descendre').isDisabled(), true);
  await menuItem('Monter').click();
  assert.deepEqual(await names(), ['Basse synthé', 'drums.wav', 'voix.wav (copie)', 'voix.wav']);
  await menuHistory('undo');
  await menuHistory('undo');
  assert.deepEqual(await names(), ['drums.wav', 'Basse synthé', 'voix.wav', 'voix.wav (copie)']);
});

test('« Effets et preset vocal » ouvre le panneau FX de la piste visée', async () => {
  await openMenuOf('voix.wav');
  await menuItem('Effets et preset vocal').click();
  await win.waitForSelector('#fx-panel:not([hidden])');
  assert.equal(await selectedName(), 'voix.wav');
  assert.match(await win.locator('#fx-panel').innerText(), /voix\.wav/);
});

test('supprimer : confirmation, Annuler conserve ; suppression annulable avec tout son état', async () => {
  const before = await win.evaluate(() => {
    const t = engine.tracks[2];
    return { id: t.id, clips: JSON.stringify(t.clips), volume: t.volumeDb, color: t.color };
  });
  await openMenuOf('voix.wav');
  await menuItem('Supprimer la piste').click();
  await win.waitForSelector('dialog[open]');
  assert.match(await win.locator('dialog[open]').innerText(), /« voix\.wav » sera retirée du projet[\s\S]*annuler/);
  await win.locator('dialog[open]').getByRole('button', { name: 'Annuler' }).click();
  assert.equal((await names()).length, 4);

  await openMenuOf('voix.wav');
  await menuItem('Supprimer la piste').click();
  await win.locator('dialog[open]').getByRole('button', { name: 'Supprimer' }).click();
  await win.waitForFunction(() => engine.tracks.length === 3);
  assert.deepEqual(await names(), ['drums.wav', 'Basse synthé', 'voix.wav (copie)']);
  assert.match(await status(), /supprimée/);

  await menuHistory('undo');
  const restored = await win.evaluate(() => {
    const t = engine.tracks[2];
    return {
      id: t.id,
      clips: JSON.stringify(t.clips),
      volume: t.volumeDb,
      color: t.color,
      preset: hub.getState(t.id).presetId,
    };
  });
  assert.deepEqual(restored, { ...before, preset: 'studio' }, 'même piste, même place, même état');
  await win.evaluate(() => hub.whenIdle());
  // Elle est de nouveau jouée et exportée.
  const audible = await win.evaluate(async () => {
    const { renderMix } = await import('./export/mixdown.js');
    engine.tracks.forEach((t, i) => engine.setMuted(t.id, i !== 2));
    const mix = await renderMix({ engine, hub });
    engine.tracks.forEach((t) => engine.setMuted(t.id, false));
    return mix.peakBefore;
  });
  assert.ok(audible > 0.01, `piste restaurée audible (${audible})`);
  await menuHistory('redo');
  assert.equal((await names()).length, 3);
  await menuHistory('undo');
  assert.equal((await names()).length, 4);
});

test('piste sans audio (tous ses clips supprimés) : supprimée sans confirmation', async () => {
  await win.evaluate(() => editHistory.perform('Vider', () => engine.setClips(engine.tracks[3].id, [])));
  await openMenuOf('voix.wav (copie)');
  await menuItem('Supprimer la piste').click();
  await win.waitForFunction(() => engine.tracks.length === 3);
  assert.equal(await win.locator('dialog[open]').count(), 0);
  await menuHistory('undo');
  await menuHistory('undo'); // et le montage vidé
  assert.ok(await win.evaluate(() => engine.tracks[3].clips.length > 0));
});

test('clic droit sur la piste (panneau et timeline) : menu de cette piste', async () => {
  const selected = await selectedName();
  await trackRow('Basse synthé').locator('.track-index').click({ button: 'right' });
  assert.equal(await menuHeading(), 'Basse synthé');
  await win.keyboard.press('Escape');
  const box = await win.locator('#timeline-canvas').boundingBox();
  await win.mouse.click(box.x + 300, box.y + 32 + 2 * 92 + 50, { button: 'right' });
  assert.equal(await menuHeading(), 'voix.wav');
  await win.keyboard.press('Escape');
  assert.equal(await selectedName(), selected, 'le clic droit ne change pas la sélection');
});

test('pendant un enregistrement : menu bloqué avec un message', async () => {
  await win.evaluate(() => (engine.locked = true));
  await trackRow('drums.wav').locator('.btn-more').click();
  assert.equal(await win.locator('.track-menu').count(), 0);
  assert.match(await status(), /impossible de modifier les pistes pendant un enregistrement/i);
  await trackRow('drums.wav').locator('.track-index').click({ button: 'right' });
  assert.equal(await win.locator('.track-menu').count(), 0);
  // Et les actions elles-mêmes sont refusées.
  await win.evaluate(() => trackActions.duplicate(engine.tracks[0].id));
  assert.equal((await names()).length, 4);
  await win.evaluate(() => (engine.locked = false));
});

test('nom et couleur conservés : enregistrer → relancer → rouvrir', async () => {
  const saved = await win.evaluate(() => engine.tracks.map((t) => [t.name, t.color]));
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
  await win.waitForFunction((n) => engine.tracks.length === n, saved.length);
  assert.deepEqual(await win.evaluate(() => engine.tracks.map((t) => [t.name, t.color])), saved);
  assert.ok(saved.some(([n, c]) => n === 'Basse synthé') && saved.some(([, c]) => c === '#ffbf47'));
  assert.equal(await win.evaluate(() => hub.getState(engine.tracks[3].id).presetId), 'studio', 'preset de la copie');
});
