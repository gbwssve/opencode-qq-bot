# OpenCode QQ Bot 设计方案

## 1. 概述

将 OpenCode AI 编程助手通过 QQ 机器人暴露给用户，实现：QQ 发消息 → OpenCode 处理 → QQ 回复。

参考实现：[grinev/opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot)（81 个文件，grammy + @opencode-ai/sdk/v2），本项目精简为 ~10 个文件。

### 目标

- 支持 QQ 群聊（@机器人）和 C2C 私聊
- 流式收集 AI 回复，完成后一次性发送
- 会话管理：每用户一个 session，支持 `/new` 新建
- 安全：仅允许白名单用户使用

### 不做（MVP 阶段）

- 不做 i18n（只需中文）
- 不做文件/图片上传
- 不做 Webhook 模式（WebSocket 足够）
- 不做数据库持久化（内存 Map）
- 不做交互式问答（OpenCode 的 question/permission 事件暂跳过）

---

## 2. 技术栈

| 组件 | 选型 | 理由 |
|------|------|------|
| Runtime | Bun | 用户偏好，原生 TS 支持 |
| Language | TypeScript + ESM | 类型安全 |
| QQ 层 | 从 sliverp/qqbot 剥离 api.ts + gateway.ts | 比 qq-bot-sdk 更完整：Token singleflight、后台刷新、上传重试、富媒体支持。去掉 OpenClaw 依赖 |
| OpenCode SDK | `@opencode-ai/sdk` v1.2.20 | 官方 SDK，完整 TypeScript 类型 |
| WS | `ws` | gateway.ts 依赖，唯一第三方运行时依赖 |
| 配置 | `.env` | Bun 原生支持 .env，不需要 dotenv |

### 2.1 为什么不用 qq-bot-sdk

sliverp/qqbot 的 api.ts (989 行) 质量远高于 qq-bot-sdk：
- Token 管理：singleflight 并发安全 + 后台定时刷新 + 过期前 5 分钟预刷新
- 上传：指数退避重试 + file_info 缓存（相同文件不重复上传）
- 完整封装：C2C/群聊/频道 x 文本/图片/语音/视频/文件 = 所有组合
- 无第三方依赖（qq-bot-sdk 内部实现不透明）

剥离策略：只取 api.ts + types.ts + gateway.ts 核心部分，去掉所有 OpenClaw 引用。

---

## 3. 架构

### 3.1 整体流程

```
QQ 用户发消息
    |
    v
qq-bot-sdk (WebSocket)
    |
    v
Bridge.handleMessage()
    |
    +---> 命令? (/new, /status, /help)
    |       |
    |       v
    |     处理命令，直接回复
    |
    +---> 普通消息 (prompt)
            |
            v
        SessionManager.getOrCreate(userId)
            |
            v
        EventRouter.register(sessionId, callback)
            |
            v
        opencode.session.chat(sessionId, {parts}) [Fire-and-Forget]
            |
            v
        全局 SSE 事件流 (event.list())
            |
            v
        EventRouter 按 sessionId 分发
            |
            v
        message.part.updated → 聚合文本
            |
            v
        session.idle → 回复完成
            |
            v
        QQSender.reply(groupId/userId, fullText, msgId)
            |
            v
        QQ 用户收到回复
```

### 3.2 SSE 事件驱动模式（核心）

从 Telegram Bot 学到的关键模式：**Fire-and-Forget + SSE 事件驱动**

```
               +---------+         +----------+
               |  chat() |-------->| OpenCode |
               | (不等待) |         |  Server  |
               +---------+         +----+-----+
                                        |
                                        | SSE 事件流
                                        v
                               +--------+--------+
                               |  EventRouter    |
                               | (全局单连接)     |
                               +--+-----+-----+--+
                                  |     |     |
                            sid-1 | sid-2| sid-3|
                                  v     v     v
                               各用户的回调函数
```

- 全局**一个** SSE 连接（`client.event.list()`）
- `EventRouter` 按 `sessionID` 分发事件到对应用户回调
- `session.chat()` 不 await，让 SSE 事件流驱动回复

---

## 4. 模块设计

