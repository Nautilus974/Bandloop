// Export du mix : choix du fichier, attente des rendus vocaux, rendu hors temps
// réel, limiteur, encodage WAV ou MP3, écriture sur disque.
import { encodeWav } from '../project/wav.js';
import { ExportError, renderMix } from './mixdown.js';

/** @typedef {{ format: 'wav'|'mp3', bitDepth?: 16|24, kbps?: 128|192|320 }} ExportOptions */

function encodeMp3(channels, sampleRate, kbps, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./mp3-worker.js', import.meta.url));
    const abort = () => {
      worker.terminate();
      reject(new DOMException('Export annulé', 'AbortError'));
    };
    signal?.addEventListener('abort', abort);
    worker.onmessage = ({ data }) => {
      if (data.progress !== undefined) return onProgress(data.progress);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      if (data.error) reject(new Error(`Encodage MP3 impossible : ${data.error}`));
      else resolve(data.bytes);
    };
    worker.onerror = (e) => {
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      reject(new Error(`Encodage MP3 impossible : ${e.message}`));
    };
    const copies = channels.map((c) => c.slice());
    worker.postMessage(
      { channels: copies, sampleRate, kbps },
      copies.map((c) => c.buffer),
    );
  });
}

export class ExportManager {
  /**
   * @param {{ engine: object, hub: object, io: object }} deps
   */
  constructor({ engine, hub, io }) {
    Object.assign(this, { engine, hub, io });
  }

  /**
   * @param {ExportOptions} options
   * @param {string} path  destination (déjà choisie)
   * @param {{ onPhase: (text: string, fraction: number) => void, signal?: AbortSignal }} ui
   * @returns {Promise<{ path: string, size: number, duration: number, reductionDb: number, peakBefore: number }>}
   */
  async run(options, path, { onPhase, signal }) {
    if (!this.engine.tracks.length) throw new ExportError('Le projet est vide : ajoute une piste avant d’exporter.');
    if (this.engine.state === 'playing') this.engine.pause();

    onPhase('Préparation des effets vocaux…', 0);
    await this.hub.whenIdle();

    // Le MP3 n'accepte que 32 / 44,1 / 48 kHz : au-delà, le rendu est fait à 48 kHz.
    const sampleRate =
      options.format === 'mp3' ? Math.min(this.engine.ctx.sampleRate, 48000) : this.engine.ctx.sampleRate;
    const mix = await renderMix({
      engine: this.engine,
      hub: this.hub,
      sampleRate,
      signal,
      onProgress: (f) => onPhase('Rendu des pistes et des effets…', 0.05 + f * 0.65),
    });
    onPhase('Limiteur et préparation du fichier…', 0.72);
    let bytes;
    if (options.format === 'mp3') {
      bytes = await encodeMp3(
        mix.channels,
        mix.sampleRate,
        options.kbps ?? 320,
        (f) => onPhase('Encodage MP3…', 0.72 + f * 0.25),
        signal,
      );
    } else {
      bytes = encodeWav(mix.channels, mix.sampleRate, { bitDepth: options.bitDepth ?? 24 });
    }
    if (signal?.aborted) throw new DOMException('Export annulé', 'AbortError');
    onPhase('Écriture du fichier…', 0.98);
    const result = await this.io.writeFile(path, bytes, 'export');
    if (result?.error) throw new ExportError(result.error.message);
    onPhase('Terminé', 1);
    return {
      path: result?.path ?? path,
      size: bytes.byteLength,
      duration: mix.channels[0].length / mix.sampleRate,
      reductionDb: mix.reductionDb,
      peakBefore: mix.peakBefore,
    };
  }
}

/** Estimation de la taille du fichier exporté (octets). */
export function estimateExportSize({ format, bitDepth = 24, kbps = 320 }, seconds, sampleRate) {
  if (format === 'mp3') return (kbps * 1000 * seconds) / 8;
  return 44 + seconds * sampleRate * 2 * (bitDepth / 8);
}
