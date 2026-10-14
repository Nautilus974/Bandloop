// Potentiomètre rotatif accessible (role="slider") : glisser verticalement,
// molette, flèches du clavier, double-clic pour revenir à la valeur par défaut.
// Maj (⇧) pendant le glisser = réglage fin.
import { clamp } from '../audio/scheduling.js';
import { h, svg } from './dom.js';

const START_ANGLE = -135;
const END_ANGLE = 135;
const DRAG_PIXELS = 160; // pixels de glisser pour parcourir toute la course

function polar(cx, cy, r, angleDeg) {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx, cy, r, from, to) {
  if (Math.abs(to - from) < 0.01) return '';
  const [x1, y1] = polar(cx, cy, r, Math.min(from, to));
  const [x2, y2] = polar(cx, cy, r, Math.max(from, to));
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

export class Knob {
  /**
   * @param {object} o
   * @param {number} o.min
   * @param {number} o.max
   * @param {number} o.value
   * @param {number} [o.defaultValue]
   * @param {number} [o.step]
   * @param {boolean} [o.bipolar]  L'arc part du centre (ex. panoramique)
   * @param {string} o.label       Nom accessible
   * @param {(v: number) => string} [o.format]
   * @param {(v: number) => void} [o.onInput]
   * @param {number} [o.size]
   */
  constructor(o) {
    this.o = { step: 0.01, size: 30, format: (v) => v.toFixed(2), ...o };
    this.defaultValue = o.defaultValue ?? o.value;
    const { size } = this.o;
    const c = size / 2;
    const r = c - 3;
    this.svg = svg(`<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
      <circle class="knob-body" cx="${c}" cy="${c}" r="${r - 3.5}"/>
      <path class="knob-track" d="${arcPath(c, c, r, START_ANGLE, END_ANGLE)}"/>
      <path class="knob-value"/>
      <line class="knob-pointer" x1="${c}" y1="${c}" x2="${c}" y2="${c - r + 6}"/>
    </svg>`);
    this.valuePath = this.svg.querySelector('.knob-value');
    this.pointer = this.svg.querySelector('.knob-pointer');
    this.el = h(
      'div',
      { className: 'knob', role: 'slider', tabIndex: 0, 'aria-label': o.label, title: o.label },
      this.svg,
    );
    this.#bind();
    this.setValue(o.value);
  }

  setValue(value) {
    const { min, max, step, bipolar, format, size } = this.o;
    this.value = clamp(Math.round(value / step) * step, min, max);
    const t = (this.value - min) / (max - min);
    const angle = START_ANGLE + t * (END_ANGLE - START_ANGLE);
    const c = size / 2;
    const from = bipolar ? 0 : START_ANGLE;
    this.valuePath.setAttribute('d', arcPath(c, c, c - 3, from, angle));
    this.pointer.setAttribute('transform', `rotate(${angle} ${c} ${c})`);
    this.el.setAttribute('aria-valuemin', String(min));
    this.el.setAttribute('aria-valuemax', String(max));
    this.el.setAttribute('aria-valuenow', String(this.value));
    this.el.setAttribute('aria-valuetext', format(this.value));
  }

  #change(value) {
    const before = this.value;
    this.setValue(value);
    if (this.value !== before) this.o.onInput?.(this.value);
  }

  #bind() {
    const { min, max, step } = this.o;
    const range = max - min;
    this.el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.el.focus();
      this.el.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const startValue = this.value;
      const move = (ev) => {
        const fine = ev.shiftKey ? 0.15 : 1;
        this.#change(startValue + ((startY - ev.clientY) / DRAG_PIXELS) * range * fine);
      };
      const up = () => {
        this.el.removeEventListener('pointermove', move);
        this.el.removeEventListener('pointerup', up);
        this.el.classList.remove('dragging');
      };
      this.el.classList.add('dragging');
      this.el.addEventListener('pointermove', move);
      this.el.addEventListener('pointerup', up);
    });
    this.el.addEventListener('dblclick', () => this.#change(this.defaultValue));
    this.el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.#change(this.value - Math.sign(e.deltaY) * Math.max(step, range / 50));
      },
      { passive: false },
    );
    this.el.addEventListener('keydown', (e) => {
      const big = Math.max(step, range / 10);
      const small = Math.max(step, range / 100);
      const moves = {
        ArrowUp: small,
        ArrowRight: small,
        ArrowDown: -small,
        ArrowLeft: -small,
        PageUp: big,
        PageDown: -big,
      };
      if (e.key in moves) {
        e.preventDefault();
        this.#change(this.value + moves[e.key]);
      } else if (e.key === 'Home') {
        this.#change(min);
      } else if (e.key === 'End') {
        this.#change(max);
      }
    });
  }
}
