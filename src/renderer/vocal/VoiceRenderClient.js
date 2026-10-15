// Client du moteur de rendu : envoie les travaux au Web Worker, ou les exécute
// sur le thread principal si le Worker ne peut pas être créé.
import { VoiceRenderer } from './VoiceRenderer.js';

export class VoiceRenderClient {
  constructor() {
    this.pending = new Map();
    this.nextId = 1;
    try {
      this.worker = new Worker(new URL('./voice-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }) => this.#onMessage(data);
      this.worker.onerror = (e) => {
        console.warn('Worker vocal indisponible, rendu sur le thread principal.', e.message);
        this.#fallback();
      };
    } catch (err) {
      console.warn('Worker vocal indisponible, rendu sur le thread principal.', err);
      this.#fallback();
    }
  }

  #fallback() {
    this.worker?.terminate();
    this.worker = null;
    this.inline ??= new VoiceRenderer();
    // Rejoue les pistes déjà chargées et les rendus en attente.
    for (const [trackId, args] of this.loaded ?? []) this.inline.load(trackId, ...args);
    for (const job of this.pending.values()) this.#runInline(job);
  }

  /** @param {Float32Array} mono  copie de la voix (transférée au Worker) */
  load(trackId, mono, sampleRate) {
    (this.loaded ??= new Map()).set(trackId, [mono, sampleRate]);
    if (this.worker) this.worker.postMessage({ type: 'load', trackId, mono: mono.slice(), sampleRate });
    else (this.inline ??= new VoiceRenderer()).load(trackId, mono, sampleRate);
  }

  unload(trackId) {
    this.loaded?.delete(trackId);
    if (this.worker) this.worker.postMessage({ type: 'unload', trackId });
    else this.inline?.unload(trackId);
  }

  /**
   * @returns {Promise<{left: Float32Array, right: Float32Array, curves: object}>}
   * @param {(phase: string) => void} [onPhase]  'analyzing' puis 'rendering'
   */
  render(trackId, settings, tonality, onPhase) {
    return new Promise((resolve, reject) => {
      const job = { id: this.nextId++, trackId, settings, tonality, resolve, reject, onPhase };
      this.pending.set(job.id, job);
      if (this.worker) this.worker.postMessage({ type: 'render', id: job.id, trackId, settings, tonality });
      else this.#runInline(job);
    });
  }

  #runInline(job) {
    // Laisse l'interface se mettre à jour avant le calcul bloquant.
    setTimeout(() => {
      if (!this.pending.has(job.id)) return;
      try {
        job.onPhase?.('rendering');
        const result = this.inline.render(job.trackId, job.settings, job.tonality);
        this.#onMessage({ id: job.id, ok: true, ...result });
      } catch (err) {
        this.#onMessage({ id: job.id, ok: false, error: String(err?.message ?? err) });
      }
    }, 30);
  }

  #onMessage({ id, phase, ok, left, right, curves, error }) {
    const job = this.pending.get(id);
    if (!job) return;
    if (phase) return job.onPhase?.(phase);
    this.pending.delete(id);
    if (ok) job.resolve({ left, right, curves });
    else job.reject(new Error(error));
  }
}
