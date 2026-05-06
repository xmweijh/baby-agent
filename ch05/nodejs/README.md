# 第五章：上下文工程 — Node.js 版本

本目录是第五章的 **Node.js 实现**。这一章的核心议题是：

> **对话历史会无限增长，而 LLM 的 context window 是有上限的——你需要一套机制来管理它。**

相较于第四章，本章引入了完整的 **Context Engineering（上下文工程）** 层：

- **ContextEngine**：带 token 计数的消息存储，以及草稿/提交的写入模型
- **三种上下文策略**：Truncate（截断）、Offload（卸载）、Summary（摘要）
- **load_storage 工具**：让 LLM 在需要时按 key 取回被卸载的完整内容
- **策略事件**：策略执行时向 TUI 推送 `policy` 事件，用户可以看到策略什么时候在运行

---

## 📁 文件结构

```text
ch05/nodejs/
├── package.json              # 依赖管理（新增 gpt-tokenizer）
├── main.js                   # 程序入口：组装 Storage / 策略 / ContextEngine / Agent
├── agent.js                  # Agent Loop（集成 ContextEngine 三段式写入）
├── storage.js                # Storage 接口：MemoryStorage / FileSystemStorage
├── prompt.js                 # 系统提示词（含 {runtime} / {workspace_path} 占位符）
├── vo.js                     # 事件类型（新增 policy 类型）
├── tui.js                    # 命令行 TUI（新增策略事件展示）
├── context/
│   ├── share.js              # countTokens()：基于 gpt-tokenizer 的 token 计数
│   ├── engine.js             # ContextEngine：消息管理 + 策略调度
│   ├── policy_truncate.js    # TruncatePolicy：截断旧消息
│   ├── policy_offload.js     # OffloadPolicy：卸载长工具消息到 Storage
│   └── policy_summary.js     # SummaryPolicy + LLMSummarizer：LLM 压缩摘要
└── tool/
    ├── bash.js               # Shell 命令执行工具
    └── load_storage.js       # 从 Storage 取回被卸载内容
```

---

## 🛠 准备工作

### 1. 安装依赖

```bash
cd ch05/nodejs
npm install
```

### 2. 配置环境变量

在项目根目录（`baby-agent/`）配置 `.env`：

```env
OPENAI_API_KEY=sk-your-api-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini

# 可选：摘要策略使用的廉价模型（不配置则与主模型相同）
OPENAI_BACK_MODEL=gpt-4o-mini

# 可选：context window 大小（tokens），默认 128000
CONTEXT_WINDOW=128000
```

---

## 🚀 运行方式

```bash
cd ch05/nodejs
node main.js
```

可用交互：

- `Enter`：提交当前输入
- `Ctrl+C`：流式输出时取消当前轮；空闲状态退出程序
- `/clear`：清空当前会话（仅保留 system prompt）

---

## 🎯 这一章到底学什么

前四章的 Agent 有一个根本性问题：`messages` 数组会随着对话不断增长。当 token 总数接近 context window 上限时：

- 最简单的处理：直接报错 `context_length_exceeded`
- 粗暴的处理：每次只传最后几条消息（丢失历史）
- 本章的处理：**策略化、可感知的上下文管理**

本章抽象出一个 `ContextEngine`，让 Agent 在每轮结束后自动检查和处理上下文压力，同时保证：
- 历史信息尽可能完整地保留或压缩
- LLM 随时可以通过工具取回被卸载的内容
- 策略执行过程对用户可见

---

## 📖 核心原理详解

### 1. Token 是什么，为什么 LLM 用 Token 而不是字符

在理解本章之前，需要先搞清楚 **Token** 的概念，因为整章都在围绕"token 数量"做决策。

**Token 不是字符，也不是单词**，而是介于两者之间的文本片段。LLM 在处理文本时，会先把原始字符串拆分成 Token 序列，再对 Token 做运算：

```
"hello world"  →  ["hello", " world"]           (2 tokens)
"unhappiness"  →  ["un", "happiness"]            (2 tokens)
"你好世界"      →  ["你", "好", "世", "界"]        (4 tokens，中文通常 1 字 = 1 token)
```

