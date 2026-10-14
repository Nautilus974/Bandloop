// Point d'entrée du renderer : relie le moteur audio, la timeline et les panneaux.
import { AudioEngine } from './audio/AudioEngine.js';
import { ExportManager } from './export/ExportManager.js';
import { ExportError } from './export/mixdown.js';
import { PROJECT_EXTENSION } from './project/format.js';
import { ProjectManager } from './project/ProjectManager.js';
import { PresetStore } from './presets/PresetStore.js';
import { createPresetStorage } from './presets/storage.js';
import { Recorder } from './record/Recorder.js';
import { svg } from './ui/dom.js';
import { AddTrackMenu } from './ui/AddTrackMenu.js';
import { alertDialog, unsavedDialog } from './ui/Dialog.js';
import { ExportDialog } from './ui/ExportDialog.js';
import { PopupMenu } from './ui/PopupMenu.js';
import { FxPanel } from './ui/FxPanel.js';
import { icons, logo } from './ui/icons.js';
import { Meter } from './ui/Meter.js';
import { RecordPanel } from './ui/RecordPanel.js';
import { Timeline } from './ui/Timeline.js';
import { formatTime } from './ui/time.js';
import { TrackPanel } from './ui/TrackPanel.js';
import { VocalHub } from './vocal/VocalHub.js';

const $ = (sel) => document.querySelector(sel);

// Icônes déclarées dans le HTML via data-icon.
for (const el of document.querySelectorAll('[data-icon]')) el.prepend(svg(icons[el.dataset.icon]));
$('#logo').append(svg(logo));
$('#empty-logo').append(svg(logo));

const engine = new AudioEngine();
// Créé avant les écouteurs de l'interface : il prépare l'état vocal de chaque
// nouvelle piste avant que les panneaux ne se redessinent.
const hub = new VocalHub(engine);
const presets = new PresetStore(createPresetStorage());
const bridge = window.bandloop;
const recorder = new Recorder(engine, {
  platform: bridge?.platform ?? 'web',
  requestSystemAccess: bridge?.mic ? () => bridge.mic.requestAccess() : undefined,
});

// --- État d'interface -------------------------------------------------------

let selectedId = null;

const ui = {
  getSelectedId: () => selectedId,
  select(id) {
    if (id === selectedId) return;
    selectedId = id;
    trackPanel.refresh();
    timeline.invalidate();
    fxPanel.render();
  },
  openFx(id) {
    ui.select(id);
    setFxOpen(true);
  },
  hasFx: (id) => hub.hasFx(id),
  /** Libellé affiché sur le clip : nom du preset, « FX » ou rien. */
  fxLabel(id) {
    if (!hub.hasFx(id)) return null;
    const state = hub.getState(id);
    return (state.presetId && presets.get(state.presetId)?.name) || 'FX';
  },
  onClose: () => setFxOpen(false),
  notify: (message, isError) => setStatus(message, isError),
  getLiveTake: () => recorder.liveTake,
  isRecording: () => recorder.state === 'recording' || recorder.state === 'finishing',
  openAddMenu: (anchor) => addTrackMenu.toggle(anchor),
};

const addTrackMenu = new AddTrackMenu({
  // Ouvre le panneau d'enregistrement : choix du micro, niveau, puis « Enregistrer ».
  record: () => setRecordPanelOpen(true),
  importFile: () => openImportDialog(),
});

const timeline = new Timeline($('#timeline'), engine, ui);
const trackPanel = new TrackPanel($('#track-panel'), engine, ui);
const fxPanel = new FxPanel($('#fx-panel'), engine, hub, presets, ui);
const meter = new Meter($('#meter'));
const recordPanel = new RecordPanel($('#record-panel'), recorder, {
  engine,
  openSystemSettings: bridge?.mic ? () => bridge.mic.openSettings() : undefined,
  onClose: () => setRecordPanelOpen(false),
  notify: (message, isError) => setStatus(message, isError),
});

const playBtn = $('#btn-play');
const timeDisplay = $('#time-display');
const statusEl = $('#status');

// Exposé pour le débogage dans la console DevTools.
Object.assign(window, { engine, hub, presets, recorder });

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function setFxOpen(open) {
  if (open) fxPanel.open();
  else fxPanel.close();
  $('#btn-fx-toggle').setAttribute('aria-pressed', String(open));
  timeline.invalidate();
}

