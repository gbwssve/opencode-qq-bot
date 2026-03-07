import type { OpencodeClient } from "./client.js"
import type { Event } from "@opencode-ai/sdk"

export type EventCallback = (event: Event) => void

export class EventRouter {
  private listeners = new Map<string, EventCallback>()
  private running = false
  private abortController: AbortController | null = null
  private client: OpencodeClient

  constructor(client: OpencodeClient) {
    this.client = client
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.consume()
  }

  stop(): void {
    this.running = false
    this.abortController?.abort()
    this.abortController = null
  }

  register(sessionId: string, callback: EventCallback): void {
    this.listeners.set(sessionId, callback)
  }

  unregister(sessionId: string): void {
    this.listeners.delete(sessionId)
  }

  private async consume(): Promise<void> {
    while (this.running) {
      try {
        this.abortController = new AbortController()
        const result = await this.client.event.subscribe()

        for await (const event of result.stream) {
          if (!this.running) break
          const sessionId = this.extractSessionId(event)
          if (sessionId) {
            const cb = this.listeners.get(sessionId)
            if (cb) cb(event)
          }
        }
      } catch (err) {
        if (!this.running) break
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[events] SSE connection error: ${msg}`)
        await this.backoff()
      }
    }
  }

  private extractSessionId(event: Event): string | undefined {
    switch (event.type) {
      case "message.part.updated":
        return event.properties.part.sessionID
      case "message.updated":
        return event.properties.info.sessionID
      case "session.idle":
      case "session.compacted":
        return event.properties.sessionID
      case "session.status":
        return event.properties.sessionID
      case "session.error":
        return event.properties.sessionID
      case "message.removed":
        return event.properties.sessionID
      default:
        return undefined
    }
  }

  private reconnectDelay = 1000
  private async backoff(): Promise<void> {
    await new Promise((r) => setTimeout(r, this.reconnectDelay))
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000)
  }

  resetBackoff(): void {
    this.reconnectDelay = 1000
  }
}
