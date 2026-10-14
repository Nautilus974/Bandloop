// Boîte « Exporter le mix » : choix du format (WAV qualité / MP3 partage),
// progression par étapes, puis résultat (afficher dans le dossier).
import { estimateExportSize } from '../export/ExportManager.js';
import { h, svg } from './dom.js';
import { icons } from './icons.js';
import { formatTime } from './time.js';

const PREF_KEY = 'bandloop.export.v1';

export function formatBytes(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} Ko`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0).replace('.', ',')} Mo`;
}

function loadPrefs() {
  try {
    return { format: 'wav', bitDepth: 24, kbps: 320, ...JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') };
  } catch {
    return { format: 'wav', bitDepth: 24, kbps: 320 };
  }
}

export class ExportDialog {
  /**
   * @param {{ duration: () => number, sampleRate: number, projectName: () => string,
   *           start: (opts: object) => Promise<string|null>, showInFolder?: (path: string) => void }} deps
   *   start(opts) choisit l'emplacement puis lance l'export (via this.run) ; renvoie null si annulé.
   */
  constructor(deps) {
    this.deps = deps;
    this.prefs = loadPrefs();
  }

  open() {
    if (this.dialog) return;
    const dialog = h('dialog', { className: 'dialog export-dialog', 'aria-label': 'Exporter le mix' });
    this.dialog = dialog;
    dialog.addEventListener('cancel', (e) => {
      if (this.running) e.preventDefault(); // Échap n'interrompt pas un export (bouton Annuler)
    });
    // L'événement « close » arrive après coup : il ne doit toucher que SA boîte
    // (une nouvelle a pu être ouverte entre-temps).
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (this.dialog === dialog) this.dialog = null;
    });
    document.body.append(dialog);
    this.#renderOptions();
    dialog.showModal();
  }

  close() {
    const dialog = this.dialog;
    this.dialog = null; // libéré tout de suite : « Exporter » peut être relancé aussitôt
    this.running = false;
    dialog?.close();
  }

  #savePrefs() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(this.prefs));
    } catch {
      // préférences non mémorisées
    }
  }

  #renderOptions() {
    const { prefs } = this;
    const duration = this.deps.duration();
    const card = (format, title, subtitle, detail) =>
      h(
        'button',
        {
          type: 'button',
          className: 'format-card',
          role: 'radio',
          'aria-checked': String(prefs.format === format),
          onclick: () => {
            prefs.format = format;
            this.#renderOptions();
          },
        },
        h('span', { className: 'format-badge' }, format.toUpperCase()),
        h('span', { className: 'format-title' }, title),
        h('span', { className: 'format-sub' }, subtitle),
        h('span', { className: 'format-detail' }, detail),
      );
    const segmented = (label, values, key, fmt) =>
      h(
        'div',
        { className: 'rp-row' },
        h('span', { className: 'param-label' }, label),
        h(
          'div',
          { className: 'segmented', role: 'radiogroup', 'aria-label': label },
          values.map((v) =>
            h(
              'button',
              {
                type: 'button',
                role: 'radio',
                'aria-checked': String(prefs[key] === v),
                onclick: () => {
                  prefs[key] = v;
                  this.#renderOptions();
                },
              },
              fmt(v),
            ),
          ),
        ),
      );
    const size = estimateExportSize(prefs, duration + 1, this.deps.sampleRate);
    this.dialog.replaceChildren(
      h('h2', { className: 'dialog-title' }, 'Exporter le mix'),
      h(
        'p',
        { className: 'dialog-message' },
        `« ${this.deps.projectName()} » · ${formatTime(duration)} · toutes les pistes audibles, avec leurs effets.`,
      ),
      h(
        'div',
        { className: 'format-cards', role: 'radiogroup', 'aria-label': 'Format' },
        card('wav', 'Qualité studio', 'Sans perte, pour le mastering ou un autre logiciel', 'Fichier lourd'),
        card('mp3', 'Partage', 'Léger, lisible partout : messagerie, réseaux, téléphone', 'Compression avec perte'),
      ),
      prefs.format === 'wav'
        ? segmented('Résolution', [24, 16], 'bitDepth', (v) => `${v} bits${v === 16 ? ' (CD)' : ''}`)
        : segmented('Débit', [128, 192, 320], 'kbps', (v) => `${v} kb/s`),
      h(
        'p',
        { className: 'fx-caption export-estimate' },
        `Taille estimée : ${formatBytes(size)} · Crête limitée à −1 dBFS (aucune saturation).`,
      ),
      h(
        'div',
        { className: 'dialog-actions' },
        h('button', { type: 'button', className: 'btn btn-ghost', onclick: () => this.close() }, 'Annuler'),
        h(
          'button',
          {
            type: 'button',
            className: 'btn btn-primary',
            onclick: async () => {
              this.#savePrefs();
              await this.deps.start({ ...prefs });
            },
          },
          svg(icons.export),
          'Exporter…',
        ),
      ),
    );
  }

  /** Affiche la progression ; renvoie un AbortSignal relié au bouton Annuler. */
  showProgress() {
    this.running = true;
    this.abort = new AbortController();
    this.phaseEl = h('p', { className: 'export-phase' }, 'Préparation…');
    this.barEl = h('div', { className: 'progress-fill' });
    this.percentEl = h('span', { className: 'progress-percent' }, '0 %');
    this.dialog.replaceChildren(
      h('h2', { className: 'dialog-title' }, 'Export en cours'),
      this.phaseEl,
      h('div', { className: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 }, this.barEl),
      this.percentEl,
      h(
        'div',
        { className: 'dialog-actions' },
        h(
          'button',
          { type: 'button', className: 'btn btn-ghost', onclick: () => this.abort.abort() },
          'Annuler l’export',
        ),
      ),
    );
    return this.abort.signal;
  }

  phase(text, fraction) {
    if (!this.phaseEl) return;
    this.phaseEl.textContent = text;
    const pct = Math.round(fraction * 100);
    this.barEl.style.transform = `scaleX(${fraction})`;
    this.percentEl.textContent = `${pct} %`;
    this.barEl.parentElement.setAttribute('aria-valuenow', String(pct));
  }

  showDone({ path, size, duration, reductionDb }) {
    this.running = false;
    if (!this.dialog) return;
    const name = String(path).split(/[\\/]/).pop();
    this.dialog.replaceChildren(
      h('div', { className: 'export-done-icon' }, svg(icons.export)),
      h('h2', { className: 'dialog-title' }, 'Mix exporté'),
      h('p', { className: 'dialog-message export-file' }, name),
      h(
        'p',
        { className: 'fx-caption' },
        `${formatTime(duration)} · ${formatBytes(size)}${reductionDb < -0.1 ? ` · crêtes réduites de ${Math.abs(reductionDb).toFixed(1).replace('.', ',')} dB par le limiteur` : ''}`,
      ),
      h(
        'div',
        { className: 'dialog-actions' },
        this.deps.showInFolder
          ? h(
              'button',
              { type: 'button', className: 'btn', onclick: () => this.deps.showInFolder(path) },
              'Afficher dans le dossier',
            )
          : null,
        h('button', { type: 'button', className: 'btn btn-primary', onclick: () => this.close() }, 'Fermer'),
      ),
    );
  }

  showError(title, text) {
    this.running = false;
    if (!this.dialog) return;
    this.dialog.replaceChildren(
      h('h2', { className: 'dialog-title' }, title),
      h('p', { className: 'dialog-message' }, text),
      h(
        'div',
        { className: 'dialog-actions' },
        h(
          'button',
          { type: 'button', className: 'btn', onclick: () => this.#renderOptions() },
          'Modifier les réglages',
        ),
        h('button', { type: 'button', className: 'btn btn-primary', onclick: () => this.close() }, 'Fermer'),
      ),
    );
  }
}
