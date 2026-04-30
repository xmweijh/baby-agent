export const MessageTypeReasoning = 'reasoning';
export const MessageTypeContent = 'content';
export const MessageTypeToolCall = 'tool_call';
export const MessageTypeError = 'error';

export function reasoningMessage(content) {
  return { type: MessageTypeReasoning, reasoningContent: content };
}

export function contentMessage(content) {
  return { type: MessageTypeContent, content };
}

export function toolCallMessage(name, argumentsText) {
  return {
    type: MessageTypeToolCall,
    toolCall: { name, arguments: argumentsText },
  };
}

export function errorMessage(content) {
  return { type: MessageTypeError, content };
}
