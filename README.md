# CONQUEST

Jeu de conquête de territoire massivement multijoueur : une carte du monde partagée en temps réel, des villes à capturer via des mini-jeux de 30 secondes.

## Stack

Next.js (App Router) · MapLibre GL · Tailwind · Fastify · Colyseus · PostgreSQL/PostGIS · Redis · Caddy · Docker Compose.

## Structure

```
apps/web         Front Next.js
apps/server      API Fastify (+ temps réel à partir de la phase 4)
packages/shared  Types, schémas zod et règles partagés client/serveur
infra/           Caddyfile, init SQL
deploy.sh        Déploiement VPS en une commande
```

## Développement local

Prérequis : Node 22, pnpm 10, Docker.

```bash
cp .env.example .env
pnpm install
pnpm infra:up      # Postgres + Redis sur localhost
pnpm --filter @conquest/shared build
pnpm import:geonames   # ~34 000 villes, idempotent (relançable sans perte)
pnpm dev           # web :3000, server :3001
```

Vérifications : `pnpm ci` (format, lint, build, typecheck, tests).

## Déploiement (VPS Ubuntu/Debian)

Le DNS du domaine doit pointer vers le serveur.

```bash
curl -fsSL https://raw.githubusercontent.com/gabinlsc/conquest/main/deploy.sh \
  | sudo DOMAIN=conquest.glsc.fr bash
```

Idempotent : la même commande met à jour. Si nginx/apache occupe déjà les ports 80/443, ajouter `DISABLE_HOST_WEBSERVER=1`. Les secrets sont générés dans `/opt/conquest/.env` et conservés entre les mises à jour.

## Données & API (phase 1)

- Villes : GeoNames `cities15000` (≈ 34 000 villes), importées par `pnpm import:geonames` (ou automatiquement par `deploy.sh` au premier déploiement). Chaque ville appartient d'abord à la faction de son pays ; un ré-import ne réinitialise jamais la propriété.
- `GET /api/cities/geojson` géométrie statique (ETag, cache) · `GET /api/world/state` factions + propriétaires · `GET /api/cities?bbox=&country=&q=&limit=&offset=` · `GET /api/cities/:id` · `GET /api/countries`.
- Tests d'intégration : `TEST_DATABASE_URL=postgres://… pnpm test` (la base ciblée est vidée).
- Fond de carte 100 % local (Natural Earth, polices statiques) : aucune dépendance à un service de tuiles.
- Attributions : GeoNames (CC BY 4.0), Natural Earth (domaine public), polices Open Sans (OFL).

## Auth & factions (phase 2)

- **Sessions** serveur (Postgres) : cookie `httpOnly` + `SameSite=Lax`, seul le hash SHA-256 du jeton est stocké, expiration glissante 30 j. Contrôle `Origin` sur les mutations (CSRF), rate limiting par IP.
- **Invité** : `POST /api/auth/guest` (pays + pseudo facultatif) → rattaché d'office à la faction de son pays. Le pays est pré-rempli depuis `Accept-Language` puis confirmé par le joueur.
- **OAuth Google / Discord** (code + PKCE, `state` signé) : un invité qui se connecte conserve son compte et sa progression. Un provider est actif seulement si ses variables `*_CLIENT_ID/SECRET` sont renseignées. URL de callback à déclarer chez le fournisseur : `https://<domaine>/api/auth/oauth/<google|discord>/callback`.
- **Factions** : un joueur appartient à exactement une faction (pays par défaut, ou un clan). Clans ouverts ou sur invitation (code à 8 caractères), chef remplacé automatiquement, dissolution = les villes reviennent à leur pays. Changement de pays : une fois par semaine.
- API : `GET/PATCH /api/me`, `POST /api/auth/logout`, `GET /api/clans`, `GET /api/clans/:id`, `POST /api/clans`, `POST /api/clans/:id/join`, `POST /api/clans/leave`.

## Mini-jeux & attaques (phase 3)

- **Moteur** (`packages/shared/src/minigames`) : interface `MiniGame { generate(seed), parseInput(raw), validate(seed, input) }`, pure et déterministe (PRNG à graine). Le client rend la partie avec `generate`, le serveur la **rejoue** avec `validate`. Le client n'envoie jamais de score, seulement ses actions brutes.
- **Ajouter un jeu** : créer `monjeu.ts` (même interface), ajouter son id dans `MINIGAME_IDS`, l'enregistrer dans `MINIGAMES`, écrire son composant de rendu côté web.
- **Flux** : `POST /api/attacks {cityId}` → graine HMAC liée à la partie + paramètres ; le joueur joue 30 s ; `POST /api/attacks/:id/submit {input}` → score calculé par le serveur. Soumission idempotente (verrou de ligne), forme invalide = 400 sans consommer la partie.
- **Anti-triche (socle)** : graine dérivée par HMAC (non choisissable), contrôle du temps réel mesuré côté serveur (soumission instantanée, tardive, clics « dans le futur »), réactions inhumaines, spam de clics, tir sur cible déjà touchée, plafond de score théorique, cooldown et plafond horaire par joueur. Drapeaux `hard:`/`soft:` conservés en base (jamais renvoyés au client) pour la détection statistique de la phase 5.
- **Réflexes** : cibles à cliquer avant disparition, 20 à 100 points par cible (rapidité + précision), −10 par tir manqué.
- Le score n'est pas encore converti en influence : c'est la phase 4 (capture, état chaud Redis, temps réel).

