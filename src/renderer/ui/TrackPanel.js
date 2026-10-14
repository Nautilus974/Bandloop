// Panneau de pistes (colonne de gauche) : une tranche par piste avec
// volume, panoramique, mute, solo, accès aux effets et suppression.
import { laneAt } from '../audio/arrange.js';
import { formatPan } from '../audio/mixing.js';
import { MAX_DB, MIN_DB } from '../audio/scheduling.js';
import { h, svg } from './dom.js';
import { icons } from './icons.js';
import { Knob } from './Knob.js';
import { RULER_HEIGHT, TRACK_HEIGHT } from './layout.js';

const formatDb = (db) => (db <= MIN_DB ? '−∞' : `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db).toFixed(1)}`);

/** Position (0..1) d'une valeur dB sur le fader, pour le remplissage CSS. */
const faderFill = (db) => (db - MIN_DB) / (MAX_DB - MIN_DB);

export class TrackPanel extends EventTarget {
  /**
   * @param {HTMLElement} container
   * @param {import('../audio/AudioEngine.js').AudioEngine} engine
   * @param {{ getSelectedId: () => number|null, select: (id: number) => void, openFx: (id: number) => void, hasFx: (id: number) => boolean }} ui
   */
  constructor(container, engine, ui) {
    super();
    this.container = container;
    this.engine = engine;
    this.ui = ui;
    container.style.setProperty('--ruler-height', `${RULER_HEIGHT}px`);
    container.style.setProperty('--track-height', `${TRACK_HEIGHT}px`);
    this.draggingId = null;
  }

