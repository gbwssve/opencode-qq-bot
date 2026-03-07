/**
 * QQ Bot API 鉴权和请求封装
 */

const API_BASE = "https://api.sgroup.qq.com"
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"

let cachedToken: { token: string; expiresAt: number; appId: string } | null = null
// Singleflight：防止并发获取 Token 时重复请求
let tokenFetchPromise: Promise<string> | null = null

/**
 * 获取 AccessToken，内置缓存与 singleflight 并发保护。
 * 当多个请求同时发现 Token 过期时，只会发起一次真实刷新请求。
 */
export async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 5 * 60 * 1000 && cachedToken.appId === appId) {
    return cachedToken.token
  }

  if (cachedToken && cachedToken.appId !== appId) {
    console.log(`[qqbot-api] appId changed (${cachedToken.appId} → ${appId}), clearing token cache`)
    cachedToken = null
    tokenFetchPromise = null
  }

  if (tokenFetchPromise) {
    console.log("[qqbot-api] Token fetch in progress, waiting for existing request...")
    return tokenFetchPromise
  }

  tokenFetchPromise = (async () => {
    try {
      return await doFetchToken(appId, clientSecret)
    } finally {
      tokenFetchPromise = null
    }
  })()

  return tokenFetchPromise
}

/**
 * 真正执行 Token 获取的内部函数。
 */
