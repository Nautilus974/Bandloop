# Architecture de Bandloop

## Vue d'ensemble

```
┌──────────────────────── Processus principal (Node) ─────────────────────────┐
│ src/main/main.js   fenêtre, protocole app://, sécurité                       │
│ src/main/ipc.js    dialogues, écriture atomique, presets.json, micro OS      │
│ src/main/menu.js   menus Fichier et Édition (annuler, découper, supprimer)   │
└──────────────▲───────────────────────────────────────────────────────────────┘
               │ IPC (ipcRenderer.invoke ↔ ipcMain.handle)
┌──────────────┴───────── Preload (src/preload/preload.cjs) ───────────────────┐
│ contextBridge → window.bandloop.{ openAudioFiles, project, files, window,     │
│                 onMenu, presets, mic }                                       │
└──────────────▲───────────────────────────────────────────────────────────────┘
               │
┌──────────────┴───────── Renderer (Chromium, sans accès Node) ────────────────┐
│ app.js                  relie moteur, moteur vocal, presets et interface     │
│ audio/                  AudioEngine (transport, master, limiteur, VU),       │
│                         arrange (ordre des pistes, aimantation des clips),   │
│                         clips (montage non destructif, purs), history        │
│                         (annuler / rétablir), Track (tranche de console),    │
│                         mixage, pics, planification                          │
│ vocal/                  moteur vocal — voir MOTEUR-VOCAL.md                  │
│   settings.js           schéma des réglages, validation                      │
│   theory.js             gammes, tonalités, intervalles                       │
│   dsp/                  YIN, correction, PSOLA, vocodeur, bourdon (purs)     │
│   VocalHub.js           état vocal par piste, rendu, chaîne temps réel       │
│   voice-worker.js       Web Worker du rendu hors temps réel                  │
│   fx/                   catalogue, nœuds Web Audio, courbes, FxChain         │
│   worklets/             AudioWorklet de bitcrush                             │
│ presets/                24 presets fournis, PresetStore, stockage            │
│ record/                 Recorder, AudioWorklet de capture, latence (purs)    │
│ project/                format .bandloop, ZIP, FLAC, WAV, limiteur (purs),   │
│                         ProjectManager (nouveau/ouvrir/enregistrer)          │
│ export/                 rendu hors temps réel du mix, export WAV/MP3         │
│ vendor/lamejs/          encodeur MP3 (LGPL, fichier séparé non modifié)      │
│ ui/                     Timeline (canvas), TrackPanel, FxPanel, Knob, Meter, │
│                         contrôles génériques, dialogues, icônes              │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Règle principale : le processus principal ne touche jamais à l'audio.** Il
s'occupe des fenêtres et du système de fichiers. Tout le traitement audio se fait
dans le renderer : la Web Audio API (thread audio temps réel), un Web Worker pour
les calculs lourds et un AudioWorklet pour le bitcrush.

## Sécurité Electron

- `contextIsolation: true`, `nodeIntegration: false` et `sandbox: true` : le
  renderer n'a aucun accès à Node.
- Le preload n'expose qu'une API minimale (`window.bandloop`).
- Le renderer est servi par un protocole `app://` (au lieu de `file://`). Cela
  lui donne une vraie origine, nécessaire aux modules ES dans les Workers et les
  AudioWorklets. Le gestionnaire refuse tout chemin hors de `src/renderer`.
- Une CSP stricte est définie dans `index.html`, sans script inline ni distant.
  Les polices sont embarquées (Inter, JetBrains Mono, licence OFL).
- Autorisations : seul le **micro** (audio, sans la caméra) est accordé, et
  seulement à l'origine `app://bandloop`. Voir
  [ENREGISTREMENT.md](ENREGISTREMENT.md).
- Toute navigation est bloquée (`will-navigate`) et l'ouverture de fenêtres
  refusée.

## Chemin d'une piste : du fichier au haut-parleur

1. **Import.** `ipc.js` ouvre la boîte de dialogue et lit les octets bruts, ou
   le glisser-déposer passe par `File.arrayBuffer()`.
2. **Décodage.** `decodeAudioData` produit un `AudioBuffer` (PCM float32).
3. **Forme d'onde.** Les min/max sont calculés une fois, à environ 200 pics/s,
   puis ré-agrégés à chaque zoom.