拆分规则由 **Tokenizer（分词器）** 决定。本章使用的 `gpt-tokenizer` 实现了 OpenAI 的 `cl100k_base` 编码方案，与 GPT-4、Claude 等主流模型兼容。

**为什么用 Token 而不是字符数？**

LLM 的 Transformer 架构在 Token 级别做 self-attention 计算，每个 Token 都要与其他所有 Token 做注意力运算，计算量是 **O(n²)**（n 是 Token 数）。因此 LLM 对输入长度的限制是按 Token 计量的，不是字符数。

常见模型的 context window 大小（输入 + 输出 token 总量）：

| 模型 | Context Window |
|------|---------------|
| GPT-4o | 128,000 tokens |
| GPT-4o-mini | 128,000 tokens |
| Claude 3.5 Sonnet | 200,000 tokens |
| Qwen2.5-72B | 128,000 tokens |

128,000 tokens 大约相当于 10 万汉字或 100,000 个英文单词——大约是一本中篇小说的体量。超过这个上限，API 就会报错 `context_length_exceeded`。

**Token 与成本的关系**

LLM API 按 token 计费（输入 + 输出分开计价）。一段很长的对话历史不仅会触发 context window 限制，还会显著增加每次请求的费用。这也是本章策略的另一个动机：**减少 token 消耗 = 降低运营成本**。

---

### 2. Token 计数：为什么需要它

策略触发的前提是"知道当前 context 用了多少"。本章为每条消息标注 token 数：

```js
// context/share.js
import { encode } from 'gpt-tokenizer';

export function countTokens(message) {
  if (typeof message.content === 'string' && message.content) {
    return encode(message.content).length;
  }
  // tool_calls 等非文本内容：按 JSON 字节数粗估
  return Math.ceil(JSON.stringify(message).length / 4);
}
```

消息存储为 `{ message, tokens }` 二元组（即 `messageWrap`），这样随时可以累加得到总 token 数，不需要每次重新扫描全部内容。

**上下文使用率**定义为：

```js
getContextUsage() {
  return this.contextTokens / this.contextWindow;  // 0.0 ~ 1.0+
}
```

所有策略都以这个比值作为触发条件。

### 3. ContextEngine：三段式写入模型

`ContextEngine` 使用类似"数据库事务"的三段式接口：

```js
// 轮次开始：创建草稿（不影响历史）
const draft = engine.startTurn({ role: 'user', content: query });

// 中间：把每条新消息（assistant、tool）追加到 draft.newMessages
draft.newMessages.push(assistantMsg);
draft.newMessages.push(toolMsg);

// 轮次成功结束：提交到历史，触发策略
await engine.commitTurn(draft);

// 轮次出错：丢弃草稿，历史不受影响
engine.abortTurn(draft);
```

**为什么要这样设计？**

如果每条消息生成后立刻写入 `engine.messages`，一旦中途出错（网络断开、工具失败），历史就会包含"半截的对话"，导致下一轮 LLM 看到残缺上下文。草稿模型保证了：只有一轮完整对话结束后，才正式写入历史。

### 4. 三种策略详解

#### 3.1 TruncatePolicy（截断）

最简单的策略：删掉最旧的消息，只保留最近 N 条。

截断有一个重要细节：**对齐到 user 消息边界**。

```js
// 从候选截断区末尾往前，找到最后一条 user 消息作为截断起点
let removeIdx = toRemove - 1;
for (let i = toRemove - 1; i >= 0; i--) {
  if (msgs[i].message.role === 'user') {
    removeIdx = i;
    break;
  }
}
```

如果不对齐，可能会出现这种情况：消息链变成 `[tool, assistant, user, ...]`，最前面的 `tool` 没有对应的 `assistant`，LLM 会困惑。对齐到 user 消息保证了被保留的部分从一个完整对话轮次开头开始。

**缺点**：历史信息直接丢失，LLM 无法追溯。

#### 3.2 OffloadPolicy（卸载）

截断丢失信息，而卸载策略更温和：把 `tool` 消息的长内容**卸载到 Storage**，消息里只保留摘要片段和恢复提示。

```text
原始 tool message（500 字）：
  "$ cat large_file.txt\n[...500 字内容...]"

卸载后（约 50 字）：
  "$ cat large_file.txt\n[...前 200 字...]...\n（更多内容已卸载，如需查看全文请使用 load_storage(key="/offload/...") 工具）"
```

