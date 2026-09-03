# EZTruckr — production deployment

DigitalOcean droplet · Cloudflare DNS + R2 · GitHub Actions · Caddy for TLS.

Everything that **can** be automated **is**. What remains below is the set of steps that
genuinely require a human: creating accounts, proving you own a domain, and copying the
resulting credentials into GitHub once. Budget **60–90 minutes** the first time.

After that, deploying is `git push origin main`.

---

## The shape of it

```
                      ┌──────────────────────────────────────────┐
  browser ──https──►  │  Cloudflare  (proxied, Full strict)       │
                      └───────────────────┬──────────────────────┘
                                          │ https, origin cert
                      ┌───────────────────▼──────────────────────┐
                      │  Droplet — Caddy :443                    │
                      │    /api/*  ─►  api   (NestJS  :4000)     │
                      │    /*      ─►  web   (Next.js :3000)     │
                      │                postgres 18 (no port)     │
                      └───────────────────┬──────────────────────┘
                                          │ S3 API
                            Cloudflare R2 — receipts + backups
```

**One hostname serves both apps.** `eztruckr.optimuslogisticscorp.com` is the API origin _and_
the web origin, split on the `/api` path by Caddy.

That is the single most useful decision here, because it collapses the four URL settings that
`.env.example` warns must always change together — `APP_BASE_URL`, `CORS_ORIGINS`,
`BETTER_AUTH_URL`, `NEXT_PUBLIC_API_URL` — into **one value**. The session cookie becomes
first-party, so it is unaffected by third-party-cookie blocking in Safari and Chrome; CORS never
engages, because nothing is cross-origin; and there is one DNS record and one certificate instead
of two. A separate `api.` subdomain would cost all of that and buy nothing — both processes are
on the same droplet either way.

---

## What you need before starting

|              |                                                          |
| ------------ | -------------------------------------------------------- |
| DigitalOcean | account with billing                                     |
| Cloudflare   | `optimuslogisticscorp.com` already on Cloudflare         |
| GitHub       | this repo pushed (it has **no remote yet** — see step 0) |
| Resend       | account, and access to the domain's DNS (Cloudflare)     |

**Mail is not optional and is the most common way this deployment fails.** There is no password
anywhere in this repository: every account, _including the first administrator you create at
`/setup`_, is activated from an emailed link. A stack with a broken sender is a stack nobody can
sign in to. `docker-compose.prod.yml` refuses to start without `RESEND_API_KEY` and `MAIL_FROM`
for exactly this reason. **Do step 4 before step 8.**

---

## Step 0 — Push the repo to GitHub

The working tree has no git remote, and there is uncommitted phase-9 work on `main`.

```bash
git status
```

Commit what you intend to ship, then:

```bash
gh repo create eztruckr --private --source=. --remote=origin --push
```

> CI runs `pnpm run check` against a real Postgres 18 on every pull request. If the phase-9 work
> is not green, fix it before wiring up the deploy — otherwise the first push to `main` fails at
> the `check` job and never reaches the droplet, which is the workflow behaving correctly.

---

## Step 1 — Create the droplet

DigitalOcean → **Create → Droplet**

| Setting        | Value                                                 |
| -------------- | ----------------------------------------------------- |
| Region         | **Singapore (SGP1)** — closest to Manila              |
| Image          | **Ubuntu 26.04 LTS x64**                              |
| Size           | **Basic → Regular → 2 vCPU / 4 GB / 80 GB** (~$24/mo) |
| Authentication | **SSH key** — upload your public key                  |
| Hostname       | `eztruckr-prod`                                       |

**On the size.** 4 GB is the honest recommendation for Postgres plus two Node runtimes. 2 GB
_can_ work — images are built in GitHub Actions, never on the droplet, so the memory-hungry part
never happens here — but it leaves nothing for a traffic spike and a backup at the same time.
`provision.sh` adds 2 GB of swap either way, as insurance rather than as memory.

**On the release.** 24.04 works identically and is supported to 2029, so either is fine — pick
26.04 only for the longer runway. The risk in a new LTS is unusually small here because the
droplet runs nothing but Docker: Postgres 18, Node 22 and Caddy 2 all arrive as container images,
and the host supplies only a kernel, Docker, `ufw` and `sshd`.

The one thing that would actually break is Docker's apt repository, which `provision.sh` derives
from the release codename — a new Ubuntu with no published repo fails at `apt-get update`.
Confirmed present for 26.04 (`resolute`), carrying `docker-ce` 29.7.2, `containerd.io` 2.3.3 and
`docker-compose-plugin` 5.4.0. Check it yourself before trusting any later release:

