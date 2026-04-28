# 第一章：初识 LLM — Node.js 版本

本目录是第一章的 **Node.js 实现**，与 Go 版本（`../README.md`）功能完全对等。如果你更熟悉 JavaScript / TypeScript 生态，可以从这里入手。

---

## 📁 文件结构

```
ch01/nodejs/
├── package.json    # 依赖管理（对应 Go 的 go.mod）
├── main.js         # 入口，解析命令行参数（对应 Go 的 main/main.go）
├── raw.js          # 原生 fetch 实现（对应 Go 的 raw.go）
└── sdk.js          # 官方 SDK 实现（对应 Go 的 sdk.go）
```

---

## 🛠 准备工作

### 1. 环境要求

- **Node.js 18+**（需要内置 `fetch` API）
- 如果你的版本低于 18，需额外安装 `node-fetch`

### 2. 安装依赖

```bash
cd ch01/nodejs
npm install
```

本项目依赖：
- `openai`：官方 Node.js SDK
- `dotenv`：从 `.env` 文件加载环境变量（对应 Go 的 `godotenv`）

### 3. 配置环境变量

在**项目根目录**（`baby-agent/`）创建 `.env` 文件：

```env
# 如果你使用国内模型（如 DeepSeek/GLM），修改 Base URL 和 Model
OPENAI_API_KEY=sk-your-api-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

> `main.js` 会自动向上两级找到根目录的 `.env` 文件加载。

---

## 🚀 动手运行

在 `ch01/nodejs/` 目录下执行：

```bash
# 1. 基础调用（SDK + 非流式，默认）
node main.js -q "讲一个关于程序员的冷笑话"

# 2. 体验流式输出（SDK + 流式）
node main.js --stream -q "用 JavaScript 写一个 Hello World"

# 3. 探索底层原理（原生 fetch + 非流式）
node main.js --raw -q "什么是大语言模型？用一句话解释"

# 4. 手写 SSE 解析（原生 fetch + 流式）
node main.js --raw --stream -q "从 1 数到 5"
```

命令行参数说明：

| 参数 | 说明 | 默认 |
|------|------|------|
| `--raw` | 使用原生 fetch 而非 SDK | 关（使用 SDK） |
| `--stream` | 开启流式响应 | 关（非流式） |
| `-q <text>` | 对话内容 | `"hello"` |

---

## 💻 代码实现详解

### raw.js — 原生 fetch 实现

不依赖任何 AI SDK，直接使用 Node.js 18+ 内置的 `fetch` API 手工完成 HTTP 请求。

#### 非流式调用

```js
const response = await fetch(`${baseURL}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: query }],
    stream: false,
  }),
});

const resp = await response.json();
console.log(resp.choices[0].message.content);
```

#### 流式调用（手写 SSE 解析）

流式响应的 HTTP body 是一个 `ReadableStream`，需要通过 `getReader()` 逐块读取：

```js
const reader = response.body.getReader();
const decoder = new TextDecoder('utf-8');
let buffer = '';   // 跨 chunk 的行切割缓冲区

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  // Uint8Array → 字符串（stream: true 告知 decoder 数据未结束）
  buffer += decoder.decode(value, { stream: true });

  // 按换行符切割，逐行处理
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';   // 最后一行可能不完整，留到下次

  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice('data:'.length).trim();
    if (data === '[DONE]') return;            // 流结束
    const chunk = JSON.parse(data);
    // chunk.choices[0].delta.content 是这次的增量文字
  }
}
```

> **与 Go 版本的关键差异**：Go 使用 `bufio.Scanner` 按行扫描，天然处理了行切割；Node.js 的网络数据包（chunk）不一定按换行符对齐，需要手动维护 `buffer` 拼接后再切割。

### sdk.js — 官方 SDK 实现

使用 `openai` npm 包，SDK 封装了所有底层细节：

```js
import OpenAI from 'openai';

const client = new OpenAI({ baseURL, apiKey });

// 非流式
const resp = await client.chat.completions.create({
  model,
  messages: [{ role: 'user', content: query }],
});
console.log(resp.choices[0].message.content);

// 流式 — SDK 返回 AsyncIterable，用 for await...of 迭代
const stream = await client.chat.completions.create({
  model,
  messages: [{ role: 'user', content: query }],
  stream: true,
  stream_options: { include_usage: true },  // 让最后一个 chunk 携带 token 用量
});

for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content ?? '';
  process.stdout.write(content);  // 逐字打印，实现打字机效果
}
```

`for await...of` 是 ES2018 的异步迭代语法，对应 Go 版本中的 `for stream.Next() { chunk := stream.Current() }`。

---

## 🔍 Go vs Node.js 对照表

| 功能 | Go | Node.js |
|------|----|---------|
| 环境变量加载 | `godotenv.Load()` | `dotenv.config()` |
| HTTP 请求 | `net/http` | `fetch`（Node 18+ 内置） |
| JSON 序列化 | `json.Marshal()` | `JSON.stringify()` |
| JSON 反序列化 | `json.Unmarshal()` | `JSON.parse()` / `response.json()` |
| 流式读取 | `bufio.NewScanner()` | `response.body.getReader()` |
| 官方 SDK 流式 | `for stream.Next()` | `for await (const chunk of stream)` |
| 错误处理 | 返回值 `err`，显式判断 | `try/catch` 或 `Promise.catch()` |
| 模块系统 | `package` | ES Module（`import/export`） |

---

## 📚 相关资料

- [第一章 Go 版本说明](../README.md) — 包含完整的 LLM 原理深度解析（神经网络、Transformer、训练流程等）
- [openai-node SDK GitHub](https://github.com/openai/openai-node) — 官方 Node.js SDK 源码
- [OpenAI API Reference](https://platform.openai.com/docs/api-reference/chat) — 完整请求/响应参数文档
- [MDN — Server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) — SSE 协议规范
