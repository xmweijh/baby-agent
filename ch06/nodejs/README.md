# 第六章：记忆系统 — Node.js 版本

本目录是第六章的 **Node.js 实现**。这一章的核心议题是：

> **Agent 能做事、能管理上下文，但每次会话重启它就彻底"失忆"了——你需要一套跨会话的记忆机制。**

相较于第五章，本章引入了完整的 **Memory System（记忆系统）**：

- **两层记忆架构**：Global Memory（跨项目用户偏好）+ Workspace Memory（当前项目知识）
- **LLM 驱动的记忆更新**：每轮对话结束后用 back_model 自动提取并更新记忆
- **文件系统持久化**：记忆写入磁盘，跨会话保留
- **记忆事件通知**：记忆更新时向 TUI 推送 `memory` 事件，用户可见更新状态
- **System Prompt 注入**：记忆在每次请求前通过 `{memory}` 占位符注入到 System Prompt

---

## 📁 文件结构

```text
ch06/nodejs/
├── package.json              # 依赖管理
├── main.js                   # 程序入口：组装 Storage / Memory / 策略 / ContextEngine / Agent
├── agent.js                  # Agent Loop（新增 setMemoryEventHook）
├── storage.js                # Storage：MemoryStorage / FileSystemStorage / 路径工具函数
├── prompt.js                 # 系统提示词（新增 {memory} 占位符）
├── vo.js                     # 事件类型（新增 MessageTypeMemory / memoryMessage）
├── tui.js                    # 命令行 TUI（新增记忆事件展示，紫色）
├── memory/
│   ├── memory.js             # MemoryContent + MultiLevelMemory
│   └── update.js             # LLMMemoryUpdater：LLM 提取记忆 + XML 解析
└── context/
    ├── share.js              # countTokens()
    ├── engine.js             # ContextEngine（新增 memory / setMemoryEventHook / {memory} 注入）
    ├── policy_truncate.js    # TruncatePolicy（继承自第五章）
    ├── policy_offload.js     # OffloadPolicy（继承自第五章）
    └── policy_summary.js     # SummaryPolicy + LLMSummarizer（继承自第五章）
```

---

## 🛠 准备工作

### 1. 安装依赖

```bash
cd ch06/nodejs
npm install
```

### 2. 配置环境变量

在项目根目录（`baby-agent/`）配置 `.env`：

```env
OPENAI_API_KEY=sk-your-api-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini

# 可选：记忆更新和摘要策略使用的廉价模型（不配置则与主模型相同）
OPENAI_BACK_MODEL=gpt-4o-mini

# 可选：context window 大小（tokens），默认 128000
CONTEXT_WINDOW=128000
```

---

## 🚀 运行方式

```bash
cd ch06/nodejs
node main.js
```

可用交互：

- `Enter`：提交当前输入
- `Ctrl+C`：流式输出时取消当前轮；空闲状态退出程序
- `/clear`：清空当前会话（仅保留 system prompt；记忆不受影响）

**验证跨会话记忆**：

```bash
# 第一次会话，说出一些个人偏好
node main.js
>>> 你好，我习惯使用 vim 编辑器，正在用 Node.js 开发一个 REST API
```

退出后查看记忆文件：

```bash
cat ~/.babyagent/memory/MEMORY.md           # 全局记忆（vim 偏好等）
cat .babyagent/memory/MEMORY.md             # 工作区记忆（项目相关）
```

再次启动，不需要重新介绍：

```bash
node main.js
>>> 我平时用什么编辑器？
```

Agent 应该能从记忆中直接回答。

---

## 🎯 这一章到底学什么

前五章的 Agent 每次启动都是"全新的"。它不知道：

- 你习惯用什么编辑器
- 你正在做哪个项目
- 上次对话里讨论了什么

这个问题无法通过"把所有历史都塞进 context"来解决——对话太长 context 就满了，而且跨会话的历史也没有办法在新进程里还原。

本章的解法是：在每轮对话结束后，**用 LLM 主动从对话中提取有价值的信息，持久化为结构化记忆**，在下次启动时自动注入到 System Prompt。这样 Agent 就有了"长期记忆"。

---

## 📖 核心原理详解

### 1. 为什么 LLM 没有"自带记忆"

从架构上讲，LLM 是一个**无状态函数**：

```
output = LLM(input)
```

每次请求都是独立的，模型的"记忆"完全依赖于输入的 context（消息历史）。一旦进程结束，context 就消失了。

这与人类记忆的工作方式根本不同——人类通过神经突触的权重变化存储长期记忆，而 LLM 的参数在推理时是固定的（不会因为对话而更新）。

**本章的解法本质上**：在 LLM 之外维护一个外部记忆存储，每轮对话后把重要信息"写入"这个存储，下次对话时从存储"读入"并注入到 context。这是一种典型的"增强记忆"（Augmented Memory）模式。

---

### 2. 两层记忆的设计依据

本章把记忆分为两层，理由是信息的**生命周期和作用域**不同：