```bash
curl -s https://download.docker.com/linux/ubuntu/dists/ | grep -o 'href="[a-z]*/"'
```

If DigitalOcean has not published the image yet, take 24.04 — no file needs changing either way.

Note the droplet's **public IPv4**; every step below calls it `<DROPLET_IP>`.

---

## Step 2 — Provision it

One command, from your laptop, in the repo root. It installs Docker, creates a non-root `deploy`
user, adds swap, configures the firewall, and hardens SSH. It is idempotent — running it twice is
harmless.

First, generate the keypair GitHub Actions will deploy with. **This is a separate key from your
personal one**, so it can be revoked without locking you out:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/eztruckr-optimus-gh-actions-deploy-prod -N "" -C "github-actions-deploy"
```

Then provision, passing the **public** half:

```bash
ssh root@<DROPLET_IP> "bash -s -- '$(cat ~/.ssh/eztruckr-optimus-gh-actions-deploy-prod.pub)'" < infra/provision.sh
```

> **The quoting is load-bearing.** A public key is three words. Passing it _after_ the script
> instead does not deliver it as one argument: ssh joins everything following the host into a
> single command string, which the **remote** shell then re-splits — so the script receives
> `ssh-ed25519` on its own, writes that into `authorized_keys` as a line sshd silently ignores,
> and the next step fails with a bare permission denied. Quoting it inside the remote command
> keeps it whole. `provision.sh` now also reassembles the parts and validates the result, so a
> mis-quoted invocation aborts with an explanation rather than half-configuring the box.

**Before closing that session**, confirm the deploy account works — the script disables password
authentication, so a broken key means a droplet you cannot reach:

```bash
ssh -i ~/.ssh/eztruckr-optimus-gh-actions-deploy-prod deploy@<DROPLET_IP> 'docker ps'
```

---

## Step 3 — Cloudflare: DNS and the origin certificate

### 3a. The DNS record

Cloudflare → `optimuslogisticscorp.com` → **DNS → Add record**

|              |                            |
| ------------ | -------------------------- |
| Type         | `A`                        |
| Name         | `eztruckr`                 |
| IPv4         | `<DROPLET_IP>`             |
| Proxy status | **Proxied** (orange cloud) |
| TTL          | Auto                       |

> **Why the name is flat, and what it would cost to nest it.** `eztruckr.apps.…` reads better as
> a namespace, and it is not free: Universal SSL issues for the apex and **first-level**
> subdomains only — `optimuslogisticscorp.com` and `*.optimuslogisticscorp.com`. A wildcard
> matches exactly one label, so anything two deep falls outside it, gets served an edge
> certificate that does not match, and **shows a warning in every browser**. Nothing in this
> repository can fix that; covering it needs Advanced Certificate Manager or Total TLS, a paid
> Cloudflare add-on.
>
> A single-label name avoids the cost entirely. If a second internal app ever makes the namespace
> worth paying for, enable ACM first, then change the `APP_DOMAIN` variable — no file here needs
> editing either way.

### 3b. SSL/TLS mode

**SSL/TLS → Overview → Configure → Full (strict)**.

Not "Flexible", which would leave Cloudflare→droplet traffic **unencrypted** while the padlock in
the browser suggests otherwise. Not "Full", which encrypts but accepts any certificate, including
one an attacker on the path presents.

### 3c. The origin certificate

**SSL/TLS → Origin Server → Create Certificate**

- Private key type: **RSA (2048)**
- Hostnames: `eztruckr.optimuslogisticscorp.com`
- Validity: **15 years**

Cloudflare shows the certificate and the key **exactly once**. Copy both — they become the
`CF_ORIGIN_CERT` and `CF_ORIGIN_KEY` secrets in step 6, including the
`-----BEGIN/END-----` lines.

> This certificate is trusted by Cloudflare and by nothing else, which is the point: the only
> client that should ever reach the droplet directly is Cloudflare.

**Expiry: `2041-08-11`.** Confirmed live via `-enddate` below.

Read it back off the running server at any time:

```bash
ssh deploy@<DROPLET_IP> 'openssl x509 -in /opt/eztruckr/certs/origin.pem -noout -enddate -subject'
```

### Why this rather than Let's Encrypt

The certificate a browser validates is Cloudflare's **Universal SSL**, which already auto-renews
with no involvement from you. This one secures only the Cloudflare→droplet hop, which no browser
sees — so auto-renewal buys nothing where public trust actually matters.

Auto-renewing it would mean a DNS-01 challenge, which needs a **`Zone:DNS:Edit` API token on the
droplet**. That token covers the whole zone, including `mail.optimuslogisticscorp.com`. Since
every account here is activated from an emailed link, DNS control over the mail subdomain is
account takeover: droplet compromised → rewrite MX/DKIM → intercept invites → activate an
administrator. A stolen origin key only impersonates this one host to Cloudflare. The smaller
credential is worth more than the automation.

It also trades **1 renewal event for ~70**, and needs a custom `xcaddy` image, since the
Cloudflare DNS module is not in the official one.

> **The real weakness is not renewal, it is memory.** One date, 15 years out, that nobody will
> recall. When it lapses, Cloudflare cannot verify the origin under Full (strict) and every
> request returns **526 Invalid SSL Certificate** — a total outage. The uptime check below is
> what turns that from a mystery into a page.
>
> _If you ever turn the orange cloud off_ (DNS-only), this certificate breaks immediately —
> browsers do not trust Cloudflare's Origin CA. Delete the `tls` line from `infra/Caddyfile` and
> Caddy provisions and renews a public Let's Encrypt certificate by itself, with no other change.
> That is the one scenario where Let's Encrypt is the right answer.

---

## Step 4 — Resend: make mail actually work

**Do this before the first deploy.** See the warning above.

1. [resend.com](https://resend.com) → **Domains → Add Domain**.
2. Use a **subdomain**: `mail.optimuslogisticscorp.com`. This isolates the app's sending
   reputation from the company's ordinary email — a bounce storm from EZTruckr should never put
   the main domain's deliverability at risk.
3. Resend gives you DKIM/SPF records. Add them in Cloudflare DNS, **DNS-only (grey cloud)** — mail
   records must not be proxied.
4. Wait for **Verified**.
5. **API Keys → Create**, permission **Sending access**. Copy it — shown once.

Your `MAIL_FROM` is then `EZTruckr <no-reply@mail.optimuslogisticscorp.com>`.

> The default `onboarding@resend.dev` only delivers to the mailbox that owns the Resend account.
> It is fine for a smoke test and useless for inviting staff.

---

## Step 5 — Cloudflare R2: two buckets

Cloudflare → **R2 → Create bucket**. Make **two**:

| Bucket                              | Holds                               |
| ----------------------------------- | ----------------------------------- |
| `eztruckr-optimus-app-prod`         | receipt uploads, written by the API |
| `eztruckr-optimus-app-prod-backups` | nightly `pg_dump`, written by cron  |

**Separate on purpose.** The app writes to the first on every upload; backups must not live
somewhere the application can overwrite them.

Then **R2 → API → Manage API Tokens → Create API Token**:

- Permission: **Object Read & Write**
- Scope: **the two buckets above**, not the whole account. An account-wide token here would let a
  compromised API container reach every bucket you own.

Copy the **Access Key ID**, **Secret Access Key**, and the **S3 endpoint**
(`https://<ACCOUNT_ID>.r2.cloudflarestorage.com` — account-level, with **no bucket name on the
end**; the SDK appends it because path-style addressing is on).

