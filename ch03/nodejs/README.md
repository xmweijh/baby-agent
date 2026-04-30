# 第三章：让 Agent 更能看见 — Node.js 版本

本目录是第三章的 **Node.js 实现**。这一章的重点不再只是“让 Agent 能调用工具”，而是让你**实时看见 Agent 正在想什么、做什么、返回了什么**。

相较于第二章，本章引入两个关键能力：

- **流式输出（streaming）**：模型一边生成一边显示，而不是等整轮结束后一次性返回
- **推理内容展示（reasoning display）**：把 `reasoning_content` / `reasoning` / `thinking` 与最终回答分开显示

为了保持 Node.js 版本简单直接，这里使用 **Node.js 原生 `readline` + ANSI 控制台输出** 做了一个轻量 TUI。它已经足够承载本章真正想表达的核心能力：**可观察性**。

---

## 📁 文件结构

```text
ch03/nodejs/
├── package.json        # 依赖管理
├── main.js             # 程序入口，加载 .env，创建 Agent 和 TUI
├── agent.js            # 流式 Agent Loop + reasoning 字段兼容解析
├── prompt.js           # 系统提示词
├── vo.js               # 事件消息结构（reasoning/content/tool_call/error）
├── tui.js              # 轻量命令行 TUI
└── tool/
    └── bash.js         # 唯一内置工具：执行 shell 命令
```

---

## 🛠 准备工作

### 1. 安装依赖

```bash
cd ch03/nodejs
npm install
```

### 2. 配置环境变量

在项目根目录（`baby-agent/`）配置 `.env`：

```env
OPENAI_API_KEY=sk-your-api-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

如果你本地使用 Ollama + Qwen3，也可以改成：

```env
OPENAI_API_KEY=ollama
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL=qwen3:8b
```

---

## 🚀 运行方式

```bash
cd ch03/nodejs
node main.js
```

启动后会进入交互式界面。你可以直接输入问题，例如：

- `请列出当前目录下的文件`
- `请执行 pwd 并解释输出含义`
- `读取 package.json 并告诉我项目依赖`

可用交互：

- `Enter`：提交当前输入
- `Ctrl+C`：模型流式输出中时取消当前轮；空闲状态下退出程序
- `/clear`：清空当前会话（仅保留 system prompt）

---

## 🎯 这一章到底学什么

第三章本质上是在第二章的 Agent Loop 上，加了一个 **“观察窗口”**。

第二章里，Agent 其实已经会：
- 接收用户输入
- 决定要不要调用工具
- 执行工具
- 把工具结果喂回模型
- 最后返回最终答案

但第二章的问题是：

- 模型在想什么你看不见
- 工具是什么时候触发的你不容易观察
- 流式增量输出和最终答案混在一起不够清晰

第三章解决的是 **调试体验** 和 **执行可见性** 问题。

---

## 📖 核心原理详解

### 1. 从“完整响应”切到“流式响应”

第二章使用的是普通的非流式调用：

```js
const response = await client.chat.completions.create({
  model,
  messages,
  tools,
});
```

这种方式的特点是：

- 服务端把整轮结果全部生成完
- 客户端一次性拿到完整 `response`
- 用户需要等待更久，且中间看不到过程

第三章改成流式：

```js
const stream = await client.chat.completions.create({
  model,
  messages,
  tools,
  stream: true,
});

for await (const chunk of stream) {
  // 每次拿到一个增量片段
}
```

这里的 `stream` 是一个 **AsyncIterable（异步可迭代对象）**。你可以把它理解成：

- 服务端每生成一点内容，就发一个 chunk 过来
- 客户端使用 `for await...of` 持续消费
- 因此可以边生成边显示

这里的本质是一样的：客户端持续消费服务端推送来的增量片段，只是在 Node.js 里用异步迭代器来表达。

---

### 2. 为什么流式响应里要自己拼增量

在流式模式下，每个 chunk 只是一小段增量，而不是完整答案。例如：

```json
{"choices":[{"delta":{"content":"法"}}]}
{"choices":[{"delta":{"content":"国"}}]}
{"choices":[{"delta":{"content":"的"}}]}
```

所以你不能指望某个 chunk 就是完整回答，而是要：

- 一边接收
- 一边展示
- 最终再由 SDK 聚合成完整消息对象

本章在 `agent.js` 里同时做了两件事：

1. 在 `for await...of stream` 中实时把 `delta.content` / `delta.reasoning_*` 发给 TUI
2. 在流结束后调用 `stream.finalChatCompletion()` 取到聚合后的完整 `assistant message`

这样既保留了**实时展示**，又能继续完成后续的 **tool loop**。

---

### 3. reasoning 字段为什么要兼容多个名字

不同模型/服务商对“推理过程”的字段命名不统一。常见情况有：

- `reasoning_content`
- `reasoning`
- `thinking`

因此本章写了统一解析逻辑：

```js
function parseDeltaWithReasoning(delta = {}) {
  return {
    content: delta.content ?? '',
    reasoningContent: delta.reasoning_content ?? '',
    reasoning: delta.reasoning ?? '',
    thinking: delta.thinking ?? '',
  };
}

