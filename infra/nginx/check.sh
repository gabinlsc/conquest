#!/usr/bin/env bash
# Vérifie que les gabarits nginx se rendent en configurations valides (sans toucher à nginx ni au réseau).
# Usage : bash infra/nginx/check.sh   (nécessite le binaire `nginx`)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

openssl req -x509 -nodes -newkey rsa:2048 -days 1 -subj "/CN=conquest.test" \
  -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null

check() { # $1 = gabarit, $2 = variante http2 ("old" | "new"), $3 = ipv6 ("v6" | "v4")
  local http2_listen="" http2_line="" filter="b"
  if [ "$2" = old ]; then http2_listen=" http2"; else http2_line="http2 on;"; fi
  if [ "$3" = v4 ]; then filter='/\[::\]/d'; fi
  sed -e "$filter" -e "s|__DOMAIN__|conquest.test|g" -e "s|__WEB_PORT__|3100|g" -e "s|__API_PORT__|3101|g" \
      -e "s|__HTTP2_LISTEN__|$http2_listen|g" -e "s|__HTTP2_DIRECTIVE__|$http2_line|" \
      -e "s|/etc/letsencrypt/live/conquest.test/fullchain.pem|$tmp/cert.pem|" \
      -e "s|/etc/letsencrypt/live/conquest.test/privkey.pem|$tmp/key.pem|" "$here/$1" >"$tmp/site.conf"
  printf 'events {}\nhttp {\n  access_log off;\n  include %s/site.conf;\n}\n' "$tmp" >"$tmp/nginx.conf"
  if [ "$http2_line" ] && ! nginx -v 2>&1 | grep -qE '/(1\.(2[5-9]|[3-9][0-9])|[2-9]\.)'; then
    echo "  (ignoré : « http2 on; » demande nginx >= 1.25.1)"; return 0
  fi
  nginx -t -c "$tmp/nginx.conf" -e "$tmp/error.log" -p "$tmp" 2>&1 | tail -1
  nginx -t -c "$tmp/nginx.conf" -e "$tmp/error.log" -p "$tmp" >/dev/null 2>&1
}

for tmpl in conquest.http.conf.tmpl conquest.conf.tmpl; do
  for http2 in old new; do
    for ip in v6 v4; do
      # nginx ne peut pas ouvrir de socket [::] sur une machine sans IPv6 : variante v6 non testable ici.
      if [ "$ip" = v6 ] && ! grep -q . /proc/net/if_inet6 2>/dev/null; then
        echo "$tmpl [$http2, v6] : ignoré (pas d'IPv6 sur cette machine)"; continue
      fi
      echo "$tmpl [$http2, $ip]"
      check "$tmpl" "$http2" "$ip" || { echo "ÉCHEC : $tmpl ($http2, $ip)"; cat "$tmp/error.log" 2>/dev/null || true; exit 1; }
    done
  done
done
echo "Gabarits nginx valides."
