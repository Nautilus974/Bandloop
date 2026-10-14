# Projets et export du mix

## Utilisation

| Action           | Menu Fichier / raccourci                                                         | Bouton                          |
| ---------------- | -------------------------------------------------------------------------------- | ------------------------------- |
| Nouveau projet   | Ctrl/⌘+N                                                                         | Fichier ▸ Nouveau projet        |
| Ouvrir           | Ctrl/⌘+O (ou double-clic sur un `.bandloop`, ou glisser-déposer dans la fenêtre) | Fichier ▸ Ouvrir…               |
| Enregistrer      | Ctrl/⌘+S                                                                         | Fichier ▸ Enregistrer           |
| Enregistrer sous | Ctrl/⌘+Maj+S                                                                     | Fichier ▸ Enregistrer sous…     |
| Exporter le mix  | Ctrl/⌘+E                                                                         | **Exporter** (en haut à droite) |

- **Titre de la fenêtre** : `Nom du projet — Bandloop`, avec un `*` tant
  qu'il y a des modifications non enregistrées. Sur macOS, le point dans le
  bouton de fermeture apparaît aussi.
- **Modifications non enregistrées** : avant Nouveau, Ouvrir ou la
  fermeture de la fenêtre, Bandloop propose « Enregistrer », « Ne pas
  enregistrer » ou « Annuler ».
- Au premier enregistrement, le projet prend le nom du fichier choisi.

## Le format `.bandloop`

Un projet est une **archive ZIP standard** : on peut l'ouvrir avec n'importe
quel outil pour récupérer l'audio.

```
Mon morceau.bandloop
├── project.json          état complet du projet
└── audio/
    ├── 01-prise-1.flac   prise micro      → FLAC 24 bits (sans perte)
    ├── 02-voix.wav       fichier importé  → octets d'origine, tels quels
    └── 03-beat.mp3       fichier importé  → octets d'origine, tels quels
```

`project.json` contient :

- le nom, le tempo, le zoom, la position de la tête et la tonalité ;
- pour chaque piste, dans l'ordre : nom, couleur, début sur la timeline,
  volume, panoramique, mute, solo, et l'effet vocal (preset, réglages
  complets, contournement) ;
- les **presets personnels** utilisés. Ouvert sur une autre machine, le projet
  les ajoute à « Mes presets ».

Le fichier est validé à l'ouverture. Les valeurs hors limites sont corrigées et
un projet créé par une version plus récente est refusé avec un message clair.

### Pourquoi ces formats audio ?

- **Fichiers importés : on garde les octets d'origine**, sans réencodage. Le
  projet se rouvre au bit près (`decodeAudioData` refait exactement le même
  décodage), il n'y a aucune perte de génération, même après 100
  enregistrements, et c'est la taille minimale (un MP3 reste un MP3).
  Convertir en FLAC un MP3 importé le ferait grossir de 3 à 8 fois sans
  rien gagner.
- **Prises micro : FLAC 24 bits**. FLAC compresse **sans perte** : en
  général 50 à 70 % de la taille d'un WAV, plus selon les silences. C'est un
  format ouvert, lu nativement par Chromium et par tous les logiciels audio
  (Audacity, VLC, ffmpeg…). Une prise micro est en flottant 32 bits ; le
  24 bits garde une dynamique de 144 dB, bien au-delà du bruit de n'importe
  quel micro ou convertisseur. La différence est donc nulle à l'oreille.
- Écarté : **WAV** (simple, mais deux fois plus gros), **Opus / MP3 / AAC**
  (avec perte : chaque réenregistrement dégraderait la prise).

Sécurités :

1. Après encodage, le FLAC est **redécodé et comparé** échantillon par
   échantillon. En cas d'écart, Bandloop enregistre cette prise en WAV
   flottant 32 bits, sans perte.
2. Le FLAC d'une prise est gardé en mémoire : les enregistrements suivants
   ne le réencodent pas.
3. **Écriture atomique** : le projet est écrit dans un fichier temporaire, puis
   renommé. Disque plein ou coupure en cours d'écriture : l'ancien projet
   reste intact et aucun fichier à moitié écrit n'est laissé.
4. L'encodeur FLAC est vérifié bit à bit contre `ffmpeg` dans les tests.

## Export du mix

- Fenêtre d'export à deux cartes : **WAV**, pour la qualité studio, en 24 ou
  16 bits (16 bits avec dither, qualité CD) ; **MP3**, pour le partage, à
  128, 192 ou 320 kb/s. La taille estimée s'affiche.
- On choisit l'emplacement, puis la progression s'affiche par étapes :
  effets vocaux, rendu des pistes, limiteur, encodage, écriture. L'export
  peut être annulé, et il n'écrit alors aucun fichier.
- À la fin : durée, taille, réduction appliquée par le limiteur et bouton
  « Afficher dans le dossier ».

### Ce qui est rendu

Le mix est calculé hors temps réel (`OfflineAudioContext`) avec **le même
graphe que la lecture**, donc tu exportes ce que tu entends :

- l'audio de chaque piste, avec le rendu vocal (correction, harmonies,
  vocodeur, bourdon) ;
- la chaîne d'effets temps réel de chaque piste ;
- le panoramique, puis volume × mute × solo : seules les pistes **audibles**
  sont exportées ;
- le bus master avec son limiteur de sécurité.

Ensuite :

1. La traîne est conservée jusqu'à la fin de la réverb ou du delay, puis le
   silence final est coupé.
2. Un **limiteur brickwall à anticipation** (5 ms) garantit qu'aucun
   échantillon ne dépasse **−1 dBFS**, sans écrêtage brutal. C'est la marge
   habituelle des plateformes de streaming : elle évite que l'encodage MP3
   fasse saturer les crêtes.

