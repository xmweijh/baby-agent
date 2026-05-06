/**
 * Token 计数工具
 *
 * 使用 gpt-tokenizer（cl100k_base 编码，与 GPT-4 / Claude 等主流模型一致）。
 * 对非字符串内容（如 tool_calls 数组）只做简单估算：按 JSON 长度 / 4。
 */
import { encode } from 'gpt-tokenizer';

/**
 * 统计单条消息的 token 数
 * @param {{ role: string, content?: string|null, tool_calls?: any[] }} message
 * @returns {number}
 */
export function countTokens(message) {
  if (typeof message.content === 'string' && message.content) {
    return encode(message.content).length;
  }
  // tool_calls 或其它非文本内容：按 JSON 字节数粗估
  const raw = JSON.stringify(message);
  return Math.ceil(raw.length / 4);
}
