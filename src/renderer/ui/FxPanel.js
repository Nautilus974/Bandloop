// Panneau latéral d'effets vocaux de la piste sélectionnée :
// nettoyage de la voix (réduction de bruit, passe-haut, gate, de-esser),
// presets par catégories, correction de voix (vitesse, intensité, vibrato,
// écoute A/B, tonalité du morceau ou propre à la piste, harmonies, note chantée
// et note visée), transposition, harmonies, vocodeur, bourdon et chaîne
// d'effets temps réel.
//
// Toute modification passe par ui.recordVocal : elle est annulable (Ctrl/⌘+Z)
// et refusée pendant un enregistrement (le panneau est alors grisé).
import { clipEnd } from '../audio/clips.js';
import { CLEAN_PARAMS, MIN_PROFILE_SECONDS } from '../vocal/clean.js';
import { formatPan } from '../audio/mixing.js';
import { USER_CATEGORY } from '../presets/PresetStore.js';
import { FX_CATALOG, FX_TYPES } from '../vocal/fx/catalog.js';
import {
  createModule,
  defaultSettings,
  DRONE_PARAMS,
  HARMONY_LEVEL,
  HARMONY_VOICE_PARAMS,
  isNeutral,
  MAX_HARMONY_VOICES,
  PITCH_PARAMS,
  sameSettings,
  VOCODER_PARAMS,
  VOICE_PARAMS,
} from '../vocal/settings.js';
import { DIATONIC_INTERVALS, inScale, NOTE_NAMES, SCALES } from '../vocal/theory.js';
import { paramRow, toggleSwitch } from './controls.js';
import { confirmDialog, promptDialog } from './Dialog.js';
import { h, svg } from './dom.js';
import { icons } from './icons.js';
import { formatTime } from './time.js';

const param = (list, key, overrides = {}) => ({ ...list.find((p) => p.key === key), ...overrides });

// Présentation spécifique de certains paramètres.
/** Caractère de la correction selon la vitesse de calage. */
export function speedCharacter(ms) {
  if (ms === 0) return 'Robot';
  if (ms <= 35) return 'Rapide';
  if (ms <= 130) return 'Naturel';
  return 'Doux';
}
const SPEED = param(PITCH_PARAMS, 'speed', {
  // Échelle « racine » : le tiers gauche du curseur couvre 0-45 ms, là où l'effet change le plus.
  scale: 'sqrt',
  format: (v) => (v === 0 ? 'Robot · instantané' : `${speedCharacter(v)} · ${v} ms`),
});
const SPEED_TICKS = [
  [0, 'Robot'],
  [20, 'Rapide'],
  [80, 'Naturel'],
  [200, 'Doux'],
];
const STRENGTH = param(PITCH_PARAMS, 'strength', { label: 'Intensité (dosage)' });
const KEEP_VIBRATO = param(PITCH_PARAMS, 'keepVibrato');
const HARMONY_MASTER = { ...HARMONY_LEVEL };
/** Nom de note à la française : 60 = Do3. */
export const noteName = (midi) => `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 2}`;
/** Nombre arrondi avec un vrai signe moins (affichage des niveaux en dB). */
const signed = (v) => String(Math.round(v)).replace('-', '−');
/** Ligne de réglage avec une colonne de libellé plus large. */
const wide = (row) => (row.classList.add('param-wide'), row);
const PITCH_VIEW_SECONDS = 4; // fenêtre de l'affichage des hauteurs, centrée sur la tête
const SHIFT = param(PITCH_PARAMS, 'shift');
const FORMANT = param(PITCH_PARAMS, 'formant');
const VOICE_LEVEL = param(VOICE_PARAMS, 'level', {
  format: (v) => (v <= -60 ? 'Coupée' : `${v > 0 ? '+' : ''}${String(v).replace('.', ',')} dB`),
});
const HARMONY_ROW_PARAMS = {
  level: param(HARMONY_VOICE_PARAMS, 'level'),
  pan: param(HARMONY_VOICE_PARAMS, 'pan', { format: (v) => formatPan(v / 100) }),
  detune: param(HARMONY_VOICE_PARAMS, 'detune'),
  delay: param(HARMONY_VOICE_PARAMS, 'delay'),
};

const CHROMATIC_NAMES = {
  0: 'unisson',
  3: 'tierce min.',
  4: 'tierce maj.',
  5: 'quarte',
  7: 'quinte',
  12: 'octave',
  24: '2 octaves',
};
const CHROMATIC_INTERVALS = Array.from({ length: 49 }, (_, i) => i - 24).map((st) => {
  const name = CHROMATIC_NAMES[Math.abs(st)];
  return [st, `${st > 0 ? '+' : st < 0 ? '−' : ''}${Math.abs(st)} dt${name ? ` · ${name}${st < 0 ? ' ↓' : ''}` : ''}`];
});
// Conversion approximative degrés <-> demi-tons (gamme majeure) au changement de mode.
const DEGREE_TO_ST = [0, 2, 4, 5, 7, 9, 11, 12];
const degreesToSemitones = (d) => Math.sign(d) * DEGREE_TO_ST[Math.min(7, Math.abs(d))];
const semitonesToDegrees = (st) => {
  const a = Math.min(12, Math.abs(st));
  let best = 0;
  DEGREE_TO_ST.forEach((v, i) => {
    if (Math.abs(v - a) < Math.abs(DEGREE_TO_ST[best] - a)) best = i;
  });
  return Math.sign(st) * best;
};

const STATUS_TEXT = {
  pending: 'En attente…',
  analyzing: 'Analyse de la voix…',
  rendering: 'Calcul des effets…',
  ready: 'À jour',
  error: 'Erreur de calcul',
};

