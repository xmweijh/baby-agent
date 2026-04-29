# 第二章：赋予 AI "手脚" — Node.js 版本

本目录是第二章的 **Node.js 实现**，将 LLM 从"只会聊天"升级为"能动手做事"的小型 Agent：读取/写入本地文件、按内容编辑文件、执行 Shell 命令。

---

## 📁 文件结构

```
ch02/nodejs/
├── package.json        # 依赖管理
├── main.js             # 入口：解析参数、创建 Agent、运行
├── agent.js            # 核心 Agent Loop（Tool Calling 驱动）
└── tool/
    ├── read.js         # 读取文件
    ├── write.js        # 写入文件（覆盖）
    ├── edit.js         # 按内容替换编辑文件
    └── bash.js         # 执行 Shell 命令
```

---

## 🛠 准备工作

### 1. 安装依赖

```bash
cd ch02/nodejs
npm install
```

### 2. 配置环境变量

在**项目根目录**（`baby-agent/`）的 `.env` 文件中配置：

```env
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-your-api-key-here
OPENAI_MODEL=gpt-4o-mini
```

---

## 🚀 动手运行

```bash
# 基本使用
node main.js -q "请读取 README.md 并总结项目目标"

# 让 Agent 写文件
node main.js -q "在 ch02 目录下创建一个 TODO.md，内容为：1. 研究 Agent"

# 让 Agent 执行命令
node main.js -q "列出当前目录下的所有 .go 文件"

# 组合任务（Agent 会自动拆解步骤）
node main.js -q "读取 ch02/prompt.go，然后把其中的英文注释翻译成中文写回去"
```

> 日志打印到 `stderr`，最终回答打印到 `stdout`，可以用 `2>/dev/null` 过滤日志。

---

## 📖 核心原理详解

### 1. Function Calling 协议：LLM 如何"调用"工具

Function Calling 是 OpenAI API 的一个标准扩展协议，允许开发者向模型声明可用工具，并由模型决策何时调用、传什么参数。

#### 工具声明格式（JSON Schema）

每个工具都需要用 JSON Schema 描述自己，这相当于给模型一份"函数签名"：

```js
{
  type: 'function',
  function: {
    name: 'read',
    description: 'Read the content of a local file and return it as a string.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The absolute or relative file path to read.',
        },
      },
      required: ['path'],
    },
  },
}
```

- `name`：工具唯一标识符，模型回复时会用这个名字告诉你要调用哪个工具
- `description`：对模型影响最大的字段，**质量直接决定模型是否会调用这个工具**。要写清楚"做什么、什么时候用"
- `parameters`：JSON Schema 格式的参数定义，模型会按此结构生成 JSON 参数
- `required`：必填参数列表

#### 模型返回的 tool_calls

当模型决定使用工具时，`choices[0].message` 里会出现 `tool_calls` 字段：

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_abc123",
      "type": "function",
      "function": {
        "name": "read",
        "arguments": "{\"path\": \"./README.md\"}"
      }
    }
  ]
}
```

注意几个关键点：
- `content` 此时为 `null`（模型把话说给工具，不直接回复用户）
- `arguments` 是**字符串形式的 JSON**，需要 `JSON.parse()` 解析
- `id` 是本次工具调用的唯一 ID，后续 tool 消息必须用这个 ID 对应上

#### 工具结果返回格式

执行完工具后，需要把结果以 `role: "tool"` 的消息追加到对话历史：

```js
{
  role: 'tool',
  tool_call_id: 'call_abc123',   // 必须与请求中的 id 对应
  content: '# README\n这是文件内容...',
}
```

`tool_call_id` 的对应关系很重要：如果一次返回了多个 `tool_calls`（并行工具调用），模型需要通过这个 ID 知道每个结果对应哪个工具调用。

---

### 2. Agent Loop：工具调用→反馈→再推理的闭环

`agent.js` 中的核心循环（`while(true)`）是整章的灵魂：

```
用户输入
    ↓
[追加 user 消息]
    ↓
