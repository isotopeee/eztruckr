#!/usr/bin/env bash
#
# EZTruckr — one-time droplet bootstrap. Run ONCE as root on a fresh Ubuntu
# 24.04 droplet, then never again (though running it twice is harmless — every
# step below checks before it acts).
#
#   ssh root@<droplet-ip> 'bash -s' < infra/provision.sh "ssh-ed25519 AAAA... deploy"
#
# The optional argument is the PUBLIC half of the deploy keypair that GitHub
# Actions will authenticate with. Without it the script still runs, and you add
# the key to /home/deploy/.ssh/authorized_keys yourself afterwards.
#
# What this deliberately does NOT do: install the application, write .env, or
# fetch any secret. Nothing here needs a credential, so this script is safe to
# read, safe to re-run, and safe to paste into a support ticket.

set -euo pipefail

DEPLOY_USER=deploy
APP_DIR=/opt/eztruckr
DEPLOY_PUBKEY="${1:-}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
	echo "Run as root: ssh root@<ip> 'bash -s' < infra/provision.sh" >&2
	exit 1
fi

# ---------------------------------------------------------------------------
log "Updating base packages"
# ---------------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq ca-certificates curl gnupg ufw unattended-upgrades

# ---------------------------------------------------------------------------
log "Enabling automatic security updates"
# ---------------------------------------------------------------------------
# This box runs unattended between deploys. Security patches should not wait
# for somebody to remember.
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# ---------------------------------------------------------------------------
log "Installing Docker Engine + Compose plugin"
# ---------------------------------------------------------------------------
# From Docker's own apt repository rather than the get.docker.com convenience
# script, which Docker themselves say not to use in production. This pins us to
# a signed repo that upgrades with the rest of the system.
if ! command -v docker >/dev/null 2>&1; then
	install -m 0755 -d /etc/apt/keyrings
	curl -fsSL https://download.docker.com/linux/ubuntu/gpg |
		gpg --dearmor -o /etc/apt/keyrings/docker.gpg
	chmod a+r /etc/apt/keyrings/docker.gpg

	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
		>/etc/apt/sources.list.d/docker.list

	apt-get update -qq
	apt-get install -y -qq \
		docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
	systemctl enable --now docker
else
	echo "Docker already present: $(docker --version)"
fi

# ---------------------------------------------------------------------------
log "Creating swap"
# ---------------------------------------------------------------------------
# Two Node runtimes and a Postgres on a 4 GB box have comfortable headroom
# right up until they briefly do not. Swap turns "the OOM killer took Postgres
# mid-transaction" into "that request was slow" — it is insurance, not memory,
# and if the stack lives in swap the droplet is simply too small.
if ! swapon --show | grep -q '/swapfile'; then
	fallocate -l 2G /swapfile
	chmod 600 /swapfile
	mkswap /swapfile
	swapon /swapfile
	echo '/swapfile none swap sw 0 0' >>/etc/fstab
	# Prefer reclaiming page cache over swapping a live heap out.
	sysctl -w vm.swappiness=10
	echo 'vm.swappiness=10' >/etc/sysctl.d/99-eztruckr.conf
else
	echo "Swap already configured."
fi

# ---------------------------------------------------------------------------
log "Creating the ${DEPLOY_USER} user"
# ---------------------------------------------------------------------------
# Deploys do not need root. This account can drive Docker and write $APP_DIR,
# and that is the whole of its authority.
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
	adduser --disabled-password --gecos "" "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"

install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
AUTH_KEYS="/home/$DEPLOY_USER/.ssh/authorized_keys"
touch "$AUTH_KEYS"

if [[ -n "$DEPLOY_PUBKEY" ]]; then
	grep -qxF "$DEPLOY_PUBKEY" "$AUTH_KEYS" || echo "$DEPLOY_PUBKEY" >>"$AUTH_KEYS"
	echo "Deploy key installed."
elif [[ -s /root/.ssh/authorized_keys ]]; then
	# No key given: fall back to whatever key you are currently logged in with,
	# so you are never locked out of the account you just created.
	cat /root/.ssh/authorized_keys >>"$AUTH_KEYS"
	sort -u -o "$AUTH_KEYS" "$AUTH_KEYS"
	echo "No key argument given; copied root's authorized_keys."
fi
chown "$DEPLOY_USER:$DEPLOY_USER" "$AUTH_KEYS"
chmod 0600 "$AUTH_KEYS"

# ---------------------------------------------------------------------------
log "Creating ${APP_DIR}"
# ---------------------------------------------------------------------------
install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"
install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR/infra"
# 0700: this holds the Cloudflare origin private key.
install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR/certs"

# ---------------------------------------------------------------------------
log "Configuring the firewall"
# ---------------------------------------------------------------------------
# Postgres is not listed because it must never be reachable from outside the
# compose network. Note that Docker publishes ports by writing DNAT rules that
# bypass ufw's INPUT chain — which is exactly why docker-compose.prod.yml
# publishes only 80 and 443 and leaves the database unpublished. ufw is the
# second lock here, not the first.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status verbose

# ---------------------------------------------------------------------------
log "Hardening SSH"
# ---------------------------------------------------------------------------
# Guarded on a key actually being installed. Turning password auth off with an
# empty authorized_keys would lock everyone out of a box that has no console.
if [[ -s "$AUTH_KEYS" ]]; then
	cat >/etc/ssh/sshd_config.d/99-eztruckr.conf <<'EOF'
PasswordAuthentication no
PermitRootLogin prohibit-password
EOF
	systemctl reload ssh || systemctl reload sshd
	echo "Password authentication disabled."
else
	echo "WARNING: no authorized_keys for $DEPLOY_USER — leaving password auth alone." >&2
fi

log "Done"
cat <<EOF

Provisioned. Next:

  1. Confirm key-based login works BEFORE closing this session:
       ssh ${DEPLOY_USER}@<droplet-ip> 'docker ps'

  2. Put the Cloudflare origin certificate in ${APP_DIR}/certs/
     (the deploy workflow does this from secrets — nothing to do by hand).

  3. Push to main, or run the "Deploy" workflow manually.

EOF
