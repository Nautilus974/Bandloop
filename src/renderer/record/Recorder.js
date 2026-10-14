// Enregistrement au micro : accès au périphérique, VU-mètre d'entrée, compte à
// rebours, capture calée sur l'horloge audio, compensation de latence, création
// de la piste, et calibrage de la latence aller-retour.
//
// Chemin du signal :
//   micro ─ MediaStreamSource ─┬─ AnalyserNode (VU-mètre)
//                              ├─ AudioWorklet de capture ─ (gain 0) ─ sortie
//                              └─ gain « retour micro » (désactivé par défaut) ─ sortie
import { PEAKS_PER_SECOND } from '../audio/peaks.js';
import {
  computeTakePlacement,
  describeMicError,
  estimateLatency,
  makeClick,
  measureLoopbackLatency,
  takeName,
} from './latency.js';

const PREFS_KEY = 'bandloop.record.v1';
const START_AHEAD = 0.08; // marge (s) entre la commande et le premier échantillon capté
const MIN_TAKE_SECONDS = 0.15;
const DEFAULT_PREFS = { deviceId: '', countdown: 3, latencyMs: null, monitor: false, processing: false, channels: 1 };

function loadPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Annulé', 'AbortError'));
    });
  });

export class Recorder extends EventTarget {
  /**
   * @param {import('../audio/AudioEngine.js').AudioEngine} engine
   * @param {{ platform: string, requestSystemAccess?: () => Promise<string> }} system
   */
  constructor(engine, system) {
    super();
    this.engine = engine;
    this.ctx = engine.ctx;
    this.system = system;
    this.prefs = loadPrefs();
    this.state = 'idle'; // idle | opening | ready | countdown | recording | finishing | calibrating
    this.devices = [];
    this.error = null;
    this.stream = null;
    this.take = null;
    this.countdownValue = 0;
    this.workletReady = null;
    this.analyserData = new Float32Array(2048);
    // Sortie des clics de calibrage (haut-parleurs ; remplaçable pour les tests en boucle).
    this.clickOutput = null;
    navigator.mediaDevices?.addEventListener?.('devicechange', () => this.refreshDevices());
  }

  // ------------------------------------------------------------------ état

  get isOpen() {
    return !!this.source;
  }

  get busy() {
    return ['countdown', 'recording', 'finishing', 'calibrating'].includes(this.state);
  }

  /** Latence d'entrée annoncée par le périphérique (s), si connue. */
  get inputLatency() {
    return this.stream?.getAudioTracks()[0]?.getSettings?.().latency;
  }

  get autoLatency() {
    return estimateLatency({
      outputLatency: this.ctx.outputLatency,
      baseLatency: this.ctx.baseLatency,
      inputLatency: this.inputLatency,
    });
  }

  /** Latence compensée (s) : réglage manuel ou mesuré, sinon estimation automatique. */
  get latency() {
    return this.prefs.latencyMs != null ? this.prefs.latencyMs / 1000 : this.autoLatency;
  }

  get deviceLabel() {
    return this.stream?.getAudioTracks()[0]?.label ?? '';
  }