async function doFetchToken(appId: string, clientSecret: string): Promise<string> {
  const requestBody = { appId, clientSecret }
  const requestHeaders = { "Content-Type": "application/json" }

  console.log(`[qqbot-api] >>> POST ${TOKEN_URL}`)
  console.log("[qqbot-api] >>> Headers:", JSON.stringify(requestHeaders, null, 2))
  console.log("[qqbot-api] >>> Body:", JSON.stringify({ appId, clientSecret: "***" }, null, 2))

  let response: Response
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(requestBody),
    })
  } catch (err) {
    console.error("[qqbot-api] <<< Network error:", err)
    throw new Error(`Network error getting access_token: ${err instanceof Error ? err.message : String(err)}`)
  }

  const responseHeaders: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })
  console.log(`[qqbot-api] <<< Status: ${response.status} ${response.statusText}`)
  console.log("[qqbot-api] <<< Headers:", JSON.stringify(responseHeaders, null, 2))

  let data: { access_token?: string; expires_in?: number }
  let rawBody: string
  try {
    rawBody = await response.text()
    const logBody = rawBody.replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token": "***"')
    console.log("[qqbot-api] <<< Body:", logBody)
    data = JSON.parse(rawBody) as { access_token?: string; expires_in?: number }
  } catch (err) {
    console.error("[qqbot-api] <<< Parse error:", err)
    throw new Error(`Failed to parse access_token response: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!data.access_token) {
    throw new Error(`Failed to get access_token: ${JSON.stringify(data)}`)
  }

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
    appId,
  }

  console.log(`[qqbot-api] Token cached for appId=${appId}, expires at: ${new Date(cachedToken.expiresAt).toISOString()}`)
  return cachedToken.token
}

/**
 * 清空当前 Token 缓存。
 * 不会中断已经在进行中的刷新请求。
 */
export function clearTokenCache(): void {
  cachedToken = null
}

/**
 * 获取当前 Token 缓存状态，便于监控或启动阶段打印状态。
 */
export function getTokenStatus(): { status: "valid" | "expired" | "refreshing" | "none"; expiresAt: number | null } {
  if (tokenFetchPromise) {
    return { status: "refreshing", expiresAt: cachedToken?.expiresAt ?? null }
  }
  if (!cachedToken) {
    return { status: "none", expiresAt: null }
  }
  const isValid = Date.now() < cachedToken.expiresAt - 5 * 60 * 1000
  return { status: isValid ? "valid" : "expired", expiresAt: cachedToken.expiresAt }
}

/**
 * 生成消息序号，范围固定为 0~65535。
 * 用时间戳低位与随机数混合，避免进程内碰撞。
 */
export function getNextMsgSeq(_msgId: string): number {
  const timePart = Date.now() % 100000000
  const random = Math.floor(Math.random() * 65536)
  return (timePart ^ random) % 65536
}

const DEFAULT_API_TIMEOUT = 30000
const FILE_UPLOAD_TIMEOUT = 120000

/**
 * 统一封装 QQ Bot REST 请求。
 * 保留源实现的超时、日志、错误处理和 JSON 解析行为。
 */
export async function apiRequest<T = unknown>(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> {
  const url = `${API_BASE}${path}`
  const headers: Record<string, string> = {
    Authorization: `QQBot ${accessToken}`,
    "Content-Type": "application/json",
  }

  const isFileUpload = path.includes("/files")
  const timeout = timeoutMs ?? (isFileUpload ? FILE_UPLOAD_TIMEOUT : DEFAULT_API_TIMEOUT)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    controller.abort()
  }, timeout)

  const options: RequestInit = {
    method,
    headers,
    signal: controller.signal,
  }

  if (body) {
    options.body = JSON.stringify(body)
  }

  console.log(`[qqbot-api] >>> ${method} ${url} (timeout: ${timeout}ms)`)
  console.log("[qqbot-api] >>> Headers:", JSON.stringify(headers, null, 2))
  if (body) {
    const logBody = { ...(body as Record<string, unknown>) }
    if (typeof logBody.file_data === "string") {
      logBody.file_data = `<base64 ${logBody.file_data.length} chars>`
    }
    console.log("[qqbot-api] >>> Body:", JSON.stringify(logBody, null, 2))
  }

  let res: Response
  try {
    res = await fetch(url, options)
  } catch (err) {
    clearTimeout(timeoutId)
    if (err instanceof Error && err.name === "AbortError") {
      console.error(`[qqbot-api] <<< Request timeout after ${timeout}ms`)
      throw new Error(`Request timeout [${path}]: exceeded ${timeout}ms`)
    }
    console.error("[qqbot-api] <<< Network error:", err)
    throw new Error(`Network error [${path}]: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timeoutId)
  }

  const responseHeaders: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })
  console.log(`[qqbot-api] <<< Status: ${res.status} ${res.statusText}`)
  console.log("[qqbot-api] <<< Headers:", JSON.stringify(responseHeaders, null, 2))

  let data: T
  let rawBody: string
  try {
    rawBody = await res.text()
    console.log("[qqbot-api] <<< Body:", rawBody)
    data = JSON.parse(rawBody) as T
  } catch (err) {
    console.error("[qqbot-api] <<< Parse error:", err)
    throw new Error(`Failed to parse response [${path}]: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!res.ok) {
    const error = data as { message?: string; code?: number }
    throw new Error(`API Error [${path}]: ${error.message ?? JSON.stringify(data)}`)
  }

  return data
}

/**
 * 获取 WebSocket Gateway 地址。
 */
export async function getGatewayUrl(accessToken: string): Promise<string> {
  const data = await apiRequest<{ url: string }>(accessToken, "GET", "/gateway")
  return data.url
}

/**
 * QQ 发消息成功后的通用响应结构。
 */
export interface MessageResponse {
  id: string
  timestamp: number | string
}

/**
 * 构建普通文本消息体。
 * 这里固定使用纯文本消息，不再保留 markdown 模式切换。
 */
function buildMessageBody(
  content: string,
  msgId: string | undefined,
  msgSeq: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    content,
    msg_type: 0,
    msg_seq: msgSeq,
  }

  if (msgId) {
    body.msg_id = msgId
  }

  return body
}

/**
 * 发送 C2C 单聊文本消息。
 * msgSeq 可选，传入时优先使用，便于上层做分片发送。
 */
export async function sendC2CMessage(
  accessToken: string,
  openid: string,
  content: string,
  msgId?: string,
  msgSeq?: number,
): Promise<MessageResponse> {
  const resolvedMsgSeq = msgSeq ?? (msgId ? getNextMsgSeq(msgId) : 1)
  const body = buildMessageBody(content, msgId, resolvedMsgSeq)
  return apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, body)
}

/**
 * 发送 C2C 输入状态提示，告诉用户机器人正在输入。
 */
export async function sendC2CInputNotify(
  accessToken: string,
  openid: string,
  msgId?: string,
  inputSecond: number = 60,
): Promise<void> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1
  const body = {
    msg_type: 6,
    input_notify: {
      input_type: 1,
      input_second: inputSecond,
    },
    msg_seq: msgSeq,
    ...(msgId ? { msg_id: msgId } : {}),
  }

  await apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, body)
}

/**
 * 发送群聊文本消息。
 * msgSeq 可选，传入时优先使用，便于上层做分片发送。
 */
export async function sendGroupMessage(
  accessToken: string,
  groupOpenid: string,
  content: string,
  msgId?: string,
  msgSeq?: number,
): Promise<MessageResponse> {
  const resolvedMsgSeq = msgSeq ?? (msgId ? getNextMsgSeq(msgId) : 1)
  const body = buildMessageBody(content, msgId, resolvedMsgSeq)
  return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, body)
}

interface BackgroundTokenRefreshOptions {
  refreshAheadMs?: number
  randomOffsetMs?: number
  minRefreshIntervalMs?: number
  retryDelayMs?: number
  log?: {
    info: (msg: string) => void
    error: (msg: string) => void
    debug?: (msg: string) => void
  }
}

let backgroundRefreshRunning = false
let backgroundRefreshAbortController: AbortController | null = null

/**
 * 启动后台 Token 刷新循环。
 * 它会在 Token 过期前提前刷新，避免真正发消息时才发现 Token 已失效。
 */
export function startBackgroundTokenRefresh(
  appId: string,
  clientSecret: string,
  options?: BackgroundTokenRefreshOptions,
): void {
  if (backgroundRefreshRunning) {
    console.log("[qqbot-api] Background token refresh already running")
    return
  }

  const {
    refreshAheadMs = 5 * 60 * 1000,
    randomOffsetMs = 30 * 1000,
    minRefreshIntervalMs = 60 * 1000,
    retryDelayMs = 5 * 1000,
    log,
  } = options ?? {}

  backgroundRefreshRunning = true
  backgroundRefreshAbortController = new AbortController()
  const signal = backgroundRefreshAbortController.signal

  const refreshLoop = async () => {
    log?.info?.("[qqbot-api] Background token refresh started")

    while (!signal.aborted) {
      try {
        await getAccessToken(appId, clientSecret)

        if (cachedToken) {
          const expiresIn = cachedToken.expiresAt - Date.now()
          const randomOffset = Math.random() * randomOffsetMs
          const refreshIn = Math.max(
            expiresIn - refreshAheadMs - randomOffset,
            minRefreshIntervalMs,
          )

          log?.debug?.(`[qqbot-api] Token valid, next refresh in ${Math.round(refreshIn / 1000)}s`)
          await sleep(refreshIn, signal)
        } else {
          log?.debug?.("[qqbot-api] No cached token, retrying soon")
          await sleep(minRefreshIntervalMs, signal)
        }
      } catch (err) {
        if (signal.aborted) break

        log?.error?.(`[qqbot-api] Background token refresh failed: ${err}`)
        await sleep(retryDelayMs, signal)
      }
    }

    backgroundRefreshRunning = false
    log?.info?.("[qqbot-api] Background token refresh stopped")
  }

  refreshLoop().catch((err) => {
    backgroundRefreshRunning = false
    log?.error?.(`[qqbot-api] Background token refresh crashed: ${err}`)
  })
}

/**
 * 停止后台 Token 刷新循环。
 */
export function stopBackgroundTokenRefresh(): void {
  if (backgroundRefreshAbortController) {
    backgroundRefreshAbortController.abort()
    backgroundRefreshAbortController = null
  }
  backgroundRefreshRunning = false
}

/**
 * 可被 AbortSignal 中断的 sleep，供后台刷新循环复用。
 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve()
    }, ms)

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        reject(new Error("Aborted"))
        return
      }

      const onAbort = () => {
        clearTimeout(timer)
        reject(new Error("Aborted"))
      }

      signal.addEventListener("abort", onAbort, { once: true })
    }
  })
}
