#!/bin/bash
# 璇玑 worktree 验收环境:起一套与生产完全隔离的后端 + 前端 dev server,供人工在浏览器验收。
#
# 隔离三件套(任何一条被破坏都可能污染生产,勿改):
#   1) 端口另起高位(默认 37777/35173),永不碰 7777 的常驻后端;
#   2) 数据用宿主库的 sqlite 快照副本,验收里的归档/挂起/改名写不回生产库;
#   3) 前端走 vite dev server,改代码热更新,不动 launchd 部署的静态产物。
#
# 用法:
#   ./preview.sh          启动(重复执行 = 先停后起)
#   ./preview.sh --stop   停止并清理临时数据
#   ./preview.sh --keep-db 复用上次的快照(保留上轮验收里的归档/挂起状态)
set -euo pipefail
cd "$(dirname "$0")"

ROOT="$(pwd)"
SLUG="$(basename "$ROOT")"
RUN_DIR="${TMPDIR:-/tmp}/xuanji-preview/$SLUG"
PID_FILE="$RUN_DIR/pids"
# 生产实例:端口与数据目录都必须避开
HOST_PORT=7777
HOST_DB="$HOME/xuanji/code/backend/data/xuanji.db"

stop() {
  [ -f "$PID_FILE" ] || return 0
  while read -r pid; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done < "$PID_FILE"
  sleep 1
  while read -r pid; do
    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
  done < "$PID_FILE"
  rm -f "$PID_FILE"
}

if [ "${1:-}" = "--stop" ]; then
  stop
  rm -rf "$RUN_DIR"
  echo "✓ 已停止 $SLUG 的验收环境并清理临时数据"
  exit 0
fi

# 端口被占则顺延,支持多个 worktree 同时验收互不打架
pick_port() {
  local p=$1
  for _ in $(seq 1 30); do
    if [ "$p" = "$HOST_PORT" ]; then p=$((p + 1)); continue; fi
    # 两个协议栈都要探:vite 只绑 IPv6([::1]),只查 127.0.0.1 会把已被占用的端口
    # 误判为空闲,vite 随后自己顺延到下一个,而脚本仍打印旧端口(2026-08-05 实际踩到)
    if ! nc -z 127.0.0.1 "$p" 2>/dev/null && ! nc -z ::1 "$p" 2>/dev/null; then echo "$p"; return 0; fi
    p=$((p + 1))
  done
  echo "✗ 找不到可用端口(从 $1 起试了 30 个)" >&2
  exit 1
}

stop # 重复执行时先收掉上一轮,避免端口顺延到越来越高
mkdir -p "$RUN_DIR"

API_PORT=$(pick_port "${XUANJI_PREVIEW_PORT:-37777}")
WEB_PORT=$(pick_port "${XUANJI_PREVIEW_WEB_PORT:-35173}")

echo "» 准备数据快照…"
if [ "${1:-}" = "--keep-db" ] && [ -f "$RUN_DIR/xuanji.db" ]; then
  echo "  复用上次快照(--keep-db)"
elif [ -f "$HOST_DB" ]; then
  rm -f "$RUN_DIR"/xuanji.db*
  # .backup 而非 cp:把 WAL 里尚未落盘的部分一并纳入,且不加锁干扰生产实例
  sqlite3 "$HOST_DB" ".backup '$RUN_DIR/xuanji.db'"
  echo "  已快照宿主库 → $RUN_DIR/xuanji.db(验收中的写入不会回流生产)"
else
  echo "  未找到宿主库,使用空库(看板只显示 agents CLI 会话)"
fi

echo "» 同步依赖…"
pnpm --dir code/backend  install --prefer-offline --silent
pnpm --dir code/frontend install --prefer-offline --silent

echo "» 启动后端(:$API_PORT)…"
XUANJI_PORT="$API_PORT" XUANJI_DATA_DIR="$RUN_DIR" \
  pnpm --dir code/backend start > "$RUN_DIR/backend.log" 2>&1 &
echo $! >> "$PID_FILE"

for i in $(seq 1 30); do
  sleep 1
  curl -sf -m 2 "http://127.0.0.1:$API_PORT/api/health" >/dev/null && break
  if [ "$i" = 30 ]; then
    echo "✗ 后端 30 秒未就绪,日志:$RUN_DIR/backend.log" >&2
    tail -20 "$RUN_DIR/backend.log" >&2
    exit 1
  fi
done
echo "  ✓ 后端就绪"

echo "» 启动前端 dev server(:$WEB_PORT)…"
XUANJI_PORT="$API_PORT" XUANJI_WEB_PORT="$WEB_PORT" \
  pnpm --dir code/frontend dev > "$RUN_DIR/web.log" 2>&1 &
echo $! >> "$PID_FILE"

# vite 可能只绑 IPv6,故用 localhost 而非 127.0.0.1 探活
for i in $(seq 1 30); do
  sleep 1
  curl -sf -m 2 "http://localhost:$WEB_PORT/" >/dev/null && break
  if [ "$i" = 30 ]; then
    echo "✗ 前端 30 秒未就绪,日志:$RUN_DIR/web.log" >&2
    tail -20 "$RUN_DIR/web.log" >&2
    exit 1
  fi
done
echo "  ✓ 前端就绪"

# 生产实例仍在:确认隔离没伤到它(它可能本来就没开,那也不算失败)
if curl -sf -m 2 "http://127.0.0.1:$HOST_PORT/api/health" >/dev/null; then
  echo "  ✓ 生产实例(:$HOST_PORT)健康,未受影响"
fi

cat <<EOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  验收地址   http://localhost:$WEB_PORT
  分支       $(git branch --show-current)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  用 localhost 而非 127.0.0.1(vite 可能只绑 IPv6)
  数据是快照副本,随便点;生产库与 :$HOST_PORT 实例不受影响
  验收完执行:  ./preview.sh --stop
EOF
