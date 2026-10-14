// Menu de l'application (barre de menus macOS, menu de fenêtre Windows/Linux).
// Les commandes sont transmises au renderer, qui les exécute.
import { app, BrowserWindow, Menu } from 'electron';

function send(command) {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  win?.webContents.send('menu', { command });
}

export function buildMenu() {
  const isMac = process.platform === 'darwin';
  const item = (id, label, accelerator) => ({ id, label, accelerator, click: () => send(id) });
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Fichier',
      submenu: [
        item('new', 'Nouveau projet', 'CmdOrCtrl+N'),
        item('open', 'Ouvrir…', 'CmdOrCtrl+O'),
        { type: 'separator' },
        item('save', 'Enregistrer', 'CmdOrCtrl+S'),
        item('save-as', 'Enregistrer sous…', 'CmdOrCtrl+Shift+S'),
        { type: 'separator' },
        item('export', 'Exporter le mix…', 'CmdOrCtrl+E'),
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit', label: 'Quitter' }]),
      ],
    },
    {
      label: 'Édition',
      submenu: [
        { role: 'cut', label: 'Couper' },
        { role: 'copy', label: 'Copier' },
        { role: 'paste', label: 'Coller' },
        { role: 'selectAll', label: 'Tout sélectionner' },
      ],
    },
    {
      label: 'Affichage',
      submenu: [
        { role: 'togglefullscreen', label: 'Plein écran' },
        ...(app.isPackaged
          ? []
          : [
              { type: 'separator' },
              { role: 'reload', label: 'Recharger' },
              { role: 'toggleDevTools', label: 'Outils de développement' },
            ]),
      ],
    },
    { role: 'windowMenu', label: 'Fenêtre' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
