// @input:  ws, ./api (getAccessToken, getGatewayUrl), ./types (MessageContext)
// @output: startGateway, MessageHandler
// @pos:    qq层 - QQ Bot WebSocket Gateway 状态机 (心跳/重连/消息分发)
import WebSocket from "ws"
import { clearTokenCache, getAccessToken } from "./token.js"
import { getGatewayUrl } from "./http.js"
import type {
  C2CMessageEvent,
  GatewayHelloData,
  GatewayReadyData,
  GroupMessageEvent,
  MessageContext,
  WSPayload,
} from "./types.js"

const GROUP_AND_C2C_EVENT_INTENT = 1 << 25
const MAX_RECONNECT_DELAY_MS = 30_000
const BASE_RECONNECT_DELAY_MS = 1_000
const INVALID_SESSION_DELAY_MS = 3_000
const RESUME_RESET_CLOSE_CODES = new Set([4006, 4007, 4009])
const FATAL_CLOSE_CODES = new Set([4914, 4915])

export type MessageHandler = (msg: MessageContext) => Promise<void>

export interface GatewayOptions {
  appId: string
  clientSecret: string
  onMessage: MessageHandler
  onReady?: () => void
}

interface GatewayState {
  ws: WebSocket | null
  stopped: boolean
  connecting: boolean
  reconnectAttempt: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  heartbeatTimer: ReturnType<typeof setInterval> | null
  accessToken: string | null
  sessionId: string | null
  seq: number | null
  heartbeatAcked: boolean
}

interface GatewayControl {
  stop: () => void
}

function createInitialState(): GatewayState {
  return {
    ws: null,
    stopped: false,
    connecting: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    heartbeatTimer: null,
    accessToken: null,
    sessionId: null,
    seq: null,
    heartbeatAcked: true,
  }
}

function cleanupSocket(state: GatewayState): void {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer)
    state.heartbeatTimer = null
  }

  const ws = state.ws
  state.ws = null

  if (!ws) {
    return
  }

  ws.removeAllListeners()

  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close()
  }
}

function scheduleReconnect(state: GatewayState, connect: () => Promise<void>, customDelayMs?: number): void {
  if (state.stopped || state.reconnectTimer) {
    return
  }

  const attempt = state.reconnectAttempt
  const delayMs = customDelayMs ?? Math.min(BASE_RECONNECT_DELAY_MS * 2 ** attempt, MAX_RECONNECT_DELAY_MS)
  state.reconnectAttempt += 1

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null
    void connect()
  }, delayMs)
}

function startHeartbeat(state: GatewayState, intervalMs: number): void {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer)
  }

  state.heartbeatAcked = true
  state.heartbeatTimer = setInterval(() => {
    const ws = state.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return
    }

    // 如果上一个心跳一直没收到 ACK，直接断线重连
    if (!state.heartbeatAcked) {
      ws.terminate()
      return
    }

    state.heartbeatAcked = false
    ws.send(JSON.stringify({ op: 1, d: state.seq }))
  }, intervalMs)
}

function resetResumeState(state: GatewayState): void {
  state.sessionId = null
  state.seq = null
}

function normalizeMessageContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trim()
}

function stripGroupAtPrefix(content: string): string {
  const normalized = normalizeMessageContent(content)
  return normalized.replace(/^<@!?.+?>\s*/u, "").trim()
}

function toC2CMessageContext(event: C2CMessageEvent): MessageContext {
  return {
    type: "c2c",
    userId: event.author.user_openid,
    msgId: event.id,
    content: normalizeMessageContent(event.content),
    timestamp: event.timestamp,
    rawEvent: event,
  }
}

function toGroupMessageContext(event: GroupMessageEvent): MessageContext {
  return {
    type: "group",
    userId: event.author.member_openid,
    groupId: event.group_openid,
    msgId: event.id,
    content: stripGroupAtPrefix(event.content),
    timestamp: event.timestamp,
    rawEvent: event,
  }
}

async function refreshGatewayAuth(options: GatewayOptions, state: GatewayState): Promise<{ accessToken: string; gatewayUrl: string }> {
  const accessToken = await getAccessToken(options.appId, options.clientSecret)
  const gatewayUrl = await getGatewayUrl(accessToken)
  state.accessToken = accessToken
  return { accessToken, gatewayUrl }
}

function sendIdentify(ws: WebSocket, accessToken: string): void {
  const payload: WSPayload<{
    token: string
    intents: number
    shard: [number, number]
    properties: Record<string, string>
  }> = {
    op: 2,
    d: {
      token: `QQBot ${accessToken}`,
      intents: GROUP_AND_C2C_EVENT_INTENT,
      shard: [0, 1],
      properties: {
        os: process.platform,
        browser: "opencode_qq_bot",
        device: "opencode_qq_bot",
      },
    },
  }

  ws.send(JSON.stringify(payload))
}

