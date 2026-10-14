// Panneau latéral d'effets vocaux de la piste sélectionnée :
// presets par catégories, tonalité du morceau, étage de hauteur (correction,
// transposition, harmonies, vocodeur, bourdon) et chaîne d'effets temps réel.
import { formatPan } from '../audio/mixing.js';
import { USER_CATEGORY } from '../presets/PresetStore.js';
import { FX_CATALOG, FX_TYPES } from '../vocal/fx/catalog.js';
import {
  createModule,
  defaultSettings,
  DRONE_PARAMS,
  HARMONY_VOICE_PARAMS,
  isNeutral,
  MAX_HARMONY_VOICES,
  PITCH_PARAMS,
  sameSettings,
  VOCODER_PARAMS,
  VOICE_PARAMS,
} from '../vocal/settings.js';
import { DIATONIC_INTERVALS, NOTE_NAMES, SCALES } from '../vocal/theory.js';
import { paramRow, toggleSwitch } from './controls.js';
import { confirmDialog, promptDialog } from './Dialog.js';
import { h, svg } from './dom.js';
import { icons } from './icons.js';

const param = (list, key, overrides = {}) => ({ ...list.find((p) => p.key === key), ...overrides });

// Présentation spécifique de certains paramètres.
const SPEED = param(PITCH_PARAMS, 'speed', { format: (v) => (v === 0 ? 'Instantané' : `${v} ms`) });
const STRENGTH = param(PITCH_PARAMS, 'strength');
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
    this.collapsed = new Set(['vocoder', 'drone']);

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

  /** Applique une modification aux réglages de la piste. `structural` : redessiner le panneau. */
  #edit(mutate, { structural = false } = {}) {
    const next = structuredClone(this.settings);
    mutate(next);
    this.hub.setSettings(this.trackId, next);
    if (structural) this.render();
    else this.#renderPresetBar();
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
              onclick: () => {
                this.hub.setBypass(this.trackId, !this.state.bypass);
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
      'div',
      { className: `fx-body${this.state.bypass ? ' bypassed' : ''}` },
      this.#presetSection(),
      this.#tonalitySection(),
      this.#pitchSection(),
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
      { className: `fx-section${collapsed ? ' collapsed' : ''}${onToggle && !enabled ? ' disabled' : ''}` },
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
        modified ? button('Rétablir', 'reset', () => this.#applyPreset(presetId)) : null,
        isUser ? button('Renommer', null, () => this.#rename()) : null,
        isUser ? button('Supprimer', 'trash', () => this.#deletePreset(), 'btn-danger-ghost') : null,
        preset || !isNeutral(this.settings) ? button('Tout retirer', null, () => this.#clear()) : null,
      ),
    );
  }

  #applyPreset(id) {
    const settings = this.presets.settingsOf(id);
    if (!settings) return;
    this.hub.setSettings(this.trackId, settings, { presetId: id });
    this.ui.notify(`Preset « ${this.presets.get(id).name} » appliqué.`);
    this.render();
  }

  #clear() {
    this.hub.setSettings(this.trackId, defaultSettings(), { presetId: null });
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
      this.hub.setSettings(this.trackId, this.settings, { presetId: created.id });
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

  #tonalitySection() {
    const { key, scale } = this.hub.tonality;
    const keySelect = h(
      'select',
      {
        className: 'select',
        'aria-label': 'Tonique',
        onchange: () => this.hub.setTonality({ key: Number(keySelect.value), scale }),
      },
      NOTE_NAMES.map((n, i) => h('option', { value: i, selected: i === key }, n)),
    );
    const scaleSelect = h(
      'select',
      {
        className: 'select',
        'aria-label': 'Gamme',
        onchange: () => this.hub.setTonality({ key, scale: scaleSelect.value }),
      },
      Object.entries(SCALES).map(([id, s]) => h('option', { value: id, selected: id === scale }, s.label)),
    );
    return this.#section(
      'tonality',
      'Tonalité du morceau',
      { caption: 'Commune à toutes les pistes : la correction et les harmonies se calent sur cette gamme.' },
      h('div', { className: 'tonality' }, keySelect, scaleSelect),
    );
  }

  #pitchSection() {
    const { pitch } = this.settings;
    const speedRow = paramRow(SPEED, pitch.speed, (v) => this.#edit((s) => (s.pitch.speed = v)));
    speedRow.append(h('div', { className: 'param-scale' }, h('span', {}, 'Robot'), h('span', {}, 'Naturel')));
    return this.#section(
      'pitch',
      'Correction de hauteur',
      {
        caption: 'Détection YIN puis resynthèse TD-PSOLA, calculées en arrière-plan (Web Worker).',
        enabled: pitch.correct,
        onToggle: (v) => this.#edit((s) => (s.pitch.correct = v), { structural: true }),
      },
      speedRow,
      paramRow(STRENGTH, pitch.strength, (v) => this.#edit((s) => (s.pitch.strength = v))),
    );
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
