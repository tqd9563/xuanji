# 远程访问部署手册(公司 VPN + 应用层鉴权)

> 本文讲怎么装、怎么验、怎么退。方案取舍与威胁模型的完整推导只留在本机规划文档里(不进仓库)。

访问路径:**家里浏览器 → 公司官方 VPN → 办公网 → 办公笔记本上的璇玑**。数据不出办公网,家里只渲染网页。

## 双监听(重要)

后端同时开两个口子,互不影响:

| 口子 | 地址 | 协议 | 用途 |
|---|---|---|---|
| 本机 | `127.0.0.1:7777` | **http**,永远在 | Pake 壳、本机浏览器。流量不出机器,无嗅探威胁 |
| 远程 | `0.0.0.0:7778` | **https**,仅在口令+证书齐备时启用 | 家里经 VPN 访问,全套鉴权 |

本机口子恒为明文回环,**不受远程配置影响**——给它套自签 https 只会让 Pake(WKWebView)因不认 mkcert rootCA 而白屏(2026-08-06 实际踩到)。同一端口无法既 http 又 https(绑 `0.0.0.0:7777` 已包含回环),所以远程用独立端口 7778。

## 0. 默认形态没有变化

不配任何 env 时,璇玑仍是 `127.0.0.1:7777` 的本机独占驾驶舱,无登录、无二次口令,行为与改造前一致。
远程模式**只能由 env 显式开启**;回滚 = 删掉配置文件重启。

## 1. 密钥与配置文件

所有远程配置放 `~/.xuanji/remote.env`(不进仓库,也不进 launchd plist):

```bash
mkdir -p ~/.xuanji && chmod 700 ~/.xuanji
cat > ~/.xuanji/remote.env <<EOF
XUANJI_HOST=0.0.0.0                      # 远程监听器绑定地址;IP 漂移不必改这里
XUANJI_REMOTE_PORT=7778                  # 远程 https 端口(可选,默认 7778)
XUANJI_PASSWORD=$(openssl rand -base64 32)        # 登录口令
XUANJI_CONFIRM_TOKEN=$(openssl rand -base64 32)   # 写操作二次口令
XUANJI_TLS_CERT=$HOME/.xuanji/certs/xuanji.pem
XUANJI_TLS_KEY=$HOME/.xuanji/certs/xuanji-key.pem
XUANJI_NOTIFY_WEBHOOK=                   # 可选:飞书机器人/Discord webhook,IP 变化时推新地址
EOF
chmod 600 ~/.xuanji/remote.env
```

`XUANJI_HOST` 只影响**远程**监听器,用 `0.0.0.0` 而非具体 IP:绑具体 IP 后 DHCP 地址一变就得改配置,绑 `0.0.0.0` 则一劳永逸(只有证书需要跟着 IP 走,由 ip-watch 自动处理)。本机 `127.0.0.1:7777` 那个口子与此无关,恒定存在。

**密钥不写回 `process.env`**:配置文件解析结果只留在后端模块内。曾经写回过,后果是口令被后端 spawn 的每个派发会话继承,派发出去的 Claude 会话及其运行的任意命令都能读到(2026-08-06 实际发生,已修 + 加回归测试)。

两个口令记在密码管理器里。**二次口令建议只记在脑子里、不存在家里那台电脑上**——家庭设备被实时远控时,它是唯一还能挡住派发(=任意命令执行)的东西。

启动时的 fail-closed 校验:绑了非回环地址却缺口令 / 缺 TLS / 两个口令相同 / 口令短于 16 字符,后端**拒绝启动**并逐条打印原因,不会以为开了远程实际在裸奔。

## 2. 证书(mkcert 自签,零 IT 依赖)

```bash
brew install mkcert && mkcert -install          # 一次性
code/backend/scripts/remote-cert.sh             # 按当前办公网 IP 签发
```

- 签发范围记在 `~/.xuanji/certs/san-list`,脚本每次把当前 IP 并入历史候选一起签,IP 在候选集内漂移就不必重签。
- 家里 Windows / 手机装一次 **rootCA**(路径 `mkcert -CAROOT` 下的 `rootCA.pem`)即可。rootCA 稳定不变,**后续叶证书重签不需要家里再做任何事**。
- 纪律:证书告警一律不要点「继续访问」。真遇到告警说明证书与地址失配,回办公室重签,别把 HTTPS 练成摆设。

## 3. 动态 IP 自适应

