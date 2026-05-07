// ---- 统一 JSON 响应包装 ----

export function ok(data) {
  return { code: 0, msg: 'ok', data };
}

export function err(code, msg) {
  return { code, msg };
}

// ---- 请求体 ----

/**
 * POST /api/conversation
 * @typedef {Object} CreateConversationReq
 * @property {string} user_id
 * @property {string} [title]
 */

/**
 * PATCH /api/conversation/:id
 * @typedef {Object} UpdateConversationReq
 * @property {string} title
 */

/**
 * POST /api/conversation/:id/message
 * @typedef {Object} CreateMessageReq
 * @property {string} user_id
 * @property {string} query
 * @property {string} [parent_message_id]
 */

// ---- 响应 VO ----

/**
 * @typedef {Object} ConversationVO
 * @property {string} conversation_id
 * @property {string} user_id
 * @property {string} title
 * @property {number} created_at
 */

/**
 * @typedef {Object} ToolCallVO
 * @property {string} id
 * @property {string} name
 * @property {string} arguments
 */

/**
 * @typedef {Object} RoundMessageVO
 * @property {string} role
 * @property {string} [content]
 * @property {ToolCallVO[]} [tool_calls]
 * @property {string} [tool_id]
 */

/**
 * @typedef {Object} ChatMessageVO
 * @property {string} message_id
 * @property {string} conversation_id
 * @property {string} parent_message_id
 * @property {string} query
 * @property {string} response
 * @property {string} model
 * @property {number} created_at
 * @property {RoundMessageVO[]} [rounds]
 */
