// Historique d'annulation (Ctrl/⌘+Z, Ctrl/⌘+Maj+Z) des opérations de montage.
//
// Chaque opération est enregistrée comme un couple d'instantanés « avant /
// après » de l'arrangement (ordre des pistes et clips de chaque piste). C'est
// léger (quelques nombres par clip, jamais d'audio) et robuste : annuler, c'est
// restaurer l'instantané « avant ».

export class EditHistory extends EventTarget {
  /**
   * @param {{ capture: () => object, restore: (snapshot: object) => void, limit?: number }} p
   */
  constructor({ capture, restore, limit = 100 }) {
    super();
    this.capture = capture;
    this.restoreFn = restore;
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  get undoLabel() {
    return this.undoStack.at(-1)?.label ?? null;
  }

  get redoLabel() {
    return this.redoStack.at(-1)?.label ?? null;
  }

  /**
   * Exécute une opération et l'enregistre si elle a changé quelque chose.
   * `before` : instantané pris plus tôt, pour un geste déjà commencé (glisser
   * un clip modifie l'ordre des pistes en direct, avant le lâcher).
   * @returns {*} la valeur renvoyée par `fn`
   */
  perform(label, fn, before = this.capture()) {
    const result = fn();
    const after = this.capture();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      this.undoStack.push({ label, before, after });
      if (this.undoStack.length > this.limit) this.undoStack.shift();
      this.redoStack = [];
      this.#emit();
    }
    return result;
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.restoreFn(entry.before);
    this.redoStack.push(entry);
    this.#emit();
    return entry.label;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.restoreFn(entry.after);
    this.undoStack.push(entry);
    this.#emit();
    return entry.label;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.#emit();
  }

  #emit() {
    this.dispatchEvent(new Event('change'));
  }
}
