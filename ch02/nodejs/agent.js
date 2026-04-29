import OpenAI from 'openai';

/**
 * Agent — 最小可用 Agent 循环
 *
 * 对应 Go 版本：ch02/agent.go
 *
 * 核心流程（Tool Loop / ReAct Loop）：
 *   1. 将用户消息追加到对话历史
 *   2. 调用 LLM，携带所有工具定义
 *   3. 如果模型返回 tool_calls → 执行工具 → 把结果追加为 tool 消息 → 回到步骤 2
 *   4. 如果模型没有返回 tool_calls → 任务完成，返回最终文本
 *
 * 多轮对话：每个 Agent 实例维护一份 messages 历史，
 * 不同主题的对话应创建不同 Agent 实例。
 */
export class Agent {
  /**
   * @param {object} options
   * @param {string} options.baseURL    - LLM API Base URL
   * @param {string} options.apiKey     - API Key
   * @param {string} options.model      - 模型名称
   * @param {string} options.systemPrompt - 系统提示词
   * @param {Array}  options.tools      - 工具实例数组（实现 name/info/execute 方法）
   */
  constructor({ baseURL, apiKey, model, systemPrompt, tools = [] }) {
    this.model = model;
    this.tools = new Map(tools.map((t) => [t.name(), t]));

    this.client = new OpenAI({ baseURL, apiKey });

    // 初始化消息历史，先注入系统提示
    this.messages = [{ role: 'system', content: systemPrompt }];
  }

  /**
   * 执行指定工具
   * @param {string} toolName
   * @param {string} argumentsInJSON
   * @returns {Promise<string>}
   */
  async #execute(toolName, argumentsInJSON) {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }
    return tool.execute(argumentsInJSON);
  }

  /**
   * 构建 tools 参数数组（传给 OpenAI API）
   * @returns {Array}
   */
  #buildToolsParam() {
    return [...this.tools.values()].map((t) => t.info());
  }

  /**
   * 运行一轮用户请求，驱动完整的 Tool Loop 直到 LLM 产出最终回答。
   *
   * @param {string} query - 用户输入
   * @returns {Promise<string>} - LLM 最终回答
   */
  async run(query) {
    // 1. 追加用户消息
    this.messages.push({ role: 'user', content: query });

    // eslint-disable-next-line no-constant-condition
    while (true) {
      console.error(`[Agent] Calling LLM model: ${this.model} ...`);

      // 2. 调用 LLM（非流式）
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: this.messages,
        tools: this.#buildToolsParam(),
      });

      if (!response.choices || response.choices.length === 0) {
        console.error('[Agent] No choices returned from LLM');
        return '';
      }

      const message = response.choices[0].message;

      // 3. 把 assistant 消息追加到历史（无论是否含 tool_calls）
      this.messages.push(message);

      // 4. 没有 tool_calls → 任务完成
      if (!message.tool_calls || message.tool_calls.length === 0) {
        return message.content ?? '';
      }

      // 5. 有 tool_calls → 逐一执行，把结果追加为 tool 消息
      for (const toolCall of message.tool_calls) {
        const { name, arguments: argsJson } = toolCall.function;
        console.error(`[Agent] Executing tool: ${name}, args: ${argsJson}`);

        let toolResult;
        try {
          toolResult = await this.#execute(name, argsJson);
        } catch (err) {
          // 工具执行失败时，把错误信息返回给 LLM，让它自行处理
          toolResult = `Error: ${err.message}`;
          console.error(`[Agent] Tool error: ${err.message}`);
        }

        // tool 消息格式：role="tool"，tool_call_id 必须与请求中的 id 对应
        this.messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult,
        });
      }

      // 6. 继续下一轮推理（Tool Loop 回到步骤 2）
    }
  }
}