---

## Step 6 — GitHub: secrets and variables

Repo → **Settings → Secrets and variables → Actions**.

### Variables (tab: _Variables_) — not secret, and useful in build logs

| Name           | Value                               |
| -------------- | ----------------------------------- |
| `APP_DOMAIN`   | `eztruckr.optimuslogisticscorp.com` |
| `APP_TIMEZONE` | `Asia/Manila`                       |

### Secrets (tab: _Secrets_)

Generate the two you invent yourself:

```bash
openssl rand -base64 32   # POSTGRES_PASSWORD
openssl rand -base64 32   # BETTER_AUTH_SECRET
```

| Name                   | Where it came from                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `DEPLOY_HOST`          | `<DROPLET_IP>`                                                                          |
| `DEPLOY_SSH_KEY`       | `cat ~/.ssh/eztruckr-optimus-gh-actions-deploy-prod` — the **private** half, whole file |
| `DEPLOY_KNOWN_HOSTS`   | `ssh-keyscan <DROPLET_IP>` — see below                                                  |
| `POSTGRES_PASSWORD`    | generated above                                                                         |
| `BETTER_AUTH_SECRET`   | generated above                                                                         |
| `CF_ORIGIN_CERT`       | step 3c, `-----BEGIN CERTIFICATE-----` block                                            |
| `CF_ORIGIN_KEY`        | step 3c, `-----BEGIN PRIVATE KEY-----` block                                            |
| `S3_ENDPOINT`          | step 5                                                                                  |
| `S3_BUCKET`            | `eztruckr-optimus-app-prod`                                                             |
| `S3_ACCESS_KEY_ID`     | step 5                                                                                  |
| `S3_SECRET_ACCESS_KEY` | step 5                                                                                  |
| `BACKUP_BUCKET`        | `eztruckr-optimus-app-prod-backups`                                                     |
| `RESEND_API_KEY`       | step 4                                                                                  |
| `MAIL_FROM`            | `EZTruckr <no-reply@mail.optimuslogisticscorp.com>`                                     |

