// Menu d'actions d'une piste (bouton « … » du panneau de pistes, ou clic
// droit sur la piste dans le panneau ou la timeline). Il agit toujours sur la
// piste VISÉE, qui n'est pas forcément la piste sélectionnée.
import { TRACK_COLORS } from '../audio/AudioEngine.js';
import { svg } from './dom.js';
import { icons } from './icons.js';
import { PopupMenu } from './PopupMenu.js';

const COLOR_NAMES = ['Corail', 'Turquoise', 'Lavande', 'Ciel', 'Rose', 'Ambre', 'Vert', 'Rouge', 'Sable', 'Ardoise'];
export const TRACK_SWATCHES = TRACK_COLORS.map((value, i) => ({ value, label: COLOR_NAMES[i] ?? value }));

export class TrackMenu extends PopupMenu {
  /**
   * @param {import('../audio/AudioEngine.js').AudioEngine} engine
   * @param {{
   *   rename: (id: number) => void, duplicate: (id: number) => void, remove: (id: number) => void,
   *   setColor: (id: number, color: string) => void, openFx: (id: number) => void, move: (id: number, delta: number) => void,
   * }} actions
   */
  constructor(engine, actions) {
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌥' : 'Alt+';
    super(
      'Actions de la piste',
      () => {
        const track = engine.getTrack(this.trackId);
        if (!track) return [];
        const index = engine.tracks.indexOf(track);
        const id = track.id;
        return [
          {
            icon: svg(icons.pencil),
            title: 'Renommer…',
            hint: 'ou double-clic sur le nom',
            run: () => actions.rename(id),
          },
          {
            icon: svg(icons.copy),
            title: 'Dupliquer',
            hint: 'Audio, montage, preset et réglages',
            run: () => actions.duplicate(id),
          },
          {
            swatches: TRACK_SWATCHES,
            selected: track.color,
            label: 'Couleur',
            pick: (color) => actions.setColor(id, color),
          },
          { icon: svg(icons.sliders), title: 'Effets et preset vocal', run: () => actions.openFx(id) },
          'separator',
          {
            icon: svg(icons.arrowUp),
            title: 'Monter',
            shortcut: `${mod}↑`,
            disabled: index === 0,
            run: () => actions.move(id, -1),
          },
          {
            icon: svg(icons.arrowDown),
            title: 'Descendre',
            shortcut: `${mod}↓`,
            disabled: index === engine.tracks.length - 1,
            run: () => actions.move(id, 1),
          },
          'separator',
          { icon: svg(icons.trash), title: 'Supprimer la piste', danger: true, run: () => actions.remove(id) },
        ];
      },
      { heading: () => engine.getTrack(this.trackId)?.name ?? null, className: 'track-menu' },
    );
    this.trackId = null;
  }

  /** Ouvre le menu pour une piste : sous `anchor`, ou au point `at` (clic droit). */
  openFor(trackId, anchor, at) {
    if (this.isOpen && this.trackId === trackId && this.anchor === anchor && anchor) return this.close();
    this.trackId = trackId;
    this.open(anchor, at);
  }
}
