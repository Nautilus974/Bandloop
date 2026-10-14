# Enregistrement au micro

## Utilisation

1. Place la tête de lecture où la prise doit commencer.
2. Clique sur **●** dans la barre de transport, ou appuie sur **R**.
   - La flèche ⌄ à côté ouvre les réglages : choix du micro, VU-mètre
     d'entrée, mono ou stéréo, compte à rebours, compensation de latence,
     retour micro, anti-écho.
3. Un compte à rebours (sans, 3 s ou 5 s, avec bips) précède la prise. **Échap**
   l'annule.
4. Les pistes existantes jouent pendant la prise et servent de guide. La prise
   s'affiche en direct dans une voie rouge.
5. **Espace**, **R**, **■** ou **Entrée** arrêtent la prise. Elle devient une
   piste « Prise N » normale, sélectionnée : volume, pan, mute, solo, et
   panneau FX avec ses presets, dont la correction de hauteur, calculée après
   coup comme pour toute piste.

Pendant la prise, le transport est verrouillé : on ne peut ni déplacer la tête
ni supprimer de piste, car cela décalerait la prise.

## Fonctionnement

```
micro ─ getUserMedia ─ MediaStreamSource ─┬─ AnalyserNode ─ VU-mètre d'entrée
   (traitements du navigateur             ├─ AudioWorklet de capture ─ prise
    désactivés par défaut)                └─ retour micro (gain 0 par défaut)
```

- **Capture** : un AudioWorklet (`record/recorder.worklet.js`) tourne sur le
  thread audio temps réel. Il démarre et s'arrête à des **numéros de trame
  exacts** de l'horloge de l'AudioContext, la même horloge que celle qui
  déclenche la lecture des pistes. Le calage est donc précis à l'échantillon,
  ce que `MediaRecorder` ne permet pas : son horodatage est imprécis et sa
  sortie compressée.
- **Démarrage commun** : la lecture du guide et la capture partent sur la même
  trame. On connaît alors exactement la position de timeline du premier
  échantillon capté.