function reasoningText(delta) {
  return delta.reasoningContent || delta.reasoning || delta.thinking || '';
}
```

这样做的目的不是“炫技兼容”，而是让你的 Agent 在以下场景都能工作：

- OpenAI 兼容推理接口
- Ollama 的 OpenAI 兼容接口
- 某些自建代理层的自定义字段

**本质思路**是：把“模型厂商差异”收敛在一个很小的兼容层里，别让上层 UI 和 Agent Loop 到处写 if/else。

---

### 4. 事件驱动的可视化层

本章没有让 `agent.js` 直接 `console.log()`，而是让它把流式过程抽象成事件：

```js
export const MessageTypeReasoning = 'reasoning';
export const MessageTypeContent = 'content';
export const MessageTypeToolCall = 'tool_call';
export const MessageTypeError = 'error';
```

Agent 在运行时，通过 `onEvent(event)` 把消息抛给 UI：

- `reasoning`：推理过程增量
- `content`：最终回答增量
- `tool_call`：模型决定调用工具
- `error`：执行错误或接口错误

这是一种典型的 **事件驱动架构**：

- Agent 负责业务逻辑
- TUI 负责显示逻辑
- 两者通过统一事件协议解耦

以后如果你要把 TUI 换成：

- WebSocket 前端
- Electron 桌面端
- 浏览器页面
- 日志系统

只要继续消费这些事件即可，不用改 Agent 本身。

---

### 5. Agent Loop 在第三章里有什么变化

第三章并没有推翻第二章的 Tool Loop，而是在第二章基础上加入流式层。

整体流程变成：

```text
用户输入
  ↓
追加 user message
  ↓
发起流式请求（stream: true）
  ↓
for await...of 消费 chunk
  ├─ 若有 reasoning 增量 → 发 reasoning 事件给 TUI
  ├─ 若有 content 增量   → 发 content 事件给 TUI
  ↓
取完整 assistant message
  ↓
有 tool_calls ?
  ├─ 有  → 发 tool_call 事件 → 执行工具 → 追加 tool message → 继续下一轮
  └─ 无  → 本轮结束，保存 messages
```

也就是说：

- **流式只是“展示层增强”**
- **Tool Loop 仍然是整个 Agent 的主骨架**

---

### 6. 为什么流式模式下还要自己拼出"最终完整消息"

这是很多初学者会忽略的点。

你可能会想：既然已经在 `for await...of` 里看到了所有 chunk，流结束不就等于拿到全部内容了吗？

答案是：**chunk 只是增量片段，不是结构化的 assistant message**。tool calling 需要的完整结构包括：

- `message.content`：最终回答文本
- `message.tool_calls[].id`：每个工具调用的唯一 ID
- `message.tool_calls[].function.name`：工具名称
- `message.tool_calls[].function.arguments`：完整的 JSON 参数字符串

这些字段**跨多个 chunk 分散拆散传输**，任何一个 chunk 都不完整。因此本章在 `for await...of` 迭代中手动累积：

```js
// 累积文本
accContent += delta.content;

// 累积 tool_calls（按 index 分组拼接）
for (const tc of deltaRaw.tool_calls ?? []) {
  const idx = tc.index ?? 0;
  if (!accToolCalls[idx]) {
    accToolCalls[idx] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
  }
  accToolCalls[idx].function.arguments += tc.function?.arguments ?? '';
}
```

流结束后，再组装成完整消息：

```js
const message = { role: 'assistant', content: accContent || null };
if (accToolCalls.length > 0) message.tool_calls = accToolCalls;
```

这样才能判断：

- 这一轮是不是该结束了
- 模型是不是想调用工具
- 工具调用的参数究竟是什么

> **注意**：openai SDK 提供了一个 `stream.finalChatCompletion()` 辅助方法，但它只在使用 `client.beta.chat.completions.stream()` 链式 API 时可用。使用原生 `for await...of` 消费流时，该方法**不存在**，必须手动累积 delta。

---

### 7. AbortController：为什么 Ctrl+C 能取消当前轮

在 Node.js 版本中，取消流式输出靠的是 `AbortController`：

```js
this.abortController = new AbortController();

