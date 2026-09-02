#!/usr/bin/env bash
#
# EZTruckr — one-time droplet bootstrap. Run ONCE as root on a fresh Ubuntu
# 26.04 LTS droplet (24.04 works identically), then never again — though
# running it twice is harmless, as every step below checks before it acts.
#
# NOTHING HERE IS PINNED TO A RELEASE. The only version-sensitive line is the
# Docker apt source, which is built from $VERSION_CODENAME, so it follows
# whatever the droplet is. That is also the step most likely to break on a
# brand-new Ubuntu: Docker has historically taken months to publish a repo for
# a fresh release, and until it does `apt-get update` fails outright. Verified
# present for 26.04 (`resolute`) before recommending it.
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

# "$*", NOT "$1". An SSH public key is three words — type, base64, comment —
# and `ssh host 'bash -s' "$(cat key.pub)"` does not deliver it as one
# argument: ssh joins everything after the host into a single command string,
# which the REMOTE shell then re-splits on whitespace. The script was handed
# `ssh-ed25519` as $1 and the rest as $2 and $3, wrote that fragment into
# authorized_keys, and every subsequent login was refused — while the file
# looked non-empty enough to pass the hardening guard below, so password auth
# was disabled on the strength of a key that could never work.
#
# Joining the positional parameters reassembles the key whatever the caller
# quoted, and `validate` immediately below refuses anything that still is not
# a key rather than writing it and hoping.
DEPLOY_PUBKEY="${*:-}"

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
# `cron` is present on the stock Ubuntu image and absent from some minimal
# and container-derived ones. The nightly backup is a crontab entry, so a
# box without the daemon takes no backups while looking entirely healthy.
apt-get install -y -qq ca-certificates curl gnupg ufw unattended-upgrades cron
systemctl enable --now cron

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
	# REFUSE ANYTHING THAT IS NOT A KEY. Writing a malformed line is worse than
	# writing nothing: sshd silently skips it, the file is non-empty so the
	# hardening step below happily turns off password authentication, and the
	# failure surfaces later as a bare "Permission denied (publickey)" with no
	# indication that the key was mangled on the way in.
	if ! printf '%s\n' "$DEPLOY_PUBKEY" | ssh-keygen -l -f - >/dev/null 2>&1; then
		cat >&2 <<EOF

ERROR: that is not a valid SSH public key.

  got: ${DEPLOY_PUBKEY}

An SSH public key is three words, and \`ssh host 'bash -s' < script "\$(cat
key.pub)"\` splits it apart. Quote it inside the remote command instead:

  ssh root@<ip> "bash -s -- '\$(cat ~/.ssh/mykey.pub)'" < infra/provision.sh

Nothing has been changed. Fix the invocation and run this again.
EOF
		exit 1
	fi

	# Drop any previously-written malformed lines before adding the good one, so
	# re-running this after a bad invocation leaves a clean file.
	if [[ -s "$AUTH_KEYS" ]]; then
		while IFS= read -r line; do
			[[ -z "$line" ]] && continue
			printf '%s\n' "$line" | ssh-keygen -l -f - >/dev/null 2>&1 && printf '%s\n' "$line"
		done <"$AUTH_KEYS" >"${AUTH_KEYS}.clean"
		mv "${AUTH_KEYS}.clean" "$AUTH_KEYS"
	fi

	grep -qxF "$DEPLOY_PUBKEY" "$AUTH_KEYS" || echo "$DEPLOY_PUBKEY" >>"$AUTH_KEYS"
	echo "Deploy key installed and verified."
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
# Cron output goes here rather than /var/log, which the deploy user cannot
# write to. A cron line redirecting into a file it cannot create does not run
# the command at all, which is how the nightly backup silently never happened.
install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR/logs"

# ---------------------------------------------------------------------------
log "Rotating ${APP_DIR}/logs"
# ---------------------------------------------------------------------------
# Small — a few lines a night — but it is appended to forever, and an unrotated
# log on a 4 GB droplet is a slow leak with a date on it.
cat >/etc/logrotate.d/eztruckr <<EOF
${APP_DIR}/logs/*.log {
	weekly
	rotate 8
	compress
	missingok
	notifempty
	copytruncate
	su ${DEPLOY_USER} ${DEPLOY_USER}
}
EOF

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
