# 反向隧道方案:让璇玑从任意端可访问

> 状态:方案设计(未实施)
> 目标:让工作笔记本上的璇玑(`127.0.0.1:7777`)能被手机 4G/5G、家里电脑等任意公网端访问,同时不触碰公司办公网安全红线、不依赖公司 VPN/Tailscale。

---

## 1. 背景与痛点

璇玑是跑在工作笔记本上的单用户 Web 应用(Hono + ws,绑定 `127.0.0.1:7777`),通过 `@anthropic-ai/claude-agent-sdk` 与 Claude 交互。痛点:

- 只能在笔记本本机浏览器访问
- 想从**手机(4G/5G)、家里电脑**访问,但笔记本在公司办公网内,无公网 IP,外部不可达

### 已排除的方案

| 方案 | 排除原因 |
|---|---|
| Tailscale / ZeroTier / WireGuard 等 overlay VPN | **公司 IT 明确禁用**,理由是会带来办公网安全问题;且属于合规红线,不值得为个人便利冒险 |
| 公网 IP + 端口转发(直连笔记本) | 笔记本在公司 NAT 后,办公网不可能给笔记本开公网入站 |
| 公司官方 VPN 拨回办公网 | 手机拨公司 VPN 体验差/不支持;家里电脑装公司 VPN 也受限;且等于把办公网网段暴露给应用,IT 大概率不批 |

---

## 2. 核心思路:反向隧道(出站 WSS)

**不暴露办公网,让笔记本主动出站拨一条隧道到公网中继。**

```
[手机/家里电脑] ──HTTPS──▶ [公网中继 relay] ◀──WSS 出站隧道── [工作笔记本]
                                │                                │
                                └── 请求经隧道编帧转发 ──────────▶│
                                    回灌 127.0.0.1:7777(璇玑)     │
```

### 为什么这能过公司网络红线

| 维度 | overlay VPN(被禁) | 反向隧道(可行) |
|---|---|---|
| 连接方向 | 建立办公网 ↔ 外部网络的**双向 overlay 隧道** | 笔记本**出站**拨一条 HTTPS/WSS,与访问网站无异 |
| 网络形态 | 虚拟网卡,办公网里出现一个"陌生子网" | 一条 443 出站连接,防火墙层面与普通网页请求不可区分 |
| 暴露面 | 办公网设备可被外部寻址 | 办公网**不可被外部寻址**,永远只有笔记本主动发起 |

公司自己的 AgentDeck relay(`pgame-client-agent-deck-relay.lilithgame.com`)每天就靠笔记本上的出站 WSS 隧道工作——公司防火墙必然放行出站 HTTPS,这是它自己产品活下来的前提。反向隧道不建立"办公网到外部"的连接,不产生 IT 担心的安全问题。

### 关键洞察

笔记本没有公网 IP、只能主动出站 → 它永远当不了"被访问方"。**必须有一个"双方都能到达的公网可达中间点"**,这个点绕不开,但它的**形态有四种**(见 §7),其中只有一种是"自己买的 VPS"。

---

## 3. 整体架构

三个组成部分:

```
┌─────────────┐   HTTPS    ┌──────────────┐   WSS 出站   ┌──────────────────┐
│ 手机/家里电脑 │ ─────────▶ │ 公网中继 relay │ ◀──────────── │ 璇玑后端 + TunnelClient │
│ (任意网络)   │            │ (隧道注册+转发) │ ──── 帧协议 ───▶ │ (笔记本,127.0.0.1:7777) │
└─────────────┘            └──────────────┘              └──────────────────┘
       ▲                       │ 认证层(PIN/令牌)                    ▲
       └───────────────────────┴────────────────────────────────────┘
```