| 维度 | Global Memory | Workspace Memory |
|------|--------------|-----------------|
| 作用域 | 所有项目、所有会话 | 当前项目 |
| 存储位置 | `~/.babyagent/memory/MEMORY.md` | `{cwd}/.babyagent/memory/MEMORY.md` |
| 典型内容 | 编辑器偏好、编码风格、语言偏好 | 项目结构、构建命令、技术栈 |
| 更新频率 | 低（只在发现新的跨项目模式时更新） | 中（项目内发现新知识时更新） |

**为什么不用一层？**

如果只有一层全局记忆，项目 A 的技术栈信息就会混入项目 B 的对话，造成混淆。分层保证了：
- 用户在项目 B 里不会看到项目 A 的 Go 相关知识
- 但用户的 vim 偏好在所有项目里都有效

**为什么存 Markdown 而不是 JSON/数据库？**

Markdown 有两个关键优点：
1. **LLM 友好**：可以直接注入 System Prompt，LLM 擅长理解 Markdown 格式
2. **人类可读**：用户可以直接打开文件查看和编辑记忆内容，低成本的人工干预

---

### 3. LLM 驱动的记忆更新：为什么要用 LLM

记忆更新需要完成的任务是：**从非结构化的对话中提取结构化知识**。

例如，用户说了这样一段话：

```
用户: 好的，我一般用 VSCode，你帮我在这个项目里配置一下 ESLint
助手: 好的，我来安装 @eslint/js 并生成配置文件...
工具: 安装完成，创建了 eslint.config.js
```

从这段对话里，需要提取出：
- Global Memory: 用户习惯 VSCode（而不是之前记录的 vim）→ 要更新/覆盖旧记忆
- Workspace Memory: 项目使用 ESLint，配置文件是 `eslint.config.js`

这种"理解 → 判断归属 → 合并/覆盖旧内容"的任务，正是 LLM 最擅长的。用规则引擎很难做好，但 LLM 只需要一个设计良好的 Prompt 就能完成。

**为什么用 back_model（廉价模型）而不是主模型？**

记忆更新不需要最强的推理能力，只需要能理解对话内容并生成结构化文本。用 `gpt-4o-mini` 等廉价模型就足够，还能大幅降低成本（记忆更新在每轮对话后都会运行）。

---

### 4. XML 标签格式的选择

LLM 更新记忆时，需要返回两块内容（global 和 workspace）。本章使用 XML 标签包裹：

```xml
<global>
## User Preferences
- **Editor**: vim
</global>

<workspace>
## Project Structure
- src/ — 源代码目录
</workspace>
```

**为什么不用 JSON？**

LLM 生成 JSON 时，如果内容里有特殊字符（如引号、反斜杠），很容易产生格式错误（JSON 解析失败）。Markdown 内容里恰好就有大量这类字符（代码块、路径等）。

XML 标签方案更健壮：即使内部内容包含各种特殊字符，正则提取 `<global>...</global>` 也不会失败（多行匹配）：

```js
const pattern = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
```

这是 Anthropic 官方在 Claude System Prompt 设计中推荐的结构化输出方式之一。

---

### 5. 记忆注入：System Prompt 中的 `{memory}` 占位符

记忆最终需要变成 LLM 能理解的文本，注入到每次请求的 System Prompt 里：

```js
// context/engine.js — buildSystemPrompt()
const memoryContent = this.memory ? this.memory.toString() : '';
return this.systemPromptTemplate
  .replace('{memory}', memoryContent);
```

注入后的效果（每次请求 LLM 时都会看到）：

```
## Memory
### Global Memory
Here is the memory about the user among all conversations:
## User Preferences
- **Editor**: vim
- **Testing**: Always use verbose flag

### Workspace Memory
The memory of the current workspace is:
## Project Structure
- src/index.js — 入口文件
- package.json — 依赖声明
```

**注意**：记忆是在 `buildSystemPrompt()` 时动态读取的，这意味着每次请求都能看到最新的记忆。如果上一轮刚刚更新了记忆，下一轮的 System Prompt 里就会包含更新后的内容。

---

### 6. 记忆更新的时机：为什么在策略执行之后

`ContextEngine.commitTurn()` 的执行顺序是：

```
1. 把本轮新消息写入历史（messages）
2. 运行所有上下文策略（offload / summarize / truncate）
3. 调用 memory.update(draft.newMessages)
```

策略执行放在记忆更新之前，有以下原因：

- **记忆更新使用原始消息**：`draft.newMessages` 是本轮原始消息，不受策略影响。策略可能会压缩/截断历史消息，但不会改变 `draft.newMessages`，因此记忆提取总是基于原始对话内容
- **避免顺序依赖**：如果先更新记忆再执行策略，策略执行时可能会意外把刚写入的记忆相关消息卸载掉

---

### 7. 记忆加载：为什么要异步加载

`main.js` 里有一行：

```js
await memory.load();
```

这行代码在 Agent 启动时从磁盘读取记忆文件。为什么不在 `MultiLevelMemory` 构造函数里同步加载？

