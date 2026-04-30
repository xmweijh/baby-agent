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

export class Agent {
  constructor({ baseURL, apiKey, model, systemPrompt, tools = [] }) {
    this.systemPrompt = systemPrompt;
    this.model = model;
    this.client = new OpenAI({ baseURL, apiKey });
    this.tools = new Map(tools.map((tool) => [tool.name(), tool]));
    this.messages = [{ role: 'system', content: systemPrompt }];
  }

  resetSession() {
    this.messages = [{ role: 'system', content: this.systemPrompt }];
  }

  #buildTools() {
    return [...this.tools.values()].map((tool) => tool.info());
  }

  async #execute(toolName, argumentsInJSON) {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }
    return tool.execute(argumentsInJSON);
  }

  /**
   * 流式运行一轮对话。
   *
   * @param {string} query
   * @param {(event: any) => void} onEvent
   * @param {AbortSignal} signal
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
        }, {
          signal,
        });
      } catch (err) {
        onEvent?.(errorMessage(err.message));
        throw err;
      }

      // 手动累积流式 delta，构建最终 message
      let accContent = '';
      let accToolCalls = [];  // [{index, id, type, function: {name, arguments}}]

      try {
        for await (const chunk of stream) {
          if (!chunk.choices || chunk.choices.length === 0) {
            continue;
          }

          const choice = chunk.choices[0];
          const deltaRaw = choice.delta ?? {};
          const delta = parseDeltaWithReasoning(deltaRaw);

          const reason = reasoningText(delta);
          if (reason) {
            onEvent?.(reasoningMessage(reason));
          }

          if (delta.content) {
            accContent += delta.content;
            onEvent?.(contentMessage(delta.content));
          }

          // 累积 tool_calls（每个 chunk 只含增量片段）
          if (deltaRaw.tool_calls) {
            for (const tc of deltaRaw.tool_calls) {
              const idx = tc.index ?? 0;
              if (!accToolCalls[idx]) {
                accToolCalls[idx] = {
                  id: tc.id ?? '',
                  type: tc.type ?? 'function',
                  function: { name: tc.function?.name ?? '', arguments: '' },
                };
              } else {
                if (tc.id) accToolCalls[idx].id = tc.id;
                if (tc.function?.name) accToolCalls[idx].function.name += tc.function.name;
              }
              if (tc.function?.arguments) {
                accToolCalls[idx].function.arguments += tc.function.arguments;
              }
            }
          }
        }
      } catch (err) {
        if (signal?.aborted) {
          throw err;
        }
        onEvent?.(errorMessage(err.message));
        throw err;
      }

      // 组装最终 message
      const message = { role: 'assistant', content: accContent || null };
      if (accToolCalls.length > 0) {
        message.tool_calls = accToolCalls.filter(Boolean);
      }

      messages.push(message);

      if (!message.tool_calls || message.tool_calls.length === 0) {
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
