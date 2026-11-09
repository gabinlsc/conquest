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
pnpm dev           # web :3000, server :3001
```

Vérifications : `pnpm ci` (format, lint, build, typecheck, tests).

## Déploiement (VPS Ubuntu/Debian)

Le DNS du domaine doit pointer vers le serveur.

```bash
curl -fsSL https://raw.githubusercontent.com/gabinlsc/conquest/main/deploy.sh \
  | sudo DOMAIN=conquest.example.com bash
```

Idempotent : la même commande met à jour. Si nginx/apache occupe déjà les ports 80/443, ajouter `DISABLE_HOST_WEBSERVER=1`. Les secrets sont générés dans `/opt/conquest/.env` et conservés entre les mises à jour.