### 4.1 项目结构

```
opencode_qq_bot/
├── src/
│   ├── index.ts              # 入口：初始化 + 启动
│   ├── config.ts             # 环境变量加载 + 校验
│   ├── qq/
│   │   ├── api.ts            # [剥离自 sliverp/qqbot] QQ REST API 封装 (Token/消息/媒体)
│   │   ├── types.ts          # [剥离自 sliverp/qqbot] QQ 消息事件类型定义
│   │   ├── gateway.ts        # [剥离自 sliverp/qqbot] WebSocket Gateway (精简版，去 OpenClaw)
│   │   └── sender.ts         # 消息发送：格式化 + 分割 + 限流
│   ├── opencode/
│   │   ├── client.ts         # OpenCode SDK 客户端封装
│   │   ├── events.ts         # 全局 SSE 订阅 + EventRouter (按 sessionId 分发)
│   │   └── sessions.ts       # 会话管理：QQ用户 <-> OpenCode Session 映射
│   └── bridge.ts             # 核心桥接：QQ 消息 -> OpenCode -> QQ 回复
├── .env.example
├── package.json
└── tsconfig.json
```

### 4.2 从 sliverp/qqbot 剥离的文件

| 原文件 | 行数 | 剥离后 | 改动 |
|--------|------|--------|------|
| src/api.ts | 989 | qq/api.ts | 删除 OpenClaw 引用、image-server 相关、file-utils import 改为内联 |
| src/types.ts | 153 | qq/types.ts | 直接搬，删除 AudioFormatPolicy 等 MVP 不需要的 |
| src/gateway.ts | 1140+ | qq/gateway.ts | 大量精简：删除 STT/TTS/媒体处理/图床，只保留 WS 连接+心跳+重连+消息分发 |

不搬的：config.ts(OpenClaw 配置)、runtime.ts(OpenClaw 插件)、outbound.ts(高层封装太重)、channel.ts、onboarding.ts

### 4.2 各模块职责

#### `config.ts` — 配置管理

```typescript
interface Config {
  qq: {
    appId: string        // QQ 开放平台 AppID
    appSecret: string    // AppSecret（换 AccessToken 用）
    sandbox: boolean     // 沙箱模式
  }
  opencode: {
    baseUrl: string      // opencode serve 地址，默认 http://localhost:54321
    providerId: string   // 模型提供商，如 'anthropic'
    modelId: string      // 模型 ID，如 'claude-sonnet-4-5'
  }
  allowedUsers: string[] // 允许使用的 QQ 用户 openid 列表（空=不限制）
  maxReplyLength: number // 单条回复最大字符数，默认 3000
}
```

#### `qq/bot.ts` — QQ Bot

```typescript
// 初始化
const client = createOpenAPI({ appID, token: '', secret: appSecret, sandbox })
const ws = createWebsocket({ appID, token: '', secret: appSecret, intents: [GROUP_AND_C2C_EVENT] })

// 监听消息
ws.on(GROUP_AND_C2C_EVENT, (data) => {
  const { msg } = data
  // msg.group_id 存在 → 群消息
  // msg.author.id 存在且无 group_id → 私聊
  bridge.handleMessage(msg)
})
```

#### `qq/sender.ts` — 消息发送

职责：
- 将 Markdown 转为 QQ 友好格式（保留代码块，去除复杂标记）
- 超长消息分割（按段落或代码块边界，不在中间截断）
- 群消息 vs 私聊分别调用 `groupApi.postMessage` / `c2cApi.postMessage`
- 带 `msg_id` 被动回复

```typescript
async function reply(ctx: MessageContext, text: string): Promise<void> {
  const formatted = formatForQQ(text)
  const chunks = splitMessage(formatted, MAX_LENGTH)

  for (const chunk of chunks) {
    if (ctx.groupId) {
      await qqClient.groupApi.postMessage(ctx.groupId, {
        content: chunk,
        msg_type: 0,
        msg_id: ctx.msgId,
        msg_seq: nextSeq(),
      })
    } else {
      await qqClient.c2cApi.postMessage(ctx.userId, {
        content: chunk,
        msg_type: 0,
        msg_id: ctx.msgId,
        msg_seq: nextSeq(),
      })
    }
  }
}
```

