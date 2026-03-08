// @input:  ./http (apiRequest)
// @output: getNextMsgSeq, sendC2CMessage, sendC2CInputNotify, sendGroupMessage, MessageResponse
// @pos:    qq层 - QQ Bot 消息发送 (文本消息 + 输入状态)

import { apiRequest } from "./http.js"

/**
 * 生成消息序号，范围固定为 0~65535。
 * 用时间戳低位与随机数混合，避免进程内碰撞。
 */
export function getNextMsgSeq(_msgId: string): number {
  const timePart = Date.now() % 100000000
  const random = Math.floor(Math.random() * 65536)
  return (timePart ^ random) % 65536
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
