// Contrôleur des effets vocaux de toutes les pistes.
//
// Pour chaque piste : réglages courants, preset d'origine, contournement (bypass),
// chaîne temps réel (FxChain branchée en insert sur la piste) et rendu de l'étage
// de hauteur (Worker). Un changement de réglage :
//   - met à jour la chaîne temps réel immédiatement ;
//   - si l'étage de hauteur est concerné, relance un rendu après 250 ms sans
//     nouveau changement, puis remplace l'audio lu par la piste (sans arrêter la lecture).
import { FxChain } from './fx/FxChain.js';
import { loadWorklets, markWorkletAvailable } from './fx/nodes.js';
import {
  DEFAULT_TONALITY,
  defaultSettings,
  isNeutral,
  normalizeSettings,
  normalizeTonality,
  pitchStageSignature,
} from './settings.js';
import { VoiceRenderClient } from './VoiceRenderClient.js';

const RENDER_DEBOUNCE_MS = 250;

/** Mixage mono d'un AudioBuffer (la voix est traitée en mono). */
function toMono(buffer) {
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }
  return mono;
}

export class VocalHub extends EventTarget {
  /** @param {import('../audio/AudioEngine.js').AudioEngine} engine */
  constructor(engine) {
    super();
    this.engine = engine;
    this.client = new VoiceRenderClient();
    this.tonality = { ...DEFAULT_TONALITY };
    this.states = new Map();
    this.ready = loadWorklets(engine.ctx).then(markWorkletAvailable);
    engine.addEventListener('tracks', () => this.#syncTracks());
  }

  #syncTracks() {
    const ids = new Set(this.engine.tracks.map((t) => t.id));
    for (const track of this.engine.tracks) {
      if (this.states.has(track.id)) continue;
      const chain = new FxChain(this.engine.ctx);
      track.setInsert(chain);
      this.states.set(track.id, {
        settings: defaultSettings(),
        presetId: null,
        bypass: false,
        chain,
        signature: 'off',
        loaded: false,
        status: 'idle', // idle | pending | analyzing | rendering | ready | error
        timer: null,
      });
    }
    for (const [id, state] of this.states) {
      if (ids.has(id)) continue;
      clearTimeout(state.timer);
      state.chain.dispose();
      this.client.unload(id);
      this.states.delete(id);
    }
  }

  /** Résolue quand aucun rendu vocal n'est en attente ou en cours (avant un export). */
  whenIdle() {
    const busy = () => [...this.states.values()].some((s) => ['pending', 'analyzing', 'rendering'].includes(s.status));
    if (!busy()) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (busy()) return;
        this.removeEventListener('status', check);
        resolve();
      };
      this.addEventListener('status', check);
    });
  }

  getState(trackId) {
    return this.states.get(trackId) ?? null;
  }

  /** Effets audibles sur cette piste ? (pour l'indicateur FX) */
  hasFx(trackId) {
    const s = this.states.get(trackId);
    return !!s && !s.bypass && !isNeutral(s.settings);
  }

  /**
   * @param {object} settings
   * @param {{presetId?: string|null}} [opts]  presetId : preset appliqué (undefined = inchangé)
   */
  setSettings(trackId, settings, { presetId } = {}) {
    const state = this.states.get(trackId);
    if (!state) return;
    state.settings = normalizeSettings(settings);
    if (presetId !== undefined) state.presetId = presetId;
    this.#apply(trackId);
    this.#emit('change', trackId);
  }

  setBypass(trackId, bypass) {
    const state = this.states.get(trackId);
    if (!state) return;
    state.bypass = bypass;
    this.#apply(trackId);
    this.#emit('change', trackId);
  }

  /** La tonalité est commune au morceau : toutes les pistes corrigées sont recalculées. */
  setTonality(tonality) {
    this.tonality = normalizeTonality(tonality);
    for (const id of this.states.keys()) this.#apply(id);
    this.#emit('tonality', null);
  }

  #apply(trackId) {
    const state = this.states.get(trackId);
    state.chain.apply(state.bypass ? [] : state.settings.chain);
    const signature = state.bypass ? 'off' : pitchStageSignature(state.settings, this.tonality);
    if (signature === state.signature) return;
    state.signature = signature;
    clearTimeout(state.timer);
    if (signature === 'off') {
      this.engine.setPlaybackBuffer(trackId, null);
      this.#setStatus(trackId, 'idle');
      return;
    }
    this.#setStatus(trackId, 'pending');
    state.timer = setTimeout(() => this.#render(trackId, signature), RENDER_DEBOUNCE_MS);
  }

  async #render(trackId, signature) {
    const state = this.states.get(trackId);
    const track = this.engine.getTrack(trackId);
    if (!state || !track) return;
    if (!state.loaded) {
      this.client.load(trackId, toMono(track.buffer), track.buffer.sampleRate);
      state.loaded = true;
    }
    try {
      const { left, right } = await this.client.render(trackId, state.settings, this.tonality, (phase) => {
        if (state.signature === signature) this.#setStatus(trackId, phase);
      });
      // Les réglages ont changé pendant le calcul : un autre rendu est déjà prévu.
      if (state.signature !== signature || !this.states.has(trackId)) return;
      const buffer = this.engine.ctx.createBuffer(2, left.length, track.buffer.sampleRate);
      buffer.copyToChannel(left, 0);
      buffer.copyToChannel(right, 1);
      this.engine.setPlaybackBuffer(trackId, buffer);
      this.#setStatus(trackId, 'ready');
    } catch (err) {
      console.error(err);
      if (state.signature === signature) this.#setStatus(trackId, 'error', err.message);
    }
  }

  #setStatus(trackId, status, message = '') {
    const state = this.states.get(trackId);
    if (!state) return;
    state.status = status;
    state.error = message;
    this.#emit('status', trackId);
  }

  #emit(type, trackId) {
    this.dispatchEvent(new CustomEvent(type, { detail: { trackId } }));
  }
}
