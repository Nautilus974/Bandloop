// Tests de bout en bout du montage des clips, dans la vraie application Electron,
// à la souris et au clavier : découper → sélectionner une portion → la supprimer
// → déplacer un morceau → rogner → annuler / rétablir → enregistrer → relancer
// l'application → rouvrir. Le résultat est vérifié À L'ÉCHANTILLON PRÈS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bandloop-edit-'));
const USER_DATA = path.join(TMP, 'userdata');
const PROJECT = path.join(TMP, 'Montage.bandloop');
const SOURCE = path.join(TMP, 'signal.wav');
const PPS = 50; // zoom par défaut (pixels par seconde)
const SECONDS = 6;

let app;
let win;
let sampleRate;

async function launch() {
  const electronPath = (await import('electron')).default;
  app = await electron.launch({
    executablePath: electronPath,
    args: [ROOT, '--no-sandbox', `--user-data-dir=${USER_DATA}`, '--autoplay-policy=no-user-gesture-required'],
  });
  win = await app.firstWindow();
  await win.waitForFunction(() => window.project && window.engine);
}

async function quit() {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()));
  await app.close();
}

const menu = (id) => app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu().getMenuItemById(itemId).click(), id);

/**
 * Signal de test : chaque échantillon est (presque) unique, on peut donc dire
 * exactement de quel endroit du fichier vient chaque échantillon du rendu.
 * WAV 16 bits mono à la fréquence de la carte son (décodé sans rééchantillonnage).
 */
const sourceSample = (i) => (((i * 7919) % 65521) - 32760) >> 2; // ±8190 : loin du limiteur
function writeSignal(file, sr) {
  const n = SECONDS * sr;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(sourceSample(i), 44 + i * 2);
  fs.writeFileSync(file, b);
}

/** Clips de la piste, sans les identifiants (qui changent à la réouverture). */
const clips = () =>
  win.evaluate(() => engine.tracks[0].clips.map(({ start, offset, length }) => ({ start, offset, length })));

/** Coordonnées écran d'un instant dans la piste 0, à une hauteur donnée de la voie. */
async function at(time, yInLane) {
  const { left, top, scroll } = await win.evaluate(() => {
    const r = document.querySelector('#timeline-canvas').getBoundingClientRect();
    return { left: r.left, top: r.top, scroll: document.querySelector('#timeline').scrollLeft };
  });
  return { x: left + time * PPS - scroll, y: top + 32 + yInLane };
}
const BODY = 60; // corps du clip (forme d'onde) : sélection
const HEADER = 15; // en-tête du clip : déplacement

async function drag(from, to, { shift = false } = {}) {
  await win.mouse.move(from.x, from.y);
  await win.mouse.down();
  if (shift) await win.keyboard.down('Shift');
  for (let k = 1; k <= 12; k++)
    await win.mouse.move(from.x + ((to.x - from.x) * k) / 12, from.y + ((to.y - from.y) * k) / 12);
  await win.mouse.up();
  if (shift) await win.keyboard.up('Shift');
}

/**
 * Rend les clips de la piste hors temps réel avec la MÊME planification que la
 * lecture et l'export (scheduleClips), puis compare chaque échantillon à ce que
 * le modèle de clips prévoit : à l'instant n, l'échantillon offset + (n − début)
 * du fichier. Les 4 ms de micro-fondu aux jointures discontinues sont comptées à part.
 * @returns {{ checked: number, mismatches: number, fadeSamples: number, length: number, hash: number }}
 */
function verifyRender() {
  return win.evaluate(async () => {
    const { scheduleClips, computeFades, FADE_SECONDS } = await import('./audio/clips.js');
    const t = engine.tracks[0];
    const sr = t.sampleRate;
    const length = Math.ceil(t.end * sr) + 10;
    const ctx = new OfflineAudioContext(1, length, sr);
    scheduleClips(
      ctx,
      { buffer: t.playbackBuffer, clips: t.clips, sampleRate: sr, sourceLength: t.buffer.length },
      ctx.destination,
      0,
      0,
    );
    const out = (await ctx.startRendering()).getChannelData(0);
    const src = t.playbackBuffer.getChannelData(0); // audio lu (rendu vocal éventuel), aligné sur l'original
    const expected = new Float64Array(length);
    const inFade = new Uint8Array(length);
    const fades = computeFades(t.clips, sr, t.buffer.length);
    const fadeFrames = Math.ceil(FADE_SECONDS * sr) + 2;
    for (const c of t.clips) {
      const s0 = Math.round(c.start * sr);
      for (let k = 0; k < c.length; k++) expected[s0 + k] += src[c.offset + k];
      const f = fades.get(c.id);
      if (f.fadeIn) inFade.fill(1, s0, s0 + fadeFrames);
      if (f.fadeOut) inFade.fill(1, Math.max(0, s0 + c.length - fadeFrames), s0 + c.length);
    }
    let checked = 0;
    let mismatches = 0;
    let fadeSamples = 0;
    let hash = 2166136261;
    for (let n = 0; n < length; n++) {
      hash = Math.imul(hash ^ (Math.round(out[n] * 32768) | 0), 16777619) >>> 0;
      if (inFade[n]) {
        fadeSamples++;
        continue;
      }
      checked++;
      if (Math.abs(out[n] - expected[n]) > 1e-6) mismatches++;
    }
    return { checked, mismatches, fadeSamples, length, hash };
  });
}

