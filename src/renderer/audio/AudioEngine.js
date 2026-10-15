// Moteur audio : un AudioContext, un bus master, des pistes et le transport.
//
// Toutes les pistes sont démarrées sur la même horloge (AudioContext.currentTime)
// avec une petite avance, ce qui garantit une synchronisation à l'échantillon près.
import { reorder } from './arrange.js';
import { newClipId, sortClips } from './clips.js';
import { effectiveGain } from './mixing.js';
import { Track } from './Track.js';
import { clamp } from './scheduling.js';

// Avance de planification : laisse le temps de créer toutes les sources
// avant l'instant de départ commun.
const START_LATENCY = 0.05;

const EDIT_EVENTS = new Set(['tracks', 'mix', 'arrange', 'volume', 'pan']);

// Palette Bandloop : teintes saturées mais lisibles sur fond sombre. Les sept
// premières sont attribuées à tour de rôle aux nouvelles pistes ; toutes sont
// proposées dans le menu « Couleur » d'une piste.
export const TRACK_COLORS = [
  '#ff7a59',
  '#2fd4b5',
  '#a78bfa',
  '#4cc3ff',
  '#ff6b9e',
  '#ffbf47',
  '#8be36c',
  '#f25555',
  '#c4a77d',
  '#9aa4b5',
];
export const TRACK_NAME_MAX = 40;

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

  /**
   * Décode un fichier audio et l'ajoute comme nouvelle piste. Les octets
   * d'origine sont conservés pour être embarqués tels quels dans le projet
   * (decodeAudioData détruit le tampon qu'on lui donne : on décode une copie).
   */
  async addTrack(name, arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer.slice(0));
    const buffer = await this.ctx.decodeAudioData(arrayBuffer);
    return this.addBufferTrack(name, buffer, { origin: { kind: 'file', name, bytes } });
  }

  /**
   * Ajoute une piste à partir d'un AudioBuffer déjà prêt (ex. prise micro).
   * @param {{ startTime?: number }} [opts]  position du clip sur la timeline (s)
   */
  addBufferTrack(name, buffer, { startTime = 0, origin = { kind: 'take' }, color } = {}) {
    const track = new Track(this.ctx, this.master, {
      name,
      buffer,
      color: color ?? TRACK_COLORS[this.tracks.length % TRACK_COLORS.length],
    });
    track.startTime = Math.max(0, startTime);
    // Origine de l'audio : fichier importé (octets d'origine) ou prise micro.
    // (Ne pas confondre avec track.source, le nœud de lecture en cours.)
    track.origin = origin;
    this.tracks.push(track);
    this.updateGains();
    if (this.state === 'playing') track.start(this.ctx.currentTime, this.position);
    this.#emit('tracks');
    return track;
  }

  /** Renomme une piste (espaces en trop retirés, 40 caractères au plus). @returns {boolean} changé */
  renameTrack(id, name) {
    const track = this.getTrack(id);
    const clean = String(name ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, TRACK_NAME_MAX);
    if (!track || !clean || clean === track.name) return false;
    track.name = clean;
    this.#emit('tracks');
    return true;
  }

  /** @returns {boolean} changé */
  setTrackColor(id, color) {
    const track = this.getTrack(id);
    if (!track || !/^#[0-9a-f]{6}$/i.test(color) || color === track.color) return false;
    track.color = color;
    this.#emit('tracks');
    return true;
  }

  /**
   * Duplique une piste juste en dessous : même audio (partagé, non copié),
   * mêmes clips, même mixage et même couleur. Les effets vocaux sont copiés par
   * l'appelant (ils appartiennent au moteur vocal).
   */
  duplicateTrack(id, name) {
    if (this.locked) return null;
    const source = this.getTrack(id);
    if (!source) return null;
    const copy = this.addBufferTrack(name, source.buffer, { origin: source.origin, color: source.color });
    copy.setClips(source.clips.map((c) => ({ ...c, id: newClipId() })));
    copy.volumeDb = source.volumeDb;
    copy.setPan(source.pan);
    copy.muted = source.muted;
    copy.solo = source.solo;
    this.tracks = reorder(this.tracks, this.tracks.indexOf(copy), this.tracks.indexOf(source) + 1);
    this.updateGains();
    if (this.state === 'playing') copy.start(this.ctx.currentTime, this.position);
    this.#emit('tracks');
    this.#emit('mix');
    return copy;
  }

  /**
   * Retire une piste du projet SANS la détruire, pour pouvoir l'y remettre
   * (annulation d'une suppression).
   * @returns {{ track: Track, index: number } | null}
   */
  detachTrack(id) {
    if (this.locked) return null;
    const index = this.tracks.findIndex((t) => t.id === id);
    if (index < 0) return null;
    const track = this.tracks[index];
    track.stop();
    track.fader.disconnect();
    this.tracks.splice(index, 1);
    this.updateGains();
    if (this.tracks.length === 0) this.stop();
    this.#emit('tracks');
    return { track, index };
  }

  /** Remet une piste retirée par detachTrack, à sa place. */
  attachTrack(track, index) {
    if (this.locked || this.tracks.includes(track)) return;
    track.fader.connect(this.master);
    this.tracks.splice(Math.max(0, Math.min(index, this.tracks.length)), 0, track);
    this.updateGains();
    if (this.state === 'playing') track.start(this.ctx.currentTime, this.position);
    this.#emit('tracks');
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

  /** Déplace tous les clips d'une piste dans le temps (gauche/droite). */
  setTrackStart(id, startTime) {
    if (this.locked) return;
    const track = this.getTrack(id);
    if (!track) return;
    track.startTime = Math.max(0, startTime);
    this.#afterClipsChange(track);
  }

  /** Remplace les clips d'une piste (découpe, rognage, suppression, déplacement). */
  setClips(id, clips) {
    if (this.locked) return false;
    const track = this.getTrack(id);
    if (!track) return false;
    track.setClips(clips);
    this.#afterClipsChange(track);
    return true;
  }

  /** Déplace un clip dans le temps. */
  moveClip(trackId, clipId, start) {
    const track = this.getTrack(trackId);
    if (!track) return;
    this.setClips(
      trackId,
      track.clips.map((c) => (c.id === clipId ? { ...c, start: Math.max(0, start) } : c)),
    );
  }

  #afterClipsChange(track) {
    // En lecture, seule cette piste est relancée à la bonne position.
    if (this.state === 'playing') track.start(this.ctx.currentTime, this.position);
    this.#emit('arrange', { id: track.id });
  }

  /** Instantané de l'arrangement (ordre des pistes + clips), pour l'annulation. */
  getArrangement() {
    return {
      order: this.tracks.map((t) => t.id),
      clips: Object.fromEntries(this.tracks.map((t) => [t.id, t.clips.map((c) => ({ ...c }))])),
    };
  }

  /** Restaure un instantané (les pistes supprimées depuis sont ignorées). */
  restoreArrangement({ order, clips }) {
    if (this.locked) return;
    const rank = (t) => {
      const i = order.indexOf(t.id);
      return i < 0 ? order.length : i;
    };
    this.tracks = [...this.tracks].sort((a, b) => rank(a) - rank(b));
    for (const track of this.tracks) {
      if (!clips[track.id]) continue;
      track.setClips(sortClips(clips[track.id]));
      if (this.state === 'playing') track.start(this.ctx.currentTime, this.position);
    }
    this.#emit('tracks');
    this.#emit('arrange', {});
  }

  getTrack(id) {
    return this.tracks.find((t) => t.id === id) ?? null;
  }

  setVolume(id, db) {
    const track = this.getTrack(id);
    if (!track) return;
    track.volumeDb = db;
    this.updateGains();
    this.#emit('volume');
  }

  setPan(id, pan) {
    const track = this.getTrack(id);
    if (!track) return;
    track.setPan(pan);
    this.#emit('pan');
  }

  /** Vide le projet (nouveau projet, ouverture d'un autre projet). */
  clear() {
    this.stop();
    this.locked = false;
    for (const track of this.tracks) track.dispose();
    this.tracks = [];
    this.#emit('tracks');
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
    // Toute modification du contenu du projet (pour le suivi « non enregistré »).
    if (EDIT_EVENTS.has(type)) this.dispatchEvent(new CustomEvent('edit', { detail: { type, ...detail } }));
  }
}
