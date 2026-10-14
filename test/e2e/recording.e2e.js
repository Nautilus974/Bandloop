// Tests de bout en bout de l'enregistrement, dans la vraie application Electron.
// Micro simulé par Chromium à partir de samples/voix.wav.
//
//   npm run test:e2e          (Linux sans écran : xvfb-run -a npm run test:e2e)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VOICE = path.join(ROOT, 'samples/voix.wav');

let app;
let win;

before(async () => {
  assert.ok(fs.existsSync(VOICE), 'Lance d’abord « npm run samples ».');
  const electronPath = (await import('electron')).default;
  app = await electron.launch({
    executablePath: electronPath,
    args: [
      ROOT,
      '--no-sandbox',
      `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'bandloop-e2e-'))}`,
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${VOICE}`,
    ],
  });
  win = await app.firstWindow();
  await win.waitForFunction(() => window.project && window.engine); // application prête
});

after(async () => {
  // Fermeture forcée : sinon la confirmation « Enregistrer les modifications ? » attendrait une réponse.
  await app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy())).catch(() => {});
  await app?.close().catch(() => {});
});

test('calage : les clics de la prise tombent sur ceux de la piste guide (boucle virtuelle de 120 ms)', async () => {
  const r = await win.evaluate(async () => {
    const sr = engine.ctx.sampleRate;
    const guide = engine.ctx.createBuffer(1, 4 * sr, sr);
    const g = guide.getChannelData(0);
    for (const t of [1, 2, 3])
      for (let k = 0; k < 24; k++) g[Math.round(t * sr) + k] = 0.8 * Math.sin((Math.PI * k) / 24);
    const guideTrack = engine.addBufferTrack('guide', guide);

    // Sortie master -> retard 120 ms -> entrée de l'enregistreur (simule haut-parleurs -> micro).
    const delay = engine.ctx.createDelay(1);
    delay.delayTime.value = 0.12;
    engine.master.connect(delay);
    await recorder.useSource(delay);

    const clickOffsets = (track) => {
      const d = track.buffer.getChannelData(0);
      const out = [];
      for (let i = 1; i < d.length; i++) {
        if (Math.abs(d[i]) > 0.3 && Math.abs(d[i - 1]) <= 0.3) {
          let j = i;
          while (j > 0 && Math.abs(d[j - 1]) > 1e-4) j--;
          const t = track.startTime + j / sr;
          out.push((t - Math.round(t)) * 1000);
          i += sr / 4;
        }
      }
      return out;
    };
    const take = async (latencyMs) => {
      await recorder.setPrefs({ countdown: 0, latencyMs });
      engine.seek(0.5);
      await recorder.record();
      await new Promise((res) => setTimeout(res, 3300));
      const t = await recorder.stop();
      const offsets = clickOffsets(t);
      engine.removeTrack(t.id);
      return offsets;
    };
    const compensated = await take(120);
    const raw = await take(0);
    recorder.clickOutput = engine.master;
    const calibration = await recorder.calibrate();
    recorder.clickOutput = null;
    engine.master.disconnect(delay);
    recorder.close();
    engine.removeTrack(guideTrack.id);
    await recorder.setPrefs({ latencyMs: null, countdown: 3 });
    return { compensated, raw, calibration };
  });
  assert.equal(r.compensated.length, 3);
  for (const ms of r.compensated) assert.ok(Math.abs(ms) < 0.1, `décalage ${ms} ms`);
  for (const ms of r.raw) assert.ok(Math.abs(ms - 120) < 0.1, `sans compensation : ${ms} ms`);
  assert.ok(r.calibration.ok, r.calibration.reason);
  assert.ok(Math.abs(r.calibration.latency - 0.12) < 0.001, `calibrage ${r.calibration.latency}`);
});

test('prise au micro : nouvelle piste calée sur la tête, mixable, presets applicables', async () => {
  await win.evaluate(async () => {
    await recorder.setPrefs({ countdown: 0 });
    // Un guide pour que la tête puisse aller à 1,5 s.
    const sr = engine.ctx.sampleRate;
    engine.addBufferTrack('guide', engine.ctx.createBuffer(1, 3 * sr, sr));
    engine.seek(1.5);
  });
  await win.click('#btn-record');
  await win.waitForFunction(() => recorder.state === 'recording', null, { timeout: 10000 });
  await win.waitForTimeout(2500);
  assert.equal(await win.evaluate(() => engine.tracks[0].source !== null), true, 'le guide joue pendant la prise');
  await win.keyboard.press('Space');
  await win.waitForFunction(() => engine.tracks.some((t) => t.name === 'Prise 1'));

  const take = await win.evaluate(() => {
    const t = engine.tracks.find((x) => x.name === 'Prise 1');
    return {
      start: t.startTime,
      duration: t.duration,
      latency: recorder.latency,
      peaks: t.peaks.max.length,
      selected: document.querySelector('.track.selected .track-name')?.textContent,
      locked: engine.locked,
    };
  });
  assert.ok(Math.abs(take.start - (1.5 - take.latency)) < 0.06, `début ${take.start} (latence ${take.latency})`);
  assert.ok(take.duration > 2, `durée ${take.duration}`);
  assert.ok(take.peaks > 0, 'forme d’onde calculée');
  assert.equal(take.selected, 'Prise 1');
  assert.equal(take.locked, false);

  // Mixage et presets sur la prise, comme sur une piste importée.
  const row = win.locator('.track', { hasText: 'Prise 1' });
  await row.locator('.btn-mute').click();
  await row.locator('.btn-mute').click();
  await row.locator('.fader').fill('-3');
  await row.locator('.btn-fx').click();
  await win.locator('.preset-card', { hasText: 'Studio' }).click();
  await win.waitForFunction(
    () => hub.getState(engine.tracks.find((t) => t.name === 'Prise 1').id).status === 'ready',
    null,
    { timeout: 30000 },
  );
  const mix = await win.evaluate(() => {
    const t = engine.tracks.find((x) => x.name === 'Prise 1');
    return { vol: t.volumeDb, muted: t.muted, fx: hub.hasFx(t.id), processed: t.playbackBuffer !== t.buffer };
  });
  assert.deepEqual(mix, { vol: -3, muted: false, fx: true, processed: true });
});

test('sécurité : avec le gestionnaire de main.js, micro accordé mais caméra refusée', async () => {
  const result = await win.evaluate(async () => {
    const tryGet = (constraints) =>
      navigator.mediaDevices.getUserMedia(constraints).then(
        (stream) => {
          stream.getTracks().forEach((t) => t.stop());
          return 'accordé';
        },
        (e) => e.name,
      );
    return {
      audio: await tryGet({ audio: true }),
      video: await tryGet({ video: true }),
      both: await tryGet({ audio: true, video: true }),
    };
  });
  assert.equal(result.audio, 'accordé');
  assert.equal(result.video, 'NotAllowedError');
  assert.equal(result.both, 'NotAllowedError');
});

test('accès au micro refusé : message clair, transport non bloqué', async () => {
  // Le système refuse toute demande de micro.
  await app.evaluate(({ session }) =>
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false)),
  );
  await win.evaluate(() => recorder.close());
  await win.keyboard.press('KeyR');
  await win.waitForSelector('.rp-error', { timeout: 10000 });
  const text = await win.locator('.rp-error').innerText();
  assert.match(text, /Accès au micro refusé/);
  assert.match(text, /Autorise-le/);
  assert.deepEqual(await win.evaluate(() => [recorder.state, engine.locked]), ['idle', false]);
});