LLM 看到提示后，在需要时可以主动调用 `load_storage(key="...")` 取回完整内容。

**为什么只卸载 tool 消息？**

- `user` 消息是问题，不应丢失
- `assistant` 消息是推理和答案，比较紧凑
- `tool` 消息是命令执行结果，最容易出现大量输出（如 `cat` 了一个大文件）

#### 3.3 SummaryPolicy（摘要）

最"智能"的策略：用另一个 LLM 把旧对话压缩成一段摘要，用这段摘要替换原来的多条消息。

```text
原始消息（10 条，共 3000 tokens）：
  user: 帮我读 config.json
  assistant: 好的，我来读一下
  tool: {"api_key": "...", "model": "gpt-4o"}
  assistant: 文件包含 api_key 和 model 两个字段...
  ...

摘要后（1 条，约 100 tokens）：
  user: [之前对话摘要] 用户要求读取 config.json，文件包含 api_key 和 model 字段...
```

摘要策略采用**分批 + 滚动**的方式，避免一次性把所有历史塞给摘要模型：

```js
while (batchStart < summarizeUntil) {
  // 每批不超过 inputTokenLimit 和 summaryBatchSize
  const batchMsgs = [];
  for (...) { /* 收集一批 */ }

  // 把 runningSummary 作为 previous_summary 传给 LLM
  runningSummary = await summarizer.summarize(runningSummary, batchMsgs);
  batchStart += batchMsgs.length;
}
```

`runningSummary` 是滚动摘要，每批处理结果会作为下一批的"历史摘要"传入，保证超长历史也能被完整压缩。

**缺点**：需要额外 LLM 调用（时间 + 费用）。建议用 `OPENAI_BACK_MODEL` 指向更便宜的模型。

### 5. 策略触发阈值的设计

本章 `main.js` 里设置的策略顺序和阈值：

```js
const policies = [
  new OffloadPolicy(storage, 0.8, 4, 200),    // 80% 触发：先卸载长工具输出
  new SummaryPolicy(summarizer, 4, 20, 0.85), // 85% 触发：LLM 摘要压缩
  new TruncatePolicy(4, 0.9),                  // 90% 触发：最后兜底截断
];
```

策略按顺序执行，每个策略执行后重新计算使用率，再判断下一个策略是否触发。三者梯度化：
- Offload 最温和，信息可恢复
- Summary 适中，信息被压缩但保留语义
- Truncate 最粗暴，只在前两者无法控制时兜底

### 6. 策略接口约定（鸭子类型）

本章策略使用鸭子类型，不需要继承基类，只要实现以下三个方法即可：

```js
class MyCustomPolicy {
  // 策略名称，用于 TUI 展示（如 "[策略] truncate 执行中..."）
  name() { return 'my-policy'; }

  // 判断是否需要触发；接收 engine 实例，通常检查 getContextUsage()
  shouldApply(engine) {
    return engine.getContextUsage() > 0.8;
  }

  // 执行策略（纯函数）：接受 engine 快照，返回新的消息列表
  // 可以是 async（例如需要调用 LLM 或写入文件时）
  async apply(engine) {
    // 处理 engine.messages（类型为 { message, tokens }[]）
    return { messages: /* 新的消息数组 */ };
  }
}
```

把自定义策略加入 `main.js` 的 `policies` 数组即可生效，不需要修改 `ContextEngine` 本身。

### 7. 策略是纯函数

每个策略的 `apply()` 方法都是**纯函数**：接受 `engine` 的当前状态，返回新的 `{ messages }` 对象，不直接修改 `engine` 内部变量。

```js
apply(engine) {
  // ✅ 返回新数组，不修改 engine.messages
  return { messages: msgs.slice(removeIdx) };

  // ❌ 错误做法：engine.messages = engine.messages.slice(...)
}
```

这样设计的好处：
- 策略执行失败时，engine 状态不会损坏
- 策略逻辑更容易单元测试（输入 engine 快照 → 验证输出）

策略执行后，`ContextEngine` 会立刻重新累加所有消息的 token 数，更新 `contextTokens`，再判断下一个策略是否触发：

