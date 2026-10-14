// Tests de bout en bout du déplacement des pistes (gauche/droite, haut/bas),
// à la souris et au clavier, dans la vraie application Electron.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let app;
let win;

const order = () => win.evaluate(() => engine.tracks.map((t) => t.name));
const startOf = (name) => win.evaluate((n) => engine.tracks.find((t) => t.name === n).startTime, name);

/** Point dans l’en-tête du clip d’une piste (zone de déplacement), en coordonnées écran. */
async function clipPoint(name) {
  return win.evaluate((n) => {
    const i = engine.tracks.findIndex((t) => t.name === n);
    const t = engine.tracks[i];
    const rect = document.querySelector('#timeline-canvas').getBoundingClientRect();
    const scroll = document.querySelector('#timeline').scrollLeft;
    const pps = 50; // zoom par défaut
    return { x: rect.left + (t.startTime + 0.5) * pps - scroll, y: rect.top + 32 + i * 92 + 15 };
  }, name);
}

async function drag(from, dx, dy, { shift = false } = {}) {
  await win.mouse.move(from.x, from.y);
  await win.mouse.down();
  if (shift) await win.keyboard.down('Shift');
  for (let k = 1; k <= 10; k++) await win.mouse.move(from.x + (dx * k) / 10, from.y + (dy * k) / 10);
  await win.mouse.up();
  if (shift) await win.keyboard.up('Shift');
}

before(async () => {
  const electronPath = (await import('electron')).default;
  app = await electron.launch({
    executablePath: electronPath,
    args: [
      ROOT,
      '--no-sandbox',
      `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'bandloop-e2e-'))}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  win = await app.firstWindow();
  await win.setViewportSize({ width: 1440, height: 860 });
  await win.waitForFunction(() => window.project && window.engine); // application prête
  // Trois pistes de 4 s (sinus), noms A, B, C.
  await win.evaluate(() => {
    const sr = engine.ctx.sampleRate;
    for (const [name, hz] of [
      ['A', 220],
      ['B', 330],
      ['C', 440],
    ]) {
      const b = engine.ctx.createBuffer(1, 4 * sr, sr);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = 0.3 * Math.sin((2 * Math.PI * hz * i) / sr);
      engine.addBufferTrack(name, b);
    }
  });
});

after(async () => {
  // Fermeture forcée : sinon la confirmation « Enregistrer les modifications ? » attendrait une réponse.
  await app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy())).catch(() => {});
  await app?.close().catch(() => {});
});

test('glisser un clip vers la droite : aimanté sur la grille (2 s)', async () => {
  await drag(await clipPoint('B'), 103, 0); // ≈ 2,06 s -> aimanté à 2 s
  assert.equal(await startOf('B'), 2);
  assert.deepEqual(await order(), ['A', 'B', 'C']);
});

test('Maj : placement libre, sans aimant', async () => {
  await drag(await clipPoint('B'), 13, 0, { shift: true }); // + 0,26 s
  const s = await startOf('B');
  assert.ok(Math.abs(s - 2.26) < 0.03, `début ${s}`);
});

test('glisser vers la gauche : jamais avant 0', async () => {
  await drag(await clipPoint('B'), -400, 0);
  assert.equal(await startOf('B'), 0);
});

test('glisser un clip vers le bas : la piste change de place', async () => {
  await drag(await clipPoint('A'), 0, 2 * 92);
  assert.deepEqual(await order(), ['B', 'C', 'A']);
  assert.equal(await startOf('A'), 0, 'mouvement vertical seul : position inchangée');
});

test('poignée de la piste : remonter tout en haut', async () => {
  const row = win.locator('.track').filter({ has: win.locator('.track-name', { hasText: /^C$/ }) });
  const grip = row.locator('.track-grip');
  await row.hover();
  const box = await grip.boundingBox();
  await drag({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, 0, -150);
  assert.deepEqual(await order(), ['C', 'B', 'A']);
  assert.equal(await win.locator('.track.dragging').count(), 0);
});

test('simple clic sur un clip : sélection et tête de lecture, sans déplacement', async () => {
  const p = await clipPoint('A');
  await win.mouse.click(p.x + 50, p.y);
  assert.equal(await win.locator('.track.selected .track-name').innerText(), 'A');
  assert.equal(await startOf('A'), 0);
  const pos = await win.evaluate(() => engine.position);
  assert.ok(Math.abs(pos - 1.5) < 0.05, `tête ${pos}`);
});

test('clavier : Alt+↑ remonte la piste, Alt+→ décale de 0,1 s, Maj+Alt+→ de 1 s', async () => {
  await win.locator('.timeline').focus();
  await win.keyboard.press('Alt+ArrowUp');
  assert.deepEqual(await order(), ['C', 'A', 'B']);
  await win.keyboard.press('Alt+ArrowRight');
  await win.keyboard.press('Shift+Alt+ArrowRight');
  assert.ok(Math.abs((await startOf('A')) - 1.1) < 1e-9);
  await win.keyboard.press('Alt+ArrowLeft');
  assert.ok(Math.abs((await startOf('A')) - 1.0) < 1e-9);
});

test('déplacer pendant la lecture : la piste est relancée au bon endroit', async () => {
  await win.evaluate(() => {
    engine.seek(0);
    return engine.play();
  });
  await win.waitForTimeout(300);
  await win.evaluate(() => engine.setTrackStart(engine.tracks.find((t) => t.name === 'C').id, 3));
  const info = await win.evaluate(() => {
    const c = engine.tracks.find((t) => t.name === 'C');
    return { playing: engine.state, source: !!c.source, duration: engine.duration };
  });
  assert.equal(info.playing, 'playing');
  assert.equal(info.source, true);
  assert.equal(info.duration, 7);
  await win.evaluate(() => engine.stop());
});

test('pendant un enregistrement, l’arrangement est verrouillé', async () => {
  const before = await order();
  await win.evaluate(() => (engine.locked = true));
  await drag(await clipPoint('B'), 100, 92);
  assert.deepEqual(await order(), before);
  await win.evaluate(() => (engine.locked = false));
});