| 组件 | 位置 | 职责 |
|---|---|---|
| **relay 中继** | 公网(见 §7 四种形态) | 维护 `machineId → WebSocket` 注册表;把公网 HTTP 请求编帧转发给对应机器,再把响应帧写回公网 |
| **TunnelClient** | 璇玑后端进程内(新增) | 出站 WSS 拨号、心跳、重连、背压;接收 relay 的 `req` 帧回灌本机,响应编帧送回 |
| **认证层** | relay 侧(主)+ 璇玑侧(纵深) | 机器令牌(笔记本↔relay)+ PIN(客户端↔relay);远端请求强制视为非本地 |

### 与现有璇玑的接口

- 璇玑**继续只绑定 `127.0.0.1:7777`,代码几乎不用动**
- TunnelClient 回灌请求时用 `host: 127.0.0.1:7777`,走完整 HTTP 栈
- `/ws`(变更推送)与 `/ws/dispatch`(派发双向流)两条 WebSocket 通道通过隧道透传(见 §5)
- 可用一个独立的 `tunnel.ts` 模块 + 配置开关启动,不影响本机使用形态

---

## 4. 帧协议(隧道内 JSON over WSS)

参考 AgentDeck gateway 的 `tunnel-client.js` 协议(MIT),完全可移植:

### Relay → 机器(下行请求)

| 帧 | 字段 | 说明 |
|---|---|---|
| `{t:'req', id, method, path, headers, body}` | `id` 请求 ID;`body` 为 base64 | 公网请求进入,转发给机器 |
| `{t:'cancel', id}` | — | 公网侧断开,通知机器取消在途请求 |

### 机器 → Relay(上行响应)

| 帧 | 字段 | 说明 |
|---|---|---|
| `{t:'res-head', id, status, headers}` | 状态码 + 响应头 | 先发头 |
| `{t:'data', id, chunk}` | `chunk` 为 base64 | 响应体分块(64KB 粒度) |
| `{t:'end', id}` | — | 响应结束 |
| `{t:'err', id, message}` | — | 上游错误 |

### 心跳 / 保活

| 机制 | 参数 |
|---|---|
| WebSocket ping/pong | 30s 一次;连续 2 次 pong 丢失 → `terminate()` 强制重连 |
| 应用层心跳 | relay 可发 `{t:'ping'}` → 机器回 `{t:'pong'}`(穿透中间代理) |
| 重连策略 | 1s 起步指数退避 → 5s 封顶;±25% 随机抖动(避免中继滚动时全员同步重连打洪峰) |

### 背压

机器侧 WS 发送缓冲 > 4MB → `res.pause()` 暂停上游;降到 1MB 恢复。防止慢公网拖垮本机进程。

---

## 5. 关键难点:WebSocket 双向流透传

璇玑的 `/ws/dispatch` 是**双向流**(client 发 `{op:'start'/'attach'/...}`,服务端推 `DispatchEvent`),隧道协议必须支持 **101 升级后的双向透传**。两种实现方式:

### 方式 A:隧道内再包一层 WS(推荐,改动最小)

```
公网客户端 WS ──relay──▶ 机器侧 TunnelClient ──WS──▶ 璇玑 /ws/dispatch
```

- relay 检测到 `req` 帧带 `upgrade: websocket` → 不按普通 HTTP 转发,而是在 relay 与机器间**再建立一条对应通道**,把公网 WS 帧原样编帧送过去
- 帧协议扩展(可选简化版,直接透传 raw bytes):

| 帧 | 说明 |
|---|---|
| `{t:'ws-open', id, path, headers}` | 请求升级 |
| `{t:'ws-msg', id, data(base64)}` | 双向消息帧 |
| `{t:'ws-close', id, code, reason}` | 关闭 |

- 机器侧收到 `ws-open` → 用 `ws` 库向 `127.0.0.1:7777/ws/dispatch` 发起真实连接 → 之后双向转发 `ws-msg`

**优点**:璇玑后端**零改动**,`ws.ts` 的现有逻辑(attach/replay/审批)完全复用。
**缺点**:隧道内多一跳 WS,但同机 loopback,开销可忽略。

### 方式 B:HTTP 流式泛化(不推荐,复杂度高)