await this.agent.runStreaming(
  query,
  (event) => this.handleEvent(event),
  this.abortController.signal,
);
```

当用户在响应过程中按下 `Ctrl+C`：

```js
this.abortController.abort();
```

请求会收到 abort signal，从而中止当前的 streaming request。

这类“可取消上下文”的设计，在后续做：

- 终止工具执行
- 超时控制
- 用户中断
- 页面关闭时的请求清理

都很重要。

---

### 8. 为什么 TUI 要把推理和回答分开显示

如果你把 reasoning 和 content 都直接打印到同一个区域，会出现两个问题：

1. **阅读混乱**：你无法区分模型在“想”还是已经在“答”
2. **调试困难**：模型明明推理没问题，但最终回答错了，你也很难定位问题出在哪

所以本章的 TUI 策略是：

- reasoning 用灰色 `推理:` 前缀显示
- final answer 用亮色 `回答:` 前缀显示
- 工具调用单独一行 `工具调用:`
- 错误单独一行 `错误:`

这就是一个最小版的“可观察性面板”。

---

### 9. 为什么这里不用复杂 TUI 框架

Node.js 里如果想做更复杂的终端 UI，也可以选：

- `blessed`
- `ink`
- `neo-blessed`
- `terminal-kit`

但本章的重点不是学习 TUI 框架，而是：

- 流式响应如何接入 UI
- 推理字段如何兼容展示
- tool call 如何在界面中被观察到

所以这里故意采用更轻的方案：

- `readline` 负责读取输入
- ANSI 颜色负责基础视觉区分
- 一个简单类 `BabyAgentTUI` 负责管理运行状态

这样更容易看懂，也更适合作为教程版本。

---

### 10. 本章只保留 bash 工具的原因

第三章的重点是 **流式 + reasoning + TUI**，不是工具生态扩展。所以本章只保留一个 `bash` 工具，避免把注意力分散到 read/write/edit 上。

这也说明一个很重要的设计思想：

> 教程代码不一定追求“最全功能”，而是追求“最小但能说明问题”。

一个 bash 工具已经足够展示：

- 模型决定调用工具
- TUI 显示工具调用
- 工具执行成功/失败
- 工具结果回流给模型
- 模型继续生成最终回答

---

## 💻 代码结构速览

- `agent.js`：增强版 Agent Loop，支持 streaming 和 reasoning 字段兼容
- `tui.js`：轻量命令行 TUI，负责输入、取消、清空、事件展示
- `vo.js`：统一事件类型定义
- `tool/bash.js`：执行 shell 命令
- `main.js`：装配入口

---

## 🔍 几段关键代码怎么理解

### 1. 流式请求

```js
const stream = await this.client.chat.completions.create({
  model: this.model,
  messages,
  tools: this.#buildTools(),
  stream: true,
}, {
  signal,
});
```

这里的第二个参数对象传入了 `signal`，意味着这个请求可取消。

### 2. 实时消费增量

```js
for await (const chunk of stream) {
  const choice = chunk.choices?.[0];
  const delta = parseDeltaWithReasoning(choice?.delta ?? {});

  const reason = reasoningText(delta);
  if (reason) onEvent(reasoningMessage(reason));
  if (delta.content) onEvent(contentMessage(delta.content));
}
```

这段逻辑展示了：

- 如何边接收边解析
- 如何把模型的不同输出类型变成统一 UI 事件

### 3. 手动累积 delta，组装完整消息继续 tool loop

```js
// 迭代中累积
accContent += delta.content;
if (deltaRaw.tool_calls) {
  for (const tc of deltaRaw.tool_calls) {
    const idx = tc.index ?? 0;
    if (!accToolCalls[idx]) {
      accToolCalls[idx] = { id: tc.id ?? '', type: 'function',
        function: { name: tc.function?.name ?? '', arguments: '' } };
    }
    if (tc.function?.arguments) accToolCalls[idx].function.arguments += tc.function.arguments;
  }
}

// 流结束后组装并推入 messages
const message = { role: 'assistant', content: accContent || null };
if (accToolCalls.length > 0) message.tool_calls = accToolCalls.filter(Boolean);
messages.push(message);

if (!message.tool_calls || message.tool_calls.length === 0) {
  this.messages = messages;
  return;
}
```

这一段是从"流式展示"重新回到"Agent 主循环"的关键桥梁。`finalChatCompletion()` 是 SDK 链式 API 才有的方法，原生 `for await...of` 下需要自行累积。

---

## ⚠️ 安全提示

本章虽然重点不是安全，但风险依然存在，尤其是 `bash` 工具：

- 模型可能误执行危险命令
- 用户输入可能夹带 prompt injection
- 当前 shell 权限就是模型的实际权限

所以本章代码只适合：

- 本地学习
- 教学演示
- 小规模实验

不适合直接上线生产环境。真正的生产防护会在后续章节引入：

- 命令白名单
- 工具确认
- Docker 沙盒
- 权限隔离
- 详细审计日志

---

## ✅ 相比第二章，你现在多掌握了什么

如果说第二章是：

> “Agent 能做事了。”

那么第三章就是：

> “你终于能看清 Agent 是怎么做事的了。”

你现在已经掌握：

- 如何用 `stream: true` 接收流式响应
- 如何兼容不同厂商的 reasoning 字段
- 如何把流式输出拆成 reasoning / content / tool / error 四类事件
- 如何让一个可交互界面实时消费这些事件
- 如何在 Node.js 中用 `AbortController` 终止当前请求
- 为什么要手动累积 `delta.content` / `delta.tool_calls`，以及为什么不能依赖 `stream.finalChatCompletion()`

---

## 📚 扩展阅读

1. **OpenAI Node SDK**  
   `https://github.com/openai/openai-node`

2. **Node.js readline 官方文档**  
   `https://nodejs.org/api/readline.html`

3. **AbortController 官方文档（MDN）**  
   `https://developer.mozilla.org/en-US/docs/Web/API/AbortController`

4. **Server-Sent Events / Streaming 基本概念**  
   如果你对底层流式原理还不熟，可以回看第一章关于 streaming 的内容
