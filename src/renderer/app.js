// Point d'entrée du renderer : relie le moteur audio, la timeline et les contrôles.
import { AudioEngine } from './audio/AudioEngine.js';
import { Timeline } from './ui/Timeline.js';
import { TrackHeaders } from './ui/TrackHeaders.js';
import { formatTime } from './ui/time.js';

const $ = (sel) => document.querySelector(sel);

const engine = new AudioEngine();
const timeline = new Timeline($('#timeline'), engine);
const headers = new TrackHeaders($('#track-headers'), engine);

const playBtn = $('#btn-play');
const timeDisplay = $('#time-display');
const statusEl = $('#status');

// Exposé pour le débogage dans la console DevTools.
window.engine = engine;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
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
        `${name} chargé (${formatTime(track.duration)}, ${channels > 1 ? 'stéréo' : 'mono'}, ${track.buffer.sampleRate} Hz)`,
      );
    } catch (err) {
      console.error(err);
      setStatus(`Impossible de décoder ${name} : format non pris en charge ?`, true);
    }
  }
}

$('#btn-import').addEventListener('click', async () => {
  if (window.bandloop) {
    importFiles(await window.bandloop.openAudioFiles());
  } else {
    $('#file-input').click(); // hors Electron (navigateur) : sélecteur HTML standard
  }
});

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

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.code === 'Enter' || e.code === 'Home') {
    e.preventDefault();
    engine.stop();
  }
});

$('#zoom').addEventListener('input', (e) => timeline.setZoom(Number(e.target.value)));

// --- Réactions aux changements du moteur ------------------------------------

engine.addEventListener('state', () => {
  const playing = engine.state === 'playing';
  playBtn.textContent = playing ? '❚❚' : '▶';
  playBtn.classList.toggle('playing', playing);
  playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Lecture');
});

engine.addEventListener('tracks', () => {
  headers.render();
  timeline.invalidate();
  $('#empty-state').hidden = engine.tracks.length > 0;
});

$('#track-headers').addEventListener('trackchange', () => timeline.invalidate());

// --- Boucle d'affichage -----------------------------------------------------

function frame() {
  if (engine.state === 'playing') {
    if (engine.position >= engine.duration) engine.stop();
    else timeline.followPlayhead();
  }
  timeDisplay.textContent = formatTime(engine.position);
  timeline.render();
  requestAnimationFrame(frame);
}

headers.render();
requestAnimationFrame(frame);