function setRecordPanelOpen(open) {
  if (open) recordPanel.open();
  else recordPanel.close();
  $('#btn-record-settings').setAttribute('aria-expanded', String(open));
}

function updateInfo() {
  const n = engine.tracks.length;
  $('#time-total').textContent = `/ ${formatTime(engine.duration)}`;
  $('#status-info').textContent =
    `${(engine.ctx.sampleRate / 1000).toLocaleString('fr-FR')} kHz · ${n === 0 ? 'aucune piste' : `${n} piste${n > 1 ? 's' : ''}`}`;
}

// --- Import de fichiers -----------------------------------------------------

async function importFiles(files) {
  // files : [{ name, data: ArrayBuffer | Uint8Array }]
  for (const { name, data } of files) {
    setStatus(`Décodage de ${name}…`);
    const buffer =
      data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    try {
      const track = await engine.addTrack(name, buffer);
      const channels = track.buffer.numberOfChannels;
      setStatus(
        `${name} importé · ${formatTime(track.duration)} · ${channels > 1 ? 'stéréo' : 'mono'} · ${track.buffer.sampleRate} Hz`,
      );
      if (selectedId === null) ui.select(track.id);
    } catch (err) {
      console.error(err);
      setStatus(`Impossible de décoder ${name} : format non pris en charge ?`, true);
    }
  }
}

async function openImportDialog() {
  if (window.bandloop) {
    importFiles(await window.bandloop.openAudioFiles());
  } else {
    $('#file-input').click(); // hors Electron (navigateur) : sélecteur HTML standard
  }
}

$('#btn-import').addEventListener('click', openImportDialog);
$('#btn-import-empty').addEventListener('click', openImportDialog);
$('#btn-record-empty').addEventListener('click', () => setRecordPanelOpen(true));

$('#file-input').addEventListener('change', async (e) => {
  await importFiles(await readBrowserFiles(e.target.files));
  e.target.value = '';
});

function readBrowserFiles(fileList) {
  return Promise.all([...fileList].map(async (file) => ({ name: file.name, data: await file.arrayBuffer() })));
}

// Glisser-déposer depuis le Finder / l'Explorateur.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth === 0) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const files = [...e.dataTransfer.files];
  const projectFile = files.find((f) => f.name.toLowerCase().endsWith(`.${PROJECT_EXTENSION}`));
  // Un projet .bandloop lâché sur la fenêtre est ouvert ; les fichiers audio sont importés.
  if (projectFile) await project.openBytes(new Uint8Array(await projectFile.arrayBuffer()), null);
  else await importFiles(await readBrowserFiles(files));
});

// --- Transport --------------------------------------------------------------

const recording = () => recorder.state === 'recording' || recorder.state === 'countdown';

function togglePlay() {
  if (recording())
    recorder.stop(); // pendant une prise, lecture/pause = fin de prise
  else if (engine.state === 'playing') engine.pause();
  else engine.play();
}

async function toggleRecord() {
  if (recording()) return recorder.stop();
  await recorder.record();
  // Accès refusé, pas de micro… : on affiche le panneau avec le message.
  if (recorder.error && !recordPanel.isOpen) setRecordPanelOpen(true);
}

function stopAll() {
  if (recording()) recorder.stop();
  else engine.stop();
}

playBtn.addEventListener('click', togglePlay);
$('#btn-stop').addEventListener('click', stopAll);
$('#btn-record').addEventListener('click', toggleRecord);
$('#btn-record-settings').addEventListener('click', (e) => {
  setRecordPanelOpen(!recordPanel.isOpen);
  if (e.detail > 0) e.currentTarget.blur(); // clic souris : pas d'anneau de focus résiduel
});
$('#btn-start').addEventListener('click', () => engine.seek(0));
$('#btn-fx-toggle').addEventListener('click', () => setFxOpen(!fxPanel.isOpen));

const isTextField = (el) =>
  el instanceof HTMLSelectElement ||
  (el instanceof HTMLInputElement && !['range', 'checkbox', 'button'].includes(el.type)) ||
  el?.isContentEditable;

