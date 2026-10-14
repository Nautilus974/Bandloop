# Architecture de Bandloop

## Vue d'ensemble

```
┌──────────────────────── Processus principal (Node) ────────────────────────┐
│ src/main/main.js   fenêtre, cycle de vie de l'app, sécurité                 │
│ src/main/ipc.js    boîte de dialogue « ouvrir », lecture des fichiers       │
└──────────────▲──────────────────────────────────────────────────────────────┘
               │ IPC (ipcRenderer.invoke ↔ ipcMain.handle)
┌──────────────┴───────── Preload (src/preload/preload.cjs) ──────────────────┐
│ contextBridge → window.bandloop.openAudioFiles()                            │
└──────────────▲──────────────────────────────────────────────────────────────┘
               │
┌──────────────┴───────── Renderer (Chromium, sans accès Node) ───────────────┐
│ app.js                     colle UI ↔ moteur, transport, raccourcis, drag&drop│
│ audio/AudioEngine.js       AudioContext, bus master, transport, horloge      │
│ audio/Track.js             AudioBuffer + GainNode + source de lecture        │
│ audio/scheduling.js        calculs purs : planification, dB → gain           │
│ audio/peaks.js             calcul des formes d'onde (min/max)                │
│ ui/Timeline.js             canvas : règle, clips, formes d'onde, tête        │
│ ui/TrackHeaders.js         en-têtes de piste : nom, volume, mute, suppression│
│ ui/time.js, ui/layout.js   formatage du temps, dimensions partagées          │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Règle principale : le processus principal ne touche jamais à l'audio.** Il
s'occupe des fenêtres et du système de fichiers. Tout le traitement audio se fait
dans le renderer, où vivent la Web Audio API et son thread audio temps réel.

## Sécurité Electron

- `contextIsolation: true`, `nodeIntegration: false` et `sandbox: true` : le
  renderer n'a aucun accès à Node.
- Le preload n'expose qu'une API minimale et typée (`window.bandloop`).
- Une CSP stricte est définie dans `index.html`, sans script inline ni distant.
- Toute navigation est bloquée (`will-navigate`) et l'ouverture de fenêtres
  refusée.

## Chemin d'une piste : du fichier au haut-parleur

1. **Import.** `ipc.js` ouvre la boîte de dialogue et lit les octets bruts avec
   `fs.readFile`. Ils traversent l'IPC sous forme de `Uint8Array`. Le
   glisser-déposer passe par `File.arrayBuffer()` et ne fait pas appel à l'IPC.
2. **Décodage.** `AudioContext.decodeAudioData` produit un `AudioBuffer` (PCM
   float32, ré-échantillonné à la fréquence du contexte). Il prend en charge
   WAV, MP3, OGG/Opus, FLAC et AAC/M4A, avec les codecs de Chromium.
3. **Forme d'onde.** `computePeaks` calcule une fois pour toutes les min/max par
   tranche d'environ 5 ms (environ 200 pics/s). À chaque zoom, la timeline
   ré-agrège ces pics par colonne de pixels (`peakRange`) sans relire le PCM.
4. **Graphe audio.**

   ```
   AudioBufferSourceNode → GainNode (piste) ┐
   AudioBufferSourceNode → GainNode (piste) ├→ GainNode (master) → destination
   AudioBufferSourceNode → GainNode (piste) ┘
   ```

## Transport et synchronisation

- L'horloge de référence est `AudioContext.currentTime`, l'horloge matérielle
  de la carte son, et non `Date.now()` ni `requestAnimationFrame`.
- **Play** : on fixe un instant commun `when = currentTime + 50 ms`, et chaque
  piste appelle `source.start(when, offset)`. Toutes les pistes démarrent ainsi
  au même échantillon. Les 50 ms laissent le temps de créer les sources.
- **Position** = `positionAuDémarrage + (currentTime − when)`. C'est un calcul,
  pas un compteur : la position ne dérive pas, même si l'interface rame.
- **Pause / seek** : une `AudioBufferSourceNode` ne peut être démarrée qu'une
  fois. On arrête donc les sources, puis on en recrée de nouvelles à la
  nouvelle position. C'est peu coûteux, car le buffer décodé est partagé.
- `computeSourceSchedule` gère déjà les clips qui ne commencent pas à 0
  (`track.startTime`). C'est la base pour déplacer des clips sur la timeline.
- Les changements de volume passent par `setTargetAtTime`, lissé sur environ
  15 ms, pour éviter les clics.

## Rendu de la timeline

- Le canvas a la taille de la **zone visible** et non du projet. Les canvas
  sont limités à environ 32 000 px, et un projet de 10 minutes affiché à
  400 px/s en ferait 240 000. Un « spacer » donne la largeur scrollable, et le
  dessin tient compte de `scrollLeft`.
- Les formes d'onde sont dessinées dans un canvas hors-écran, invalidé sur
  scroll, zoom, redimensionnement ou modification des pistes. À chaque image,
  on recopie cette couche puis on dessine seulement la tête de lecture.
- La densité de pixels (`devicePixelRatio`) est gérée pour les écrans Retina
  et HiDPI.

## Tests

`npm test` lance `node:test` sur la logique pure : planification, dB → gain,
pics, formatage du temps. Les modules liés à Web Audio et au DOM restent fins
pour que l'essentiel de la logique soit testable sans navigateur.

## Évolutions prévues

| Étape | Sujet                          | Piste technique                                                                                 |
| ----- | ------------------------------ | ----------------------------------------------------------------------------------------------- |
| 1     | Déplacer et découper les clips | Modèle `Clip` séparé de `Track` (plusieurs clips par piste), `start(when, offset, duration)`    |
| 2     | Pan, solo, VU-mètres           | `StereoPannerNode`, `AnalyserNode`                                                              |
| 3     | Sauvegarde de projet           | JSON du projet et fichiers audio dans un dossier `.bandloop`, via IPC `fs`                      |
| 4     | Enregistrement micro           | `getUserMedia` + AudioWorklet d'enregistrement, compensation de latence                         |
| 5     | Effets                         | Nœuds natifs (EQ `BiquadFilterNode`, compresseur, réverbe `ConvolverNode`) puis AudioWorklet    |
| 6     | Export / mixdown               | `OfflineAudioContext` → WAV                                                                     |
| 7     | Gros projets                   | Décodage et calcul des pics dans un Worker ; streaming disque si la mémoire devient un problème |
| 8     | Moteur temps réel maison       | Mixage dans un AudioWorklet (JS puis C++/Rust → WASM), comme les DAW web évolués                |
