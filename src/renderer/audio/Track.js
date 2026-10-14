// Une piste : un clip audio décodé et sa tranche de console.
//
//   source → input → [insert : effets, branché par setInsert] → panner → fader → master
//
// Le fader applique volume, mute et solo (calculé par le moteur, qui connaît
// l'état solo des autres pistes).
import { PEAKS_PER_SECOND, computePeaks } from './peaks.js';
import { computeSourceSchedule } from './scheduling.js';
import { clamp } from './scheduling.js';

// Lissage des changements de gain / pan pour éviter les clics.
const SMOOTHING = 0.015;

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
    this.buffer = buffer; // audio original, tel qu'importé
    this.playbackBuffer = buffer; // audio lu (peut être remplacé par un rendu traité)
    this.color = color;
    this.startTime = 0; // position du clip sur la timeline (s)
    this.volumeDb = 0;
    this.pan = 0;
    this.muted = false;
    this.solo = false;

    this.input = ctx.createGain();
    this.panner = ctx.createStereoPanner();
    this.fader = ctx.createGain();
    this.input.connect(this.panner);
    this.panner.connect(this.fader);
    this.fader.connect(destination);
    this.insert = null;
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

  /** Applique un gain calculé par le moteur (volume × mute × solo). */
  applyGain(gain) {
    this.fader.gain.setTargetAtTime(gain, this.ctx.currentTime, SMOOTHING);
  }

  setPan(pan) {
    this.pan = clamp(pan, -1, 1);
    this.panner.pan.setTargetAtTime(this.pan, this.ctx.currentTime, SMOOTHING);
  }

  /**
   * Branche une chaîne d'effets entre l'entrée et le panoramique.
   * @param {{input: AudioNode, output: AudioNode} | null} insert
   */
  setInsert(insert) {
    this.input.disconnect();
    if (this.insert) this.insert.output.disconnect();
    this.insert = insert;
    if (insert) {
      this.input.connect(insert.input);
      insert.output.connect(this.panner);
    } else {
      this.input.connect(this.panner);
    }
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
    source.buffer = this.playbackBuffer;
    source.connect(this.input);
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
    this.input.disconnect();
    this.panner.disconnect();
    this.fader.disconnect();
  }
}