#### `opencode/client.ts` — OpenCode 客户端

```typescript
import Opencode from '@opencode-ai/sdk'

// 简单封装，加健康检查
export function createOpencodeClient(baseUrl: string): Opencode {
  return new Opencode({ baseURL: baseUrl, timeout: 120_000, maxRetries: 2 })
}

export async function healthCheck(client: Opencode): Promise<boolean> {
  // GET /health
}
```

#### `opencode/events.ts` — SSE 事件路由器（核心）

```typescript
type EventCallback = (event: EventListResponse) => void

class EventRouter {
  private stream: Stream<EventListResponse> | null = null
  private listeners: Map<string, EventCallback> = new Map() // sessionId → callback
  private client: Opencode

  async start(): Promise<void> {
    // 建立全局 SSE 连接
    this.stream = await this.client.event.list()
    this.consume() // 启动消费循环
  }

  private async consume(): Promise<void> {
    for await (const event of this.stream!) {
      const sessionId = this.extractSessionId(event)
      if (sessionId && this.listeners.has(sessionId)) {
        this.listeners.get(sessionId)!(event)
      }
    }
    // 断线重连（指数退避）
    this.reconnect()
  }

  register(sessionId: string, callback: EventCallback): void {
    this.listeners.set(sessionId, callback)
  }

  unregister(sessionId: string): void {
    this.listeners.delete(sessionId)
  }

  private extractSessionId(event: EventListResponse): string | undefined {
    // 从不同事件类型中提取 sessionID
    switch (event.type) {
      case 'message.part.updated': return event.properties.part?.sessionID
      case 'message.updated': return event.properties.info?.sessionID
      case 'session.idle': return event.properties.sessionID
      case 'session.error': return event.properties.sessionID
      default: return undefined
    }
  }
}
```

#### `opencode/sessions.ts` — 会话管理

```typescript
// QQ 用户 → OpenCode Session 映射
class SessionManager {
  private sessions: Map<string, string> = new Map()  // qqUserId → opencodeSessionId
  private client: Opencode

  // 获取或创建会话
  async getOrCreate(qqUserId: string): Promise<string> {
    if (this.sessions.has(qqUserId)) {
      return this.sessions.get(qqUserId)!
    }
    const session = await this.client.session.create()
    this.sessions.set(qqUserId, session.id)
    return session.id
  }

  // /new 命令：强制新建
  async createNew(qqUserId: string): Promise<string> {
    const session = await this.client.session.create()
    this.sessions.set(qqUserId, session.id)
    return session.id
  }
}
```

#### `bridge.ts` — 核心桥接

```typescript
async function handleMessage(msg: QQMessage): Promise<void> {
  const userId = msg.author?.id || msg.author?.user_openid
  const content = stripAtPrefix(msg.content).trim()

  // 白名单检查
  if (!isAllowed(userId)) return

  // 命令处理 (见第 5.5 节命令体系)
  const cmd = parseCommand(content)
  if (cmd) { await handleCommand(cmd, msg); return }

  // 防并发：如果该用户有正在处理的消息，排队
  if (userBusy.has(userId)) {
    await reply(msg, '上一条消息还在处理中，请稍候...')
    return
  }
  userBusy.add(userId)

  try {
    // 获取/创建 OpenCode session
    const sessionId = await sessionManager.getOrCreate(userId)

    // 注册事件回调：收集 AI 回复
    let fullText = ''
    const done = new Promise<string>((resolve, reject) => {
      eventRouter.register(sessionId, (event) => {
        if (event.type === 'message.part.updated') {
          const part = event.properties.part
          if (part.type === 'text') fullText += part.text
        }
        if (event.type === 'session.idle') {
          resolve(fullText)
        }
        if (event.type === 'session.error') {
          reject(new Error(event.properties.error))
        }
      })
    })

    // Fire-and-Forget: 发送 prompt（不 await chat，让 SSE 驱动）
    client.session.chat(sessionId, {
      providerID: config.opencode.providerId,
      modelID: config.opencode.modelId,
      parts: [{ type: 'text', text: content }],
    }).catch(err => console.error('chat error:', err))

    // 等待完成
    const replyText = await done
    eventRouter.unregister(sessionId)

    // 发送回复
    await reply(msg, replyText || '(AI 未返回内容)')
  } finally {
    userBusy.delete(userId)
  }
}
```

