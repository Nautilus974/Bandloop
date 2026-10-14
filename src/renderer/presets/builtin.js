// Presets vocaux fournis avec Bandloop, rangés par catégories.
//
// Chaque preset est une combinaison de réglages du moteur vocal (voir
// vocal/settings.js). La tonalité n'en fait pas partie : elle est celle du morceau.
// Les valeurs omises prennent leur valeur par défaut (normalizeSettings).
//
// Rappel des unités : speed en ms (0 = calage instantané), strength en %,
// shift/formant en demi-tons, level en dB, pan de -100 (gauche) à 100 (droite),
// detune en cents, delay en ms ; harmonies « diatonic » : intervalle en degrés
// (2 = tierce, 4 = quinte, 7 = octave), « chromatic » : en demi-tons.

const comp = (threshold, ratio, attack, release, makeup) => ({
  type: 'compressor',
  params: { threshold, ratio, attack, release, makeup },
});
const eq = (low, mid, midFreq, high) => ({ type: 'eq', params: { low, mid, midFreq, high } });
const reverb = (decay, preDelay, brightness, lowCut, mix) => ({
  type: 'reverb',
  params: { decay, preDelay, brightness, lowCut, mix },
});
const delay = (time, feedback, tone, pingpong, mix) => ({
  type: 'delay',
  params: { time, feedback, tone, pingpong, mix },
});
const chorus = (voices, delayMs, depth, rate, spread, mix) => ({
  type: 'chorus',
  params: { voices, delay: delayMs, depth, rate, spread, mix },
});
const tune = (speed, strength = 100, extra = {}) => ({ correct: true, speed, strength, ...extra });
const voice = (interval, level, pan, detune = 0, delayMs = 0) => ({ interval, level, pan, detune, delay: delayMs });

export const CATEGORIES = [
  { id: 'essentials', name: 'Les Indispensables' },
  { id: 'hiphop', name: 'Hip Hop' },
  { id: 'hyperpop', name: 'Hyperpop' },
  { id: 'scifi', name: 'Sci-Fi' },
  { id: 'signature', name: 'Collection Signature' },
];