- **Compensation de latence** : le son que tu entends sort des haut-parleurs
  avec un retard (latence de sortie), et ta voix arrive au logiciel avec un
  autre retard (latence d'entrée). Tu chantes « en retard » de la somme des
  deux, la latence aller-retour. La prise est donc **avancée** d'autant sur la
  timeline (`computeTakePlacement`). Si cela la ferait commencer avant 0:00,
  le début est rogné.
- **Valeur de la latence**, par ordre de priorité :
  1. **mesurée** avec le bouton « Mesurer » : 6 clics joués dans les
     haut-parleurs, enregistrés par le micro, puis retard retrouvé par
     intercorrélation (médiane, rejet si les mesures divergent de plus de
     10 ms) ;
  2. réglée à la main (curseur de 0 à 400 ms) ;
  3. sinon **estimée** : `AudioContext.outputLatency` plus la latence
     d'entrée annoncée par le micro, ou 10 ms par défaut.
- **Autorisations** :
  - macOS : la fenêtre système est demandée par
    `systemPreferences.askForMediaAccess`. L'app empaquetée déclare
    `NSMicrophoneUsageDescription` et l'entitlement
    `com.apple.security.device.audio-input`.
  - Windows : on lit l'état du réglage de confidentialité.
  - Chromium : le gestionnaire de `main.js` n'accorde que l'**audio**, et
    seulement à l'interface de Bandloop. La caméra est toujours refusée.
  - En cas de refus, un message explique où autoriser l'accès, avec un bouton
    « Ouvrir les réglages » (macOS et Windows).

## Tests

- `npm test` : placement de la prise, rognage, estimation et **mesure de
  latence** sur des signaux simulés (bruit, réverbération de pièce, filtrage),
  libellés des prises, conseils de niveau, messages d'erreur selon le système.
- `npm run test:e2e` (sous Linux sans écran : `xvfb-run -a npm run test:e2e`)
  lance la **vraie application Electron** avec un micro simulé par Chromium,
  alimenté par `samples/voix.wav` :
  - **calage** : la sortie est rebouclée vers l'entrée avec 120 ms de retard ;
    les clics de la prise tombent à moins de 0,1 ms de ceux du guide (mesuré :
    0,02 ms, moins d'un échantillon). Sans compensation, ils sont à 120 ms, et
    le calibrage mesure 120,00 ms ;
  - **prise au micro** : la piste est créée à « position − latence », guide
    joué pendant la prise, mixage, preset « Studio » rendu ;
  - **sécurité** : micro accordé, caméra refusée ;
  - **refus d'accès** : message clair, transport non bloqué.

## Limites

### Latence

- **Ce qui est compensé** : le décalage de la prise par rapport au guide, à
  condition que la valeur de latence soit juste. L'estimation automatique est
  souvent approximative de 5 à 30 ms : macOS l'annonce assez bien, Windows et
  Bluetooth beaucoup moins. **Mesure-la une fois par configuration**
  (« Mesurer ») ; elle est mémorisée.
- **Ce qui ne peut pas l'être** : le retard que tu _entends_. Un casque
  Bluetooth ajoute 150 à 300 ms, ce qui rend le chant en rythme pénible, même
  si la prise est ensuite bien recalée. Pour enregistrer, utilise un **casque
  filaire**.
- La mesure par clics exige que le micro entende les haut-parleurs. Avec un
  casque fermé, mesure d'abord sur haut-parleurs, puis passe au casque : la
  différence de latence entre les deux sorties d'une même carte son est en
  général négligeable. Elle ne l'est pas pour le Bluetooth.
- Sous Windows, la pile audio partagée de Chromium (WASAPI) a une latence de
  l'ordre de 20 à 40 ms et plus. Il n'y a pas d'ASIO dans Electron.

### Qualité du micro

- Le son est enregistré **brut** : pas d'annulation d'écho, de réduction de
  bruit ni de gain automatique (désactivables dans les réglages). C'est le
  meilleur choix pour la voix et les effets.
- La fréquence d'échantillonnage est celle du système (souvent 44,1 ou
  48 kHz), en flottant 32 bits. Le pilote ne permet pas de choisir la
  résolution.
- **Micro intégré d'ordinateur portable** : bruit de ventilateur, son de pièce
  et réverbération réduisent la qualité de la correction de hauteur, qui
  préfère une voix sèche (voir `MOTEUR-VOCAL.md`). Un micro USB ou une
  interface audio change tout.
- **Interface à plusieurs entrées** : en mono, les entrées sont mélangées
  ((G + D) / 2). Si le micro n'est que sur l'entrée 1, le niveau baisse de
  6 dB. Choisis le bon canal dans le panneau de contrôle de l'interface, ou
  enregistre en stéréo.
- Le niveau se règle sur le micro ou l'interface : Bandloop n'a pas de gain
  d'entrée logiciel, qui ne ferait que monter le bruit. Le VU-mètre et le
  conseil « faible / bon / saturation » aident à le régler.

### Monitoring sans écho

- **Guide au casque** : c'est la configuration recommandée. Les pistes ne
  passent pas dans le micro.
- **Guide sur haut-parleurs** : le micro capte aussi la musique (repisse). La
  prise contient alors un écho du guide, recalé par la compensation, donc il
  s'additionne en phase, mais il gêne la correction de hauteur. L'option
  « Anti-écho » (traitement du navigateur) retire une bonne partie du guide,
  au prix d'une voix plus « téléphonique » et d'artefacts de réduction de
  bruit.
- **Retour micro** (s'entendre dans le casque) : désactivé par défaut. Il
  passe par la chaîne Web Audio, donc avec la latence aller-retour (souvent
  20 à 50 ms), un retard perceptible et parfois gênant. **Sur haut-parleurs,
  il provoque un larsen.** Le monitoring direct (zéro latence) de ton
  interface audio est préférable.
- Les **effets vocaux ne sont pas entendus pendant la prise**. C'est voulu :
  la correction et les presets sont calculés après coup, sur la prise
  enregistrée.

### Autres

- Une prise est une piste mono ou stéréo en mémoire. Elle n'est pas encore
  écrite sur disque : il faudra la sauvegarde de projet pour la conserver
  après fermeture.
- Pas d'enregistrement en boucle ni de « punch-in » (remplacer un passage
  d'une prise existante) pour l'instant.
