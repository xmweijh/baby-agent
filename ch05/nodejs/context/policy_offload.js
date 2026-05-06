import { countTokens } from './share.js';

/**
 * OffloadPolicy — 卸载策略
 *
 * 当上下文使用率超过阈值时，把较早的、内容较长的 tool 消息的正文卸载到 Storage，
 * 在消息体里只保留摘要片段和一个 load_storage(key) 提示，节省 context token。
 *
 * 只卸载 role === 'tool' 的消息，且内容长度超过 previewCharLimit。
 * 最近 keepRecentMessages 条消息跳过，保留原始内容供 LLM 直接参考。
 */
export class OffloadPolicy {
  /**
   * @param {import('../storage.js').MemoryStorage} storage
   * @param {number} usageThreshold       - 触发阈值（0.0 ~ 1.0）
   * @param {number} keepRecentMessages   - 最近 N 条消息不卸载
   * @param {number} previewCharLimit     - 保留的摘要字符数
   */
  constructor(storage, usageThreshold, keepRecentMessages, previewCharLimit) {
    this.storage = storage;
    this.usageThreshold = usageThreshold;
    this.keepRecentMessages = keepRecentMessages;
    this.previewCharLimit = previewCharLimit;
  }

  name() { return 'offload'; }

  shouldApply(engine) {
    return engine.getContextUsage() > this.usageThreshold;
  }

  #makeStorageKey(index) {
    const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 15);
    return `/offload/${ts}_${index}`;
  }

  /**
   * @param {import('./engine.js').ContextEngine} engine
   * @returns {Promise<{ messages: import('./engine.js').MessageWrap[] }>}
   */
  async apply(engine) {
    const msgs = engine.messages;

    if (msgs.length <= this.keepRecentMessages) {
      return { messages: msgs };
    }

    // 浅拷贝，避免直接修改 engine.messages
    const newMsgs = [...msgs];
    const offloadCount = msgs.length - this.keepRecentMessages;

    for (let i = 0; i < offloadCount; i++) {
      const wrap = msgs[i];
      if (wrap.message.role !== 'tool') continue;

      const content = wrap.message.content;
      if (typeof content !== 'string' || content.length <= this.previewCharLimit) continue;

      const key = this.#makeStorageKey(i);
      try {
        await this.storage.store(key, content);
      } catch (err) {
        console.error(`[offload] store failed for key=${key}: ${err.message}`);
        continue;
      }

      const preview = content.slice(0, this.previewCharLimit);
      const newContent =
        `${preview}...\n（更多内容已卸载，如需查看全文请使用 load_storage(key="${key}") 工具）\n`;

      // 重建 tool message（保留 tool_call_id）
      const newMsg = {
        role: 'tool',
        tool_call_id: wrap.message.tool_call_id,
        content: newContent,
      };

      newMsgs[i] = { message: newMsg, tokens: countTokens(newMsg) };
    }

    return { messages: newMsgs };
  }
}
