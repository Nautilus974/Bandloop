# Bandloop

Studio audio multipiste de bureau, façon BandLab, pour macOS et Windows.
Construit avec **Electron** et la **Web Audio API**.

> Statut : prototype. Import de pistes, timeline avec formes d'onde, lecture
> synchronisée, play / pause / stop, déplacement de la tête de lecture, volume et mute par piste.

## Démarrer

```bash
npm install
npm run samples   # génère 3 pistes de démo dans ./samples (batterie, basse, nappe)
npm start         # lance l'application
```

Importe les fichiers de `samples/` avec **Importer des pistes…**, ou glisse-les dans la fenêtre.

| Raccourci                 | Action                                         |
| ------------------------- | ---------------------------------------------- |
| Espace                    | Lecture / pause                                |
| Entrée / Début            | Stop (retour au début)                         |
| Clic sur la timeline      | Déplacer la tête de lecture (glisser possible) |
| Double-clic sur un volume | Retour à 0 dB                                  |

## Scripts

| Commande           | Rôle                                         |
| ------------------ | -------------------------------------------- |
| `npm start`        | Lance l'app en développement                 |
| `npm test`         | Tests unitaires (`node:test`, sans Electron) |
| `npm run samples`  | Génère des WAV de démo                       |
| `npm run dist:mac` | Construit un `.dmg` (à lancer sur un Mac)    |
| `npm run dist:win` | Construit un installeur `.exe` (NSIS)        |

L'architecture est décrite dans [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
