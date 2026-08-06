### 新增

- **远程访问鉴权**：新增登录关卡（httpOnly + SameSite=Strict 会话 cookie，7 天有效期，单活跃会话互踢）、写操作二次口令与访问审计日志，支撑经公司 VPN 从家里访问办公笔记本上的璇玑。
- **动态 IP 自适应**：`scripts/ip-watch.sh` + launchd 定时项在办公笔记本 DHCP 地址漂移时自动重签 mkcert 证书、重启后端并推送新访问地址（webhook 优先，退回 macOS 横幅），家里无需重装 rootCA。
- **HTTPS 支持**：配置 `XUANJI_TLS_CERT` / `XUANJI_TLS_KEY` 后后端直接以 https 监听，配套 `scripts/remote-cert.sh` 一键签发覆盖多个候选 IP 的自签证书。
- **部署手册**：`wiki/tech/remote-access.md` 给出密钥配置、证书、IP 自适应、鉴权模型速查与验收清单。

### 变更

- **监听地址可配**：`XUANJI_HOST` 默认仍为 `127.0.0.1`；绑定非回环地址时若缺登录口令 / 二次口令 / TLS 证书，或两个口令相同、口令短于 16 字符，后端拒绝启动并逐条打印原因，不再可能在无鉴权状态下暴露到办公网。
- **写操作分级**：派发、定时任务、技能启停、打开外链、关闭会话、周报生成及 WS 派发通道的 start/bg/attach 需二次口令；待办、会话改名/归档/挂起只需登录。`XUANJI_CONFIRM_SCOPE=all` 可提升为全部写操作都要口令。
- **本机使用无感**：来自 `127.0.0.1` 的请求默认免登录，办公室日常体验与改造前一致；未配置 `XUANJI_PASSWORD` 时鉴权整体关闭，等同改造前形态。
- **验收环境隔离**：`preview.sh` 默认以 `XUANJI_ENV_FILE=none` 启动，不再继承宿主的 `~/.xuanji/remote.env`，远程鉴权配置不会漏进隔离验收实例。
- **部署脚本兼容 HTTPS**：`restart.sh` 的就绪探活先试 http 再试 https（自签证书用 `-k`），远程模式下不再因协议不匹配误报「15 秒内未就绪」。