## Temps réel & capture (phase 4)

- **Choix Socket.IO plutôt que Colyseus** : la synchro d'état par schéma de Colyseus pousse l'état complet d'une room à tous ses clients, à l'opposé de la règle « deltas par viewport » ; Socket.IO offre des rooms natives (une par tuile géographique), la reconnexion automatique avec backoff et un adaptateur Redis pour passer à plusieurs process.
- **État chaud dans Redis** (propriétaire, influence, version par ville). Le client s'abonne aux **tuiles de 22,5°** de sa zone visible (zoom ≥ 5,5, 48 tuiles max, messages limités) : il reçoit un instantané de la tuile, puis uniquement des **deltas** `{id, owner, ver, inf}`. Chaque ville porte un numéro de version : les messages en retard sont ignorés.
- **Capture atomique** : un script Lua (`apps/server/src/world/scripts.ts`) applique l'attaque, sérialise les attaques simultanées et est **idempotent** par identifiant d'attaque. Il est vérifié contre une implémentation de référence en TypeScript (`resolveAttack`, `packages/shared/src/capture.ts`) par un test différentiel aléatoire.
- **Règles** : garnison de 60 à 240 selon la valeur de la ville ; score → 0-100 points d'influence ; attaquer sa propre ville la renforce (plafond 3× la garnison) ; érosion de 10 points/h ; l'attaquant doit **dépasser strictement** l'occupant ; bouclier de 60 s après une capture ; à la capture l'ancien occupant garde la moitié de son influence. Tous ces paramètres sont des constantes de `capture.ts`.
- **Persistance** : write-behind Redis → Postgres toutes les 2 s (villes modifiées uniquement), vidange à l'arrêt, ré-hydratation automatique si Redis est vide (les versions repartent au-dessus du maximum connu).
- **Mode dégradé** : si Redis tombe, l'API reste lisible (copie Postgres), les parties sont scorées et enregistrées, leur effet est mis « en attente » puis rejoué automatiquement au retour de Redis (`/api/health` passe en `degraded`).
- **Flux d'événements** : captures persistées (table `events`, une par attaque) et diffusées à tous, `GET /api/events` pour l'historique.
- **Test de charge** : `pnpm --filter @conquest/server loadtest -- --base http://localhost:3001 --players 1000 --attackers 300` (comptes, sockets, vraies parties, mesure de la latence de diffusion). Résultats de référence en local (4 cœurs, tout sur la même machine), 1 000 sockets, 300 parties : connexion p95 ≈ 300 ms, soumission p95 ≈ 20-70 ms, 0 erreur. La latence de diffusion est mesurée par un processus sonde séparé : ≈ 6 ms (p95) en régime normal ; sous rafale extrême (300 parties soumises en 3 s, ≈ 25 captures/s) médiane ≈ 60 ms, p95 ≈ 1,2 s. Le flux d'événements est regroupé par lots de 200 ms pour cette raison (une écriture par client et par lot, au lieu d'une par capture).

## Classements, saisons, anti-triche (phase 5)

- **Classements** en sorted sets Redis par saison : joueurs (global et par pays), nations, clans. Points : influence apportée + bonus de capture (`attackPoints`), plus le **revenu des territoires** (valeur cumulée des villes tenues, versée toutes les 5 min, un seul versement par tranche même avec plusieurs processus). Attribution **atomique et idempotente** (script Lua) ; write-behind vers `season_scores`, reconstruction depuis Postgres si Redis est vide, repli sur Postgres si Redis est tombé.
- **Saisons** : durée `SEASON_WEEKS` (4 par défaut). À l'échéance, un verrou inter-processus suspend les nouvelles parties (503), fige le podium, remet chaque ville à la faction de son pays (Postgres et Redis), ouvre la saison suivante et prévient tous les clients par Socket.IO. Comptes, clans et historique des parties survivent.
- **Anti-triche renforcé** (en plus de la validation déterministe) : empreinte de réactions pour détecter le **rejeu d'un enregistrement**, score statistiquement aberrant (z-score en ligne, algorithme de Welford), **fermes de comptes** (IP hachée par HMAC, jamais stockée en clair), limite de débit **par joueur** avec compteurs partagés dans Redis. Les signaux alimentent une suspicion qui décroît de moitié par jour ; au-delà du seuil le joueur est en **shadow ban** (parties jugées normalement, résultat plausible, mais aucun effet sur la carte ni le classement). Chaque attaque n'est analysée qu'une fois, même rejouée.
- **Revue des suspects** : `docker compose exec server node dist/cli/anticheat.js report` · réhabilitation d'un faux positif : `... anticheat.js unban <userId>`.
- API : `GET /api/season`, `GET /api/seasons`, `GET /api/leaderboards/{players,nations,clans}?country=&limit=&offset=`, `GET /api/leaderboards/me`.

