// @input:  (none - raw HTTP to QQ Bot REST API)
// @output: apiRequest, getGatewayUrl
// @pos:    qq层 - QQ Bot REST API 通用请求层 (超时 + 日志 + 错误处理)

const API_BASE = "https://api.sgroup.qq.com"
const DEBUG = process.env.DEBUG_QQ_API === "true"
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

  const start = Date.now()

  if (DEBUG) {
    const logHeaders = { ...headers, Authorization: "QQBot ***" }
    console.log(`[qqbot-api] >>> ${method} ${url} (timeout: ${timeout}ms)`)
    console.log("[qqbot-api] >>> Headers:", JSON.stringify(logHeaders, null, 2))
    if (body) {
      const logBody = { ...(body as Record<string, unknown>) }
      if (typeof logBody.file_data === "string") {
        logBody.file_data = `<base64 ${logBody.file_data.length} chars>`
      }
      console.log("[qqbot-api] >>> Body:", JSON.stringify(logBody, null, 2))
    }
  }

  let res: Response
  try {
    res = await fetch(url, options)
  } catch (err) {
    clearTimeout(timeoutId)
    if (err instanceof Error && err.name === "AbortError") {
      console.error(`[qqbot-api] ${method} ${path} -> TIMEOUT (${timeout}ms)`)
      throw new Error(`Request timeout [${path}]: exceeded ${timeout}ms`)
    }
    console.error(`[qqbot-api] ${method} ${path} -> ERROR: ${err instanceof Error ? err.message : String(err)}`)
    throw new Error(`Network error [${path}]: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timeoutId)
  }

  let data: T
  let rawBody: string
  try {
    rawBody = await res.text()
    data = JSON.parse(rawBody) as T
  } catch (err) {
    const elapsed = Date.now() - start
    console.error(`[qqbot-api] ${method} ${path} -> ${res.status} (${elapsed}ms) - Parse error: ${err instanceof Error ? err.message : String(err)}`)
    throw new Error(`Failed to parse response [${path}]: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (DEBUG) {
    const responseHeaders: Record<string, string> = {}
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })
    console.log(`[qqbot-api] <<< Status: ${res.status} ${res.statusText}`)
    console.log("[qqbot-api] <<< Headers:", JSON.stringify(responseHeaders, null, 2))
    console.log("[qqbot-api] <<< Body:", rawBody)
  }

  const elapsed = Date.now() - start
  console.log(`[qqbot-api] ${method} ${path} -> ${res.status} (${elapsed}ms)`)

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
