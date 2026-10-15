// Timeline dessinée sur canvas : règle, clips avec formes d'onde, tête de lecture
// et montage à la souris.
//
// Le canvas a la taille de la zone visible (et non du projet entier) : un
// "spacer" donne la largeur scrollable et on dessine en tenant compte de scrollLeft.
// Les formes d'onde sont rendues dans un canvas hors-écran, ré-utilisé à chaque
// image ; la tête de lecture, la sélection et les repères de glisser sont
// redessinés par-dessus à chaque image.
//
// Zones d'un clip (comme dans la plupart des DAW) :
//   ┌──────────── en-tête : glisser = déplacer le clip (et la piste en hauteur) ┐
//   ║ bord                corps : glisser = sélectionner une portion       bord ║
//   └ (6 px) rogner ───────────────────────────────────────────────── rogner ┘
import { laneAt, snapCandidates, snapStart } from '../audio/arrange.js';
import { clipEnd, sortClips, trimClip } from '../audio/clips.js';
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
  snap: '#2fd4b5',
  selection: '#eaedf2',
};
const REC_COLOR = '#ff4d6d';
const CLIP_PAD = 6;
const CLIP_HEADER = 18;
const EDGE_PIXELS = 6; // largeur des poignées de rognage
const DRAG_THRESHOLD = 4; // pixels avant qu'un clic devienne un glisser
const SNAP_PIXELS = 8; // distance d'aimantation

const CURSORS = { move: 'grab', trim: 'ew-resize', range: 'text' };

export class Timeline {
  /**
   * @param {HTMLElement} scroller  Conteneur scrollable horizontalement
   * @param {import('../audio/AudioEngine.js').AudioEngine} engine
   * @param {{
   *   getSelectedId: () => number|null, select: (id: number) => void,
   *   fxLabel?: (id: number) => string|null, getLiveTake?: () => object|null,
   *   edit: (label: string, fn: () => void, before?: object) => void,
   *   captureArrangement: () => object,
   *   onClipSelection?: (selection: object|null) => void,
   * }} ui
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
    this.drag = null; // geste en cours : déplacement, rognage ou sélection
    /** Clip sélectionné, avec éventuellement une portion [from, to] (secondes). */
    this.selection = null;

