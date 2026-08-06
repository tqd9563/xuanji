#!/usr/bin/env bash
# 用 mkcert 给办公网 IP 签发璇玑的 HTTPS 证书(零 IT 依赖方案)。
#
#   ./remote-cert.sh              # 用当前办公网 IP + 历史候选 IP 签发
#   ./remote-cert.sh <额外IP>      # 追加指定 IP 一起签
#
# rootCA 一次性装到家里 Windows/手机即可:后续叶证书重签不换 rootCA,家里无需任何操作。
# rootCA 位置:mkcert -CAROOT
set -euo pipefail

CERT_DIR="${XUANJI_CERT_DIR:-$HOME/.xuanji/certs}"
CANDIDATES_FILE="$CERT_DIR/san-list"
CERT="$CERT_DIR/xuanji.pem"
KEY="$CERT_DIR/xuanji-key.pem"

if ! command -v mkcert >/dev/null 2>&1; then
  echo "未找到 mkcert。先装:brew install mkcert && mkcert -install" >&2
  exit 1
fi

mkdir -p "$CERT_DIR"

# 当前办公网 IP:取默认路由所在网卡的 IPv4
current_ip() {
  local iface
  iface=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
  [ -n "$iface" ] && ipconfig getifaddr "$iface" 2>/dev/null || true
}

IP=$(current_ip)
[ -z "$IP" ] && { echo "拿不到当前办公网 IP(未连网?)" >&2; exit 1; }

# SAN 集合 = 历史候选 ∪ 当前 IP ∪ 命令行追加 ∪ 本机回环。
# 多写几个候选,IP 在这些地址间漂移时就不必重签。
touch "$CANDIDATES_FILE"
{
  cat "$CANDIDATES_FILE"
  echo "$IP"
  echo "127.0.0.1"
  echo "localhost"
  for extra in "$@"; do echo "$extra"; done
} | sed '/^[[:space:]]*$/d' | sort -u > "$CANDIDATES_FILE.tmp"
mv "$CANDIDATES_FILE.tmp" "$CANDIDATES_FILE"

# shellcheck disable=SC2046
mkcert -cert-file "$CERT" -key-file "$KEY" $(tr '\n' ' ' < "$CANDIDATES_FILE")
chmod 600 "$KEY"

echo "证书已签发:$CERT"
echo "覆盖地址:$(tr '\n' ' ' < "$CANDIDATES_FILE")"
echo
echo "在 ~/.xuanji/remote.env 里配置:"
echo "  XUANJI_TLS_CERT=$CERT"
echo "  XUANJI_TLS_KEY=$KEY"
echo
echo "家里设备装 rootCA(只需一次):$(mkcert -CAROOT)/rootCA.pem"
