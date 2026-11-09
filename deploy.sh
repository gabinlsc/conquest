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

compose() {
  # Supervision optionnelle : activée par MONITORING=1 dans .env.
  local files=(-f docker-compose.yml)
  if [ -f "$INSTALL_DIR/.env" ] && grep -q '^MONITORING=1' "$INSTALL_DIR/.env"; then
    files+=(-f docker-compose.monitoring.yml)
  fi
  (cd "$INSTALL_DIR" && docker compose "${files[@]}" "$@")
}

# Écrit ou remplace KEY=VALUE dans .env (valeur échappée pour sed).
set_env() {
  local k="$1" v="$2" f="$INSTALL_DIR/.env" esc
  esc=$(printf '%s' "$v" | sed -e 's/[\\&|]/\\&/g')
  if grep -q "^${k}=" "$f"; then sed -i "s|^${k}=.*|${k}=${esc}|" "$f"; else printf '%s=%s\n' "$k" "$v" >>"$f"; fi
}

case "$CMD" in
  status) compose ps; exit 0 ;;
  logs) compose logs -f --tail=100; exit 0 ;;
  down) compose down; exit 0 ;;
  # Revue anti-triche : ... | sudo bash -s -- anticheat report   |   anticheat unban <userId>
  anticheat) shift; compose exec -T server node dist/cli/anticheat.js "$@"; exit 0 ;;
  # Modifie la configuration puis redémarre le serveur :
  #   ... | sudo bash -s -- env GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy BOTS_ENABLED=false
  env)
    shift
    [ "$#" -gt 0 ] || die "usage : env CLE=VALEUR [CLE=VALEUR ...]"
    [ -f "$INSTALL_DIR/.env" ] || die "Pas encore déployé : lance d'abord le déploiement."
    for kv in "$@"; do
      case "$kv" in *=*) set_env "${kv%%=*}" "${kv#*=}" ;; *) die "Format attendu CLE=VALEUR : $kv" ;; esac
    done
    compose up -d --force-recreate server
    log "Configuration mise à jour, serveur redémarré."
    exit 0
    ;;
  # Connexion Google / Discord : `oauth` vérifie la configuration, `oauth setup` saisit les clés SANS les afficher
  # (ni historique shell, ni liste des processus). Exemple : ... | sudo bash -s -- oauth setup
  oauth)
    shift
    [ -f "$INSTALL_DIR/.env" ] || die "Pas encore déployé : lance d'abord le déploiement."
    oauth_domain=$(grep '^DOMAIN=' "$INSTALL_DIR/.env" | cut -d= -f2)
    if [ "${1:-}" = "setup" ]; then
      [ -r /dev/tty ] || die "Un terminal interactif est nécessaire pour saisir les clés."
      log "Callbacks à déclarer chez le fournisseur AVANT de continuer :"
      log "  Google  : https://$oauth_domain/api/auth/oauth/google/callback"
      log "  Discord : https://$oauth_domain/api/auth/oauth/discord/callback"
      for provider in google discord; do
        upper=${provider^^}
        read -r -p "$provider — Client ID (Entrée pour ignorer) : " oauth_id </dev/tty
        if [ -n "$oauth_id" ]; then
          read -r -s -p "$provider — Client Secret (saisie masquée) : " oauth_secret </dev/tty
          echo
          [ -n "$oauth_secret" ] || die "Secret vide pour $provider."
          set_env "${upper}_CLIENT_ID" "$oauth_id"
          set_env "${upper}_CLIENT_SECRET" "$oauth_secret"
        fi
      done
      unset oauth_secret
      compose up -d --force-recreate server
      log "Serveur redémarré, vérification dans quelques secondes…"
      sleep 8
    fi
    for provider in google discord; do
      upper=${provider^^}
      if grep -q "^${upper}_CLIENT_ID=." "$INSTALL_DIR/.env" && grep -q "^${upper}_CLIENT_SECRET=." "$INSTALL_DIR/.env"; then
        # Le serveur doit répondre par une redirection vers le fournisseur (sans suivre le lien).
        loc=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "https://$oauth_domain/api/auth/oauth/$provider/start" || true)
        case "$loc" in
          302\ https://accounts.google.com/*|302\ https://discord.com/*) log "✔ $provider : configuré et opérationnel" ;;
          *) log "✘ $provider : clés présentes mais le serveur ne redirige pas ($loc) — voir : ... | sudo bash -s -- logs" ;;
        esac
      else
        log "– $provider : non configuré"
      fi
    done
    exit 0
    ;;
  deploy) ;;
  *) die "Commande inconnue : $CMD (deploy|status|logs|down|env|anticheat|oauth)" ;;
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
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-}
GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET:-}
DISCORD_CLIENT_ID=${DISCORD_CLIENT_ID:-}
DISCORD_CLIENT_SECRET=${DISCORD_CLIENT_SECRET:-}
SEASON_WEEKS=${SEASON_WEEKS:-4}
BOTS_ENABLED=${BOTS_ENABLED:-true}
MONITORING=${MONITORING:-0}
GRAFANA_PASSWORD=$(openssl rand -hex 12)
EOF
  umask 022
else
  log "$ENV_FILE existant conservé (secrets inchangés)."
  if [ -n "${DOMAIN:-}" ]; then
    set_env DOMAIN "$DOMAIN"
  fi
  # Options passées à la volée (ex. clés OAuth ajoutées plus tard) : appliquées sans toucher aux secrets existants.
  for key in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET DISCORD_CLIENT_ID DISCORD_CLIENT_SECRET SEASON_WEEKS BOTS_ENABLED MONITORING; do
    if [ -n "${!key:-}" ]; then set_env "$key" "${!key}"; fi
  done
fi
# Grafana a besoin d'un mot de passe dès que la supervision est active (généré si absent).
if grep -q '^MONITORING=1' "$ENV_FILE" && ! grep -q '^GRAFANA_PASSWORD=.' "$ENV_FILE"; then
  set_env GRAFANA_PASSWORD "$(openssl rand -hex 12)"
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
if ! grep -q '^GOOGLE_CLIENT_ID=.' "$ENV_FILE" && ! grep -q '^DISCORD_CLIENT_ID=.' "$ENV_FILE"; then
  log "OAuth non configuré (connexion invité seule). URL de callback à déclarer chez Google / Discord :"
  log "  https://$DOMAIN_FINAL/api/auth/oauth/google/callback"
  log "  https://$DOMAIN_FINAL/api/auth/oauth/discord/callback"
  log "puis : ... | sudo bash -s -- env GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… DISCORD_CLIENT_ID=… DISCORD_CLIENT_SECRET=…"
fi
if grep -q '^MONITORING=1' "$ENV_FILE"; then
  log "Grafana : ssh -L 3030:127.0.0.1:3030 <utilisateur>@<serveur> puis http://localhost:3030 (admin / $(grep '^GRAFANA_PASSWORD=' "$ENV_FILE" | cut -d= -f2))"
fi
docker image prune -f >/dev/null 2>&1 || true
