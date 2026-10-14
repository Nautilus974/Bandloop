// Menu du bouton « + » du panneau de pistes : nouvelle piste par prise micro
// ou par import de fichier.
import { h, svg } from './dom.js';
import { icons } from './icons.js';
import { PopupMenu } from './PopupMenu.js';

export class AddTrackMenu extends PopupMenu {
  /** @param {{ record: () => void, importFile: () => void }} actions */
  constructor(actions) {
    super('Ajouter une piste', () => [
      {
        icon: h('span', { className: 'rec-dot small' }),
        title: 'Enregistrer au micro',
        hint: 'Voix ou instrument, sur une nouvelle piste',
        run: actions.record,
      },
      {
        icon: svg(icons.import),
        title: 'Importer un fichier audio',
        hint: 'WAV, MP3, OGG, FLAC, M4A',
        run: actions.importFile,
      },
    ]);
  }
}
