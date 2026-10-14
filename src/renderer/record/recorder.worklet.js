// AudioWorklet de capture : tourne sur le thread audio temps réel.
// Chaque échantillon est repéré par son numéro de trame sur l'horloge de
// l'AudioContext (`currentFrame`) : la capture démarre et s'arrête à des trames
// exactes, ce qui permet de caler la prise à l'échantillon près sur la lecture.
// Les données sont envoyées au thread principal par blocs (transfert sans copie).

const CHUNK = 8192;

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.armed = false;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'start') {
        this.startFrame = data.startFrame;
        this.stopFrame = Infinity;
        this.channels = data.channels;
        this.armed = true;
        this.#allocate();
      } else if (data.type === 'stop') {
        this.stopFrame = Math.max(this.startFrame, data.stopFrame);
      }
    };
  }

  #allocate() {
    this.chunk = Array.from({ length: this.channels }, () => new Float32Array(CHUNK));
    this.fill = 0;
  }

  #flush() {
    if (this.fill === 0) return;
    const data = this.chunk.map((c) => c.slice(0, this.fill));
    this.port.postMessage(
      { type: 'chunk', data },
      data.map((c) => c.buffer),
    );
    this.#allocate();
  }

  process(inputs) {
    if (!this.armed) return true;
    const input = inputs[0];
    const frames = input[0]?.length ?? 128;
    for (let i = 0; i < frames; i++) {
      const frame = currentFrame + i;
      if (frame < this.startFrame) continue;
      if (frame >= this.stopFrame) {
        this.#flush();
        this.armed = false;
        this.port.postMessage({ type: 'done' });
        return true;
      }
      for (let ch = 0; ch < this.channels; ch++) {
        // Entrée vide (flux interrompu) : on enregistre du silence pour garder le calage.
        const src = input[Math.min(ch, input.length - 1)];
        this.chunk[ch][this.fill] = src ? src[i] : 0;
      }
      if (++this.fill === CHUNK) this.#flush();
    }
    return true;
  }
}

registerProcessor('bandloop-recorder', RecorderProcessor);
