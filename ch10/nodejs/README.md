# 第十章：Web 服务化与 SSE 流式传输 — Node.js 版本

本目录是第十章的 **Node.js 实现**。这一章的核心任务是**服务化**：

> **把 Agent 从 TUI 终端中解放出来，封装成 HTTP 服务，让浏览器也能像 ChatGPT 一样与 Agent 流式对话。**

相较于前几章的 TUI 模式，本章实现了完整的 Web 服务化架构：

- **Agent 与传输层解耦**：Agent 通过回调输出 `StreamEvent`，不感知任何 HTTP 概念
- **SSE 流式传输**：`text/event-stream` 协议将 LLM 输出实时推送到浏览器
- **会话持久化**：SQLite 存储 Conversation / ChatMessage，服务重启后历史不丢失
- **树形消息结构**：`parent_message_id` 支持分支对话，`buildHistory` 沿祖先链重建 LLM context
- **AbortController 取消**：客户端断连时自动取消 Agent 执行，避免资源泄漏

---

## 📁 文件结构

```text
ch10/nodejs/
├── package.json              # 依赖管理（express、better-sqlite3、openai、uuid）
├── main.js                   # 程序入口：初始化 DB + Agent + HTTP 服务（:8080）
├── agent/
│   ├── agent.js              # Agent 核心：runStreaming 接收 history，通过回调输出 StreamEvent
│   ├── stream.js             # StreamEvent 事件常量（与传输层解耦）
│   └── tool/
│       └── bash.js           # BashTool（shell 命令执行）
├── server/
│   ├── db.js                 # better-sqlite3 数据模型 + initDB
│   ├── history.js            # buildHistory：沿 parent_message_id 树追溯，拼接 LLM history
│   ├── service.js            # 业务层：会话/消息 CRUD + Agent 流式执行 + parseRounds
│   └── router.js             # Express Router + SSE 控制器
└── vo/
    ├── vo.js                 # 请求/响应 VO 类型定义 + ok/err 工具函数
    └── sse.js                # SSEMessageVO + toSSEMessage 转换函数
```

---

## 🛠 准备工作

### 1. 安装依赖

```bash
cd ch10/nodejs
npm install
```

### 2. 配置环境

在项目根目录（`baby-agent/`）配置：

```bash
cp .env.example .env          # LLM API Key 等环境变量
cp config.example.json config.json
```

`config.json` 中需要填写 `llm_providers.front_model`：

```json
{
  "llm_providers": {
    "front_model": {
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-your-api-key",
      "model": "gpt-4o-mini",
      "context_window": 128000
    }
  }
}
```

---

## 🚀 运行方式

```bash
cd ch10/nodejs
node main.js
# Database initialized: ch10.db
# BabyAgent ch10 server listening on http://localhost:8080
# Model: gpt-4o-mini
```

服务启动后数据库文件 `ch10.db` 会自动在项目根目录创建。

---

## 💡 使用示例

### API 调用

```bash
# 1. 创建会话
curl -s -X POST http://localhost:8080/api/conversation \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"alice","title":"我的第一个对话"}' | jq .
# {"code":0,"msg":"ok","data":{"conversation_id":"uuid-xxx",...}}

# 2. 发送消息，观察 SSE 流式输出
curl -N -X POST http://localhost:8080/api/conversation/{conversation_id}/message \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"alice","query":"用 JS 写一个冒泡排序"}'

# 流式输出（每行一个 SSE 事件）：
# event: message
# data: {"message_id":"...","event":"content","content":"好的"}
# 
# event: message
# data: {"message_id":"...","event":"tool_call","tool_call":"bash","tool_arguments":"{...}"}
#
# event: message
# data: {"message_id":"...","event":"tool_result","tool_call":"bash","tool_result":"..."}

# 3. 继续对话（传入 parent_message_id 保持上下文）
curl -N -X POST http://localhost:8080/api/conversation/{conversation_id}/message \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"alice","query":"再加上注释","parent_message_id":"{message_id}"}'

# 4. 查询历史消息
curl -s http://localhost:8080/api/conversation/{conversation_id}/message | jq .

# 5. 重命名会话
curl -s -X PATCH http://localhost:8080/api/conversation/{conversation_id} \
  -H 'Content-Type: application/json' \
  -d '{"title":"新标题"}' | jq .

# 6. 删除会话（同时删除所有消息）
curl -s -X DELETE http://localhost:8080/api/conversation/{conversation_id} | jq .
```

