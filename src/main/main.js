// Processus principal : fenêtres, menus et accès au système de fichiers.
// Aucun traitement audio ici : tout le moteur vit dans le renderer (Web Audio).
import { app, BrowserWindow, dialog, ipcMain, net, protocol, session } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { allowPath, registerIpcHandlers } from './ipc.js';
import { buildMenu } from './menu.js';

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

// État du document par fenêtre : nom, modifications non enregistrées.
const documents = new WeakMap();
// Projet à ouvrir au démarrage (double-clic sur un fichier .bandloop).
let pendingOpen = process.argv.find((a) => a.toLowerCase().endsWith('.bandloop')) ?? null;

function openInWindow(win, file) {
  allowPath(file);
  win.webContents.send('menu', { command: 'open-path', path: file });
}

/**
 * Fermeture : s'il y a des modifications non enregistrées, on demande quoi faire.
 * « Enregistrer » délègue l'enregistrement au renderer, qui rappelle ensuite
 * window:close-now si tout s'est bien passé.
 */
function guardClose(win) {
  win.on('close', async (event) => {
    const doc = documents.get(win) ?? {};
    if (doc.forceClose || !doc.edited) return;
    event.preventDefault();
    if (doc.prompting) return;
    doc.prompting = true;
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Enregistrer', 'Ne pas enregistrer', 'Annuler'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      message: `Enregistrer les modifications de « ${doc.name ?? 'ce projet'} » ?`,
      detail: 'Si tu fermes sans enregistrer, les modifications seront perdues.',
    });
    doc.prompting = false;
    if (response === 0) win.webContents.send('menu', { command: 'save-then-close' });
    else if (response === 1) {
      doc.forceClose = true;
      win.close();
    }
  });
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
  documents.set(win, { edited: false, name: null });
  guardClose(win);
  win.webContents.on('did-finish-load', () => {
    if (pendingOpen) openInWindow(win, pendingOpen);
    pendingOpen = null;
  });
  win.loadURL('app://bandloop/index.html');
  return win;
}

function registerWindowHandlers() {
  // Titre « Nom * — Bandloop », point de modification et fichier associé (macOS).
  ipcMain.on('window:set-document', (event, { title, name, edited, path: file }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    Object.assign(documents.get(win) ?? {}, { name, edited: !!edited });
    if (typeof title === 'string') win.setTitle(title);
    if (process.platform === 'darwin') {
      win.setDocumentEdited(!!edited);
      win.setRepresentedFilename(typeof file === 'string' ? file : '');
    }
  });
  ipcMain.on('window:close-now', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    (documents.get(win) ?? {}).forceClose = true;
    win.close();
  });
}

// Une seule instance : un double-clic sur un projet l'ouvre dans la fenêtre existante.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const file = argv.find((a) => a.toLowerCase().endsWith('.bandloop'));
    if (file) openInWindow(win, file);
  });
}

// macOS : fichier ouvert depuis le Finder.
app.on('open-file', (event, file) => {
  event.preventDefault();
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.webContents.isLoading()) openInWindow(win, file);
  else pendingOpen = file;
});

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
  registerWindowHandlers();
  buildMenu();
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
