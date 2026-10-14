// Modèle d'édition non destructive : une piste garde son audio intact, et ses
// CLIPS sont des fenêtres sur cet audio.
//
//   clip = { id, start, offset, length }
//     start  : position sur la timeline (secondes)
//     offset : premier échantillon utilisé dans l'audio de la piste (entier)
//     length : nombre d'échantillons (entier)
//
// Découper, rogner, supprimer une portion ne fait que modifier ces fenêtres :
// aucun audio n'est copié ni recalculé (et les effets vocaux de la piste, rendus
// sur l'audio complet, s'appliquent à chaque morceau). Offsets et longueurs sont
// en ÉCHANTILLONS : les coupes sont exactes et survivent sans arrondi à une
// sauvegarde.
import { computeSourceSchedule } from './scheduling.js';

export const FADE_SECONDS = 0.004; // micro-fondu aux jointures non continues
export const MIN_CLIP_SECONDS = 0.01;

let counter = 0;
export const newClipId = () => `c${Date.now().toString(36)}${(counter++).toString(36)}`;

export const clipDuration = (clip, sr) => clip.length / sr;
export const clipEnd = (clip, sr) => clip.start + clip.length / sr;
const minFrames = (sr) => Math.max(1, Math.round(MIN_CLIP_SECONDS * sr));

/** Clip couvrant tout l'audio d'une piste. */
export function fullClip(bufferLength, start = 0) {
  return { id: newClipId(), start: Math.max(0, start), offset: 0, length: bufferLength };
}

export function sortClips(clips) {
  return [...clips].sort((a, b) => a.start - b.start || a.offset - b.offset);
}

/** Étendue occupée sur la timeline. */
export function clipsSpan(clips, sr) {
  if (!clips.length) return { start: 0, end: 0 };
  return { start: Math.min(...clips.map((c) => c.start)), end: Math.max(...clips.map((c) => clipEnd(c, sr))) };
}

/** Clip sous une position (le dernier dessiné l'emporte s'ils se chevauchent). */
export function clipAt(clips, time, sr) {
  let found = null;
  for (const c of sortClips(clips)) if (time >= c.start && time < clipEnd(c, sr)) found = c;
  return found;
}

/**
 * Coupe un clip en deux à `time`. Le point de coupe est arrondi à l'échantillon.
 * @returns {[object, object] | null}  null si la coupe tombe sur un bord
 */
export function splitClip(clip, time, sr) {
  const cut = Math.round((time - clip.start) * sr);
  if (cut <= 0 || cut >= clip.length) return null;
  return [
    { ...clip, length: cut },
    { id: newClipId(), start: clip.start + cut / sr, offset: clip.offset + cut, length: clip.length - cut },
  ];
}

/** Coupe les clips (ou seulement `onlyId`) qui contiennent `time`. */
export function splitClipsAt(clips, time, sr, onlyId = null) {
  const out = [];
  let changed = false;
  for (const c of clips) {
    const parts = !onlyId || c.id === onlyId ? splitClip(c, time, sr) : null;
    if (parts) {
      out.push(...parts);
      changed = true;
    } else out.push(c);
  }
  return { clips: sortClips(out), changed };
}

/**
 * Coupe un clip aux deux bords d'une sélection [from, to] : la portion
 * sélectionnée devient un clip à part entière.
 * @returns {{ clips: object[], middleId: string | null }}
 */
export function splitClipRange(clips, clipId, from, to, sr) {
  const target = clips.find((c) => c.id === clipId);
  if (!target || to <= from) return { clips, middleId: null };
  let middle = target;
  const pieces = [];
  const first = splitClip(middle, from, sr);
  if (first) {
    pieces.push(first[0]);
    middle = first[1];
  }
  const second = splitClip(middle, to, sr);
  if (second) {
    middle = second[0];
    pieces.push(second[1]);
  }
  pieces.push(middle);
  return { clips: sortClips([...clips.filter((c) => c !== target), ...pieces]), middleId: middle.id };
}

/**
 * Supprime l'intervalle [from, to[ de la timeline sur ces clips.
 * ripple = true : le reste de chaque clip coupé se RECOLLE (recule jusqu'au début
 * de la portion supprimée) ; les autres clips ne bougent pas.
 * ripple = false : un blanc reste à la place de la portion.
 */
export function deleteRange(clips, from, to, sr, { ripple = true, onlyId = null } = {}) {
  if (to <= from) return { clips, changed: false };
  const out = [];
  let changed = false;
  for (const c of clips) {
    const end = clipEnd(c, sr);
    if ((onlyId && c.id !== onlyId) || to <= c.start || from >= end) {
      out.push(c);
      continue;
    }
    changed = true;
    const a = Math.max(0, Math.round((from - c.start) * sr)); // début supprimé, relatif au clip
    const b = Math.min(c.length, Math.round((to - c.start) * sr)); // fin supprimée
    if (a > 0) out.push({ ...c, length: a });
    if (b < c.length) {
      const rightStart = ripple ? c.start + a / sr : c.start + b / sr;
      out.push({ id: a > 0 ? newClipId() : c.id, start: rightStart, offset: c.offset + b, length: c.length - b });
    }
  }
  return { clips: sortClips(out), changed };
}