For `DEPLOY_KNOWN_HOSTS`:

```bash
ssh-keyscan -t ed25519 <DROPLET_IP>
```

Paste the whole output line. **This is pinned rather than scanned at deploy time on purpose**:
trusting whatever answers on first connection would hand a deploy — every secret above — to
anyone able to get in the middle of it once.

---

## Step 7 — Deploy

```bash
git push origin main
```

Or **Actions → Deploy → Run workflow**. Watch it in the Actions tab. In order it will:

1. **check** — `pnpm run check` against a real Postgres 18
2. **build** — both images, pushed to GHCR, tagged with the commit SHA
3. **deploy** — write `.env` and the certificate from secrets, copy the stack over SSH, apply
   migrations, start, and **wait for both containers to report healthy** before declaring success

Migrations run as their own step, _before_ the new API starts. A failed migration therefore stops
the deploy with the reason on screen while the previous release keeps serving — rather than
crash-looping a container whose real error scrolls past in the logs.

Images are tagged by SHA, never a floating tag, so what the droplet runs is exactly what CI
tested.

---

## Step 8 — Create the first administrator

Open **https://eztruckr.optimuslogisticscorp.com/setup**

Enter your name and email. The system creates one ADMINISTRATOR and **emails you an invite link** —
it deliberately does not show you a password, because there isn't one. Click the link, set a
password (12 characters minimum), sign in.

`/setup` answers **exactly once** in the lifetime of the installation. The flag is written to
`system_setting.initializedAt` and never cleared, so the endpoint cannot be reopened by deleting
users.

> ### If mail is broken, `/setup` refuses and stays open
>
> A failed invite answers **`503`**, quoting whatever the mail provider said, and rolls back — no
> administrator, no `initializedAt`, `/setup` still available. Fix the configuration, redeploy, and
> press it again with the same address.
>
> ```
> The administrator account could not be invited, because the email could not be
> sent: 403 The domain is not verified. Nothing has been set up — fix the mail
> configuration and try again.
> ```
>
> That message names the fault exactly. `403 The domain is not verified` is the likeliest one and
> means step 4 is incomplete — the Resend domain has to show **Verified**, not merely exist.
>
> This is the one endpoint where a recorded-but-not-raised delivery failure would be
> unrecoverable: everywhere else an administrator sees the error and clicks resend, but here the
> administrator IS the failed invite, and the token is stored hashed so the link cannot be
> recovered from the database. Earlier builds returned `204` and stamped the flag, leaving an
> installation nobody could sign in to. If you are running a build from before that fix, the
> recovery is below.

**If the email never arrives**, check the log — the reason is recorded verbatim:

```bash
ssh deploy@<DROPLET_IP> 'cd /opt/eztruckr && docker compose -f docker-compose.prod.yml logs --tail=80 api | grep -i mail'
```

```bash
ssh deploy@<DROPLET_IP> 'cd /opt/eztruckr && docker compose -f docker-compose.prod.yml exec -T postgres psql -U eztruckr eztruckr -c "SELECT \"sentAt\", \"deliveryError\" FROM staff_invitation ORDER BY \"createdAt\" DESC LIMIT 1;"'
```

### Reopening `/setup` after a failed first run

Only needed on an installation stamped by a build predating the `503` rollback above — current
builds leave nothing to clean up.

Fix the Resend configuration and redeploy first, or this just repeats. **Order matters**:
`system_setting.createdBy` points at the administrator with `ON DELETE RESTRICT`, so the user
cannot be removed until the settings row is gone.

