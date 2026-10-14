// Menu déroulant générique, accessible au clavier (flèches, Échap qui rend le
// focus au bouton) et fermé par un clic à l'extérieur.
import { h } from './dom.js';

export class PopupMenu {
  /**
   * @param {string} label  Nom accessible du menu
   * @param {() => Array<{ icon?: Node, title: string, hint?: string, shortcut?: string, disabled?: boolean, run: () => void } | 'separator'>} items
   */
  constructor(label, items) {
    this.label = label;
    this.items = items;
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
    const entries = this.items().map((item) =>
      item === 'separator'
        ? h('div', { className: 'menu-separator', role: 'separator' })
        : h(
            'button',
            {
              className: 'menu-item',
              role: 'menuitem',
              disabled: item.disabled,
              onclick: () => {
                this.close();
                item.run();
              },
            },
            // Emplacement d'icône toujours présent : les libellés restent alignés.
            h('span', { className: `menu-icon${item.icon ? '' : ' empty'}` }, item.icon ?? null),
            h(
              'span',
              { className: 'menu-text' },
              h('span', { className: 'menu-title' }, item.title),
              item.hint ? h('span', { className: 'menu-hint' }, item.hint) : null,
            ),
            item.shortcut ? h('kbd', { className: 'menu-shortcut' }, item.shortcut) : null,
          ),
    );
    this.el = h(
      'div',
      { className: 'menu', role: 'menu', 'aria-label': this.label, onkeydown: (e) => this.#onKey(e) },
      ...entries,
    );
    document.body.append(this.el);
    const r = anchor.getBoundingClientRect();
    const top = Math.min(r.bottom + 6, window.innerHeight - this.el.offsetHeight - 8);
    this.el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - this.el.offsetWidth - 8))}px`;
    this.el.style.top = `${top}px`;
    anchor.setAttribute('aria-expanded', 'true');
    this.el.querySelector('.menu-item:not(:disabled)')?.focus();
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
    const items = [...this.el.querySelectorAll('.menu-item:not(:disabled)')];
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