export class FxPanel {
  /**
   * @param {HTMLElement} el
   * @param {import('../audio/AudioEngine.js').AudioEngine} engine
   * @param {import('../vocal/VocalHub.js').VocalHub} hub
   * @param {import('../presets/PresetStore.js').PresetStore} presets
   * @param {{ getSelectedId: () => number|null, onClose: () => void, notify: (msg: string, isError?: boolean) => void }} ui
   */
  constructor(el, engine, hub, presets, ui) {
    this.el = el;
    this.engine = engine;
    this.hub = hub;
    this.presets = presets;
    this.ui = ui;
    this.category = 'essentials';
    this.collapsed = new Set(['vocoder', 'drone', 'clean']);

    hub.addEventListener('status', (e) => {
      if (e.detail.trackId === this.trackId) this.#renderStatus();
    });
    hub.addEventListener('tonality', () => this.render());
    presets.addEventListener('change', () => this.render());
  }

  get isOpen() {
    return !this.el.hidden;
  }

  get trackId() {
    return this.ui.getSelectedId();
  }

  open() {
    this.el.hidden = false;
    this.render();
  }

  close() {
    this.el.hidden = true;
  }

  // ------------------------------------------------------------------ état

  get state() {
    return this.hub.getState(this.trackId);
  }

  get settings() {
    return this.state.settings;
  }

