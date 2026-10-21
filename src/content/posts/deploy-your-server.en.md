---
title: "From Bare Metal to HTTPS: A Server Deployment Checklist"
published: 2026-10-21
description: "The order that matters when a fresh VPS lands in your hands: SSH hardening, firewall, Docker, reverse proxy, Let's Encrypt, systemd, backups, monitoring — with commands you can paste and the traps that lock you out."
image: ''
tags: [Ops, Linux, Docker, Nginx, TLS]
category: Tech
draft: false
lang: en
---

The most dangerous moment for a new server is not an attack. It's **the second right after you change a config, drop the SSH session, and can never get back in.**

This walks the real sequence from receiving an IP to serving `https://` — commands, plus a rollback plan at each step. The goal isn't theory; it's not breaking things.

## 1. Three decisions before touching anything

- **Debian 12 or Ubuntu 22.04/24.04 LTS.** Best documentation; Docker, Nginx and certbot are one command each. The CentOS line is no longer a default choice.
- **Prefer x86_64.** ARM is cheaper, but binary availability and old images will cost more time than the savings.
- **2 GB RAM minimum.** A 1 GB box running Docker, Nginx and a database will OOM during an image build.

Before starting, record three things: the IP, the root password (or key), and the console VNC/rescue entry in your provider's panel. **That last one is what saves you** when a config change goes wrong.

## 2. SSH: keep a way back in before hardening

### 2.1 Order matters enormously

The rule is "verify the new way works, then disable the old way." Reversed, a broken key locks you out.

```bash
# local: generate a key if you don't have one
ssh-keygen -t ed25519 -C "me@laptop"

# local: push it up (password still works here)
ssh-copy-id -i ~/.ssh/id_ed25519.pub root@203.0.113.10
```

Verify key-only login:

```bash
ssh -o PasswordAuthentication=no root@203.0.113.10 'echo ok'
```

**Only after you see `ok` should you change anything else.** This is the most important line in this article.

### 2.2 Create a regular user

Running as root long-term means no second chance when you delete the wrong directory:

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh && chmod 700 /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
```

### 2.3 Edit sshd_config

```bash
cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak   # the backup that saves you
```

In `/etc/ssh/sshd_config`:

```ini
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
KbdInteractiveAuthentication no
MaxAuthTries 3
ClientAliveInterval 300
```

**Do not restart yet.** Check syntax first:

```bash
sshd -t
```

If it passes, `systemctl reload ssh` — reload keeps existing connections alive, restart kills them. Open a second terminal, confirm login works, and only then close the first.

### 2.4 On changing the SSH port

Many tutorials tell you to move to 2222 "for security." In reality:

- It **does not improve security** — scanners find it, you just get quieter logs;
- It carries **real risk** — forget the firewall or the cloud security group and you're locked out;
- If your provider has a security group, restricting port 22 by source IP is more effective.

My suggestion: **restrict 22 by source IP in the cloud security group and leave the port alone.** If you insist on changing it, open the new port in both the host firewall and the cloud group first.

## 3. Firewall: open only what's needed

```bash
apt update && apt install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp      # ← must come before enable
ufw allow 80,443/tcp
ufw --force enable
ufw status verbose
```

Run `ufw --force enable` without allowing 22 first and your SSH dies immediately — and survives a reboot. The provider console exists for exactly this.

Docker has a **famous trap**: ports published with `-p` are written into iptables directly, bypassing ufw. `ufw status` may say 5432 is denied while a `docker run -p 5432:5432` Postgres is reachable from the internet.

Bind to loopback instead, which is better practice anyway:

```yaml
ports:
  - "127.0.0.1:5432:5432"    # not "5432:5432"
```

Databases, Redis, and inference servers all bind `127.0.0.1`; only Nginx's 80/443 face the world.

## 4. Base system

```bash
# timezone (logs and certificate validation depend on it)
timedatectl set-timezone Asia/Shanghai
timedatectl set-ntp true
timedatectl status

# automatic security updates
apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades

# log rotation (present by default; confirm limits)
grep -E "rotate|maxsize" /etc/logrotate.conf
```

Clock synchronization matters more than it seems. Drift beyond a few minutes makes TLS handshakes fail with `not yet valid` or `expired` errors that look nothing like a clock problem.

**On swap:** enable 2 GB below 2 GB of RAM to keep the OOM killer from shooting processes at random; on a memory-rich box swap slows GC down. If you enable it, lower `vm.swappiness`:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl -w vm.swappiness=10
```

## 5. Install Docker

Use the official repo, not the distro's old package:

```bash
curl -fsSL https://get.docker.com | sh
```

Then cap log size immediately — this is the **number one cause of full disks**:

```bash
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}
EOF
systemctl restart docker
```

`live-restore: true` keeps containers running while the daemon restarts, so a Docker upgrade doesn't stop your services.

```bash
docker run --rm hello-world
docker info | grep -E "Logging Driver|Storage Driver"
```

## 6. Reverse proxy and HTTPS

Two paths; pick one.

### 6.1 Path A: Caddy (recommended for new projects)

Caddy obtains and renews certificates automatically. The config is three lines:

```txt
# /etc/caddy/Caddyfile
example.com {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
systemctl reload caddy
```

One prerequisite: **the domain's A record already points here.** Until DNS resolves, Caddy retries and logs `no such host`.

### 6.2 Path B: Nginx plus certbot

```bash
apt install -y nginx certbot python3-certbot-nginx
```

Configure the HTTP site first so certbot can validate over port 80:

