// Timeline dessinée sur canvas : règle, formes d'onde et tête de lecture.
//
// Le canvas a la taille de la zone visible (et non du projet entier) : un
// "spacer" donne la largeur scrollable et on dessine en tenant compte de scrollLeft.
// Les formes d'onde sont rendues dans un canvas hors-écran, ré-utilisé à chaque
// image ; seule la tête de lecture est redessinée pendant la lecture.
import { peakRange } from '../audio/peaks.js';
import { RULER_HEIGHT, TRACK_HEIGHT } from './layout.js';
import { formatRulerLabel, rulerStep } from './time.js';

const COLORS = {
  ruler: '#1d2027',
  rulerText: '#8b93a7',
  tick: '#3a3f4b',
  lane: '#1a1c22',
  laneAlt: '#1e2128',
  grid: '#262a33',
  playhead: '#ff4d6d',
};

export class Timeline {
  /**
   * @param {HTMLElement} scroller  Conteneur scrollable horizontalement
   * @param {import('../audio/AudioEngine.js').AudioEngine} engine
   */
  constructor(scroller, engine) {
    this.scroller = scroller;
    this.engine = engine;
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

  /** À appeler quand les pistes, le zoom ou le scroll changent. */
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
    g.strokeStyle = COLORS.playhead;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, canvas.height / dpr);
    g.stroke();
    g.fillStyle = COLORS.playhead;
    g.beginPath();
    g.moveTo(x - 6, 0);
    g.lineTo(x + 6, 0);
    g.lineTo(x, 8);
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
    const pps = this.pixelsPerSecond;
    const scrollLeft = this.scroller.scrollLeft;
    const step = rulerStep(pps);
    const firstTick = Math.floor(scrollLeft / pps / step) * step;

    // Pistes : fonds alternés et grille verticale.
    this.engine.tracks.forEach((track, i) => {
      const top = RULER_HEIGHT + i * TRACK_HEIGHT;
      g.fillStyle = i % 2 ? COLORS.laneAlt : COLORS.lane;
      g.fillRect(0, top, width, TRACK_HEIGHT);
    });
    g.strokeStyle = COLORS.grid;
    g.beginPath();
    for (let t = firstTick; t * pps - scrollLeft < width; t += step) {
      const x = Math.round(t * pps - scrollLeft) + 0.5;
      g.moveTo(x, RULER_HEIGHT);
      g.lineTo(x, this.layer.height / dpr);
    }
    g.stroke();

    this.engine.tracks.forEach((track, i) => this.#drawClip(g, track, RULER_HEIGHT + i * TRACK_HEIGHT, width));

    // Règle.
    g.fillStyle = COLORS.ruler;
    g.fillRect(0, 0, width, RULER_HEIGHT);
    g.strokeStyle = COLORS.tick;
    g.fillStyle = COLORS.rulerText;
    g.font = '11px system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.beginPath();
    for (let t = firstTick; t * pps - scrollLeft < width; t += step) {
      const x = Math.round(t * pps - scrollLeft) + 0.5;
      g.moveTo(x, RULER_HEIGHT - 10);
      g.lineTo(x, RULER_HEIGHT);
      g.fillText(formatRulerLabel(t, step), x + 4, RULER_HEIGHT / 2 - 2);
    }
    g.stroke();
  }

  #drawClip(g, track, top, viewWidth) {
    const pps = this.pixelsPerSecond;
    const scrollLeft = this.scroller.scrollLeft;
    const clipX = track.startTime * pps - scrollLeft;
    const clipW = track.duration * pps;
    const pad = 4;
    const x0 = Math.max(0, clipX);
    const x1 = Math.min(viewWidth, clipX + clipW);
    if (x1 <= x0) return;

    g.globalAlpha = track.muted ? 0.35 : 1;
    g.fillStyle = `${track.color}33`;
    g.fillRect(x0, top + pad, x1 - x0, TRACK_HEIGHT - pad * 2);
    g.fillStyle = track.color;
    g.fillRect(x0, top + pad, x1 - x0, 14);
    g.fillStyle = '#0d0f13';
    g.font = '600 11px system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.fillText(track.name, Math.max(clipX, 0) + 6, top + pad + 7);

    // Forme d'onde : pour chaque colonne de pixels, min/max des pics correspondants.
    const mid = top + pad + 14 + (TRACK_HEIGHT - pad * 2 - 14) / 2;
    const amp = (TRACK_HEIGHT - pad * 2 - 14) / 2 - 2;
    const peaksPerPixel = track.peaksPerSecond / pps;
    g.fillStyle = track.color;
    for (let x = Math.floor(x0); x < x1; x++) {
      const from = (x - clipX) * peaksPerPixel;
      const { min, max } = peakRange(track.peaks, from, from + peaksPerPixel);
      const y1 = mid - max * amp;
      const y2 = mid - min * amp;
      g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
    g.globalAlpha = 1;
  }

  #onPointerDown(e) {
    const rect = this.canvas.getBoundingClientRect();
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