  /**
   * Applique une modification aux réglages de la piste (annulable).
   * `structural` : redessiner le panneau ; `key` : réglage modifié, pour fusionner
   * les mouvements d'un même curseur dans l'historique.
   */
  #edit(mutate, { structural = false, label = 'Modifier les effets vocaux', key } = {}) {
    const next = structuredClone(this.settings);
    mutate(next);
    const done = this.#record(label, () => this.hub.setSettings(this.trackId, next), key);
    if (structural || !done) this.render();
    else this.#renderPresetBar();
  }

  /** Toute modification de l'état vocal passe par ici (historique, blocage). */
  #record(label, fn, key) {
    return this.ui.recordVocal ? this.ui.recordVocal(this.trackId, label, fn, { mergeKey: key }) : (fn(), true);
  }

  get locked() {
    return !!this.ui.isLocked?.();
  }

  #isModified() {
    const { presetId, settings } = this.state;
    if (!presetId) return false;
    const reference = this.presets.settingsOf(presetId);
    return !!reference && !sameSettings(reference, settings);
  }

  // ------------------------------------------------------------------ rendu

  render() {
    if (!this.isOpen) return;
    const track = this.engine.getTrack(this.trackId);
    const scrollTop = this.el.querySelector('.fx-body')?.scrollTop ?? 0;
    this.statusChip = h('span', { className: 'fx-status' });
    this.abButtons = [];
    this.presetBar = h('div', { className: 'preset-bar' });

    const header = h(
      'header',
      { className: 'fx-header' },
      h(
        'div',
        { className: 'fx-title' },
        h('span', { className: 'fx-eyebrow' }, 'Effets vocaux'),
        h(
          'span',
          { className: 'fx-track', style: { '--track-color': track?.color ?? 'var(--text-3)' } },
          h('span', { className: 'dot' }),
          h('span', { className: 'fx-track-name' }, track ? track.name : 'Aucune piste'),
        ),
      ),
      track ? this.statusChip : null,
      track
        ? h(
            'button',
            {
              className: 'icon-btn bypass-btn',
              'aria-pressed': String(this.state.bypass),
              title: this.state.bypass ? 'Réactiver les effets' : 'Contourner les effets (écoute de la voix d’origine)',
              'aria-label': 'Contourner les effets',
              disabled: this.locked,
              onclick: () => {
                const off = !this.state.bypass;
                this.#record(off ? 'Contourner les effets' : 'Réactiver les effets', () =>
                  this.hub.setBypass(this.trackId, off),
                );
                this.render();
              },
            },
            svg(icons.power),
          )
        : null,
      h(
        'button',
        { className: 'icon-btn', title: 'Fermer', 'aria-label': 'Fermer le panneau', onclick: () => this.ui.onClose() },
        svg(icons.close),
      ),
    );

    if (!track) {
      this.el.replaceChildren(
        header,
        h(
          'div',
          { className: 'fx-empty' },
          svg(icons.wave),
          h('p', {}, 'Sélectionne une piste pour éditer ses effets vocaux.'),
        ),
      );
      return;
    }

    const body = h(
      'fieldset',
      { className: `fx-body${this.state.bypass ? ' bypassed' : ''}`, disabled: this.locked },
      this.locked
        ? h(
            'p',
            { className: 'fx-locked', role: 'status' },
            'Enregistrement en cours : les réglages sont bloqués jusqu’à la fin de la prise.',
          )
        : null,
      this.#cleanSection(),
      this.#presetSection(),
      this.#correctionSection(),
      this.#timbreSection(),
      this.#harmonySection(),
      this.#vocoderSection(),
      this.#droneSection(),
      this.#chainSection(),
    );
    this.el.replaceChildren(header, body);
    body.scrollTop = scrollTop;
    this.#renderPresetBar();
    this.#renderStatus();
  }

  #renderStatus() {
    if (!this.statusChip || !this.state) return;
    const { status, error } = this.state;
    this.statusChip.textContent = STATUS_TEXT[status] ?? '';
    this.statusChip.dataset.status = status;
    this.statusChip.title = error || '';
    // Le calcul vient de finir (ou de repartir) : A/B et affichage des notes suivent,
    // sans redessiner tout le panneau (un curseur peut être en cours de glisser).
    const canCompare = this.state.signature !== 'off' && !!this.state.rendered && !this.locked;
    for (const b of this.abButtons ?? []) b.disabled = !canCompare;
    this.lastPitchKey = null;
    this.#refreshCleanInfo();
  }

  /** Section repliable, avec interrupteur optionnel dans l'en-tête. */
  #section(id, title, { caption, enabled, onToggle, actions } = {}, ...content) {
    const collapsed = this.collapsed.has(id);
    const toggleCollapse = () => {
      if (this.collapsed.has(id)) this.collapsed.delete(id);
      else this.collapsed.add(id);
      section.classList.toggle('collapsed');
      head.setAttribute('aria-expanded', String(!section.classList.contains('collapsed')));
    };
    const head = h(
      'div',
      {
        className: 'fx-section-head',
        role: 'button',
        tabIndex: 0,
        'aria-expanded': String(!collapsed),
        onclick: toggleCollapse,
        onkeydown: (e) => {
          if (e.target === head && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            toggleCollapse();
          }
        },
      },
      h('span', { className: 'chevron' }, svg(icons.chevronDown)),
      h('span', { className: 'fx-section-title' }, title),
      actions ?? null,
      onToggle ? toggleSwitch({ checked: enabled, label: `Activer : ${title}`, onChange: onToggle }) : null,
    );
    const section = h(
      'section',
      {
        className: `fx-section${collapsed ? ' collapsed' : ''}${onToggle && !enabled ? ' disabled' : ''}`,
        dataset: { section: id },
      },
      head,
      h(
        'div',
        { className: 'fx-section-body' },
        caption ? h('p', { className: 'fx-caption' }, caption) : null,
        ...content,
      ),
    );
    return section;
  }

  // ------------------------------------------------------------------ presets

  #presetSection() {
    const categories = this.presets.categories;
    const current = this.state.presetId ? this.presets.get(this.state.presetId) : null;
    if (current && !this.presetCategoryChosen) this.category = current.category;
    const category = categories.find((c) => c.id === this.category) ?? categories[0];

    const tabs = h(
      'div',
      { className: 'preset-tabs', role: 'tablist' },
      categories.map((c) =>
        h(
          'button',
          {
            className: 'preset-tab',
            role: 'tab',
            'aria-selected': String(c.id === category.id),
            onclick: () => {
              this.category = c.id;
              this.presetCategoryChosen = true;
              this.render();
            },
          },
          c.name,
          c.id === USER_CATEGORY.id ? h('span', { className: 'tab-count' }, String(c.presets.length)) : null,
        ),
      ),
    );

    const grid = category.presets.length
      ? h(
          'div',
          { className: 'preset-grid' },
          category.presets.map((p) =>
            h(
              'button',
              {
                className: 'preset-card',
                'aria-pressed': String(p.id === this.state.presetId),
                title: p.description || p.name,
                onclick: () => this.#applyPreset(p.id),
              },
              h('span', { className: 'preset-name' }, p.name),
              p.description ? h('span', { className: 'preset-desc' }, p.description) : null,
            ),
          ),
        )
      : h(
          'p',
          { className: 'fx-caption preset-empty' },
          'Règle les effets à ton goût puis « Enregistrer sous… » pour créer ton premier preset.',
        );

    return this.#section('presets', 'Presets', {}, this.presetBar, tabs, grid);
  }

  #renderPresetBar() {
    if (!this.presetBar) return;
    const { presetId } = this.state;
    const preset = presetId ? this.presets.get(presetId) : null;
    const modified = this.#isModified();
    const isUser = preset && !preset.builtin;
    const button = (label, icon, onclick, cls = '') =>
      h('button', { className: `btn btn-small ${cls}`, onclick }, icon ? svg(icons[icon]) : null, label);

    this.presetBar.replaceChildren(
      h(
        'div',
        { className: 'preset-current' },
        h('span', { className: 'preset-current-label' }, 'Preset'),
        h('span', { className: 'preset-current-name' }, preset ? preset.name : 'Aucun'),
        modified ? h('span', { className: 'badge' }, 'modifié') : null,
      ),
      h(
        'div',
        { className: 'preset-actions' },
        isUser && modified ? button('Enregistrer', 'save', () => this.#saveUserPreset(), 'btn-accent') : null,
        button('Enregistrer sous…', isUser && modified ? null : 'save', () => this.#saveAs()),
        modified ? button('Revenir au preset', 'reset', () => this.#applyPreset(presetId)) : null,
        isUser ? button('Renommer', null, () => this.#rename()) : null,
        isUser ? button('Supprimer', 'trash', () => this.#deletePreset(), 'btn-danger-ghost') : null,
        preset || !isNeutral(this.settings) ? button('Tout retirer', null, () => this.#clear()) : null,
      ),
    );
  }

  #applyPreset(id) {
    const settings = this.presets.settingsOf(id);
    if (!settings) return;
    const name = this.presets.get(id).name;
    const done = this.#record(`Appliquer le preset « ${name} »`, () =>
      this.hub.setSettings(this.trackId, settings, { presetId: id }),
    );
    if (done) this.ui.notify(`Preset « ${name} » appliqué.`);
    this.render();
  }

  #clear() {
    this.#record('Retirer tous les effets', () =>
      this.hub.setSettings(this.trackId, defaultSettings(), { presetId: null }),
    );
    this.render();
  }

  async #saveAs() {
    const preset = this.state.presetId ? this.presets.get(this.state.presetId) : null;
    const name = await promptDialog({
      title: 'Enregistrer un preset',
      label: 'Nom du preset',
      value: preset ? `${preset.name} perso` : 'Ma voix',
      hint: 'Il sera rangé dans « Mes presets ». La tonalité du morceau n’est pas enregistrée.',
    });
    if (!name) return;
    try {
      const created = await this.presets.create(name, this.settings);
      this.#record(`Enregistrer le preset « ${created.name} »`, () =>
        this.hub.setSettings(this.trackId, this.settings, { presetId: created.id }),
      );
      this.category = USER_CATEGORY.id;
      this.presetCategoryChosen = true;
      this.ui.notify(`Preset « ${created.name} » enregistré.`);
      this.render();
    } catch (err) {
      this.ui.notify(err.message, true);
    }
  }

  async #saveUserPreset() {
    try {
      const p = await this.presets.update(this.state.presetId, { settings: this.settings });
      this.ui.notify(`Preset « ${p.name} » mis à jour.`);
      this.render();
    } catch (err) {
      this.ui.notify(err.message, true);
    }
  }

  async #rename() {
    const preset = this.presets.get(this.state.presetId);
    const name = await promptDialog({
      title: 'Renommer le preset',
      label: 'Nouveau nom',
      value: preset.name,
      confirm: 'Renommer',
    });
    if (!name) return;
    try {
      await this.presets.update(preset.id, { name });
    } catch (err) {
      this.ui.notify(err.message, true);
    }
  }

  async #deletePreset() {
    const preset = this.presets.get(this.state.presetId);
    const ok = await confirmDialog({
      title: 'Supprimer le preset',
      message: `« ${preset.name} » sera définitivement supprimé. Les réglages actuels de la piste sont conservés.`,
      confirm: 'Supprimer',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.presets.remove(preset.id);
      this.hub.setSettings(this.trackId, this.settings, { presetId: null });
      this.ui.notify(`Preset « ${preset.name} » supprimé.`);
      this.render();
    } catch (err) {
      this.ui.notify(err.message, true);
    }
  }

  // ------------------------------------------------------------------ tonalité et hauteur

  /**
   * Écoute A/B (commune à la correction et au nettoyage) : A = voix traitée,
   * B = voix brute. Simple écoute, rien n'est modifié ni exporté autrement.
   */
  #abRow(labelA) {
    const state = this.state;
    const canCompare = state.signature !== 'off' && !!state.rendered;
    this.abButtons ??= [];
    return h(
      'div',
      { className: 'ab-row' },
      h('span', { className: 'param-label' }, 'Écoute'),
      h(
        'div',
        {
          className: 'segmented ab-switch',
          role: 'radiogroup',
          'aria-label': `Comparer la voix ${labelA.toLowerCase()} et la voix brute`,
          title: canCompare
            ? 'Compare à l’oreille, pendant la lecture. Simple écoute : l’export et le projet gardent la voix traitée.'
            : 'Disponible quand un traitement (nettoyage, correction…) est calculé.',
        },
        [
          [false, 'A', labelA],
          [true, 'B', 'Brute'],
        ].map(([raw, letter, label]) => {
          const b = h(
            'button',
            {
              role: 'radio',
              'aria-checked': String(state.compareRaw === raw),
              disabled: !canCompare,
              onclick: () => {
                this.hub.setCompare(this.trackId, raw);
                this.render();
              },
            },
            h('b', {}, letter),
            ` ${label}`,
          );
          this.abButtons.push(b);
          return b;
        }),
      ),
    );
  }

  /** Ouvre une section (depuis le menu d'une piste) et la met en évidence. */
  reveal(id) {
    this.collapsed.delete(id);
    this.render();
    const section = this.el.querySelector(`[data-section="${id}"]`);
    if (!section) return;
    section.scrollIntoView({ block: 'start' });
    section.classList.remove('flash');
    void section.offsetWidth;
    section.classList.add('flash');
  }

  // ------------------------------------------------------------------ nettoyage de la voix

  /** Modification du nettoyage (annulable). */
  #editClean(mutate, { structural = false, label = 'Modifier le nettoyage', key } = {}) {
    const next = structuredClone(this.state.clean);
    mutate(next);
    const done = this.#record(label, () => this.hub.setClean(this.trackId, next), key && `clean.${key}`);
    if (structural || !done) this.render();
  }

  /** Carte d'un outil de nettoyage : interrupteur et réglages. */
  #cleanCard(group, title, rows, extra = []) {
    const c = this.state.clean[group];
    return h(
      'div',
      { className: `sub-card${c.enabled ? '' : ' off'}`, dataset: { tool: group } },
      h(
        'div',
        { className: 'sub-card-head' },
        h('span', { className: 'param-label' }, title),
        toggleSwitch({
          checked: c.enabled,
          label: `Activer : ${title}`,
          onChange: (v) =>
            this.#editClean((n) => (n[group].enabled = v), {
              structural: true,
              label: `${v ? 'Activer' : 'Désactiver'} : ${title.toLowerCase()}`,
            }),
        }),
      ),
      ...rows,
      ...extra,
    );
  }

  #cleanSection() {
    const { clean } = this.state;
    const P = CLEAN_PARAMS;
    const row = (group, key, label, opts = {}) => {
      const def = { ...P[group].find((p) => p.key === key), ...opts };
      const r = paramRow(def, clean[group][key], (v) =>
        this.#editClean((n) => (n[group][key] = v), { label, key: `${group}.${key}` }),
      );
      return r;
    };

    // Bruit de fond : intensité et empreinte (auto ou zone choisie).
    const amount = row('noise', 'amount', 'Intensité de la réduction de bruit', {
      format: (v) => `${v <= 30 ? 'Léger' : v <= 70 ? 'Moyen' : 'Fort'} · ${v} %`,
    });
    amount.classList.add('param-hero');
    amount.append(h('div', { className: 'param-scale' }, h('span', {}, 'Léger'), h('span', {}, 'Fort')));
    const profile = clean.noise.profile;
    this.cleanInfoEls = {
      profile: h('span', { className: 'profile-text' }),
      warn: h('p', { className: 'clean-warn', hidden: true }),
      gate: h('p', { className: 'fx-caption' }),
      fit: h(
        'button',
        {
          className: 'btn btn-small',
          title: 'Place le seuil 8 dB au-dessus du bruit restant mesuré par le dernier calcul.',
          onclick: () => this.#fitGate(),
        },
        'Régler sur le bruit',
      ),
    };
    const profileRow = h(
      'div',
      { className: 'profile-row' },
      this.cleanInfoEls.profile,
      h(
        'div',
        { className: 'segmented profile-mode', role: 'radiogroup', 'aria-label': 'Empreinte du bruit' },
        h(
          'button',
          {
            role: 'radio',
            'aria-checked': String(!profile),
            onclick: () =>
              this.#editClean((n) => (n.noise.profile = null), {
                structural: true,
                label: 'Empreinte du bruit automatique',
              }),
          },
          'Auto',
        ),
        h(
          'button',
          {
            role: 'radio',
            'aria-checked': String(!!profile),
            title:
              'Glisse d’abord sur le clip, dans la timeline, pour sélectionner une zone où l’on n’entend que le bruit.',
            onclick: () => this.#takeSelectionAsProfile(),
          },
          'Prendre la sélection',
        ),
      ),
    );

    const hp = row('highpass', 'freq', 'Fréquence du passe-haut');
    const gate = row('gate', 'threshold', 'Seuil du noise gate');
    return this.#section(
      'clean',
      'Nettoyage de la voix',
      {
        enabled: clean.enabled,
        onToggle: (v) =>
          this.#editClean((n) => (n.enabled = v), {
            structural: true,
            label: v ? 'Activer le nettoyage' : 'Désactiver le nettoyage',
          }),
        caption:
          'Appliqué avant la correction de voix, calculé en arrière-plan. Traitement classique (sans IA) : très efficace sur un bruit de fond constant, sans effet sur les clics, grésillements ou saturations enregistrés.',
      },
      this.#abRow('Nettoyée'),
      this.#cleanCard(
        'noise',
        'Bruit de fond (souffle, ronflement, pièce)',
        [amount, profileRow],
        [this.cleanInfoEls.warn],
      ),
      this.#cleanCard(
        'highpass',
        'Passe-haut',
        [hp],
        [
          h(
            'p',
            { className: 'fx-caption' },
            '50-60 Hz : ronflement secteur · 80-100 Hz : voix grave · 120-150 Hz : voix aiguë, bruits de manipulation.',
          ),
        ],
      ),
      this.#cleanCard('gate', 'Noise gate', [gate], [this.cleanInfoEls.gate, this.cleanInfoEls.fit]),
      this.#cleanCard('deesser', 'De-esser (sifflantes)', [row('deesser', 'amount', 'Intensité du de-esser')]),
    );
  }

  /** Bruit estimé par le dernier calcul : mis à jour sans redessiner le panneau. */
  #refreshCleanInfo() {
    const els = this.cleanInfoEls;
    if (!els?.profile.isConnected || !this.state) return;
    const { clean, cleanInfo, status } = this.state;
    const profile = clean.noise.profile;
    const fresh = cleanInfo && clean.enabled && clean.noise.enabled;
    const db = cleanInfo?.noiseDb != null ? signed(cleanInfo.noiseDb) : null;
    if (!fresh || db === null)
      els.profile.textContent = ['pending', 'analyzing', 'rendering'].includes(status)
        ? 'Estimation du bruit en cours…'
        : 'Le bruit sera estimé au prochain calcul.';
    else if (cleanInfo.source === 'manual')
      els.profile.textContent = `Zone choisie : ${formatTime(profile.start)} → ${formatTime(profile.end)} · bruit ≈ ${db} dBFS`;
    else
      els.profile.textContent = `Auto : ${cleanInfo.seconds.toFixed(1).replace('.', ',')} s de passages calmes · bruit ≈ ${db} dBFS`;
    els.warn.hidden = !(fresh && cleanInfo.uncertain && !profile);
    els.warn.textContent =
      'Peu de vrai silence dans la prise : l’estimation contient sans doute de la voix. Sélectionne dans la timeline une zone de bruit seul (avant la première phrase, par exemple), puis « Prendre la sélection ».';
    const residual = cleanInfo?.residualDb != null ? signed(cleanInfo.residualDb) : null;
    els.gate.textContent =
      residual !== null && clean.enabled
        ? `Bruit restant avant le gate ≈ ${residual} dBFS : un seuil 6 à 10 dB au-dessus coupe les silences sans toucher aux fins de phrases.`
        : 'Coupe ce qui reste sous le seuil : les silences entre les phrases.';
    if (els.fit) els.fit.disabled = residual === null || !clean.enabled || this.locked;
  }

  /** Seuil du gate : 8 dB au-dessus du bruit restant mesuré. */
  #fitGate() {
    const residual = this.state.cleanInfo?.residualDb;
    if (residual == null) return;
    const threshold = Math.max(-80, Math.min(-20, Math.round(residual + 8)));
    this.#editClean(
      (n) => {
        n.gate.enabled = true;
        n.gate.threshold = threshold;
      },
      { structural: true, label: 'Régler le seuil du gate' },
    );
    this.ui.notify(`Seuil du noise gate réglé à ${signed(threshold)} dB (bruit restant ≈ ${signed(residual)} dBFS).`);
  }

  #takeSelectionAsProfile() {
    const range = this.ui.getTrackRange?.(this.trackId);
    if (!range) {
      this.ui.notify(
        'Sélectionne d’abord, dans la timeline, une zone de cette piste où l’on n’entend que le bruit (glisse sur le clip).',
        true,
      );
      return this.render();
    }
    if (range.end - range.start < MIN_PROFILE_SECONDS) {
      this.ui.notify('Zone trop courte : sélectionne au moins 0,15 s de bruit seul.', true);
      return this.render();
    }
    this.#editClean((n) => (n.noise.profile = range), {
      structural: true,
      label: 'Empreinte du bruit sur la sélection',
    });
    this.ui.notify(`Empreinte du bruit prise de ${formatTime(range.start)} à ${formatTime(range.end)}.`);
  }

  // ------------------------------------------------------------------ correction de voix

  #correctionSection() {
    const { pitch, harmony } = this.settings;
    const k = (key) => ({ key });

    const ab = this.#abRow('Corrigée');

    // Note chantée / note visée.
    this.pitchView = h('canvas', { className: 'pitch-view', height: 96 });
    this.pitchReadout = h('div', { className: 'pitch-readout', 'aria-live': 'off' });

    const speedRow = paramRow(SPEED, pitch.speed, (v) =>
      this.#edit((s) => (s.pitch.speed = v), { label: 'Vitesse de calage', ...k('pitch.speed') }),
    );
    speedRow.classList.add('param-hero');
    speedRow.append(
      h(
        'div',
        { className: 'param-ticks', 'aria-hidden': 'true' },
        SPEED_TICKS.map(([ms, label]) =>
          h('span', { style: { left: `${(Math.sqrt(ms / SPEED.max) * 100).toFixed(2)}%` } }, label),
        ),
      ),
    );
    const strengthRow = paramRow(STRENGTH, pitch.strength, (v) =>
      this.#edit((s) => (s.pitch.strength = v), { label: 'Intensité de la correction', ...k('pitch.strength') }),
    );
    strengthRow.classList.add('param-hero');
    strengthRow.append(
      h('div', { className: 'param-scale' }, h('span', {}, 'Voix brute'), h('span', {}, 'Pleinement corrigée')),
    );

    return this.#section(
      'pitch',
      'Correction de voix',
      {
        enabled: pitch.correct,
        onToggle: (v) =>
          this.#edit((s) => (s.pitch.correct = v), {
            structural: true,
            label: v ? 'Activer la correction' : 'Désactiver la correction',
          }),
        caption:
          'Recale la voix sur les notes de la gamme. Calcul en arrière-plan après chaque réglage (quelques secondes), pas en direct au micro.',
      },
      ab,
      h('div', { className: 'pitch-box' }, this.pitchReadout, this.pitchView),
      speedRow,
      strengthRow,
      wide(
        paramRow(KEEP_VIBRATO, pitch.keepVibrato, (v) =>
          this.#edit((s) => (s.pitch.keepVibrato = v), { label: 'Préserver le vibrato' }),
        ),
      ),
      this.#trackTonalityBlock(),
      this.#harmonyQuick(harmony),
    );
  }

  /** Tonalité de calage : celle du morceau, ou une tonalité propre à la piste. */
  #trackTonalityBlock() {
    const own = this.state.tonality;
    const current = own ?? this.hub.tonality;
    const set = (t) => {
      if (own) this.#record('Changer la tonalité de la piste', () => this.hub.setTrackTonality(this.trackId, t));
      else this.ui.setSongTonality ? this.ui.setSongTonality(t) : this.hub.setTonality(t);
      this.render();
    };
    const keySelect = h(
      'select',
      {
        className: 'select',
        'aria-label': own ? 'Tonique de la piste' : 'Tonique du morceau',
        onchange: () => set({ key: Number(keySelect.value), scale: current.scale }),
      },
      NOTE_NAMES.map((n, i) => h('option', { value: i, selected: i === current.key }, n)),
    );
    const scaleSelect = h(
      'select',
      {
        className: 'select',
        'aria-label': own ? 'Gamme de la piste' : 'Gamme du morceau',
        onchange: () => set({ key: current.key, scale: scaleSelect.value }),
      },
      Object.entries(SCALES).map(([id, sc]) => h('option', { value: id, selected: id === current.scale }, sc.label)),
    );
    const checkbox = h('input', {
      type: 'checkbox',
      checked: !!own,
      onchange: () => {
        this.#record(checkbox.checked ? 'Tonalité propre à la piste' : 'Suivre la tonalité du morceau', () =>
          this.hub.setTrackTonality(this.trackId, checkbox.checked ? { ...this.hub.tonality } : null),
        );
        this.render();
      },
    });
    const song = this.hub.tonality;
    return h(
      'div',
      { className: `tonality-block${own ? ' own' : ''}` },
      h('span', { className: 'param-label' }, own ? 'Tonalité de la piste' : 'Tonalité du morceau'),
      h('div', { className: 'tonality' }, keySelect, scaleSelect),
      h('label', { className: 'check-row' }, checkbox, h('span', {}, 'Tonalité propre à cette piste')),
      h(
        'p',
        { className: 'fx-caption' },
        own
          ? `Cette piste se cale sur sa propre gamme. Le morceau reste en ${NOTE_NAMES[song.key]} ${SCALES[song.scale].label.toLowerCase()}.`
          : 'Commune à toutes les pistes qui suivent le morceau (correction, harmonies, vocodeur, bourdon).',
      ),
    );
  }

  /** Harmonies : interrupteur et niveau global (le détail des voix est plus bas). */
  #harmonyQuick(harmony) {
    const n = harmony.voices.length;
    const toggle = toggleSwitch({
      checked: harmony.enabled && n > 0,
      label: 'Activer les harmonies',
      onChange: (v) =>
        this.#edit(
          (s) => {
            s.harmony.enabled = v;
            // Première activation : une voix à la tierce, pour entendre quelque chose.
            if (v && !s.harmony.voices.length)
              s.harmony.voices.push({
                interval: s.harmony.mode === 'diatonic' ? 2 : 4,
                level: -6,
                pan: -40,
                detune: 0,
                delay: 0,
              });
          },
          { structural: true, label: v ? 'Activer les harmonies' : 'Désactiver les harmonies' },
        ),
    });
    return h(
      'div',
      { className: `harmony-quick${harmony.enabled && n ? '' : ' off'}` },
      h(
        'div',
        { className: 'harmony-quick-head' },
        h('span', { className: 'param-label' }, 'Harmonies'),
        h('span', { className: 'harmony-count' }, n ? `${n} voix · détail plus bas` : 'aucune voix'),
        toggle,
      ),
      wide(
        paramRow(HARMONY_MASTER, harmony.level, (v) =>
          this.#edit((s) => (s.harmony.level = v), { label: 'Niveau des harmonies', key: 'harmony.level' }),
        ),
      ),
    );
  }

  /**
   * Affichage de la note chantée et de la note visée, autour de la tête de
   * lecture (appelé à chaque image tant que le panneau est ouvert).
   */
  tick() {
    const canvas = this.pitchView;
    if (!this.isOpen || !canvas?.isConnected) return;
    const track = this.engine.getTrack(this.trackId);
    const curves = this.state?.curves;
    const position = this.engine.position;
    const key = `${position.toFixed(3)}|${curves ? curves.inMidi.length : 0}|${this.state?.signature}|${canvas.clientWidth}`;
    if (key === this.lastPitchKey) return;
    this.lastPitchKey = key;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(hgt * dpr)) canvas.height = Math.round(hgt * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);

    if (!track || !curves) {
      this.pitchReadout.replaceChildren(
        h(
          'span',
          { className: 'pitch-hint' },
          this.settings?.pitch.correct
            ? 'Calcul en cours… la note chantée et la note visée s’afficheront ici.'
            : 'Active la correction pour voir la note chantée et la note visée.',
        ),
      );
      return;
    }

    // Trame d'analyse correspondant à un instant de la timeline (à travers les clips).
    const sr = track.sampleRate;
    const frameAt = (t) => {
      for (const c of track.clips) {
        if (t >= c.start && t < clipEnd(c, sr)) return Math.floor((c.offset + (t - c.start) * sr) / curves.hop);
      }
      return -1;
    };
    const valueAt = (arr, f) => (f >= 0 && f < arr.length ? arr[f] : NaN);

    // Lecture instantanée.
    const f = frameAt(position);
    const sung = valueAt(curves.inMidi, f);
    const target = valueAt(curves.noteMidi, f);
    if (Number.isNaN(sung)) {
      this.pitchReadout.replaceChildren(
        h('span', { className: 'pitch-hint' }, 'Pas de note chantée à la tête de lecture.'),
      );
    } else {
      const cents = Math.round((sung - target) * 100);
      const centsText = `${cents > 0 ? '+' : cents < 0 ? '−' : '±'}${Math.abs(cents)} ct`;
      this.pitchReadout.replaceChildren(
        h('span', { className: 'pitch-label' }, 'Chantée'),
        h('b', { className: 'pitch-sung' }, noteName(Math.round(sung))),
        h('span', { className: `pitch-cents${Math.abs(cents) > 25 ? ' off' : ''}` }, centsText),
        h('span', { className: 'pitch-arrow' }, '→'),
        h('span', { className: 'pitch-label' }, 'Visée'),
        h('b', { className: 'pitch-target' }, noteName(target)),
      );
    }

    // Courbes sur ±2 s : gamme en fond, voix chantée (gris), voix corrigée (accent).
    const t0 = position - PITCH_VIEW_SECONDS / 2;
    const samples = [];
    let lo = Infinity;
    let hi = -Infinity;
    for (let x = 0; x < w; x += 2) {
      const fr = frameAt(t0 + (x / w) * PITCH_VIEW_SECONDS);
      const a = valueAt(curves.inMidi, fr);
      const b = valueAt(curves.outMidi, fr);
      samples.push([x, a, b]);
      if (!Number.isNaN(a)) {
        lo = Math.min(lo, a, b);
        hi = Math.max(hi, a, b);
      }
    }
    if (lo === Infinity) {
      lo = 57;
      hi = 69;
    }
    const mid = (lo + hi) / 2;
    const span = Math.max(7, hi - lo + 3);
    lo = mid - span / 2;
    hi = mid + span / 2;
    const y = (m) => hgt - ((m - lo) / (hi - lo)) * hgt;
    const { key: tk, scale } = this.hub.trackTonality(this.trackId);
    g.font = '500 9px "JetBrains Mono", monospace';
    g.textBaseline = 'middle';
    let lastLabel = Infinity;
    for (let m = Math.ceil(lo); m <= Math.floor(hi); m++) {
      if (!inScale(m, tk, scale)) continue;
      g.fillStyle = m % 12 === tk ? 'rgb(215 255 79 / 16%)' : 'rgb(255 255 255 / 6%)';
      g.fillRect(0, Math.round(y(m)), w, 1);
      // Nom de la note, sauf s'il chevaucherait le précédent (demi-ton voisin).
      if (lastLabel - y(m) >= 11) {
        g.fillStyle = 'rgb(255 255 255 / 30%)';
        g.fillText(noteName(m), 4, y(m) - 6);
        lastLabel = y(m);
      }
    }
    const line = (index, color, width) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      let pen = false;
      for (const sample of samples) {
        const m = sample[index];
        if (Number.isNaN(m)) {
          pen = false;
          continue;
        }
        if (pen) g.lineTo(sample[0], y(m));
        else g.moveTo(sample[0], y(m));
        pen = true;
      }
      g.stroke();
    };
    line(1, 'rgb(234 237 242 / 60%)', 1.5);
    if (this.settings.pitch.correct) line(2, '#d7ff4f', 2);
    g.fillStyle = 'rgb(215 255 79 / 70%)';
    g.fillRect(Math.round(w / 2), 0, 1, hgt);
  }

  #timbreSection() {
    const { pitch, voice } = this.settings;
    return this.#section(
      'timbre',
      'Transposition et timbre',
      {
        caption:
          'PSOLA : la hauteur change sans changer la durée ; les formants règlent le timbre (grave/rond ↔ aigu/fin).',
      },
      paramRow(SHIFT, pitch.shift, (v) => this.#edit((s) => (s.pitch.shift = v))),
      paramRow(FORMANT, pitch.formant, (v) => this.#edit((s) => (s.pitch.formant = v))),
      paramRow(VOICE_LEVEL, voice.level, (v) => this.#edit((s) => (s.voice.level = v))),
    );
  }

  #harmonySection() {
    const { harmony } = this.settings;
    const intervals = harmony.mode === 'diatonic' ? DIATONIC_INTERVALS : CHROMATIC_INTERVALS;
    const mode = h(
      'div',
      { className: 'segmented', role: 'radiogroup', 'aria-label': 'Mode des intervalles' },
      [
        ['diatonic', 'Dans la gamme'],
        ['chromatic', 'Demi-tons fixes'],
      ].map(([id, label]) =>
        h(
          'button',
          {
            role: 'radio',
            'aria-checked': String(harmony.mode === id),
            onclick: () => {
              if (harmony.mode === id) return;
              this.#edit(
                (s) => {
                  s.harmony.mode = id;
                  for (const v of s.harmony.voices)
                    v.interval = id === 'chromatic' ? degreesToSemitones(v.interval) : semitonesToDegrees(v.interval);
                },
                { structural: true },
              );
            },
          },
          label,
        ),
      ),
    );

    const voices = harmony.voices.map((v, index) => {
      const select = h(
        'select',
        {
          className: 'select',
          'aria-label': `Intervalle de la voix ${index + 1}`,
          onchange: () => this.#edit((s) => (s.harmony.voices[index].interval = Number(select.value))),
        },
        intervals.map(([value, label]) => h('option', { value, selected: value === v.interval }, label)),
      );
      return h(
        'div',
        { className: 'voice-card' },
        h(
          'div',
          { className: 'voice-head' },
          h('span', { className: 'voice-index' }, `Voix ${index + 1}`),
          select,
          h(
            'button',
            {
              className: 'icon-btn',
              title: 'Retirer cette voix',
              'aria-label': `Retirer la voix ${index + 1}`,
              onclick: () => this.#edit((s) => s.harmony.voices.splice(index, 1), { structural: true }),
            },
            svg(icons.close),
          ),
        ),
        ...Object.entries(HARMONY_ROW_PARAMS).map(([key, p]) =>
          paramRow(p, v[key], (val) => this.#edit((s) => (s.harmony.voices[index][key] = val))),
        ),
      );
    });

    const add = h(
      'button',
      {
        className: 'btn btn-small btn-ghost add-btn',
        disabled: harmony.voices.length >= MAX_HARMONY_VOICES,
        onclick: () =>
          this.#edit(
            (s) => {
              const used = s.harmony.voices.length;
              const presetsDiatonic = [2, 4, -3, 7];
              const presetsChromatic = [4, 7, -5, 12];
              s.harmony.enabled = true;
              s.harmony.voices.push({
                interval: (s.harmony.mode === 'diatonic' ? presetsDiatonic : presetsChromatic)[used],
                level: -6,
                pan: [-50, 50, -25, 25][used],
                detune: 0,
                delay: 0,
              });
            },
            { structural: true },
          ),
      },
      svg(icons.plus),
      harmony.voices.length >= MAX_HARMONY_VOICES ? `${MAX_HARMONY_VOICES} voix maximum` : 'Ajouter une voix',
    );

    return this.#section(
      'harmony',
      'Harmonies',
      {
        caption: 'Une resynthèse PSOLA par voix, qui suit la mélodie corrigée et se tait sur les consonnes.',
        enabled: harmony.enabled,
        onToggle: (v) => this.#edit((s) => (s.harmony.enabled = v), { structural: true }),
      },
      mode,
      ...voices,
      add,
    );
  }

  #paramsFor(sectionKey, params) {
    return params
      .filter((p) => p.key !== 'enabled')
      .map((p) => paramRow(p, this.settings[sectionKey][p.key], (v) => this.#edit((s) => (s[sectionKey][p.key] = v))));
  }

  #vocoderSection() {
    const { vocoder } = this.settings;
    return this.#section(
      'vocoder',
      'Vocodeur',
      {
        caption: 'Analyse FFT par bandes de la voix appliquée à un accord de dents de scie qui suit la mélodie.',
        enabled: vocoder.enabled,
        onToggle: (v) => this.#edit((s) => (s.vocoder.enabled = v), { structural: true }),
      },
      ...this.#paramsFor('vocoder', VOCODER_PARAMS),
    );
  }

  #droneSection() {
    const { drone } = this.settings;
    return this.#section(
      'drone',
      'Bourdon',
      {
        caption: 'Accord tenu sur la tonique (dents de scie + sous-octave filtrées), qui s’ouvre quand la voix chante.',
        enabled: drone.enabled,
        onToggle: (v) => this.#edit((s) => (s.drone.enabled = v), { structural: true }),
      },
      ...this.#paramsFor('drone', DRONE_PARAMS),
    );
  }

  // ------------------------------------------------------------------ chaîne temps réel

  #chainSection() {
    const { chain } = this.settings;
    const modules = chain.map((m, index) => {
      const def = FX_CATALOG[m.type];
      const move = (delta) =>
        this.#edit(
          (s) => {
            const [item] = s.chain.splice(index, 1);
            s.chain.splice(index + delta, 0, item);
          },
          { structural: true },
        );
      return h(
        'div',
        { className: `module-card${m.enabled ? '' : ' disabled'}` },
        h(
          'div',
          { className: 'module-head' },
          toggleSwitch({
            checked: m.enabled,
            label: `Activer : ${def.label}`,
            onChange: (v) => this.#edit((s) => (s.chain[index].enabled = v), { structural: true }),
          }),
          h('span', { className: 'module-title', title: def.description }, def.label),
          h(
            'div',
            { className: 'module-tools' },
            h(
              'button',
              {
                className: 'icon-btn',
                title: 'Monter',
                'aria-label': `Monter ${def.label}`,
                disabled: index === 0,
                onclick: () => move(-1),
              },
              svg(icons.chevronUp),
            ),
            h(
              'button',
              {
                className: 'icon-btn',
                title: 'Descendre',
                'aria-label': `Descendre ${def.label}`,
                disabled: index === chain.length - 1,
                onclick: () => move(1),
              },
              svg(icons.chevronDown),
            ),
            h(
              'button',
              {
                className: 'icon-btn',
                title: 'Retirer',
                'aria-label': `Retirer ${def.label}`,
                onclick: () => this.#edit((s) => s.chain.splice(index, 1), { structural: true }),
              },
              svg(icons.close),
            ),
          ),
        ),
        h('p', { className: 'module-bricks' }, def.bricks),
        ...def.params.map((p) =>
          paramRow(p, m.params[p.key], (v) => this.#edit((s) => (s.chain[index].params[p.key] = v))),
        ),
      );
    });

    const add = h(
      'select',
      {
        className: 'select add-module',
        'aria-label': 'Ajouter un effet',
        onchange: () => {
          const type = add.value;
          add.value = '';
          if (type) this.#edit((s) => s.chain.push(createModule(type)), { structural: true });
        },
      },
      h('option', { value: '', selected: true }, '+ Ajouter un effet…'),
      FX_TYPES.map((t) => h('option', { value: t }, FX_CATALOG[t].label)),
    );

    return this.#section(
      'chain',
      'Chaîne d’effets',
      { caption: 'Nœuds Web Audio en temps réel, appliqués dans l’ordre ci-dessous.' },
      chain.length
        ? h('div', { className: 'module-list' }, modules)
        : h('p', { className: 'fx-caption' }, 'Aucun effet pour le moment.'),
      add,
    );
  }
}
