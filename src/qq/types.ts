/**
 * QQ Bot 基础配置
 */
export interface QQBotConfig {
  appId: string
  clientSecret: string
}

/**
 * 富媒体附件
 */
export interface MessageAttachment {
  content_type: string
  filename?: string
  height?: number
  width?: number
  size?: number
  url: string
  voice_wav_url?: string
}

/**
 * C2C 消息事件
 */
export interface C2CMessageEvent {
  author: {
    id: string
    union_openid: string
    user_openid: string
  }
  content: string
  id: string
  timestamp: string
  message_scene?: {
    source: string
  }
  attachments?: MessageAttachment[]
}

/**
 * 频道 AT 消息事件
 */
export interface GuildMessageEvent {
  id: string
  channel_id: string
  guild_id: string
  content: string
  timestamp: string
  author: {
    id: string
    username?: string
    bot?: boolean
  }
  member?: {
    nick?: string
    joined_at?: string
  }
  attachments?: MessageAttachment[]
}

/**
 * 群聊 AT 消息事件
 */
export interface GroupMessageEvent {
  author: {
    id: string
    member_openid: string
  }
  content: string
  id: string
  timestamp: string
  group_id: string
  group_openid: string
  attachments?: MessageAttachment[]
}

/**
 * Hello 事件数据
 */
export interface GatewayHelloData {
  heartbeat_interval: number
}

/**
 * READY 事件数据
 */
export interface GatewayReadyData {
  session_id: string
}

/**
 * WebSocket 事件负载
 */
export interface WSPayload<T = unknown> {
  op: number
  d?: T
  s?: number
  t?: string
}

/**
 * 桥接层统一使用的消息上下文
 */
export interface MessageContext {
  type: "c2c" | "group"
  userId: string
  groupId?: string
  msgId: string
  content: string
  timestamp?: string
  rawEvent?: C2CMessageEvent | GroupMessageEvent
}
