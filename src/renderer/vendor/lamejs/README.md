# lamejs 1.2.1

Encodeur MP3 en JavaScript (portage de LAME), utilisé pour l'export MP3.

- Source : https://github.com/zhuker/lamejs (paquet npm `lamejs@1.2.1`)
- Licence : **LGPL-3.0** (voir `LICENSE`)
- Fichier `lame.min.js` copié **sans modification** depuis le paquet npm.

Conformément à la LGPL, la bibliothèque est livrée comme un fichier séparé,
chargé dynamiquement par `export/mp3-worker.js` : elle peut être remplacée par
une autre version compatible sans recompiler Bandloop.
