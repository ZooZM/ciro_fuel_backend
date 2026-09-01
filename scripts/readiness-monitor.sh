#!/usr/bin/env bash
#
# Steady-state readiness monitor — spec 012, FR-007a/FR-007b, SC-001.
# operations-contract.md §2.1.
#
#   ./scripts/readiness-monitor.sh            # run in the foreground
#   systemd unit: see the bottom of this file
#
# WHY THIS EXISTS
# ---------------
# Open-source nginx cannot poll `/health/ready` — active upstream health checks
# are an nginx Plus feature. nginx's passive `max_fails` detection (see
# nginx/upstream.conf) reacts only to real requests failing, so an instance
# that fails readiness for a reason not every route trips stays in rotation
# indefinitely while readiness has been refusing traffic the whole time.
#
# It REWRITES THE UPSTREAM AND RELOADS. An alert-only monitor leaves a broken
# instance serving users until a human intervenes, which is the situation Story
# 1 exists to end, not a solution to it.
#
# HYSTERESIS IS THE POINT. A single failed poll is a network blip; three
# consecutive ones at a 10s interval is a real condition, detected within 30s
# (SC-001). Recovery needs its own count so an instance that flaps does not
# flap the upstream with it — each reload drops idle keepalive connections.
#
# A NOTE ON WHAT THIS CANNOT DO: it never removes the LAST healthy instance. If
# both fail readiness, the upstream is left as it is and the platform serves
# degraded rather than serving nothing. Emptying an upstream turns a partial
# outage into a total one, and nginx refuses to load a config with an empty
# upstream block anyway.
set -uo pipefail

UPSTREAM_FILE="${UPSTREAM_FILE:-nginx/upstream.conf}"
POLL_INTERVAL="${READINESS_POLL_INTERVAL_SECONDS:-10}"
FAIL_THRESHOLD="${READINESS_FAILURE_THRESHOLD:-3}"
RECOVER_THRESHOLD="${READINESS_RECOVERY_THRESHOLD:-3}"
CURL_TIMEOUT="${READINESS_CURL_TIMEOUT_SECONDS:-3}"
NGINX_RELOAD="${NGINX_RELOAD_CMD:-docker compose -f docker-compose.prod.yml exec -T nginx nginx -s reload}"

# instance name -> the address the MONITOR polls (the host's published port),
# which is not the address nginx proxies to (a compose service name).
declare -A PROBE=(
  [app-1]="http://127.0.0.1:3001/api/v1/health/ready"
  [app-2]="http://127.0.0.1:3002/api/v1/health/ready"
)

declare -A FAILS=()   # consecutive failed polls
declare -A PASSES=()  # consecutive healthy polls
for i in "${!PROBE[@]}"; do FAILS[$i]=0; PASSES[$i]=0; done

log() {
  # Same newline-delimited JSON shape as the application's own records
  # (FR-028), so an incident timeline reads as one stream rather than two.
  printf '{"level":"%s","time":"%s","component":"readiness-monitor","msg":"%s"}\n' \
    "$1" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$2"
}

# An instance is IN the upstream when its line is not commented out.
is_enabled() {
  grep -qE "^[[:space:]]*server .*# instance=$1$" "$UPSTREAM_FILE"
}

enabled_count() {
  grep -cE "^[[:space:]]*server .*# instance=" "$UPSTREAM_FILE"
}

reload_nginx() {
  if $NGINX_RELOAD >/dev/null 2>&1; then
    return 0
  fi
  log error "nginx reload FAILED; upstream file and running config now disagree"
  return 1
}

disable_instance() {
  local name=$1
  if [[ $(enabled_count) -le 1 ]]; then
    # Never empty the upstream. Degraded beats down, and nginx will not load a
    # config whose upstream has no servers.
    log error "$name failed readiness but is the LAST enabled instance; leaving it in rotation"
    return
  fi
  sed -i.bak -E "s|^([[:space:]]*)(server .*# instance=$name)$|\1# DOWN \2|" "$UPSTREAM_FILE"
  log warn "$name removed from upstream after $FAIL_THRESHOLD consecutive readiness failures"
  reload_nginx
}

enable_instance() {
  local name=$1
  sed -i.bak -E "s|^([[:space:]]*)# DOWN (server .*# instance=$name)$|\1\2|" "$UPSTREAM_FILE"
  log info "$name restored to upstream after $RECOVER_THRESHOLD consecutive healthy polls"
  reload_nginx
}

log info "monitoring ${!PROBE[*]} every ${POLL_INTERVAL}s (fail=$FAIL_THRESHOLD recover=$RECOVER_THRESHOLD)"

while true; do
  for name in "${!PROBE[@]}"; do
    # `--fail` is what makes the 503 a non-zero exit. Readiness answers 503
    # both when a dependency is down AND while the instance is draining
    # (FR-005) — the monitor deliberately does not distinguish them, because
    # the correct action is identical: stop sending it traffic.
    if curl -fsS --max-time "$CURL_TIMEOUT" -o /dev/null "${PROBE[$name]}"; then
      PASSES[$name]=$(( PASSES[$name] + 1 ))
      FAILS[$name]=0
      if ! is_enabled "$name" && [[ ${PASSES[$name]} -ge $RECOVER_THRESHOLD ]]; then
        enable_instance "$name"
        PASSES[$name]=0
      fi
    else
      FAILS[$name]=$(( FAILS[$name] + 1 ))
      PASSES[$name]=0
      if is_enabled "$name" && [[ ${FAILS[$name]} -ge $FAIL_THRESHOLD ]]; then
        disable_instance "$name"
        FAILS[$name]=0
      fi
    fi
  done
  sleep "$POLL_INTERVAL"
done

# systemd unit (/etc/systemd/system/ciro-readiness-monitor.service):
#
#   [Unit]
#   Description=Ciro readiness monitor
#   After=docker.service
#
#   [Service]
#   WorkingDirectory=/opt/ciro_fuel
#   ExecStart=/opt/ciro_fuel/scripts/readiness-monitor.sh
#   Restart=always
#   RestartSec=5
#
#   [Install]
#   WantedBy=multi-user.target
#
# Restart=always is load-bearing: if the monitor dies, readiness stops being
# consumed at all and the only detection left is nginx's passive layer — which
# still works, but slowly and only for routes that actually fail.
