// Pont sécurisé entre le renderer (sans accès Node) et le processus principal.
// Doit rester en CommonJS : les preloads sandboxés ne supportent pas les modules ES.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bandloop', {
  platform: process.platform,
  /** @returns {Promise<Array<{name: string, data: Uint8Array}>>} */
  openAudioFiles: () => ipcRenderer.invoke('audio:open-files'),
  mic: {
    /** @returns {Promise<string>} état de l'autorisation système du micro */
    requestAccess: () => ipcRenderer.invoke('mic:request-access'),
    /** Ouvre la page de confidentialité du micro dans les réglages du système. */
    openSettings: () => ipcRenderer.invoke('mic:open-settings'),
  },
  project: {
    /** @returns {Promise<null | {path: string, bytes: Uint8Array} | {error: {code: string, message: string}}>} */
    openDialog: () => ipcRenderer.invoke('project:open-dialog'),
    /** Lit un projet transmis par le système (double-clic). */
    read: (path) => ipcRenderer.invoke('project:read', path),
  },
  files: {
    /** @param {{ kind: 'project'|'wav'|'mp3', suggestedName: string }} opts @returns {Promise<string|null>} */
    chooseSavePath: (opts) => ipcRenderer.invoke('file:choose-save-path', opts),
    /** Écriture atomique. @returns {Promise<{ok: true, path: string, size: number} | {error: {code: string, message: string}}>} */
    write: (path, bytes, action) => ipcRenderer.invoke('file:write', { path, bytes, action }),
    showInFolder: (path) => ipcRenderer.invoke('file:show-in-folder', path),
  },
  window: {
    setDocument: (doc) => ipcRenderer.send('window:set-document', doc),
    closeNow: () => ipcRenderer.send('window:close-now'),
  },
  /** Commandes du menu de l'application (nouveau, ouvrir, enregistrer…). */
  onMenu: (callback) => ipcRenderer.on('menu', (_event, payload) => callback(payload)),
  presets: {
    /** @returns {Promise<object[]>} presets utilisateur enregistrés */
    load: () => ipcRenderer.invoke('presets:load'),
    /** @param {object[]} presets */
    save: (presets) => ipcRenderer.invoke('presets:save', presets),
  },
});