window.addEventListener('keydown', (e) => {
  // Hors Electron (navigateur), les raccourcis de fichier ne passent pas par le menu natif.
  if (!bridge && (e.ctrlKey || e.metaKey) && !e.altKey) {
    const command = { KeyS: e.shiftKey ? 'save-as' : 'save', KeyO: 'open', KeyN: 'new', KeyE: 'export' }[e.code];
    if (command) {
      e.preventDefault();
      runCommand(command);
      return;
    }
  }
  if (isTextField(e.target)) return;
  // Entrée active le bouton qui a le focus (accessibilité clavier) ; dans un menu ou
  // une boîte de dialogue, Entrée et Espace gardent leur rôle natif.
  const inPopup = e.target instanceof Element && e.target.closest('.menu, dialog');
  if (
    (e.code === 'Enter' && e.target instanceof HTMLButtonElement) ||
    (inPopup && (e.code === 'Enter' || e.code === 'Space'))
  )
    return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.code === 'Enter') {
    e.preventDefault();
    stopAll();
  } else if (e.code === 'KeyR' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    toggleRecord();
  } else if (e.code === 'Escape') {
    if (recorder.state === 'countdown') recorder.stop();
    else if (recordPanel.isOpen && !document.querySelector('dialog[open]')) setRecordPanelOpen(false);
  } else if (e.altKey && e.code.startsWith('Arrow') && !(e.target instanceof HTMLInputElement) && selectedId !== null) {
    // Alt+↑/↓ : changer la piste de place ; Alt+←/→ : décaler son clip (Maj : par seconde).
    e.preventDefault();
    const track = engine.getTrack(selectedId);
    if (!track || engine.locked) return;
    const index = engine.tracks.indexOf(track);
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      engine.moveTrack(track.id, index + (e.code === 'ArrowUp' ? -1 : 1));
    } else {
      const step = (e.shiftKey ? 1 : 0.1) * (e.code === 'ArrowLeft' ? -1 : 1);
      engine.setTrackStart(track.id, track.startTime + step);
    }
  } else if (e.code === 'Home') {
    e.preventDefault();
    engine.seek(0);
  }
});

const zoom = $('#zoom');
const setZoom = (value) => {
  zoom.value = String(value);
  timeline.setZoom(Number(zoom.value));
};
zoom.addEventListener('input', () => setZoom(zoom.value));
$('#zoom-in').addEventListener('click', () => setZoom(Number(zoom.value) * 1.4));
$('#zoom-out').addEventListener('click', () => setZoom(Number(zoom.value) / 1.4));

// --- Projet : nouveau, ouvrir, enregistrer ; export du mix --------------------

/** Accès aux fichiers : Electron (dialogues natifs) ou navigateur (téléchargement / sélecteur). */
const io = bridge?.files
  ? {
      chooseSavePath: (opts) => bridge.files.chooseSavePath(opts),
      writeFile: (path, bytes, action) => bridge.files.write(path, bytes, action),
      openProjectFile: () => bridge.project.openDialog(),
      showInFolder: (path) => bridge.files.showInFolder(path),
    }
  : {
      chooseSavePath: async ({ suggestedName }) => suggestedName,
      async writeFile(path, bytes) {
        const url = URL.createObjectURL(new Blob([bytes]));
        Object.assign(document.createElement('a'), { href: url, download: path }).click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        return { ok: true, path, size: bytes.byteLength };
      },
      openProjectFile: () =>
        new Promise((resolve) => {
          const input = Object.assign(document.createElement('input'), {
            type: 'file',
            accept: `.${PROJECT_EXTENSION}`,
          });
          input.onchange = async () => {
            const file = input.files[0];
            resolve(file ? { path: null, bytes: new Uint8Array(await file.arrayBuffer()) } : null);
          };
          input.click();
        }),
    };

const tempoInput = $('#tempo');
const projectNameInput = $('#project-name');
const busy = (text) => {
  $('#busy').hidden = !text;
  $('#busy-text').textContent = text ?? '';
};

const project = new ProjectManager({
  engine,
  hub,
  presets,
  io,
  view: {
    getZoom: () => Number(zoom.value),
    setZoom: (v) => setZoom(v),
    getTempo: () => Number(tempoInput.value) || 120,
    setTempo: (v) => (tempoInput.value = String(v)),
    isBusy: () => recorder.busy,
  },
  ask: {
    unsaved: (name) => unsavedDialog(name),
    error: (title, text) => {
      setStatus(`${title} : ${text}`, true);
      alertDialog(title, text);
    },
    progress: busy,
  },
});
window.project = project;

