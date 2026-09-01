#!/usr/bin/env bash
#
# Rolling deploy — spec 012, FR-012a, SC-002/SC-003.
# operations-contract.md §3.
#
#   ./scripts/rolling-deploy.sh
#
# WHY THIS EXISTS
# ---------------
# `docker compose up` replaces a container by STOPPING it. That severs in-flight
# requests, drops realtime connections and kills background jobs part-way
# through. Every piece of graceful-shutdown machinery this feature builds
# (Story 2) is bypassed by it. Without this script the shutdown work is
# implemented and never exercised, and SC-003 is unreachable.
#
# THE ORDER IS THE WHOLE THING:
#
#   1. Build once, up front. A build failure must not leave the platform
#      half-deployed.
#   2. Per instance, ONE AT A TIME:
#      a. Take it OUT of the upstream and reload — traffic stops arriving.
#      b. SIGTERM it. Readiness flips to 503 (FR-005), in-flight requests
#         finish (FR-008), BullMQ workers release unfinished jobs for
#         redelivery (FR-009), sockets close in an orderly way (FR-010), every
#         destroy hook runs including RedisModule's (FR-011).
#      c. Wait for exit, bounded by SHUTDOWN_DRAIN_MS plus a margin.
#      d. Start the replacement.
#      e. Poll its readiness until 200. ABORT if it never becomes ready — a
#         replacement that cannot start must not take the other instance down
#         with it.
#      f. Put it back in the upstream and reload.
#
# NEVER BOTH AT ONCE. Step 2's serialisation is what makes the deploy invisible;
# replacing both in parallel empties the upstream for the duration.
#
# A SECRET ROTATION IS COMPLETED BY THIS PROCEDURE (FR-044) — secrets are read
# once at startup, so a rolling restart is the adoption mechanism. Rotating a
# TOKEN-SIGNING key is different and is not routine: see operations-contract §5.
#
# STOP THE READINESS MONITOR FIRST, or it will fight this script for the
# upstream file — it sees the instance being drained, decides it is unhealthy,
# and rewrites the same lines. The script refuses to run while it is up.
set -euo pipefail

COMPOSE="${COMPOSE_CMD:-docker compose -f docker-compose.prod.yml}"
UPSTREAM_FILE="${UPSTREAM_FILE:-nginx/upstream.conf}"
INSTANCES=(app-1 app-2)
declare -A PROBE=(
  [app-1]="http://127.0.0.1:3001/api/v1/health/ready"
  [app-2]="http://127.0.0.1:3002/api/v1/health/ready"
)

DRAIN_MS="${SHUTDOWN_DRAIN_MS:-30000}"
DRAIN_TIMEOUT=$(( DRAIN_MS / 1000 + 10 ))   # the app's own deadline, plus margin
READY_TIMEOUT="${DEPLOY_READY_TIMEOUT_SECONDS:-90}"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mABORT: %s\033[0m\n' "$*" >&2; exit 1; }

reload_nginx() { $COMPOSE exec -T nginx nginx -s reload >/dev/null; }

upstream_disable() {
  sed -i.bak -E "s|^([[:space:]]*)(server .*# instance=$1)$|\1# DOWN \2|" "$UPSTREAM_FILE"
  reload_nginx
}

upstream_enable() {
  sed -i.bak -E "s|^([[:space:]]*)# DOWN (server .*# instance=$1)$|\1\2|" "$UPSTREAM_FILE"
  reload_nginx
}

wait_ready() {
  local name=$1 deadline=$(( SECONDS + READY_TIMEOUT ))
  while (( SECONDS < deadline )); do
    if curl -fsS --max-time 3 -o /dev/null "${PROBE[$name]}"; then return 0; fi
    sleep 2
  done
  return 1
}

# ---- Preconditions ---------------------------------------------------------

if pgrep -f readiness-monitor.sh >/dev/null 2>&1; then
  fail "readiness-monitor.sh is running. Stop it first (it rewrites $UPSTREAM_FILE too, and will
       fight this script over the instance being drained):
         sudo systemctl stop ciro-readiness-monitor"
fi

for name in "${INSTANCES[@]}"; do
  curl -fsS --max-time 3 -o /dev/null "${PROBE[$name]}" \
    || fail "$name is not ready BEFORE the deploy starts. Deploying now would leave zero healthy
       instances the moment the other one is taken out of rotation."
done

log "Building the new image"
$COMPOSE build app-1

# ---- The rolling replacement ------------------------------------------------

for name in "${INSTANCES[@]}"; do
  log "[$name] removing from upstream"
  upstream_disable "$name"

  log "[$name] signalling drain (SIGTERM), waiting up to ${DRAIN_TIMEOUT}s"
  # `compose stop -t` sends SIGTERM and waits, escalating to SIGKILL only at the
  # timeout — which is precisely the drain contract. The timeout is the app's
  # OWN deadline plus margin, so a clean drain always wins the race and a forced
  # exit is recorded by the app itself (FR-012) rather than being a silent kill.
  $COMPOSE stop -t "$DRAIN_TIMEOUT" "$name"

  log "[$name] starting the replacement"
  $COMPOSE up -d --no-deps "$name"

  log "[$name] waiting for readiness (up to ${READY_TIMEOUT}s)"
  if ! wait_ready "$name"; then
    # Deliberately leaves the instance OUT of the upstream and stops. The other
    # instance is still serving on the old image; a broken deploy degrades
    # capacity rather than taking the platform down, and an operator has a
    # running system to debug against.
    fail "$name never became ready. It is OUT of the upstream and the deploy has stopped.
       The remaining instance is still serving the previous image.
         logs:     $COMPOSE logs --tail=100 $name
         rollback: git checkout <previous>; $COMPOSE build $name; $COMPOSE up -d $name"
  fi

  log "[$name] restoring to upstream"
  upstream_enable "$name"
done

log "Deploy complete. Restart the readiness monitor:  sudo systemctl start ciro-readiness-monitor"