把 `res-head/data/end` 泛化为"任意流",WS 帧当二进制流处理。需要对 WS 的握手头、mask、ping/pong 帧做完整解析,工程量大且易错。**不采用**。

### 决策

采用 **方式 A**。理由:复用璇玑全部现有 WS 逻辑,隧道层只做"字节搬运",协议简单可靠。

---

## 6. 认证与安全模型

### 6.1 机器令牌(笔记本 ↔ relay)

- 笔记本生成**随机 machine-token**(32+ 字节随机串),写入 `~/.xuanji/tunnel.env`(chmod 600)
- 隧道握手时放 `Authorization: Bearer <token>` + `x-deck-machine-id`(hostname)
- relay 校验通过才注册机器;token 泄漏可吊销重签

### 6.2 PIN(客户端 ↔ relay)

借鉴 AgentDeck AuthGate 的 `isRelayForwarded` 思想:

- **回灌请求强制视为"非本地"** → 公网访问者必须过 PIN
- relay 侧:未带有效 PIN 的请求 → 返回 401 + 登录页
- 6 位 PIN 由用户在 relay 配置,哈希存储;可选登录限流(失败 5 次锁 5 分钟)

### 6.3 防伪造(借鉴 AuthGate 的 tunnel-secret)

- relay 回灌给机器的请求必须带 `x-forwarded-for`(远端 IP)
- 机器侧校验:回灌请求必须来自**本机 loopback** + 带 `x-deck-tunnel-secret`(进程内随机,只发给隧道客户端)
- 双重校验杜绝本机其他进程/SSRF 伪造 xff 冒充本地放行

### 6.4 纵深防御(可选,后续叠加)

即使隧道被攻破,璇玑侧仍可保留登录/二次闸/审计(即既有鉴权改造的方向)。隧道负责"传输可达",应用层负责"纵深安全",两者互补不冲突。

---

## 7. 中继(relay)的四种形态

"公网可达的中间点"绕不开,但形态可选:

| 形态 | 条件 | 成本 | 评价 |
|---|---|---|---|
| **① 自建 VPS** | 有一个云服务器 | ¥30-60/月 | 最可控;国内可选地域延迟低;推荐 |
| **② 家里设备当 relay** | 家里宽带有**公网 IPv4**(需实测),配 DDNS | 0 元 | 手机在家连 WiFi 直连、出门走 DDNS;需要家里常开设备 |
| **③ Cloudflare Tunnel** | 注册 CF 账号 + 免费域名 | 0 元 | 笔记本 `cloudflared` 一条命令;国内直连 CF 延迟高、偶尔不稳 |
| **④ 自建中继程序 + 任意公网主机** | 有任意公网主机 | — | 形态①的变体,协议自研 |

### 家里网络现状(2026-08 实测)

- 手机 4G/5G + 家里 WiFi 为主要访问场景 → 任何公网中继都可达
- **家里主路由 WAN 口是 `192.168.x.x`** → TP-Link 是二级路由,公网出口在运营商光猫上
- 光猫是否拿到公网 IP **待测**:登录 `http://192.168.1.1`(光猫背面账号)看 WAN 信息
  - 若是 `100.64.x / 10.x / 172.16~31.x` → 运营商大内网(CG-NAT),家里做不了中继,只能 VPS/CF
  - 若是公网段 → 光猫上配端口转发/DMZ 到 TP-Link → 形态②可行
- ⚠️ **测公网 IP 必须用手机连家里 WiFi(关 VPN)测**,工作笔记本上的 CorpLink/Tailscale 虚拟网卡会污染结果

### 建议路线

1. **先验证价值**:Cloudflare Tunnel 今天就能用(笔记本一条命令,手机 4G 可访问),零成本
2. **值得投入再升级**:按家里公网 IP 实测结果,选形态②(0 元)或形态①(VPS)

---

## 8. 实施计划(文件级改动清单)

> 基于形态①自建 VPS relay + 方式 A(WS 透传),璇玑侧改动最小。