```js
// engine.js 内部
const result = await policy.apply(this);
this.messages = result.messages;
this.#recountTokens();   // 重新算 contextTokens，影响下一个策略的 shouldApply
```

这意味着：如果 Offload 策略已经把使用率从 83% 降到了 75%，后面 SummaryPolicy（阈值 85%）就不会再触发。

### 8. load_storage 工具与 OffloadPolicy 的配合

`OffloadPolicy` 和 `LoadStorageTool` 形成一个闭环：

```text
OffloadPolicy 执行时：
  tool message 长内容 → Storage.store(key, content)
  tool message 被替换为：preview + "使用 load_storage(key=...) 取回全文"

用户后续问到相关内容时：
  LLM 看到提示 → 调用 load_storage(key="...")
  LoadStorageTool.execute() → Storage.load(key) → 返回完整内容
```

关键点：LLM **自主决定**什么时候需要取回全文，不需要用户干预。这是一种典型的"延迟加载"（lazy loading）思路——先把数据存起来，需要时再取。

### 9. AbortTurn：为什么对话出错不会"污染"历史

如果一轮对话中途出错（比如工具执行失败、网络超时），agent.js 会捕获异常并调用 `engine.abortTurn(draft)`：

```js
try {
  // ... 流式对话 + 工具调用 ...
  await this.contextEngine.commitTurn(draft);
} catch (err) {
  this.contextEngine.abortTurn(draft);   // 丢弃草稿
  throw err;
}
```

`abortTurn` 是 no-op（什么都不做），因为草稿从未写入 `engine.messages`。这保证了历史永远是"完整对话轮次"的集合，不会出现孤立的 assistant 或 tool 消息。

---

## 💻 模块关系速览

```text
main.js
  ├── MemoryStorage
  ├── OffloadPolicy(storage)  ─┐
  ├── SummaryPolicy(summarizer)├── policies[]
  ├── TruncatePolicy           ┘
  ├── ContextEngine(policies)
  └── Agent(contextEngine, tools)
        └── runStreaming(query)
              ├── engine.startTurn()
              ├── while(tool loop)
              │     ├── stream → accContent / accToolCalls
              │     ├── execute(toolName)
              │     │     ├── BashTool
              │     │     └── LoadStorageTool(storage)
              │     └── draft.newMessages.push(...)
              └── engine.commitTurn(draft)
                    └── applyPolicies()
                          ├── OffloadPolicy.apply()  → storage.store()
                          ├── SummaryPolicy.apply()  → LLM 摘要调用
                          └── TruncatePolicy.apply() → 截断旧消息
```

---

## ✅ 相比第四章，你现在多掌握了什么

如果说第四章是：

> "你不再需要自己实现每一种工具了。"

那么第五章就是：

> "你的 Agent 可以维持长期对话了，而不会在 context 满了之后崩溃。"

你现在已经掌握：

- 为什么需要 token 计数，以及 `gpt-tokenizer` 的基本用法
- `ContextEngine` 的三段式写入（StartTurn / CommitTurn / AbortTurn）及其设计原因
- 三种上下文策略的原理、适用场景和权衡
- 截断策略为什么要对齐到 user 消息边界
- 卸载策略如何与 `load_storage` 工具形成"延迟加载"闭环
- 摘要策略的分批 + 滚动 `runningSummary` 设计
- 策略作为纯函数的意义（可测试、状态安全）
- `abortTurn` 如何防止错误污染对话历史

---

## 📚 扩展阅读

1. **gpt-tokenizer**  
   `https://github.com/nicepkg/gpt-tokenizer`  
   纯 JS 实现的 tiktoken 兼容库，支持 cl100k_base（GPT-4）等编码

2. **Context Window 限制**  
   `https://platform.openai.com/docs/models`  
   各模型的 context window 大小

3. **RAG（Retrieval Augmented Generation）**  
   本章的 Offload 策略是一种轻量级 RAG 思路：内容存储 + 按需检索。  
   完整的 RAG（向量检索）会在第七章实现。

4. **Sliding Window Attention**  
   理解为什么长距离历史对 LLM 来说比近期历史更难"记住"，  
   这是 Summary / Truncate 策略的理论动机。
