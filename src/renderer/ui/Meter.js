// VU-mètre stéréo du master, avec maintien de crête et retombée progressive.
import { meterLevel } from '../audio/mixing.js';
import { h } from './dom.js';

const FALL_PER_FRAME = 0.018; // vitesse de retombée de l'affichage
const HOLD_FRAMES = 45; // durée de maintien de la crête (~0,75 s)

export class Meter {
  /** @param {string[]} [labels]  un libellé par canal (['G', 'D'] par défaut) */
  constructor(container, labels = ['G', 'D']) {
    this.channels = labels.map((label) => {
      const fill = h('div', { className: 'meter-fill' });
      const hold = h('div', { className: 'meter-hold' });
      container.append(
        h(
          'div',
          { className: 'meter-row' },
          h('span', { className: 'meter-label' }, label),
          h('div', { className: 'meter-bar' }, fill, hold),
        ),
      );
      return { fill, hold, level: 0, peak: 0, holdFrames: 0 };
    });
  }

  /** @param {number[]} peaks  Niveaux crête linéaires (0..1+) par canal */
  update(peaks) {
    if (typeof peaks === 'number') peaks = [peaks];
    this.channels.forEach((ch, i) => {
      const target = meterLevel(peaks[i] ?? 0);
      ch.level = Math.max(target, ch.level - FALL_PER_FRAME);
      if (ch.level >= ch.peak) {
        ch.peak = ch.level;
        ch.holdFrames = HOLD_FRAMES;
      } else if (--ch.holdFrames <= 0) {
        ch.peak = Math.max(ch.level, ch.peak - FALL_PER_FRAME);
      }
      ch.fill.style.transform = `scaleX(${ch.level})`;
      ch.hold.style.left = `${ch.peak * 100}%`;
      ch.hold.classList.toggle('clip', (peaks[i] ?? 0) >= 1);
    });
  }
}