  /** Glisser la poignée d'une piste pour la changer de place (haut / bas). */
  #startReorder(e, track) {
    if (e.button !== 0 || this.engine.locked) return;
    e.preventDefault();
    this.draggingId = track.id;
    document.body.classList.add('reordering');
    this.render();
    this.refresh();
    const move = (ev) => {
      const first = this.container.querySelector('.track[data-track-id]');
      if (!first) return;
      const lane = laneAt(ev.clientY - first.getBoundingClientRect().top, TRACK_HEIGHT, this.engine.tracks.length);
      this.engine.moveTrack(track.id, lane);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('reordering');
      this.draggingId = null;
      this.render();
      this.refresh();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  render() {
    const selected = this.ui.getSelectedId();
    const children = [
      h(
        'div',
        { className: 'panel-ruler' },
        h('span', {}, 'Pistes'),
        h('span', { className: 'count' }, String(this.engine.tracks.length)),
      ),
      ...this.engine.tracks.map((track, index) => this.#renderTrack(track, index, track.id === selected)),
      this.ui.isRecording?.()
        ? h(
            'div',
            { className: 'track rec-lane', 'aria-live': 'polite' },
            h('div', { className: 'track-strip' }),
            h(
              'div',
              { className: 'track-main' },
              h(
                'div',
                { className: 'track-top' },
                h('span', { className: 'rec-dot small' }),
                h('span', { className: 'track-name' }, 'Enregistrement en cours'),
              ),
              h('span', { className: 'rec-lane-hint' }, 'La prise deviendra une nouvelle piste à l’arrêt.'),
            ),
          )
        : null,
      // Rangée « + » sous la dernière piste : ajoute une piste (prise micro ou fichier).
      h(
        'div',
        { className: 'add-track' },
        h(
          'button',
          {
            className: 'add-track-btn',
            title: 'Ajouter une piste',
            'aria-label': 'Ajouter une piste',
            'aria-haspopup': 'menu',
            'aria-expanded': 'false',
            disabled: this.ui.isRecording?.() ?? false,
            onclick: (e) => this.ui.openAddMenu?.(e.currentTarget),
          },
          svg(icons.plus),
        ),
      ),
    ];
    this.container.replaceChildren(...children.filter(Boolean));
  }

  /** Met à jour les états visuels sans reconstruire le DOM (sélection, mute, solo, FX). */
  refresh() {
    const selected = this.ui.getSelectedId();
    for (const el of this.container.querySelectorAll('.track')) {
      const track = this.engine.getTrack(Number(el.dataset.trackId));
      if (!track) continue;
      el.classList.toggle('selected', track.id === selected);
      el.classList.toggle('inaudible', !this.engine.isAudible(track));
      el.querySelector('.btn-mute').setAttribute('aria-pressed', String(track.muted));
      el.querySelector('.btn-solo').setAttribute('aria-pressed', String(track.solo));
      el.querySelector('.btn-fx').classList.toggle('active', this.ui.hasFx(track.id));
    }
  }

  #renderTrack(track, index, selected) {
    const { engine } = this;

    const volumeValue = h('output', { className: 'fader-value' }, formatDb(track.volumeDb));
    const fader = h('input', {
      className: 'fader',
      type: 'range',
      min: MIN_DB,
      max: MAX_DB,
      step: 0.1,
      value: track.volumeDb,
      'aria-label': `Volume de ${track.name}`,
      title: 'Volume (double-clic : 0 dB)',
    });
    const setVolume = (db) => {
      fader.value = String(db);
      engine.setVolume(track.id, db);
      volumeValue.textContent = formatDb(db);
      fader.style.setProperty('--fill', faderFill(db));
    };
    fader.style.setProperty('--fill', faderFill(track.volumeDb));
    fader.addEventListener('input', () => setVolume(Number(fader.value)));
    fader.addEventListener('dblclick', () => setVolume(0));

    const panValue = h('span', { className: 'knob-value-label' }, formatPan(track.pan));
    const pan = new Knob({
      min: -1,
      max: 1,
      step: 0.01,
      value: track.pan,
      defaultValue: 0,
      bipolar: true,
      label: `Panoramique de ${track.name}`,
      format: formatPan,
      onInput: (v) => {
        track.setPan(v);
        panValue.textContent = formatPan(v);
      },
    });

    const toggle = (cls, label, title, onclick) =>
      h(
        'button',
        { className: `toggle ${cls}`, 'aria-pressed': 'false', 'aria-label': `${title} ${track.name}`, title, onclick },
        label,
      );

    const el = h(
      'div',
      {
        className: `track${selected ? ' selected' : ''}${this.draggingId === track.id ? ' dragging' : ''}`,
        dataset: { trackId: String(track.id) },
        style: { '--track-color': track.color },
        onpointerdown: () => this.ui.select(track.id),
      },
      h('div', { className: 'track-strip' }),
      h(
        'div',
        { className: 'track-main' },
        h(
          'div',
          { className: 'track-top' },
          h(
            'span',
            {
              className: 'track-grip',
              title: 'Glisser pour déplacer la piste (ou Alt+↑ / Alt+↓)',
              'aria-label': `Déplacer ${track.name}`,
              onpointerdown: (e) => this.#startReorder(e, track),
            },
            svg(icons.grip),
          ),
          h('span', { className: 'track-index' }, String(index + 1).padStart(2, '0')),
          h('span', { className: 'track-name', title: track.name }, track.name),
          h(
            'button',
            {
              className: 'btn-fx',
              title: 'Effets vocaux de la piste',
              'aria-label': `Effets de ${track.name}`,
              onclick: () => this.ui.openFx(track.id),
            },
            svg(icons.sliders),
            h('span', {}, 'FX'),
          ),
          h(
            'button',
            {
              className: 'icon-btn btn-remove',
              title: 'Supprimer la piste',
              'aria-label': `Supprimer ${track.name}`,
              onclick: () => engine.removeTrack(track.id),
            },
            svg(icons.close),
          ),
        ),
        h(
          'div',
          { className: 'track-bottom' },
          toggle('btn-mute', 'M', 'Muet', () => engine.setMuted(track.id, !track.muted)),
          toggle('btn-solo', 'S', 'Solo', () => engine.setSolo(track.id, !track.solo)),
          h('div', { className: 'fader-wrap' }, fader, volumeValue),
        ),
      ),
      h('div', { className: 'track-pan' }, pan.el, panValue),
    );
    return el;
  }
}
