// Format de projet Bandloop (.bandloop).
//
// Un fichier .bandloop est une archive ZIP lisible par n'importe quel outil :
//   project.json            état complet du projet (voir buildManifest)
//   audio/01-<nom>.<ext>    audio de chaque piste, EMBARQUÉ :
//     - fichier importé : octets d'origine, tels quels (MP3, WAV, FLAC…) :
//       aucune perte, aucun réencodage, taille minimale ;
//     - prise micro : FLAC 24 bits (sans perte, ~50-70 % d'un WAV).
// Le projet se rouvre donc à l'identique même si les fichiers d'origine ont bougé.
import { normalizeSettings, normalizeTonality } from '../vocal/settings.js';
import { createZip, readZip, ZipError } from './zip.js';

export const PROJECT_FORMAT = 'bandloop-project';
// v1 : un seul clip par piste (startTime). v2 : liste de clips (montage).
export const PROJECT_VERSION = 2;
export const PROJECT_EXTENSION = 'bandloop';

export class ProjectError extends Error {
  /** @param {'corrupt'|'not-project'|'too-new'|'missing-audio'|'bad-audio'} code */
  constructor(code, message) {
    super(message);
    this.name = 'ProjectError';
    this.code = code;
  }
}

const clampNum = (v, min, max, fallback) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);
const COLOR = /^#[0-9a-f]{6}$/i;

/** Nom de fichier sûr pour une entrée d'archive. */
export function slugify(name) {
  const base = String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40);
  return base || 'piste';
}

/** Extension à utiliser pour un fichier importé (d'après son nom). */
export function audioExtension(fileName, fallback = 'bin') {
  const m = /\.([a-z0-9]{1,5})$/i.exec(fileName ?? '');
  return m ? m[1].toLowerCase() : fallback;
}

/**
 * Construit le manifeste (project.json) à partir de l'état de l'application.
 * @param {object} state
 */
export function buildManifest({ name, tempo, zoom, playhead, tonality, tracks, userPresets = [], appVersion = '' }) {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    app: `Bandloop ${appVersion}`.trim(),
    savedAt: new Date().toISOString(),
    name,
    tempo,
    zoom,
    playhead,
    tonality,
    tracks: tracks.map((t) => ({
      name: t.name,
      color: t.color,
      startTime: t.startTime,
      volumeDb: t.volumeDb,
      pan: t.pan,
      muted: t.muted,
      solo: t.solo,
      // Montage : fenêtres sur l'audio (offset et longueur en échantillons de audio.sampleRate).
      clips: (t.clips ?? []).map(({ start, offset, length }) => ({ start, offset, length })),
      audio: t.audio, // { path, origin: 'file'|'take', codec, originalName, sampleRate, channels, frames }
      vocal: t.vocal, // { presetId, presetName, bypass, settings }
    })),
    // Presets personnels utilisés par les pistes : le projet reste complet sur une autre machine.
    presets: userPresets,
  };
}

