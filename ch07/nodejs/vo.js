export const MessageTypeReasoning = 'reasoning';
export const MessageTypeContent   = 'content';
export const MessageTypeToolCall  = 'tool_call';
export const MessageTypeError     = 'error';
export const MessageTypePolicy    = 'policy';
export const MessageTypeMemory    = 'memory';
export const MessageTypeIndex     = 'index';   // 索引进度事件（ch07 新增）

export function reasoningMessage(content) {
  return { type: MessageTypeReasoning, reasoningContent: content };
}
export function contentMessage(content) {
  return { type: MessageTypeContent, content };
}
export function toolCallMessage(name, args) {
  return { type: MessageTypeToolCall, toolCall: { name, arguments: args } };
}
export function errorMessage(content) {
  return { type: MessageTypeError, content };
}
export function policyMessage(name, running, err = null) {
  return { type: MessageTypePolicy, policy: { name, running, err } };
}
export function memoryMessage(running, err = null) {
  return { type: MessageTypeMemory, memory: { running, err } };
}
/**
 * indexMessage — 索引状态事件（ch07 新增）
 * @param {boolean} running - true=索引中，false=完成
 * @param {string|null} summary - 完成时的摘要信息（文件数、块数等）
 * @param {Error|null} err
 */
export function indexMessage(running, summary = null, err = null) {
  return { type: MessageTypeIndex, index: { running, summary, err } };
}
