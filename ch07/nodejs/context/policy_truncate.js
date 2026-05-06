/**
 * TruncatePolicy — 截断策略
 *
 * 当上下文使用率超过阈值时，删除较早的历史消息，只保留最近 keepRecentMessages 条。
 * 为了维护对话的语义完整性，截断点会对齐到最近的一条 user 消息（避免孤立的 assistant/tool 消息）。
 */
export class TruncatePolicy {
  /**
   * @param {number} keepRecentMessages - 保留最近 N 条消息（不被截断）
   * @param {number} usageThreshold     - 触发阈值（0.0 ~ 1.0），超过此值才执行截断
   */
  constructor(keepRecentMessages, usageThreshold) {
    this.keepRecentMessages = keepRecentMessages;
    this.usageThreshold = usageThreshold;
  }

  name() { return 'truncate'; }

  shouldApply(engine) {
    return engine.getContextUsage() > this.usageThreshold;
  }

  /**
   * 执行截断：返回新的 messages 数组（纯函数，不修改 engine）
   * @param {import('./engine.js').ContextEngine} engine
   * @returns {{ messages: import('./engine.js').MessageWrap[] }}
   */
  apply(engine) {
    const msgs = engine.messages;

    if (msgs.length <= this.keepRecentMessages) {
      return { messages: msgs };
    }

    // 找到前半段（候选截断区）
    const toRemove = msgs.length - this.keepRecentMessages;

    // 从候选区末尾往前找最后一条 user 消息，以该消息为截断起点
    let removeIdx = toRemove - 1;
    for (let i = toRemove - 1; i >= 0; i--) {
      if (msgs[i].message.role === 'user') {
        removeIdx = i;
        break;
      }
    }

    // 如果截断起点是 0，什么都不做（否则会清空所有历史）
    if (removeIdx <= 0) {
      return { messages: msgs };
    }

    return { messages: msgs.slice(removeIdx) };
  }
}
