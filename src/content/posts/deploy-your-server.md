---
title: 从裸机到 HTTPS：一台服务器的完整部署清单
published: 2026-10-21
description: 新买的 VPS 到手后该按什么顺序配置：SSH 加固、防火墙、Docker、反向代理、Let's Encrypt、systemd 托管、备份与监控。每一步都给可直接粘贴的命令，以及那些「配完就登不上去」的坑。
image: ''
tags: [运维, Linux, Docker, Nginx, TLS]
category: 技术
draft: false
---

一台新服务器最容易出事的时刻，不是被攻击，而是**你刚改完配置、断开 SSH、然后再也连不上**。

这篇文章按真实顺序走一遍：从拿到 IP 到 `https://` 正常访问，每一步都给出命令和回滚办法。目标不是讲原理，是让你照着做不出事。

## 一、开工前先定三件事

选型阶段的三句话：

- **系统用 Debian 12 或 Ubuntu 22.04/24.04 LTS**。文档最多，Docker、Nginx、certbot 都是一条命令的事。CentOS 系已经不是默认选择了（Stream 版本生命周期短）。
- **架构优先 x86_64**。ARM 便宜，但很多二进制、老镜像、商业软件没有 aarch64 版本，踩坑成本大于省下的钱。
- **内存 2G 起**。1G 机器跑 Docker + Nginx + 数据库，构建镜像时几乎必然 OOM。

拿到机器后，先记录三样东西再动手：IP、root 密码（或密钥）、云厂商控制台的 VNC/救援入口。**最后一项是保命的**——配置改坏了只能靠它进系统。

## 二、SSH：先备好退路，再加固

### 2.1 顺序极其重要

标准做法是「先验证新方式能用，再关掉旧方式」。反过来的话，一旦密钥有问题就锁在门外。

```bash
# 本地：生成密钥（已经有就跳过）
ssh-keygen -t ed25519 -C "me@laptop"

# 本地：把公钥传上去（此时还需要密码）
ssh-copy-id -i ~/.ssh/id_ed25519.pub root@203.0.113.10
```

验证不用密码能登录：

```bash
ssh -o PasswordAuthentication=no root@203.0.113.10 'echo ok'
```

**看到 `ok` 才能继续往下改。** 这是全文最重要的一条。

### 2.2 建普通用户

不建议长期用 root 操作，误删系统文件时没有第二次机会：

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh && chmod 700 /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
```

### 2.3 改 sshd 配置

```bash
cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak   # 备份，救命用
```

编辑 `/etc/ssh/sshd_config`，确认这几行：

```ini
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
KbdInteractiveAuthentication no
MaxAuthTries 3
ClientAliveInterval 300
```

改完**不要重启**，先检查语法：

```bash
sshd -t
```

语法通过后用 `systemctl reload ssh`（reload 不会踢掉现有连接，restart 会）。再开一个新终端测试能登录，确认没问题后才关掉旧终端。

### 2.4 关于改 SSH 端口

网上很多教程让你改成 2222「提升安全」。实际上：

- 它**不提升安全性**——扫描器一样能扫到，只是减少了日志噪音；
- 它有**真实风险**——忘了改防火墙、忘了改云安全组，直接锁死；
- 如果云厂商有安全组，直接用安全组限制来源 IP 更有效。

我的建议：**用云安全组限制 22 端口的来源 IP，不改端口**。如果非要改，改之前先把新端口在防火墙和云安全组都放行。

## 三、防火墙：只开需要的

```bash
apt update && apt install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp      # ← 这行必须在 enable 之前！
ufw allow 80,443/tcp
ufw --force enable
ufw status verbose
```

`ufw --force enable` 之前没有放行 22，命令执行完你的 SSH 就断了，而且重启也进不去。云厂商的救援控制台就是为这种情况准备的。

Docker 有个**著名的坑**：容器通过 `-p` 发布的端口，会绕过 ufw 直接写 iptables。也就是说 `ufw status` 显示 5432 是 deny，但 `docker run -p 5432:5432` 起来的 Postgres 从公网照样能连。

解决办法是只监听本地回环，这也是更好的实践：

```yaml
ports:
  - "127.0.0.1:5432:5432"    # 而不是 "5432:5432"
```

数据库、Redis、推理服务一律只绑 `127.0.0.1`，对外只暴露 Nginx 的 80/443。

## 四、基础系统配置

```bash
# 时区（日志时间和证书校验都依赖它）
timedatectl set-timezone Asia/Shanghai
timedatectl set-ntp true
timedatectl status

# 自动安全更新
apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades

# 日志轮转（默认已有，确认上限）
grep -E "rotate|maxsize" /etc/logrotate.conf
```

时间同步比想象中重要。系统时间漂移超过几分钟，TLS 握手会直接失败（证书 not yet valid / expired），而且报错信息完全看不出是时间问题。

**关于 swap**：内存 2G 以下建议开 2G swap，防止 OOM killer 随机杀掉进程；内存充足时 swap 反而会让 GC 变慢。开的话顺手调低 `vm.swappiness`：

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl -w vm.swappiness=10
```

## 五、装 Docker

用官方源，别用发行版仓库里那个老版本：

```bash
curl -fsSL https://get.docker.com | sh
```

装完立刻限制日志大小——这是**磁盘被写满的头号原因**：

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

`live-restore: true` 让 Docker daemon 重启时容器继续运行，升级 Docker 不用停服务。

验证：

```bash
docker run --rm hello-world
docker info | grep -E "Logging Driver|Storage Driver"
```

## 六、反向代理与 HTTPS

两条路，选一条。

### 6.1 路线 A：Caddy（推荐给新项目）

Caddy 自动申请并续期证书，配置只有三行：

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

