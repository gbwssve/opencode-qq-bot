export interface Config {
  qq: {
    appId: string
    clientSecret: string
    sandbox: boolean
  }
  opencode: {
    baseUrl: string
  }
  allowedUsers: string[]
  maxReplyLength: number
}

export function loadConfig(): Config {
  const appId = process.env.QQ_APP_ID
  const clientSecret = process.env.QQ_APP_SECRET

  if (!appId) {
    throw new Error("缺少环境变量 QQ_APP_ID")
  }
  if (!clientSecret) {
    throw new Error("缺少环境变量 QQ_APP_SECRET")
  }

  const allowedRaw = process.env.ALLOWED_USERS?.trim() ?? ""
  const allowedUsers = allowedRaw
    ? allowedRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : []

  return {
    qq: {
      appId,
      clientSecret,
      sandbox: process.env.QQ_SANDBOX === "true",
    },
    opencode: {
      baseUrl: process.env.OPENCODE_BASE_URL?.trim() || "http://localhost:54321",
    },
    allowedUsers,
    maxReplyLength: parseInt(process.env.MAX_REPLY_LENGTH ?? "3000", 10),
  }
}