办公笔记本是 DHCP,地址会随重启/换工位漂移。装上定时项自动兜住:

```bash
node code/backend/scripts/install-ip-watch.mjs      # 每 5 分钟检查一次
node code/backend/scripts/install-ip-watch.mjs --uninstall
```

每次检测到 IP 变化:
1. 新 IP 已在证书 SAN 内 → 只推送新访问地址,不动服务(不打断正在跑的会话);
2. 新 IP 不在 SAN 内 → 自动重签证书 → 重启后端 → 推送新地址。

推送优先走 `XUANJI_NOTIFY_WEBHOOK`(人在家也能收到),没配则退回 macOS 横幅 + `~/.xuanji/ip-watch.log`。

> ⚠️ `ip-watch.sh` 会重启后端,是宿主级操作。**派发会话(`XUANJI_DISPATCH=1`)不得执行**它或 `install-ip-watch.mjs`(防自斩铁律)。

## 4. 生效与回滚

配置就位后由**用户或非派发会话**执行 `./restart.sh`(或 `launchctl kickstart -k gui/$(id -u)/com.xuanji.backend`)。
回滚:`rm ~/.xuanji/remote.env` 再重启,即回到本机独占形态。

建议同时打开 macOS 应用层防火墙,仅放行办公网/VPN 网段访问 **7778**(7777 只绑回环,本就不对外)。

## 5. 鉴权模型速查

| 层 | 机制 | 说明 |
|---|---|---|
| 登录 | httpOnly + Secure + SameSite=Strict cookie | JS 读不到,XSS 偷不走;WS 握手浏览器自动带,不用 query 传 token |
| 会话 | 7 天过期 + **单活跃会话** | 新登录踢掉旧会话,凭证被盗用时本人立刻被踢下线从而察觉 |
| 本机 | 127.0.0.1 免登录 | 办公室日常体验不变;`XUANJI_TRUST_LOOPBACK=0` 可关掉 |
| 写操作 | confirmToken 二次口令 | 默认只拦执行类(见下);`XUANJI_CONFIRM_SCOPE=all` 可提升为全部写操作 |
| 审计 | `access_log` 表 | 远程 IP / 方法 / 路径 / 是否写 / 状态码;**不落任何口令或 session id** |

**默认二次确认范围(exec)**:派发 `/dispatch/*`、定时任务 `/schedules/*`、技能启停、`/open-url`、`/sessions/*/close`、周报生成,以及 WS 派发通道的 `start`/`bg`/`attach`。
待办、会话改名/归档/挂起这类纯自有数据变更只需登录——它们不构成代码执行。

WS 派发通道按连接确认一次:`start`/`bg`/`attach` 校验口令,同一连接内后续 `send`/`permission` 不再反复问(否则每轮对话都要输口令)。攻击者仅有 cookie 时无法 attach 到已有会话继续下指令。

> **维护纪律**:新增任何「会在本机执行代码」的写路由,必须同步加进 `src/auth.ts` 的 `EXEC_WRITE_PATTERNS`,否则它会绕过二次闸。这是 code review 的固定检查项。

## 6. 验收清单

```bash
# 隔离验收(高位端口 + 快照库,不碰生产 7777)
XUANJI_PASSWORD=<32位> XUANJI_CONFIRM_TOKEN=<32位> XUANJI_TRUST_LOOPBACK=0 ./preview.sh
```

1. 未登录访问 `/api/dashboard` → 401,界面显示登录页
2. 错误口令 → 401 且不下发 cookie;正确口令 → cookie 带 `HttpOnly; SameSite=Strict`(HTTPS 下还有 `Secure`)
3. 浏览器 devtools 里 `document.cookie` 读不到会话
4. 第二台设备登录 → 第一台被踢回登录页
5. 派发/定时等高危写操作:无口令 403、口令错 403、口令对放行;新建待办只需登录
6. WS:无 cookie / 伪造 cookie / 已注销 cookie 均被 401 拒绝握手
7. `GET /api/auth/access-log` 有远程 IP 记录,且不含任何口令明文
8. HTTPS 访问无证书告警(家里装过 rootCA 后)
9. 本机 `http://localhost:7777` 仍可用且免登录,Pake 壳与派发通道正常(双监听回归)
10. 后端进程环境不含口令:`ps eww -p <pid> | tr ' ' '\n' | grep -c XUANJI_PASSWORD` 应为 0
