// Bibliothèque de presets : presets fournis (lecture seule) + presets utilisateur
// (création, modification, suppression), persistés via un adaptateur de stockage.
import { normalizeSettings } from '../vocal/settings.js';
import { BUILTIN_PRESETS, CATEGORIES } from './builtin.js';

export const USER_CATEGORY = { id: 'mine', name: 'Mes presets' };
const MAX_NAME_LENGTH = 40;

/** Réglages tels qu'enregistrés : sans les identifiants internes des modules. */
function serializeSettings(settings) {
  const s = normalizeSettings(settings);
  return { ...s, chain: s.chain.map(({ type, enabled, params }) => ({ type, enabled, params })) };
}

function cleanName(name) {
  const trimmed = String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!trimmed) throw new Error('Le nom du preset est vide.');
  return trimmed.slice(0, MAX_NAME_LENGTH);
}

export class PresetStore extends EventTarget {
  /** @param {{ load: () => Promise<object[]>, save: (presets: object[]) => Promise<void> }} storage */
  constructor(storage) {
    super();
    this.storage = storage;
    this.user = [];
  }

  async load() {
    let raw = [];
    try {
      raw = await this.storage.load();
    } catch (err) {
      console.error('Presets utilisateur illisibles :', err);
    }
    // On ne garde que des entrées valides, et on re-valide leurs réglages.
    this.user = (Array.isArray(raw) ? raw : [])
      .filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && p.name.trim())
      .map((p) => ({
        id: p.id,
        name: p.name.trim().slice(0, MAX_NAME_LENGTH),
        category: USER_CATEGORY.id,
        description: typeof p.description === 'string' ? p.description : '',
        settings: serializeSettings(p.settings),
        builtin: false,
      }));
    this.#emit();
  }

  /** Catégories avec leurs presets (la catégorie utilisateur en dernier, toujours présente). */
  get categories() {
    return [
      ...CATEGORIES.map((c) => ({
        ...c,
        presets: BUILTIN_PRESETS.filter((p) => p.category === c.id).map(withBuiltin),
      })),
      { ...USER_CATEGORY, presets: [...this.user] },
    ];
  }

  get(id) {
    const builtin = BUILTIN_PRESETS.find((p) => p.id === id);
    return builtin ? withBuiltin(builtin) : (this.user.find((p) => p.id === id) ?? null);
  }

  isUser(id) {
    return this.user.some((p) => p.id === id);
  }

  /** Réglages complets et validés d'un preset, prêts à être appliqués. */
  settingsOf(id) {
    const preset = this.get(id);
    return preset ? normalizeSettings(preset.settings) : null;
  }

  async create(name, settings, description = '') {
    const preset = {
      id: `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: this.#uniqueName(cleanName(name)),
      category: USER_CATEGORY.id,
      description,
      settings: serializeSettings(settings),
      builtin: false,
    };
    this.user.push(preset);
    await this.#persist();
    return preset;
  }

  /** Modifie un preset utilisateur (les presets fournis ne sont pas modifiables). */
  async update(id, { name, settings, description } = {}) {
    const preset = this.user.find((p) => p.id === id);
    if (!preset) throw new Error('Seuls vos propres presets peuvent être modifiés.');
    if (name !== undefined) preset.name = this.#uniqueName(cleanName(name), id);
    if (settings !== undefined) preset.settings = serializeSettings(settings);
    if (description !== undefined) preset.description = description;
    await this.#persist();
    return preset;
  }

  async remove(id) {
    const before = this.user.length;
    this.user = this.user.filter((p) => p.id !== id);
    if (this.user.length === before) throw new Error('Seuls vos propres presets peuvent être supprimés.');
    await this.#persist();
  }

  /** « Studio » existe déjà -> « Studio 2 ». */
  #uniqueName(name, exceptId = null) {
    const taken = new Set(this.user.filter((p) => p.id !== exceptId).map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    let i = 2;
    while (taken.has(`${name} ${i}`.toLowerCase())) i++;
    return `${name} ${i}`;
  }

  async #persist() {
    await this.storage.save(
      this.user.map(({ id, name, description, settings }) => ({ id, name, description, settings })),
    );
    this.#emit();
  }

  #emit() {
    this.dispatchEvent(new Event('change'));
  }
}

function withBuiltin(p) {
  return { ...p, builtin: true };
}
