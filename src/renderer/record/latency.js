// Calculs purs de l'enregistrement : placement de la prise sur la timeline,
// estimation et mesure de la latence aller-retour, messages d'erreur du micro.
//
// Modèle de latence :
//   la lecture démarre à l'instant `when` (horloge AudioContext), tête à P0 ;
//   la position p est entendue à  when + (p − P0) + latenceSortie ;
//   on chante en même temps, le micro la livre  latenceEntrée  plus tard.
//   => un échantillon capté à l'instant T appartient à la position
//      P0 + (T − when) − (latenceSortie + latenceEntrée).
// La prise doit donc être avancée de la latence aller-retour.

/**
 * Où poser la prise sur la timeline.
 * @param {object} p
 * @param {number} p.startPosition  Position de la tête au début de la capture (s)
 * @param {number} p.latency        Latence aller-retour à compenser (s)
 * @param {number} p.sampleRate
 * @returns {{ startTime: number, trimSamples: number }}
 *   trimSamples > 0 : début de la prise à jeter (il tomberait avant 0:00)
 */
export function computeTakePlacement({ startPosition, latency, sampleRate }) {
  const start = startPosition - Math.max(0, latency);
  if (start >= 0) return { startTime: start, trimSamples: 0 };
  return { startTime: 0, trimSamples: Math.round(-start * sampleRate) };
}

/**
 * Estimation automatique de la latence aller-retour à partir de ce que le
 * navigateur expose (souvent incomplet : à affiner par la mesure).
 * @param {{ outputLatency?: number, baseLatency?: number, inputLatency?: number }} p  en secondes
 */
export function estimateLatency({ outputLatency, baseLatency, inputLatency }) {
  const out = Number.isFinite(outputLatency) && outputLatency > 0 ? outputLatency : (baseLatency ?? 0) + 0.01;
  // Chrome n'indique pas toujours la latence d'entrée : on suppose un tampon typique de 10 ms.
  const input = Number.isFinite(inputLatency) && inputLatency > 0 ? inputLatency : 0.01;
  return out + input;
}

/** Clic de calibrage : rafale sinusoïdale de 3 ms à 2 kHz fenêtrée (bien détectable, peu filtrée). */
export function makeClick(sampleRate) {
  const n = Math.round(0.003 * sampleRate);
  return Float32Array.from(
    { length: n },
    (_, i) => Math.sin((2 * Math.PI * 2000 * i) / sampleRate) * Math.sin((Math.PI * i) / n),
  );
}

/**
 * Mesure la latence aller-retour : des clics ont été joués aux échantillons
 * `clickFrames` (relatifs au début de l'enregistrement) ; on cherche par
 * intercorrélation le retard de chacun dans la prise, puis on prend la médiane.
 * @returns {{ ok: true, latency: number, spread: number } | { ok: false, reason: string }}
 */
export function measureLoopbackLatency(
  recording,
  sampleRate,
  clickFrames,
  template = makeClick(sampleRate),
  maxLatency = 0.5,
) {
  const maxLag = Math.round(maxLatency * sampleRate);
  const lags = [];
  let noiseFloor = 0;
  for (let i = 0; i < Math.min(recording.length, clickFrames[0] ?? 0); i++)
    noiseFloor = Math.max(noiseFloor, Math.abs(recording[i]));

  for (const frame of clickFrames) {
    let best = -Infinity;
    let bestLag = -1;
    for (let lag = 0; lag < maxLag; lag++) {
      const at = frame + lag;
      if (at + template.length >= recording.length) break;
      let acc = 0;
      for (let k = 0; k < template.length; k++) acc += recording[at + k] * template[k];
      if (acc > best) {
        best = acc;
        bestLag = lag;
      }
    }
    // Pic d'énergie au voisinage du meilleur retard : le clic doit dépasser le bruit de fond.
    let peak = 0;
    for (let k = 0; k < template.length && bestLag >= 0; k++)
      peak = Math.max(peak, Math.abs(recording[frame + bestLag + k]));
    if (bestLag >= 0 && peak > Math.max(0.01, noiseFloor * 3)) lags.push(bestLag);
  }

  if (lags.length < Math.ceil(clickFrames.length / 2)) {
    return {
      ok: false,
      reason:
        'Les clics n’ont pas été entendus par le micro. Utilise les haut-parleurs (pas le casque) et monte le volume.',
    };
  }
  lags.sort((a, b) => a - b);
  const median = lags[lags.length >> 1];
  const spread = (lags[lags.length - 1] - lags[0]) / sampleRate;
  if (spread > 0.01) {
    return { ok: false, reason: 'Mesures incohérentes (bruit ou écho dans la pièce). Recommence dans le calme.' };
  }
  return { ok: true, latency: median / sampleRate, spread };
}

