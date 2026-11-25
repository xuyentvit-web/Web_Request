#!/usr/bin/env bash
# Cài Web Request lên máy Ubuntu 22.04/24.04 (ví dụ máy ảo Oracle Cloud Always Free).
# Chạy:  curl -fsSL https://raw.githubusercontent.com/xuyentvit-web/Web_Request/main/deploy/install.sh | sudo bash
# Chạy lại lệnh này bất cứ lúc nào để cập nhật bản mới nhất; dữ liệu được giữ nguyên.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/xuyentvit-web/Web_Request.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/web-request
DATA_DIR=/var/lib/web-request
APP_USER=webrequest

if [ "$(id -u)" -ne 0 ]; then echo "Hãy chạy bằng sudo."; exit 1; fi
export DEBIAN_FRONTEND=noninteractive

echo "==> 1/6 Thêm bộ nhớ swap (máy 1GB RAM cần thêm để cài đặt ổn định)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> 2/6 Cài Node.js 22, git, Caddy"
apt-get update -y >/dev/null
apt-get install -y ca-certificates curl gnupg git debian-keyring debian-archive-keyring apt-transport-https >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y nodejs >/dev/null
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y >/dev/null && apt-get install -y caddy >/dev/null
fi

echo "==> 3/6 Tải mã nguồn"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$DATA_DIR" && chown "$APP_USER":"$APP_USER" "$DATA_DIR" && chmod 700 "$DATA_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH" && git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund >/dev/null

echo "==> 4/6 Tạo dịch vụ chạy nền"
FIRST_RUN=0; [ -f "$DATA_DIR/web-request.db" ] || FIRST_RUN=1
ADMIN_PW=""
if [ "$FIRST_RUN" = 1 ]; then ADMIN_PW="$(head -c 9 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 10)"; fi
cat > /etc/systemd/system/web-request.service <<UNIT
[Unit]
Description=Web Request
After=network.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=DATA_DIR=$DATA_DIR
Environment=ADMIN_PASSWORD=$ADMIN_PW
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable web-request >/dev/null 2>&1
systemctl restart web-request

echo "==> 5/6 Mở cổng 80/443 và cấu hình https"
# Ảnh Ubuntu của Oracle chặn mọi cổng trừ 22 bằng iptables.
for p in 80 443; do
  iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || iptables -I INPUT 5 -p tcp --dport $p -j ACCEPT
done
if command -v netfilter-persistent >/dev/null; then netfilter-persistent save >/dev/null 2>&1 || true; fi
PUBLIC_IP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me)"
DOMAIN="${DOMAIN:-$(echo "$PUBLIC_IP" | tr . -).sslip.io}"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3000 {
		flush_interval -1
	}
}
CADDY
systemctl reload caddy || systemctl restart caddy

echo "==> 6/6 Kiểm tra"
sleep 3
if curl -fsS http://127.0.0.1:3000/ >/dev/null; then echo "App đang chạy."; else echo "App chưa chạy, xem lỗi bằng: sudo journalctl -u web-request -n 50"; fi
if [ "$FIRST_RUN" = 1 ]; then
  # Mật khẩu chỉ dùng cho lần chạy đầu; xoá khỏi file dịch vụ.
  sleep 2
  sed -i 's/^Environment=ADMIN_PASSWORD=.*/Environment=ADMIN_PASSWORD=/' /etc/systemd/system/web-request.service && systemctl daemon-reload
fi

echo
echo "================================================================"
echo " Địa chỉ web:  https://$DOMAIN"
echo "   (lần đầu mở có thể mất 1 phút để cấp chứng chỉ https)"
if [ "$FIRST_RUN" = 1 ]; then
  echo " Đăng nhập:    admin"
  echo " Mật khẩu:     $ADMIN_PW"
  echo "   Ghi lại mật khẩu này, sau đó đổi trong menu tài khoản."
else
  echo " Đã cập nhật lên bản mới nhất, dữ liệu giữ nguyên."
fi
echo "================================================================"
