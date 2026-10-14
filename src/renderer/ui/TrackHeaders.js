// Colonne de gauche : nom, volume, mute et suppression de chaque piste.
import { MAX_DB, MIN_DB } from '../audio/scheduling.js';
import { RULER_HEIGHT, TRACK_HEIGHT } from './layout.js';

export class TrackHeaders {
  constructor(container, engine) {
    this.container = container;
    this.engine = engine;
    container.style.setProperty('--ruler-height', `${RULER_HEIGHT}px`);
    container.style.setProperty('--track-height', `${TRACK_HEIGHT}px`);
  }

  render() {
    this.container.replaceChildren(
      Object.assign(document.createElement('div'), { className: 'ruler-spacer' }),
      ...this.engine.tracks.map((track) => this.#renderTrack(track)),
    );
  }

  #renderTrack(track) {
    const el = document.createElement('div');
    el.className = 'track-header';
    el.dataset.trackId = String(track.id);
    el.style.setProperty('--track-color', track.color);
    el.innerHTML = `
      <div class="track-title">
        <span class="track-color"></span>
        <span class="track-name"></span>
        <button class="icon-btn remove" title="Supprimer la piste" aria-label="Supprimer la piste">×</button>
      </div>
      <div class="track-controls">
        <button class="mute" title="Muet" aria-pressed="false">M</button>
        <input class="volume" type="range" min="${MIN_DB}" max="${MAX_DB}" step="0.5" aria-label="Volume" />
        <output class="volume-value"></output>
      </div>`;
    el.querySelector('.track-name').textContent = track.name;
    el.querySelector('.track-name').title = track.name;

    const volume = el.querySelector('.volume');
    const volumeValue = el.querySelector('.volume-value');
    const showVolume = () => {
      volumeValue.textContent = track.volumeDb <= MIN_DB ? '-∞ dB' : `${track.volumeDb.toFixed(1)} dB`;
    };
    volume.value = String(track.volumeDb);
    showVolume();
    volume.addEventListener('input', () => {
      track.setVolumeDb(Number(volume.value));
      showVolume();
    });
    // Double-clic : retour à 0 dB.
    volume.addEventListener('dblclick', () => {
      volume.value = '0';
      track.setVolumeDb(0);
      showVolume();
    });

    const mute = el.querySelector('.mute');
    mute.addEventListener('click', () => {
      track.setMuted(!track.muted);
      mute.setAttribute('aria-pressed', String(track.muted));
      this.container.dispatchEvent(new Event('trackchange'));
    });

    el.querySelector('.remove').addEventListener('click', () => this.engine.removeTrack(track.id));
    return el;
  }
}
