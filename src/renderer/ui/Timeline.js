// Timeline dessinée sur canvas : règle, clips avec formes d'onde et tête de lecture.
//
// Le canvas a la taille de la zone visible (et non du projet entier) : un
// "spacer" donne la largeur scrollable et on dessine en tenant compte de scrollLeft.
// Les formes d'onde sont rendues dans un canvas hors-écran, ré-utilisé à chaque
// image ; seule la tête de lecture est redessinée pendant la lecture.
import { peakRange } from '../audio/peaks.js';
import { RULER_HEIGHT, TRACK_HEIGHT } from './layout.js';
import { formatRulerLabel, rulerStep } from './time.js';

// Doit rester cohérent avec les variables CSS de styles.css.
const COLORS = {
  ruler: '#101318',
  rulerText: '#7d8596',
  rulerTick: '#2f3540',
  lane: '#0d1014',
  laneSelected: '#141a20',
  separator: '#1c2128',
  grid: '#171b21',
  gridMajor: '#1f242c',
  playhead: '#d7ff4f',
};
const CLIP_PAD = 6;
const CLIP_HEADER = 18;

export class Timeline {
  /**
   * @param {HTMLElement} scroller  Conteneur scrollable horizontalement
   * @param {import('../audio/AudioEngine.js').AudioEngine} engine
   * @param {{ getSelectedId: () => number|null, select: (id: number) => void, fxLabel?: (id: number) => string|null }} ui
   */
  constructor(scroller, engine, ui) {
    this.scroller = scroller;
    this.engine = engine;
    this.ui = ui;
    this.pixelsPerSecond = 50;
    this.canvas = scroller.querySelector('canvas');
    this.spacer = scroller.querySelector('.timeline-spacer');
    this.ctx2d = this.canvas.getContext('2d');
    this.layer = document.createElement('canvas'); // couche statique (formes d'onde)
    this.layerDirty = true;

    scroller.addEventListener('scroll', () => this.invalidate());
    new ResizeObserver(() => this.invalidate()).observe(scroller);
    this.canvas.addEventListener('pointerdown', (e) => this.#onPointerDown(e));
  }

  setZoom(pixelsPerSecond) {
    // Garder le temps au centre de la vue fixe pendant le zoom.
    const center = (this.scroller.scrollLeft + this.scroller.clientWidth / 2) / this.pixelsPerSecond;
    this.pixelsPerSecond = pixelsPerSecond;
    this.#updateSize();
    this.scroller.scrollLeft = center * pixelsPerSecond - this.scroller.clientWidth / 2;
    this.invalidate();
  }

  /** À appeler quand les pistes, la sélection, le zoom ou le scroll changent. */
  invalidate() {
    this.layerDirty = true;
  }

  /** Dessine une image ; appelé à chaque requestAnimationFrame. */
  render() {
    if (this.layerDirty) {
      this.#updateSize();
      this.#renderLayer();
      this.layerDirty = false;
    }
    const { ctx2d: g, canvas } = this;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.drawImage(this.layer, 0, 0);

    const dpr = window.devicePixelRatio || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const x = Math.round(this.engine.position * this.pixelsPerSecond - this.scroller.scrollLeft) + 0.5;
    const height = canvas.height / dpr;
    g.strokeStyle = COLORS.playhead;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, RULER_HEIGHT - 6);
    g.lineTo(x, height);
    g.stroke();
    // Poignée de la tête de lecture dans la règle.
    g.fillStyle = COLORS.playhead;
    g.beginPath();
    g.roundRect(x - 6, 6, 12, 14, 3);
    g.moveTo(x - 6, 18);
    g.lineTo(x, RULER_HEIGHT - 4);
    g.lineTo(x + 6, 18);
    g.fill();
  }

  /** Fait défiler la vue pour garder la tête de lecture visible pendant la lecture. */
  followPlayhead() {
    const x = this.engine.position * this.pixelsPerSecond;
    const { scrollLeft, clientWidth } = this.scroller;
    if (x > scrollLeft + clientWidth - 40 || x < scrollLeft) {
      this.scroller.scrollLeft = Math.max(0, x - 40);
    }
  }