### API 接口一览

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/conversation` | 创建会话 |
| `GET` | `/api/conversation?user_id=` | 列出会话 |
| `PATCH` | `/api/conversation/:id` | 重命名会话 |
| `DELETE` | `/api/conversation/:id` | 删除会话及所有消息 |
| `POST` | `/api/conversation/:id/message` | 发送消息（SSE 流式响应） |
| `GET` | `/api/conversation/:id/message` | 查询消息历史 |

### SSE 事件格式

每个 SSE 事件的 `data` 字段是一个 JSON 对象：

| `event` 值 | 含义 | 有效字段 |
|-----------|------|---------|
| `reasoning` | 推理模型的思考内容（流式） | `reasoning_content` |
| `content` | 模型文本输出片段（流式） | `content` |
| `tool_call` | 发起工具调用 | `tool_call`（工具名）、`tool_arguments` |
| `tool_result` | 工具执行结果 | `tool_call`（工具名）、`tool_result` |
| `error` | 错误信息 | `content` |

---

## 💡 Node.js 实现要点

### 1. 回调替代 Channel：Agent 与传输层解耦

Go 版本使用 `chan StreamEvent` 在 Agent 和 HTTP 层之间传递事件；Node.js 是单线程的，没有真正的 goroutine，改用**回调函数**实现同等效果：

```
Go 版本：
  Agent.RunStreaming(ctx, history, query, eventCh chan<- StreamEvent)
  → service 从 channel 消费事件 → HTTP 写 SSE

Node.js 版本：
  agent.runStreaming(history, query, signal, onEvent)
  → onEvent 回调直接调用 service 的 writeSSE → HTTP 写 SSE
```

回调链路更短，无需 goroutine 同步，代码反而更直观：

```javascript
// service.js
result = await agent.runStreaming(
  history, query, signal,
  (event) => onSSEEvent(toSSEMessage(msgId, event)),  // 直接回调
);
```

```javascript
// router.js
await server.createMessage(conversationId, body, ac.signal, writeSSE);

function writeSSE(msgVO) {
  if (res.writableEnded) return;
  res.write(`event: message\ndata: ${JSON.stringify(msgVO)}\n\n`);
}
```

---

### 2. AbortController 替代 context.Context

Go 版本通过 `context.WithCancel()` 传播取消信号；Node.js 使用 Web 标准的 `AbortController` / `AbortSignal`：

```javascript
// router.js
const ac = new AbortController();
req.on('close', () => ac.abort());   // 客户端断开 → 触发 abort

// agent.js：将 signal 传给 OpenAI SDK
const stream = await client.chat.completions.create({
  ...params,
  stream: true,
}, { signal });                       // SDK 自动监听 signal
```

`openai` SDK 原生支持 `AbortSignal`，一旦 `signal.aborted` 为 `true`，SDK 会中断当前 HTTP 请求，`for await` 循环自动退出。Agent loop 末尾也会显式检查：

```javascript
if (signal?.aborted) break;
```

---

### 3. 流式 tool_calls 的手动拼接

OpenAI Streaming API 的 `tool_calls` 是**分片下发**的：第一个 chunk 携带 `id` 和工具名，后续 chunk 追加 `arguments` 字节。Go 版本使用 SDK 的 `ChatCompletionAccumulator` 自动处理；Node.js openai SDK（v4）在 streaming 模式下不提供自动累积，需要手动拼接：

```javascript
const toolCallsMap = {};  // index -> { id, name, arguments }

