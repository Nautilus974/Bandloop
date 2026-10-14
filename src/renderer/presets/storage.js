// Adaptateurs de stockage des presets utilisateur.

const LOCAL_KEY = 'bandloop.presets.v1';

/**
 * Electron : fichier presets.json dans le dossier de données de l'app (via IPC).
 * Navigateur : localStorage (repli, pratique pour développer sans Electron).
 */
export function createPresetStorage() {
  if (globalThis.window?.bandloop?.presets) {
    return { load: () => window.bandloop.presets.load(), save: (list) => window.bandloop.presets.save(list) };
  }
  return {
    async load() {
      try {
        return JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '[]');
      } catch {
        return [];
      }
    },
    async save(list) {
      try {
        localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
      } catch (err) {
        throw new Error(`Impossible d'enregistrer les presets : ${err.message}`);
      }
    },
  };
}

/** Stockage en mémoire (tests). */
export function memoryStorage(initial = []) {
  let data = structuredClone(initial);
  return {
    saves: 0,
    async load() {
      return structuredClone(data);
    },
    async save(list) {
      this.saves++;
      data = structuredClone(list);
    },
    get data() {
      return data;
    },
  };
}
