// Barre supérieure : aucun élément ne se chevauche ni ne sort de la fenêtre, à
// différentes largeurs, et le nom du projet n'est tronqué (« … » + infobulle)
// que s'il est vraiment long.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bandloop-topbar-'));
const WIDTHS = [1100, 1280, 1440, 1920]; // 1100 : largeur minimale de la fenêtre
const LONG_NAME = 'Session d’enregistrement de l’album — Nuit blanche (version finale v3)';

let app;
let win;

before(async () => {
  const electronPath = (await import('electron')).default;
  app = await electron.launch({ executablePath: electronPath, args: [ROOT, '--no-sandbox', `--user-data-dir=${TMP}`] });
  win = await app.firstWindow();
  await win.waitForFunction(() => window.project && window.engine);
});

after(async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()));
  await app.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** Boîtes des éléments visibles de la barre, chevauchements et débordements. */
async function layoutAt(width) {
  await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setContentSize(w, 760), width);
  await win.waitForFunction((w) => innerWidth === w, width);
  return win.evaluate(() => {
    const selectors = [
      '#logo',
      '.wordmark',
      '#btn-file',
      '#project-name',
      '#btn-start',
      '#btn-stop',
      '#btn-play',
      '.rec-group',
      '.clock',
      '.tempo',
      '#meter',
      '.edit-tools',
      '.zoom',
      '#btn-import',
      '#btn-fx-toggle',
      '#btn-export',
    ];
    const boxes = selectors
      .map((s) => ({ s, b: document.querySelector(s).getBoundingClientRect() }))
      .filter(({ b }) => b.width > 0);
    const overlaps = [];
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i].b, boxes[j].b];
        if (a.left < b.right - 1 && b.left < a.right - 1) overlaps.push(`${boxes[i].s} × ${boxes[j].s}`);
      }
    const offscreen = boxes.filter(({ b }) => b.left < 0 || b.right > innerWidth).map(({ s }) => s);
    const name = document.querySelector('#project-name');
    return { overlaps, offscreen, truncated: name.scrollWidth > name.clientWidth, title: name.title };
  });
}

test('nom par défaut : affiché en entier, rien ne se chevauche', async () => {
  for (const width of WIDTHS) {
    const r = await layoutAt(width);
    assert.deepEqual(r.overlaps, [], `${width} px`);
    assert.deepEqual(r.offscreen, [], `${width} px`);
    assert.equal(r.truncated, false, `${width} px : « Projet sans titre » tronqué`);
  }
});

test('nom très long : « … » propre, nom complet en infobulle, rien ne se chevauche', async () => {
  await win.evaluate((n) => project.setName(n), LONG_NAME);
  for (const width of WIDTHS) {
    const r = await layoutAt(width);
    assert.deepEqual(r.overlaps, [], `${width} px`);
    assert.deepEqual(r.offscreen, [], `${width} px`);
    assert.equal(r.truncated, true);
    assert.ok(r.title.startsWith(LONG_NAME), 'nom complet dans l’infobulle');
  }
});
