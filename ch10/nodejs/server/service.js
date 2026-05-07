import { randomUUID } from 'crypto';
import { buildHistory } from './history.js';
import { toSSEMessage } from '../vo/sse.js';
import { EventError } from '../agent/stream.js';

export class Server {
  #db;
  #agent;

  constructor(db, agent) {
    this.#db = db;
    this.#agent = agent;
  }

  // ---- 会话 ----

  createConversation({ user_id, title = '' }) {
    const conv = {
      conversation_id: randomUUID(),
      user_id,
      title: title || '',
      created_at: Math.floor(Date.now() / 1000),
    };
    this.#db.prepare(`
      INSERT INTO conversations (conversation_id, user_id, title, created_at)
      VALUES (@conversation_id, @user_id, @title, @created_at)
    `).run(conv);
    return conv;
  }

  listConversations(userId) {
    const stmt = userId
      ? this.#db.prepare('SELECT * FROM conversations WHERE user_id = ? ORDER BY created_at DESC')
      : this.#db.prepare('SELECT * FROM conversations ORDER BY created_at DESC');
    return userId ? stmt.all(userId) : stmt.all();
  }

  renameConversation(conversationId, title) {
    this.#db.prepare(`
      UPDATE conversations SET title = ? WHERE conversation_id = ?
    `).run(title, conversationId);
    return this.#db.prepare('SELECT * FROM conversations WHERE conversation_id = ?').get(conversationId);
  }

  deleteConversation(conversationId) {
    const deleteMessages = this.#db.prepare('DELETE FROM chat_messages WHERE conversation_id = ?');
    const deleteConv = this.#db.prepare('DELETE FROM conversations WHERE conversation_id = ?');
    this.#db.transaction(() => {
      deleteMessages.run(conversationId);
      deleteConv.run(conversationId);
    })();
  }

  getConversation(conversationId) {
    return this.#db.prepare('SELECT * FROM conversations WHERE conversation_id = ?').get(conversationId);
  }

  // ---- 消息 ----

  listMessages(conversationId) {
    const msgs = this.#db.prepare(`
      SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC
    `).all(conversationId);
    return msgs.map(m => parseMessageVO(m));
  }

  /**
   * createMessage 验证会话、构建历史、启动 agent 流式执行，结束后持久化消息。
   * 通过 onSSEEvent 回调将 SSE 事件推送给调用方（controller 层）。
   *
   * @param {string} conversationId
   * @param {{user_id: string, query: string, parent_message_id?: string}} req
   * @param {AbortSignal} signal
   * @param {(sseMsg: object) => void} onSSEEvent
   */
  async createMessage(conversationId, req, signal, onSSEEvent) {
    // 验证会话存在
    const conv = this.getConversation(conversationId);
    if (!conv) throw new Error(`conversation not found: ${conversationId}`);

    // 从历史消息构建 history
    const historyMsgs = this.#db.prepare(`
      SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC
    `).all(conversationId);
    const history = buildHistory(historyMsgs, req.parent_message_id || '');

    const msgId = randomUUID();
    const createdAt = Math.floor(Date.now() / 1000);

    // 运行 Agent，事件通过回调推送
    let result;
    try {
      result = await this.#agent.runStreaming(
        history,
        req.query,
        signal,
        (event) => onSSEEvent(toSSEMessage(msgId, event)),
      );
    } catch (err) {
      if (!signal?.aborted) {
        onSSEEvent(toSSEMessage(msgId, { event: EventError, content: err.message }));
      }
      result = { response: '', rounds: [], usage: {} };
    }

    // 持久化消息
    this.#db.prepare(`
      INSERT INTO chat_messages
        (message_id, user_id, conversation_id, parent_message_id,
         query, response, rounds, model, usage, created_at)
      VALUES
        (@message_id, @user_id, @conversation_id, @parent_message_id,
         @query, @response, @rounds, @model, @usage, @created_at)
    `).run({
      message_id: msgId,
      user_id: req.user_id,
      conversation_id: conversationId,
      parent_message_id: req.parent_message_id || '',
      query: req.query,
      response: result.response,
      rounds: JSON.stringify(result.rounds),
      model: this.#agent.model(),
      usage: JSON.stringify(result.usage),
      created_at: createdAt,
    });
  }
}

// ---- 辅助函数 ----

function parseMessageVO(msg) {
  return {
    message_id:        msg.message_id,
    conversation_id:   msg.conversation_id,
    parent_message_id: msg.parent_message_id,
    query:             msg.query,
    response:          msg.response,
    model:             msg.model,
    created_at:        msg.created_at,
    rounds:            parseRounds(msg.rounds),
  };
}

/**
 * 将存储的 rounds JSON 转换为前端友好的 RoundMessageVO 列表。
 */
function parseRounds(roundsJSON) {
  if (!roundsJSON) return [];
  let msgs;
  try {
    msgs = JSON.parse(roundsJSON);
  } catch {
    return [];
  }

  const result = [];
  for (const m of msgs) {
    if (m.role === 'user') {
      // user 消息不需要展示
      continue;
    } else if (m.role === 'assistant') {
      if (m.tool_calls?.length > 0) {
        result.push({
          role: 'assistant',
          tool_calls: m.tool_calls.map(tc => ({
            id:        tc.id,
            name:      tc.function?.name,
            arguments: tc.function?.arguments,
          })),
        });
      }
    } else if (m.role === 'tool') {
      result.push({
        role:    'tool',
        tool_id: m.tool_call_id,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      });
    }
  }
  return result;
}