    scroller.addEventListener('scroll', () => this.invalidate());
    new ResizeObserver(() => this.invalidate()).observe(scroller);
    this.canvas.addEventListener('pointerdown', (e) => this.#onPointerDown(e));
    // Clic droit sur une piste : son menu d'actions (sans changer la sélection).
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const y = e.clientY - this.canvas.getBoundingClientRect().top - RULER_HEIGHT;
      const track = y >= 0 ? this.engine.tracks[Math.floor(y / TRACK_HEIGHT)] : null;
      if (track) this.ui.openTrackMenu?.(track.id, null, { x: e.clientX, y: e.clientY });
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.drag) return;
      const hit = this.engine.locked ? null : this.#hitTest(e);
      this.canvas.style.cursor = hit ? CURSORS[hit.zone] : '';
    });
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

  // --- Sélection de clip ------------------------------------------------------

  /** Clip sélectionné et sa piste, ou null (la sélection est oubliée si le clip a disparu). */
  getSelection() {
    const sel = this.selection;
    if (!sel) return null;
    const track = this.engine.getTrack(sel.trackId);
    const clip = track?.clips.find((c) => c.id === sel.clipId);
    if (!clip) {
      this.setSelection(null);
      return null;
    }
    // La portion est bornée au clip (il a pu être rogné ou déplacé depuis).
    const end = clipEnd(clip, track.sampleRate);
    let range = null;
    if (sel.from !== undefined) {
      const from = Math.max(clip.start, sel.from);
      const to = Math.min(end, sel.to);
      if (to - from > 1 / track.sampleRate) range = { from, to };
    }
    return { track, clip, range };
  }

  /** @param {{ trackId: number, clipId: string, from?: number, to?: number } | null} sel */
  setSelection(sel) {
    this.selection = sel ? { ...sel } : null;
    if (sel) this.ui.select(sel.trackId);
    this.invalidate();
    this.ui.onClipSelection?.(this.selection);
  }

  // --- Dessin -----------------------------------------------------------------

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
    const height = canvas.height / dpr;
    this.#drawRangeOverlay(g);
    const x = Math.round(this.#x(this.engine.position)) + 0.5;
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

  #x(time) {
    return time * this.pixelsPerSecond - this.scroller.scrollLeft;
  }

  #laneTop(trackId) {
    const index = this.engine.tracks.findIndex((t) => t.id === trackId);
    return index < 0 ? null : RULER_HEIGHT + index * TRACK_HEIGHT;
  }

  /** Portion sélectionnée (ou en cours de sélection) : surlignage + début, fin, durée. */
  #drawRangeOverlay(g) {
    const live = this.drag?.kind === 'range' && this.drag.moved ? this.drag : null;
    let trackId, from, to;
    if (live) ({ trackId, from, to } = live);
    else {
      const sel = this.getSelection();
      if (!sel?.range) return;
      ({ from, to } = sel.range);
      trackId = sel.track.id;
    }
    const laneTop = this.#laneTop(trackId);
    if (laneTop === null) return;
    const top = laneTop + CLIP_PAD + CLIP_HEADER;
    const h = TRACK_HEIGHT - CLIP_PAD * 2 - 1 - CLIP_HEADER;
    const x0 = this.#x(from);
    const x1 = this.#x(to);
    g.fillStyle = 'rgb(234 237 242 / 22%)';
    g.fillRect(x0, top, x1 - x0, h);
    g.fillStyle = COLORS.selection;
    g.fillRect(Math.round(x0), top, 1, h);
    g.fillRect(Math.round(x1) - 1, top, 1, h);
    this.#pill(g, `${formatTime(from)} → ${formatTime(to)} · ${formatTime(to - from)}`, x0, laneTop - 2);
  }

  /** Étiquette claire au-dessus d'une voie (ou dans la règle pour la première). */
  #pill(g, label, x, bottom) {
    g.font = '600 11px "JetBrains Mono", monospace';
    const w = g.measureText(label).width + 12;
    const viewWidth = this.canvas.width / (window.devicePixelRatio || 1);
    const lx = Math.max(4, Math.min(viewWidth - w - 4, x));
    const ly = Math.max(RULER_HEIGHT + 2, bottom - 18);
    g.fillStyle = COLORS.selection;
    g.beginPath();
    g.roundRect(lx, ly, w, 18, 5);
    g.fill();
    g.fillStyle = '#0a0c0f';
    g.textBaseline = 'middle';
    g.fillText(label, lx + 6, ly + 9.5);
  }

  /** Repère d'aimantation et position du clip déplacé ou du bord rogné. */
  #drawDragOverlay(g, height) {
    const { drag } = this;
    if (drag.snappedTo !== null && drag.snappedTo !== undefined) {
      const sx = Math.round(this.#x(drag.snappedTo)) + 0.5;
      g.strokeStyle = COLORS.snap;
      g.setLineDash([4, 3]);
      g.beginPath();
      g.moveTo(sx, RULER_HEIGHT);
      g.lineTo(sx, height);
      g.stroke();
      g.setLineDash([]);
    }
    const laneTop = this.#laneTop(drag.trackId);
    if (laneTop === null || drag.kind === 'range') return;
    const sr = this.engine.getTrack(drag.trackId)?.sampleRate ?? 48000;
    const time = drag.kind === 'move' || drag.edge === 'start' ? drag.clip.start : clipEnd(drag.clip, sr);
    this.#pill(g, formatTime(time), this.#x(time) - (drag.edge === 'end' ? 60 : 0), laneTop - 2);
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
    return this.ui.getLiveTake?.() ?? null;
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

    const selection = this.getSelection();
    this.engine.tracks.forEach((track, i) => {
      const laneTop = RULER_HEIGHT + i * TRACK_HEIGHT;
      const audible = this.engine.isAudible(track);
      const fx = this.ui.fxLabel?.(track.id);
      for (const clip of this.#displayedClips(track)) {
        this.#drawClip(g, laneTop, width, {
          name: track.name,
          color: track.color,
          peaks: track.peaks,
          peaksPerSecond: track.peaksPerSecond,
          start: clip.start,
          duration: clip.length / track.sampleRate,
          audioOffset: clip.offset / track.sampleRate,
          audible,
          fx,
          selected: selection?.clip.id === clip.id,
        });
      }
    });
    const live = this.#liveClip();
    if (live) {
      const top = RULER_HEIGHT + this.engine.tracks.length * TRACK_HEIGHT;
      g.fillStyle = 'rgb(255 77 109 / 6%)';
      g.fillRect(0, top, width, TRACK_HEIGHT);
      this.#drawClip(g, top, width, {
        name: '● Enregistrement…',
        color: REC_COLOR,
        peaks: live.peaks,
        peaksPerSecond: live.peaksPerSecond,
        start: live.startTime,
        duration: live.duration,
        audioOffset: 0,
        audible: true,
      });
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

  /** Clips d'une piste tels qu'affichés : avec l'aperçu du geste en cours. */
  #displayedClips(track) {
    const { drag } = this;
    if (!drag?.moved || drag.trackId !== track.id || drag.kind === 'range') return track.clips;
    return sortClips(track.clips.map((c) => (c.id === drag.clip.id ? drag.clip : c)));
  }

  #drawClip(g, laneTop, viewWidth, clip) {
    const pps = this.pixelsPerSecond;
    const clipX = this.#x(clip.start);
    const clipW = Math.max(1, clip.duration * pps);
    const x0 = Math.max(-4, clipX);
    const x1 = Math.min(viewWidth + 4, clipX + clipW);
    if (x1 <= x0) return;
    const top = laneTop + CLIP_PAD;
    const h = TRACK_HEIGHT - CLIP_PAD * 2 - 1;
    const radius = Math.min(6, clipW / 2);

    g.save();
    g.globalAlpha = clip.audible ? 1 : 0.32;
    g.beginPath();
    g.roundRect(clipX, top, clipW, h, radius);
    g.clip();
    g.fillStyle = `${clip.color}${clip.selected ? '2e' : '1f'}`;
    g.fillRect(x0, top, x1 - x0, h);
    g.fillStyle = `${clip.color}38`;
    g.fillRect(x0, top, x1 - x0, CLIP_HEADER);

    // Nom du clip, collé au bord gauche visible.
    g.fillStyle = clip.color;
    g.font = '600 11px "Inter Variable", system-ui, sans-serif';
    g.textBaseline = 'middle';
    const nameX = Math.max(clipX, 0) + 8;
    g.fillText(clip.name, nameX, top + CLIP_HEADER / 2 + 0.5);
    const nameEnd = nameX + g.measureText(clip.name).width;

    // Pastille du preset / des effets, collée au bord droit visible du clip (s'il y a la place).
    if (clip.fx) {
      g.font = '650 10px "Inter Variable", system-ui, sans-serif';
      const w = g.measureText(clip.fx).width + 12;
      const right = Math.min(clipX + clipW, viewWidth) - 6;
      if (right - w > nameEnd + 6) {
        g.fillStyle = clip.color;
        g.beginPath();
        g.roundRect(right - w, top + 3, w, CLIP_HEADER - 6, 6);
        g.fill();
        g.fillStyle = '#0a0c0f';
        g.fillText(clip.fx, right - w + 6, top + CLIP_HEADER / 2 + 0.5);
      }
    }

    // Forme d'onde : pour chaque colonne de pixels, min/max des pics correspondants,
    // décalés de la position du clip dans l'audio de la piste.
    const waveTop = top + CLIP_HEADER;
    const waveH = h - CLIP_HEADER;
    const mid = waveTop + waveH / 2;
    const amp = waveH / 2 - 3;
    const peaksPerPixel = clip.peaksPerSecond / pps;
    const peakOffset = clip.audioOffset * clip.peaksPerSecond;
    g.fillStyle = clip.color;
    for (let x = Math.floor(Math.max(0, x0)); x < Math.min(viewWidth, x1); x++) {
      const from = peakOffset + (x - clipX) * peaksPerPixel;
      const { min, max } = peakRange(clip.peaks, from, from + peaksPerPixel);
      const y1 = mid - max * amp;
      const y2 = mid - min * amp;
      g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
    g.restore();

    // Contour (plus marqué si le clip est sélectionné).
    g.save();
    g.globalAlpha = clip.selected ? 1 : clip.audible ? 0.55 : 0.2;
    g.strokeStyle = clip.selected ? COLORS.selection : clip.color;
    g.lineWidth = clip.selected ? 2 : 1;
    const inset = clip.selected ? 1 : 0.5;
    g.beginPath();
    g.roundRect(clipX + inset, top + inset, Math.max(1, clipW - inset * 2), h - inset * 2, radius);
    g.stroke();
    g.restore();
  }

  // --- Souris -----------------------------------------------------------------

  #timeAt(clientX) {
    const rect = this.canvas.getBoundingClientRect();
    return (clientX - rect.left + this.scroller.scrollLeft) / this.pixelsPerSecond;
  }

  /**
   * Clip et zone sous le pointeur, ou null.
   * @returns {{ track, index: number, clip, zone: 'move'|'trim'|'range', edge?: 'start'|'end' } | null}
   */
  #hitTest(e) {
    const rect = this.canvas.getBoundingClientRect();
    const y = e.clientY - rect.top - RULER_HEIGHT;
    if (y < 0) return null;
    const index = Math.floor(y / TRACK_HEIGHT);
    const track = this.engine.tracks[index];
    if (!track) return null;
    const yIn = y - index * TRACK_HEIGHT;
    if (yIn < CLIP_PAD || yIn > TRACK_HEIGHT - CLIP_PAD) return null;
    const px = e.clientX - rect.left;
    // Le dernier clip dessiné est au-dessus : on cherche à rebours.
    const clips = sortClips(track.clips);
    for (let i = clips.length - 1; i >= 0; i--) {
      const clip = clips[i];
      const x0 = this.#x(clip.start);
      const x1 = this.#x(clipEnd(clip, track.sampleRate));
      if (px < x0 || px > x1) continue;
      const hit = { track, index, clip };
      // Poignées de rognage à l'intérieur du clip : entre deux clips bout à bout,
      // le côté du pointeur décide lequel est rogné.
      if (x1 - x0 >= EDGE_PIXELS * 3) {
        if (px - x0 < EDGE_PIXELS) return { ...hit, zone: 'trim', edge: 'start' };
        if (x1 - px < EDGE_PIXELS) return { ...hit, zone: 'trim', edge: 'end' };
      }
      return { ...hit, zone: yIn < CLIP_PAD + CLIP_HEADER ? 'move' : 'range' };
    }
    return null;
  }

  /** Points d'aimantation : 0, tête de lecture, bords des autres clips (toutes pistes), grille. */
  #snap(raw, duration, exceptClipId) {
    const others = [];
    for (const t of this.engine.tracks) {
      for (const c of t.clips)
        if (c.id !== exceptClipId) others.push({ start: c.start, end: clipEnd(c, t.sampleRate) });
    }
    const candidates = snapCandidates({
      position: this.engine.position,
      otherClips: others,
      gridStep: rulerStep(this.pixelsPerSecond),
      near: raw,
    });
    return snapStart(raw, duration, candidates, SNAP_PIXELS / this.pixelsPerSecond);
  }

  #onPointerDown(e) {
    if (e.button !== 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const seekAt = (clientX) => this.engine.seek(Math.max(0, this.#timeAt(clientX)));
    const hit = this.engine.locked ? null : this.#hitTest(e);
    if (hit) return this.#startGesture(e, hit, seekAt);

    // Clic dans une piste (hors clip) ou dans la règle : sélection + tête de lecture.
    const y = e.clientY - rect.top - RULER_HEIGHT;
    if (y >= 0) {
      const track = this.engine.tracks[Math.floor(y / TRACK_HEIGHT)];
      if (track) this.ui.select(track.id);
      if (this.selection) this.setSelection(null);
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
   * Geste sur un clip, selon la zone :
   * - en-tête : horizontalement, le clip change de position dans le temps ;
   *   verticalement, la piste change de place dans la liste ;
   * - bord : rognage ;
   * - corps : sélection d'une portion.
   * Aimantation sur 0, la tête, les bords des autres clips et la grille ; Maj = libre.
   * Un simple clic sans mouvement sélectionne le clip et place la tête.
   */
  #startGesture(e, { track, clip, zone, edge }, seekAt) {
    const rect = this.canvas.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const sr = track.sampleRate;
    const before = this.ui.captureArrangement();
    this.ui.select(track.id);
    let pressed = this.#timeAt(e.clientX);
    if (zone === 'range' && !e.shiftKey) pressed = this.#snap(pressed, 0, clip.id).time;
    const anchor = Math.max(clip.start, Math.min(clipEnd(clip, sr), pressed));
    this.drag = { kind: zone, trackId: track.id, clip, edge, snappedTo: null, moved: false, from: anchor, to: anchor };
    this.canvas.setPointerCapture(e.pointerId);
    if (zone === 'move') this.canvas.style.cursor = 'grabbing';

    const move = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!this.drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      this.drag.moved = true;
      const raw =
        (zone === 'move'
          ? clip.start
          : zone === 'trim'
            ? edge === 'start'
              ? clip.start
              : clipEnd(clip, sr)
            : anchor) +
        dx / this.pixelsPerSecond;
      const duration = zone === 'move' ? clip.length / sr : 0;
      const snapped = ev.shiftKey ? { time: Math.max(0, raw), snappedTo: null } : this.#snap(raw, duration, clip.id);
      this.drag.snappedTo = snapped.snappedTo;
      if (zone === 'move') {
        this.drag.clip = { ...clip, start: snapped.time };
        // Changement de piste en direct (haut / bas).
        const lane = laneAt(ev.clientY - rect.top - RULER_HEIGHT, TRACK_HEIGHT, this.engine.tracks.length);
        this.engine.moveTrack(track.id, lane);
      } else if (zone === 'trim') {
        this.drag.clip = trimClip(clip, edge, snapped.time, sr, track.buffer.length);
      } else {
        const t = Math.max(clip.start, Math.min(clipEnd(clip, sr), snapped.time));
        if (t !== snapped.time) this.drag.snappedTo = null; // bloqué au bord du clip
        this.drag.from = Math.min(anchor, t);
        this.drag.to = Math.max(anchor, t);
      }
      this.invalidate();
    };
    const up = (ev) => {
      this.canvas.removeEventListener('pointermove', move);
      this.canvas.removeEventListener('pointerup', up);
      this.canvas.removeEventListener('pointercancel', up);
      const drag = this.drag;
      this.drag = null;
      this.canvas.style.cursor = CURSORS[zone];
      const replace = (label) =>
        this.ui.edit(
          label,
          () =>
            this.engine.setClips(
              track.id,
              track.clips.map((c) => (c.id === clip.id ? drag.clip : c)),
            ),
          before,
        );
      if (!drag.moved) {
        this.setSelection({ trackId: track.id, clipId: clip.id });
        seekAt(ev.clientX);
      } else if (zone === 'move') {
        replace('Déplacer le clip');
        this.setSelection({ trackId: track.id, clipId: clip.id });
      } else if (zone === 'trim') {
        replace('Rogner le clip');
        this.setSelection({ trackId: track.id, clipId: clip.id });
      } else if (drag.to - drag.from >= 1 / sr) {
        this.setSelection({ trackId: track.id, clipId: clip.id, from: drag.from, to: drag.to });
      } else {
        this.setSelection({ trackId: track.id, clipId: clip.id });
      }
      this.invalidate();
    };
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
  }
}
