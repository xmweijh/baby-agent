import OpenAI from 'openai';
import {
  contentMessage,
  errorMessage,
  indexMessage,
  memoryMessage,
  policyMessage,
  reasoningMessage,
  toolCallMessage,
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

/**
 * Agent — 集成 ContextEngine（含 Memory + Agentic RAG 工具）的流式 Agent
 *
 * 相较于第六章，本章新增：
 *   - SemanticSearchTool：语义搜索工具，让 LLM 自主决定何时检索代码库
 *   - indexer：可选的代码库索引器，在 Agent 启动时自动索引
 */
export class Agent {
  /**
   * @param {object} options
   * @param {string} options.baseURL
   * @param {string} options.apiKey
   * @param {string} options.model
   * @param {number} [options.contextWindow]
   * @param {string} options.systemPrompt
   * @param {Array}  options.tools        - native 工具实例数组
   * @param {Array}  options.mcpClients   - McpClient 实例数组（可选）
   * @param {import('./context/engine.js').ContextEngine} options.contextEngine
   */
  constructor({ baseURL, apiKey, model, contextWindow, systemPrompt, tools = [], mcpClients = [], contextEngine }) {
    this.model = model;
    this.client = new OpenAI({ baseURL, apiKey });
    this.nativeTools = new Map(tools.map((t) => [t.name(), t]));
    this.mcpClients = mcpClients;
    this.contextEngine = contextEngine;

    // 初始化 ContextEngine
    contextEngine.init(systemPrompt, contextWindow ?? 0);
  }

  resetSession() {
    this.contextEngine.reset();
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

  async #execute(toolName, argumentsInJSON) {
    const native = this.nativeTools.get(toolName);
    if (native) return native.execute(argumentsInJSON);

    for (const mcpClient of this.mcpClients) {
      for (const mcpTool of mcpClient.getTools()) {
        if (mcpTool.name() === toolName) return mcpTool.execute(argumentsInJSON);
      }
    }
    throw new Error(`Tool not found: ${toolName}`);
  }

  /**
   * 流式运行一轮对话
   * @param {string} query
   * @param {(event: object) => void} onEvent
   * @param {AbortSignal} [signal]
   */
  async runStreaming(query, onEvent, signal) {
    // 1. 设置策略事件钩子
    this.contextEngine.setPolicyEventHook((name, running, err) => {
      onEvent?.(policyMessage(name, running, err));
    });
    // 2. 设置记忆事件钩子
    this.contextEngine.setMemoryEventHook((running, err) => {
      onEvent?.(memoryMessage(running, err));
    });

    // 3. 开始草稿
    const userMsg = { role: 'user', content: query };
    const draft = this.contextEngine.startTurn(userMsg);

    // 4. 构建初始请求消息（历史 + 当前 user）
    const messages = [
      ...this.contextEngine.buildRequestMessages(),
      ...draft.newMessages,
    ];

    try {
      while (true) {
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
            const delta = parseDeltaWithReasoning(deltaRaw);

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
            this.contextEngine.abortTurn(draft);
            throw err;
          }
          onEvent?.(errorMessage(err.message));
          throw err;
        }

        // 组装 assistant message 并推入草稿 + 当前请求链
        const assistantMsg = { role: 'assistant', content: accContent || null };
        const validToolCalls = accToolCalls.filter(Boolean);
        if (validToolCalls.length > 0) assistantMsg.tool_calls = validToolCalls;

        messages.push(assistantMsg);
        draft.newMessages.push(assistantMsg);

        // 无 tool call → 本轮结束
        if (!assistantMsg.tool_calls?.length) break;

        // 有 tool call → 执行并继续循环
        for (const toolCall of assistantMsg.tool_calls) {
          onEvent?.(toolCallMessage(toolCall.function.name, toolCall.function.arguments));

          let toolResult;
          try {
            toolResult = await this.#execute(toolCall.function.name, toolCall.function.arguments);
          } catch (err) {
            toolResult = `Error: ${err.message}`;
            onEvent?.(errorMessage(toolResult));
          }

          const toolMsg = {
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResult,
          };
          messages.push(toolMsg);
          draft.newMessages.push(toolMsg);
        }
      }

      // 5. CommitTurn：写入历史 + 执行策略 + 更新记忆
      await this.contextEngine.commitTurn(draft);
    } catch (err) {
      this.contextEngine.abortTurn(draft);
      throw err;
    } finally {
      this.contextEngine.setPolicyEventHook(null);
      this.contextEngine.setMemoryEventHook(null);
    }
  }
}