/** Valide et normalise un manifeste lu sur disque. */
export function parseManifest(raw) {
  if (!raw || typeof raw !== 'object' || raw.format !== PROJECT_FORMAT) {
    throw new ProjectError('not-project', 'Ce fichier n’est pas un projet Bandloop.');
  }
  if (!Number.isInteger(raw.version) || raw.version < 1)
    throw new ProjectError('corrupt', 'Version de projet invalide.');
  if (raw.version > PROJECT_VERSION) {
    throw new ProjectError(
      'too-new',
      'Ce projet a été créé avec une version plus récente de Bandloop. Mets l’application à jour pour l’ouvrir.',
    );
  }
  if (!Array.isArray(raw.tracks)) throw new ProjectError('corrupt', 'La liste des pistes est illisible.');
  return {
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 120) : 'Projet sans titre',
    tempo: clampNum(raw.tempo, 20, 300, 120),
    zoom: clampNum(raw.zoom, 10, 400, 50),
    playhead: clampNum(raw.playhead, 0, 86400, 0),
    tonality: normalizeTonality(raw.tonality ?? {}),
    presets: Array.isArray(raw.presets)
      ? raw.presets.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string')
      : [],
    tracks: raw.tracks.map((t, i) => {
      if (!t || typeof t.audio?.path !== 'string')
        throw new ProjectError('corrupt', `La piste ${i + 1} est illisible.`);
      return {
        name: typeof t.name === 'string' && t.name ? t.name.slice(0, 120) : `Piste ${i + 1}`,
        color: COLOR.test(t.color) ? t.color : null,
        startTime: clampNum(t.startTime, 0, 86400, 0),
        volumeDb: clampNum(t.volumeDb, -60, 6, 0),
        pan: clampNum(t.pan, -1, 1, 0),
        muted: t.muted === true,
        solo: t.solo === true,
        clips: parseClips(t.clips, t.startTime),
        audio: {
          path: t.audio.path,
          origin: t.audio.origin === 'take' ? 'take' : 'file',
          codec: typeof t.audio.codec === 'string' ? t.audio.codec : '',
          originalName: typeof t.audio.originalName === 'string' ? t.audio.originalName : t.name,
          sampleRate: Number.isFinite(t.audio.sampleRate) && t.audio.sampleRate > 0 ? t.audio.sampleRate : null,
          frames: Number.isInteger(t.audio.frames) ? t.audio.frames : null,
        },
        vocal: {
          presetId: typeof t.vocal?.presetId === 'string' ? t.vocal.presetId : null,
          presetName: typeof t.vocal?.presetName === 'string' ? t.vocal.presetName : null,
          bypass: t.vocal?.bypass === true,
          settings: normalizeSettings(t.vocal?.settings ?? {}),
          tonality: t.vocal?.tonality ? normalizeTonality(t.vocal.tonality) : null,
        },
      };
    }),
  };
}

/**
 * Clips d'une piste lus sur disque. Projet v1 (pas de clips) : `null`, ce qui
 * veut dire « un clip couvrant tout l'audio, posé à startTime ».
 */
function parseClips(raw, startTime) {
  if (!Array.isArray(raw)) return null;
  const valid = (c) =>
    c &&
    Number.isFinite(c.start) &&
    c.start >= 0 &&
    Number.isInteger(c.offset) &&
    c.offset >= 0 &&
    Number.isInteger(c.length) &&
    c.length > 0;
  if (!raw.every(valid)) throw new ProjectError('corrupt', 'Le montage d’une piste est illisible.');
  return raw.map(({ start, offset, length }) => ({ start, offset, length }));
}

/** Assemble le fichier .bandloop. */
export function packProject(manifest, audioFiles) {
  const entries = [{ name: 'project.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) }];
  for (const [path, data] of audioFiles) entries.push({ name: path, data });
  return createZip(entries);
}

/**
 * Ouvre un fichier .bandloop : vérifie l'archive, le manifeste et la présence
 * de l'audio de chaque piste.
 * @returns {{ project: object, audio: Map<string, Uint8Array> }}
 */
export function unpackProject(bytes) {
  let files;
  try {
    files = readZip(bytes);
  } catch (err) {
    if (err instanceof ZipError) throw new ProjectError('corrupt', `Projet endommagé : ${err.message}`);
    throw err;
  }
  const json = files.get('project.json');
  if (!json) throw new ProjectError('not-project', 'Ce fichier n’est pas un projet Bandloop (project.json absent).');
  let raw;
  try {
    raw = JSON.parse(new TextDecoder().decode(json));
  } catch {
    throw new ProjectError('corrupt', 'Projet endommagé : project.json illisible.');
  }
  const project = parseManifest(raw);
  for (const t of project.tracks) {
    if (!files.has(t.audio.path))
      throw new ProjectError('missing-audio', `L’audio de la piste « ${t.name} » est absent du projet.`);
  }
  return { project, audio: files };
}
