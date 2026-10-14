// Une piste : un clip audio décodé, son nœud de gain et la source en cours de lecture.
import { PEAKS_PER_SECOND, computePeaks } from './peaks.js';
import { computeSourceSchedule, dbToGain } from './scheduling.js';

// Lissage des changements de volume pour éviter les clics.
const GAIN_SMOOTHING = 0.015;

let nextId = 1;

export class Track {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} destination  Bus de sortie (master)
   * @param {{name: string, buffer: AudioBuffer, color: string}} opts
   */
  constructor(ctx, destination, { name, buffer, color }) {
    this.id = nextId++;
    this.ctx = ctx;
    this.name = name;
    this.buffer = buffer;
    this.color = color;
    this.startTime = 0; // position du clip sur la timeline (s)
    this.volumeDb = 0;
    this.muted = false;

    this.gain = ctx.createGain();
    this.gain.connect(destination);
    this.source = null;

    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    const bucketSize = Math.max(1, Math.round(buffer.sampleRate / PEAKS_PER_SECOND));
    this.peaks = computePeaks(channels, bucketSize);
    // Taux réel (44100 / 221 ≠ 200) : l'utiliser évite une dérive de l'affichage.
    this.peaksPerSecond = buffer.sampleRate / bucketSize;
  }

  get duration() {
    return this.buffer.duration;
  }

  get end() {
    return this.startTime + this.duration;
  }

  setVolumeDb(db) {
    this.volumeDb = db;
    this.#applyGain();
  }

  setMuted(muted) {
    this.muted = muted;
    this.#applyGain();
  }

  #applyGain() {
    const target = this.muted ? 0 : dbToGain(this.volumeDb);
    this.gain.gain.setTargetAtTime(target, this.ctx.currentTime, GAIN_SMOOTHING);
  }

  /** Programme la lecture : à l'instant `when`, la tête de lecture est à `playhead`. */
  start(when, playhead) {
    this.stop();
    const plan = computeSourceSchedule({
      clipStart: this.startTime,
      clipDuration: this.duration,
      playhead,
      when,
    });
    if (!plan) return;
    // Une AudioBufferSourceNode ne sert qu'une fois : on en recrée une à chaque lecture.
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.gain);
    source.start(plan.when, plan.offset);
    this.source = source;
  }

  stop() {
    if (!this.source) return;
    try {
      this.source.stop();
    } catch {
      // déjà arrêtée
    }
    this.source.disconnect();
    this.source = null;
  }

  dispose() {
    this.stop();
    this.gain.disconnect();
  }
}
