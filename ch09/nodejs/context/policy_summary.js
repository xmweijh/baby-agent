import { countTokens } from './share.js';

/**
 * summary prompt 模板 — 与 Go 版本保持一致
 */
const SUMMARY_PROMPT_TEMPLATE = `Summarize the following conversation history between a user and an AI assistant.

<previous_summary>
{previous_summary}
</previous_summary>

<conversation>
{text}
</conversation>

Requirements:
- Preserve key information: user requests, tool calls, and important results
- Keep the summary under {summary_length} words
- Output ONLY the summary, no explanations
- Use concise language, omit redundant details

Example:

Input:
user: What files are in the current directory?
assistant: I'll use the bash tool to list files.
tool: file1.txt file2.go directory/
assistant: The directory contains file1.txt, file2.go, and a directory/.

Output:
User asked to list directory contents. Assistant ran bash command showing file1.txt, file2.go, and a directory.
`;

/**
 * LLMSummarizer — 使用 LLM 生成对话摘要
 *
 * 接口约定（鸭子类型）：
 *   getSummaryInputTokenLimit(): number
 *   summarize(runningSummary, messages): Promise<string>
 */
export class LLMSummarizer {
  /**
   * @param {import('openai').default} client      - openai client
   * @param {string} model                          - 摘要用模型（建议用便宜的 back_model）
   * @param {number} contextWindow                  - 模型 context window（tokens）
   * @param {number} summaryCharLimit               - 摘要目标字数上限
   */
  constructor(client, model, contextWindow, summaryCharLimit) {
    this.client = client;
    this.model = model;
    this.contextWindow = contextWindow;
    this.summaryCharLimit = summaryCharLimit;
  }

  getSummaryInputTokenLimit() {
    return Math.floor(this.contextWindow / 2);
  }

  /**
   * @param {string} runningSummary - 已有的累积摘要（首次为空字符串）
   * @param {object[]} messages     - 待摘要的消息列表
   * @returns {Promise<string>}
   */
  async summarize(runningSummary, messages) {
    // 把消息格式化成 "role: content" 纯文本
    const text = messages
      .map((m) => {
        const content =
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
        return `${m.role}: ${content}`;
      })
      .join('\n');

    const prompt = SUMMARY_PROMPT_TEMPLATE
      .replace('{previous_summary}', runningSummary)
      .replace('{text}', text)
      .replace('{summary_length}', String(this.summaryCharLimit));

    const resp = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
    });

    return resp.choices?.[0]?.message?.content ?? '';
  }
}

/**
 * SummaryPolicy — 摘要策略
 *
 * 当上下文使用率超过阈值时，把较早的消息通过 LLM 压缩成一段摘要文本，
 * 用一条 user message 替换原来多条消息，大幅节省 context token。
 *
 * 摘要采用分批处理（summaryBatchSize），每批不超过 inputTokenLimit，
 * 并利用 runningSummary 做滚动摘要，保证超长历史也能被压缩。
 */
export class SummaryPolicy {
  /**
   * @param {LLMSummarizer} summarizer
   * @param {number} keepRecentMessages - 最近 N 条消息不纳入摘要
   * @param {number} summaryBatchSize   - 每批最多摘要的消息数
   * @param {number} usageThreshold     - 触发阈值（0.0 ~ 1.0）
   */
  constructor(summarizer, keepRecentMessages, summaryBatchSize, usageThreshold) {
    this.summarizer = summarizer;
    this.keepRecentMessages = keepRecentMessages;
    this.summaryBatchSize = summaryBatchSize;
    this.usageThreshold = usageThreshold;
  }

  name() { return 'summarize'; }

  shouldApply(engine) {
    return engine.getContextUsage() > this.usageThreshold;
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

    const summarizeUntil = msgs.length - this.keepRecentMessages;
    const inputTokenLimit = this.summarizer.getSummaryInputTokenLimit();

    let runningSummary = '';
    let batchStart = 0;

    while (batchStart < summarizeUntil) {
      const batchMsgs = [];
      let batchTokens = 0;

      for (let i = batchStart; i < summarizeUntil; i++) {
        const msgTokens = msgs[i].tokens;
        if (batchTokens + msgTokens > inputTokenLimit && batchMsgs.length > 0) break;
        batchMsgs.push(msgs[i].message);
        batchTokens += msgTokens;
        if (batchMsgs.length >= this.summaryBatchSize) break;
      }

      if (batchMsgs.length === 0) break;

      runningSummary = await this.summarizer.summarize(runningSummary, batchMsgs);
      batchStart += batchMsgs.length;
    }

    if (!runningSummary) {
      console.error('[summary] no summary generated');
      return { messages: msgs };
    }

    // 用一条 user message 替换原来的多条历史消息
    const summaryMsg = { role: 'user', content: runningSummary };
    const summaryWrap = { message: summaryMsg, tokens: countTokens(summaryMsg) };

    return {
      messages: [summaryWrap, ...msgs.slice(summarizeUntil)],
    };
  }
}