  #updateSize() {
    const dpr = window.devicePixelRatio || 1;
    const width = this.scroller.clientWidth;
    const height = RULER_HEIGHT + this.engine.tracks.length * TRACK_HEIGHT;
    // Un peu de marge après la fin du projet pour pouvoir y positionner la tête.
    const contentWidth = Math.max(width, (this.engine.duration + 5) * this.pixelsPerSecond);
    this.spacer.style.width = `${contentWidth}px`;
    for (const c of [this.canvas, this.layer]) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
    }
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  #renderLayer() {
    const dpr = window.devicePixelRatio || 1;
    const g = this.layer.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const width = this.layer.width / dpr;
    const height = this.layer.height / dpr;
    const pps = this.pixelsPerSecond;
    const scrollLeft = this.scroller.scrollLeft;
    const step = rulerStep(pps);
    const firstTick = Math.floor(scrollLeft / pps / step) * step;
    const selected = this.ui.getSelectedId();
    const ticks = [];
    for (let t = firstTick; t * pps - scrollLeft < width; t += step) {
      ticks.push({ t, x: Math.round(t * pps - scrollLeft) + 0.5, major: Math.round(t / step) % 4 === 0 });
    }

    // Pistes : fond (plus clair si sélectionnée) et séparateurs.
    g.fillStyle = COLORS.lane;
    g.fillRect(0, RULER_HEIGHT, width, height - RULER_HEIGHT);
    this.engine.tracks.forEach((track, i) => {
      const top = RULER_HEIGHT + i * TRACK_HEIGHT;
      if (track.id === selected) {
        g.fillStyle = COLORS.laneSelected;
        g.fillRect(0, top, width, TRACK_HEIGHT);
      }
      g.fillStyle = COLORS.separator;
      g.fillRect(0, top + TRACK_HEIGHT - 1, width, 1);
    });

    // Grille verticale (repères majeurs plus marqués).
    for (const { x, major } of ticks) {
      g.fillStyle = major ? COLORS.gridMajor : COLORS.grid;
      g.fillRect(Math.floor(x), RULER_HEIGHT, 1, height - RULER_HEIGHT);
    }

    this.engine.tracks.forEach((track, i) => this.#drawClip(g, track, RULER_HEIGHT + i * TRACK_HEIGHT, width));

    // Règle.
    g.fillStyle = COLORS.ruler;
    g.fillRect(0, 0, width, RULER_HEIGHT);
    g.fillStyle = COLORS.separator;
    g.fillRect(0, RULER_HEIGHT - 1, width, 1);
    g.font = '500 10.5px "Inter Variable", system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (const { t, x, major } of ticks) {
      g.fillStyle = COLORS.rulerTick;
      const tickHeight = major ? 12 : 6;
      g.fillRect(Math.floor(x), RULER_HEIGHT - tickHeight, 1, tickHeight);
      if (major || step * pps >= 90) {
        g.fillStyle = COLORS.rulerText;
        g.fillText(formatRulerLabel(t, step), x + 5, 12);
      }
    }
  }

  #drawClip(g, track, laneTop, viewWidth) {
    const pps = this.pixelsPerSecond;
    const scrollLeft = this.scroller.scrollLeft;
    const clipX = track.startTime * pps - scrollLeft;
    const clipW = track.duration * pps;
    const x0 = Math.max(-4, clipX);
    const x1 = Math.min(viewWidth + 4, clipX + clipW);
    if (x1 <= x0) return;
    const top = laneTop + CLIP_PAD;
    const h = TRACK_HEIGHT - CLIP_PAD * 2 - 1;

    g.save();
    g.globalAlpha = this.engine.isAudible(track) ? 1 : 0.32;
    g.beginPath();
    g.roundRect(clipX, top, clipW, h, 6);
    g.clip();
    g.fillStyle = `${track.color}1f`;
    g.fillRect(x0, top, x1 - x0, h);
    g.fillStyle = `${track.color}38`;
    g.fillRect(x0, top, x1 - x0, CLIP_HEADER);

    // Nom du clip, collé au bord gauche visible.
    g.fillStyle = track.color;
    g.font = '600 11px "Inter Variable", system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.fillText(track.name, Math.max(clipX, 0) + 8, top + CLIP_HEADER / 2 + 0.5);

    // Pastille du preset / des effets, collée au bord droit visible du clip.
    const fx = this.ui.fxLabel?.(track.id);
    if (fx) {
      g.font = '650 10px "Inter Variable", system-ui, sans-serif';
      const w = g.measureText(fx).width + 12;
      const right = Math.min(clipX + clipW, viewWidth) - 6;
      g.fillStyle = track.color;
      g.beginPath();
      g.roundRect(right - w, top + 3, w, CLIP_HEADER - 6, 6);
      g.fill();
      g.fillStyle = '#0a0c0f';
      g.fillText(fx, right - w + 6, top + CLIP_HEADER / 2 + 0.5);
    }

    // Forme d'onde : pour chaque colonne de pixels, min/max des pics correspondants.
    const waveTop = top + CLIP_HEADER;
    const waveH = h - CLIP_HEADER;
    const mid = waveTop + waveH / 2;
    const amp = waveH / 2 - 3;
    const peaksPerPixel = track.peaksPerSecond / pps;
    g.fillStyle = track.color;
    for (let x = Math.floor(Math.max(0, x0)); x < Math.min(viewWidth, x1); x++) {
      const from = (x - clipX) * peaksPerPixel;
      const { min, max } = peakRange(track.peaks, from, from + peaksPerPixel);
      const y1 = mid - max * amp;
      const y2 = mid - min * amp;
      g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
    g.restore();

    // Contour.
    g.save();
    g.globalAlpha = this.engine.isAudible(track) ? 0.55 : 0.2;
    g.strokeStyle = track.color;
    g.lineWidth = 1;
    g.beginPath();
    g.roundRect(clipX + 0.5, top + 0.5, clipW - 1, h - 1, 6);
    g.stroke();
    g.restore();
  }

  #onPointerDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    // Clic dans une piste : la sélectionner.
    const y = e.clientY - rect.top - RULER_HEIGHT;
    if (y >= 0) {
      const track = this.engine.tracks[Math.floor(y / TRACK_HEIGHT)];
      if (track) this.ui.select(track.id);
    }
    const seekAt = (clientX) => {
      const x = clientX - rect.left + this.scroller.scrollLeft;
      this.engine.seek(x / this.pixelsPerSecond);
    };
    seekAt(e.clientX);
    // Glisser pour faire défiler la tête de lecture.
    const move = (ev) => seekAt(ev.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
}