## Style

L'interface reprend le design de glsc.fr : fond crème pointillé, contours noirs de 3 px, ombres dures décalées, pastels (banane, menthe, corail, ciel, pêche, lilas), titres en Fredoka et texte en Space Grotesk (auto-hébergées, licence OFL). Les jetons sont dans `apps/web/tailwind.config.ts` et les classes réutilisables (`card`, `btn`, `pill`, `field`) dans `apps/web/src/app/globals.css`. La carte reprend l'habillage : mer bleu ciel, terres crème, contours noirs.

## Finitions, bots, métriques, OAuth (phase 6)

**Effets et alertes**

- **Vagues de capture** : des anneaux concentriques, aux couleurs de la faction conquérante, s'étendent autour de la ville (une source GeoJSON dédiée mise à jour à chaque image, aucun élément DOM). Confettis à l'écran de résultat quand on capture. Désactivés si le système demande moins d'animations.
- **Sons** synthétisés avec Web Audio (aucun fichier à charger) : coups au but (la note monte avec la série), ratés, compte à rebours, fanfare de capture, alerte. Bouton muet mémorisé.
- **Alertes « ta ville est attaquée »** : les membres de la faction attaquée reçoivent une alerte temps réel (toast + son, notification native du navigateur si l'onglet est en arrière-plan et si autorisée). Anti-spam : une alerte de pression par ville et par défenseur toutes les 20 s ; une capture est toujours signalée. L'alerte suit le joueur quand sa faction change.

**Bots d'animation** (`BOTS_ENABLED=true`, activé par défaut en production) : 40 comptes marqués `is_bot` répartis sur les pays les plus riches en villes, qui mènent des « guerres de frontière » et défendent leur territoire. Même chemin que les joueurs (Lua atomique, flux, deltas, alertes) mais pas de mini-jeu, aucun point de classement, aucune analyse anti-triche. Pause automatique au-delà de `BOT_MAX_ONLINE` (20) connectés et pendant un changement de saison.

**Métriques** : `/metrics` au format Prometheus (trafic par route, parties par issue, captures, alertes, drapeaux anti-triche, bots, joueurs connectés, état de Redis, écritures en attente, saison, CPU/mémoire/boucle d'événements). Accessible uniquement depuis le réseau privé (ou avec `METRICS_TOKEN`), jamais exposé par Caddy. Supervision optionnelle : `MONITORING=1` lance Prometheus + Grafana (dashboard fourni dans `infra/monitoring/`), Grafana n'écoute que sur `127.0.0.1:3030` (tunnel SSH). Les journaux sont du JSON structuré (pino), avec masquage des cookies et en-têtes d'autorisation.

**Commandes `deploy.sh`**

```bash
# mise à jour / premier déploiement
curl -fsSL https://raw.githubusercontent.com/gabinlsc/conquest/main/deploy.sh | sudo DOMAIN=conquest.glsc.fr bash
# changer la configuration (redémarre le serveur) : clés OAuth, bots, durée de saison…
curl -fsSL .../deploy.sh | sudo bash -s -- env GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… BOTS_ENABLED=false
# supervision, revue anti-triche, état, journaux
curl -fsSL .../deploy.sh | sudo MONITORING=1 bash
curl -fsSL .../deploy.sh | sudo bash -s -- anticheat report
curl -fsSL .../deploy.sh | sudo bash -s -- status | logs | down
```

**Activer l'OAuth**

1. Google : console Google Cloud → API et services → Identifiants → ID client OAuth (application Web). Discord : portail développeur → Application → OAuth2.
2. URI de redirection à déclarer : `https://conquest.glsc.fr/api/auth/oauth/google/callback` et `https://conquest.glsc.fr/api/auth/oauth/discord/callback`.
3. `deploy.sh env GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… DISCORD_CLIENT_ID=… DISCORD_CLIENT_SECRET=…` : les boutons apparaissent automatiquement pour chaque fournisseur configuré. Les deux flux (Authorization Code + PKCE, `state` signé) sont testés de bout en bout avec un faux fournisseur ; seule la connexion réelle à Google/Discord ne l'a pas été, faute de clés.
