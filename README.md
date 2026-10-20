# Passe-Playlist

Une petite web app (PWA) pour **copier une playlist Deezer dans un compte Spotify** : on colle le lien, la playlist est créée sur Spotify et l'appli renvoie son lien.

- Fonctionne dans le navigateur, **sur téléphone comme sur ordinateur**, sans APK ni installation (on peut l'ajouter à l'écran d'accueil).
- Hébergement gratuit sur **GitHub Pages**. Tout se passe dans le navigateur : aucune donnée ne transite par un serveur à toi.
- Correspondance des titres par **ISRC** (identifiant unique d'un enregistrement), puis titre/artiste/durée en secours.
- Sur Android, une fois installée, l'appli apparaît dans le menu **Partager** de Deezer.

## Les règles de Spotify à connaître

Depuis février 2026, une application Spotify en *Development Mode* :

- nécessite que son **propriétaire ait Spotify Premium** ;
- accepte **5 utilisateurs maximum**, ajoutés à la main.

Passe-Playlist est donc fait pour un petit cercle : la personne Premium installe l'appli et invite jusqu'à 5 amis.

## Installation (une fois, ~10 minutes)

### 1. Publier sur GitHub Pages

1. Crée un dépôt GitHub (ex. `passe-playlist`) et envoie-y le contenu de ce dossier.
2. Dans le dépôt : **Settings → Pages → Source : Deploy from a branch**, branche `main`, dossier `/ (root)`.
3. Après une minute, l'appli est en ligne : `https://<ton-pseudo>.github.io/passe-playlist/`

### 2. Créer l'application Spotify

1. Va sur <https://developer.spotify.com/dashboard> avec le compte **Premium** → **Create app**.
2. *Redirect URI* : l'adresse exacte de l'appli, **avec la barre finale** :
   `https://<ton-pseudo>.github.io/passe-playlist/`
   (l'appli l'affiche aussi dans ⚙︎ Réglages, avec un bouton Copier).
3. *APIs used* : coche **Web API**, puis enregistre.
4. **Settings → User Management** : ajoute chaque ami (nom + e-mail de son compte Spotify).
5. Copie le **Client ID** dans `config.js` (`clientId: "…"`), puis commit. Le *Client secret* ne sert pas : ne le mets nulle part.

### 3. (Recommandé) Le résolveur de liens courts

Le bouton *Partager* de Deezer donne des liens courts `https://link.deezer.com/s/…`. Une page web n'a pas le droit de les suivre elle-même (sécurité du navigateur). Deux options :

- **Sans rien faire** : l'appli te demandera de coller le lien complet `https://www.deezer.com/fr/playlist/…` (visible en ouvrant le lien court dans un navigateur).
- **Avec le résolveur (gratuit)** :
  1. Crée un compte sur <https://dash.cloudflare.com> → **Workers & Pages → Create → Worker**.
  2. Remplace le code par celui de `worker/resolver.js`, puis **Deploy**.
  3. Copie l'adresse du worker (ex. `https://passe-playlist.ton-pseudo.workers.dev`) dans `config.js` (`resolverUrl`).

Le worker n'accepte que les liens courts Deezer et ne stocke rien.

## Utilisation

1. Ouvre l'appli, colle le lien de la playlist Deezer, appuie sur **Créer sur Spotify**.
2. La première fois, Spotify demande l'autorisation, puis l'appli reprend toute seule.
3. À la fin : bouton **Ouvrir dans Spotify**, lien à copier ou partager, et liste des titres introuvables.

La playlist Deezer doit être **publique**. La playlist Spotify est créée **privée** par défaut (option *Playlist publique* dans *Options*).

**L'installer sur le téléphone** : Android/Chrome → menu ⋮ → *Installer l'application* ; iPhone/Safari → bouton Partager → *Sur l'écran d'accueil*.

## Synchronisation automatique

Une fois activée sur une playlist, une tâche GitHub Actions tourne toutes les 30 minutes :

| Changement | Effet |
|---|---|
| Titre **ajouté sur Deezer** | Ajouté sur Spotify automatiquement |
| Titre **retiré de Deezer** | Retiré de Spotify automatiquement |
| Titre **ajouté sur Spotify** (par toi ou un ami) | Listé dans l'appli « à ajouter sur Deezer », avec un bouton qui ouvre le titre dans Deezer |
| Titre **retiré de Spotify** | Listé « à retirer sur Deezer » (il n'est pas remis sur Spotify) |

Le sens Spotify → Deezer reste manuel : Deezer n'accepte plus de nouvelles applications pouvant modifier des playlists. Dès que le changement est fait sur Deezer, l'entrée disparaît de la liste au passage suivant.

Garde-fous : si la playlist Deezer paraît vide, ou si plus de la moitié de ses titres disparaissent d'un coup, rien n'est supprimé côté Spotify. Les titres introuvables sur Spotify sont recherchés de nouveau une fois par jour.

### Mise en place (une fois)

1. Dans l'appli : **⚙︎ Réglages → Générer le jeton de synchro**. Spotify demande une autorisation, puis l'appli affiche 2 ou 3 valeurs.
2. Sur GitHub : **Settings → Secrets and variables → Actions → New repository secret**, et crée chaque secret affiché (`SPOTIFY_REFRESH_TOKEN`, `SYNC_KEY`, et `SPOTIFY_CLIENT_ID` si le Client ID n'est pas dans `config.js`).
3. Sur GitHub : onglet **Actions**, et accepte d'activer les workflows si GitHub le demande.

### Activer une playlist

Après avoir créé une playlist avec l'appli, appuie sur **Activer la synchro sur GitHub** : GitHub s'ouvre avec le fichier prêt, il suffit de cliquer sur **Commit changes**. La première synchro démarre aussitôt.

Pour que tes amis puissent ajouter des titres, laisse l'option **Collaborative** cochée et invite-les dans Spotify : playlist → ⋯ → **Inviter des collaborateurs**.

Pour arrêter la synchro d'une playlist, supprime son fichier dans `sync/pairs/`.

### Bon à savoir

- L'état de la synchro (titres, listes à reporter) est publié dans `sync/state/` : il est visible publiquement, comme le reste du dépôt.
- GitHub désactive les tâches programmées d'un dépôt sans activité depuis 60 jours : réactive-les dans l'onglet Actions si besoin.
- Un échec (jeton expiré, playlist Deezer devenue privée…) apparaît dans l'appli et dans l'onglet Actions, et GitHub t'envoie un e-mail.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html`, `style.css`, `app.js` | L'appli |
| `config.js` | Client ID Spotify et adresse du résolveur |
| `manifest.webmanifest`, `sw.js`, `icons/` | Installation sur l'écran d'accueil, cible de partage Android |
| `worker/resolver.js` | Résolveur de liens courts (optionnel, Cloudflare) |
| `sync/sync.py`, `.github/workflows/sync.yml` | Synchronisation automatique |
| `sync/pairs/` | Une fiche par playlist synchronisée |
| `sync/state/` | État publié par la synchro (lu par l'appli) |

## Dépannage

- **« Spotify refuse l'accès »** : le compte n'est pas dans *User Management*, ou le Premium du propriétaire a expiré.
- **`INVALID_CLIENT: Invalid redirect URI`** : l'adresse déclarée dans Spotify doit être identique à celle de l'appli, barre finale comprise.
- **« Playlist introuvable »** : la playlist Deezer est privée.
- Les titres absents du catalogue Spotify sont listés à la fin, rien n'est ajouté à leur place.

## Vie privée

Le jeton Spotify reste dans le stockage local du navigateur. Les seuls services contactés sont `api.deezer.com`, `accounts.spotify.com`, `api.spotify.com` et, si tu l'as configuré, ton propre résolveur.

## Licence

MIT. Outil indépendant, non affilié à Deezer ni à Spotify.
