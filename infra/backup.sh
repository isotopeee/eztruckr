#!/usr/bin/env bash
#
# EZTruckr — nightly database backup to Cloudflare R2.
#
# Installed at /opt/eztruckr/infra/backup.sh by the deploy workflow and run by
# cron (see the crontab line in DEPLOYMENT.md). Safe to run by hand at any
# time; it never touches the running database beyond reading it.
#
# RESTORING IS THE POINT OF THIS FILE, and the procedure is in DEPLOYMENT.md
# under "Restoring from backup". A backup nobody has ever restored is a
# hypothesis, not a backup — restore one into a scratch database at least once
# before you need to.

set -euo pipefail

APP_DIR=/opt/eztruckr
COMPOSE="docker compose -f ${APP_DIR}/docker-compose.prod.yml"

cd "$APP_DIR"

# The same .env compose reads, so credentials and bucket names cannot drift
# from the ones the application is using — but READ, never sourced.
#
# `.env` is Compose's format, not shell's, and the two disagree. `MAIL_FROM` is
#
#     MAIL_FROM=EZTruckr <no-reply@mail.optimuslogisticscorp.com>
#
# which bash parses as an assignment followed by a redirection, and dies with
# "syntax error near unexpected token `newline`" — killing this script before
# it takes a single backup, while the stack it is backing up runs perfectly,
# because Compose parses that same line correctly. Sourcing also imports every
# other key, including ones with no business being in this script's environment.
#
# So: pull out exactly the seven values needed, tolerating quoted or bare
# values, and never let the file reach a shell parser.
env_value() {
	sed -n "s/^$1=//p" "${APP_DIR}/.env" | tail -n 1 |
		sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

POSTGRES_USER="$(env_value POSTGRES_USER)"
POSTGRES_DB="$(env_value POSTGRES_DB)"
S3_ENDPOINT="$(env_value S3_ENDPOINT)"
S3_ACCESS_KEY_ID="$(env_value S3_ACCESS_KEY_ID)"
S3_SECRET_ACCESS_KEY="$(env_value S3_SECRET_ACCESS_KEY)"
BACKUP_BUCKET="$(env_value BACKUP_BUCKET)"

: "${POSTGRES_USER:?not found in .env}" "${POSTGRES_DB:?not found in .env}"
: "${S3_ENDPOINT:?not found in .env}" "${BACKUP_BUCKET:?not found in .env}"
: "${S3_ACCESS_KEY_ID:?not found in .env}" "${S3_SECRET_ACCESS_KEY:?not found in .env}"
RETENTION_DAYS="$(env_value BACKUP_RETENTION_DAYS)"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
FILE="eztruckr-${STAMP}.dump"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> Dumping ${POSTGRES_DB}"
# --format=custom, not plain SQL: it is already compressed, it can be restored
# selectively (one table, or schema-only), and pg_restore can parallelise it.
# Piping through the container's own pg_dump guarantees the client version
# matches the server, which plain `pg_dump` from the host would not.
$COMPOSE exec -T postgres \
	pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner \
	>"${TMP}/${FILE}"

# A dump that failed early can still exit 0 through the pipe. Anything under
# 50 KB is not this schema — 32 tables, and the reference data alone exceeds
# that — so treat it as a failed dump rather than uploading it over a good one.
SIZE=$(wc -c <"${TMP}/${FILE}")
if ((SIZE < 51200)); then
	echo "FAILED: dump is only ${SIZE} bytes, refusing to upload it." >&2
	exit 1
fi
echo "    ${FILE} — $((SIZE / 1024)) KiB"

# AWS CLI v2 ≥ 2.23 attaches CRC checksums by default and R2 rejects the
# resulting request, exactly as the SDK does in StorageService. Same fix, same
# reason: only send a checksum where the API mandates one.
r2() {
	docker run --rm \
		-v "${TMP}:/backup" \
		-e AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" \
		-e AWS_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY" \
		-e AWS_DEFAULT_REGION=auto \
		-e AWS_REQUEST_CHECKSUM_CALCULATION=when_required \
		-e AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
		amazon/aws-cli:latest --endpoint-url "$S3_ENDPOINT" "$@"
}

echo "==> Uploading to s3://${BACKUP_BUCKET}/"
r2 s3 cp "/backup/${FILE}" "s3://${BACKUP_BUCKET}/${FILE}"

# ---------------------------------------------------------------------------
# Retention
# ---------------------------------------------------------------------------
# The filenames are UTC ISO-8601, so they sort lexically in time order and the
# cutoff is a string comparison — no date parsing per object, and no dependency
# on R2 reporting a LastModified we would have to trust.
CUTOFF="eztruckr-$(date -u -d "${RETENTION_DAYS} days ago" +%Y-%m-%dT%H%M%SZ)"
echo "==> Pruning backups older than ${RETENTION_DAYS} days"

r2 s3 ls "s3://${BACKUP_BUCKET}/" | awk '{print $4}' | grep -E '^eztruckr-.*\.dump$' |
	while read -r key; do
		if [[ "$key" < "$CUTOFF" ]]; then
			echo "    removing ${key}"
			r2 s3 rm "s3://${BACKUP_BUCKET}/${key}"
		fi
	done

echo "==> Backup complete: ${FILE}"