```bash
ssh deploy@<DROPLET_IP>
cd /opt/eztruckr
docker compose -f docker-compose.prod.yml exec -T postgres psql -U eztruckr eztruckr <<'SQL'
BEGIN;
DELETE FROM staff_invitation;
DELETE FROM session;
DELETE FROM account;
DELETE FROM system_setting;   -- singleton; recreated by the next initialise
DELETE FROM "user";
COMMIT;
SQL
```

`GET /api/system/status` then reports `{"initialized":false}` and `/setup` works again. Only run
this on an installation that has never had a successful sign-in — it deletes every login.

Everyone else is then invited from **Users** inside the app.

---

## Day-to-day

### Deploying

`git push origin main`. That is the whole procedure.

### Rolling back

Images are tagged by SHA, so a rollback is one line on the droplet:

```bash
ssh deploy@<DROPLET_IP>
cd /opt/eztruckr
sed -i 's/:CURRENT_SHA/:KNOWN_GOOD_SHA/g' .env
docker compose -f docker-compose.prod.yml up -d
```

**A rollback does not undo migrations**, and nothing here will do that for you. If the bad release
included a destructive schema change, restore from backup instead.

Re-running the Deploy workflow on an older commit works too, and is preferable — it puts the
droplet back in a state the repository describes.

### Monitoring

Set up **one** external uptime check. It is the cheapest safeguard here by a wide margin, because
it catches every failure mode this document warns about — expired origin certificate (526), a
crashed container, a full disk, a droplet that never came back from a reboot.

|              |                                                        |
| ------------ | ------------------------------------------------------ |
| URL          | `https://eztruckr.optimuslogisticscorp.com/api/health` |
| Interval     | 5 minutes                                              |
| Healthy when | HTTP 200 **and** body contains `"status":"ok"`         |
| Alert to     | an address that is **not** on this domain              |

The body check matters. `/api/health` answers **200 even when degraded**, deliberately — so
orchestrators can tell "process is serving" from "a dependency is unhappy". A status-code-only
monitor will therefore report green while the database or R2 is down. Match on `"status":"ok"`
and a degraded stack pages you; `{"status":"degraded"}` names which dependency in
`checks.database` and `checks.storage`.

Alert somewhere off this domain, because a mail-path failure is one of the things being watched
for.

UptimeRobot's free tier covers this. Cloudflare Health Checks work too and need no third party.

### Logs

```bash
ssh deploy@<DROPLET_IP> 'cd /opt/eztruckr && docker compose -f docker-compose.prod.yml logs -f --tail=100 api'
```

### A psql prompt

```bash
ssh deploy@<DROPLET_IP>
cd /opt/eztruckr && docker compose -f docker-compose.prod.yml exec postgres psql -U eztruckr eztruckr
```

Postgres publishes **no port**. It is reachable only from inside the compose network, which is why
this goes through `exec` rather than a connection string.

---

## Backups

`infra/backup.sh` runs nightly at **02:00 Manila** (18:00 UTC) from cron, installed and re-asserted
by every deploy. It takes a `pg_dump --format=custom`, refuses to upload anything implausibly
small, ships it to `eztruckr-optimus-app-prod-backups`, and prunes past 30 days.

Run one by hand:

```bash
ssh deploy@<DROPLET_IP> '/opt/eztruckr/infra/backup.sh'
```

Check that the nightly one ran — the log is the only place it reports:

```bash
ssh deploy@<DROPLET_IP> 'tail -40 /opt/eztruckr/logs/backup.log'
```

**The cron log must live somewhere `deploy` can write, and `/var/log` is not that place.** It is
`root:syslog 0775`, and this crontab belongs to `deploy`. A redirection that cannot open its file
fails _before_ the command it redirects, so the cron entry pointing at
`/var/log/eztruckr-backup.log` ran `backup.sh` exactly zero times over its whole life — while
looking correct in `crontab -l`, and while the same script run by hand (no redirection) worked
every time. Cron's "permission denied" went to a local mailbox nobody reads. The log now goes to
`/opt/eztruckr/logs/`, created by `provision.sh` and by the deploy itself, and rotated weekly by
`/etc/logrotate.d/eztruckr`.

### Restoring

**Do this once, deliberately, before you ever need it.** A backup nobody has restored is a
hypothesis. Restore into a scratch database — never straight over production:

