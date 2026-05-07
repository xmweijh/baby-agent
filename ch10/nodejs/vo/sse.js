// SSEMessageVO：SSE 事件的 JSON 格式

export const SSETypeError      = 'error';
export const SSETypeReasoning  = 'reasoning';
export const SSETypeContent    = 'content';
export const SSETypeToolCall   = 'tool_call';
export const SSETypeToolResult = 'tool_result';

/**
 * @typedef {Object} SSEMessageVO
 * @property {string}  message_id
 * @property {string}  event
 * @property {string}  [content]
 * @property {string}  [reasoning_content]
 * @property {string}  [tool_call]
 * @property {string}  [tool_arguments]
 * @property {string}  [tool_result]
 */

/**
 * 将 StreamEvent 转换为 SSEMessageVO 对象
 * @param {string} messageId
 * @param {import('../agent/stream.js').StreamEvent} event
 * @returns {SSEMessageVO}
 */
export function toSSEMessage(messageId, event) {
  const msg = { message_id: messageId, event: event.event };
  switch (event.event) {
    case SSETypeReasoning:
      msg.reasoning_content = event.reasoningContent;
      break;
    case SSETypeContent:
    case SSETypeError:
      msg.content = event.content;
      break;
    case SSETypeToolCall:
      msg.tool_call = event.toolCall;
      msg.tool_arguments = event.toolArguments;
      break;
    case SSETypeToolResult:
      msg.tool_call = event.toolCall;
      msg.tool_result = event.toolResult;
      break;
  }
  return msg;
}
