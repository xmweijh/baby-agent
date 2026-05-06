/**
 * agent.js — Agent 核心（第八章扩展版）
 *
 * 相较于第七章，本章新增：
 *   1. ToolConfirmConfig：工具确认配置（哪些工具需要执行前确认）
 *   2. alwaysAllowTools：当前会话"始终允许"的工具集合（ConfirmAlwaysAllow 后加入）
 *   3. confirmCh：与 TUI 通信的确认 channel（Promise-based）
 *   4. ESC 取消支持：检测 AbortSignal，取消时 commitTurn(draft, true) 保存消息但跳过策略/记忆
 *   5. findTool()：统一工具查找（native + MCP）
 */

import OpenAI from 'openai';
import {
  contentMessage,
  errorMessage,
  memoryMessage,
  policyMessage,
  reasoningMessage,
  toolCallMessage,
  toolConfirmMessage,
  ConfirmationAction,
} from './vo.js';

function parseDeltaWithReasoning(delta = {}) {
  return {
    content: delta.content ?? '',
    reasoningContent: delta.reasoning_content ?? '',
    reasoning: delta.reasoning ?? '',
    thinking: delta.thinking ?? '',
  };
}

function reasoningText(d) {
  return d.reasoningContent || d.reasoning || d.thinking || '';
}

export class Agent {
  /**
   * @param {object} options
   * @param {string} options.baseURL
   * @param {string} options.apiKey
   * @param {string} options.model
   * @param {number} [options.contextWindow]
   * @param {string} options.systemPrompt
   * @param {Array}  options.tools              - native 工具实例数组
   * @param {Array}  [options.mcpClients]       - McpClient 实例数组（可选）
   * @param {import('./context/engine.js').ContextEngine} options.contextEngine
   * @param {ToolConfirmConfig} [options.confirmConfig]  - 工具确认配置（第八章新增）
   */
  constructor({ baseURL, apiKey, model, contextWindow, systemPrompt, tools = [], mcpClients = [], contextEngine, confirmConfig = {} }) {
    this.model       = model;
    this.client      = new OpenAI({ baseURL, apiKey });
    this.nativeTools = new Map(tools.map((t) => [t.name(), t]));
    this.mcpClients  = mcpClients;
    this.contextEngine = contextEngine;

    // 工具确认配置（第八章新增）
    // requireConfirmTools: Set<string>，需要确认的工具名集合
    this.requireConfirmTools = new Set(confirmConfig.requireConfirmTools ?? []);
    // alwaysAllowTools：当前会话中用户选择"始终允许"的工具（会话级缓存）
    this.alwaysAllowTools    = new Set();

    // 初始化 ContextEngine
    contextEngine.init(systemPrompt, contextWindow ?? 0);
  }

  resetSession() {
    this.contextEngine.reset();
    // 清空"始终允许"记录（与会话绑定）
    this.alwaysAllowTools.clear();
  }

  // ── 工具查找（统一入口：native + MCP）──────────────────────────

  /**
   * 根据工具名查找工具实例
   * @param {string} toolName
   * @returns {{ tool: object, isMcp: boolean } | null}
   */
  #findTool(toolName) {
    const native = this.nativeTools.get(toolName);
    if (native) return { tool: native, isMcp: false };

