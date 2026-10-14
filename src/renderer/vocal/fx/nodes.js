// Fabrication des effets temps réel en nœuds Web Audio.
// Chaque fabrique renvoie { input, output, set(params), dispose() } ; les briques
// utilisées pour chaque effet sont aussi listées dans catalog.js (champ `bricks`).
import { generateImpulse, makeDistortionCurve, makeQuantizeCurve, mixGains } from './curves.js';

const SMOOTH = 0.02;
const ramp = (param, value, ctx) => param.setTargetAtTime(value, ctx.currentTime, SMOOTH);
const dbToGain = (db) => Math.pow(10, db / 20);

const workletsByContext = new WeakMap();

/** Charge les AudioWorklets (une fois par contexte : temps réel ou rendu d'export). */
export function loadWorklets(ctx) {
  if (!workletsByContext.has(ctx)) {
    workletsByContext.set(
      ctx,
      ctx.audioWorklet
        .addModule(new URL('../worklets/bitcrusher.worklet.js', import.meta.url))
        .then(() => true)
        .catch((err) => {
          console.warn('AudioWorklet indisponible : bitcrush réduit à la quantification.', err);
          return false;
        }),
    );
  }
  return workletsByContext.get(ctx);
}
let workletAvailable = false;
export const markWorkletAvailable = (v) => (workletAvailable = v);

/**
 * Enveloppe sec/traité commune : input ─┬─ dry ─────────────┬─ output
 *                                       └─ [effet] ─ wet ───┘
 */
function wetDry(ctx) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  input.connect(dry);
  dry.connect(output);
  wet.connect(output);
  return {
    input,
    output,
    wet,
    setMix(mix) {
      const [d, w] = mixGains(mix);
      ramp(dry.gain, d, ctx);
      ramp(wet.gain, w, ctx);
    },
  };
}

function disconnectAll(...nodes) {
  for (const n of nodes) {
    try {
      n.disconnect();
    } catch {
      // déjà déconnecté
    }
  }
}