for await (const chunk of stream) {
  const delta = chunk.choices?.[0]?.delta;
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index;
      if (!toolCallsMap[idx]) toolCallsMap[idx] = { id: '', name: '', arguments: '' };
      if (tc.id)               toolCallsMap[idx].id        = tc.id;
      if (tc.function?.name)   toolCallsMap[idx].name     += tc.function.name;
      if (tc.function?.arguments) toolCallsMap[idx].arguments += tc.function.arguments;
    }
  }
}
const toolCalls = Object.values(toolCallsMap);  // 拼接完成
```

---

### 4. better-sqlite3 替代 GORM

Go 版本使用 GORM ORM；Node.js 版本选择 `better-sqlite3`——一个**同步**的 SQLite 绑定库。

选择同步库的原因：
- SQLite 本身是本地文件 I/O，同步调用极快（微秒级），无需异步
- 避免引入 `async/await` 传染，Service 层代码更简洁
- `better-sqlite3` 的 prepared statement 性能极佳，且线程安全

```javascript
// db.js — 建表（同步，应用启动时一次执行）
const db = new Database('ch10.db');
db.pragma('journal_mode = WAL');  // WAL 模式提升并发读性能
db.exec(`CREATE TABLE IF NOT EXISTS conversations (...)`);

// service.js — 查询（同步，无需 await）
const conv = db.prepare('SELECT * FROM conversations WHERE conversation_id = ?').get(id);

// service.js — 事务（同步，原子保证）
db.transaction(() => {
  deleteMessages.run(conversationId);
  deleteConv.run(conversationId);
})();
```

对比 Go 的 GORM（ORM 抽象）和 Node.js 的 `better-sqlite3`（直接 SQL）：

| 方面 | Go + GORM | Node.js + better-sqlite3 |
|------|-----------|--------------------------|
| 风格 | ORM，自动生成 SQL | 原生 SQL，prepared statement |
| I/O 模型 | 异步（但 SQLite 底层同步） | 同步 API |
| AutoMigrate | `db.AutoMigrate(&Model{})` | 手写 `CREATE TABLE IF NOT EXISTS` |
| UUID | `github.com/google/uuid` | Node.js 内置 `crypto.randomUUID()` |

---

### 5. SSE 手动写响应流

Go 版本使用 Gin 的 `c.SSEvent()` + `c.Writer.Flush()`；Node.js 用 Express + 原生 `res.write()` 直接写 SSE 协议格式：

```javascript
// 设置 SSE 必要响应头
res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
res.setHeader('Cache-Control', 'no-cache');
res.setHeader('Connection', 'keep-alive');
res.setHeader('X-Accel-Buffering', 'no');  // 禁用 Nginx 缓冲（生产必须）
res.flushHeaders();                          // 立即发送响应头，建立 SSE 连接

// 每个事件写入格式：
res.write(`event: message\ndata: ${JSON.stringify(msgVO)}\n\n`);
//         ↑ 事件名         ↑ JSON 数据                   ↑ 双换行表示事件结束
```

`X-Accel-Buffering: no` 是在 Nginx 反向代理场景下必须设置的头，否则 Nginx 会缓冲所有 SSE 数据直到连接关闭，导致流式效果失效。

---

### 6. 树形历史的 buildHistory 实现

Go 和 Node.js 版本的算法完全相同，差异仅在语法层面：

```javascript
// server/history.js
export function buildHistory(allMsgs, parentMessageId) {
  if (!parentMessageId) return [];

  // 构建 id -> message 索引（O(n) 建表，O(1) 查询）
  const index = new Map(allMsgs.map(m => [m.message_id, m]));

  // 从 parentMessageId 向根追溯，收集路径（顺序：parent → 根）
  const path = [];
  let cur = parentMessageId;
  while (cur) {
    const msg = index.get(cur);
    if (!msg) break;
    path.push(msg);
    cur = msg.parent_message_id;
  }

  // 反转为 根 → parent 的顺序，拼接每条消息的 rounds
  path.reverse();
  const history = [];
  for (const msg of path) {
    if (!msg.rounds) continue;
    try { history.push(...JSON.parse(msg.rounds)); }
    catch { /* 跳过损坏的数据 */ }
  }
  return history;
}
```

树形结构示意：

```
根消息（parent_message_id=""）
  └── 第2轮消息（parent=根消息ID）
        ├── 第3轮消息A（parent=第2轮ID）  ← 用户继续对话
        └── 第3轮消息B（parent=第2轮ID）  ← 用户重新生成
