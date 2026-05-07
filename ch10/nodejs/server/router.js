import express from 'express';
import { ok, err } from '../vo/vo.js';
import { EventError } from '../agent/stream.js';
import { toSSEMessage } from '../vo/sse.js';

/**
 * 创建 Express Router，挂载所有 /api 路由。
 * @param {import('./service.js').Server} server
 * @returns {express.Router}
 */
export function createRouter(server) {
  const router = express.Router();

  // POST /api/conversation — 创建会话
  router.post('/conversation', (req, res) => {
    try {
      if (!req.body?.user_id) {
        return res.status(400).json(err(400, 'user_id is required'));
      }
      const result = server.createConversation(req.body);
      res.json(ok(result));
    } catch (e) {
      res.status(500).json(err(500, e.message));
    }
  });

  // GET /api/conversation — 列出会话
  router.get('/conversation', (req, res) => {
    try {
      const result = server.listConversations(req.query.user_id || '');
      res.json(ok(result));
    } catch (e) {
      res.status(500).json(err(500, e.message));
    }
  });

  // PATCH /api/conversation/:conversation_id — 重命名会话
  router.patch('/conversation/:conversation_id', (req, res) => {
    try {
      const { title } = req.body || {};
      if (!title) return res.status(400).json(err(400, 'title is required'));
      const result = server.renameConversation(req.params.conversation_id, title);
      if (!result) return res.status(404).json(err(404, 'conversation not found'));
      res.json(ok(result));
    } catch (e) {
      res.status(500).json(err(500, e.message));
    }
  });

  // DELETE /api/conversation/:conversation_id — 删除会话
  router.delete('/conversation/:conversation_id', (req, res) => {
    try {
      server.deleteConversation(req.params.conversation_id);
      res.json(ok({ conversation_id: req.params.conversation_id }));
    } catch (e) {
      res.status(500).json(err(500, e.message));
    }
  });

  // GET /api/conversation/:conversation_id/message — 查询消息历史
  router.get('/conversation/:conversation_id/message', (req, res) => {
    try {
      const result = server.listMessages(req.params.conversation_id);
      res.json(ok(result));
    } catch (e) {
      res.status(500).json(err(500, e.message));
    }
  });

  // POST /api/conversation/:conversation_id/message — 发送消息（SSE 流式响应）
  router.post('/conversation/:conversation_id/message', async (req, res) => {
    const { conversation_id } = req.params;
    const body = req.body || {};

    if (!body.user_id || !body.query) {
      return res.status(400).json(err(400, 'user_id and query are required'));
    }

    // 检查会话是否存在（提前验证，避免 SSE 开流后才报错）
    const conv = server.getConversation(conversation_id);
    if (!conv) {
      return res.status(404).json(err(404, 'conversation not found'));
    }

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');  // 禁用 Nginx 缓冲
    res.flushHeaders();

    // 创建 AbortController，客户端断开连接时取消 Agent 执行
    const ac = new AbortController();
    req.on('close', () => ac.abort());

    /**
     * 将 SSEMessageVO 写入响应流
     * SSE 格式: "event: message\ndata: <JSON>\n\n"
     */
    function writeSSE(msgVO) {
      if (res.writableEnded) return;
      res.write(`event: message\ndata: ${JSON.stringify(msgVO)}\n\n`);
    }

    try {
      await server.createMessage(conversation_id, body, ac.signal, writeSSE);
    } catch (e) {
      if (!res.writableEnded) {
        writeSSE(toSSEMessage('', { event: EventError, content: e.message }));
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  return router;
}
