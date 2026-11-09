#!/usr/bin/env bash
# CONQUEST — déploiement automatisé sur un VPS Ubuntu/Debian.
#
# Premier déploiement (en root) :
#   curl -fsSL https://raw.githubusercontent.com/gabinlsc/conquest/main/deploy.sh \
#     | sudo DOMAIN=conquest.example.com bash
#
# Mises à jour : relancer exactement la même commande (idempotent).
# Autres commandes : ... | sudo bash -s -- status | logs | down
#
# Variables : DOMAIN (requis) · BRANCH (main) · INSTALL_DIR (/opt/conquest)
#             DISABLE_HOST_WEBSERVER=1 (arrête et désactive nginx/apache de l'hôte)
set -euo pipefail

REPO="${REPO:-gabinlsc/conquest}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/conquest}"
CMD="${1:-deploy}"

log() { printf '\033[1;34m[conquest]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[conquest] ERREUR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "À lancer en root (sudo)."

compose() { (cd "$INSTALL_DIR" && docker compose "$@"); }

case "$CMD" in
  status) compose ps; exit 0 ;;
  logs) compose logs -f --tail=100; exit 0 ;;
  down) compose down; exit 0 ;;
  deploy) ;;
  *) die "Commande inconnue : $CMD (deploy|status|logs|down)" ;;
esac

# ---------- 1. Paquets de base + Docker ----------
if ! command -v apt-get >/dev/null; then die "Seuls Debian/Ubuntu sont supportés."; fi
export DEBIAN_FRONTEND=noninteractive
if ! command -v git >/dev/null || ! command -v curl >/dev/null || ! command -v openssl >/dev/null; then
  log "Installation de git, curl, openssl…"
  apt-get update -qq
  apt-get install -y -qq git curl openssl ca-certificates
fi

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  log "Installation de Docker (script officiel)…"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# ---------- 2. Conflit de ports 80/443 (NGINX / Apache déjà présents ?) ----------
port_busy() { ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q .; }
if port_busy 80 || port_busy 443; then
  # Si c'est déjà notre Caddy (redéploiement), pas de conflit.
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^conquest-caddy'; then
    if [ "${DISABLE_HOST_WEBSERVER:-0}" = "1" ]; then
      log "Arrêt des serveurs web de l'hôte (nginx/apache2)…"
      for svc in nginx apache2 httpd; do
        systemctl disable --now "$svc" >/dev/null 2>&1 || true
      done
    else
      ss -ltnp "( sport = :80 or sport = :443 )" || true
      die "Les ports 80/443 sont occupés (nginx/apache ?). Relance avec DISABLE_HOST_WEBSERVER=1 pour les désactiver, ou libère-les."
    fi
  fi
fi

# ---------- 3. Pare-feu (si ufw est actif) ----------
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  log "Ouverture des ports 22, 80, 443 dans ufw…"
  ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
fi

# ---------- 4. Code source ----------
if [ -d "$INSTALL_DIR/.git" ]; then
  log "Mise à jour du code ($BRANCH)…"
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$INSTALL_DIR" reset --hard FETCH_HEAD
else
  log "Clonage de $REPO dans $INSTALL_DIR…"
  git clone --depth 1 --branch "$BRANCH" "https://github.com/$REPO.git" "$INSTALL_DIR"
fi

# ---------- 5. Configuration (.env) ----------
ENV_FILE="$INSTALL_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  DOMAIN="${DOMAIN:-}"
  if [ -z "$DOMAIN" ] && [ -r /dev/tty ]; then
    read -r -p "Nom de domaine (DNS A déjà pointé vers ce serveur) : " DOMAIN </dev/tty
  fi
  [ -n "$DOMAIN" ] || die "DOMAIN requis (ex: DOMAIN=conquest.example.com)."
  log "Génération de $ENV_FILE avec des secrets aléatoires…"
  umask 077
  cat >"$ENV_FILE" <<EOF
DOMAIN=$DOMAIN
NODE_ENV=production
LOG_LEVEL=info
SESSION_SECRET=$(openssl rand -hex 32)
POSTGRES_USER=conquest
POSTGRES_PASSWORD=$(openssl rand -hex 24)
POSTGRES_DB=conquest
REDIS_PASSWORD=$(openssl rand -hex 24)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
EOF
  umask 022
else
  log "$ENV_FILE existant conservé (secrets inchangés)."
  if [ -n "${DOMAIN:-}" ]; then
    sed -i "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" "$ENV_FILE"
  fi
fi

# ---------- 6. Build + démarrage ----------
log "Build et démarrage des conteneurs (quelques minutes la première fois)…"
compose up -d --build --remove-orphans

log "Attente de la santé du serveur…"
for _ in $(seq 1 60); do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' conquest-server-1 2>/dev/null)" = "healthy" ]; then
    break
  fi
  sleep 2
done

# Import GeoNames au premier déploiement uniquement (idempotent, ne touche pas à la propriété des villes).
log "Import des villes GeoNames (ignoré si déjà fait)…"
compose exec -T server node dist/cli/import-geonames.js --if-empty
compose ps

DOMAIN_FINAL="$(grep '^DOMAIN=' "$ENV_FILE" | cut -d= -f2)"
log "Terminé → https://$DOMAIN_FINAL  (certificat HTTPS émis automatiquement par Caddy au premier accès)"
docker image prune -f >/dev/null 2>&1 || true