┌─────────────────────────────┐
│  调用 LLM（携带工具定义）      │
│          ↓                  │
│  返回有 tool_calls？         │
│   ├─ 是 → 执行工具           │
│   │       ↓                 │
│   │  追加 tool 结果消息        │
│   │       ↓                 │
│   │  （继续循环）              │
│   └─ 否 → 返回最终回答  ←─── ┘
└─────────────────────────────┘
```

这个模式也叫 **ReAct**（Reason + Act）：

| 阶段 | 在代码中的体现 |
|------|--------------|
| **Reason（推理）** | LLM 收到上下文，决定下一步调用哪个工具 |
| **Act（行动）** | 代码执行工具，获取真实结果 |
| **Observe（观察）** | 把工具结果追加为 `tool` 消息，LLM 基于结果继续推理 |

---

### 3. 消息历史的完整结构

一次包含工具调用的完整对话，`messages` 数组会是这样的结构：

```js
[
  // 1. 系统提示（Agent 初始化时注入）
  { role: 'system', content: '# BabyAgent\n...' },

  // 2. 用户请求
  { role: 'user', content: '读取 README.md 并总结' },

  // 3. 模型决定调用工具（content 为 null）
  {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_1', function: { name: 'read', arguments: '{"path":"./README.md"}' } }]
  },

  // 4. 工具执行结果
  { role: 'tool', tool_call_id: 'call_1', content: '# BabyAgent\n项目说明...' },

  // 5. 模型基于工具结果给出最终回答（没有 tool_calls → 循环终止）
  { role: 'assistant', content: '这个项目是一个...总结内容...' },
]
```

每一轮循环，`messages` 数组都在累积，这就是 **Multi-turn Context**（多轮上下文）的工作原理：模型"记住"了所有历史操作和结果。

---

### 4. 并行工具调用（Parallel Tool Calls）

GPT-4o 等高级模型支持在**一次回复**中同时返回多个 `tool_calls`，例如：

```json
{
  "tool_calls": [
    { "id": "call_1", "function": { "name": "read", "arguments": "{\"path\":\"a.txt\"}" } },
    { "id": "call_2", "function": { "name": "read", "arguments": "{\"path\":\"b.txt\"}" } }
  ]
}
```

本章的实现用 `for...of` 顺序执行它们。更优化的做法是并行执行：

```js
// 当前（顺序执行）
for (const toolCall of message.tool_calls) {
  const result = await execute(toolCall);
  messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
}

// 优化（并行执行，适合 I/O 密集型工具）
const results = await Promise.all(
  message.tool_calls.map(async (toolCall) => {
    const result = await execute(toolCall);
    return { role: 'tool', tool_call_id: toolCall.id, content: result };
  })
);
messages.push(...results);
```

---

### 5. 工具设计细节

#### read — 文件读取

```js
// 核心实现
const stat = fs.statSync(resolved);
if (stat.isDirectory()) throw new Error(`Path is a directory: ${resolved}`);
return fs.readFileSync(resolved, 'utf-8');
```

- 路径会用 `path.resolve()` 转为绝对路径，避免相对路径歧义
- 目录检查：防止模型误传目录路径

#### write — 文件写入

```js
// 自动创建父目录（Node.js 独有改进，Go 版本没有此逻辑）
const dir = path.dirname(resolved);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(resolved, content, 'utf-8');
```

- `O_TRUNC` 语义：每次都完整覆盖，不追加
- `mkdirSync({ recursive: true })`：自动创建不存在的父目录，比 Go 版本更友好

#### edit — 精准替换编辑

```js
// 备份 → 替换 → 写入 → 清理备份
fs.writeFileSync(backupPath, original);         // 创建 .bak 备份
const updated = original.split(before).join(after); // 全局替换
fs.writeFileSync(resolved, updated);            // 写入
fs.unlinkSync(backupPath);                      // 删除备份
```

- **为什么不用 `replaceAll`**：`String.prototype.replaceAll` 在正则特殊字符时有坑，`split().join()` 是纯文本全局替换的最安全方式
- **备份策略**：写入失败时从 `.bak` 还原，防止文件损坏

#### bash — Shell 命令执行

```js
// 平台适配
const isWindows = os.platform() === 'win32';
// execSync 同步等待结果，超时 30 秒
execSync(command, { encoding: 'utf-8', timeout: 30_000 });
```

- `sh -c`（Unix）vs `cmd /C`（Windows）的平台适配
- `execSync` 合并 stdout + stderr，模型能看到完整输出
- 30 秒超时防止命令阻塞 Agent Loop

---

### 6. 工具接口的统一设计

所有工具实现相同的三个方法（对应 Go 的 `Tool` interface）：

```js
class SomeTool {
  name()                         // → string，工具唯一名称
  info()                         // → OpenAI tools 数组的单个元素
  async execute(argumentsInJSON) // → Promise<string>，工具执行结果
}
```

这种接口设计的好处：
- **注册解耦**：Agent 不需要知道工具的实现细节，只通过接口调用
- **工具路由**：`this.tools = new Map(tools.map(t => [t.name(), t]))` 用 Map 做 O(1) 查找
- **统一错误处理**：Agent 层统一捕获工具异常，返回错误字符串给 LLM，而不是崩溃

---

### 7. 私有方法 `#execute`

