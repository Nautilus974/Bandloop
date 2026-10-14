// Timeline dessinée sur canvas : règle, clips avec formes d'onde et tête de lecture.
//
// Le canvas a la taille de la zone visible (et non du projet entier) : un
// "spacer" donne la largeur scrollable et on dessine en tenant compte de scrollLeft.
// Les formes d'onde sont rendues dans un canvas hors-écran, ré-utilisé à chaque
// image ; seule la tête de lecture est redessinée pendant la lecture.
import { laneAt, snapCandidates, snapStart } from '../audio/arrange.js';
import { peakRange } from '../audio/peaks.js';
import { RULER_HEIGHT, TRACK_HEIGHT } from './layout.js';
import { formatRulerLabel, formatTime, rulerStep } from './time.js';

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
const REC_COLOR = '#ff4d6d';
const CLIP_PAD = 6;
const CLIP_HEADER = 18;
const DRAG_THRESHOLD = 4; // pixels avant qu'un clic devienne un glisser
const SNAP_PIXELS = 8; // distance d'aimantation

export class Timeline {
  /**
   * @param {HTMLElement} scroller  Conteneur scrollable horizontalement
   * @param {import('../audio/AudioEngine.js').AudioEngine} engine
   * @param {{ getSelectedId: () => number|null, select: (id: number) => void, fxLabel?: (id: number) => string|null, getLiveTake?: () => object|null }} ui
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
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.drag) return;
      this.canvas.style.cursor = !this.engine.locked && this.#clipAt(e) ? 'grab' : '';
    });
    this.drag = null; // { id, start, snappedTo } pendant un déplacement de clip
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
    if (this.drag?.moved) this.#drawDragOverlay(g, height);
  }

  /** Repère d'aimantation et position du clip déplacé. */
  #drawDragOverlay(g, height) {
    const { drag } = this;
    const scrollLeft = this.scroller.scrollLeft;
    if (drag.snappedTo !== null) {
      const sx = Math.round(drag.snappedTo * this.pixelsPerSecond - scrollLeft) + 0.5;
      g.strokeStyle = '#2fd4b5';
      g.setLineDash([4, 3]);
      g.beginPath();
      g.moveTo(sx, RULER_HEIGHT);
      g.lineTo(sx, height);
      g.stroke();
      g.setLineDash([]);
    }
    const index = this.engine.tracks.findIndex((t) => t.id === drag.id);
    if (index < 0) return;
    const label = formatTime(drag.start);
    g.font = '600 11px "JetBrains Mono", monospace';
    const w = g.measureText(label).width + 12;
    const lx = Math.max(4, drag.start * this.pixelsPerSecond - scrollLeft);
    const ly = RULER_HEIGHT + index * TRACK_HEIGHT - 22;
    g.fillStyle = '#eaedf2';
    g.beginPath();
    g.roundRect(lx, Math.max(RULER_HEIGHT + 2, ly), w, 18, 5);
    g.fill();
    g.fillStyle = '#0a0c0f';
    g.textBaseline = 'middle';
    g.fillText(label, lx + 6, Math.max(RULER_HEIGHT + 2, ly) + 9.5);
  }

  /** Fait défiler la vue pour garder la tête de lecture visible pendant la lecture. */
  followPlayhead() {
    const x = this.engine.position * this.pixelsPerSecond;
    const { scrollLeft, clientWidth } = this.scroller;
    if (x > scrollLeft + clientWidth - 40 || x < scrollLeft) {
      this.scroller.scrollLeft = Math.max(0, x - 40);
    }
  }

  /** Prise en cours d'enregistrement, dessinée comme un clip dans une voie supplémentaire. */
  #liveClip() {
    const live = this.ui.getLiveTake?.();
    if (!live) return null;
    return { id: -1, name: '● Enregistrement…', color: REC_COLOR, ...live };
  }

  #updateSize() {
    const dpr = window.devicePixelRatio || 1;
    const width = this.scroller.clientWidth;
    const live = this.#liveClip();
    const lanes = this.engine.tracks.length + (live ? 1 : 0);
    const height = RULER_HEIGHT + lanes * TRACK_HEIGHT;
    // Un peu de marge après la fin du projet pour pouvoir y positionner la tête.
    const end = Math.max(this.engine.duration, live ? live.startTime + live.duration : 0, this.engine.position);
    const contentWidth = Math.max(width, (end + 5) * this.pixelsPerSecond);
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
    const live = this.#liveClip();
    if (live) {
      const top = RULER_HEIGHT + this.engine.tracks.length * TRACK_HEIGHT;
      g.fillStyle = 'rgb(255 77 109 / 6%)';
      g.fillRect(0, top, width, TRACK_HEIGHT);
      this.#drawClip(g, live, top, width);
    }

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
    const start = this.drag?.id === track.id ? this.drag.start : track.startTime;
    const clipX = start * pps - scrollLeft;
    const clipW = track.duration * pps;
    const x0 = Math.max(-4, clipX);
    const x1 = Math.min(viewWidth + 4, clipX + clipW);
    if (x1 <= x0) return;
    const top = laneTop + CLIP_PAD;
    const h = TRACK_HEIGHT - CLIP_PAD * 2 - 1;

    g.save();
    const audible = track.id < 0 || this.engine.isAudible(track);
    g.globalAlpha = audible ? 1 : 0.32;
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
    g.globalAlpha = audible ? 0.55 : 0.2;
    g.strokeStyle = track.color;
    g.lineWidth = 1;
    g.beginPath();
    g.roundRect(clipX + 0.5, top + 0.5, clipW - 1, h - 1, 6);
    g.stroke();
    g.restore();
  }

  /** Clip sous le pointeur, ou null. */
  #clipAt(e) {
    const rect = this.canvas.getBoundingClientRect();
    const y = e.clientY - rect.top - RULER_HEIGHT;
    if (y < 0) return null;
    const index = Math.floor(y / TRACK_HEIGHT);
    const track = this.engine.tracks[index];
    if (!track) return null;
    const yIn = y - index * TRACK_HEIGHT;
    const t = (e.clientX - rect.left + this.scroller.scrollLeft) / this.pixelsPerSecond;
    const inside = t >= track.startTime && t <= track.end && yIn >= CLIP_PAD && yIn <= TRACK_HEIGHT - CLIP_PAD;
    return inside ? { track, index } : null;
  }

  #onPointerDown(e) {
    if (e.button !== 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const seekAt = (clientX) => {
      const x = clientX - rect.left + this.scroller.scrollLeft;
      this.engine.seek(x / this.pixelsPerSecond);
    };
    const hit = this.engine.locked ? null : this.#clipAt(e);
    if (hit) return this.#startClipDrag(e, hit, seekAt);

    // Clic dans une piste (hors clip) ou dans la règle : sélection + tête de lecture.
    const y = e.clientY - rect.top - RULER_HEIGHT;
    if (y >= 0) {
      const track = this.engine.tracks[Math.floor(y / TRACK_HEIGHT)];
      if (track) this.ui.select(track.id);
    }
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

  /**
   * Glisser un clip : horizontalement il change de position dans le temps
   * (aimanté sur 0, la tête, les autres clips et la grille ; Maj = libre),
   * verticalement la piste change de place dans la liste.
   * Un simple clic sans mouvement sélectionne la piste et place la tête.
   */
  #startClipDrag(e, { track }, seekAt) {
    const rect = this.canvas.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = track.startTime;
    this.ui.select(track.id);
    this.drag = { id: track.id, start: origin, snappedTo: null, moved: false };
    this.canvas.setPointerCapture(e.pointerId);

    const move = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!this.drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      this.drag.moved = true;
      this.canvas.style.cursor = 'grabbing';
      const pps = this.pixelsPerSecond;
      const raw = origin + dx / pps;
      if (ev.shiftKey) {
        Object.assign(this.drag, { start: Math.max(0, raw), snappedTo: null });
      } else {
        const others = this.engine.tracks
          .filter((t) => t.id !== track.id)
          .map((t) => ({ start: t.startTime, end: t.end }));
        const candidates = snapCandidates({
          position: this.engine.position,
          otherClips: others,
          gridStep: rulerStep(pps),
          near: raw,
        });
        const snapped = snapStart(raw, track.duration, candidates, SNAP_PIXELS / pps);
        Object.assign(this.drag, { start: snapped.time, snappedTo: snapped.snappedTo });
      }
      // Changement de piste en direct (haut / bas).
      const lane = laneAt(ev.clientY - rect.top - RULER_HEIGHT, TRACK_HEIGHT, this.engine.tracks.length);
      this.engine.moveTrack(track.id, lane);
      this.invalidate();
    };
    const up = (ev) => {
      this.canvas.removeEventListener('pointermove', move);
      this.canvas.removeEventListener('pointerup', up);
      this.canvas.removeEventListener('pointercancel', up);
      const { moved, start } = this.drag;
      this.drag = null;
      this.canvas.style.cursor = '';
      if (moved) this.engine.setTrackStart(track.id, start);
      else seekAt(ev.clientX);
      this.invalidate();
    };
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
  }
}
