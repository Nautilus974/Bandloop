// Moteur audio : un AudioContext, un bus master, des pistes et le transport.
//
// Toutes les pistes sont démarrées sur la même horloge (AudioContext.currentTime)
// avec une petite avance, ce qui garantit une synchronisation à l'échantillon près.
import { Track } from './Track.js';
import { clamp } from './scheduling.js';

// Avance de planification : laisse le temps de créer toutes les sources
// avant l'instant de départ commun.
const START_LATENCY = 0.05;

const TRACK_COLORS = ['#4f8cff', '#ff7a59', '#3ccf91', '#c77dff', '#ffc145', '#36c5f0'];

export class AudioEngine extends EventTarget {
  constructor(ctx = new AudioContext({ latencyHint: 'interactive' })) {
    super();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.tracks = [];
    this.state = 'stopped'; // 'stopped' | 'playing' | 'paused'
    this._position = 0;
    this._anchorCtxTime = 0; // instant AudioContext du dernier démarrage
    this._anchorPosition = 0; // position timeline au dernier démarrage
  }

  /** Durée du projet : fin du clip le plus long. */
  get duration() {
    return this.tracks.reduce((max, t) => Math.max(max, t.end), 0);
  }

  /** Position courante de la tête de lecture (s). */
  get position() {
    if (this.state !== 'playing') return this._position;
    const elapsed = this.ctx.currentTime - this._anchorCtxTime;
    return this._anchorPosition + Math.max(0, elapsed);
  }

  /** Décode un fichier audio et l'ajoute comme nouvelle piste. */
  async addTrack(name, arrayBuffer) {
    const buffer = await this.ctx.decodeAudioData(arrayBuffer);
    const color = TRACK_COLORS[this.tracks.length % TRACK_COLORS.length];
    const track = new Track(this.ctx, this.master, { name, buffer, color });
    this.tracks.push(track);
    if (this.state === 'playing') track.start(this.ctx.currentTime, this.position);
    this.#emit('tracks');
    return track;
  }

  removeTrack(id) {
    const track = this.tracks.find((t) => t.id === id);
    if (!track) return;
    track.dispose();
    this.tracks = this.tracks.filter((t) => t !== track);
    if (this.tracks.length === 0) this.stop();
    this.#emit('tracks');
  }

  async play() {
    if (this.state === 'playing' || this.tracks.length === 0) return;
    // Les navigateurs suspendent l'AudioContext tant qu'il n'y a pas eu d'interaction.
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (this._position >= this.duration) this._position = 0;
    this.#startAll(this._position);
    this.#setState('playing');
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

  #emit(type) {
    this.dispatchEvent(new Event(type));
  }
}