前提只有一个：**域名的 A 记录已经指向这台机器**。DNS 没生效时 Caddy 会反复失败重试，日志里能看到 `no such host`。

### 6.2 路线 B：Nginx + certbot

```bash
apt install -y nginx certbot python3-certbot-nginx
```

先配好 HTTP 站点（80 端口），让 certbot 能通过 webroot 验证：

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

`--redirect` 会自动加 301 跳转并配好续期。验证续期能跑通（**很多人装完就不管了，半年后证书过期全站挂**）：

```bash
certbot renew --dry-run
systemctl list-timers | grep certbot
```

### 6.3 那几个必须加的请求头

`X-Forwarded-Proto` 不加，后端会以为自己在 HTTP 下，生成的回调链接、重定向地址全是 `http://`，然后被浏览器拦。

`X-Forwarded-For` 不加，后端只能看到 `127.0.0.1`，限流和日志全部失效。

### 6.4 安全响应头

```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
```

HSTS 一旦下发就会被浏览器记住 max-age 这么久，**确认全站都能 HTTPS 再加**，否则回退很痛苦。

## 七、用 systemd 托管非容器服务

Docker 之外，总有些东西要直接跑在宿主机上（定时任务、小脚本、编译好的二进制）。

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

# 安全加固
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

`Restart=always` 加上 `RestartSec=5`，进程崩了五秒后自动拉起，比任何监控脚本都可靠。`ProtectSystem=strict` 让整个文件系统只读，只有 `ReadWritePaths` 里的目录可写——被拿到 shell 之后也很难持久化。

## 八、备份：没有演练的备份等于没有

三层，缺一不可：

```bash
# 1. 数据库逻辑备份（每天）
pg_dump -Fc -U postgres app > /var/backups/db/app-$(date +%F).dump

# 2. 保留 7 天
find /var/backups/db -name '*.dump' -mtime +7 -delete

# 3. 同步到异地（对象存储 / 另一台机器）
rclone sync /var/backups/db remote:backup/db
```

放到 crontab：

```txt
30 3 * * * /usr/local/bin/backup-db.sh >> /var/log/backup.log 2>&1
```

关键的第三步不是「同步」，而是**定期恢复一次**：

```bash
createdb app_restore_test
pg_restore -d app_restore_test /var/backups/db/app-2026-10-21.dump
psql -d app_restore_test -c 'select count(*) from users;'
dropdb app_restore_test
```

没跑过这条命令的备份，可靠性是未知的。dump 文件可能一直是 0 字节（权限不对）、可能是三个月前某个坏版本、可能少了最关键的那张表——只有恢复出来才知道。

## 九、监控：至少要有外部探测

服务器上装监控，机器挂了监控也一起挂，等于没有。最低配的两件事：

```bash
# 1. 本机：node_exporter + 磁盘水位告警
apt install -y prometheus-node-exporter
df -h | awk '$5+0 > 80 { print "磁盘告警: " $6 " " $5 }'
```

2. **外部探测**：用云监控、UptimeRobot、或者另一台机器上的 cron，每分钟请求一次 `/health`，连续失败三次告警到手机。

要盯的指标，按「曾经出过事」的概率排序：

| 指标 | 阈值 | 出事的后果 |
| --- | --- | --- |
| 磁盘使用率 | > 80% 告警 | 写满后数据库只读，全站 500 |
| 内存 + OOM 日志 | `dmesg \| grep -i oom` | 进程被随机杀掉，表现为「服务莫名重启」 |
| 证书到期 | < 14 天 | 浏览器直接拦截，比宕机更吓人 |
| 5xx 比例 | > 1% | 用户流失 |
| 队列 / 延迟 | 视业务 | 比宕机更隐蔽 |

## 十、事故复盘：几个最常见的死法

**磁盘 100%。** 最常见的是 Docker 日志和 `journald`。`docker system df` 一眼能看出来。平时就该配 `max-size`，并加一条 `docker system prune -f --filter until=168h` 的周任务。

**证书过期。** 原因是自动续期某次静默失败了（80 端口被安全组关掉、DNS 换了、Caddy 权限不够）。所以要有到期前 14 天的告警，而不是相信「它应该会自动续」。

**SSH 锁死。** 改配置没留备份、防火墙没放行新端口。解法只有云控制台的 VNC。

**时间漂移。** 表现为 TLS 握手随机失败、日志时间对不上。`timedatectl status` 看 `System clock synchronized: yes`。

**swap 抖动。** 内存不够时系统疯狂换页，负载飙到几十，SSH 都卡。`vmstat 1` 里 `si/so` 持续不为 0 就是它。

## 十一、上线检查清单

| 阶段 | 检查项 |
| --- | --- |
| 访问 | 密钥登录验证通过、root 登录已禁用、密码登录已禁用 |
| 网络 | ufw 已启用且放行 22/80/443、云安全组一致、容器端口只绑 127.0.0.1 |
| 系统 | 时区正确、NTP 同步、自动安全更新开启、swap 按需 |
| 容器 | Docker 日志上限已配、`live-restore` 已开 |
| 代理 | 反代头齐全（Host / X-Forwarded-*）、80 跳 443、HSTS 开启 |
| 证书 | 自动续期 `--dry-run` 通过、到期告警已配 |
| 服务 | systemd `Restart=always`、环境变量文件权限 600 |
| 数据 | 备份任务在跑、**恢复演练做过一次**、备份同步到异地 |
| 监控 | 外部探测在线、磁盘/内存/证书三条告警能收到 |

## 小结

这份清单里没有一条是高深技术，全是顺序和细节：**先验证再关闭、先放行再启用、先演练再相信**。

真正让服务器稳定的，不是买了多好的机器，而是每个「不可逆操作」之前都留了退路。
