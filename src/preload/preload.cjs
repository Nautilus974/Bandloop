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
  presets: {
    /** @returns {Promise<object[]>} presets utilisateur enregistrés */
    load: () => ipcRenderer.invoke('presets:load'),
    /** @param {object[]} presets */
    save: (presets) => ipcRenderer.invoke('presets:save', presets),
  },
});
