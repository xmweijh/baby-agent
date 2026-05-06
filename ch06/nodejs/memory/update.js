import OpenAI from 'openai';
import { MemoryContent } from './memory.js';

/**
 * update.js — LLM 驱动的记忆更新器
 *
 * LLMMemoryUpdater 接口约定（鸭子类型）：
 *   update(oldMemory: MemoryContent, newMessages: object[]): Promise<MemoryContent>
 *
 * 工作流程：
 *   1. 把本轮对话消息序列化为文本
 *   2. 组装 Prompt（当前记忆 + 新消息 + 更新指令）
 *   3. 调用 back_model（廉价模型）生成更新后的记忆
 *   4. 用正则从 LLM 输出中提取 <global>…</global> 和 <workspace>…</workspace>
 *   5. 返回新的 MemoryContent
 */
export class LLMMemoryUpdater {
  /**
   * @param {object} options
   * @param {string} options.baseURL
   * @param {string} options.apiKey
   * @param {string} options.model  - 推荐使用便宜的 back_model
   */
  constructor({ baseURL, apiKey, model }) {
    this.client = new OpenAI({ baseURL, apiKey });
    this.model = model;
  }

  /**
   * @param {MemoryContent} oldMemory
   * @param {object[]} newMessages - OpenAI message 格式的对话消息
   * @returns {Promise<MemoryContent>}
   */
  async update(oldMemory, newMessages) {
    if (!newMessages || newMessages.length === 0) return oldMemory;

    // 把消息序列化为可读文本（只处理 text content，跳过 tool_calls 等）
    const messagesText = newMessages
      .filter((m) => typeof m.content === 'string' && m.content)
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');

    if (!messagesText.trim()) return oldMemory;

    const prompt = UPDATE_MEMORY_PROMPT
      .replace('{current_memory}', oldMemory.toString())
      .replace('{new_messages}', messagesText);

    let respContent = '';
    try {
      const resp = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
      });
      respContent = resp.choices?.[0]?.message?.content ?? '';
    } catch (err) {
      console.error('[Memory] LLM update failed:', err.message);
      return oldMemory;
    }

    if (!respContent) return oldMemory;

    const globalMemory = extractXMLTag(respContent, 'global');
    const workspaceMemory = extractXMLTag(respContent, 'workspace');

    // 如果两者都为空（LLM 没有按格式返回），保留旧记忆
    if (!globalMemory && !workspaceMemory) return oldMemory;

    return new MemoryContent(
      globalMemory || oldMemory.globalMemory,
      workspaceMemory || oldMemory.workspaceMemory,
    );
  }
}

/**
 * 用正则从文本中提取 <tagName>…</tagName> 的内容（支持多行）
 * @param {string} content
 * @param {string} tagName
 * @returns {string}
 */
function extractXMLTag(content, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<${escaped}>([\\s\\S]*?)<\\/${escaped}>`);
  const match = content.match(pattern);
  return match ? match[1].trim() : '';
}

const UPDATE_MEMORY_PROMPT = `You are a memory management system for an AI coding assistant. Your task is to analyze conversation messages and update two levels of memory.

## Current Memory
{current_memory}

## New Messages to Process
{new_messages}

## Instructions

Analyze the new messages and update the two memory levels accordingly. Each memory level should be formatted in Markdown.

### Global Memory (User-level)
- User preferences, coding style, frequently used tools/libraries
- Long-term patterns observed across conversations
- User's background, expertise level, recurring needs

### Workspace Memory (Project-level)
- Project structure, architecture, key files
- Build commands, test commands, deployment processes
- Project-specific conventions, tech stack
- Issues encountered and their solutions

## Output Format

Return the updated memories using XML tags. Each memory content should be a valid Markdown string:

<global>
<updated global memory in Markdown format>
</global>

<workspace>
<updated workspace memory in Markdown format>
</workspace>

## Guidelines

1. Use Markdown formatting:
   - Use ## for section headings within a memory level
   - Use - for bullet points
   - Use **bold** for emphasis
   - Use backticks for code, commands, and file names

2. Content principles:
   - Be concise but informative
   - Only update memory levels affected by new messages
   - Preserve existing important information
   - Remove outdated or superseded information

3. If a memory level doesn't need updates, return it unchanged

## Example

Input messages:
- User: I prefer using vim for editing and always run tests with verbose flag
- User: Can you help me set up a Go project?
- Assistant: Created go.mod and main.go files. Used module name "example.com/myapp"

Output:
<global>
## User Preferences
- **Editor**: vim
- **Testing**: Always use verbose flag
</global>

<workspace>
## Project Structure
- go.mod - module: example.com/myapp
- main.go - application entry point
</workspace>

Now process the messages and return the updated memory using XML tags with Markdown-formatted content.
`;