```

查询消息B时，`buildHistory` 会追溯 `B → 第2轮 → 根`，将三条消息的 `rounds` 按顺序拼接，还原完整的对话上下文传给 LLM。

---

### 7. Rounds 持久化与恢复

每次 `runStreaming` 结束后，把本轮所有 LLM 消息序列化为 JSON 存入数据库：

```
一次对话轮次的 rounds（存储格式）：
  [
    { role: "user",      content: "用 JS 写冒泡排序" },
    { role: "assistant", content: null, tool_calls: [...] },
    { role: "tool",      tool_call_id: "...", content: "..." },
    { role: "assistant", content: "好的，这是代码：..." }
  ]
      ↓ JSON.stringify
  存入 chat_messages.rounds 字段（TEXT）
      ↓ 下次对话时 JSON.parse
  恢复为消息数组，作为 history 传给 Agent
```

这样即使服务重启，历史对话也能完整恢复，因为 LLM 需要的全部上下文都保存在 `rounds` 里。

---

### 8. parseRounds：rounds → 前端友好格式

`rounds` 字段存储的是 LLM 协议格式，包含较多冗余字段，对前端展示不友好。`parseRounds` 函数将其转换为精简的 `RoundMessageVO` 格式：

```javascript
function parseRounds(roundsJSON) {
  const msgs = JSON.parse(roundsJSON);
  return msgs
    .filter(m => m.role !== 'user')   // user 消息已有 query 字段，无需重复
    .map(m => {
      if (m.role === 'assistant' && m.tool_calls?.length > 0) {
        return { role: 'assistant', tool_calls: m.tool_calls.map(tc => ({
          id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments,
        })) };
      }
      if (m.role === 'tool') {
        return { role: 'tool', tool_id: m.tool_call_id, content: m.content };
      }
    })
    .filter(Boolean);
}
```

---

## 📊 模块关系速览

```
main.js
  ├── initDB('ch10.db')                    # better-sqlite3 同步初始化
  ├── new Agent(modelConf, SystemPrompt, [BashTool])
  ├── new Server(db, agent)
  └── express().use('/api', createRouter(server)).listen(8080)

POST /api/conversation/:id/message
  ├── router.js → server.createMessage(conversationId, body, signal, writeSSE)
  │     ├── buildHistory(allMsgs, parent_message_id)  # 树形追溯
  │     ├── agent.runStreaming(history, query, signal, onEvent)
  │     │     ├── [LLM 流式返回 content]
  │     │     │     └── onEvent({ event: 'content', content: '...' })
  │     │     │           └── writeSSE(toSSEMessage(msgId, event))
  │     │     │                 └── res.write('event: message\ndata: {...}\n\n')
  │     │     ├── [LLM 返回 tool_calls]
  │     │     │     ├── onEvent({ event: 'tool_call', ... })
  │     │     │     ├── BashTool.execute(argsJSON)
  │     │     │     └── onEvent({ event: 'tool_result', ... })
  │     │     └── return { response, rounds, usage }
  │     └── db.prepare('INSERT INTO chat_messages ...').run(...)   # 持久化
  └── res.end()