## Tests

- **Unitaires** (`npm test`) :
  - ZIP : CRC, intégrité, fichier tronqué ou altéré ;
  - FLAC 16/24 bits, mono et stéréo, silence, valeurs extrêmes, décodage à
    l'identique par un décodeur indépendant et par `ffmpeg` ;
  - WAV 16/24/32 bits ;
  - limiteur : plafond respecté, signal faible intact ;
  - format de projet : aller-retour, fichiers corrompus ou étrangers, audio
    manquant, version trop récente, valeurs aberrantes ;
  - messages d'erreur disque, import des presets.
- **De bout en bout dans Electron** (`npm run test:e2e`) :
  - **sauvegarde → fermeture complète de l'application → relance →
    réouverture** : pistes, ordre, positions, mixage, presets (y compris un
    preset personnel supprimé entre-temps), tonalité, tempo, zoom, nom, et
    **audio identique** (au bit près pour les fichiers importés, à
    l'échantillon 24 bits près pour la prise micro) ;
  - astérisque du titre, confirmation avant « Nouveau » et à la fermeture
    de la fenêtre (Annuler / Enregistrer puis fermer) ;
  - export WAV : fichier valide, piste muette absente, effet présent,
    **aucun échantillon au-dessus de −1 dBFS ni plateau d'écrêtage** alors
    que les pistes saturent en somme ;
  - export MP3 320 kb/s : lu par `ffmpeg`, stéréo, durée correcte, sous
    0 dBFS ;
  - annulation, fichier corrompu, étranger, tronqué ou disparu ;
  - **vrai disque plein** (petit disque monté pour le test) et **emplacement
    en lecture seule** : messages clairs, aucun fichier partiel.

## Limites

### Taille des projets (audio embarqué)

Mesuré sur un morceau de 3 min (2 WAV stéréo, 1 MP3, 1 prise micro mono) :
**84 Mo**. En ordre de grandeur :

| Contenu d'une piste de 3 min        | Taille dans le projet |
| ----------------------------------- | --------------------- |
| WAV stéréo 16 bits importé          | ~32 Mo (tel quel)     |
| WAV stéréo 24 bits / 48 kHz importé | ~52 Mo (tel quel)     |
| MP3 importé                         | 3 à 7 Mo (tel quel)   |
| Prise micro mono (FLAC 24 bits)     | ~10 à 18 Mo           |

- Un album de 10 morceaux de 20 pistes peut dépasser 1 Go par projet. Un
  projet ne peut pas dépasser **4 Gio** (limite du format ZIP sans ZIP64) : au-delà,
  Bandloop refuse d'enregistrer avec un message.
- Tout le projet est **en mémoire** pendant l'ouverture et l'enregistrement :
  l'audio décodé (32 bits flottants) occupe environ 5 fois la taille d'un WAV
  16 bits. Un projet d'1 Go peut demander plusieurs Go de RAM.
- Une piste dupliquée n'est pas dédupliquée : chaque piste embarque son
  audio.

### Durée des opérations

| Opération (morceau de 3 min, 4 pistes)                   | Durée mesurée |
| -------------------------------------------------------- | ------------- |
| Premier enregistrement (FLAC + vérification de la prise) | ~5 s          |
| Enregistrements suivants                                 | ~1 s          |
| Export WAV                                               | ~7 s          |
| Export MP3 320 kb/s                                      | ~23 s         |

- Le rendu du mix et l'export WAV vont environ **25 fois plus vite que le
  temps réel**. Le MP3 est **environ 3 fois plus long** que le WAV :
  l'encodeur (lamejs) est en JavaScript pur, plus lent qu'un encodeur natif.
  Ici, il encode environ 11 fois plus vite que le temps réel ; son auteur
  annonce ~20× sur sa machine. Il tourne dans un Worker, donc l'interface
  reste fluide.
- Les effets vocaux lourds (correction, harmonies, vocodeur) doivent être
  calculés avant l'export ; l'export attend qu'ils soient prêts.
- Ces mesures ont été prises dans un conteneur de test sans carte graphique.
  Elles varient selon la machine.

### Qualité du MP3

- Le MP3 est une compression **avec perte**. À **320 kb/s**, il est
  pratiquement indiscernable de l'original pour la plupart des gens. À
  **192 kb/s**, de légers défauts deviennent possibles sur les cymbales et les
  réverbérations longues ; à **128 kb/s**, ils sont audibles (aigus coupés
  vers 16 kHz, « gargouillis »). Pour du mastering ou un autre logiciel,
  exporte en **WAV**.
- lamejs est une réécriture en JavaScript de LAME, l'encodeur MP3 de
  référence, passée par le projet jump3r. Son modèle psychoacoustique suit
  celui de LAME.
- Le MP3 ajoute un court silence au début et à la fin (latence de
  l'encodeur, ~25 ms), sans balise « gapless ». À éviter pour des boucles
  qui doivent s'enchaîner sans blanc : prends le WAV.
- Fréquence : 44,1 ou 48 kHz (au-delà, le mix est rendu à 48 kHz pour le
  MP3). Pas de métadonnées ID3 (titre, artiste) pour l'instant.
- Licence : lamejs est sous **LGPL-3.0**. Il est livré comme un fichier séparé
  et non modifié (`vendor/lamejs/`), remplaçable, ce que permet la LGPL dans
  une application commerciale.

### Autres

- Il n'y a ni annulation (Ctrl+Z) ni enregistrement automatique pour
  l'instant : pense à Ctrl+S.
- Le rendu vocal (correction, harmonies…) n'est pas stocké dans le projet :
  il est **recalculé à l'ouverture** à partir des réglages, ce qui garde des
  fichiers légers mais demande quelques secondes par piste corrigée.
