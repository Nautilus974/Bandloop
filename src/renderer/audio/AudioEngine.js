// Moteur audio : un AudioContext, un bus master, des pistes et le transport.
//
// Toutes les pistes sont démarrées sur la même horloge (AudioContext.currentTime)
// avec une petite avance, ce qui garantit une synchronisation à l'échantillon près.
import { reorder } from './arrange.js';
import { effectiveGain } from './mixing.js';
import { Track } from './Track.js';
import { clamp } from './scheduling.js';

// Avance de planification : laisse le temps de créer toutes les sources
// avant l'instant de départ commun.
const START_LATENCY = 0.05;

// Palette Bandloop : teintes saturées mais lisibles sur fond sombre.
const TRACK_COLORS = ['#ff7a59', '#2fd4b5', '#a78bfa', '#4cc3ff', '#ff6b9e', '#ffbf47', '#8be36c'];

export class AudioEngine extends EventTarget {
  constructor(ctx = new AudioContext({ latencyHint: 'interactive' })) {
    super();
    this.ctx = ctx;
    this.master = ctx.createGain();
    // Limiteur de sécurité : harmonies et effets peuvent dépasser 0 dBFS.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);
    // Analyse du bus master pour le VU-mètre (un analyseur par canal).
    this.meterSplitter = ctx.createChannelSplitter(2);
    this.meters = [ctx.createAnalyser(), ctx.createAnalyser()];
    this.limiter.connect(this.meterSplitter);
    this.meters.forEach((analyser, i) => {
      analyser.fftSize = 1024;
      this.meterSplitter.connect(analyser, i);
    });
    this._meterData = new Float32Array(1024);
    this.tracks = [];
    this.state = 'stopped'; // 'stopped' | 'playing' | 'paused'
    this._position = 0;
    this._anchorCtxTime = 0; // instant AudioContext du dernier démarrage
    this._anchorPosition = 0; // position timeline au dernier démarrage
    // Pendant un enregistrement, le transport est verrouillé : déplacer la tête
    // décalerait la prise par rapport aux pistes.
    this.locked = false;
  }

  /** Durée du projet : fin du clip le plus long. */
  get duration() {
    return this.tracks.reduce((max, t) => Math.max(max, t.end), 0);
  }

  /** Position courante de la tête de lecture (s). */
  get position() {
    if (this.state !== 'playing') return this._position;
    return this.positionAt(this.ctx.currentTime);
  }

  /** Position de la timeline à un instant donné de l'horloge AudioContext (lecture en cours). */
  positionAt(ctxTime) {
    return this._anchorPosition + Math.max(0, ctxTime - this._anchorCtxTime);
  }

  /** Décode un fichier audio et l'ajoute comme nouvelle piste. */
  async addTrack(name, arrayBuffer) {
    const buffer = await this.ctx.decodeAudioData(arrayBuffer);
    return this.addBufferTrack(name, buffer);
  }

  /**
   * Ajoute une piste à partir d'un AudioBuffer déjà prêt (ex. prise micro).
   * @param {{ startTime?: number }} [opts]  position du clip sur la timeline (s)
   */
  addBufferTrack(name, buffer, { startTime = 0 } = {}) {
    const color = TRACK_COLORS[this.tracks.length % TRACK_COLORS.length];
    const track = new Track(this.ctx, this.master, { name, buffer, color });
    track.startTime = Math.max(0, startTime);
    this.tracks.push(track);
    this.updateGains();
    if (this.state === 'playing') track.start(this.ctx.currentTime, this.position);
    this.#emit('tracks');
    return track;
  }

  removeTrack(id) {
    if (this.locked) return;
    const track = this.tracks.find((t) => t.id === id);
    if (!track) return;
    track.dispose();
    this.tracks = this.tracks.filter((t) => t !== track);
    this.updateGains();
    if (this.tracks.length === 0) this.stop();
    this.#emit('tracks');
  }

  /** Change l'ordre des pistes (haut/bas). */
  moveTrack(id, toIndex) {
    if (this.locked) return;
    const from = this.tracks.findIndex((t) => t.id === id);
    if (from < 0 || from === toIndex) return;
    this.tracks = reorder(this.tracks, from, toIndex);
    this.#emit('tracks');
  }

