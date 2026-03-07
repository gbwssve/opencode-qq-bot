import type { OpencodeClient } from "./client.js"

interface UserSession {
  sessionId: string
  title?: string
  modelId?: string
  providerId?: string
  agentId?: string
}

export class SessionManager {
  private sessions = new Map<string, UserSession>()
  private client: OpencodeClient

  constructor(client: OpencodeClient) {
    this.client = client
  }

  async getOrCreate(userId: string): Promise<UserSession> {
    const existing = this.sessions.get(userId)
    if (existing) return existing

    const result = await this.client.session.create({})
    const session: UserSession = {
      sessionId: result.data!.id,
      title: result.data!.title,
    }
    this.sessions.set(userId, session)
    return session
  }

  async createNew(userId: string): Promise<UserSession> {
    const result = await this.client.session.create({})
    const session: UserSession = {
      sessionId: result.data!.id,
      title: result.data!.title,
    }
    this.sessions.set(userId, session)
    return session
  }

  switchSession(userId: string, sessionId: string, title?: string): void {
    this.sessions.set(userId, {
      ...this.sessions.get(userId),
      sessionId,
      title,
    })
  }

  getSession(userId: string): UserSession | undefined {
    return this.sessions.get(userId)
  }

  setModel(userId: string, providerId: string, modelId: string): void {
    const s = this.sessions.get(userId)
    if (s) {
      s.providerId = providerId
      s.modelId = modelId
    }
  }

  setAgent(userId: string, agentId: string): void {
    const s = this.sessions.get(userId)
    if (s) {
      s.agentId = agentId
    }
  }

  getModel(userId: string): { providerId?: string; modelId?: string } {
    const s = this.sessions.get(userId)
    return { providerId: s?.providerId, modelId: s?.modelId }
  }

  getAgent(userId: string): string | undefined {
    return this.sessions.get(userId)?.agentId
  }
}

export type { UserSession }