---

## 5. 关键设计决策

### 5.1 WebSocket vs Webhook

**选 WebSocket**。理由：
- 不需要公网 HTTPS + 域名
- opencode serve 是本地服务，Bot 跟它跑同一台机器
- 个人工具场景，WebSocket 完全够用
- 官方说 2024 年底下线 WS，但 2026 年仍在运行

### 5.2 被动回复策略

QQ 速率限制：
- 被动回复（群）：5 分钟 / 5 次
- 被动回复（私聊）：60 分钟 / 5 次
- 主动消息：每月 4 条

**策略**：
- **只用被动回复**（带 msg_id），不主动推送
- AI 回复收集完毕后**一次性发送**，不逐 token 流式推
- 超长回复分割成 2-3 条，每条都带 msg_id + 递增 msg_seq

### 5.3 会话映射

```
QQ 用户 A (群消息) ──→ OpenCode Session #1
QQ 用户 A (私聊)   ──→ OpenCode Session #1  (同一个 session)
QQ 用户 B          ──→ OpenCode Session #2
```

- 按 `user_openid` 映射，不区分群/私聊
- `/new` 替换映射到新 session
- 无持久化，重启后重建（可接受）

### 5.4 消息格式化

OpenCode 返回 Markdown，QQ 处理规则：
- `msg_type: 0`（纯文本）发送
- 保留代码块（QQ 客户端会渲染 ` `` ` 包裹的内容）
- 去除 `**bold**` → `bold`，`[link](url)` → `link (url)`
- 保留列表符号 `- ` 和编号 `1. `

### 5.5 命令体系

参考 [grinev/opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot) 的命令设计，按 QQ 场景适配。

#### MVP 命令

| 命令 | 功能 | 对应 Telegram Bot | SDK 调用 |
|------|------|-------------------|----------|
| `/new` | 创建新会话 | `/new` | `session.create()` |
| `/stop` | 中断当前 AI 运行 | `/stop` | `session.abort(id)` |
| `/status` | 服务器+会话+模型状态 | `/status` | health + session 信息 |
| `/sessions` | 列出历史会话，回复序号切换 | `/sessions` | `session.list()` |
| `/help` | 帮助信息，列出所有命令 | `/help` | 无 |
| `/model` | 列出可用模型 | Model 按钮 | `app.models()` |
| `/model <id>` | 切换模型 (序号或 provider/model) | Model 按钮 | 修改当前用户配置 |
| `/agent` | 列出可用 agent 模式 | Agent 按钮 | `app.agents()` |
| `/agent <name>` | 切换 agent (如 code/ask) | Agent 按钮 | 修改当前用户配置 |
| `/rename <name>` | 重命名当前会话 | `/rename` | 内存修改 title |

#### 命令解析逻辑

```typescript
interface ParsedCommand {
  name: string    // 命令名，如 'new', 'model', 'sessions'
  args: string    // 命令参数，如 'anthropic/claude-sonnet-4-5'
}

function parseCommand(content: string): ParsedCommand | null {
  if (!content.startsWith('/')) return null
  const [name, ...rest] = content.slice(1).split(/\s+/)
  return { name: name.toLowerCase(), args: rest.join(' ') }
}
```

#### 命令交互示例

**`/sessions` — 会话列表 + 切换**
```
用户: /sessions
Bot:  会话列表:
      1. [当前] 实现登录功能 (2 分钟前)
      2. 重构数据库模型 (1 小时前)
      3. 修复 CSS 布局 (昨天)
      回复序号切换会话

用户: 2
Bot:  已切换到会话: 重构数据库模型
```

