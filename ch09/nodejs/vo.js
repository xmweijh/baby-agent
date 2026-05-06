/**
 * vo.js — 消息类型常量与工厂函数（第八章扩展版）
 *
 * 相较于第七章，本章新增：
 *   - MessageTypeToolConfirm：工具调用确认请求消息
 *   - ConfirmationAction：确认动作枚举（Allow / Reject / AlwaysAllow）
 *   - toolConfirmMessage：工具确认消息工厂函数
 */

export const MessageTypeReasoning   = 'reasoning';
export const MessageTypeContent     = 'content';
export const MessageTypeToolCall    = 'tool_call';
export const MessageTypeError       = 'error';
export const MessageTypePolicy      = 'policy';
export const MessageTypeMemory      = 'memory';
export const MessageTypeToolConfirm = 'tool_confirm'; // 第八章新增：工具确认

/**
 * ConfirmationAction — 用户对工具调用确认框的操作
 *   - allow:       允许本次调用
 *   - reject:      拒绝本次调用（终止 Agent Loop）
 *   - alwaysAllow: 允许并记录，当前会话同名工具不再确认
 */
export const ConfirmationAction = Object.freeze({
  allow:       'allow',
  reject:      'reject',
  alwaysAllow: 'alwaysAllow',
});

// ── 消息工厂函数 ────────────────────────────────────────────────

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
 * toolConfirmMessage — 工具调用确认请求（第八章新增）
 * @param {string} toolName   - 工具名称
 * @param {string} args       - 工具参数 JSON 字符串
 * @returns {object}
 */
export function toolConfirmMessage(toolName, args) {
  return {
    type: MessageTypeToolConfirm,
    toolConfirmRequest: { toolName, arguments: args },
  };
}
