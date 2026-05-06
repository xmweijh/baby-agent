export const MessageTypeReasoning = 'reasoning';
export const MessageTypeContent   = 'content';
export const MessageTypeToolCall  = 'tool_call';
export const MessageTypeError     = 'error';
export const MessageTypePolicy    = 'policy';
export const MessageTypeMemory    = 'memory';

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
/**
 * memoryMessage — 记忆更新状态事件
 * @param {boolean} running - true=更新中，false=更新结束
 * @param {Error|null} err  - 更新失败时的错误
 */
export function memoryMessage(running, err = null) {
  return { type: MessageTypeMemory, memory: { running, err } };
}
