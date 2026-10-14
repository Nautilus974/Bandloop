// Panneau latéral d'effets vocaux de la piste sélectionnée.
import { h, svg } from './dom.js';
import { icons } from './icons.js';

export class FxPanel {
  /**
   * @param {HTMLElement} el
   * @param {import('../audio/AudioEngine.js').AudioEngine} engine
   * @param {{ getSelectedId: () => number|null, onClose: () => void }} ui
   */
  constructor(el, engine, ui) {
    this.el = el;
    this.engine = engine;
    this.ui = ui;
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open() {
    this.el.hidden = false;
    this.render();
  }

  close() {
    this.el.hidden = true;
  }

  render() {
    if (!this.isOpen) return;
    const track = this.engine.getTrack(this.ui.getSelectedId());
    this.el.replaceChildren(
      h(
        'header',
        { className: 'fx-header' },
        h(
          'div',
          { className: 'fx-title' },
          h('span', { className: 'fx-eyebrow' }, 'Effets vocaux'),
          h(
            'span',
            { className: 'fx-track', style: { '--track-color': track?.color ?? 'var(--text-3)' } },
            h('span', { className: 'dot' }),
            track ? track.name : 'Aucune piste',
          ),
        ),
        h(
          'button',
          {
            className: 'icon-btn',
            title: 'Fermer',
            'aria-label': 'Fermer le panneau',
            onclick: () => this.ui.onClose(),
          },
          svg(icons.close),
        ),
      ),
      track
        ? h('div', { className: 'fx-empty' }, svg(icons.wave), h('p', {}, 'Le moteur vocal arrive bientôt ici.'))
        : h(
            'div',
            { className: 'fx-empty' },
            svg(icons.wave),
            h('p', {}, 'Sélectionne une piste pour éditer ses effets.'),
          ),
    );
  }
}
