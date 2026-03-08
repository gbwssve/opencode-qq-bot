import type { MessageContext } from "../qq/types.js"
import type { CommandContext, ParsedCommand } from "./types.js"
import {
  handleNew,
  handleStop,
  handleStatus,
  handleSessions,
  handleModel,
  handleAgent,
  handleRename,
} from "./handlers.js"
import { buildHelpText } from "./help.js"

const SHORT_ALIASES: Record<string, string> = {
  nw: "new",
  st: "stop",
  ss: "status",
  sn: "sessions",
  hp: "help",
  md: "model",
  ag: "agent",
  rn: "rename",
}

export function isCommand(content: string): boolean {
  const trimmed = content.trim()
  if (trimmed.startsWith("/")) return true
  const firstToken = trimmed.split(/\s+/)[0]?.toLowerCase()
  return firstToken !== undefined && firstToken in SHORT_ALIASES
}

function parseCommand(content: string): ParsedCommand | null {
  const trimmed = content.trim()

  if (trimmed.startsWith("/")) {
    const [rawName, ...rest] = trimmed.slice(1).split(/\s+/)
    const name = rawName?.toLowerCase()
    if (!name) return null
    return { name, args: rest.join(" ").trim() }
  }

  const [firstToken, ...rest] = trimmed.split(/\s+/)
  const alias = firstToken?.toLowerCase()
  if (!alias || !(alias in SHORT_ALIASES)) return null
  return { name: SHORT_ALIASES[alias], args: rest.join(" ").trim() }
}

export async function handleCommand(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  cmdCtx.pendingSelections.delete(ctx.userId)

  const parsed = parseCommand(ctx.content)
  if (!parsed) {
    return "不是有效命令"
  }

  switch (parsed.name) {
    case "new":
      return handleNew(ctx, cmdCtx)
    case "stop":
      return handleStop(ctx, cmdCtx)
    case "status":
      return handleStatus(ctx, cmdCtx)
    case "sessions":
      return handleSessions(ctx, cmdCtx)
    case "help":
      return buildHelpText()
    case "model":
      return handleModel(ctx, parsed.args, cmdCtx)
    case "agent":
      return handleAgent(ctx, parsed.args, cmdCtx)
    case "rename":
      return handleRename(ctx, parsed.args, cmdCtx)
    default:
      return `不支持的命令：${parsed.name}\n发送 hp 或 /help 查看可用命令`
  }
}

export async function handlePendingSelection(
  userId: string,
  selection: number,
  cmdCtx: CommandContext,
): Promise<string | null> {
  const pending = cmdCtx.pendingSelections.get(userId)
  if (!pending) return null

  if (pending.expiresAt <= Date.now()) {
    cmdCtx.pendingSelections.delete(userId)
    return null
  }

  const item = pending.items[selection - 1]
  if (!item) {
    return `序号无效，请回复 1-${pending.items.length}`
  }

  cmdCtx.pendingSelections.delete(userId)

  if (pending.type === "session") {
    cmdCtx.sessions.switchSession(userId, item.id, item.label)
    return `已切换到会话：${item.label}`
  }

  const model = splitModelId(item.id)
  if (!model) {
    return `模型项无效：${item.label}`
  }

  await ensureSession(userId, cmdCtx)
  cmdCtx.sessions.setModel(userId, model.providerId, model.modelId)
  return `已切换模型：${item.label}`
}

async function ensureSession(userId: string, cmdCtx: CommandContext): Promise<void> {
  await cmdCtx.sessions.getOrCreate(userId)
}

function splitModelId(value: string): { providerId: string; modelId: string } | null {
  const trimmed = value.trim()
  const slashIndex = trimmed.indexOf("/")
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) return null
  const providerId = trimmed.slice(0, slashIndex).trim()
  const modelId = trimmed.slice(slashIndex + 1).trim()
  if (!providerId || !modelId) return null
  return { providerId, modelId }
}
