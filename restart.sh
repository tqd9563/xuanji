#!/bin/bash
# 璇玑一键部署重启:依赖同步 → 前端构建 → 重启后端 → 健康检查
# 任何一步失败即中止,不会让旧前端配新后端(或反之)带病上线。
set -euo pipefail
cd "$(dirname "$0")"

# 防自斩铁律(项目 CLAUDE.md):派发会话是后端子进程,重启后端 = 杀死自己
if [ "${XUANJI_DISPATCH:-}" = "1" ]; then
  echo "✗ 派发会话禁止重启后端(会杀死自己的宿主),此步请留给用户执行" >&2
  exit 1
fi

echo "» 同步依赖…"
pnpm --dir code/backend  install --frozen-lockfile --prefer-offline
pnpm --dir code/frontend install --frozen-lockfile --prefer-offline

echo "» 构建前端(含 tsc --noEmit,失败则不重启)…"
pnpm --dir code/frontend build

echo "» 重启后端…"
launchctl kickstart -k "gui/$(id -u)/com.xuanji.backend"

echo "» 等待就绪…"
# 远程模式下后端以 https 监听(自签证书故 -k),普通模式仍是 http:两种都试,谁通算谁
for _ in $(seq 1 15); do
  sleep 1
  if health=$(curl -sf -m 2 http://127.0.0.1:7777/api/health 2>/dev/null) \
    || health=$(curl -skf -m 2 https://127.0.0.1:7777/api/health 2>/dev/null); then
    echo "✓ 后端已就绪:${health:0:120}"
    exit 0
  fi
done
echo "✗ 15 秒内未就绪,查日志:~/Library/Logs/xuanji/backend.err.log" >&2
exit 1
