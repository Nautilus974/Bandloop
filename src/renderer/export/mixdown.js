// Rendu du mix complet hors temps réel (OfflineAudioContext), avec exactement
// le même graphe que la lecture : audio de chaque piste (rendu vocal compris),
// chaîne d'effets temps réel, panoramique, volume × mute × solo, bus master et
// limiteur. Puis limiteur brickwall à anticipation pour garantir l'absence de
// saturation.
import { scheduleClips } from '../audio/clips.js';
import { effectiveGain } from '../audio/mixing.js';
import { limitPeaks, peakOf } from '../project/limiter.js';
import { FxChain } from '../vocal/fx/FxChain.js';
import { loadWorklets } from '../vocal/fx/nodes.js';

export const EXPORT_CEILING_DB = -1;
const SILENCE = 1e-4; // -80 dBFS
const MAX_TAIL = 12;

export class ExportError extends Error {}

/** Durée de traîne à rendre après la dernière note (réverb, delay). */
export function tailSeconds(chains) {
  let tail = 0.5;
  for (const chain of chains) {
    for (const m of chain) {
      if (!m.enabled) continue;
      if (m.type === 'reverb') tail = Math.max(tail, m.params.decay * 1.1 + m.params.preDelay / 1000);
      if (m.type === 'delay' && m.params.feedback > 0) {
        // Temps pour que les répétitions tombent à -60 dB.
        const repeats = Math.log(0.001) / Math.log(m.params.feedback / 100);
        tail = Math.max(tail, (repeats * m.params.time) / 1000);
      }
    }
  }
  return Math.min(MAX_TAIL, tail);
}

/** Longueur utile : coupe le silence final au-delà de la fin du dernier clip (+0,25 s). */
export function trimmedLength(channels, sampleRate, minLength) {
  let last = 0;
  for (const ch of channels) {
    for (let i = ch.length - 1; i > last; i--) {
      if (Math.abs(ch[i]) > SILENCE) {
        last = i;
        break;
      }
    }
  }
  return Math.min(channels[0].length, Math.max(minLength, last + Math.round(0.25 * sampleRate)));
}

/**
 * @param {object} p
 * @param {import('../audio/AudioEngine.js').AudioEngine} p.engine
 * @param {import('../vocal/VocalHub.js').VocalHub} p.hub
 * @param {number} [p.sampleRate]
 * @param {(fraction: number) => void} [p.onProgress]
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<{ channels: Float32Array[], sampleRate: number, peakBefore: number, reductionDb: number }>}
 */
export async function renderMix({ engine, hub, sampleRate = engine.ctx.sampleRate, onProgress = () => {}, signal }) {
  const anySolo = engine.tracks.some((t) => t.solo);
  const audible = engine.tracks.filter((t) => effectiveGain(t, anySolo) > 0);
  if (!audible.length)
    throw new ExportError('Rien à exporter : toutes les pistes sont muettes (ou le projet est vide).');

  const chains = audible.map((t) => {
    const state = hub.getState(t.id);
    return state && !state.bypass ? state.settings.chain : [];
  });
  const end = Math.max(0, ...audible.map((t) => t.end));
  if (end <= 0) throw new ExportError('Rien à exporter : les pistes audibles n’ont plus aucun clip.');
  const duration = end + tailSeconds(chains);
  const length = Math.ceil(duration * sampleRate);
  const ctx = new OfflineAudioContext(2, length, sampleRate);
  await loadWorklets(ctx);

  // Bus master identique à la lecture (limiteur de sécurité compris).
  const master = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;
  master.connect(limiter).connect(ctx.destination);

  audible.forEach((track, i) => {
    const chain = new FxChain(ctx);
    chain.apply(chains[i]);
    const panner = ctx.createStereoPanner();
    panner.pan.value = track.pan;
    const fader = ctx.createGain();
    fader.gain.value = effectiveGain(track, anySolo);
    chain.output.connect(panner).connect(fader).connect(master);
    // Clips de la piste, joués comme en lecture (audio d'origine ou rendu vocal ;
    // toujours le rendu, même si on écoute la voix brute en A/B).
    scheduleClips(
      ctx,
      {
        buffer: hub?.exportBuffer?.(track.id) ?? track.playbackBuffer,
        clips: track.clips,
        sampleRate: track.sampleRate,
        sourceLength: track.buffer.length,
      },
      chain.input,
      0,
      0,
    );
  });

  // Progression : le rendu est suspendu chaque seconde de son pour la signaler.
  let aborted = false;
  const step = Math.max(0.5, duration / 100);
  for (let t = step; t < duration; t += step) {
    ctx.suspend(t).then(() => {
      if (signal?.aborted) {
        aborted = true;
        return; // rendu laissé suspendu : abandonné
      }
      onProgress(t / duration);
      ctx.resume();
    });
  }
  const rendered = await Promise.race([
    ctx.startRendering(),
    new Promise((_, reject) =>
      signal?.addEventListener('abort', () => reject(new DOMException('Export annulé', 'AbortError'))),
    ),
  ]);
  if (aborted || signal?.aborted) throw new DOMException('Export annulé', 'AbortError');
  onProgress(1);

  const full = [rendered.getChannelData(0), rendered.getChannelData(1)];
  const keep = trimmedLength(full, sampleRate, Math.ceil(end * sampleRate));
  const channels = full.map((c) => c.slice(0, keep));
  const peakBefore = peakOf(channels);
  const { reductionDb } = limitPeaks(channels, sampleRate, { ceiling: Math.pow(10, EXPORT_CEILING_DB / 20) });
  return { channels, sampleRate, peakBefore, reductionDb };
}
