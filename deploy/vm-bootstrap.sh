#!/usr/bin/env bash
#
# Prepares a fresh Compute Engine VM to run the CIRO Fuel stack.
#
# Everything in here was originally typed by hand on 2026-09-02. That is the
# reason this file exists: a server built by remembering commands is a server
# nobody can rebuild. Run this instead.
#
#   gcloud compute ssh ciro-fuel-prod-vm --zone=me-central1-a --tunnel-through-iap
#   curl -O <this file>   # or scp it
#   sudo bash vm-bootstrap.sh
#
# IDEMPOTENT — safe to re-run. Every step checks whether it has already been
# done, so this doubles as a way to verify an existing VM is fully configured.
set -euo pipefail

REGION="me-central1"
DATA_DEVICE="/dev/disk/by-id/google-ciro-data"   # from --device-name=ciro-data
DATA_MOUNT="/mnt/data"
DEPLOY_DIR="/opt/ciro"

log() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()  { printf '  ✓ %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
log "1/7  Data disk"
# A SEPARATE disk from the boot disk, deliberately: the VM can be deleted and
# rebuilt without touching the databases. Snapshots of this disk are the backup.
if ! blkid "$DATA_DEVICE" >/dev/null 2>&1; then
  mkfs.ext4 -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard "$DATA_DEVICE"
  ok "formatted"
else
  ok "already formatted — left alone"
fi

mkdir -p "$DATA_MOUNT"
mountpoint -q "$DATA_MOUNT" || mount -o discard,defaults "$DATA_DEVICE" "$DATA_MOUNT"
ok "mounted at $DATA_MOUNT"

# `nofail` is not optional. Without it, a VM whose data disk is missing or
# renamed refuses to finish booting and the only way back in is the serial
# console. With it, the machine boots and the problem is a mount you can fix.
if ! grep -q "$DATA_MOUNT" /etc/fstab; then
  echo "$DATA_DEVICE $DATA_MOUNT ext4 discard,defaults,nofail 0 2" >> /etc/fstab
  ok "added to /etc/fstab (nofail)"
else
  ok "already in /etc/fstab"
fi

mkdir -p "$DATA_MOUNT"/{mongo,redis,caddy}
ok "data directories present"

# ─────────────────────────────────────────────────────────────────────────────
log "2/7  Docker"
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
  ok "installed"
else
  ok "already installed"
fi

# ─────────────────────────────────────────────────────────────────────────────
log "3/7  Artifact Registry credentials — for ROOT"
# Deploys run `sudo docker compose pull`, so the credential helper must exist in
# root's docker config. Configuring it only for the interactive user leaves the
# pull unauthenticated, and the error says "Unauthenticated request" without
# hinting that the identity, not the permission, is what is missing.
# No key file is involved: gcloud authenticates as the VM's attached service
# account through the metadata server.
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
ok "root can pull from ${REGION}-docker.pkg.dev"

# ─────────────────────────────────────────────────────────────────────────────
log "4/7  Ops Agent"
# Ships container stdout to Cloud Logging and reports memory and disk metrics,
# neither of which Compute Engine collects on its own.
if ! systemctl is-active --quiet google-cloud-ops-agent 2>/dev/null; then
  curl -sSO https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh
  bash add-google-cloud-ops-agent-repo.sh --also-install
  rm -f add-google-cloud-ops-agent-repo.sh
  ok "installed"
else
  ok "already running"
fi

# ─────────────────────────────────────────────────────────────────────────────
log "5/7  Automatic security updates"
apt-get install -y -qq unattended-upgrades
ok "unattended-upgrades installed"

# ─────────────────────────────────────────────────────────────────────────────
log "6/7  Deployment directory"
# NOT a home directory. CI signs in as its own OS Login user, so `~` resolves
# differently for every identity — and deployment must not depend on which
# person or robot is connecting.
mkdir -p "$DEPLOY_DIR"
chown -R root:docker "$DEPLOY_DIR"
chmod -R g+rw "$DEPLOY_DIR"
ok "$DEPLOY_DIR ready (root:docker, group-writable)"

# ─────────────────────────────────────────────────────────────────────────────
log "7/7  Verify"
docker --version | sed 's/^/  /'
docker compose version | sed 's/^/  /'
df -h "$DATA_MOUNT" | tail -1 | sed 's/^/  /'
systemctl is-active google-cloud-ops-agent 2>/dev/null | sed 's/^/  ops-agent: /' || true

cat <<'NEXT'

▸ Remaining — not automated, and deliberately so:

  1. Copy the deployment files (they live in the repo, not here):
       gcloud compute scp deploy/docker-compose.prod.yml \
         <instance>:/tmp/ --zone=<zone> --tunnel-through-iap
       sudo mv /tmp/docker-compose.prod.yml /opt/ciro/

       gcloud compute scp deploy/Caddyfile \
         <instance>:/tmp/ --zone=<zone> --tunnel-through-iap
       sudo mv /tmp/Caddyfile /mnt/data/caddy/Caddyfile

  2. Start the stack:
       cd /opt/ciro
       sudo docker compose -f docker-compose.prod.yml up -d

  Secrets are NOT handled here and never should be. The application reads them
  from Secret Manager at startup using the VM's attached service account, so
  nothing sensitive is ever written to this disk, this script, or a snapshot.

NEXT
