// Canaux IPC exposés au renderer (via le preload).
import { BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'webm'];

export function registerIpcHandlers() {
  // Ouvre un sélecteur de fichiers et renvoie le contenu brut des fichiers choisis.
  // Le décodage se fait dans le renderer avec decodeAudioData.
  ipcMain.handle('audio:open-files', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Importer des pistes audio',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }],
    });
    if (canceled) return [];
    return Promise.all(
      filePaths.map(async (filePath) => ({
        name: path.basename(filePath),
        data: await fs.readFile(filePath), // arrive comme Uint8Array côté renderer
      })),
    );
  });
}