function syncDocument() {
  document.title = project.title;
  if (document.activeElement !== projectNameInput) projectNameInput.value = project.name;
  bridge?.window?.setDocument({ title: project.title, name: project.name, edited: project.dirty, path: project.path });
}
project.addEventListener('change', syncDocument);
syncDocument();

projectNameInput.addEventListener('change', () => project.setName(projectNameInput.value));
projectNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') projectNameInput.blur();
});
tempoInput.addEventListener('change', () => {
  tempoInput.value = String(Math.min(300, Math.max(20, Math.round(Number(tempoInput.value) || 120))));
  project.markDirty();
});

const exporter = new ExportManager({ engine, hub, io });
const exportDialog = new ExportDialog({
  duration: () => engine.duration,
  sampleRate: engine.ctx.sampleRate,
  projectName: () => project.name,
  showInFolder: io.showInFolder,
  async start(options) {
    const path = await io.chooseSavePath({ kind: options.format, suggestedName: `${project.name}.${options.format}` });
    if (!path) return null;
    const signal = exportDialog.showProgress();
    try {
      const result = await exporter.run(options, path, { signal, onPhase: (text, f) => exportDialog.phase(text, f) });
      exportDialog.showDone(result);
      setStatus(`Mix exporté : ${String(result.path).split(/[\\/]/).pop()}`);
      return result;
    } catch (err) {
      if (err.name === 'AbortError') {
        exportDialog.close();
        setStatus('Export annulé.');
      } else {
        console.error(err);
        exportDialog.showError(
          'L’export a échoué',
          err instanceof ExportError ? err.message : `Erreur inattendue : ${err.message}`,
        );
      }
      return null;
    }
  },
});

function openExport() {
  if (recorder.busy) return setStatus('Termine d’abord l’enregistrement en cours.', true);
  if (!engine.tracks.length)
    return alertDialog('Rien à exporter', 'Ajoute au moins une piste avant d’exporter le mix.');
  exportDialog.open();
}

async function runCommand(command, payload = {}) {
  switch (command) {
    case 'new':
      if (await project.newProject()) setStatus('Nouveau projet.');
      break;
    case 'open':
      if (await project.open()) setStatus(`Projet « ${project.name} » ouvert.`);
      break;
    case 'open-path': {
      if (!(await project.confirmDiscard())) break;
      const file = await bridge.project.read(payload.path);
      if (file?.error) alertDialog('Impossible d’ouvrir le projet', file.error.message);
      else if (await project.openBytes(file.bytes, file.path, { confirmed: true }))
        setStatus(`Projet « ${project.name} » ouvert.`);
      break;
    }
    case 'save':
    case 'save-as':
      if (await project.save({ as: command === 'save-as' }))
        setStatus(`Projet enregistré : ${String(project.path).split(/[\\/]/).pop()}`);
      break;
    case 'save-then-close':
      // Fermeture de la fenêtre demandée avec « Enregistrer » : on ferme seulement si c'est fait.
      if (await project.save()) bridge?.window?.closeNow();
      break;
    case 'export':
      openExport();
      break;
  }
}
bridge?.onMenu?.(({ command, ...payload }) => runCommand(command, payload));

const fileMenu = new PopupMenu('Fichier', () => {
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  return [
    { icon: svg(icons.file), title: 'Nouveau projet', shortcut: `${mod}N`, run: () => runCommand('new') },
    { icon: svg(icons.folder), title: 'Ouvrir…', shortcut: `${mod}O`, run: () => runCommand('open') },
    'separator',
    { icon: svg(icons.save), title: 'Enregistrer', shortcut: `${mod}S`, run: () => runCommand('save') },
    { title: 'Enregistrer sous…', shortcut: `${mod}⇧S`, run: () => runCommand('save-as') },
    'separator',
    {
      icon: svg(icons.export),
      title: 'Exporter le mix…',
      shortcut: `${mod}E`,
      disabled: !engine.tracks.length,
      run: () => runCommand('export'),
    },
  ];
});
$('#btn-file').addEventListener('click', (e) => fileMenu.toggle(e.currentTarget));
$('#btn-export').addEventListener('click', openExport);

// --- Réactions aux changements du moteur ------------------------------------

engine.addEventListener('state', () => {
  const playing = engine.state === 'playing';
  playBtn.replaceChildren(svg(playing ? icons.pause : icons.play));
  playBtn.classList.toggle('playing', playing);
  playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Lecture');
});