```

---

## 🆚 与 Go 版本对比

| 特性 | Go 版本 | Node.js 版本 |
|------|---------|-------------|
| HTTP 框架 | Gin | Express |
| 数据库 | GORM + SQLite | better-sqlite3（同步 API） |
| 并发模型 | goroutine | 单线程事件循环 |
| 事件传递 | `chan StreamEvent` | 回调函数 `onEvent` |
| 取消信号 | `context.Context` | `AbortController` / `AbortSignal` |
| SSE 写响应 | `c.SSEvent()` + `c.Writer.Flush()` | `res.write('event: ...\ndata: ...\n\n')` |
| tool_calls 累积 | SDK `ChatCompletionAccumulator` | 手动拼接 `toolCallsMap` |
| UUID 生成 | `github.com/google/uuid` | Node.js 内置 `crypto.randomUUID()` |
| 数据库 Schema | GORM `AutoMigrate` | 手写 `CREATE TABLE IF NOT EXISTS` |
| ORM 风格 | 结构体 tag 映射 | 原生 SQL prepared statement |

---

## 📖 与前序章节对比

| 功能 | ch06~09 TUI | ch10 Web 服务 |
|------|------------|--------------|
| 运行方式 | 终端 TUI | HTTP 服务 + 浏览器 |
| 对话历史 | 内存（进程内） | SQLite 持久化 |
| 多轮上下文 | ContextEngine（内存） | buildHistory（数据库追溯） |
| 流式输出 | ANSI TUI 渲染 | SSE（`text/event-stream`） |
| 取消机制 | ESC 键 | 客户端断开连接 |
| 多会话 | ❌ | ✅（会话管理 API） |
| 分支对话 | ❌ | ✅（树形 parent_message_id） |
| Context 策略/记忆 | ✅ | ❌（本章有意简化，聚焦服务化） |

> ch10 有意去掉了 TUI、上下文管理、记忆等高级特性，只保留最核心的 Agent Loop + bash 工具，专注解决服务化这一工程问题。

---

## 🖥 配套前端

`frontend/` 目录包含一个配套的 React + TypeScript 前端（Vite + Tailwind CSS），实现了侧边栏会话列表、流式消息气泡（含推理内容折叠）、工具调用折叠面板。

```bash
cd frontend
pnpm install
pnpm dev   # 开发模式，自动代理 /api 到 localhost:8080
```

前端通过 `@microsoft/fetch-event-source` 消费 SSE 流，代理配置在 `vite.config.ts`：

```typescript
server: { proxy: { '/api': 'http://localhost:8080' } }
```

---

## 📚 延伸知识

### Server-Sent Events（SSE）协议

SSE 是 HTTP/1.1 标准协议，比 WebSocket 更轻量，适合**单向推送**（服务端 → 客户端）场景：

```
# SSE 帧格式（纯文本）
event: message          ← 事件类型（可选，不写则为 message）
data: {"key":"value"}   ← 事件数据（必须）
                        ← 空行表示一个事件结束
```

**SSE vs WebSocket 选择原则**：
- SSE：单向推送、基于 HTTP、自动重连、实现简单 → Agent 对话场景首选
- WebSocket：双向通信、持久连接、协议升级 → 实时协作、游戏等场景

**客户端消费 SSE（浏览器原生 API）**：

```javascript
const es = new EventSource('/api/conversation/xxx/message?...');
es.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  console.log(msg.event, msg.content);
});
```

### Little's Law 与 Agent 并发

Agent 服务的 Duration 动辄 30 秒，用 Little's Law 计算并发：

```
并发数 = QPS × Duration
10 QPS × 30s = 300 个并发请求同时维持状态
```

这意味着 Node.js 的单线程事件循环在 Agent 场景中**特别合适**：I/O 等待时（等待 LLM 响应）完全不阻塞，可以同时处理数百个 SSE 连接的写入。

### SQLite WAL 模式

`db.pragma('journal_mode = WAL')` 开启 Write-Ahead Logging 模式：

- **普通模式**：写入时独占锁，读写互斥
- **WAL 模式**：写入追加到 WAL 文件，读取不受阻塞，读写并发

对于 Agent 服务（多个并发请求同时读写历史），WAL 模式可以显著降低锁竞争。

---

## 🔗 精选扩展阅读

- [MDN: Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) — SSE 官方文档
- [better-sqlite3 文档](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md) — 同步 SQLite API
- [AbortController MDN](https://developer.mozilla.org/en-US/docs/Web/API/AbortController) — Web 标准取消机制
- [OpenAI Streaming Guide](https://platform.openai.com/docs/api-reference/streaming) — OpenAI 流式 API 文档
- [Little's Law](https://en.wikipedia.org/wiki/Little%27s_law) — 排队理论基础
