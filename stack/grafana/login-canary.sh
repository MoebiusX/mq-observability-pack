#!/bin/sh
# stack/grafana/login-canary.sh — the grafana-login-canary service (curl image).
#
# Observogram's grafana reference pack has a login-success SLI and declares a login canary as its
# synthetic; nothing else in the lab ever logs in through the form (the harness and the reference
# tool use basic auth, which Grafana counts as an authentication, not a login). One POST /login
# with the lab's committed dev credentials every LOGIN_INTERVAL seconds is that canary. One JSON
# line per attempt so the log pipeline files it under service grafana-login-canary.
set -u
URL=${GRAFANA_URL:-http://grafana:3000}
USER=${GRAFANA_USER:-admin}
PASSWORD=${GRAFANA_PASSWORD:-admin}
INTERVAL=${LOGIN_INTERVAL:-300}
while true; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    -d "{\"user\":\"$USER\",\"password\":\"$PASSWORD\"}" "$URL/login" || echo 000)
  printf '{"time":"%s","level":"%s","service":"grafana-login-canary","msg":"login","status":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$([ "$code" = 200 ] && echo info || echo warn)" "$code"
  sleep "$INTERVAL"
done