### 8.1 中继端(独立仓库/目录,Node.js,约 250 行)

```
relay/
├── package.json          # ws 依赖
├── src/
│   ├── server.ts         # HTTP 入口:公网请求 → 找机器 → 编帧转发;WS 升级 → ws-open 透传
│   ├── registry.ts       # machineId → WebSocket 注册表(握手时 register)
│   ├── auth.ts           # PIN 校验 + 机器令牌校验 + 限流
│   └── frames.ts         # req/res-head/data/end/err + ws-open/ws-msg/ws-close 帧编解码
├── .env                  # PIN 哈希、机器令牌白名单、端口
└── README.md
```

### 8.2 璇玑后端(新增 1 个模块 + 配置)

```
code/backend/src/
├── tunnel.ts             # 新增:TunnelClient(移植 AgentDeck tunnel-client.js 核心,~250 行)
│                         #   - 出站 WSS 拨号 + Bearer token
│                         #   - 30s ping/重连退避/背压(直接复用)
│                         #   - 处理 req 帧 → http.request 回灌 127.0.0.1:7777
│                         #   - 处理 ws-open → 连本机 /ws、/ws/dispatch → 双向透传
├── config.ts             # 追加 XUANJI_TUNNEL_URL / XUANJI_TUNNEL_TOKEN(空 = 隧道关闭,默认形态不变)
└── index.ts              # 启动时若配置了隧道 → new TunnelClient().start()
```

### 8.3 部署

| 端 | 动作 |
|---|---|
| VPS | `pnpm install && pnpm start`(可 systemd 常驻);配 HTTPS(域名 + certbot 或反代) |
| 笔记本 | 填 `~/.xuanji/tunnel.env` → 重启后端 → 隧道自动拨号,launchd 常驻自愈 |
| 手机 | 浏览器访问 `https://<relay域名>/` → 输 PIN → 进璇玑驾驶舱 |

### 8.4 验收标准

1. 本机形态不变:不配隧道 env 时,`127.0.0.1:7777` 行为与改造前完全一致
2. 手机 4G:`https://<relay域名>/` 能打开驾驶舱、登录 PIN 后 `/api/dashboard` 200
3. `/ws/dispatch` 双向流:手机端发起 `start`/`attach`,能看到 Claude 流式回复
4. 断网重连:笔记本 WiFi 断开再连,隧道 5s 内自动恢复,期间请求不丢(或明确失败)
5. 无 PIN 访问 → 401;错误 PIN 限流生效
6. 办公网不可寻址:从办公网外部 `nmap` 笔记本无任何开放端口

---

## 9. 风险与边界

| 风险 | 缓解 |
|---|---|
| 公司防火墙 DPI 识别并拦截非常规 WSS | 隧道走 443 + TLS(与 HTTPS 无法区分);公司自己的 AgentDeck 就在用同类机制 |
| VPS 被黑 → 拿到机器令牌 | 令牌独立可吊销;PIN 哈希存储;relay 只做转发不落业务数据 |
| 家里设备当 relay 时家庭路由重启 | DDNS + 隧道自动重连(机器侧 5s 退避),自愈 |
| 手机 PIN 泄漏 | 限流 + 可改 PIN;后续可叠加璇玑侧应用层登录做纵深 |
| 国内 CF 网络质量差 | 形态③仅为"先验证价值"过渡;正式用走 VPS(国内地域) |

---

## 10. 参考

- AgentDeck gateway module 实现(本机):`~/.deck/modules/agent-deck.gateway/src/server/index.js`
- AgentDeck TunnelClient(核心可移植代码, MIT):`C:\Users\Administrator\AppData\Roaming\npm\node_modules\agent-deck-cli\dist\manager\tunnel-client.js`
- AgentDeck AuthGate 鉴权分层思路:`dist\manager\auth-gate.js`(subrequest 风格 + relay-trust 校验)
- 璇玑 WS 通道:`code/backend/src/ws.ts`(`/ws` 变更推送 + `/ws/dispatch` 派发双向流)