/** « Prise 1 », « Prise 2 »… (premier numéro libre). */
export function takeName(existingNames) {
  const used = new Set(existingNames);
  let n = 1;
  while (used.has(`Prise ${n}`)) n++;
  return `Prise ${n}`;
}

/**
 * Conseil de niveau d'entrée à partir de la crête récente (linéaire).
 * @returns {{ level: 'none'|'low'|'good'|'hot'|'clip', text: string }}
 */
export function levelHint(peak) {
  if (peak < 0.003) return { level: 'none', text: 'Aucun signal : vérifie le micro choisi.' };
  if (peak < 0.06) return { level: 'low', text: 'Signal faible : rapproche-toi ou monte le gain du micro.' };
  if (peak < 0.7) return { level: 'good', text: 'Bon niveau.' };
  if (peak < 0.98) return { level: 'hot', text: 'Niveau élevé : baisse un peu le gain.' };
  return { level: 'clip', text: 'Saturation ! Baisse le gain du micro.' };
}

/**
 * Message clair pour un échec d'accès au micro.
 * @param {{ name?: string, message?: string }} err  Erreur de getUserMedia (ou { name: 'SystemDenied' })
 * @param {string} platform  'darwin' | 'win32' | 'linux' | 'web'
 * @returns {{ title: string, text: string, canOpenSettings: boolean }}
 */
export function describeMicError(err, platform) {
  const settings =
    platform === 'darwin'
      ? 'Réglages Système › Confidentialité et sécurité › Micro, puis coche Bandloop'
      : platform === 'win32'
        ? 'Paramètres Windows › Confidentialité et sécurité › Microphone, puis active « Autoriser les applications de bureau à accéder au microphone »'
        : 'les réglages de confidentialité de ton système';
  const canOpenSettings = platform === 'darwin' || platform === 'win32';
  switch (err?.name) {
    case 'SystemDenied':
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return {
        title: 'Accès au micro refusé',
        text: `Bandloop n’a pas le droit d’utiliser le micro. Autorise-le dans ${settings}, puis réessaie.`,
        canOpenSettings,
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return {
        title: 'Aucun micro détecté',
        text: 'Branche un micro ou une interface audio, puis réessaie.',
        canOpenSettings: false,
      };
    case 'NotReadableError':
    case 'TrackStartError':
      return {
        title: 'Micro indisponible',
        text: 'Le micro est déjà utilisé par une autre application (visio, autre DAW…) ou bloqué par le système. Ferme-la puis réessaie.',
        canOpenSettings,
      };
    case 'NotSupportedError':
    case 'NotSupported':
      return {
        title: 'Micro non disponible ici',
        text: 'Cet environnement ne permet pas d’accéder au micro (page non sécurisée ou autorisation impossible à demander). Utilise l’application Bandloop.',
        canOpenSettings: false,
      };
    case 'OverconstrainedError':
      return {
        title: 'Micro introuvable',
        text: 'Le micro choisi a été débranché. Choisis-en un autre.',
        canOpenSettings: false,
      };
    default:
      return {
        title: 'Impossible d’ouvrir le micro',
        text: err?.message || 'Erreur inconnue.',
        canOpenSettings: false,
      };
  }
}
