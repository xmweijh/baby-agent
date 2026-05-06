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
 * ContextEngine — 上下文管理引擎（第六章扩展版）
 *
 * 相较于第五章，本章新增：
 *   - memory 成员：MultiLevelMemory 实例，在 buildSystemPrompt 时注入 {memory}
 *   - setMemoryEventHook：记忆更新时向 TUI 推送 memory 事件
 *   - commitTurn 在策略执行后调用 memory.update()
 */
export class ContextEngine {
  /**
   * @param {object[]} policies       - 策略实例数组（实现 name/shouldApply/apply 三方法）
   * @param {object|null} memory      - MultiLevelMemory 实例（可为 null）
   * @param {number} [contextWindow]  - 默认上下文窗口大小（tokens）
   */
  constructor(policies = [], memory = null, contextWindow = 200_000) {
    this.systemPromptTemplate = '';
    this.messages = /** @type {MessageWrap[]} */ ([]);
    this.policies = policies;
    this.memory = memory;
    this.contextTokens = 0;
    this.contextWindow = contextWindow;
    this.onPolicyEvent = null; // (name, running, err) => void
    this.onMemoryEvent = null; // (running, err) => void
  }

  /**
   * 初始化：设置 system prompt 模板和 context window 大小
   */
  init(systemPromptTemplate, contextWindow) {
    this.systemPromptTemplate = systemPromptTemplate;
    if (contextWindow > 0) this.contextWindow = contextWindow;
  }

  /**
   * 构建 system prompt（替换占位符：{runtime} / {workspace_path} / {memory}）
   */
  buildSystemPrompt() {
    const runtime = os.platform(); // darwin / linux / win32
    const workspacePath = process.cwd();
    const memoryContent = this.memory ? this.memory.toString() : '';

    return this.systemPromptTemplate
      .replace('{runtime}', runtime)
      .replace('{workspace_path}', workspacePath)
      .replace('{memory}', memoryContent);
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
   * 提交本轮草稿：
   *   1. 把新消息写入历史
   *   2. 运行所有上下文策略（skipPoliciesAndMemory=true 时跳过）
   *   3. 调用 memory.update() 更新记忆（skipPoliciesAndMemory=true 时跳过）
   *
   * ESC 取消场景：传入 skipPoliciesAndMemory=true，仅保存消息不执行策略/记忆，
   * 让用户可以在取消后继续对话而不丢失上下文。
   *
   * @param {TurnDraft} draft
   * @param {boolean} [skipPoliciesAndMemory=false]
   * @returns {Promise<void>}
   */
  async commitTurn(draft, skipPoliciesAndMemory = false) {
    for (const msg of draft.newMessages) {
      this.messages.push({ message: msg, tokens: countTokens(msg) });
    }
    this.#recountTokens();

    if (skipPoliciesAndMemory) return; // ESC 取消：只保存消息，不执行策略和记忆

    await this.#applyPolicies();

    // 更新记忆（策略执行完后运行，避免卸载后的消息影响记忆提取）
    if (this.memory) {
      this.onMemoryEvent?.(true, null);
      let memErr = null;
      try {
        await this.memory.update(draft.newMessages);
      } catch (err) {
        memErr = err;
        console.error('[Memory] update failed:', err.message);
      } finally {
        this.onMemoryEvent?.(false, memErr);
      }
    }
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
   * 设置策略事件钩子
   * @param {((name: string, running: boolean, err: Error|null) => void)|null} hook
   */
  setPolicyEventHook(hook) {
    this.onPolicyEvent = hook;
  }

  /**
   * 设置记忆事件钩子（用于通知 UI 记忆正在更新）
   * @param {((running: boolean, err: Error|null) => void)|null} hook
   */
  setMemoryEventHook(hook) {
    this.onMemoryEvent = hook;
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
