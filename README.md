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
