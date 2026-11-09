# Connexion Google et Discord : méthode pas à pas

Durée : environ 10 minutes. Tu n'as **rien à coder** : il faut créer deux « applications » chez Google et Discord, récupérer
deux clés pour chacune (un identifiant public, un secret), puis les donner au serveur.

Les deux URL de callback sont les seules choses à recopier **exactement** (au caractère près, en `https`, sans `/` final) :

| Fournisseur | URL de redirection (callback)                              |
| ----------- | ---------------------------------------------------------- |
| Google      | `https://conquest.glsc.fr/api/auth/oauth/google/callback`  |
| Discord     | `https://conquest.glsc.fr/api/auth/oauth/discord/callback` |

> Le jeu fonctionne déjà sans OAuth (connexion « invité »). Les boutons Google / Discord n'apparaissent que pour un
> fournisseur dont les deux clés sont configurées.

## 1. Google

1. Va sur <https://console.cloud.google.com> et crée un projet (menu en haut → **Nouveau projet** → « Conquest »).
2. Menu **API et services → Écran de consentement OAuth** (ou « Google Auth Platform ») :
   - type d'utilisateur : **Externe** ;
   - nom de l'application : `CONQUEST`, e-mail d'assistance : le tien ;
   - **Champs d'application** : ajoute uniquement `openid` et `profile` (non sensibles : aucune validation Google requise) ;
   - **Publie l'application** (« En production »). Tant qu'elle reste en mode « Test », seuls les comptes ajoutés à la main peuvent se connecter.
3. Menu **Identifiants → Créer des identifiants → ID client OAuth** :
   - type : **Application Web** ;
   - **URI de redirection autorisés** : `https://conquest.glsc.fr/api/auth/oauth/google/callback` ;
   - (Origines JavaScript autorisées : `https://conquest.glsc.fr`, facultatif.)
4. Google affiche l'**ID client** (finit par `.apps.googleusercontent.com`) et le **Code secret du client**. Garde la fenêtre ouverte.

## 2. Discord

1. Va sur <https://discord.com/developers/applications> → **New Application** → « CONQUEST ».
2. Menu **OAuth2** :
   - **Redirects → Add Redirect** : `https://conquest.glsc.fr/api/auth/oauth/discord/callback` puis **Save Changes** ;
   - **Client ID** : visible en haut de la page ;
   - **Client Secret** : bouton **Reset Secret** (il n'est affiché qu'une fois, copie-le tout de suite).
3. Rien d'autre : le scope `identify` (pseudo + avatar) est demandé automatiquement.

## 3. Donner les clés au serveur (sans les exposer)

Sur le VPS :

```bash
curl -fsSL https://raw.githubusercontent.com/gabinlsc/conquest/main/deploy.sh | sudo bash -s -- oauth setup
```

Le script rappelle les deux callbacks, te demande chaque **Client ID** puis chaque **Client Secret** (saisie masquée : rien
dans l'historique du shell ni dans la liste des processus), les écrit dans `/opt/conquest/.env` (lisible par root seulement),
redémarre le serveur et **vérifie** que chaque fournisseur redirige bien. Entrée vide = fournisseur ignoré.

Alternative non interactive (les valeurs resteront dans l'historique du shell) :

```bash
curl -fsSL .../deploy.sh | sudo bash -s -- env GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… DISCORD_CLIENT_ID=… DISCORD_CLIENT_SECRET=…
```

## 4. Vérifier

```bash
curl -fsSL .../deploy.sh | sudo bash -s -- oauth
# ✔ google : configuré et opérationnel
# ✔ discord : configuré et opérationnel
```

Puis dans le navigateur : ouvre `https://conquest.glsc.fr` en navigation privée → **Jouer** → les boutons **Google** et
**Discord** doivent apparaître → clique, autorise, tu reviens sur la carte connecté.

**Un invité qui se connecte garde son compte et sa progression** (liaison automatique) ; si l'identité Google/Discord
existait déjà, il se connecte à ce compte-là.

## Dépannage

| Symptôme                                                                                       | Cause probable                                                                                                                                           |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google : `redirect_uri_mismatch`                                                               | L'URL déclarée n'est pas **identique** à la callback (http au lieu de https, `/` final, mauvais domaine). Corrige-la dans la console, attends 1 à 5 min. |
| Google : « Accès bloqué : l'application n'a pas été validée » / seuls certains comptes passent | L'application est restée en mode **Test** : publie-la (étape 1.2).                                                                                       |
| Retour sur la carte avec `?auth_error=failed`                                                  | Secret erroné ou périmé (Discord : « Reset Secret » en génère un nouveau). Refais `oauth setup`, puis `... -- logs` pour lire l'erreur exacte.           |
| `?auth_error=expired`                                                                          | Le cookie de transaction (10 min) a expiré ou le navigateur bloque les cookies : réessaie.                                                               |
| `oauth` affiche « non configuré »                                                              | Une des deux clés (ID **ou** secret) est vide pour ce fournisseur.                                                                                       |
| Aucun bouton dans le jeu                                                                       | Aucun fournisseur configuré, ou le serveur n'a pas redémarré : `... -- oauth`.                                                                           |

## Sécurité

- Les clés ne sont **jamais** dans le dépôt : uniquement dans `/opt/conquest/.env` (droits `600`).
- Si un secret fuite : régénère-le chez le fournisseur (Google : « Ajouter un secret » puis supprime l'ancien ; Discord : « Reset Secret »), puis `oauth setup`.
- Le flux utilise le code d'autorisation avec PKCE et un `state` signé dans un cookie éphémère (protection CSRF), et une nouvelle session est créée à chaque connexion.