const FACTORIES = {
  // Téléphone : passe-bande raide + bosse dans les médiums + léger grain.
  telephone(ctx) {
    const m = wetDry(ctx);
    const hp1 = ctx.createBiquadFilter();
    const hp2 = ctx.createBiquadFilter();
    const lp1 = ctx.createBiquadFilter();
    const lp2 = ctx.createBiquadFilter();
    const peak = ctx.createBiquadFilter();
    const shaper = ctx.createWaveShaper();
    const makeup = ctx.createGain();
    hp1.type = hp2.type = 'highpass';
    lp1.type = lp2.type = 'lowpass';
    peak.type = 'peaking';
    peak.gain.value = 5;
    peak.Q.value = 0.8;
    makeup.gain.value = dbToGain(5);
    shaper.oversample = '2x';
    m.input
      .connect(hp1)
      .connect(hp2)
      .connect(lp1)
      .connect(lp2)
      .connect(peak)
      .connect(shaper)
      .connect(makeup)
      .connect(m.wet);
    let lastDrive = null;
    return {
      ...m,
      set(p) {
        ramp(hp1.frequency, p.low, ctx);
        ramp(hp2.frequency, p.low, ctx);
        ramp(lp1.frequency, p.high, ctx);
        ramp(lp2.frequency, p.high, ctx);
        hp1.Q.value = lp1.Q.value = p.resonance;
        hp2.Q.value = lp2.Q.value = 0.707;
        ramp(peak.frequency, Math.sqrt(p.low * p.high), ctx);
        if (p.drive !== lastDrive) shaper.curve = makeDistortionCurve('soft', (lastDrive = p.drive) * 0.6);
        m.setMix(p.mix);
      },
      dispose: () => disconnectAll(m.input, m.output, hp1, hp2, lp1, lp2, peak, shaper, makeup, m.wet),
    };
  },

  // Chœur : jusqu'à 4 copies retardées, chacune modulée par son propre LFO et panoramiquée.
  chorus(ctx) {
    const m = wetDry(ctx);
    const voices = Array.from({ length: 4 }, (_, i) => {
      const delay = ctx.createDelay(0.2);
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      const pan = ctx.createStereoPanner();
      const gain = ctx.createGain();
      lfo.connect(depth).connect(delay.delayTime);
      m.input.connect(delay).connect(pan).connect(gain).connect(m.wet);
      lfo.start(ctx.currentTime + i * 0.13); // décalage de phase entre voix
      return { delay, lfo, depth, pan, gain };
    });
    return {
      ...m,
      set(p) {
        voices.forEach((v, i) => {
          const active = i < p.voices;
          ramp(v.gain.gain, active ? 1 / Math.sqrt(p.voices) : 0, ctx);
          ramp(v.delay.delayTime, (p.delay + i * 3.7) / 1000, ctx);
          ramp(v.depth.gain, p.depth / 1000, ctx);
          ramp(v.lfo.frequency, p.rate * (1 + i * 0.17), ctx);
          const side = p.voices === 1 ? 0 : (i % 2 ? 1 : -1) * (0.5 + 0.5 * (i >> 1));
          ramp(v.pan.pan, Math.max(-1, Math.min(1, side * (p.spread / 100))), ctx);
        });
        m.setMix(p.mix);
      },
      dispose() {
        voices.forEach((v) => {
          v.lfo.stop();
          disconnectAll(v.delay, v.lfo, v.depth, v.pan, v.gain);
        });
        disconnectAll(m.input, m.output, m.wet);
      },
    };
  },

  // Delay ping-pong : deux lignes croisées, réinjection filtrée.
  delay(ctx) {
    const m = wetDry(ctx);
    const left = ctx.createDelay(2);
    const right = ctx.createDelay(2);
    const fbL = ctx.createGain();
    const fbR = ctx.createGain();
    const toneL = ctx.createBiquadFilter();
    const toneR = ctx.createBiquadFilter();
    const feedRight = ctx.createGain(); // entrée directe vers la droite (mode non ping-pong)
    const merger = ctx.createChannelMerger(2);
    toneL.type = toneR.type = 'lowpass';
    m.input.connect(left);
    m.input.connect(feedRight).connect(right);
    left.connect(toneL).connect(fbL).connect(right);
    right.connect(toneR).connect(fbR).connect(left);
    left.connect(merger, 0, 0);
    right.connect(merger, 0, 1);
    merger.connect(m.wet);
    return {
      ...m,
      set(p) {
        ramp(left.delayTime, p.time / 1000, ctx);
        ramp(right.delayTime, p.time / 1000, ctx);
        ramp(fbL.gain, p.feedback / 100, ctx);
        ramp(fbR.gain, p.feedback / 100, ctx);
        ramp(toneL.frequency, p.tone, ctx);
        ramp(toneR.frequency, p.tone, ctx);
        ramp(feedRight.gain, p.pingpong ? 0 : 1, ctx);
        m.setMix(p.mix);
      },
      dispose: () => disconnectAll(m.input, m.output, m.wet, left, right, fbL, fbR, toneL, toneR, feedRight, merger),
    };
  },

  // Réverbération à convolution sur réponse impulsionnelle générée.
  reverb(ctx) {
    const m = wetDry(ctx);
    const pre = ctx.createDelay(0.5);
    const lowCut = ctx.createBiquadFilter();
    const convolver = ctx.createConvolver();
    lowCut.type = 'highpass';
    convolver.normalize = true;
    m.input.connect(pre).connect(lowCut).connect(convolver).connect(m.wet);
    let irKey = '';
    let timer = null;
    return {
      ...m,
      set(p) {
        ramp(pre.delayTime, p.preDelay / 1000, ctx);
        ramp(lowCut.frequency, p.lowCut, ctx);
        m.setMix(p.mix);
        const key = `${p.decay}|${p.brightness}`;
        if (key === irKey) return;
        irKey = key;
        const build = () => {
          const [l, r] = generateImpulse(ctx.sampleRate, { decay: p.decay, brightness: p.brightness, seed: 11 });
          const buffer = ctx.createBuffer(2, l.length, ctx.sampleRate);
          buffer.copyToChannel(l, 0);
          buffer.copyToChannel(r, 1);
          convolver.buffer = buffer;
        };
        clearTimeout(timer);
        // Premier réglage : immédiat (indispensable pour le rendu d'export) ;
        // ensuite différé, car coûteux pendant qu'on tourne un bouton.
        if (!convolver.buffer) build();
        else timer = setTimeout(build, 120);
      },
      dispose() {
        clearTimeout(timer);
        disconnectAll(m.input, m.output, m.wet, pre, lowCut, convolver);
      },
    };
  },

  // Distorsion : filtrage avant/après un WaveShaper suréchantillonné (moins d'aliasing).
  distortion(ctx) {
    const m = wetDry(ctx);
    const hp = ctx.createBiquadFilter();
    const shaper = ctx.createWaveShaper();
    const lp = ctx.createBiquadFilter();
    const out = ctx.createGain();
    hp.type = 'highpass';
    hp.frequency.value = 90;
    lp.type = 'lowpass';
    shaper.oversample = '4x';
    m.input.connect(hp).connect(shaper).connect(lp).connect(out).connect(m.wet);
    let curveKey = '';
    return {
      ...m,
      set(p) {
        const key = `${p.character}|${p.drive}`;
        if (key !== curveKey) shaper.curve = makeDistortionCurve(p.character, p.drive);
        curveKey = key;
        ramp(lp.frequency, p.tone, ctx);
        ramp(out.gain, dbToGain(p.output), ctx);
        m.setMix(p.mix);
      },
      dispose: () => disconnectAll(m.input, m.output, m.wet, hp, shaper, lp, out),
    };
  },

  // Bitcrush : AudioWorklet maison (repli : WaveShaper de quantification seule).
  bitcrush(ctx) {
    const m = wetDry(ctx);
    let node;
    let fallback = null;
    if (workletAvailable) {
      node = new AudioWorkletNode(ctx, 'bandloop-bitcrusher', { outputChannelCount: [2] });
    } else {
      node = fallback = ctx.createWaveShaper();
    }
    m.input.connect(node).connect(m.wet);
    return {
      ...m,
      set(p) {
        if (fallback) {
          fallback.curve = makeQuantizeCurve(p.bits);
        } else {
          node.parameters.get('bits').value = p.bits;
          node.parameters.get('downsample').value = p.downsample;
          node.parameters.get('glitch').value = p.glitch / 100;
        }
        m.setMix(p.mix);
      },
      dispose: () => disconnectAll(m.input, m.output, m.wet, node),
    };
  },

  // Modulation en anneau : l'oscillateur pilote le gain → multiplication des signaux.
  ringmod(ctx) {
    const m = wetDry(ctx);
    const vca = ctx.createGain();
    const osc = ctx.createOscillator();
    vca.gain.value = 0;
    osc.connect(vca.gain);
    m.input.connect(vca).connect(m.wet);
    osc.start();
    return {
      ...m,
      set(p) {
        ramp(osc.frequency, p.frequency, ctx);
        osc.type = p.wave;
        m.setMix(p.mix);
      },
      dispose() {
        osc.stop();
        disconnectAll(m.input, m.output, m.wet, vca, osc);
      },
    };
  },

  compressor(ctx) {
    const comp = ctx.createDynamicsCompressor();
    const makeup = ctx.createGain();
    comp.knee.value = 6;
    comp.connect(makeup);
    return {
      input: comp,
      output: makeup,
      set(p) {
        ramp(comp.threshold, p.threshold, ctx);
        ramp(comp.ratio, p.ratio, ctx);
        comp.attack.value = p.attack / 1000;
        comp.release.value = p.release / 1000;
        ramp(makeup.gain, dbToGain(p.makeup), ctx);
      },
      dispose: () => disconnectAll(comp, makeup),
    };
  },

  eq(ctx) {
    const low = ctx.createBiquadFilter();
    const mid = ctx.createBiquadFilter();
    const high = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 180;
    mid.type = 'peaking';
    mid.Q.value = 0.9;
    high.type = 'highshelf';
    high.frequency.value = 8000;
    low.connect(mid).connect(high);
    return {
      input: low,
      output: high,
      set(p) {
        ramp(low.gain, p.low, ctx);
        ramp(mid.gain, p.mid, ctx);
        ramp(mid.frequency, p.midFreq, ctx);
        ramp(high.gain, p.high, ctx);
      },
      dispose: () => disconnectAll(low, mid, high),
    };
  },
};

/** Crée le nœud d'un module de la chaîne et lui applique ses paramètres. */
export function createFxNode(ctx, module) {
  const node = FACTORIES[module.type](ctx);
  node.set(module.params);
  return node;
}
