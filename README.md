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
