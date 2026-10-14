// Menu du bouton « + » du panneau de pistes : nouvelle piste par prise micro
// ou par import de fichier. Accessible au clavier (flèches, Échap).
import { h, svg } from './dom.js';
import { icons } from './icons.js';

export class AddTrackMenu {
  /** @param {{ record: () => void, importFile: () => void }} actions */
  constructor(actions) {
    this.actions = actions;
    this.el = null;
    this.anchor = null;
    this.onOutside = (e) => {
      if (!this.el?.contains(e.target) && !this.anchor?.contains(e.target)) this.close();
    };
  }

  get isOpen() {
    return !!this.el;
  }

  toggle(anchor) {
    if (this.isOpen && this.anchor === anchor) this.close();
    else this.open(anchor);
  }

  open(anchor) {
    this.close();
    this.anchor = anchor;
    const item = (icon, title, hint, run) =>
      h(
        'button',
        {
          className: 'menu-item',
          role: 'menuitem',
          onclick: () => {
            this.close();
            run();
          },
        },
        h('span', { className: 'menu-icon' }, icon),
        h(
          'span',
          { className: 'menu-text' },
          h('span', { className: 'menu-title' }, title),
          h('span', { className: 'menu-hint' }, hint),
        ),
      );
    this.el = h(
      'div',
      { className: 'menu', role: 'menu', 'aria-label': 'Ajouter une piste', onkeydown: (e) => this.#onKey(e) },
      item(
        h('span', { className: 'rec-dot small' }),
        'Enregistrer au micro',
        'Voix ou instrument, sur une nouvelle piste',
        this.actions.record,
      ),
      item(svg(icons.import), 'Importer un fichier audio', 'WAV, MP3, OGG, FLAC, M4A', this.actions.importFile),
    );
    document.body.append(this.el);
    const r = anchor.getBoundingClientRect();
    const top = Math.min(r.bottom + 6, window.innerHeight - this.el.offsetHeight - 8);
    this.el.style.left = `${Math.max(8, r.left)}px`;
    this.el.style.top = `${top}px`;
    anchor.setAttribute('aria-expanded', 'true');
    this.el.querySelector('.menu-item').focus();
    setTimeout(() => document.addEventListener('pointerdown', this.onOutside), 0);
  }

  close() {
    if (!this.el) return;
    document.removeEventListener('pointerdown', this.onOutside);
    this.anchor?.setAttribute('aria-expanded', 'false');
    this.el.remove();
    this.el = null;
  }

  #onKey(e) {
    const items = [...this.el.querySelectorAll('.menu-item')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      const anchor = this.anchor;
      this.close();
      anchor?.focus();
    }
  }
}