`agent.js` 中使用了 JavaScript 私有类字段语法（ES2022）：

```js
async #execute(toolName, argumentsInJSON) { ... }
```

`#` 前缀表示真正的私有方法——外部代码无法访问 `agent.#execute()`，这与 Go 的小写 `execute` 方法的包级私有略有区别（JS 私有性更强）。

---

### 8. 系统提示词（System Prompt）工程

`main.js` 中内嵌的 `SYSTEM_PROMPT` 直接影响 Agent 的行为：

```
- State intent before tool calls（先说意图，再调工具）
- Before modifying a file, read it first（修改前先读取）
- If a tool call fails, analyze the error before retrying（失败了分析再重试）
```

这些约束是"软性护栏"：它们不是代码逻辑，但显著降低了模型"想当然"的概率。好的 System Prompt 对 Agent 的可靠性至关重要。

---

### 9. 工具错误处理策略

```js
try {
  toolResult = await this.#execute(name, argsJson);
} catch (err) {
  toolResult = `Error: ${err.message}`;  // 错误信息返回给 LLM
}
```

这是一个有意为之的设计：**不直接抛出异常，而是把错误作为工具结果返回给 LLM**。原因是：

- LLM 可以根据错误信息自行调整策略（例如路径写错了，它可以先用 `bash` 列出目录再重试）
- 避免一个工具失败导致整个 Agent Loop 崩溃
- 符合 ReAct 的 Observe 原则：错误本身也是"观察结果"

---

## ⚠️ 安全提示

赋予 LLM 执行 Shell 命令和修改文件的能力，存在极高安全风险：

1. **幻觉（Hallucination）**：模型可能凭空"想象"一个路径并尝试删除它
2. **Prompt Injection**：用户文件内包含"请执行 rm -rf /..."这类恶意指令时，模型可能照做
3. **权限失控**：bash 工具拥有当前用户的全部权限

**生产环境必须引入以下策略（第八章详细实现）**：

- ✅ 命令/路径白名单过滤
- ✅ 执行前人工二次确认弹窗
- ✅ Docker 容器沙盒隔离（隔离文件系统、网络、进程）
- ✅ 工具调用审计日志

---

## 📚 扩展阅读

1. **[OpenAI Function Calling 官方文档](https://platform.openai.com/docs/guides/function-calling)**
   — 完整的工具调用协议说明，含并行工具调用、strict 模式等进阶特性

2. **[ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629)**
   — 本章 Agent Loop 背后的论文，提出了 Reason + Act + Observe 的交替推理范式

3. **[JSON Schema 规范](https://json-schema.org/understanding-json-schema/)**
   — 工具参数声明使用 JSON Schema，深入理解有助于写出更好的工具定义

4. **[OpenAI Node.js SDK](https://github.com/openai/openai-node)**
   — 官方 SDK 源码，查看 `chat.completions.create` 的完整参数类型
