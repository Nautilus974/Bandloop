// Canaux IPC exposés au renderer (via le preload).
import { app, BrowserWindow, dialog, ipcMain, shell, systemPreferences } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'webm'];

// Pages de réglages de confidentialité du micro (liste fermée : rien d'autre ne peut être ouvert).
const MIC_SETTINGS_URLS = {
  darwin: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  win32: 'ms-settings:privacy-microphone',
};

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

  // Accès au micro au niveau du système d'exploitation.
  // macOS : demande l'autorisation (fenêtre système) la première fois.
  // Windows : indique si le réglage de confidentialité bloque les applications.
  // Renvoie 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'.
  ipcMain.handle('mic:request-access', async () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return 'unknown';
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (process.platform === 'darwin' && status === 'not-determined') {
      return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
    }
    return status;
  });

  ipcMain.handle('mic:open-settings', async () => {
    const url = MIC_SETTINGS_URLS[process.platform];
    if (url) await shell.openExternal(url);
    return !!url;
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
