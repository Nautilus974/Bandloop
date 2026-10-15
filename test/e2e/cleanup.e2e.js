// Tests de bout en bout du nettoyage de la voix, dans la vraie application
// Electron : accès par le mini-menu de piste, réduction de bruit (auto et zone
// choisie dans la timeline), passe-haut, gate, de-esser, écoute A/B, ordre
// nettoyage → correction, cohérence lecture / export, annulation, blocage
// pendant un enregistrement, et conservation après enregistrement → relance → réouverture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bandloop-cleanup-'));
const PROJECT = path.join(TMP, 'Nettoyage.bandloop');
const TAKE = path.join(TMP, 'prise-bruitee.wav');
const SR = 44100;
const LEAD = 0.8; // secondes de bruit seul au début de la prise

let app;
let win;

/**
 * Prise bruitée : 0,8 s de bruit seul, puis 2,4 s de « voix » (dents de scie
 * filtrées sur trois notes, avec des pauses), le tout avec un souffle constant
 * (≈ −45 dBFS) et un ronflement 50 Hz + 150 Hz.
 */
function writeNoisyTake(file) {
  const seconds = 3.6;
  const n = Math.round(seconds * SR);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  let seed = 9;
  let phase = 0;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const tv = t - LEAD;
    const notes = [220, 247, 262];
    const sung = tv >= 0 && tv < 2.4 && tv % 0.8 < 0.65;
    const hz = notes[Math.min(2, Math.floor(Math.max(0, tv) / 0.8))] * 0.985; // un peu bas
    phase = (phase + hz / SR) % 1;
    lp += 0.25 * (2 * phase - 1 - lp);
    seed = (seed * 16807) % 2147483647;
    const hiss = 0.0095 * (seed / 1073741823.5 - 1);
    const hum = 0.004 * Math.sin(2 * Math.PI * 50 * t) + 0.002 * Math.sin(2 * Math.PI * 150 * t);
    const v = (sung ? 0.45 * lp : 0) + hiss + hum;
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  fs.writeFileSync(file, b);
}

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
async function menuHistory(id) {
  const n = await win.evaluate(() => editHistory.undoStack.length);
  await menu(id);
  await win.waitForFunction((m) => editHistory.undoStack.length === m, n + (id === 'undo' ? -1 : 1));
}

const section = () => win.locator('[data-section="clean"]');
const card = (tool) => section().locator(`[data-tool="${tool}"]`);
const state = () =>
  win.evaluate(() => {
    const s = hub.getState(engine.tracks[0].id);
    return { clean: s.clean, info: s.cleanInfo, signature: s.signature, compareRaw: s.compareRaw };
  });
const idle = () => win.evaluate(() => hub.whenIdle());
/** Niveau (dBFS) de l'audio lu par la piste entre deux instants de l'audio source. */
const levelDb = (from, to, which = 'playback') =>
  win.evaluate(
    ([a, b, w]) => {
      const t = engine.tracks[0];
      const buf = w === 'export' ? hub.exportBuffer(t.id) : w === 'raw' ? t.buffer : t.playbackBuffer;
      const d = buf.getChannelData(0);
      let e = 0;
      const i0 = Math.round(a * t.sampleRate);
      const i1 = Math.round(b * t.sampleRate);
      for (let i = i0; i < i1; i++) e += d[i] * d[i];
      return 10 * Math.log10(e / (i1 - i0) + 1e-20);
    },
    [from, to, which],
  );

before(async () => {
  writeNoisyTake(TAKE);
  await launch();
  await app.evaluate(
    ({ dialog }, f) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: f })),
    [path.join(ROOT, 'samples', 'drums.wav'), TAKE],
  );
  await win.click('#btn-import');
  await win.waitForFunction(() => engine.tracks.length === 2);
  // La prise bruitée en première position (piste 0), la batterie sélectionnée.
  await win.evaluate(() => engine.moveTrack(engine.tracks[1].id, 0));
  await win.locator('.track').nth(1).locator('.track-index').click();
});

