// Processus principal : fenêtres, menus et accès au système de fichiers.
// Aucun traitement audio ici : tout le moteur vit dans le renderer (Web Audio).
import { app, BrowserWindow, net, protocol } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerIpcHandlers } from './ipc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = path.join(__dirname, '../renderer');

// Protocole app:// : donne au renderer une vraie origine (au lieu de file://),
// nécessaire aux modules ES dans les Web Workers et AudioWorklets.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/** Sert les fichiers du renderer, sans jamais sortir de son dossier. */
function serveRenderer(request) {
  const { pathname } = new URL(request.url);
  const file = path.normalize(path.join(RENDERER_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response('Introuvable', { status: 404 });
  return net.fetch(pathToFileURL(file).toString());
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 880,
    minWidth: 1100,
    minHeight: 600,
    backgroundColor: '#0a0c0f',
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
  win.loadURL('app://bandloop/index.html');
}

app.whenReady().then(() => {
  protocol.handle('app', serveRenderer);
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
