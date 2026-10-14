// Processus principal : fenêtres, menus et accès au système de fichiers.
// Aucun traitement audio ici : tout le moteur vit dans le renderer (Web Audio).
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpcHandlers } from './ipc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 500,
    backgroundColor: '#16181d',
    title: 'Bandloop',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Un fichier lâché hors de la zone gérée ne doit pas remplacer l'application.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();
  // macOS : recréer une fenêtre quand on clique sur l'icône du Dock.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Windows/Linux : quitter quand toutes les fenêtres sont fermées.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