/** Empreinte du mix complet (graphe d'export : effets, master, limiteur). */
function mixHash() {
  return win.evaluate(async () => {
    const { renderMix } = await import('./export/mixdown.js');
    const mix = await renderMix({ engine, hub });
    let h = 2166136261;
    for (const ch of mix.channels) for (const v of ch) h = Math.imul(h ^ (Math.round(v * 8388608) | 0), 16777619) >>> 0;
    return { h, length: mix.channels[0].length };
  });
}

before(async () => {
  await launch();
  sampleRate = await win.evaluate(() => engine.ctx.sampleRate);
  writeSignal(SOURCE, sampleRate);
  await app.evaluate(
    ({ dialog }, f) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })),
    SOURCE,
  );
  await win.click('#btn-import');
  await win.waitForFunction(() => engine.tracks.length === 1);
  // Un preset vocal sur la piste : les morceaux doivent le garder.
  await win.evaluate(() => hub.setSettings(engine.tracks[0].id, presets.settingsOf('studio'), { presetId: 'studio' }));
  await win.evaluate(() => hub.whenIdle());
});

after(async () => {
  if (app) await quit();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const sr = () => sampleRate;
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('audio importé tel quel : chaque échantillon est celui du fichier', async () => {
  const ok = await win.evaluate(
    ([n]) => {
      const d = engine.tracks[0].buffer.getChannelData(0);
      return d.length === n;
    },
    [SECONDS * sr()],
  );
  assert.ok(ok);
  const first = await win.evaluate(() => Array.from(engine.tracks[0].buffer.getChannelData(0).subarray(0, 4)));
  assert.deepEqual(
    first,
    [0, 1, 2, 3].map((i) => sourceSample(i) / 32768),
  );
});

test('découper (S) à la tête de lecture : deux morceaux bout à bout', async () => {
  // Clic dans le clip : sélection du clip et tête de lecture.
  const p = await at(1, BODY);
  await win.mouse.click(p.x, p.y);
  assert.match(await win.locator('#status').innerText(), /Clip de « signal\.wav »/);
  await win.evaluate(() => engine.seek(2));
  await win.keyboard.press('s');
  assert.deepEqual(await clips(), [
    { start: 0, offset: 0, length: 2 * sr() },
    { start: 2, offset: 2 * sr(), length: 4 * sr() },
  ]);
  // Rien n'a bougé à l'écoute : coupe en place, sans fondu.
  const r = await verifyRender();
  assert.equal(r.mismatches, 0);
  assert.equal(r.fadeSamples, 0, 'pas de fondu sur une coupe restée en place');
});

test('sélectionner une portion en glissant : surlignage, début / fin / durée affichés', async () => {
  // De 3,0 s à ~4 s (aimanté sur la graduation de 4 s).
  await drag(await at(3, BODY), await at(3.96, BODY));
  const sel = await win.evaluate(() => {
    const s = timeline.getSelection();
    return s && s.range;
  });
  assert.ok(sel, 'une portion est sélectionnée');
  assert.ok(close(sel.to, 4), `fin aimantée sur 4 s (${sel.to})`);
  assert.ok(Math.abs(sel.from - 3) < 0.03, `début ${sel.from}`);
  const status = await win.locator('#status').innerText();
  assert.match(status, /Sélection dans « signal\.wav » : 0:0\d\.\d{3} → 0:04\.000 \(durée 0:0\d\.\d{3}\)/);
});

let removed;
test('Suppr : la portion disparaît et le reste du clip se recolle', async () => {
  const { from, to } = await win.evaluate(() => timeline.getSelection().range);
  removed = { from, to };
  await win.keyboard.press('Delete');
  const a = Math.round((from - 2) * sr());
  const b = Math.round((to - 2) * sr());
  assert.deepEqual(await clips(), [
    { start: 0, offset: 0, length: 2 * sr() },
    { start: 2, offset: 2 * sr(), length: a },
    { start: 2 + a / sr(), offset: 2 * sr() + b, length: 4 * sr() - b },
  ]);
  assert.match(await win.locator('#status').innerText(), /supprimée, le reste du clip s’est recollé/);
  const r = await verifyRender();
  assert.equal(r.mismatches, 0, `${r.mismatches} échantillons faux sur ${r.checked}`);
  assert.ok(r.fadeSamples > 0 && r.fadeSamples < 0.02 * sr(), 'micro-fondus seulement à la jointure');
  assert.ok(r.checked > 0.99 * r.length, `${r.checked} échantillons vérifiés sur ${r.length}`);
});

test('déplacer un morceau par son en-tête (aimanté) puis le rogner par son bord', async () => {
  const before = await clips();
  const last = before[2];
  // Glisser l'en-tête de +1,5 s environ : le début s'aimante sur la graduation de 4 s si elle est proche.
  const x0 = last.start + 0.5;
  await drag(await at(x0, HEADER), await at(x0 + 1.5, HEADER), { shift: true }); // Maj : sans aimantation
  const moved = (await clips())[2];
  assert.equal(moved.offset, last.offset);
  assert.equal(moved.length, last.length);
  assert.ok(Math.abs(moved.start - (last.start + 1.5)) < 0.03, `début ${moved.start}`);
  assert.ok(close(moved.start * sr(), Math.round(moved.start * sr()), 1e-6), 'début calé sur un échantillon');
  // Les autres morceaux n'ont pas bougé.
  assert.deepEqual((await clips()).slice(0, 2), before.slice(0, 2));

  // Rogner la fin de 1 s (bord droit, à l'intérieur du clip).
  const end = moved.start + moved.length / sr();
  await drag(await at(end - 0.04, BODY), await at(end - 1.04, BODY), { shift: true });
  const trimmed = (await clips())[2];
  assert.equal(trimmed.start, moved.start);
  assert.equal(trimmed.offset, moved.offset);
  assert.ok(Math.abs(trimmed.length - (moved.length - sr())) < 0.03 * sr(), `longueur ${trimmed.length}`);
  const r = await verifyRender();
  assert.equal(r.mismatches, 0);
});

test('annuler / rétablir (menu Édition et boutons) : chaque étape revient exactement', async () => {
  const final = await clips();
  await menu('undo'); // rognage
  await menu('undo'); // déplacement
  const afterTwoUndos = await clips();
  assert.equal(afterTwoUndos[2].length, 4 * sr() - Math.round((removed.to - 2) * sr()));
  await menu('undo'); // suppression
  await menu('undo'); // découpe
  assert.deepEqual(await clips(), [{ start: 0, offset: 0, length: SECONDS * sr() }]);
  assert.equal(await win.locator('#btn-undo').isDisabled(), true);
  for (let i = 0; i < 4; i++) await menu('redo');
  assert.deepEqual(await clips(), final);
  assert.equal(await win.locator('#btn-redo').isDisabled(), true);
  // Boutons de la barre d'outils.
  await win.locator('#btn-undo').click();
  assert.notDeepEqual(await clips(), final);
  await win.locator('#btn-redo').click();
  assert.deepEqual(await clips(), final);
});

test('pendant un enregistrement, le montage est bloqué', async () => {
  const state = await clips();
  await win.evaluate(() => (engine.locked = true));
  await win.evaluate(() => engine.seek(1));
  const p = await at(1, BODY);
  await drag(p, await at(1.6, BODY));
  await win.keyboard.press('s');
  await win.keyboard.press('Delete');
  await menu('undo');
  await drag(await at(0.5, HEADER), await at(1.5, HEADER));
  assert.deepEqual(await clips(), state);
  assert.match(await win.locator('#status').innerText(), /impossible pendant un enregistrement/);
  await win.evaluate(() => (engine.locked = false));
});

let saved;
test('enregistrer → relancer l’application → rouvrir : montage et rendu identiques à l’échantillon', async () => {
  saved = { clips: await clips(), render: await verifyRender(), mix: await mixHash() };
  assert.equal(saved.render.mismatches, 0);
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
  await win.waitForFunction(() => engine.tracks.length === 1 && !document.querySelector('#busy:not([hidden])'));
  await win.evaluate(() => hub.whenIdle());
  assert.deepEqual(await clips(), saved.clips, 'clips identiques (débuts, décalages, longueurs en échantillons)');
  const render = await verifyRender();
  assert.equal(render.mismatches, 0);
  assert.equal(render.hash, saved.render.hash, 'rendu des clips identique au bit près');
  assert.deepEqual(await mixHash(), saved.mix, 'mix exporté identique au bit près (effets compris)');
  assert.equal(await win.evaluate(() => hub.getState(engine.tracks[0].id).presetId), 'studio', 'preset conservé');
  assert.equal(await win.locator('#btn-undo').isDisabled(), true, 'historique vide après ouverture');
});

test('supprimer un clip entier, puis Maj+Suppr sur une portion laisse un blanc', async () => {
  const before = await clips();
  // Clic sur le 2e morceau : sélection du clip, puis Suppr.
  const mid = before[1].start + before[1].length / sr() / 2;
  await win.mouse.click((await at(mid, BODY)).x, (await at(mid, BODY)).y);
  await win.keyboard.press('Delete');
  assert.deepEqual(await clips(), [before[0], before[2]]);
  // Portion de 0,5 à 1 s du 1er morceau, Maj+Suppr : pas de recollage.
  await drag(await at(0.5, BODY), await at(1, BODY), { shift: true });
  const { from, to } = await win.evaluate(() => timeline.getSelection().range);
  await win.keyboard.press('Shift+Delete');
  const c = await clips();
  const a = Math.round(from * sr());
  const b = Math.round(to * sr());
  assert.deepEqual(c.slice(0, 2), [
    { start: 0, offset: 0, length: a },
    { start: b / sr(), offset: b, length: 2 * sr() - b },
  ]);
  const r = await verifyRender();
  assert.equal(r.mismatches, 0);
});
