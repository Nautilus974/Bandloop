// Génère 3 pistes de démo (WAV 44,1 kHz, 16 bits) dans ./samples pour tester l'app.
// Usage : npm run samples
import fs from 'node:fs';
import path from 'node:path';

const SAMPLE_RATE = 44100;
const BPM = 120;
const BEAT = 60 / BPM;
const DURATION = 16 * BEAT * 2; // 8 mesures

function render(fn, duration = DURATION) {
  const out = new Float32Array(Math.round(duration * SAMPLE_RATE));
  for (let i = 0; i < out.length; i++) out[i] = fn(i / SAMPLE_RATE);
  return out;
}

const midiToHz = (n) => 440 * Math.pow(2, (n - 69) / 12);

// Batterie : grosse caisse sur les temps, charleston sur les croches.
function drums(t) {
  const beatPos = t % BEAT;
  const kick = Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-beatPos * 30)) * beatPos) * Math.exp(-beatPos * 8);
  const eighth = t % (BEAT / 2);
  const hat = (Math.random() * 2 - 1) * Math.exp(-eighth * 60) * 0.25;
  return 0.8 * kick + hat;
}

// Basse : une note par mesure (La - Fa - Do - Sol).
const BASS = [45, 41, 48, 43];
function bass(t) {
  const bar = Math.floor(t / (4 * BEAT));
  const note = BASS[bar % BASS.length];
  const local = t % BEAT;
  const env = Math.min(1, local * 200) * (0.6 + 0.4 * Math.exp(-local * 4));
  return 0.5 * env * Math.sin(2 * Math.PI * midiToHz(note) * t);
}

// Nappe : accords tenus.
const CHORDS = [
  [57, 60, 64],
  [53, 57, 60],
  [60, 64, 67],
  [55, 59, 62],
];
function pad(t) {
  const bar = Math.floor(t / (4 * BEAT));
  const chord = CHORDS[bar % CHORDS.length];
  const local = t % (4 * BEAT);
  const env = Math.min(1, local * 4) * Math.min(1, (4 * BEAT - local) * 8);
  return (0.18 * env * chord.reduce((s, n) => s + Math.sin(2 * Math.PI * midiToHz(n) * t), 0)) / 1.5;
}

function encodeWav(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), 44 + i * 2));
  return buf;
}

const dir = path.resolve('samples');
fs.mkdirSync(dir, { recursive: true });
for (const [name, fn] of Object.entries({ drums, bass, pad })) {
  const file = path.join(dir, `${name}.wav`);
  fs.writeFileSync(file, encodeWav(render(fn)));
  console.log(`✔ ${path.relative(process.cwd(), file)}`);
}
