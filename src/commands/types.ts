import type { Config } from "../config.js"
import type { OpencodeClient } from "../opencode/client.js"
import { SessionManager } from "../opencode/sessions.js"

export const SELECTION_TTL_MS = 60_000

export interface CommandContext {
  config: Config
  client: OpencodeClient
  sessions: SessionManager
  getAccessToken: () => Promise<string>
  pendingSelections: Map<string, PendingSelection>
}

export interface PendingSelection {
  type: "session" | "model"
  items: Array<{ id: string; label: string }>
  expiresAt: number
}

export interface ParsedCommand {
  name: string
  args: string
}
