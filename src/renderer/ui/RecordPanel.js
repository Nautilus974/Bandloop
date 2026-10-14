// Panneau « Enregistrement » (sous la barre de transport) : choix du micro,
// VU-mètre d'entrée, compte à rebours, compensation de latence, retour micro,
// traitement du micro, et messages clairs en cas de refus d'accès.
import { levelHint } from '../record/latency.js';
import { toggleSwitch } from './controls.js';
import { h, svg } from './dom.js';
import { icons } from './icons.js';
import { Meter } from './Meter.js';
import { formatTime } from './time.js';

const COUNTDOWNS = [
  [0, 'Sans'],
  [3, '3 s'],
  [5, '5 s'],
];
const HINT_WINDOW_MS = 1200;

export class RecordPanel {
  /**
   * @param {HTMLElement} el
   * @param {import('../record/Recorder.js').Recorder} recorder
   * @param {{ engine: object, openSystemSettings?: () => void, onClose: () => void, notify: (msg: string, isError?: boolean) => void }} ui
   */
  constructor(el, recorder, ui) {
    this.el = el;
    this.recorder = recorder;
    this.ui = ui;
    this.signature = '';
    this.recentPeaks = [];
    recorder.addEventListener('change', () => this.#maybeRender());
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open() {
    this.el.hidden = false;
    this.signature = '';
    this.render();
    // Ouvre le micro pour afficher le niveau tout de suite (demande l'autorisation).
    if (!this.recorder.isOpen && !this.recorder.busy) this.recorder.open();
  }

  close() {
    this.el.hidden = true;
    // Libère le micro (et le voyant système) s'il ne sert plus.
    if (!this.recorder.busy) this.recorder.close();
  }

  #structure() {
    const r = this.recorder;
    const { latencyMs, ...prefs } = r.prefs;
    return JSON.stringify([r.state, r.isOpen, r.error, r.devices, prefs, latencyMs == null]);
  }

  #maybeRender() {
    if (!this.isOpen) return;
    const sig = this.#structure();
    if (sig !== this.signature) this.render();
    else this.#renderLatency();
  }