**`/model` — 模型切换**
```
用户: /model
Bot:  可用模型:
      1. [当前] anthropic / claude-sonnet-4-5
      2. anthropic / claude-opus-4-6
      3. openai / gpt-5
      回复序号或 /model <provider/model> 切换

用户: /model 2
Bot:  已切换模型: anthropic / claude-opus-4-6
```

**`/agent` — Agent 切换**
```
用户: /agent
Bot:  可用 Agent:
      1. [当前] code - 编写和编辑代码
      2. ask - 回答问题，不修改文件
      回复 /agent <name> 切换

用户: /agent ask
Bot:  已切换 Agent: ask
```

**`/status` — 状态总览**
```
用户: /status
Bot:  OpenCode 状态
      服务器: 运行中
      会话: 实现登录功能 (ses_abc123)
      模型: anthropic / claude-sonnet-4-5
      Agent: code
```

#### 不做的命令 (与 Telegram Bot 对比)

| Telegram 命令 | 不做原因 |
|---------------|---------|
| `/start` | QQ 没有类似 Telegram 的 /start 入口，首条消息自动触发 |
| `/projects` | 单用户场景，项目固定在 opencode serve 启动目录 |
| `/opencode_start` | Bot 和 opencode 跑同一台机器，手动管理进程 |
| `/opencode_stop` | 同上 |
| `/commands` | OpenCode 内置命令，复杂度高，MVP 不需要 |

#### 序号选择机制

QQ 没有 InlineKeyboard，用「序号回复」模拟选择：
- `/sessions` 和 `/model` 发出列表后，设置一个临时「等待输入」状态
- 用户下一条消息如果是纯数字，视为选择序号
- 超过 60 秒未回复，自动取消等待
- 等待期间发送非数字消息，视为普通 prompt（取消等待）

```typescript
interface PendingSelection {
  type: 'session' | 'model'    // 等待选择的类型
  items: string[]               // 可选项 ID 列表
  expiresAt: number             // 过期时间戳
}

// 每用户一个 pending
const pendingSelections: Map<string, PendingSelection> = new Map()
```

---

## 6. 配置

### .env.example

```env
# QQ Bot
QQ_APP_ID=102935014
QQ_APP_SECRET=你的AppSecret
QQ_SANDBOX=false

# OpenCode
OPENCODE_BASE_URL=http://localhost:54321
OPENCODE_PROVIDER_ID=anthropic
OPENCODE_MODEL_ID=claude-sonnet-4-5

# 安全
ALLOWED_USERS=          # 逗号分隔的 user_openid，留空不限制

# 消息
MAX_REPLY_LENGTH=3000   # 单条消息最大字符
```

---

## 7. 启动流程

```typescript
// index.ts
async function main() {
  // 1. 加载配置
  const config = loadConfig()

  // 2. 初始化 OpenCode 客户端 + 健康检查
  const oc = createOpencodeClient(config.opencode.baseUrl)
  await healthCheck(oc)

  // 3. 启动全局 SSE 事件路由
  const router = new EventRouter(oc)
  await router.start()

  // 4. 初始化会话管理
  const sessions = new SessionManager(oc)

  // 5. 创建桥接层
  const bridge = new Bridge(config, oc, router, sessions)

  // 6. 启动 QQ Bot
  const bot = createQQBot(config.qq, bridge)
  // ws.on(GROUP_AND_C2C_EVENT, bridge.handleMessage)

  console.log('QQ Bot 已启动')
}
```

---

## 8. 后续迭代

### P1（MVP 之后）
- [ ] 支持 OpenCode 的 question/permission 事件（交互式问答）
- [ ] 会话持久化（SQLite 或 JSON 文件，重启不丢映射）
- [ ] 超时处理（AI 回复超过 N 秒则通知用户）
- [ ] `/projects` 命令（多项目切换）

### P2
- [ ] 支持图片/文件发送（OpenCode 的 file part → QQ 富媒体）
- [ ] Webhook 模式支持（公网部署场景）
- [ ] `/commands` 运行 OpenCode 内置命令

### P3
- [ ] 群内多用户隔离（group_id + user_id 组合键）
- [ ] 消息历史查看（`/history`）
- [ ] 管理员命令（`/users`, `/kick`）