    for (const mcpClient of this.mcpClients) {
      for (const mcpTool of mcpClient.getTools()) {
        if (mcpTool.name() === toolName) return { tool: mcpTool, isMcp: true };
      }
    }
    return null;
  }

  #buildTools() {
    const result = [...this.nativeTools.values()].map((t) => t.info());
    for (const mcpClient of this.mcpClients) {
      for (const mcpTool of mcpClient.getTools()) {
        result.push(mcpTool.info());
      }
    }
    return result;
  }

  // ── 流式运行 ─────────────────────────────────────────────────

  /**
   * 流式运行一轮对话
   *
   * @param {string} query
   * @param {(event: object) => void} onEvent    - 事件回调（发给 TUI）
   * @param {AbortSignal} [signal]               - ESC 取消信号
   * @param {() => Promise<string>} [askConfirm] - 第八章新增：等待用户确认的异步函数
   *   返回 ConfirmationAction.allow / reject / alwaysAllow
   */
  async runStreaming(query, onEvent, signal, askConfirm) {
    // 设置策略事件钩子
    this.contextEngine.setPolicyEventHook((name, running, err) => {
      onEvent?.(policyMessage(name, running, err));
    });
    // 设置记忆事件钩子
    this.contextEngine.setMemoryEventHook((running, err) => {
      onEvent?.(memoryMessage(running, err));
    });

    const userMsg = { role: 'user', content: query };
    const draft   = this.contextEngine.startTurn(userMsg);

    const messages = [
      ...this.contextEngine.buildRequestMessages(),
      ...draft.newMessages,
    ];

    try {
      while (true) {
        // 检查 ESC 取消
        if (signal?.aborted) {
          await this.contextEngine.commitTurn(draft, true); // 保存消息，跳过策略/记忆
          return;
        }

        let stream;
        try {
          stream = await this.client.chat.completions.create({
            model: this.model,
            messages,
            tools: this.#buildTools(),
            stream: true,
          }, { signal });
        } catch (err) {
          onEvent?.(errorMessage(err.message));
          throw err;
        }

        // 手动累积 delta
        let accContent = '';
        const accToolCalls = [];

        try {
          for await (const chunk of stream) {
            if (!chunk.choices?.length) continue;
            const deltaRaw = chunk.choices[0].delta ?? {};
            const delta    = parseDeltaWithReasoning(deltaRaw);

            const reason = reasoningText(delta);
            if (reason) onEvent?.(reasoningMessage(reason));
            if (delta.content) {
              accContent += delta.content;
              onEvent?.(contentMessage(delta.content));
            }

            for (const tc of deltaRaw.tool_calls ?? []) {
              const idx = tc.index ?? 0;
              if (!accToolCalls[idx]) {
                accToolCalls[idx] = {
                  id: tc.id ?? '',
                  type: 'function',
                  function: { name: tc.function?.name ?? '', arguments: '' },
                };
              }
              if (tc.function?.arguments) {
                accToolCalls[idx].function.arguments += tc.function.arguments;
              }
            }
          }
        } catch (err) {
          if (signal?.aborted) {
            // ESC 取消：保存草稿消息，跳过策略和记忆
            await this.contextEngine.commitTurn(draft, true);
            return;
          }
          onEvent?.(errorMessage(err.message));
          throw err;
        }

        // 组装 assistant message
        const assistantMsg = { role: 'assistant', content: accContent || null };
        const validToolCalls = accToolCalls.filter(Boolean);
        if (validToolCalls.length > 0) assistantMsg.tool_calls = validToolCalls;

        messages.push(assistantMsg);
        draft.newMessages.push(assistantMsg);

        // 无 tool call → 本轮结束
        if (!assistantMsg.tool_calls?.length) break;

        // ── 执行工具调用 ──────────────────────────────────────
        for (const toolCall of assistantMsg.tool_calls) {
          const found = this.#findTool(toolCall.function.name);
          if (!found) {
            const errMsg = `Tool not found: ${toolCall.function.name}`;
            onEvent?.(errorMessage(errMsg));
            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: errMsg });
            draft.newMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: errMsg });
            continue;
          }

          const { tool } = found;
          const toolName = tool.name();

          // 工具确认流程（第八章核心功能）
          const needConfirm = this.requireConfirmTools.has(toolName) && !this.alwaysAllowTools.has(toolName);
          if (needConfirm && askConfirm) {
            // 通知 TUI 显示确认框
            onEvent?.(toolConfirmMessage(toolCall.function.name, toolCall.function.arguments));

            // 等待用户选择
            let action;
            try {
              action = await askConfirm();
            } catch {
              // askConfirm 被 abort（ESC）
              await this.contextEngine.commitTurn(draft, true);
              return;
            }

            if (action === ConfirmationAction.reject) {
              // 用户拒绝 → 向 LLM 返回拒绝信息，循环继续（LLM 会给出最终回复）
              const rejectMsg = { role: 'tool', tool_call_id: toolCall.id, content: 'User rejected the tool call.' };
              messages.push(rejectMsg);
              draft.newMessages.push(rejectMsg);
              continue;
            }

            if (action === ConfirmationAction.alwaysAllow) {
              this.alwaysAllowTools.add(toolName);
            }
            // action === allow：继续执行
          }

          // 执行工具
          let toolResult;
          try {
            toolResult = await tool.execute(toolCall.function.arguments);
          } catch (err) {
            toolResult = `Error: ${err.message}`;
            onEvent?.(errorMessage(toolResult));
          }

          onEvent?.(toolCallMessage(toolCall.function.name, toolCall.function.arguments));

          const toolMsg = { role: 'tool', tool_call_id: toolCall.id, content: toolResult };
          messages.push(toolMsg);
          draft.newMessages.push(toolMsg);
        }

        // 每轮工具执行后检查 ESC 取消
        if (signal?.aborted) {
          await this.contextEngine.commitTurn(draft, true);
          return;
        }
      }

      // 正常结束：执行策略 + 记忆更新
      await this.contextEngine.commitTurn(draft, false);
    } catch (err) {
      this.contextEngine.abortTurn(draft);
      throw err;
    } finally {
      this.contextEngine.setPolicyEventHook(null);
      this.contextEngine.setMemoryEventHook(null);
    }
  }
}
