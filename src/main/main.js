// Processus principal : fenêtres, menus et accès au système de fichiers.
// Aucun traitement audio ici : tout le moteur vit dans le renderer (Web Audio).
import { app, BrowserWindow, net, protocol, session } from 'electron';
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

const APP_ORIGIN = 'app://bandloop';

/**
 * Autorisations Chromium : seul l'accès au micro (audio, pas la caméra) est
 * accordé, et seulement à l'interface de Bandloop. Tout le reste est refusé.
 */
function configurePermissions() {
  const isAudioOnly = (details) => {
    const types = details?.mediaTypes ?? [];
    return types.length > 0 && types.every((t) => t === 'audio');
  };
  const fromApp = (url) => typeof url === 'string' && url.startsWith(APP_ORIGIN);
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(permission === 'media' && isAudioOnly(details) && fromApp(details.requestingUrl ?? webContents.getURL()));
  });
  // Nécessaire pour que enumerateDevices() donne les noms des micros.
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission, origin) => permission === 'media' && fromApp(origin),
  );
}

app.whenReady().then(() => {
  protocol.handle('app', serveRenderer);
  configurePermissions();
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