原因是 Node.js 的模块顶层代码是同步执行的，而文件读取推荐用异步 API（避免阻塞事件循环）。`await` 需要在 `async` 函数或 ESM 模块的顶层 `await` 中使用。本章 `package.json` 设置了 `"type": "module"`，因此 `main.js` 支持顶层 `await`：

```js
// main.js — 顶层 await（ESM only）
await memory.load();
```

这是 ES2022 的语言特性，只能用于 ESM 模块（`.mjs` 或 `"type": "module"` 的 `.js`）。CommonJS（`require`）不支持。

---

### 8. 记忆事件：为什么需要 TUI 通知

记忆更新是一次额外的 LLM 调用（back_model），通常需要 1-3 秒。如果没有任何反馈，用户看到回答显示完毕后界面"卡住"，不知道发生了什么。

本章通过 `setMemoryEventHook` 把记忆更新状态推送到 TUI：

```
回答: 好的，我已经...（主模型回答完毕）

记忆更新: (运行中...) (已完成)
────────────────────────────────────────────────
```

这与第五章的策略事件（`MessageTypePolicy`）是同样的设计思路：**让 Agent 的内部执行状态对用户可见**。这是 Agent 可观察性的重要组成部分。

---

### 9. ContextEngine 扩展模式

对比第五章 vs 第六章的 `ContextEngine`：

**第五章**：

```js
constructor(policies = [], contextWindow = 200_000)
// commitTurn: 写入历史 → 执行策略
```

**第六章**：

```js
constructor(policies = [], memory = null, contextWindow = 200_000)
// commitTurn: 写入历史 → 执行策略 → 更新记忆
```

这是一种典型的**可选依赖注入**（Optional Dependency Injection）：`memory` 默认为 `null`，如果不传入则跳过记忆更新。这保证了不需要记忆功能的场景也能正常工作，不破坏向后兼容性。

---

## 💻 模块关系速览

```text
main.js
  ├── FileSystemStorage(globalDir)     ─┐
  ├── FileSystemStorage(workspaceDir)  ─┤ → MultiLevelMemory
  ├── LLMMemoryUpdater(back_model)     ─┘
  ├── MemoryStorage (offload 用)
  ├── OffloadPolicy(offloadStorage)    ─┐
  ├── SummaryPolicy(summarizer)        ├── policies[]
  ├── TruncatePolicy                   ┘
  ├── ContextEngine(policies, memory)
  └── Agent(contextEngine, tools)
        └── runStreaming(query)
              ├── setPolicyEventHook → onEvent(policyMessage)
              ├── setMemoryEventHook → onEvent(memoryMessage)  ← 新增
              ├── startTurn()
              ├── while(tool loop) ...
              └── commitTurn(draft)
                    ├── applyPolicies()
                    │     ├── OffloadPolicy.apply()  → storage.store()
                    │     ├── SummaryPolicy.apply()  → LLM 摘要调用
                    │     └── TruncatePolicy.apply() → 截断旧消息
                    └── memory.update(draft.newMessages)      ← 新增
                          ├── LLMMemoryUpdater.update()       → LLM 提取记忆
                          ├── globalStorage.store()           → ~/.babyagent/
                          └── workspaceStorage.store()        → .babyagent/
```

---

## ✅ 相比第五章，你现在多掌握了什么

如果说第五章是：

> "你的 Agent 可以维持长期对话了，而不会在 context 满了之后崩溃。"

那么第六章就是：

> "你的 Agent 有记忆了，重启后它还记得你。"

你现在已经掌握：

- 为什么 LLM 没有"自带记忆"（无状态函数 + 固定参数）
- 两层记忆架构的设计依据（信息的生命周期和作用域）
- 为什么用 LLM 提取记忆而不是规则引擎
- XML 标签比 JSON 更适合结构化 LLM 输出的场景
- `{memory}` 占位符如何在 System Prompt 里动态注入记忆
- 记忆更新时机的设计（策略执行后、原始消息传入）
- 顶层 `await` 的使用场景（ESM 异步初始化）
- 记忆事件通知如何提升 Agent 可观察性
- 可选依赖注入模式：`memory = null` 的向后兼容设计

---

## 📚 扩展阅读

1. **记忆文件位置**
   - 全局记忆：`~/.babyagent/memory/MEMORY.md`
   - 工作区记忆：`{cwd}/.babyagent/memory/MEMORY.md`
   - 可以直接编辑这些文件，手动调整 Agent 的记忆内容

2. **LangChain Memory 模块**
   `https://python.langchain.com/docs/modules/memory/`
   — 工业级框架如何处理记忆，对比可以理解本章实现的简化之处

3. **Retrieval Augmented Generation（RAG）**
   随着记忆内容增多，全量注入会消耗大量 token。下一步优化是：把记忆向量化，按相关性检索 Top-K 记忆片段注入。第七章会实现向量检索（pgvector）。

4. **Claude Memory 设计**
   `https://www.anthropic.com/research/memory`
   — Anthropic 对 AI 记忆机制的研究，包含短期/长期记忆的理论框架

5. **XML 标签结构化输出**
   `https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags`
   — Anthropic 推荐使用 XML 标签指导 LLM 输出结构化内容的官方文档