export const BUILTIN_PRESETS = [
  // ---------------------------------------------------------------- Les Indispensables
  {
    id: 'studio',
    category: 'essentials',
    name: 'Studio',
    description: 'Correction douce et propre, voix polie de studio.',
    settings: {
      pitch: tune(80, 85),
      chain: [comp(-18, 3, 8, 150, 3), eq(-1, 0, 1500, 2.5), reverb(1.4, 25, 7500, 200, 15)],
    },
  },
  {
    id: 'flow',
    category: 'essentials',
    name: 'Flow',
    description: 'Calage rapide et voix compacte pour le rap moderne.',
    settings: {
      pitch: tune(15),
      chain: [
        comp(-22, 5, 3, 90, 5),
        eq(-2, 1.5, 2500, 3),
        delay(250, 20, 3500, true, 12),
        reverb(1, 15, 6000, 250, 10),
      ],
    },
  },
  {
    id: 'chorale',
    category: 'essentials',
    name: 'Chorale',
    description: 'Voix entourée de quatre harmonies larges dans la gamme.',
    settings: {
      pitch: tune(40),
      harmony: {
        enabled: true,
        mode: 'diatonic',
        voices: [
          voice(2, -5, -65, -6, 12),
          voice(4, -6, 65, 6, 18),
          voice(-3, -8, -30, 4, 22),
          voice(-7, -10, 30, -4, 8),
        ],
      },
      chain: [chorus(2, 20, 2, 0.5, 90, 25), reverb(2.8, 30, 8000, 200, 28)],
    },
  },
  {
    id: 'tandem',
    category: 'essentials',
    name: 'Tandem',
    description: 'Duo : la voix doublée à l’octave inférieure et à la quinte.',
    settings: {
      pitch: tune(50, 90),
      harmony: {
        enabled: true,
        mode: 'chromatic',
        voices: [voice(-12, -4, -40, 0, 14), voice(7, -8, 40, 4, 24)],
      },
      chain: [comp(-18, 3, 10, 150, 3), reverb(1.8, 25, 7000, 200, 18)],
    },
  },
  {
    id: 'automate',
    category: 'essentials',
    name: 'Automate',
    description: 'Calage instantané : la voix saute de note en note, effet robot.',
    settings: {
      pitch: tune(0),
      chain: [comp(-20, 4, 5, 120, 4), eq(-1, 1, 2000, 2), reverb(1.2, 20, 7000, 250, 10)],
    },
  },
  {
    id: 'mirage',
    category: 'essentials',
    name: 'Mirage',
    description: 'Robot dédoublé et désaccordé : deux copies étranges de part et d’autre.',
    settings: {
      pitch: tune(0, 100, { formant: -1 }),
      voice: { level: -3 },
      harmony: {
        enabled: true,
        mode: 'chromatic',
        voices: [voice(0, -2, -85, 22, 9), voice(0, -2, 85, -22, 21)],
      },
      chain: [chorus(1, 7, 4, 0.3, 0, 30), reverb(2, 30, 6500, 200, 22)],
    },
  },

  // ---------------------------------------------------------------- Hip Hop
  {
    id: 'brut',
    category: 'hiphop',
    name: 'Brut',
    description: 'Correction à peine perceptible, voix naturelle et proche.',
    settings: {
      pitch: tune(160, 55),
      chain: [comp(-16, 2.5, 10, 160, 2), eq(0, 0, 1500, 1.5), reverb(0.7, 10, 6000, 250, 8)],
    },
  },
  {
    id: 'granit',
    category: 'hiphop',
    name: 'Granit',
    description: 'Calage dur, compression serrée et grain : sec et frontal.',
    settings: {
      pitch: tune(5),
      chain: [
        comp(-26, 8, 2, 70, 7),
        eq(1.5, 2, 1800, 1),
        { type: 'distortion', params: { character: 'soft', drive: 15, tone: 7000, output: -2, mix: 25 } },
      ],
    },
  },
  {
    id: 'velours',
    category: 'hiphop',
    name: 'Velours',
    description: 'Voix lissée, douce et ronde, aigus adoucis.',
    settings: {
      pitch: tune(90, 90, { formant: -1.5 }),
      chain: [
        comp(-20, 3, 15, 200, 4),
        eq(2, -2, 3000, -2.5),
        chorus(2, 25, 1.5, 0.35, 60, 22),
        reverb(2.2, 40, 4500, 180, 22),
      ],
    },
  },
  {
    id: 'carre',
    category: 'hiphop',
    name: 'Carré',
    description: 'Calage net sur chaque note, sans glissando, écho rythmique.',
    settings: {
      pitch: tune(2),
      chain: [comp(-22, 6, 3, 80, 5), eq(-1.5, 2.5, 2200, 2), delay(188, 25, 4000, true, 14)],
    },
  },
  {
    id: 'meduse',
    category: 'hiphop',
    name: 'Méduse',
    description: 'Correction agressive, timbre assombri et voix qui ondule.',
    settings: {
      pitch: tune(0, 100, { formant: -2.5 }),
      chain: [
        chorus(1, 6, 2.5, 6.5, 0, 100), // une seule voix 100 % traitée = vibrato
        { type: 'ringmod', params: { frequency: 30, wave: 'sine', mix: 25 } },
        { type: 'distortion', params: { character: 'amp', drive: 30, tone: 6000, output: -3, mix: 35 } },
        reverb(1.2, 15, 6000, 200, 12),
      ],
    },
  },

  // ---------------------------------------------------------------- Hyperpop
  {
    id: 'surshift',
    category: 'hyperpop',
    name: 'Surshift',
    description: 'Une octave plus haut, formants relevés : voix suraiguë.',
    settings: {
      pitch: tune(0, 100, { shift: 12, formant: 5 }),
      chain: [
        comp(-20, 4, 4, 100, 4),
        eq(-4, 0, 1500, 3),
        chorus(2, 12, 1, 0.4, 70, 20),
        reverb(1.5, 15, 9000, 300, 15),
      ],
    },
  },
  {
    id: 'survolt',
    category: 'hyperpop',
    name: 'Survolt',
    description: 'Calage ultra-rapide et saturation poussée.',
    settings: {
      pitch: tune(0, 100, { formant: 1 }),
      chain: [
        comp(-24, 6, 2, 80, 6),
        { type: 'distortion', params: { character: 'soft', drive: 55, tone: 9000, output: -6, mix: 60 } },
        eq(-3, 0, 1500, 4),
        delay(150, 30, 6000, true, 12),
      ],
    },
  },
  {
    id: 'pixel',
    category: 'hyperpop',
    name: 'Pixel',
    description: 'Résolution réduite : voix 6 bits, crénelée façon console.',
    settings: {
      pitch: tune(10),
      chain: [
        { type: 'bitcrush', params: { bits: 6, downsample: 6, glitch: 0, mix: 75 } },
        eq(-2, 0, 1500, 2),
        reverb(1, 10, 8000, 300, 10),
      ],
    },
  },
  {
    id: 'neon',
    category: 'hyperpop',
    name: 'Néon',
    description: 'Nappe large : harmonies aériennes, réverb brillante, échos croisés.',
    settings: {
      pitch: tune(10),
      harmony: {
        enabled: true,
        mode: 'diatonic',
        voices: [voice(4, -8, -70, -8, 15), voice(7, -10, 70, 8, 25), voice(-7, -11, 0, 0, 10)],
      },
      chain: [chorus(3, 22, 3.5, 0.6, 100, 40), delay(375, 35, 6000, true, 18), reverb(4.5, 45, 14000, 300, 38)],
    },
  },

  // ---------------------------------------------------------------- Sci-Fi
  {
    id: 'astra',
    category: 'scifi',
    name: 'Astra',
    description: 'Voix métallique de synthétiseur, façon vocodeur.',
    settings: {
      pitch: tune(0),
      vocoder: { enabled: true, mix: 85, bands: 24, chord: 'power', noise: 25 },
      chain: [
        { type: 'ringmod', params: { frequency: 140, wave: 'sine', mix: 18 } },
        chorus(2, 8, 1, 0.25, 70, 30),
        reverb(1.6, 20, 9000, 250, 15),
      ],
    },
  },

  // ---------------------------------------------------------------- Collection Signature
  {
    id: 'tiers',
    category: 'signature',
    name: 'Tiers',
    description: 'Une harmonie à la tierce, dans la gamme du morceau.',
    settings: {
      pitch: tune(40, 90),
      harmony: { enabled: true, mode: 'diatonic', voices: [voice(2, -4, 35, 0, 10)] },
      chain: [comp(-18, 3, 8, 150, 3), reverb(1.6, 25, 7000, 200, 16)],
    },
  },
  {
    id: 'puce',
    category: 'signature',
    name: 'Puce',
    description: 'Glitch numérique léger : petits accrocs et grain 10 bits.',
    settings: {
      pitch: tune(5, 100, { formant: 1 }),
      chain: [
        { type: 'bitcrush', params: { bits: 10, downsample: 2, glitch: 30, mix: 55 } },
        delay(90, 15, 5000, true, 10),
        reverb(0.9, 10, 8000, 300, 10),
      ],
    },
  },
  {
    id: 'maree',
    category: 'signature',
    name: 'Marée',
    description: 'Réverbération profonde qui ondule lentement.',
    settings: {
      pitch: tune(100, 70),
      chain: [chorus(3, 25, 6, 0.18, 100, 45), delay(500, 40, 2500, true, 15), reverb(7.5, 60, 5500, 150, 45)],
    },
  },
  {
    id: 'combine',
    category: 'signature',
    name: 'Combiné',
    description: 'Filtre de combiné téléphonique : bande étroite et grain.',
    settings: {
      chain: [
        { type: 'telephone', params: { low: 500, high: 3000, resonance: 2, drive: 35, mix: 100 } },
        comp(-20, 6, 3, 100, 4),
      ],
    },
  },
  {
    id: 'ampli',
    category: 'signature',
    name: 'Ampli',
    description: 'Voix poussée dans un ampli : distorsion chaude et écho court.',
    settings: {
      pitch: tune(60, 80),
      chain: [
        { type: 'distortion', params: { character: 'amp', drive: 55, tone: 5000, output: -6, mix: 80 } },
        eq(-2, 3, 1200, -1),
        comp(-20, 4, 5, 120, 3),
        delay(110, 10, 3000, false, 15),
      ],
    },
  },
  {
    id: 'prisme',
    category: 'signature',
    name: 'Prisme',
    description: 'Doublage brillant et moderne, avec une pointe d’octave.',
    settings: {
      pitch: tune(20),
      harmony: {
        enabled: true,
        mode: 'chromatic',
        voices: [voice(0, -6, -55, 9, 14), voice(0, -6, 55, -9, 26), voice(12, -16, 0)],
      },
      chain: [comp(-20, 4, 4, 100, 4), eq(-2, 0, 1500, 4), reverb(1.2, 20, 12000, 300, 14)],
    },
  },
  {
    id: 'aureole',
    category: 'signature',
    name: 'Auréole',
    description: 'Voix lointaine et éthérée, noyée dans une réverb aérienne.',
    settings: {
      pitch: tune(70, 85),
      voice: { level: -2 },
      harmony: { enabled: true, mode: 'diatonic', voices: [voice(7, -14, 0)] },
      chain: [
        eq(-4, 0, 1500, 3),
        chorus(2, 30, 3, 0.3, 100, 35),
        delay(430, 45, 3000, true, 22),
        reverb(6, 90, 11000, 400, 50),
      ],
    },
  },
  {
    id: 'bourdon',
    category: 'signature',
    name: 'Bourdon',
    description: 'Une note tenue sur la tonique s’installe sous la voix.',
    settings: {
      pitch: tune(60),
      drone: { enabled: true, level: -12, chord: 'open', octave: -1, attack: 1.5, release: 6, brightness: 1200 },
      chain: [reverb(4, 30, 6000, 120, 30)],
    },
  },
];