/**
 * Rogne un bord (« start » ou « end ») d'un clip jusqu'à `time`, sans dépasser
 * l'audio disponible ni descendre sous 10 ms.
 */
export function trimClip(clip, edge, time, sr, bufferLength) {
  const min = minFrames(sr);
  if (edge === 'start') {
    let delta = Math.round((time - clip.start) * sr);
    delta = Math.max(delta, -clip.offset, Math.ceil(-clip.start * sr - 1e-9)); // ni avant l'audio, ni avant 0:00
    delta = Math.min(delta, clip.length - min);
    return { ...clip, start: clip.start + delta / sr, offset: clip.offset + delta, length: clip.length - delta };
  }
  let length = Math.round((time - clip.start) * sr);
  length = Math.max(min, Math.min(length, bufferLength - clip.offset));
  return { ...clip, length };
}

/** Deux clips se suivent-ils SANS discontinuité (même audio, bout à bout) ? */
function continuous(prev, next, sr) {
  return Math.abs(clipEnd(prev, sr) - next.start) < 0.5 / sr && prev.offset + prev.length === next.offset;
}

/**
 * Fondus à appliquer : seulement aux jointures où l'audio est discontinu
 * (coupe déplacée, portion supprimée, bord rogné). Les bords d'origine du
 * fichier et les coupes restées en place sont joués tels quels.
 * @returns {Map<string, { fadeIn: boolean, fadeOut: boolean }>}
 */
export function computeFades(clips, sr, bufferLength) {
  const fades = new Map();
  for (const c of clips) {
    const fadeIn = c.offset > 0 && !clips.some((o) => o !== c && continuous(o, c, sr));
    const fadeOut = c.offset + c.length < bufferLength && !clips.some((o) => o !== c && continuous(c, o, sr));
    fades.set(c.id, { fadeIn, fadeOut });
  }
  return fades;
}

/**
 * Planifie la lecture d'un clip : à l'instant `when`, la tête est à `playhead`.
 * @returns {{ when: number, offset: number, duration: number, fromStart: boolean } | null}
 *   offset / duration en secondes dans l'audio de la piste
 */
export function planClip(clip, sr, playhead, when) {
  const plan = computeSourceSchedule({ clipStart: clip.start, clipDuration: clip.length / sr, playhead, when });
  if (!plan) return null;
  return {
    when: plan.when,
    offset: clip.offset / sr + plan.offset,
    duration: clip.length / sr - plan.offset,
    fromStart: plan.offset === 0,
  };
}

export function sameClips(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Recalcule les clips pour une autre fréquence d'échantillonnage (projet ouvert sur une autre machine). */
export function rescaleClips(clips, fromRate, toRate, bufferLength) {
  if (fromRate === toRate) return clips;
  const k = toRate / fromRate;
  return clips.map((c) => {
    const offset = Math.min(bufferLength - 1, Math.round(c.offset * k));
    return { ...c, offset, length: Math.max(1, Math.min(bufferLength - offset, Math.round(c.length * k))) };
  });
}

/**
 * Crée les sources Web Audio qui jouent les clips d'une piste (lecture ET export,
 * pour qu'on exporte exactement ce qu'on entend). Micro-fondus de 4 ms aux
 * jointures discontinues, via un GainNode par clip concerné.
 * @param {BaseAudioContext} ctx
 * @param {{ buffer: AudioBuffer, clips: object[], sampleRate: number, sourceLength: number }} audio
 *   buffer : audio lu (éventuellement traité), aligné échantillon par échantillon sur l'audio d'origine
 * @returns {Array<{ source: AudioBufferSourceNode, gain: GainNode | null }>}
 */
export function scheduleClips(ctx, { buffer, clips, sampleRate, sourceLength }, destination, playhead, when) {
  const fades = computeFades(clips, sampleRate, sourceLength);
  const nodes = [];
  for (const clip of clips) {
    const plan = planClip(clip, sampleRate, playhead, when);
    if (!plan || plan.duration <= 0) continue;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const { fadeIn, fadeOut } = fades.get(clip.id);
    const fade = Math.min(FADE_SECONDS, plan.duration / 4);
    let gain = null;
    if ((fadeIn && plan.fromStart) || fadeOut) {
      gain = ctx.createGain();
      const g = gain.gain;
      const startAt = plan.when;
      const endAt = plan.when + plan.duration;
      if (fadeIn && plan.fromStart) {
        g.setValueAtTime(0, startAt);
        g.linearRampToValueAtTime(1, startAt + fade);
      } else g.setValueAtTime(1, startAt);
      if (fadeOut) {
        g.setValueAtTime(1, Math.max(startAt + (fadeIn ? fade : 0), endAt - fade));
        g.linearRampToValueAtTime(0, endAt);
      }
      source.connect(gain).connect(destination);
    } else {
      source.connect(destination);
    }
    source.start(plan.when, plan.offset, plan.duration);
    nodes.push({ source, gain });
  }
  return nodes;
}
