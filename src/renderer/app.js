// Point d'entrée du renderer : relie le moteur audio, la timeline et les panneaux.
import { AudioEngine } from './audio/AudioEngine.js';
import { PresetStore } from './presets/PresetStore.js';
import { createPresetStorage } from './presets/storage.js';
import { svg } from './ui/dom.js';
import { FxPanel } from './ui/FxPanel.js';
import { icons, logo } from './ui/icons.js';
import { Meter } from './ui/Meter.js';
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
};

const timeline = new Timeline($('#timeline'), engine, ui);
const trackPanel = new TrackPanel($('#track-panel'), engine, ui);
const fxPanel = new FxPanel($('#fx-panel'), engine, hub, presets, ui);
const meter = new Meter($('#meter'));

const playBtn = $('#btn-play');
const timeDisplay = $('#time-display');
const statusEl = $('#status');

// Exposé pour le débogage dans la console DevTools.
Object.assign(window, { engine, hub, presets });

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
  await importFiles(await readBrowserFiles(e.dataTransfer.files));
});

// --- Transport --------------------------------------------------------------

function togglePlay() {
  if (engine.state === 'playing') engine.pause();
  else engine.play();
}

playBtn.addEventListener('click', togglePlay);
$('#btn-stop').addEventListener('click', () => engine.stop());
$('#btn-start').addEventListener('click', () => engine.seek(0));
$('#btn-fx-toggle').addEventListener('click', () => setFxOpen(!fxPanel.isOpen));

const isTextField = (el) =>
  el instanceof HTMLSelectElement ||
  (el instanceof HTMLInputElement && !['range', 'checkbox', 'button'].includes(el.type)) ||
  el?.isContentEditable;

window.addEventListener('keydown', (e) => {
  if (isTextField(e.target)) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.code === 'Enter') {
    e.preventDefault();
    engine.stop();
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

engine.addEventListener('mix', () => {
  trackPanel.refresh();
  timeline.invalidate();
});

hub.addEventListener('change', () => {
  trackPanel.refresh();
  timeline.invalidate();
});

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
    if (engine.position >= engine.duration) engine.stop();
    else timeline.followPlayhead();
  }
  timeDisplay.textContent = formatTime(engine.position);
  meter.update(engine.state === 'playing' ? engine.readMeters() : [0, 0]);
  timeline.render();
  requestAnimationFrame(frame);
}

trackPanel.render();
updateInfo();
requestAnimationFrame(frame);
presets.load();