4. **Graphe audio.**

   ```
   sources (une par clip) ─ input ─ [FxChain : effets temps réel] ─ StereoPanner ─ fader ─┐
   (fenêtres sur l'audio d'origine ou le rendu vocal)            (volume × mute × solo)   │
                                                                                         ├─ master ─ limiteur ─ sortie
   … une tranche par piste …                                                             ┘            └─ analyseurs (VU)
   ```

   Le **fader** applique `effectiveGain()` : volume en dB, mute, et solo. Dès
   qu'une piste est en solo, les autres sont coupées ; le mute l'emporte.

   Le **limiteur** (`DynamicsCompressorNode`, -1 dBFS, ratio 20:1) protège la
   sortie : les harmonies et les effets peuvent dépasser 0 dBFS. En interne,
   Web Audio travaille en flottant et rien ne sature avant la sortie.

## Transport et synchronisation

- L'horloge de référence est `AudioContext.currentTime`, l'horloge matérielle
  de la carte son.
- **Play** : on fixe un instant commun `when = currentTime + 50 ms`, et chaque
  clip de chaque piste est planifié par rapport à cet instant
  (`source.start(when + décalage, offset, durée)`, voir
  [MONTAGE.md](MONTAGE.md)). Tout démarre sur la même horloge, à
  l'échantillon près.
- **Position** = `positionAuDémarrage + (currentTime − when)`. C'est un calcul,
  pas un compteur, donc il ne dérive pas.
- **Pause, seek et remplacement de l'audio** (rendu vocal terminé) : on arrête
  la source et on en recrée une à la position courante.
- Gains et panoramiques passent par `setTargetAtTime` (environ 15 ms) pour
  éviter les clics.

## Interface

- **Identité visuelle** : fond graphite bleuté, accent « citron électrique »
  (`#d7ff4f`), dégradé citron → turquoise du logo (une boucle ouverte qui se
  termine en triangle de lecture). Toutes les couleurs sont des variables CSS
  dans `styles.css`.
- **Barre de transport** : retour au début, stop, lecture/pause, horloge
  (position / durée), VU-mètre stéréo du master avec maintien de crête, zoom,
  import, ouverture du panneau d'effets.
- **Panneau de pistes** : par piste, mute, solo, fader en dB (double-clic pour
  revenir à 0 dB), potentiomètre de panoramique accessible (glisser, molette,
  flèches, double-clic pour centrer), bouton FX et suppression. Cliquer sur une
  piste la sélectionne.
- **Timeline** : un canvas de la taille de la zone visible (un « spacer » donne
  la largeur scrollable) et une couche hors-écran pour les formes d'onde. La
  piste sélectionnée est mise en surbrillance, les pistes inaudibles sont
  atténuées, et le nom du preset s'affiche sur le clip.
- **Panneau d'effets** : contrôles générés depuis les descripteurs de
  paramètres (`ui/controls.js`), curseurs logarithmiques pour les fréquences et
  les temps.

## Tests

`npm test` lance `node:test` (115 tests) sur toute la logique pure :

- transport et mixage ;
- théorie musicale, détection de hauteur, correction, PSOLA et rendu vocal
  complet, mesurés sur des signaux synthétiques ;
- courbes d'effets et schéma des réglages ;
- les 24 presets : catégories, ordre, valeurs non corrigées par la validation ;
- `PresetStore` : création, modification, suppression, persistance ;
- montage des clips (découpe, suppression, rognage, fondus) et historique
  d'annulation ;
- format de projet, codecs FLAC / WAV / ZIP, limiteur.

Les modules Web Audio et DOM restent fins. `npm run test:e2e` lance la vraie
application Electron (Playwright, micro simulé) pour vérifier l'enregistrement :
calage à l'échantillon, prise au micro, autorisations, déplacement des pistes,
montage des clips vérifié à l'échantillon, cycle sauvegarde → relance →
réouverture identique, export WAV/MP3 et erreurs disque. Voir
[PROJETS-ET-EXPORT.md](PROJETS-ET-EXPORT.md) et [MONTAGE.md](MONTAGE.md).

## Évolutions prévues

| Étape | Sujet                                          | Piste technique                                                                  |
| ----- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| 1     | Clips entre pistes, copier / coller, fondus    | Clips référençant une source audio partagée (et non l'audio de leur piste)       |
| 2     | Punch-in et prises en boucle                   | Remplacement d'un passage, plusieurs prises par piste (modèle de clips en place) |
| 3     | Correction en direct                           | YIN + PSOLA dans un AudioWorklet (les briques `dsp/` sont déjà sans DOM)         |
| 4     | Annulation étendue, enregistrement automatique | Mixage et effets dans l'historique ; sauvegarde de secours périodique            |
| 5     | Import / export de presets                     | Fichier `.blpreset` (JSON validé par `normalizeSettings`)                        |