  render() {
    const r = this.recorder;
    this.signature = this.#structure();
    this.meterEl = h('div', { className: 'meter input-meter' });
    this.meter = new Meter(this.meterEl, ['IN']);
    this.hintEl = h('p', { className: 'level-hint' });
    this.latencyValue = h('output', { className: 'param-value' });
    this.latencyAuto = h('span', { className: 'latency-auto' });
    this.latencySlider = h('input', {
      type: 'range',
      className: 'param-slider',
      min: 0,
      max: 400,
      step: 1,
      'aria-label': 'Compensation de latence',
      oninput: () => r.setPrefs({ latencyMs: Number(this.latencySlider.value) }),
    });

    const head = h(
      'header',
      { className: 'rp-head' },
      h('span', { className: 'rp-title' }, h('span', { className: 'rec-dot small' }), 'Enregistrement'),
      h(
        'button',
        { className: 'icon-btn', title: 'Fermer', 'aria-label': 'Fermer', onclick: () => this.ui.onClose() },
        svg(icons.close),
      ),
    );

    const body = [];
    if (r.error) {
      body.push(
        h(
          'div',
          { className: 'rp-error', role: 'alert' },
          h('strong', {}, r.error.title),
          h('p', {}, r.error.text),
          h(
            'div',
            { className: 'rp-error-actions' },
            r.error.canOpenSettings && this.ui.openSystemSettings
              ? h(
                  'button',
                  { className: 'btn btn-small', onclick: () => this.ui.openSystemSettings() },
                  'Ouvrir les réglages',
                )
              : null,
            h('button', { className: 'btn btn-small btn-accent', onclick: () => r.open() }, 'Réessayer'),
          ),
        ),
      );
    } else if (r.state === 'opening') {
      body.push(
        h('p', { className: 'fx-caption' }, 'Autorisation du micro… Accepte la demande du système si elle apparaît.'),
      );
    }

    // Entrée
    const deviceSelect = h(
      'select',
      {
        className: 'select',
        'aria-label': 'Micro d’entrée',
        disabled: r.busy || r.devices.length === 0,
        onchange: () => r.setPrefs({ deviceId: deviceSelect.value }),
      },
      r.devices.length
        ? r.devices.map((d) =>
            h(
              'option',
              { value: d.id, selected: d.id === r.prefs.deviceId || (!r.prefs.deviceId && d.id === 'default') },
              d.label,
            ),
          )
        : h('option', {}, r.isOpen ? r.deviceLabel || 'Micro' : 'Aucun micro ouvert'),
    );
    body.push(
      h('div', { className: 'rp-row' }, h('span', { className: 'param-label' }, 'Micro'), deviceSelect),
      h('div', { className: 'rp-row' }, h('span', { className: 'param-label' }, 'Niveau'), this.meterEl),
      this.hintEl,
    );

    // Canaux
    body.push(
      h(
        'div',
        { className: 'rp-row' },
        h('span', { className: 'param-label' }, 'Canaux'),
        h(
          'div',
          { className: 'segmented', role: 'radiogroup', 'aria-label': 'Canaux enregistrés' },
          [
            [1, 'Mono (voix)'],
            [2, 'Stéréo'],
          ].map(([n, label]) =>
            h(
              'button',
              {
                role: 'radio',
                'aria-checked': String(r.prefs.channels === n),
                disabled: r.busy,
                onclick: () => r.setPrefs({ channels: n }),
              },
              label,
            ),
          ),
        ),
      ),
    );

    // Compte à rebours
    body.push(
      h(
        'div',
        { className: 'rp-row' },
        h('span', { className: 'param-label' }, 'Compte à rebours'),
        h(
          'div',
          { className: 'segmented', role: 'radiogroup', 'aria-label': 'Compte à rebours' },
          COUNTDOWNS.map(([n, label]) =>
            h(
              'button',
              {
                role: 'radio',
                'aria-checked': String(r.prefs.countdown === n),
                disabled: r.busy,
                onclick: () => r.setPrefs({ countdown: n }),
              },
              label,
            ),
          ),
        ),
      ),
    );

    // Latence
    body.push(
      h(
        'div',
        { className: 'rp-block' },
        h(
          'div',
          { className: 'param' },
          h(
            'span',
            {
              className: 'param-label',
              title: 'Retard du trajet haut-parleurs → oreilles → micro → logiciel, retiré de la prise',
            },
            'Compensation',
          ),
          this.latencySlider,
          this.latencyValue,
        ),
        h(
          'div',
          { className: 'rp-latency-tools' },
          this.latencyAuto,
          h(
            'button',
            {
              className: 'btn btn-small',
              disabled: r.busy || !!r.error,
              title: 'Joue des clics dans les haut-parleurs et mesure leur retard au micro',
              onclick: () => this.#calibrate(),
            },
            r.state === 'calibrating' ? 'Mesure…' : 'Mesurer',
          ),
          r.prefs.latencyMs != null
            ? h(
                'button',
                { className: 'btn btn-small btn-ghost', onclick: () => r.setPrefs({ latencyMs: null }) },
                'Auto',
              )
            : null,
        ),
        h('p', { className: 'fx-caption' }, '« Mesurer » : haut-parleurs allumés (pas de casque), pièce calme, ~4 s.'),
      ),
    );

    // Retour micro et traitement
    body.push(
      h(
        'div',
        { className: 'rp-toggle' },
        toggleSwitch({ checked: r.prefs.monitor, label: 'Retour micro', onChange: (v) => r.setPrefs({ monitor: v }) }),
        h(
          'div',
          {},
          h('span', { className: 'rp-toggle-title' }, 'Retour micro'),
          h(
            'p',
            { className: 'fx-caption' },
            'S’entendre dans le casque. Casque obligatoire (sinon larsen) ; le retour a un léger retard.',
          ),
        ),
      ),
      h(
        'div',
        { className: 'rp-toggle' },
        toggleSwitch({
          checked: r.prefs.processing,
          label: 'Traitement du micro',
          onChange: (v) => r.setPrefs({ processing: v }),
        }),
        h(
          'div',
          {},
          h('span', { className: 'rp-toggle-title' }, 'Anti-écho et réduction de bruit'),
          h(
            'p',
            { className: 'fx-caption' },
            'Utile sans casque pour retirer le guide de la prise, mais dégrade la voix. Désactivé = son brut, conseillé.',
          ),
        ),
      ),
    );

    const recording = r.state === 'recording' || r.state === 'countdown';
    this.actionLabel = h('span', {}, recording ? 'Arrêter' : '');
    const action = h(
      'button',
      {
        className: `btn rp-record${recording ? ' active' : ''}`,
        disabled: r.state === 'opening' || r.state === 'finishing' || r.state === 'calibrating',
        onclick: () => (recording ? r.stop() : r.record()),
      },
      h('span', { className: 'rec-dot' }),
      this.actionLabel,
    );
    this.recording = recording;

    this.el.replaceChildren(
      head,
      h('div', { className: 'rp-body' }, ...body),
      h('footer', { className: 'rp-foot' }, action),
    );
    this.#renderLatency();
  }

  #renderLatency() {
    const r = this.recorder;
    const ms = Math.round(r.latency * 1000);
    this.latencySlider.value = String(ms);
    this.latencySlider.style.setProperty('--fill', ms / 400);
    this.latencyValue.textContent = `${ms} ms`;
    this.latencyAuto.textContent =
      r.prefs.latencyMs == null ? 'Estimation automatique' : `Auto : ${Math.round(r.autoLatency * 1000)} ms`;
  }

  async #calibrate() {
    this.ui.notify('Mesure de la latence : silence, haut-parleurs allumés…');
    const result = await this.recorder.calibrate();
    if (result.ok)
      this.ui.notify(
        `Latence aller-retour mesurée : ${Math.round(result.latency * 1000)} ms (compensée sur les prochaines prises).`,
      );
    else this.ui.notify(`Mesure impossible : ${result.reason}`, true);
  }

  /** Mise à jour du VU-mètre d'entrée et du conseil de niveau (à chaque image). */
  tick() {
    if (!this.isOpen || !this.meter) return;
    if (!this.recording)
      this.actionLabel.textContent = `Enregistrer depuis ${formatTime(this.ui.engine.position).slice(0, -2)}`;
    const peak = this.recorder.readLevel();
    this.meter.update([peak]);
    const now = performance.now();
    this.recentPeaks.push([now, peak]);
    while (this.recentPeaks.length && now - this.recentPeaks[0][0] > HINT_WINDOW_MS) this.recentPeaks.shift();
    if (!this.recorder.isOpen) {
      this.hintEl.textContent = '';
      return;
    }
    const max = this.recentPeaks.reduce((m, [, p]) => Math.max(m, p), 0);
    const hint = levelHint(max);
    this.hintEl.textContent = hint.text;
    this.hintEl.dataset.level = hint.level;
  }
}
