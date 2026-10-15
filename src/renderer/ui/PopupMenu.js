// Menu déroulant générique, accessible au clavier et fermé par un clic à
// l'extérieur ou par Échap (le focus revient alors à l'élément d'origine).
//
// Clavier : ↑ / ↓ passent d'une ligne à l'autre (Début / Fin : première /
// dernière), ← / → parcourent une rangée de pastilles, Entrée ou Espace
// activent l'élément qui a le focus.
import { h } from './dom.js';

/**
 * @typedef {{ icon?: Node, title: string, hint?: string, shortcut?: string, disabled?: boolean, danger?: boolean, run: () => void }} MenuItem
 * @typedef {{ swatches: Array<{ value: string, label: string }>, selected?: string, label: string, pick: (value: string) => void }} MenuSwatches
 */
export class PopupMenu {
  /**
   * @param {string} label  Nom accessible du menu
   * @param {() => Array<MenuItem | MenuSwatches | 'separator'>} items
   * @param {{ heading?: () => string|null, className?: string }} [opts]  titre affiché en tête du menu
   */
  constructor(label, items, { heading, className = '' } = {}) {
    this.label = label;
    this.items = items;
    this.heading = heading;
    this.className = className;
    this.el = null;
    this.anchor = null;
    this.returnFocus = null;
    this.onOutside = (e) => {
      if (!this.el?.contains(e.target) && !this.anchor?.contains(e.target)) this.close();
    };
    this.onBlur = () => this.close();
  }

  get isOpen() {
    return !!this.el;
  }

  toggle(anchor) {
    if (this.isOpen && this.anchor === anchor) this.close();
    else this.open(anchor);
  }

  /**
   * Ouvre le menu sous `anchor`, ou au point `at` (clic droit).
   * @param {HTMLElement|null} anchor  bouton d'origine (aria-expanded, retour du focus)
   * @param {{ x: number, y: number }} [at]
   */
  open(anchor, at) {
    this.close();
    this.anchor = anchor;
    this.returnFocus = anchor ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const heading = this.heading?.();
    const entries = this.items().map((item) => this.#renderItem(item));
    this.el = h(
      'div',
      {
        className: `menu ${this.className}`.trim(),
        role: 'menu',
        'aria-label': heading ? `${this.label} : ${heading}` : this.label,
        onkeydown: (e) => this.#onKey(e),
      },
      heading ? h('div', { className: 'menu-heading', 'aria-hidden': 'true' }, heading) : null,
      ...entries,
    );
    document.body.append(this.el);
    const { offsetWidth: w, offsetHeight: hgt } = this.el;
    let left;
    let top;
    if (at) {
      left = at.x;
      top = at.y;
    } else {
      const r = anchor.getBoundingClientRect();
      left = r.left;
      top = r.bottom + 6;
      // Pas la place en dessous : au-dessus du bouton.
      if (top + hgt > window.innerHeight - 8 && r.top - hgt - 6 >= 8) top = r.top - hgt - 6;
    }
    this.el.style.left = `${Math.max(8, Math.min(left, window.innerWidth - w - 8))}px`;
    this.el.style.top = `${Math.max(8, Math.min(top, window.innerHeight - hgt - 8))}px`;
    anchor?.setAttribute('aria-expanded', 'true');
    this.#rows()[0]?.focus();
    setTimeout(() => {
      document.addEventListener('pointerdown', this.onOutside);
      window.addEventListener('blur', this.onBlur);
    }, 0);
  }

  close({ restoreFocus = false } = {}) {
    if (!this.el) return;
    document.removeEventListener('pointerdown', this.onOutside);
    window.removeEventListener('blur', this.onBlur);
    this.anchor?.setAttribute('aria-expanded', 'false');
    this.el.remove();
    this.el = null;
    if (restoreFocus) this.returnFocus?.focus();
  }

  #renderItem(item) {
    if (item === 'separator') return h('div', { className: 'menu-separator', role: 'separator' });
    if (item.swatches) {
      return h(
        'div',
        { className: 'menu-swatches', role: 'group', 'aria-label': item.label },
        h('span', { className: 'menu-swatches-label' }, item.label),
        h(
          'div',
          { className: 'menu-swatch-row' },
          ...item.swatches.map(({ value, label }) =>
            h('button', {
              className: 'menu-swatch',
              role: 'menuitemradio',
              'aria-checked': String(value === item.selected),
              'aria-label': label,
              title: label,
              style: { '--swatch': value },
              dataset: { value },
              onclick: () => {
                this.close({ restoreFocus: true });
                item.pick(value);
              },
            }),
          ),
        ),
      );
    }
    return h(
      'button',
      {
        className: `menu-item${item.danger ? ' danger' : ''}`,
        role: 'menuitem',
        disabled: item.disabled,
        onclick: () => {
          this.close({ restoreFocus: true });
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
    );
  }

  /**
   * Lignes navigables : un élément de menu, ou une rangée de pastilles (on y
   * entre par la pastille cochée).
   */
  #rows() {
    const rows = [];
    for (const el of this.el.querySelectorAll('.menu-item:not(:disabled), .menu-swatches')) {
      if (el.classList.contains('menu-swatches'))
        rows.push(el.querySelector('.menu-swatch[aria-checked="true"]') ?? el.querySelector('.menu-swatch'));
      else rows.push(el);
    }
    return rows;
  }

  #onKey(e) {
    const active = document.activeElement;
    const rows = this.#rows();
    const rowOf = (el) =>
      rows.findIndex(
        (r) =>
          r === el || (r.closest('.menu-swatches') && r.closest('.menu-swatches') === el?.closest('.menu-swatches')),
      );
    const i = rowOf(active);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (e.key === 'Home' ? rows[0] : rows.at(-1))?.focus();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && active?.classList.contains('menu-swatch')) {
      e.preventDefault();
      const swatches = [...active.parentElement.children];
      const j = swatches.indexOf(active);
      swatches[(j + (e.key === 'ArrowRight' ? 1 : swatches.length - 1)) % swatches.length].focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      this.close({ restoreFocus: true });
    }
  }
}