function sendResume(ws: WebSocket, accessToken: string, sessionId: string, seq: number): void {
  const payload: WSPayload<{
    token: string
    session_id: string
    seq: number
  }> = {
    op: 6,
    d: {
      token: `QQBot ${accessToken}`,
      session_id: sessionId,
      seq,
    },
  }

  ws.send(JSON.stringify(payload))
}

async function handleDispatchEvent(
  payload: WSPayload,
  options: GatewayOptions,
  state: GatewayState,
): Promise<void> {
  switch (payload.t) {
    case "READY": {
      const readyData = payload.d as GatewayReadyData
      state.sessionId = readyData.session_id
      state.reconnectAttempt = 0
      options.onReady?.()
      return
    }

    case "RESUMED": {
      state.reconnectAttempt = 0
      return
    }

    case "C2C_MESSAGE_CREATE": {
      const message = toC2CMessageContext(payload.d as C2CMessageEvent)
      if (!message.content) {
        return
      }
      await options.onMessage(message)
      return
    }

    case "GROUP_AT_MESSAGE_CREATE": {
      const message = toGroupMessageContext(payload.d as GroupMessageEvent)
      if (!message.content) {
        return
      }
      await options.onMessage(message)
      return
    }

    default:
      return
  }
}

async function handlePayload(
  payload: WSPayload,
  ws: WebSocket,
  options: GatewayOptions,
  state: GatewayState,
  connect: () => Promise<void>,
): Promise<void> {
  if (typeof payload.s === "number") {
    state.seq = payload.s
  }

  switch (payload.op) {
    case 10: {
      // Hello：建立心跳，并根据有无 session 决定 Identify/Resume
      const hello = payload.d as GatewayHelloData
      startHeartbeat(state, hello.heartbeat_interval)

      if (state.accessToken && state.sessionId && state.seq !== null) {
        sendResume(ws, state.accessToken, state.sessionId, state.seq)
      } else if (state.accessToken) {
        sendIdentify(ws, state.accessToken)
      }
      return
    }

    case 0:
      await handleDispatchEvent(payload, options, state)
      return

    case 1:
      // 服务端要求立即心跳
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ op: 1, d: state.seq }))
      }
      return

    case 7:
      // 服务端要求重连，尽量保留 session 走 Resume
      cleanupSocket(state)
      scheduleReconnect(state, connect)
      return

    case 9: {
      // InvalidSession：不可恢复时清空会话，稍后重新 Identify
      const canResume = Boolean(payload.d)
      if (!canResume) {
        resetResumeState(state)
      }
      cleanupSocket(state)
      scheduleReconnect(state, connect, INVALID_SESSION_DELAY_MS)
      return
    }

    case 11:
      state.heartbeatAcked = true
      return

    default:
      return
  }
}

export async function startGateway(options: GatewayOptions): Promise<GatewayControl> {
  const state = createInitialState()

  const stop = (): void => {
    state.stopped = true

    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = null
    }

    cleanupSocket(state)
  }

  const connect = async (): Promise<void> => {
    if (state.stopped || state.connecting) {
      return
    }

    state.connecting = true

    try {
      cleanupSocket(state)

      const { gatewayUrl } = await refreshGatewayAuth(options, state)
      const ws = new WebSocket(gatewayUrl)
      state.ws = ws

      ws.on("open", () => {
        state.connecting = false
      })

      ws.on("message", (data) => {
        void (async () => {
          try {
            const payload = JSON.parse(data.toString()) as WSPayload
            await handlePayload(payload, ws, options, state, connect)
          } catch (error) {
            console.error("[qq-gateway] 处理网关消息失败:", error)
          }
        })()
      })

      ws.on("close", (code) => {
        state.connecting = false
        cleanupSocket(state)

        if (state.stopped || code === 1000) {
          return
        }

        // 这些错误码说明 Resume 已经没意义，直接清空会话重来
        if (RESUME_RESET_CLOSE_CODES.has(code)) {
          resetResumeState(state)
        }

        // token 失效时强制刷新，避免死循环拿旧 token
        if (code === 4004) {
          clearTokenCache()
          state.accessToken = null
        }

        if (FATAL_CLOSE_CODES.has(code)) {
          return
        }

        scheduleReconnect(state, connect)
      })

      ws.on("error", (error) => {
        state.connecting = false
        console.error("[qq-gateway] WebSocket 错误:", error)
      })
    } catch (error) {
      state.connecting = false
      console.error("[qq-gateway] 建连失败:", error)
      clearTokenCache()
      state.accessToken = null
      scheduleReconnect(state, connect)
    }
  }

  await connect()

  return { stop }
}
