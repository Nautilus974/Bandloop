// Boîtes de dialogue modales (<dialog>) : saisie d'un nom, confirmation.
// window.prompt() n'est pas disponible dans Electron.
import { h } from './dom.js';

function modal(content, onSubmit) {
  return new Promise((resolve) => {
    const form = h('form', { className: 'dialog-form', method: 'dialog' }, ...content.body);
    const dialog = h('dialog', { className: 'dialog' }, h('h2', { className: 'dialog-title' }, content.title), form);
    form.append(
      h(
        'div',
        { className: 'dialog-actions' },
        h('button', { type: 'button', className: 'btn btn-ghost', onclick: () => dialog.close('cancel') }, 'Annuler'),
        h(
          'button',
          { type: 'submit', value: 'ok', className: `btn ${content.danger ? 'btn-danger' : 'btn-primary'}` },
          content.confirm,
        ),
      ),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const result = onSubmit();
      if (result === undefined) return; // saisie invalide : on reste ouvert
      dialog.close('ok');
      resolve(result);
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (dialog.returnValue !== 'ok') resolve(null);
    });
    document.body.append(dialog);
    dialog.showModal();
    content.focus?.focus();
    content.focus?.select?.();
  });
}

/** @returns {Promise<string|null>} le texte saisi, ou null si annulé */
export function promptDialog({ title, label, value = '', confirm = 'Enregistrer', hint = '' }) {
  const input = h('input', {
    className: 'text-input',
    type: 'text',
    value,
    maxLength: 40,
    required: true,
    spellcheck: false,
  });
  const error = h('p', { className: 'dialog-error', role: 'alert' });
  return modal(
    {
      title,
      confirm,
      focus: input,
      body: [
        h('label', { className: 'dialog-label' }, label, input),
        hint ? h('p', { className: 'dialog-hint' }, hint) : null,
        error,
      ],
    },
    () => {
      const text = input.value.trim();
      if (!text) {
        error.textContent = 'Donne un nom au preset.';
        return undefined;
      }
      return text;
    },
  );
}

/** @returns {Promise<boolean>} */
export async function confirmDialog({ title, message, confirm = 'Confirmer', danger = false }) {
  const result = await modal(
    { title, confirm, danger, body: [h('p', { className: 'dialog-message' }, message)] },
    () => true,
  );
  return result === true;
}

/**
 * Modifications non enregistrées : « Enregistrer », « Ne pas enregistrer », « Annuler ».
 * @returns {Promise<'save'|'discard'|'cancel'>}
 */
export function unsavedDialog(projectName) {
  return new Promise((resolve) => {
    const dialog = h('dialog', { className: 'dialog' });
    const choose = (value) => {
      dialog.returnValue = value;
      dialog.close();
    };
    dialog.append(
      h('h2', { className: 'dialog-title' }, `Enregistrer les modifications de « ${projectName} » ?`),
      h('p', { className: 'dialog-message' }, 'Si tu continues sans enregistrer, les modifications seront perdues.'),
      h(
        'div',
        { className: 'dialog-actions' },
        h('button', { type: 'button', className: 'btn btn-ghost', onclick: () => choose('cancel') }, 'Annuler'),
        h('button', { type: 'button', className: 'btn', onclick: () => choose('discard') }, 'Ne pas enregistrer'),
        h('button', { type: 'button', className: 'btn btn-primary', onclick: () => choose('save') }, 'Enregistrer'),
      ),
    );
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(['save', 'discard'].includes(dialog.returnValue) ? dialog.returnValue : 'cancel');
    });
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('.btn-primary').focus();
  });
}

/** Message d'erreur (ou d'information) avec un seul bouton. */
export function alertDialog(title, text) {
  return new Promise((resolve) => {
    const dialog = h('dialog', { className: 'dialog', role: 'alertdialog' });
    dialog.append(
      h('h2', { className: 'dialog-title' }, title),
      ...String(text)
        .split('\n')
        .map((line) => h('p', { className: 'dialog-message' }, line)),
      h(
        'div',
        { className: 'dialog-actions' },
        h('button', { type: 'button', className: 'btn btn-primary', onclick: () => dialog.close() }, 'OK'),
      ),
    );
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve();
    });
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('.btn-primary').focus();
  });
}
