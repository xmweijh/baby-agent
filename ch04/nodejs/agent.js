import OpenAI from 'openai';
import {
  contentMessage,
  errorMessage,
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

function reasoningText(delta) {
  return delta.reasoningContent || delta.reasoning || delta.thinking || '';
}

/**
 * Agent — 支持 native 工具 + MCP 工具的流式 Agent Loop
 *
 * 工具来源：
 *   - nativeTools：本地实现的工具（如 bash），通过 Map 按名路由
 *   - mcpClients：MCP 客户端数组，每个客户端管理多个 McpTool
 *
 * 工具查找顺序：nativeTools → mcpClients（遍历所有 McpTool）
 */
export class Agent {
  /**
   * @param {object} options
   * @param {string} options.baseURL
   * @param {string} options.apiKey
   * @param {string} options.model
   * @param {string} options.systemPrompt
   * @param {Array}  options.tools        - native 工具实例数组（实现 name/info/execute）
   * @param {Array}  options.mcpClients   - McpClient 实例数组
   */
  constructor({ baseURL, apiKey, model, systemPrompt, tools = [], mcpClients = [] }) {
    this.systemPrompt = systemPrompt;
    this.model = model;
    this.client = new OpenAI({ baseURL, apiKey });
    this.nativeTools = new Map(tools.map((t) => [t.name(), t]));
    this.mcpClients = mcpClients;
    this.messages = [{ role: 'system', content: systemPrompt }];
  }

  resetSession() {
    this.messages = [{ role: 'system', content: this.systemPrompt }];
  }

  /**
   * 构建传给 OpenAI API 的 tools 数组（native + 所有 MCP 工具合并）
   */
  #buildTools() {
    const result = [...this.nativeTools.values()].map((t) => t.info());
    for (const mcpClient of this.mcpClients) {
      for (const mcpTool of mcpClient.getTools()) {
        result.push(mcpTool.info());
      }
    }
    return result;
  }

  /**
   * 按工具名查找工具并执行
   * 查找顺序：native → MCP（先找到先执行）
   */
  async #execute(toolName, argumentsInJSON) {
    // 1. 查 native tools
    const native = this.nativeTools.get(toolName);
    if (native) {
      return native.execute(argumentsInJSON);
    }
    // 2. 查 MCP tools（遍历所有 client 的所有 tool）
    for (const mcpClient of this.mcpClients) {
      for (const mcpTool of mcpClient.getTools()) {
        if (mcpTool.name() === toolName) {
          return mcpTool.execute(argumentsInJSON);
        }
      }
    }
    throw new Error(`Tool not found: ${toolName}`);
  }

  /**
   * 流式运行一轮对话，通过 onEvent 回调实时推送事件给 UI
   *
   * @param {string} query
   * @param {(event: object) => void} onEvent
   * @param {AbortSignal} [signal]
   */
  async runStreaming(query, onEvent, signal) {
    const messages = [...this.messages, { role: 'user', content: query }];

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

      // 手动累积 delta，流式响应结束后拼出完整 assistant message
      // 注意：stream.finalChatCompletion() 仅在 client.beta.chat.completions.stream()
      // 链式 API 下可用；使用原生 for await...of 时必须自行累积
      let accContent = '';
      const accToolCalls = [];

      try {
        for await (const chunk of stream) {
          if (!chunk.choices?.length) continue;
          const choice = chunk.choices[0];
          const deltaRaw = choice.delta ?? {};
          const delta = parseDeltaWithReasoning(deltaRaw);

          const reason = reasoningText(delta);
          if (reason) onEvent?.(reasoningMessage(reason));
          if (delta.content) {
            accContent += delta.content;
            onEvent?.(contentMessage(delta.content));
          }

          // 累积 tool_calls（按 index 分组拼接 arguments）
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
        if (signal?.aborted) throw err;
        onEvent?.(errorMessage(err.message));
        throw err;
      }

      // 组装完整 assistant message
      const message = {
        role: 'assistant',
        content: accContent || null,
      };
      const validToolCalls = accToolCalls.filter(Boolean);
      if (validToolCalls.length > 0) message.tool_calls = validToolCalls;

      messages.push(message);

      if (!message.tool_calls?.length) {
        this.messages = messages;
        return;
      }

      for (const toolCall of message.tool_calls) {
        onEvent?.(toolCallMessage(toolCall.function.name, toolCall.function.arguments));

        let toolResult;
        try {
          toolResult = await this.#execute(toolCall.function.name, toolCall.function.arguments);
        } catch (err) {
          toolResult = `Error: ${err.message}`;
          onEvent?.(errorMessage(toolResult));
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult,
        });
      }
    }
  }
}
