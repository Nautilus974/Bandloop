// Une piste : son audio décodé, ses clips (fenêtres sur cet audio, voir clips.js)
// et sa tranche de console.
//
//   sources (une par clip) → input → [insert : effets] → panner → fader → master
//
// Le fader applique volume, mute et solo (calculé par le moteur, qui connaît
// l'état solo des autres pistes).
import { clipsSpan, fullClip, scheduleClips, sortClips } from './clips.js';
import { PEAKS_PER_SECOND, computePeaks } from './peaks.js';
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
    this.clips = [fullClip(buffer.length)];
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
    this.sources = []; // nœuds de lecture en cours (un par clip)

    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    const bucketSize = Math.max(1, Math.round(buffer.sampleRate / PEAKS_PER_SECOND));
    this.peaks = computePeaks(channels, bucketSize);
    // Taux réel (44100 / 221 ≠ 200) : l'utiliser évite une dérive de l'affichage.
    this.peaksPerSecond = buffer.sampleRate / bucketSize;
  }

  /** Durée de l'audio de la piste (et non des clips). */
  get duration() {
    return this.buffer.duration;
  }

  get sampleRate() {
    return this.buffer.sampleRate;
  }

  /** Début du premier clip sur la timeline. */
  get startTime() {
    return clipsSpan(this.clips, this.sampleRate).start;
  }

  /** Déplace TOUS les clips de la piste pour que le premier commence à `t`. */
  set startTime(t) {
    const delta = Math.max(0, t) - this.startTime;
    this.setClips(this.clips.map((c) => ({ ...c, start: c.start + delta })));
  }

  /** Fin du dernier clip. */
  get end() {
    return clipsSpan(this.clips, this.sampleRate).end;
  }

  /**
   * Remplace les clips. Les débuts sont calés sur l'échantillon : la lecture et
   * l'export restent exacts (pas d'interpolation entre échantillons).
   */
  setClips(clips) {
    const sr = this.sampleRate;
    this.clips = sortClips(clips.map((c) => ({ ...c, start: Math.max(0, Math.round(c.start * sr) / sr) })));
  }

  /** Premier nœud de lecture actif (compatibilité : « la piste joue-t-elle ? »). */
  get source() {
    return this.sources[0]?.source ?? null;
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
    // Une AudioBufferSourceNode ne sert qu'une fois : on en recrée à chaque lecture.
    this.sources = scheduleClips(
      this.ctx,
      { buffer: this.playbackBuffer, clips: this.clips, sampleRate: this.sampleRate, sourceLength: this.buffer.length },
      this.input,
      playhead,
      when,
    );
  }

  stop() {
    for (const { source, gain } of this.sources) {
      try {
        source.stop();
      } catch {
        // déjà arrêtée
      }
      source.disconnect();
      gain?.disconnect();
    }
    this.sources = [];
  }

  dispose() {
    this.stop();
    this.input.disconnect();
    this.panner.disconnect();
    this.fader.disconnect();
  }
}
