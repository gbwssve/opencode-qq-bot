export function buildHelpText(): string {
  return [
    "可用命令（短别名 或 /全称）：",
    "nw | /new - 创建新会话",
    "st | /stop - 停止当前 AI 运行",
    "ss | /status - 查看状态",
    "sn | /sessions - 历史会话，回复序号切换",
    "hp | /help - 查看帮助",
    "md | /model - 列出/切换模型",
    "ag | /agent - 列出/切换 Agent",
    "rn | /rename <name> - 重命名会话",
  ].join("\n")
}
