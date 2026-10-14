// Canaux IPC exposés au renderer (via le preload).
import { app, BrowserWindow, dialog, ipcMain, shell, systemPreferences } from 'electron';
import { describeFsError } from './fs-errors.js';
import fs from 'node:fs/promises';
import path from 'node:path';

export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'webm'];

// Pages de réglages de confidentialité du micro (liste fermée : rien d'autre ne peut être ouvert).
const MIC_SETTINGS_URLS = {
  darwin: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  win32: 'ms-settings:privacy-microphone',
};

const PROJECT_FILTER = { name: 'Projet Bandloop', extensions: ['bandloop'] };
const SAVE_FILTERS = {
  project: [PROJECT_FILTER],
  wav: [{ name: 'Audio WAV', extensions: ['wav'] }],
  mp3: [{ name: 'Audio MP3', extensions: ['mp3'] }],
};
const EXTENSIONS = { project: 'bandloop', wav: 'wav', mp3: 'mp3' };

// Le renderer ne peut écrire, lire ou montrer QUE des chemins choisis par
// l'utilisateur dans une boîte de dialogue (ou ouverts depuis le système).
const allowedPaths = new Set();
export const allowPath = (p) => allowedPaths.add(path.resolve(p));
const isAllowed = (p) => typeof p === 'string' && allowedPaths.has(path.resolve(p));

/** Nom de fichier sûr (sans caractères interdits sous Windows/macOS). */
function safeFileName(name) {
  return (
    String(name ?? 'Sans titre')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
      .slice(0, 120) || 'Sans titre'
  );
}

/** Écriture atomique : fichier temporaire puis renommage (jamais de projet à moitié écrit). */
async function writeAtomic(file, bytes) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function readProject(file) {
  try {
    const stat = await fs.stat(file);
    if (stat.size > 4 * 1024 ** 3)
      return {
        error: { code: 'EFBIG', message: 'Ce fichier est trop volumineux pour un projet Bandloop (plus de 4 Gio).' },
      };
    return { path: file, bytes: await fs.readFile(file) };
  } catch (err) {
    return { error: describeFsError(err, 'open') };
  }
}

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

  // ---- Projets et export ----

  ipcMain.handle('project:open-dialog', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Ouvrir un projet',
      properties: ['openFile'],
      filters: [PROJECT_FILTER],
    });
    if (canceled || !filePaths.length) return null;
    allowPath(filePaths[0]);
    return readProject(filePaths[0]);
  });

  // Ouverture d'un chemin transmis par le système (double-clic sur un .bandloop).
  ipcMain.handle('project:read', async (_event, file) => {
    if (!isAllowed(file)) return { error: { code: 'EPERM', message: 'Accès refusé à ce fichier.' } };
    return readProject(file);
  });

  ipcMain.handle('file:choose-save-path', async (event, { kind, suggestedName }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const ext = EXTENSIONS[kind];
    if (!ext) return null;
    const base = safeFileName(suggestedName).replace(new RegExp(`\\.${ext}$`, 'i'), '');
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: kind === 'project' ? 'Enregistrer le projet' : 'Exporter le mix',
      defaultPath: path.join(app.getPath('documents'), `${base}.${ext}`),
      filters: SAVE_FILTERS[kind],
    });
    if (canceled || !filePath) return null;
    const final = filePath.toLowerCase().endsWith(`.${ext}`) ? filePath : `${filePath}.${ext}`;
    allowPath(final);
    return final;
  });

  ipcMain.handle('file:write', async (_event, { path: file, bytes, action }) => {
    if (!isAllowed(file)) return { error: { code: 'EPERM', message: 'Emplacement non autorisé.' } };
    try {
      await writeAtomic(file, bytes);
      return { ok: true, path: file, size: bytes.byteLength };
    } catch (err) {
      return { error: describeFsError(err, action === 'export' ? 'export' : 'save') };
    }
  });

  ipcMain.handle('file:show-in-folder', (_event, file) => {
    if (isAllowed(file)) shell.showItemInFolder(file);
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
