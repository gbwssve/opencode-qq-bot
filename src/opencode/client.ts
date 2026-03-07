import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk"

let client: OpencodeClient | null = null

export function createClient(baseUrl: string): OpencodeClient {
  client = createOpencodeClient({ baseUrl })
  return client
}

export function getClient(): OpencodeClient {
  if (!client) throw new Error("OpenCode client not initialized")
  return client
}

export async function healthCheck(oc: OpencodeClient): Promise<void> {
  try {
    await oc.session.list()
    console.log("[opencode] health check passed")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`OpenCode server unreachable: ${msg}`)
  }
}

export type { OpencodeClient }
