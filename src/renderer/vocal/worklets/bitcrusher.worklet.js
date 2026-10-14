// AudioWorklet de bitcrush : tourne sur le thread audio temps réel.
//  - quantification de chaque échantillon sur N bits (bruit de quantification, son « 8 bits ») ;
//  - échantillonneur-bloqueur : on ne garde qu'un échantillon sur D (réduction de
//    fréquence d'échantillonnage, repliement spectral volontaire) ;
//  - glitch : de temps en temps, un court fragment récent est répété (bégaiement numérique).
import { quantize } from '../fx/curves.js';

const HISTORY = 16384;

class BitcrusherProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bits', defaultValue: 8, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
      { name: 'downsample', defaultValue: 1, minValue: 1, maxValue: 64, automationRate: 'k-rate' },
      { name: 'glitch', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.held = [0, 0];
    this.counter = 0;
    this.history = [new Float32Array(HISTORY), new Float32Array(HISTORY)];
    this.write = 0;
    this.repeat = null; // { start, length, pos, left }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input.length) return true;
    const bits = parameters.bits[0];
    const step = Math.max(1, Math.round(parameters.downsample[0]));
    const glitch = parameters.glitch[0];
    const frames = output[0].length;

    // Déclenchement aléatoire d'une répétition (probabilité par bloc de 128 échantillons).
    if (!this.repeat && glitch > 0 && Math.random() < glitch * 0.03) {
      const length = [1024, 2048, 4096, 6144][Math.floor(Math.random() * 4)];
      this.repeat = {
        start: (this.write - length + HISTORY) % HISTORY,
        length,
        pos: 0,
        left: 1 + Math.floor(Math.random() * 3),
      };
    }

    for (let i = 0; i < frames; i++) {
      if (this.counter === 0) {
        for (let ch = 0; ch < output.length; ch++) {
          const src = input[Math.min(ch, input.length - 1)];
          this.held[ch] = quantize(src[i], bits);
        }
      }
      this.counter = (this.counter + 1) % step;
      for (let ch = 0; ch < output.length; ch++) {
        let v = this.held[ch];
        this.history[ch][this.write] = v;
        if (this.repeat) v = this.history[ch][(this.repeat.start + this.repeat.pos) % HISTORY];
        output[ch][i] = v;
      }
      this.write = (this.write + 1) % HISTORY;
      if (this.repeat && ++this.repeat.pos >= this.repeat.length) {
        this.repeat.pos = 0;
        if (--this.repeat.left <= 0) this.repeat = null;
      }
    }
    return true;
  }
}

registerProcessor('bandloop-bitcrusher', BitcrusherProcessor);