  /** Déplace le clip d'une piste dans le temps (gauche/droite). */
  setTrackStart(id, startTime) {
    if (this.locked) return;
    const track = this.getTrack(id);
    if (!track) return;
    track.startTime = Math.max(0, startTime);
    // En lecture, seule cette piste est relancée à la bonne position.
    if (this.state === 'playing') track.start(this.ctx.currentTime, this.position);
    this.#emit('arrange', { id });
  }

  getTrack(id) {
    return this.tracks.find((t) => t.id === id) ?? null;
  }

  setVolume(id, db) {
    const track = this.getTrack(id);
    if (!track) return;
    track.volumeDb = db;
    this.updateGains();
  }

  setMuted(id, muted) {
    const track = this.getTrack(id);
    if (!track) return;
    track.muted = muted;
    this.updateGains();
    this.#emit('mix');
  }

  setSolo(id, solo) {
    const track = this.getTrack(id);
    if (!track) return;
    track.solo = solo;
    this.updateGains();
    this.#emit('mix');
  }

  /** Recalcule le gain de chaque piste (le solo d'une piste affecte toutes les autres). */
  updateGains() {
    const anySolo = this.tracks.some((t) => t.solo);
    for (const track of this.tracks) track.applyGain(effectiveGain(track, anySolo));
  }

  /** Une piste est-elle audible compte tenu des mute/solo ? (pour l'affichage) */
  isAudible(track) {
    return (
      effectiveGain(
        { ...track, volumeDb: 0 },
        this.tracks.some((t) => t.solo),
      ) > 0
    );
  }

  /** Remplace l'audio lu par une piste (ex. rendu d'effets), sans couper la lecture. */
  setPlaybackBuffer(id, buffer) {
    const track = this.getTrack(id);
    if (!track) return;
    track.playbackBuffer = buffer ?? track.buffer;
    if (this.state === 'playing') track.start(this.ctx.currentTime, this.position);
  }

  /** Niveaux crête instantanés du master, [gauche, droite] entre 0 et 1. */
  readMeters() {
    return this.meters.map((analyser) => {
      analyser.getFloatTimeDomainData(this._meterData);
      let peak = 0;
      for (const v of this._meterData) peak = Math.max(peak, Math.abs(v));
      return peak;
    });
  }

  /**
   * @param {{ allowEmpty?: boolean }} [opts]  allowEmpty : faire tourner le transport
   *   même sans piste ou au-delà de la fin (enregistrement).
   * @returns {Promise<{ when: number, position: number } | null>} instant et position de départ
   */
  async play({ allowEmpty = false } = {}) {
    if (this.state === 'playing') return { when: this._anchorCtxTime, position: this._anchorPosition };
    if (this.tracks.length === 0 && !allowEmpty) return null;
    // Les navigateurs suspendent l'AudioContext tant qu'il n'y a pas eu d'interaction.
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (!allowEmpty && this._position >= this.duration) this._position = 0;
    this.#startAll(this._position);
    this.#setState('playing');
    return { when: this._anchorCtxTime, position: this._anchorPosition };
  }

  pause() {
    if (this.state !== 'playing') return;
    this._position = this.position;
    this.#stopAll();
    this.#setState('paused');
  }

  stop() {
    this.#stopAll();
    this._position = 0;
    this.#setState('stopped');
  }

  seek(seconds) {
    if (this.locked) return;
    const target = clamp(seconds, 0, this.duration);
    if (this.state === 'playing') {
      this.#stopAll();
      this.#startAll(target);
    } else {
      this._position = target;
    }
    this.#emit('seek');
  }

  #startAll(position) {
    const when = this.ctx.currentTime + START_LATENCY;
    for (const track of this.tracks) track.start(when, position);
    this._anchorCtxTime = when;
    this._anchorPosition = position;
  }

  #stopAll() {
    for (const track of this.tracks) track.stop();
  }

  #setState(state) {
    this.state = state;
    this.#emit('state');
  }

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
