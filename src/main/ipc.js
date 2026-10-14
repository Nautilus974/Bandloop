// Canaux IPC exposés au renderer (via le preload).
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'webm'];

const presetsFile = () => path.join(app.getPath('userData'), 'presets.json');

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

  // Presets utilisateur : un fichier JSON dans le dossier de données de l'app
  // (macOS : ~/Library/Application Support/Bandloop, Windows : %APPDATA%\Bandloop).
  ipcMain.handle('presets:load', async () => {
    try {
      const data = JSON.parse(await fs.readFile(presetsFile(), 'utf8'));
      return Array.isArray(data.presets) ? data.presets : [];
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('Lecture des presets impossible :', err);
      return [];
    }
  });

  ipcMain.handle('presets:save', async (_event, presets) => {
    if (!Array.isArray(presets)) throw new Error('Format de presets invalide');
    const file = presetsFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Écriture atomique : fichier temporaire puis renommage.
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: 1, presets }, null, 2), 'utf8');
    await fs.rename(tmp, file);
  });
}
