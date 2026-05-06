import os from 'os';
import process from 'process';
import { countTokens } from './share.js';

/**
 * messageWrap — 内部消息封装，同时携带 token 计数
 * @typedef {{ message: object, tokens: number }} MessageWrap
 */

/**
 * TurnDraft — 当前轮次的"草稿"，commit 前不影响历史上下文
 * @typedef {{ newMessages: object[] }} TurnDraft
 */

/**
 * ContextEngine — 上下文管理引擎
 *
 * 核心职责：
 *   1. 以 messageWrap[] 存储带 token 计数的历史消息
 *   2. 提供 StartTurn / CommitTurn / AbortTurn 三段式写入接口
 *   3. CommitTurn 后依次尝试所有策略，超过阈值则执行对应策略
 *   4. BuildRequestMessages() 组装 system prompt + 历史消息，供 LLM 请求使用
 */
export class ContextEngine {
  /**
   * @param {object[]} policies - 策略实例数组（实现 name/shouldApply/apply 三方法）
   * @param {number} [contextWindow=200000] - 默认上下文窗口大小（tokens）
   */
  constructor(policies = [], contextWindow = 200_000) {
    this.systemPromptTemplate = '';
    this.messages = /** @type {MessageWrap[]} */ ([]);
    this.policies = policies;
    this.contextTokens = 0;
    this.contextWindow = contextWindow;
    this.onPolicyEvent = null; // (name, running, err) => void
  }

  /**
   * 初始化：设置 system prompt 模板和 context window 大小
   */
  init(systemPromptTemplate, contextWindow) {
    this.systemPromptTemplate = systemPromptTemplate;
    if (contextWindow > 0) this.contextWindow = contextWindow;
  }

  /**
   * 构建 system prompt（替换 {runtime} / {workspace_path} 占位符）
   */
  buildSystemPrompt() {
    const runtime = os.platform(); // darwin / linux / win32
    const workspacePath = process.cwd();
    return this.systemPromptTemplate
      .replace('{runtime}', runtime)
      .replace('{workspace_path}', workspacePath);
  }

  /**
   * 构建传给 LLM 的完整消息列表（system prompt + 历史消息）
   * @returns {object[]}
   */
  buildRequestMessages() {
    const result = [];
    if (this.systemPromptTemplate) {
      result.push({ role: 'system', content: this.buildSystemPrompt() });
    }
    for (const wrap of this.messages) {
      result.push(wrap.message);
    }
    return result;
  }

  /**
   * 开始一轮对话，返回草稿（草稿包含 user message，尚未计入历史）
   * @param {{ role: string, content: string }} userMsg
   * @returns {TurnDraft}
   */
  startTurn(userMsg) {
    return { newMessages: [userMsg] };
  }

  /**
   * 提交本轮草稿：把新消息写入历史，然后运行所有策略
   * @param {TurnDraft} draft
   * @returns {Promise<void>}
   */
  async commitTurn(draft) {
    for (const msg of draft.newMessages) {
      this.messages.push({ message: msg, tokens: countTokens(msg) });
    }
    this.#recountTokens();
    await this.#applyPolicies();
  }

  /**
   * 丢弃本轮草稿（无需操作，草稿从不直接修改 this.messages）
   */
  abortTurn(_draft) {
    // no-op：草稿只在内存，从未写入 this.messages
  }

  /**
   * 上下文使用率（0.0 ~ 1.0+）
   */
  getContextUsage() {
    if (this.contextWindow <= 0) return 0;
    return this.contextTokens / this.contextWindow;
  }

  /**
   * 设置策略事件钩子（用于通知 UI 策略正在执行）
   * @param {((name: string, running: boolean, err: Error|null) => void)|null} hook
   */
  setPolicyEventHook(hook) {
    this.onPolicyEvent = hook;
  }

  /**
   * 清空所有消息（保留 system prompt 模板和 context window 配置）
   */
  reset() {
    this.messages = [];
    this.contextTokens = 0;
  }

  // ─── 内部方法 ────────────────────────────────────────────────

  #recountTokens() {
    this.contextTokens = this.messages.reduce((sum, w) => sum + w.tokens, 0);
  }

  async #applyPolicies() {
    for (const policy of this.policies) {
      if (!policy.shouldApply(this)) continue;

      this.onPolicyEvent?.(policy.name(), true, null);
      let err = null;
      try {
        const result = await policy.apply(this);
        this.messages = result.messages;
        this.#recountTokens();
      } catch (e) {
        err = e;
        throw e;
      } finally {
        this.onPolicyEvent?.(policy.name(), false, err);
      }
    }
  }
}
