import OpenAI from 'openai';
import {
  EventError, EventReasoning, EventContent,
  EventToolCall, EventToolResult,
} from './stream.js';

export const SystemPrompt = `# BabyAgent

You are BabyAgent, a helpful coding assistant.

## Guidelines
- State intent before tool calls, but NEVER predict or claim results before receiving them.
- Before modifying a file, read it first. Do not assume files or directories exist.
- If a tool call fails, analyze the error before retrying with a different approach.
- Ask for clarification when the request is ambiguous.

Reply directly with text for conversations.
`;

export class Agent {
  #model;
  #client;
  #tools;      // Map<string, Tool>
  #systemPrompt;

  constructor(modelConf, systemPrompt, tools = []) {
    this.#model = modelConf.model;
    this.#systemPrompt = systemPrompt;
    this.#client = new OpenAI({
      apiKey: modelConf.apiKey,
      baseURL: modelConf.baseUrl,
      defaultHeaders: { 'x-request-source': 'babyagent' },
    });
    this.#tools = new Map();
    for (const t of tools) {
      this.#tools.set(t.toolName(), t);
    }
  }

  model() { return this.#model; }

  #buildTools() {
    return [...this.#tools.values()].map(t => t.info());
  }

  async #executeTool(toolName, argsJSON) {
    const t = this.#tools.get(toolName);
    if (!t) throw new Error(`tool not found: ${toolName}`);
    return t.execute(argsJSON);
  }

  /**
   * RunStreaming 执行 agent loop，通过 onEvent 回调流式输出，结束后返回 RunResult。
   *
   * @param {Array} history - 本会话之前所有 ChatMessage.rounds 反序列化后的消息列表
   * @param {string} query  - 用户本轮提问
   * @param {AbortSignal} signal - 取消信号
   * @param {(event: import('./stream.js').StreamEvent) => void} onEvent - 事件回调
   * @returns {Promise<{response: string, rounds: Array, usage: object}>}
   */
  async runStreaming(history, query, signal, onEvent) {
    // 构建本轮消息：system + 历史 + 当前 user 消息
    const messages = [
      { role: 'system', content: this.#systemPrompt },
      ...history,
      { role: 'user', content: query },
    ];

    // roundMessages 记录本轮新增消息（user + assistant + tool，不含 system 和历史）
    const roundMessages = [{ role: 'user', content: query }];

    let usage = {};
    let finalResponse = '';

    for (;;) {
      const stream = await this.#client.chat.completions.create({
        model: this.#model,
        messages,
        tools: this.#buildTools(),
        stream: true,
        stream_options: { include_usage: true },
      }, { signal });

      // 累积 streaming 输出
      let assistantContent = '';
      let reasoningContent = '';
      const toolCallsMap = {};  // index -> { id, name, arguments }

      for await (const chunk of stream) {
        // 用量信息在最后一个 chunk
        if (chunk.usage) usage = chunk.usage;

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // 推理内容（deepseek-r1 等模型）
        if (delta.reasoning_content) {
          reasoningContent += delta.reasoning_content;
          onEvent({ event: EventReasoning, reasoningContent: delta.reasoning_content });
        }

        // 普通文本
        if (delta.content) {
          assistantContent += delta.content;
          onEvent({ event: EventContent, content: delta.content });
        }

        // tool calls（流式拼接）
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCallsMap[idx]) {
              toolCallsMap[idx] = { id: tc.id || '', name: '', arguments: '' };
            }
            if (tc.function?.name) toolCallsMap[idx].name += tc.function.name;
            if (tc.function?.arguments) toolCallsMap[idx].arguments += tc.function.arguments;
            if (tc.id) toolCallsMap[idx].id = tc.id;
          }
        }
      }

      const toolCalls = Object.values(toolCallsMap);

      // 构造 assistant 消息并追加
      const assistantMsg = {
        role: 'assistant',
        content: assistantContent || null,
        ...(toolCalls.length > 0 ? {
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
        } : {}),
      };
      messages.push(assistantMsg);
      roundMessages.push(assistantMsg);

      // 没有 tool call，结束 loop
      if (toolCalls.length === 0) {
        finalResponse = assistantContent;
        break;
      }

      // 执行 tool calls
      for (const tc of toolCalls) {
        onEvent({ event: EventToolCall, toolCall: tc.name, toolArguments: tc.arguments });

        let toolResult;
        try {
          toolResult = await this.#executeTool(tc.name, tc.arguments);
        } catch (err) {
          toolResult = err.message;
          onEvent({ event: EventError, content: toolResult });
        }
        onEvent({ event: EventToolResult, toolCall: tc.name, toolResult });

        const toolMsg = { role: 'tool', tool_call_id: tc.id, content: toolResult };
        messages.push(toolMsg);
        roundMessages.push(toolMsg);
      }

      // 检查是否被取消
      if (signal?.aborted) break;
    }

    return { response: finalResponse, rounds: roundMessages, usage };
  }
}
