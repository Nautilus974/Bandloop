// Gestion du projet courant : nouveau, ouvrir, enregistrer, enregistrer sous,
// suivi des modifications non enregistrées (titre de fenêtre avec « * »).
import { newClipId, rescaleClips } from '../audio/clips.js';
import { encodeFlac, floatToInt } from './flac.js';
import {
  audioExtension,
  buildManifest,
  packProject,
  PROJECT_EXTENSION,
  ProjectError,
  slugify,
  unpackProject,
} from './format.js';
import { encodeWav } from './wav.js';

export const UNTITLED = 'Projet sans titre';
const TAKE_BITS = 24;

/** Encodeur FLAC en arrière-plan (Worker), avec repli sur le thread principal. */
class FlacEncoder {
  constructor() {
    this.jobs = new Map();
    this.next = 1;
    try {
      this.worker = new Worker(new URL('./codec-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }) => {
        const job = this.jobs.get(data.id);
        this.jobs.delete(data.id);
        if (data.ok) job?.resolve(data.bytes);
        else job?.reject(new Error(data.error));
      };
    } catch {
      this.worker = null;
    }
  }

  encode(channels, sampleRate) {
    if (!this.worker) {
      return Promise.resolve(
        encodeFlac(
          channels.map((c) => floatToInt(c, TAKE_BITS)),
          { sampleRate, bitsPerSample: TAKE_BITS },
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const id = this.next++;
      this.jobs.set(id, { resolve, reject });
      const copies = channels.map((c) => c.slice());
      this.worker.postMessage(
        { id, channels: copies, sampleRate, bits: TAKE_BITS },
        copies.map((c) => c.buffer),
      );
    });
  }
}

export class ProjectManager extends EventTarget {
  /**
   * @param {object} deps
   * @param {import('../audio/AudioEngine.js').AudioEngine} deps.engine
   * @param {import('../vocal/VocalHub.js').VocalHub} deps.hub
   * @param {import('../presets/PresetStore.js').PresetStore} deps.presets
   * @param {object} deps.io     Accès fichiers (Electron ou navigateur), voir app.js
   * @param {object} deps.view   { getZoom, setZoom, getTempo, setTempo, isBusy }
   * @param {object} deps.ask    { unsaved(name) -> 'save'|'discard'|'cancel', error(title, text), progress(text|null) }
   */
  constructor({ engine, hub, presets, io, view, ask, appVersion = '' }) {
    super();
    Object.assign(this, { engine, hub, presets, io, view, ask, appVersion });
    this.name = UNTITLED;
    this.path = null;
    this.dirty = false;
    this.restoring = false;
    this.flac = new FlacEncoder();
    const touch = () => this.markDirty();
    engine.addEventListener('edit', touch);
    hub.addEventListener('change', touch);
    hub.addEventListener('tonality', touch);
  }

  get title() {
    return `${this.name}${this.dirty ? ' *' : ''} — Bandloop`;
  }

  markDirty() {
    if (this.restoring || this.dirty) return;
    this.dirty = true;
    this.#emit();
  }

  setName(name) {
    const clean = String(name ?? '').trim() || UNTITLED;
    if (clean === this.name) return;
    this.name = clean;
    this.markDirty();
    this.#emit();
  }

  // ------------------------------------------------------------------ enregistrer

  /** @returns {Promise<boolean>} vrai si le projet a été enregistré */
  async save({ as = false } = {}) {
    if (this.view.isBusy?.()) {
      this.ask.error('Enregistrement impossible', 'Termine d’abord l’enregistrement en cours.');
      return false;
    }
    let path = this.path;
    if (!path || as) {
      path = await this.io.chooseSavePath({ kind: 'project', suggestedName: `${this.name}.${PROJECT_EXTENSION}` });
      if (!path) return false;
    }
    this.ask.progress('Enregistrement du projet…');
    const previousName = this.name;
    // Premier enregistrement ou « Enregistrer sous » : le projet prend le nom du fichier
    // (avant la sérialisation, pour que le nom enregistré soit le bon).
    if (as || this.name === UNTITLED) this.name = fileBaseName(path) || this.name;
    try {
      const bytes = await this.serialize();
      const result = await this.io.writeFile(path, bytes);
      if (result?.error) {
        this.name = previousName;
        this.ask.error('Le projet n’a pas été enregistré', result.error.message);
        return false;
      }
      this.path = result?.path ?? path;
      this.dirty = false;
      this.#emit();
      return true;
    } catch (err) {
      console.error(err);
      this.name = previousName;
      this.ask.error('Le projet n’a pas été enregistré', err.message);
      return false;
    } finally {
      this.ask.progress(null);
    }
  }

  /** Construit le fichier .bandloop (manifeste + audio embarqué). */
  async serialize() {
    const audioFiles = new Map();
    const tracks = [];
    const usedUserPresets = new Map();
    for (const [i, track] of this.engine.tracks.entries()) {
      const audio = await this.#trackAudio(track);
      const path = `audio/${String(i + 1).padStart(2, '0')}-${slugify(track.name)}.${audio.ext}`;
      audioFiles.set(path, audio.bytes);
      const state = this.hub.getState(track.id);
      const preset = state?.presetId ? this.presets.get(state.presetId) : null;
      if (preset && !preset.builtin) {
        usedUserPresets.set(preset.id, {
          id: preset.id,
          name: preset.name,
          description: preset.description,
          settings: preset.settings,
        });
      }
      tracks.push({
        name: track.name,
        color: track.color,
        startTime: track.startTime,
        volumeDb: track.volumeDb,
        pan: track.pan,
        muted: track.muted,
        solo: track.solo,
        clips: track.clips,
        audio: {
          path,
          origin: track.origin?.kind === 'file' ? 'file' : 'take',
          codec: audio.ext,
          originalName: track.origin?.name ?? track.name,
          sampleRate: track.buffer.sampleRate,
          channels: track.buffer.numberOfChannels,
          frames: track.buffer.length,
        },
        vocal: {
          presetId: preset ? preset.id : null,
          presetName: preset ? preset.name : null,
          bypass: !!state?.bypass,
          settings: state?.settings ?? {},
          // Tonalité propre à la piste (null : elle suit celle du morceau).
          tonality: state?.tonality ?? null,
          // Nettoyage de la voix (empreinte du bruit : zone de l'audio, pas de spectre stocké).
          clean: state?.clean ?? null,
        },
      });
    }
    const manifest = buildManifest({
      name: this.name,
      tempo: this.view.getTempo(),
      zoom: this.view.getZoom(),
      playhead: this.engine.position,
      tonality: this.hub.tonality,
      tracks,
      userPresets: [...usedUserPresets.values()],
      appVersion: this.appVersion,
    });
    return packProject(manifest, audioFiles);
  }

  /**
   * Audio à embarquer pour une piste :
   *  - fichier importé : ses octets d'origine ;
   *  - prise micro : FLAC 24 bits, vérifié par un décodage complet (repli WAV
   *    flottant si la vérification échoue), puis mis en cache sur la piste.
   */
  async #trackAudio(track) {
    const src = track.origin ?? { kind: 'take' };
    if (src.kind === 'file' && src.bytes) return { bytes: src.bytes, ext: audioExtension(src.name, 'audio') };
    if (src.bytes) return { bytes: src.bytes, ext: src.codec };

    const { buffer } = track;
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    let bytes = await this.flac.encode(channels, buffer.sampleRate);
    let ext = 'flac';
    if (!(await this.#verifyFlac(bytes, channels))) {
      console.warn(`Vérification FLAC échouée pour « ${track.name} » : enregistrement en WAV flottant.`);
      bytes = encodeWav(channels, buffer.sampleRate, { bitDepth: 32 });
      ext = 'wav';
    }
    track.origin = { ...src, kind: 'take', bytes, codec: ext };
    return { bytes, ext };
  }

  /** Décode le FLAC produit et compare à la quantification 24 bits attendue. */
  async #verifyFlac(bytes, channels) {
    try {
      const decoded = await this.engine.ctx.decodeAudioData(bytes.slice().buffer);
      if (decoded.length !== channels[0].length || decoded.numberOfChannels !== channels.length) return false;
      const max = 2 ** (TAKE_BITS - 1);
      for (let c = 0; c < channels.length; c++) {
        const d = decoded.getChannelData(c);
        const ref = floatToInt(channels[c], TAKE_BITS);
        for (let i = 0; i < d.length; i++) if (Math.abs(d[i] * max - ref[i]) > 0.5) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ ouvrir / nouveau

  /** Demande quoi faire des modifications non enregistrées. @returns {Promise<boolean>} on peut continuer */
  async confirmDiscard() {
    if (!this.dirty) return true;
    const choice = await this.ask.unsaved(this.name);
    if (choice === 'save') return this.save();
    return choice === 'discard';
  }

  async newProject() {
    if (this.view.isBusy?.() || !(await this.confirmDiscard())) return false;
    this.restoring = true;
    try {
      this.engine.clear();
      this.hub.setTonality({ key: 0, scale: 'major' });
      this.view.setTempo(120);
      this.view.setZoom(50);
      this.name = UNTITLED;
      this.path = null;
      this.dirty = false;
    } finally {
      this.restoring = false;
    }
    this.#emit();
    this.dispatchEvent(new Event('load'));
    return true;
  }

  async open() {
    if (this.view.isBusy?.() || !(await this.confirmDiscard())) return false;
    const file = await this.io.openProjectFile();
    if (!file) return false;
    if (file.error) {
      this.ask.error('Impossible d’ouvrir le projet', file.error.message);
      return false;
    }
    return this.openBytes(file.bytes, file.path, { confirmed: true });
  }

  /** Ouvre un projet à partir de ses octets (menu Ouvrir, glisser-déposer, tests). */
  async openBytes(bytes, path = null, { confirmed = false } = {}) {
    if (!confirmed && !(await this.confirmDiscard())) return false;
    let unpacked;
    try {
      unpacked = unpackProject(bytes);
    } catch (err) {
      this.ask.error(
        'Impossible d’ouvrir le projet',
        err instanceof ProjectError ? err.message : `Fichier illisible (${err.message}).`,
      );
      return false;
    }
    this.ask.progress('Ouverture du projet…');
    try {
      const warnings = await this.#restore(unpacked.project, unpacked.audio);
      this.path = path;
      this.dirty = false;
      this.#emit();
      this.dispatchEvent(new Event('load'));
      if (warnings.length) this.ask.error('Projet ouvert partiellement', warnings.join('\n'));
      return true;
    } finally {
      this.ask.progress(null);
    }
  }

  /**
   * Clips d'une piste ouverte. L'audio décodé peut avoir une autre fréquence que
   * lors de l'enregistrement (décodage rééchantillonné à la fréquence de la
   * carte son) : les positions en échantillons sont alors converties.
   */
  #restoreClips(t, buffer) {
    const fromRate = t.audio.sampleRate ?? buffer.sampleRate;
    return rescaleClips(t.clips, fromRate, buffer.sampleRate, buffer.length)
      .filter((c) => c.offset < buffer.length)
      .map((c) => ({
        id: newClipId(),
        start: c.start,
        offset: c.offset,
        length: Math.max(1, Math.min(c.length, buffer.length - c.offset)),
      }));
  }

  async #restore(project, audio) {
    const warnings = [];
    this.restoring = true;
    try {
      this.engine.clear();
      // Presets personnels du projet absents de cette machine : ajoutés à « Mes presets ».
      await this.presets.importPresets(project.presets);
      this.hub.setTonality(project.tonality);
      this.view.setTempo(project.tempo);
      this.view.setZoom(project.zoom);
      for (const t of project.tracks) {
        const bytes = audio.get(t.audio.path);
        let buffer;
        try {
          buffer = await this.engine.ctx.decodeAudioData(bytes.slice().buffer);
        } catch {
          warnings.push(`L’audio de la piste « ${t.name} » est illisible : piste ignorée.`);
          continue;
        }
        const origin =
          t.audio.origin === 'file'
            ? { kind: 'file', name: t.audio.originalName, bytes }
            : { kind: 'take', bytes, codec: t.audio.codec };
        const track = this.engine.addBufferTrack(t.name, buffer, {
          startTime: t.startTime,
          origin,
          color: t.color ?? undefined,
        });
        if (t.clips) this.engine.setClips(track.id, this.#restoreClips(t, buffer));
        this.engine.setVolume(track.id, t.volumeDb);
        this.engine.setPan(track.id, t.pan);
        if (t.muted) this.engine.setMuted(track.id, true);
        if (t.solo) this.engine.setSolo(track.id, true);
        const presetId = t.vocal.presetId && this.presets.get(t.vocal.presetId) ? t.vocal.presetId : null;
        if (t.vocal.tonality) this.hub.setTrackTonality(track.id, t.vocal.tonality);
        if (t.vocal.clean.enabled) this.hub.setClean(track.id, t.vocal.clean);
        this.hub.setSettings(track.id, t.vocal.settings, { presetId });
        if (t.vocal.bypass) this.hub.setBypass(track.id, true);
      }
      this.engine.seek(project.playhead);
      this.name = project.name;
    } finally {
      this.restoring = false;
    }
    return warnings;
  }

  #emit() {
    this.dispatchEvent(new Event('change'));
  }
}

/** « /dossier/Mon morceau.bandloop » -> « Mon morceau ». */
export function fileBaseName(path) {
  return String(path ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(new RegExp(`\\.${PROJECT_EXTENSION}$`, 'i'), '');
}
