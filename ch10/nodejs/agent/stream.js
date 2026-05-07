// StreamEvent 是 agent 内部流式输出的事件类型，与传输层无关

export const EventError      = 'error';
export const EventReasoning  = 'reasoning';
export const EventContent    = 'content';
export const EventToolCall   = 'tool_call';
export const EventToolResult = 'tool_result';

/**
 * @typedef {Object} StreamEvent
 * @property {string} event            - 事件类型（见上方常量）
 * @property {string} [content]        - 文本内容（content / error 事件）
 * @property {string} [reasoningContent] - 推理内容（reasoning 事件）
 * @property {string} [toolCall]       - 工具名（tool_call / tool_result 事件）
 * @property {string} [toolArguments] - 工具入参 JSON（tool_call 事件）
 * @property {string} [toolResult]    - 工具执行结果（tool_result 事件）
 */