  setPrefs(patch) {
    const changed = (key) => key in patch && patch[key] !== this.prefs[key];
    const reopen = this.isOpen && !this.busy && (changed('deviceId') || changed('processing') || changed('channels'));
    Object.assign(this.prefs, patch);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
    } catch {
      // stockage indisponible : réglages valables pour la session seulement
    }
    if ('monitor' in patch && this.monitorGain)
      this.monitorGain.gain.setTargetAtTime(this.prefs.monitor ? 1 : 0, this.ctx.currentTime, 0.02);
    this.#emit('change');
    if (reopen) return this.open();
    return Promise.resolve();
  }

  // ------------------------------------------------------------------ micro

  async #ensureWorklet() {
    this.workletReady ??= this.ctx.audioWorklet.addModule(new URL('./recorder.worklet.js', import.meta.url));
    return this.workletReady;
  }

  async refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const all = await navigator.mediaDevices.enumerateDevices();
    this.devices = all
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Micro ${i + 1}` }));
    this.#emit('change');
  }

  /** Ouvre le micro (demande l'autorisation au besoin). Renvoie false en cas d'échec. */
  async open() {
    if (this.busy) return false;
    this.close();
    this.#setState('opening');
    this.error = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw Object.assign(new Error('Ce navigateur ne permet pas d’enregistrer.'), { name: 'NotSupported' });
      // macOS / Windows : autorisation système (Electron) avant celle de Chromium.
      const status = await this.system.requestSystemAccess?.();
      if (status === 'denied' || status === 'restricted')
        throw Object.assign(new Error(status), { name: 'SystemDenied' });

      const processing = this.prefs.processing;
      const audio = {
        echoCancellation: processing,
        noiseSuppression: processing,
        autoGainControl: processing,
        channelCount: { ideal: this.prefs.channels },
        sampleRate: { ideal: this.ctx.sampleRate },
        latency: { ideal: 0 },
      };
      if (this.prefs.deviceId) audio.deviceId = { exact: this.prefs.deviceId };
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio });
      } catch (err) {
        // Micro mémorisé débranché : on retombe sur le micro par défaut.
        if (err.name !== 'OverconstrainedError' && err.name !== 'NotFoundError') throw err;
        if (!this.prefs.deviceId) throw err;
        delete audio.deviceId;
        this.prefs.deviceId = '';
        stream = await navigator.mediaDevices.getUserMedia({ audio });
      }
      await this.#ensureWorklet();
      this.#connect(this.ctx.createMediaStreamSource(stream), stream);
      stream.getAudioTracks()[0]?.addEventListener('ended', () => this.#onDeviceLost());
      await this.refreshDevices();
      this.#setState('ready');
      return true;
    } catch (err) {
      console.warn('Ouverture du micro impossible :', err);
      this.close();
      this.error = describeMicError(err, this.system.platform);
      this.#setState('idle');
      return false;
    }
  }

  /** Remplace le micro par un nœud quelconque (tests, boucle de vérification du calage). */
  async useSource(node) {
    this.close();
    await this.#ensureWorklet();
    this.#connect(node, null);
    this.#setState('ready');
  }

  #connect(source, stream) {
    this.stream = stream;
    this.source = source;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.monitorGain = this.ctx.createGain();
    this.monitorGain.gain.value = this.prefs.monitor ? 1 : 0;
    this.node = new AudioWorkletNode(this.ctx, 'bandloop-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      // Mono : les canaux de l'entrée sont mélangés ((G + D) / 2) ; stéréo : gardés.
      channelCount: this.prefs.channels,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0; // le nœud de capture doit être relié à la sortie pour être exécuté
    source.connect(this.analyser);
    source.connect(this.node);
    source.connect(this.monitorGain);
    this.monitorGain.connect(this.ctx.destination);
    this.node.connect(this.sink);
    this.sink.connect(this.ctx.destination);
    this.node.port.onmessage = ({ data }) => this.#onWorkletMessage(data);
  }

  close() {
    if (this.busy) return;
    for (const n of [this.source, this.analyser, this.monitorGain, this.node, this.sink]) n?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source = this.analyser = this.monitorGain = this.node = this.sink = this.stream = null;
    if (this.state === 'ready') this.#setState('idle');
  }

  #onDeviceLost() {
    const wasRecording = this.state === 'recording';
    this.error = {
      title: 'Micro déconnecté',
      text: 'Le micro a été débranché ou coupé par le système.',
      canOpenSettings: false,
    };
    if (wasRecording) this.stop();
    else {
      this.close();
      this.#setState('idle');
    }
  }

  /** Crête récente du signal d'entrée (0..1+). */
  readLevel() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.analyserData);
    let peak = 0;
    for (const v of this.analyserData) peak = Math.max(peak, Math.abs(v));
    return peak;
  }

  // ------------------------------------------------------------------ enregistrement

  /** Compte à rebours puis enregistrement à partir de la tête de lecture. */
  async record() {
    if (this.busy) return;
    if (!this.isOpen && !(await this.open())) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.abort = new AbortController();
    this.error = null;

    // Compte à rebours (transport arrêté, tête immobile).
    if (this.engine.state === 'playing') this.engine.pause();
    try {
      for (let n = this.prefs.countdown; n > 0; n--) {
        this.countdownValue = n;
        this.#setState('countdown');
        this.#beep(n === 1 ? 1320 : 880);
        await sleep(1000, this.abort.signal);
      }
    } catch {
      this.countdownValue = 0;
      this.#setState('ready');
      return;
    }
    this.countdownValue = 0;

    // Démarrage commun : la lecture des pistes (guide) et la capture partent
    // de la même trame de l'horloge audio.
    this.engine.locked = true;
    const { when } = await this.engine.play({ allowEmpty: true });
    const startCtx = Math.max(when, this.ctx.currentTime + START_AHEAD);
    const startFrame = Math.round(startCtx * this.ctx.sampleRate);
    const latency = this.latency;
    const channels = this.prefs.channels === 2 ? 2 : 1;
    this.take = {
      startPosition: this.engine.positionAt(startFrame / this.ctx.sampleRate),
      latency,
      channels,
      chunks: [],
      length: 0,
      peaks: { min: [], max: [] },
      bucket: Math.max(1, Math.round(this.ctx.sampleRate / PEAKS_PER_SECOND)),
      partial: { min: 0, max: 0, n: 0 },
    };
    this.node.port.postMessage({ type: 'start', startFrame, channels });
    this.#setState('recording');
  }

  /** Arrête l'enregistrement et crée la piste. Renvoie la piste (ou null). */
  async stop() {
    if (this.state === 'countdown') {
      this.abort?.abort();
      return null;
    }
    if (this.state !== 'recording') return null;
    this.#setState('finishing');
    const done = new Promise((resolve) => {
      this.onDone = resolve;
      setTimeout(resolve, 1500); // sécurité si le thread audio ne répond plus
    });
    this.node?.port.postMessage({ type: 'stop', stopFrame: Math.round(this.ctx.currentTime * this.ctx.sampleRate) });
    if (this.node) await done;
    this.engine.pause();
    this.engine.locked = false;

    const take = this.take;
    this.take = null;
    const track = this.#createTrack(take);
    this.#setState(this.isOpen ? 'ready' : 'idle');
    if (this.error) this.#emit('change');
    return track;
  }

  /** Abandonne la prise en cours (ou le compte à rebours). */
  async cancel() {
    if (this.state === 'countdown') return this.stop();
    if (this.state !== 'recording') return;
    this.take.discard = true;
    await this.stop();
  }

  #createTrack(take) {
    if (!take || take.discard) return null;
    const { sampleRate } = this.ctx;
    const placement = computeTakePlacement({ startPosition: take.startPosition, latency: take.latency, sampleRate });
    const length = take.length - placement.trimSamples;
    if (length < MIN_TAKE_SECONDS * sampleRate) {
      this.#emit('message', { text: 'Prise trop courte : rien n’a été ajouté.' });
      return null;
    }
    const buffer = this.ctx.createBuffer(take.channels, length, sampleRate);
    for (let ch = 0; ch < take.channels; ch++) {
      const data = new Float32Array(take.length);
      let offset = 0;
      for (const chunk of take.chunks) {
        data.set(chunk[ch], offset);
        offset += chunk[ch].length;
      }
      buffer.copyToChannel(data.subarray(placement.trimSamples), ch);
    }
    const name = takeName(this.engine.tracks.map((t) => t.name));
    const track = this.engine.addBufferTrack(name, buffer, { startTime: placement.startTime });
    this.#emit('take', { track, latency: take.latency });
    return track;
  }

  #onWorkletMessage(data) {
    if (data.type === 'done') return this.onDone?.();
    if (data.type !== 'chunk') return;
    const target = this.calibration ?? this.take;
    if (!target) return;
    target.chunks.push(data.data);
    target.length += data.data[0].length;
    if (target.peaks) this.#appendPeaks(target, data.data);
  }

  /** Forme d'onde au fil de l'eau, pour l'afficher pendant l'enregistrement. */
  #appendPeaks(take, channels) {
    const p = take.partial;
    for (let i = 0; i < channels[0].length; i++) {
      for (const c of channels) {
        if (c[i] < p.min) p.min = c[i];
        if (c[i] > p.max) p.max = c[i];
      }
      if (++p.n === take.bucket) {
        take.peaks.min.push(p.min);
        take.peaks.max.push(p.max);
        p.min = p.max = p.n = 0;
      }
    }
  }

  /** Informations pour dessiner la prise en cours sur la timeline. */
  get liveTake() {
    if (this.state !== 'recording' && this.state !== 'finishing') return null;
    const t = this.take;
    if (!t) return null;
    return {
      startTime: Math.max(0, t.startPosition - t.latency),
      duration: t.length / this.ctx.sampleRate,
      peaks: t.peaks,
      peaksPerSecond: this.ctx.sampleRate / t.bucket,
    };
  }

  #beep(freq) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const t = this.ctx.currentTime;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + 0.13);
  }

  // ------------------------------------------------------------------ calibrage

  /**
   * Mesure la latence aller-retour réelle : des clics sont joués par les
   * haut-parleurs et enregistrés par le micro ; leur retard est la latence.
   * À faire avec les haut-parleurs (pas au casque), dans le calme.
   */
  async calibrate() {
    if (this.busy) return { ok: false, reason: 'Occupé.' };
    if (!this.isOpen && !(await this.open())) return { ok: false, reason: this.error?.text ?? 'Micro indisponible.' };
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.#setState('calibrating');
    const { sampleRate } = this.ctx;
    const click = makeClick(sampleRate);
    const startCtx = this.ctx.currentTime + 0.2;
    const startFrame = Math.round(startCtx * sampleRate);
    const clickFrames = [0.5, 1.1, 1.7, 2.3, 2.9, 3.5].map((t) => Math.round(t * sampleRate));
    const clickBuffer = this.ctx.createBuffer(1, click.length, sampleRate);
    clickBuffer.copyToChannel(click, 0);
    for (const f of clickFrames) {
      const src = this.ctx.createBufferSource();
      src.buffer = clickBuffer;
      src.connect(this.clickOutput ?? this.ctx.destination);
      src.start((startFrame + f) / sampleRate);
    }
    this.calibration = { chunks: [], length: 0 };
    this.node.port.postMessage({ type: 'start', startFrame, channels: 1 });
    await sleep(4300);
    const done = new Promise((resolve) => {
      this.onDone = resolve;
      setTimeout(resolve, 1500);
    });
    this.node.port.postMessage({ type: 'stop', stopFrame: Math.round(this.ctx.currentTime * sampleRate) });
    await done;

    const rec = new Float32Array(this.calibration.length);
    let offset = 0;
    for (const [c] of this.calibration.chunks) {
      rec.set(c, offset);
      offset += c.length;
    }
    this.calibration = null;
    const result = measureLoopbackLatency(rec, sampleRate, clickFrames, click);
    this.#setState('ready');
    if (result.ok) await this.setPrefs({ latencyMs: Math.round(result.latency * 1000) });
    return result;
  }

  // ------------------------------------------------------------------

  #setState(state) {
    this.state = state;
    this.#emit('change');
  }

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
