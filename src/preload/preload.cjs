// Pont sécurisé entre le renderer (sans accès Node) et le processus principal.
// Doit rester en CommonJS : les preloads sandboxés ne supportent pas les modules ES.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bandloop', {
  platform: process.platform,
  /** @returns {Promise<Array<{name: string, data: Uint8Array}>>} */
  openAudioFiles: () => ipcRenderer.invoke('audio:open-files'),
});