engine.addEventListener('tracks', () => {
  if (selectedId !== null && !engine.getTrack(selectedId)) selectedId = engine.tracks[0]?.id ?? null;
  trackPanel.render();
  trackPanel.refresh();
  timeline.invalidate();
  fxPanel.render();
  updateInfo();
  $('#empty-state').hidden = engine.tracks.length > 0;
});

// Clip déplacé dans le temps : la durée du projet et l'affichage changent.
engine.addEventListener('arrange', ({ detail }) => {
  timeline.invalidate();
  updateInfo();
  const track = engine.getTrack(detail.id);
  if (track) setStatus(`${track.name} commence à ${formatTime(track.startTime)}.`);
});

engine.addEventListener('mix', () => {
  trackPanel.refresh();
  timeline.invalidate();
});

hub.addEventListener('change', () => {
  trackPanel.refresh();
  timeline.invalidate();
});

// --- Enregistrement ---------------------------------------------------------

let lastRecorderState = recorder.state;
recorder.addEventListener('change', () => {
  const { state } = recorder;
  const rec = state === 'recording' || state === 'finishing';
  document.body.classList.toggle('is-recording', rec);
  $('#btn-record').classList.toggle('armed', state === 'countdown' || rec);
  $('#btn-record').setAttribute(
    'aria-label',
    rec || state === 'countdown' ? 'Arrêter l’enregistrement' : 'Enregistrer',
  );
  $('#countdown').hidden = state !== 'countdown';
  const countEl = $('#countdown-value');
  if (countEl.textContent !== String(recorder.countdownValue || '')) {
    countEl.textContent = String(recorder.countdownValue || '');
    countEl.style.animation = 'none';
    void countEl.offsetWidth; // relance l'animation à chaque chiffre
    countEl.style.animation = '';
  }
  if (state === 'countdown') setStatus('Prépare-toi… (Échap pour annuler)');
  if (state === 'recording' && lastRecorderState !== 'recording') {
    setStatus(`Enregistrement depuis ${recorder.deviceLabel || 'le micro'}… (Espace ou R pour arrêter)`);
  }
  // La voie « enregistrement en cours » apparaît / disparaît.
  if (rec !== (lastRecorderState === 'recording' || lastRecorderState === 'finishing')) {
    trackPanel.render();
    trackPanel.refresh();
    timeline.invalidate();
  }
  if (recorder.error && state === 'idle') setStatus(`${recorder.error.title} : ${recorder.error.text}`, true);
  lastRecorderState = state;
});

recorder.addEventListener('take', ({ detail }) => {
  const { track, latency } = detail;
  ui.select(track.id);
  setStatus(
    `${track.name} ajoutée à ${formatTime(track.startTime)} (latence compensée : ${Math.round(latency * 1000)} ms). Clique sur FX pour lui appliquer un preset vocal.`,
  );
});

recorder.addEventListener('message', ({ detail }) => setStatus(detail.text));

const RENDER_MESSAGES = {
  analyzing: 'Analyse de la hauteur de « %s »…',
  rendering: 'Calcul des effets vocaux de « %s »…',
  ready: 'Effets vocaux de « %s » à jour.',
};
hub.addEventListener('status', ({ detail }) => {
  const state = hub.getState(detail.trackId);
  const track = engine.getTrack(detail.trackId);
  if (!state || !track) return;
  if (state.status === 'error') setStatus(`Échec du calcul des effets de « ${track.name} » : ${state.error}`, true);
  else if (RENDER_MESSAGES[state.status]) setStatus(RENDER_MESSAGES[state.status].replace('%s', track.name));
});

// --- Boucle d'affichage -----------------------------------------------------

function frame() {
  if (engine.state === 'playing') {
    // Pendant une prise, le transport continue au-delà de la fin du projet.
    if (!engine.locked && engine.position >= engine.duration) engine.stop();
    else timeline.followPlayhead();
  }
  timeDisplay.textContent = formatTime(engine.position);
  meter.update(engine.state === 'playing' ? engine.readMeters() : [0, 0]);
  if (recorder.state === 'recording') {
    timeline.invalidate(); // la prise s'allonge
    $('#btn-record').style.setProperty('--level', Math.min(1, recorder.readLevel() * 2));
  }
  recordPanel.tick();
  timeline.render();
  requestAnimationFrame(frame);
}

trackPanel.render();
updateInfo();
requestAnimationFrame(frame);
presets.load();