```nginx
# /etc/nginx/sites-available/app.conf
server {
    listen 80;
    server_name example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/app.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d example.com --redirect -m you@example.com --agree-tos
```

`--redirect` adds the 301 and sets up renewal. Verify renewal actually works — **plenty of people install once and find out six months later when the cert expires and the whole site is blocked**:

```bash
certbot renew --dry-run
systemctl list-timers | grep certbot
```

### 6.3 Headers you must not skip

Without `X-Forwarded-Proto` the backend believes it is on HTTP and generates `http://` callback and redirect URLs, which browsers then block.

Without `X-Forwarded-For` the backend sees only `127.0.0.1`, so rate limiting and access logs are meaningless.

### 6.4 Security headers

```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
```

HSTS is remembered by browsers for the full max-age, so **only enable it once every subdomain serves HTTPS**; rolling back is painful.

## 7. Running non-container services with systemd

Beyond Docker, some things run on the host directly — cron jobs, small daemons, compiled binaries.

```ini
# /etc/systemd/system/myapp.service
[Unit]
Description=My App
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=deploy
Group=deploy
WorkingDirectory=/opt/myapp
EnvironmentFile=/etc/myapp/env
ExecStart=/opt/myapp/bin/server --port 3000
Restart=always
RestartSec=5

# hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/myapp

[Install]
WantedBy=multi-user.target
```

```bash
install -m 600 /dev/null /etc/myapp/env
printf 'DATABASE_URL=postgres://...\n' > /etc/myapp/env
systemctl daemon-reload
systemctl enable --now myapp
systemctl status myapp
journalctl -u myapp -f
```

`Restart=always` with `RestartSec=5` restarts a crashed process within five seconds — more reliable than any watchdog script. `ProtectSystem=strict` makes the filesystem read-only except `ReadWritePaths`, so persistence after a shell compromise is hard.

## 8. Backups: untested backups don't exist

Three layers, all required:

```bash
# 1. logical database dump (daily)
pg_dump -Fc -U postgres app > /var/backups/db/app-$(date +%F).dump

# 2. keep 7 days
find /var/backups/db -name '*.dump' -mtime +7 -delete

# 3. sync offsite (object storage or another machine)
rclone sync /var/backups/db remote:backup/db
```

In crontab:

```txt
30 3 * * * /usr/local/bin/backup-db.sh >> /var/log/backup.log 2>&1
```

The critical step isn't syncing, it's **restoring once in a while**:

```bash
createdb app_restore_test
pg_restore -d app_restore_test /var/backups/db/app-2026-10-21.dump
psql -d app_restore_test -c 'select count(*) from users;'
dropdb app_restore_test
```

A backup you've never restored has unknown reliability. The dump may have been zero bytes for weeks (wrong permissions), may be a broken version, may be missing the one table that matters. Only a restore tells you.

## 9. Monitoring: at minimum, external probing

Monitoring that lives on the box dies with the box. Two things are non-negotiable:

```bash
# 1. local: node_exporter plus a disk watermark check
apt install -y prometheus-node-exporter
df -h | awk '$5+0 > 80 { print "disk warning: " $6 " " $5 }'
```

2. **External probing**: cloud monitoring, UptimeRobot, or a cron on another machine hitting `/health` every minute, alerting to your phone after three failures.

Metrics worth watching, ordered by how often they've caused incidents:

| Metric | Threshold | Consequence |
| --- | --- | --- |
| Disk usage | alert > 80% | Database goes read-only, everything 500s |
| Memory and OOM logs | `dmesg \| grep -i oom` | Processes killed at random; "it restarted itself" |
| Certificate expiry | < 14 days | Browsers hard-block the site |
| 5xx ratio | > 1% | Users leave |
| Queue depth / latency | depends | More insidious than an outage |

## 10. Postmortems: the most common ways servers die

**Disk at 100%.** Usually Docker logs and `journald`. `docker system df` shows it instantly. Cap `max-size` upfront and add a weekly `docker system prune -f --filter until=168h`.

**Expired certificate.** Renewal failed silently once — port 80 closed by a security group, DNS changed, Caddy lost permissions. Alert 14 days ahead instead of trusting auto-renewal.

**SSH lockout.** Config changed without a backup, new port not allowed. Only the provider's VNC gets you back.

**Clock drift.** Shows up as random TLS handshake failures and timestamps that don't line up. `timedatectl status` should say `System clock synchronized: yes`.

**Swap thrashing.** Insufficient memory leads to constant paging, load average in the dozens, even SSH hangs. If `si/so` stay non-zero in `vmstat 1`, that's it.

## 11. Launch checklist

| Area | Check |
| --- | --- |
| Access | Key login verified, root login disabled, password auth disabled |
| Network | ufw enabled with 22/80/443, cloud group consistent, container ports on 127.0.0.1 |
| System | Correct timezone, NTP synced, unattended upgrades on, swap as needed |
| Containers | Docker log limits set, `live-restore` enabled |
| Proxy | Host and `X-Forwarded-*` headers present, 80 redirects to 443, HSTS on |
| TLS | `certbot renew --dry-run` passes, expiry alert configured |
| Services | systemd `Restart=always`, env file mode 600 |
| Data | Backup job running, **restore rehearsed once**, copies synced offsite |
| Monitoring | External probe live, disk/memory/cert alerts actually received |

## Summary

Nothing here is advanced. It's all ordering and detail: **verify before disabling, allow before enabling, rehearse before trusting.**

What keeps a server alive isn't better hardware. It's leaving yourself a way back before every irreversible step.
