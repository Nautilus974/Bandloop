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