after(async () => {
  if (app) await quit();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('mini-menu « Nettoyage de la voix » : ouvre le panneau FX de CETTE piste sur la section', async () => {
  const row = win.locator('.track').nth(0);
  await row.hover();
  await row.locator('.btn-more').click();
  await win.locator('.track-menu .menu-item', { hasText: 'Nettoyage de la voix' }).click();
  await win.waitForSelector('#fx-panel:not([hidden]) [data-section="clean"]:not(.collapsed)');
  assert.match(await win.locator('.fx-track-name').innerText(), /prise-bruitee/);
  assert.equal(await section().locator('.ab-switch button').first().isDisabled(), true, 'rien à comparer');
  assert.equal((await state()).clean.enabled, false);
});

test('activation : bruit estimé automatiquement, souffle et ronflement réduits dans les silences, voix gardée', async () => {
  const rawSilence = await levelDb(0.1, 0.7, 'raw');
  const rawVoice = await levelDb(LEAD + 0.1, LEAD + 0.6, 'raw');
  await section().getByRole('switch', { name: 'Activer : Nettoyage de la voix' }).click();
  await idle();
  const { info, signature } = await state();
  assert.notEqual(signature, 'off');
  assert.equal(info.source, 'auto');
  assert.ok(info.noiseDb > -50 && info.noiseDb < -40, `bruit estimé ${info.noiseDb}`);
  assert.match(
    await card('noise').locator('.profile-text').innerText(),
    /Auto : .* s de passages calmes · bruit ≈ −?-?\d+ dBFS/,
  );
  const silence = await levelDb(0.1, 0.7);
  const voice = await levelDb(LEAD + 0.1, LEAD + 0.6);
  assert.ok(silence < rawSilence - 10, `silence ${rawSilence.toFixed(1)} → ${silence.toFixed(1)} dB`);
  assert.ok(Math.abs(voice - rawVoice) < 1, `voix ${rawVoice.toFixed(1)} → ${voice.toFixed(1)} dB`);
});

test('intensité « Fort » : encore moins de bruit ; un glisser = une annulation', async () => {
  const before = await levelDb(0.1, 0.7);
  const undo = await win.evaluate(() => editHistory.undoStack.length);
  const slider = card('noise').locator('.param-slider');
  await slider.fill('800');
  await slider.fill('1000');
  assert.equal((await state()).clean.noise.amount, 100);
  assert.equal(await win.evaluate(() => editHistory.undoStack.length), undo + 1);
  await idle();
  assert.ok((await levelDb(0.1, 0.7)) < before - 4);
  await menuHistory('undo');
  assert.equal((await state()).clean.noise.amount, 50);
  await idle();
});

test('empreinte du bruit prise sur une sélection de la timeline (zone de bruit seul)', async () => {
  // Sélection 0,2 s → 0,7 s sur le clip de la prise (glisser dans le corps du clip,
  // assez loin du bord pour ne pas attraper la poignée de rognage).
  const clipsBefore = await win.evaluate(() => JSON.stringify(engine.tracks[0].clips));
  const { left, top } = await win.evaluate(() => {
    const r = document.querySelector('#timeline-canvas').getBoundingClientRect();
    return { left: r.left - document.querySelector('#timeline').scrollLeft, top: r.top };
  });
  const y = top + 32 + 60;
  await win.mouse.move(left + 0.2 * 50, y);
  await win.mouse.down();
  await win.keyboard.down('Shift');
  for (let k = 1; k <= 10; k++) await win.mouse.move(left + (0.2 + (0.5 * k) / 10) * 50, y);
  await win.mouse.up();
  await win.keyboard.up('Shift');
  await card('noise').getByRole('radio', { name: 'Prendre la sélection' }).click();
  const { clean } = await state();
  assert.ok(clean.noise.profile, 'empreinte manuelle');
  assert.ok(Math.abs(clean.noise.profile.start - 0.2) < 0.03 && Math.abs(clean.noise.profile.end - 0.7) < 0.03);
  assert.equal(await win.evaluate(() => JSON.stringify(engine.tracks[0].clips)), clipsBefore, 'clip intact');
  await idle();
  assert.equal((await state()).info.source, 'manual');
  assert.match(await card('noise').locator('.profile-text').innerText(), /Zone choisie : 0:00\.\d+ → 0:00\.\d+/);
  await card('noise').getByRole('radio', { name: 'Auto' }).click();
  assert.equal((await state()).clean.noise.profile, null);
});

test('passe-haut : le ronflement 50 Hz disparaît ; gate réglé sur le bruit restant', async () => {
  await idle();
  const hum50 = () =>
    win.evaluate(() => {
      const d = engine.tracks[0].playbackBuffer.getChannelData(0);
      let re = 0;
      let im = 0;
      for (let i = 4410; i < 30870; i++) {
        re += d[i] * Math.cos((2 * Math.PI * 50 * i) / 44100);
        im += d[i] * Math.sin((2 * Math.PI * 50 * i) / 44100);
      }
      return Math.hypot(re, im) / 26460;
    });
  assert.ok((await hum50()) < 0.0005, `50 Hz restant ${await hum50()}`);
  await card('gate').getByRole('button', { name: 'Régler sur le bruit' }).click();
  const { clean, info } = await state();
  assert.equal(clean.gate.enabled, true);
  assert.equal(clean.gate.threshold, Math.round(info.residualDb + 8));
  await idle();
  assert.ok((await levelDb(0.1, 0.7)) < -90, 'silence coupé par le gate');
  assert.ok(Math.abs((await levelDb(LEAD + 0.1, LEAD + 0.6)) - (await levelDb(LEAD + 0.1, LEAD + 0.6, 'raw'))) < 1);
});

test('A/B : B = voix brute, A = voix nettoyée ; l’export reste nettoyé ; rien dans l’historique', async () => {
  const undo = await win.evaluate(() => editHistory.undoStack.length);
  await section().getByRole('radio', { name: /Brute/ }).click();
  assert.equal(await win.evaluate(() => engine.tracks[0].playbackBuffer === engine.tracks[0].buffer), true);
  assert.ok((await levelDb(0.1, 0.7, 'export')) < -90, 'export toujours nettoyé');
  await section()
    .getByRole('radio', { name: /Nettoyée/ })
    .click();
  assert.ok((await levelDb(0.1, 0.7)) < -90);
  assert.equal(await win.evaluate(() => editHistory.undoStack.length), undo);
});

test('nettoyage AVANT la correction : voix recalée ET débruitée ; export identique à la lecture', async () => {
  await win.evaluate(() => {
    const id = engine.tracks[0].id;
    const s = structuredClone(hub.getState(id).settings);
    s.pitch.correct = true;
    s.pitch.speed = 0;
    hub.setSettings(id, s);
  });
  await idle();
  const r = await win.evaluate(async () => {
    const { analyzePitch } = await import('./vocal/dsp/pitch.js');
    const t = engine.tracks[0];
    const d = t.playbackBuffer.getChannelData(0);
    const a = analyzePitch(d.subarray(Math.round(0.9 * 44100), Math.round(1.4 * 44100)), 44100);
    const f0 = [...a.f0].filter((v) => v > 0).sort((x, y) => x - y);
    const midi = 69 + 12 * Math.log2(f0[f0.length >> 1] / 440);
    return { midi, same: hub.exportBuffer(t.id) === t.playbackBuffer };
  });
  assert.ok(Math.abs(r.midi - 57) < 0.1, `La recalé (MIDI ${r.midi.toFixed(2)})`);
  assert.equal(r.same, true, 'l’export utilise le même rendu que la lecture');
  assert.ok((await levelDb(0.1, 0.7)) < -90, 'toujours débruité');
});

test('pendant un enregistrement : réglages de nettoyage bloqués', async () => {
  const before = (await state()).clean;
  await win.evaluate(() => {
    engine.locked = true;
    fxPanel.render();
  });
  assert.equal(await win.locator('fieldset.fx-body').evaluate((el) => el.disabled), true);
  assert.equal(await card('noise').locator('.param-slider').isDisabled(), true);
  const row = win.locator('.track').nth(0);
  await row.locator('.track-index').click({ button: 'right' });
  assert.equal(await win.locator('.track-menu').count(), 0, 'mini-menu bloqué aussi');
  assert.deepEqual((await state()).clean, before);
  await win.evaluate(() => {
    engine.locked = false;
    fxPanel.render();
  });
});

test('réglages de nettoyage conservés : enregistrer → relancer → rouvrir', async () => {
  await card('deesser').getByRole('switch').click();
  await idle();
  const saved = await state();
  const level = await levelDb(0.1, 0.7);
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
  await win.waitForFunction(() => engine.tracks.length === 2);
  await idle();
  const reopened = await state();
  assert.deepEqual(reopened.clean, saved.clean);
  assert.equal(reopened.clean.deesser.enabled, true);
  assert.ok(Math.abs((await levelDb(0.1, 0.7)) - level) < 0.5, 'même rendu après réouverture');
});
