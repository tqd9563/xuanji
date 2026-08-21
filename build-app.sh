#!/usr/bin/env bash
# 用 Pake 把璇玑 Web 端打包成 macOS 桌面壳。
# 用法:./build-app.sh          → 产物 Xuanji.dmg 落在仓库根目录
#
# 注意:
# - Pake 必须是 2.6.1。3.x 走 Tauri v2,插件 ACL 会拦掉 notification 调用导致壳内白屏
#   (2026-08-08 已踩,见 worklog)。脚本会硬校验版本,不匹配直接退出。
# - 图标源是矢量 assets/icon1024.png / assets/xuanji.icns,改图标改这两个文件,不要改 favicon.ico。
# - 壳只是加载 http://localhost:7777,前后端改动不用重新打包,重启后端即可。
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="Xuanji"
APP_URL="http://localhost:7777"
ICON="./assets/xuanji.icns"
REQUIRED_PAKE="2.6.1"

command -v pake >/dev/null || { echo "未找到 pake,先装:npm i -g pake-cli@${REQUIRED_PAKE}" >&2; exit 1; }

actual="$(pake -v)"
if [[ "$actual" != "$REQUIRED_PAKE" ]]; then
  echo "pake 版本是 ${actual},本项目必须用 ${REQUIRED_PAKE}(3.x 会白屏)。" >&2
  echo "执行:npm i -g pake-cli@${REQUIRED_PAKE}" >&2
  exit 1
fi

[[ -f "$ICON" ]] || { echo "图标缺失:$ICON" >&2; exit 1; }

echo "打包 ${APP_NAME} ← ${APP_URL}"
pake "$APP_URL" \
  --name "$APP_NAME" \
  --icon "$ICON" \
  --width 1400 \
  --height 900 \
  --hide-title-bar

echo
echo "完成:$(pwd)/${APP_NAME}.dmg"
echo "安装后 Dock 若仍是旧图标,执行:killall Dock"