```bash
ssh deploy@<DROPLET_IP>
cd /opt/eztruckr
set -a && source .env && set +a

# fetch a specific dump
docker run --rm -v /tmp:/backup \
  -e AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" \
  -e AWS_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY" \
  -e AWS_DEFAULT_REGION=auto \
  -e AWS_REQUEST_CHECKSUM_CALCULATION=when_required \
  amazon/aws-cli --endpoint-url "$S3_ENDPOINT" \
  s3 cp "s3://$BACKUP_BUCKET/eztruckr-2026-08-20T180000Z.dump" /backup/restore.dump

# restore it beside the live database, not over it
docker compose -f docker-compose.prod.yml exec -T postgres \
  createdb -U eztruckr eztruckr_restore
docker cp /tmp/restore.dump "$(docker compose -f docker-compose.prod.yml ps -q postgres)":/tmp/restore.dump
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U eztruckr -d eztruckr_restore --no-owner /tmp/restore.dump
```

Inspect `eztruckr_restore`, and only then decide what to do with it.

**Receipts in R2 are not covered by this.** The dump holds the object _keys_, not the bytes. R2
versioning or a scheduled bucket copy is the answer if receipt loss matters — worth deciding
deliberately rather than discovering.

---

## Notes and gotchas

**Changing the domain needs a rebuild, not a restart.** Next inlines `NEXT_PUBLIC_API_URL` into
the client bundle at build time, so it is a build argument in `deploy.yml`. Update the
`APP_DOMAIN` variable and re-run the workflow; a restart alone re-serves the old value.

**R2 and SDK checksums.** From v3.729 the AWS SDK attaches CRC trailers by default, which R2
rejects. `StorageService` sets `requestChecksumCalculation: 'WHEN_REQUIRED'` to prevent it, and
`backup.sh` sets the CLI's equivalent. Remove either and uploads fail against R2 while
`/api/health` still reports storage `up` — because `HeadBucket` carries no body.

**Nothing on the droplet is edited by hand.** `.env` is regenerated from GitHub secrets on every
deploy, so any manual change is silently reverted by the next one. Change the secret and redeploy.

**Cloudflare caching.** The defaults are correct here: `/_next/static/*` is content-hashed and
safe to cache, and Cloudflare does not cache HTML or API responses without being told to. Do not
add a broad "Cache Everything" rule — it will happily serve one user's data to another.

**Postgres is the Debian image, not Alpine, and that is a correctness choice.** Alpine is musl,
whose `strcoll` is effectively `strcmp` — the database reports `en_US.utf8` and then sorts by raw
byte order. The same seven surnames:

```
musl   De Leon | Dela Rosa | Zamora | abad | bautista | dela Cruz | Ángeles
glibc  abad | Ángeles | bautista | dela Cruz | Dela Rosa | De Leon | Zamora
```

Every staff, client and payee picker sorts by name, so this is visible on screen. It also decides
index correctness: 24 partial unique indexes sit on text columns, and an index is ordered by the
collation that built it. The 180 MB the Alpine image saves is meaningless on an 80 GB droplet.

> **Changing the image does not re-initialise an existing data directory.** A volume created under
> Alpine keeps its musl-ordered indexes, and Postgres will start and quietly use them. On a
> developer machine, recreate it — the dev database is designed to start empty and is set up
> through `/setup`:
>
> ```bash
> docker compose down -v && docker compose up -d
> ```
>
> To keep existing dev data instead, rebuild the indexes in the new collation:
> `REINDEX DATABASE eztruckr;`
>
> Production is unaffected: it has not been deployed yet, so its volume is created under glibc
> from the start. **This is the free moment to make this change** — after go-live it needs a dump
> and restore.

**Containers are named by Compose, not pinned.** No service declares a `container_name`, so the
names are `eztruckr-api-1` and friends — the `eztruckr-` prefix comes from `name: eztruckr` at the
top of the file. Pinning them would only drop the `-1`, and it would make the name **global**
rather than project-scoped, so the prod stack could not be started on any machine already running
the dev one. Address containers by SERVICE name (`docker compose ... ps -q api`), never by a
literal.

**Running the prod stack on a laptop needs `-p`.** Both compose files declare `name: eztruckr`, so
Compose treats them as the same project — and the deploy's `--remove-orphans` would delete your
dev containers as strays. Override the project name at the point of use rather than editing the
file, which would rename the droplet's volumes:

```bash
docker compose -p eztruckr-prod -f docker-compose.prod.yml up -d
```

**`api.eztruckr...` is not needed and would be a downgrade.** See the top of this document.

**A droplet is a single point of failure**, which for an MVP is a reasonable trade and worth
naming out loud. Nightly backups bound the loss to a day; the recovery is a new droplet, step 2,
a redeploy, and a restore.
