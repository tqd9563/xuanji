#!/usr/bin/env bash
# 动态 IP 自适应:办公笔记本的 DHCP 地址变了,自动把远程访问接上。
#
# 每次运行做三件事:
#   1. 比对当前办公网 IP 与上次记录,没变直接退出
#   2. 变了且新 IP 不在证书 SAN 里 → 重签证书(remote-cert.sh)并重启后端
#   3. 推送新的访问地址(飞书/Discord,复用璇玑既有通知通道)
#
# 由 launchd 定时跑(见 install-ip-watch.mjs)。**不要在派发会话里执行**:它会重启后端(防自斩铁律)。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${XUANJI_STATE_DIR:-$HOME/.xuanji}"
CERT_DIR="${XUANJI_CERT_DIR:-$STATE_DIR/certs}"
LAST_IP_FILE="$STATE_DIR/last-ip"
SAN_FILE="$CERT_DIR/san-list"
PORT="${XUANJI_PORT:-7777}"
LABEL="com.xuanji.backend"

mkdir -p "$STATE_DIR"

current_ip() {
  local iface
  iface=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
  [ -n "$iface" ] && ipconfig getifaddr "$iface" 2>/dev/null || true
}

notify() {
  # 复用璇玑的通知适配器;没配通道时静默(日志里仍有记录)
  "$HERE/notify-remote.mjs" "$1" 2>/dev/null || true
}

IP=$(current_ip)
[ -z "$IP" ] && { echo "[ip-watch] 无网络,跳过"; exit 0; }

LAST=$(cat "$LAST_IP_FILE" 2>/dev/null || true)
if [ "$IP" = "$LAST" ]; then
  exit 0
fi

echo "[ip-watch] 办公网 IP 变化:${LAST:-<无>} → $IP"
echo "$IP" > "$LAST_IP_FILE"

# 新 IP 已在证书覆盖范围内 → 只推地址,不动服务(避免无谓重启打断会话)
if [ -f "$SAN_FILE" ] && grep -qx "$IP" "$SAN_FILE"; then
  echo "[ip-watch] 新 IP 已在证书 SAN 内,无需重签"
  notify "璇玑访问地址已变更:https://$IP:$PORT(证书无需更新)"
  exit 0
fi

echo "[ip-watch] 新 IP 不在证书 SAN 内,重签证书并重启后端"
"$HERE/remote-cert.sh" "$IP"

# 宿主级 launchd 任务重启后端;派发会话严禁走到这里(见文件头)
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
  echo "[ip-watch] 后端已重启"
else
  echo "[ip-watch] 未安装 launchd 服务($LABEL),证书已更新但需手动重启后端"
fi

notify "璇玑访问地址已变更:https://$IP:$PORT(证书已重签,家里无需重装 rootCA)"
