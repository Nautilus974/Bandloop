// Génère 4 pistes de démo (WAV 44,1 kHz, 16 bits) dans ./samples pour tester l'app :
// batterie, basse, nappe, et une voix de synthèse pour essayer les effets vocaux.
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

// Voix de synthèse pour tester les effets vocaux : source glottique (dent de scie)
// filtrée par trois formants (voyelles a, o, é, i), mélodie en La mineur chantée
// volontairement un peu faux (±35 cents), avec attaques glissées, vibrato et
// consonnes (bruit) entre les notes.
const VOWELS = {
  a: [800, 1200, 2600],
  o: [450, 850, 2600],
  e: [450, 1900, 2600],
  i: [300, 2250, 3000],
};
// [note MIDI, durée en temps, voyelle, erreur de justesse en cents]
const MELODY = [
  [69, 1, 'a', -30],
  [72, 1, 'o', 25],
  [71, 0.5, 'e', -20],
  [69, 0.5, 'a', 15],
  [67, 2, 'i', -35],
  [64, 1, 'a', 20],
  [67, 1, 'e', -25],
  [69, 2, 'o', 30],
  [72, 1, 'a', -15],
  [74, 1, 'e', 35],
  [76, 1.5, 'i', -25],
  [74, 0.5, 'o', 20],
  [72, 2, 'a', -30],
  [71, 1, 'e', 25],
  [69, 1, 'o', -20],
  [67, 1, 'a', 30],
  [69, 3, 'a', -25],
];

function resonator(freq, bw) {
  const r = Math.exp((-Math.PI * bw) / SAMPLE_RATE);
  const a1 = -2 * r * Math.cos((2 * Math.PI * freq) / SAMPLE_RATE);
  const a2 = r * r;
  let y1 = 0;
  let y2 = 0;
  return (x) => {
    const y = (1 - r) * x - a1 * y1 - a2 * y2;
    y2 = y1;
    y1 = y;
    return y;
  };
}

function voice() {
  const out = new Float32Array(Math.round(DURATION * SAMPLE_RATE));
  let t0 = 0.5;
  let phase = 0;
  let seed = 3;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (const [note, beats, vowel, cents] of MELODY) {
    const dur = beats * BEAT;
    const start = Math.round(t0 * SAMPLE_RATE);
    const len = Math.round((dur - 0.06) * SAMPLE_RATE);
    const filters = VOWELS[vowel].map((f, i) => resonator(f, [80, 100, 140][i]));
    for (let i = 0; i < len && start + i < out.length; i++) {
      const t = i / SAMPLE_RATE;
      const scoop = -0.8 * Math.exp(-t / 0.05); // attaque glissée par en dessous
      const vibrato = Math.min(1, t / 0.4) * 0.25 * Math.sin(2 * Math.PI * 5.4 * t);
      const hz = 440 * Math.pow(2, (note + cents / 100 + scoop + vibrato - 69) / 12);
      phase = (phase + hz / SAMPLE_RATE) % 1;
      const source = 2 * phase - 1 + 0.02 * random();
      const formant = filters.reduce((acc, f, k) => acc + f(source) * [1, 0.6, 0.25][k], 0);
      const env = Math.min(1, t / 0.03) * Math.min(1, (len - i) / (0.05 * SAMPLE_RATE));
      out[start + i] += 2.2 * formant * env;
    }
    // Consonne : petit souffle avant la note suivante.
    const cons = Math.round(0.05 * SAMPLE_RATE);
    for (let i = 0; i < cons; i++) {
      const idx = start + len + i;
      if (idx < out.length) out[idx] += 0.06 * random() * Math.sin((Math.PI * i) / cons);
    }
    t0 += dur;
  }
  // Normalisation à -2 dBFS.
  const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  return out.map((v) => (v / peak) * 0.79);
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
for (const [name, fn] of Object.entries({ drums, bass, pad, voix: null })) {
  const file = path.join(dir, `${name}.wav`);
  fs.writeFileSync(file, encodeWav(fn ? render(fn) : voice()));
  console.log(`✔ ${path.relative(process.cwd(), file)}`);
}
