# USB ISO Flasher

Application Electron (interface HTML/CSS/JS) pour écrire une image ISO/IMG
sur une clé USB et la rendre bootable, à la manière de Rufus ou balenaEtcher.

Une page HTML seule, ouverte dans un simple navigateur, ne peut **pas** faire
ça : les navigateurs interdisent tout accès bas niveau aux disques (WebUSB
bloque explicitement les périphériques de stockage de masse). Il faut donc
une appli de bureau avec un accès système réel ; Electron permet de garder une
interface 100% HTML/JS tout en ayant ce backend.

## Installation

```bash
npm install
npm start
```

> Nécessite un environnement de bureau normal (serveur graphique, D-Bus,
> agent polkit). Ça ne démarrera pas dans un conteneur headless/CI.

## Fonctionnement

1. Choisis un fichier `.iso` ou `.img`.
2. Choisis la clé USB cible dans la liste (seuls les périphériques
   amovibles/USB sont listés, jamais les disques internes).
3. Confirme — **toutes les données de la clé seront effacées**.
4. La progression et le journal brut de la commande d'écriture s'affichent.

## État du support par plateforme

- **Linux : testé.** Utilise `lsblk` pour lister les clés, `umount` puis
  `pkexec dd ... status=progress` pour écrire, avec progression lue depuis
  la sortie de `dd`. Nécessite un agent polkit actif (présent sur la plupart
  des environnements de bureau) pour la demande d'autorisation.
- **macOS : non testé (best-effort).** Utilise `diskutil list`/`diskutil
  info` pour lister les disques externes et `diskutil unmountDisk` + `dd`
  via une demande de mot de passe administrateur (`sudo-prompt`). Pas de
  barre de progression détaillée car le `dd` fourni par macOS n'affiche pas
  d'avancement par défaut.
- **Windows : non testé (best-effort).** Liste les disques USB via
  PowerShell/WMI et écrit directement sur `\\.\PhysicalDriveN` depuis
  Node.js. **L'application doit être lancée en mode administrateur**
  (clic droit → "Exécuter en tant qu'administrateur"), car Node ne peut pas
  déclencher lui-même l'invite UAC pour ouvrir un disque physique en
  écriture.

Cet environnement de build est Linux : seule la partie Linux a pu être
réellement exercée. Les parties macOS/Windows sont écrites par analogie avec
les API documentées de chaque OS, mais n'ont pas été testées sur du matériel
réel — teste-les prudemment (idéalement sur une clé USB sans données
importantes) avant un usage critique.

## Avertissement

Écrire sur le mauvais périphérique efface définitivement son contenu.
L'application ne liste que les disques amovibles/USB pour limiter le risque,
mais vérifie toujours le modèle et la taille affichés avant de confirmer.
