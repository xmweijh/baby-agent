# 第四章：MCP 协议集成 — Node.js 版本

本目录是第四章的 **Node.js 实现**。这一章的核心议题是：

> **如何让 Agent 把已有工具生态统统接进来，而不是自己把每种工具都重新实现一遍？**

答案是 **MCP（Model Context Protocol）**。MCP 是一个标准化的工具挂载协议，只要某个工具服务实现了 MCP 服务端接口，任何支持 MCP 客户端的 Agent 都可以直接接入，无需重新适配。

相较于第三章，本章做了两件事：

1. **引入 MCP 客户端层**：解析 `mcp-server.json` 配置，按协议连接本地或远程的 MCP Server，发现并使用它们暴露的工具
2. **统一工具路由**：让 native 工具（如 bash）和 MCP 工具通过同一套接口被 Agent 发现和调用，Agent 本身不需要感知"这是哪种工具"

---

## 📁 文件结构

```text
ch04/nodejs/
├── package.json        # 依赖管理（含 @modelcontextprotocol/sdk）
├── main.js             # 程序入口：加载 MCP 服务器 + 启动 TUI
├── agent.js            # Agent Loop（支持 native + MCP 双模工具）
├── mcp.js              # MCP 客户端：McpClient / McpTool / loadMcpClients
├── prompt.js           # 系统提示词
├── vo.js               # 事件消息结构（与第三章一致）
├── tui.js              # 命令行 TUI（与第三章一致）
└── tool/
    └── bash.js         # 唯一 native 工具：执行 shell 命令
```

---

## 🛠 准备工作

### 1. 安装依赖

```bash
cd ch04/nodejs
npm install
```

### 2. 配置环境变量

在项目根目录（`baby-agent/`）配置 `.env`：

```env
OPENAI_API_KEY=sk-your-api-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

也可以使用本地模型（如 Ollama + Qwen3）：

```env
OPENAI_API_KEY=ollama
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL=qwen3:8b
```

### 3. 配置 MCP Server（可选）

在项目根目录创建 `mcp-server.json`（参考 `mcp-server.json.example`）：

```json
{
  "filesystem": {
    "command": "npx",
    "args": [
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "${workspaceFolder}"
    ]
  }
}
```

> 若 `mcp-server.json` 不存在，Agent 会跳过 MCP 加载，仍可正常运行，仅有 `bash` 工具可用。

---

## 🚀 运行方式

```bash
cd ch04/nodejs
node main.js
```

可用交互：

- `Enter`：提交当前输入
- `Ctrl+C`：流式输出时取消当前轮；空闲状态退出程序
- `/clear`：清空当前会话（仅保留 system prompt）

---

## 🎯 这一章到底学什么

第三章让你看见了 Agent 的执行过程，但所有工具都需要在代码里手动实现。这会带来一个显而易见的瓶颈：

> 如果你的 Agent 要用到文件读写、GitHub 操作、数据库查询、浏览器控制……难道每一种你都要写一遍适配代码？

本章引入 MCP，从根本上解决这个问题。MCP 是 Anthropic 开源的工具协议标准，它规定了：

- **客户端（Client）**：Agent 侧，负责发现工具、发送调用请求
- **服务端（Server）**：工具侧，负责暴露工具声明、执行工具并返回结果
- **传输层（Transport）**：两者之间的通信方式，支持 stdio 或 HTTP

只要某个工具服务实现了 MCP Server 接口，Agent 就能"即插即用"地接入它。目前已有数十个官方和第三方的 MCP Server 可用（文件系统、搜索、数据库、浏览器等）。

---

## 📖 核心原理详解

### 1. MCP 的通信模型

MCP 使用 **JSON-RPC 2.0** 协议进行通信。整体流程是：

```text
Agent（Client）                  工具服务（Server）
      │                                │
      │── initialize ───────────────→  │
      │← initialized ─────────────── │
      │── tools/list ──────────────→  │
      │← [tool1, tool2, ...] ────── │
      │── tools/call (name, args) → │
      │← { content: [...] } ─────── │
      │                                │
```

所有消息都是结构化的 JSON，序列化后通过传输层收发：

- **stdio 传输**：子进程的 `stdin`/`stdout` 作为管道（本地 MCP Server 的标准方式）
- **HTTP 传输**：通过 HTTP + Server-Sent Events（远程 MCP Server 的标准方式）

### 2. stdio 传输的工作原理

以 `@modelcontextprotocol/server-filesystem` 为例，当你配置：

```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
}
```

Agent 启动时，MCP 客户端会通过 `StdioClientTransport` 启动这个子进程：

```js
transport = new StdioClientTransport({
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/dir'],
  env: process.env,
});
await this.client.connect(transport);
```

之后所有的 `tools/list` 和 `tools/call` 请求，都以 JSON-RPC 格式写入子进程的 `stdin`，响应从子进程的 `stdout` 读出。子进程与父进程的生命周期绑定，父进程退出则子进程自动退出。

这种方式的优点是：
- 不需要额外起一个 HTTP 服务
- 所有 MCP Server 都天然支持 stdio 传输
- 启动速度快，延迟极低

### 3. HTTP 传输配置示例

如果 MCP Server 是远程服务（或本地已经开了 HTTP 服务），可以用 HTTP 传输：

```json
{
  "my-remote-server": {
    "url": "http://localhost:8080/mcp",
    "headers": {
      "Authorization": "Bearer my-token"
    }
  }
}
```

对应代码里用 `StreamableHTTPClientTransport` 连接：

```js
transport = new StreamableHTTPClientTransport(
  new URL(this.serverConfig.url),
  { headers: this.serverConfig.headers ?? {} },
);
```

HTTP 传输适合的场景：
- MCP Server 是一个已运行的独立进程（如 Docker 容器里的服务）
- 需要多个 Agent 进程共用同一个 MCP Server 实例
- MCP Server 部署在远程机器上

stdio 适合的场景：
- 工具服务是可执行程序，每次需要按需启动（如 `npx @modelcontextprotocol/server-filesystem`）
- 单 Agent 独占一个工具进程
- 本地开发调试

### 4. 为什么 MCP 选用 JSON-RPC 2.0 而不是 REST

你可能会想：直接用 REST（GET/POST）不是更简单吗？JSON-RPC 2.0 的选择有几个原因：

**双向调用能力**：JSON-RPC 支持服务端主动向客户端发消息（通知），未来 MCP 可以扩展为 Server 主动推送事件给 Agent（如工具执行进度、异步结果）。REST 是请求-响应模型，服务端不能主动发起。

**批量请求**：JSON-RPC 2.0 支持在一次 HTTP 请求里携带多个 RPC 调用（批处理），可以一次性发送多个 `tools/call`，减少往返延迟。

**统一消息格式**：所有消息（请求、响应、通知、错误）共用一套结构：

```json
// 请求
{ "jsonrpc": "2.0", "method": "tools/call", "params": {...}, "id": 1 }

// 响应
{ "jsonrpc": "2.0", "result": {...}, "id": 1 }

// 错误
{ "jsonrpc": "2.0", "error": { "code": -32600, "message": "..." }, "id": 1 }
```

这套格式同时适用于 stdio（换行分隔的 JSON 流）和 HTTP，传输层和协议层彻底解耦。

### 5. 工具命名空间化（Namespace）

当 Agent 同时挂载多个 MCP Server 时，不同 Server 可能有同名工具（例如多个 Server 都有 `read_file`）。为了避免冲突，所有 MCP 工具在注册进 Agent 时都会加上 server 名称作为前缀：

```
给 LLM 看的名称：babyagent_mcp__{serverName}__{toolName}
给 MCP Server 看的名称：toolName（原始名）
```

例如：

| MCP Server 名 | 工具原始名   | 给 LLM 的名称                          |
|--------------|------------|--------------------------------------|
| filesystem   | read_file  | `babyagent_mcp__filesystem__read_file`  |
| filesystem   | write_file | `babyagent_mcp__filesystem__write_file` |
| github       | create_issue | `babyagent_mcp__github__create_issue` |

当 LLM 决定调用某个工具时，Agent 解析出 serverName 和 toolName，再转发给对应 MCP Server 执行。

```js
// McpTool.name() — 给 LLM 看
name() {
  return `babyagent_mcp__${this.serverName}__${this.toolDef.name}`;
}

// McpTool.execute() — 转发给 MCP Server
async execute(argumentsInJSON) {
  return this.mcpClient.callTool(this.toolDef.name, argumentsInJSON);
}
```

### 6. 工具路由的统一化

本章的一个重要设计决策：**不区分工具来源**。

第三章中，Agent 通过 `Map<name, tool>` 查找 native 工具。本章扩展为：

```js
async #execute(toolName, argumentsInJSON) {
  // 优先查 native tools
  const native = this.nativeTools.get(toolName);
  if (native) return native.execute(argumentsInJSON);

  // 再遍历所有 MCP client 下的 MCP tool
  for (const mcpClient of this.mcpClients) {
    for (const mcpTool of mcpClient.getTools()) {
      if (mcpTool.name() === toolName) {
        return mcpTool.execute(argumentsInJSON);
      }
    }
  }
  throw new Error(`Tool not found: ${toolName}`);
}
```

关键点：无论是 native 工具还是 MCP 工具，对 Agent Loop 来说调用方式是完全一样的：

```js
const result = await this.#execute(toolCall.function.name, toolCall.function.arguments);
```

Agent Loop 主体代码完全不需要感知"工具是哪里来的"。

### 7. `#buildTools()` 的合并逻辑

Agent 每次发请求时，会把所有工具的 `info()` 合并成一个 tools 数组传给 LLM：

```js
#buildTools() {
  // 1. native tools
  const result = [...this.nativeTools.values()].map((t) => t.info());
  // 2. 所有 MCP client 下的所有 tool
  for (const mcpClient of this.mcpClients) {
    for (const mcpTool of mcpClient.getTools()) {
      result.push(mcpTool.info());
    }
  }
  return result;
}
```

工具的 `info()` 格式是 OpenAI Function Calling 的标准格式，LLM 直接根据这些声明决定要不要调用工具、调什么工具。对于 MCP 工具，`info()` 由 `McpTool` 负责生成：

```js
info() {
  return {
    type: 'function',
    function: {
      name: this.name(),           // 命名空间化的名字
      description: this.toolDef.description ?? '',
      parameters: this.toolDef.inputSchema ?? { type: 'object', properties: {} },
    },
  };
}
```

注意：MCP Server 在 `tools/list` 响应里已经提供了 `inputSchema`（JSON Schema 格式），因此不需要 Agent 手写工具参数结构，直接透传即可。这是 MCP 协议减少接入成本的一个核心设计。

### 8. `${workspaceFolder}` 占位符替换

很多 MCP Server（如 `server-filesystem`）需要知道当前工作目录。为了让 `mcp-server.json` 可移植，本章使用 `${workspaceFolder}` 作为占位符：

```json
{
  "args": ["${workspaceFolder}"]
}
```

在加载时由 `replacePlaceholders()` 统一替换为 `process.cwd()`：

```js
function replacePlaceholders(serverConfig, workspaceFolder) {
  const result = { ...serverConfig };
  if (result.args) {
    result.args = result.args.map((arg) =>
      arg.replace('${workspaceFolder}', workspaceFolder),
    );
  }
  return result;
}
```

这样 `mcp-server.json` 可以提交到代码库，不同机器上 clone 下来不需要手动修改路径。

### 9. MCP 工具的返回格式

MCP `tools/call` 的响应结构是：

```json
{
  "content": [
    { "type": "text", "text": "..." },
    { "type": "image", "data": "...", "mimeType": "image/png" }
  ]
}
```

本章只处理 `type: "text"` 的内容，把所有文本片段拼接后作为工具结果返回给 LLM：

```js
return result.content
  .filter((c) => c.type === 'text')
  .map((c) => c.text)
  .join('');
```

图片等非文本内容暂不处理（在多模态 Agent 章节会扩展）。

### 10. MCP 加载失败的容错处理

如果某个 MCP Server 启动失败（比如 `npx` 超时、命令不存在），Agent 不应该整体退出，而是跳过这个 Server 继续加载其他的：

```js
try {
  await client.refreshTools();
  clients.push(client);
} catch (err) {
  console.error(`[MCP] Failed to load server "${name}": ${err.message}`);
  // 跳过，继续加载下一个
}
```

这种容错策略保证了：
- 即使 MCP 配置有误，native 工具仍然可用
- 多个 MCP Server 中某个失败，不影响其他 Server

### 11. Agent 与 MCP Client 的生命周期

本章中 MCP Client 在 `main.js` 里启动，生命周期与整个进程绑定：

```text
进程启动
  → loadMcpClients()：连接所有 MCP Server，拉取工具列表
  → new Agent({ mcpClients })：把 client 列表传给 Agent
  → TUI 启动：用户开始对话
  → 每一轮对话：#buildTools() 合并工具 → LLM 请求 → 工具执行
进程退出
  → MCP 子进程（stdio 模式）自动退出
```

工具列表在启动时加载一次，之后不再刷新。如果需要动态刷新（例如 Server 新增了工具），可以在每次 LLM 请求前调用 `mcpClient.refreshTools()`，但这会增加延迟，本章为简洁起见不引入。

---

## 💻 模块关系速览

```text
main.js
  ├── loadMcpClients()  →  McpClient × N  →  McpTool × M
  │                                              ↕ (info / execute)
  └── new Agent
        ├── nativeTools: Map<name, BashTool>
        ├── mcpClients: McpClient[]
        └── runStreaming()
              ├── #buildTools()  →  [BashTool.info(), McpTool.info(), ...]
              └── #execute(name) →  BashTool.execute() 或 McpTool.execute()
                                         └── McpClient.callTool()
                                               └── JSON-RPC → MCP Server
```

---

## 🔍 几段关键代码怎么理解

### 1. 连接 MCP Server（stdio 模式）

```js
transport = new StdioClientTransport({
  command: this.serverConfig.command,
  args: this.serverConfig.args ?? [],
  env,
});
await this.client.connect(transport);
```

`connect()` 完成后，SDK 内部已经完成了 MCP 握手（`initialize` / `initialized` 消息对）。此后的 `listTools()` 和 `callTool()` 就是直接发 JSON-RPC。

### 2. 拉取工具列表

```js
const result = await this.client.listTools();
this.mcpTools = (result.tools ?? []).map(
  (tool) => new McpTool(this.serverName, tool, this),
);
```

每个 `tool` 对象包含 `name`、`description`、`inputSchema`，一一包装成 `McpTool` 实例后就可以像 native 工具一样使用。

### 3. 执行工具（McpClient → MCP Server）

```js
const result = await this.client.callTool({
  name: toolName,
  arguments: JSON.parse(argumentsInJSON),
});
```

注意：这里的 `toolName` 是原始名（如 `read_file`），不是命名空间化的名（如 `babyagent_mcp__filesystem__read_file`）。命名空间只是 Agent 侧的约定，MCP Server 不知道也不关心。

---

## ⚠️ 安全提示

本章的风险叠加了一层：

- 原有 `bash` 工具的风险仍然存在
- MCP Server 本身（如 `server-filesystem`）拥有对指定目录的完整读写权限
- `mcp-server.json` 里的 Server 配置如果指向不可信的第三方 MCP Server，存在供应链攻击风险

所以本章代码只适合：
- 本地学习
- 教学演示
- 使用官方或自己维护的 MCP Server

真正的生产防护（工具确认、沙盒、权限隔离）会在后续章节引入。

---

## ✅ 相比第三章，你现在多掌握了什么

如果说第三章是：

> "你终于能看清 Agent 是怎么做事的了。"

那么第四章就是：

> "你不再需要自己实现每一种工具了。"

你现在已经掌握：

- MCP 协议的基本通信模型（JSON-RPC 2.0 + stdio/HTTP 传输）
- 如何用 `@modelcontextprotocol/sdk` 连接 MCP Server 并发现工具
- 为什么工具需要命名空间化，以及如何在路由层透明处理
- 如何把 native 工具和 MCP 工具统一为同一套接口
- `${workspaceFolder}` 占位符替换的必要性
- MCP 加载失败时的容错策略

---

## 📚 扩展阅读

1. **MCP 官方文档**  
   `https://modelcontextprotocol.io/docs`

2. **MCP TypeScript SDK**  
   `https://github.com/modelcontextprotocol/typescript-sdk`

3. **官方 MCP Server 列表**  
   `https://github.com/modelcontextprotocol/servers`  
   包含 filesystem、GitHub、PostgreSQL、Slack、puppeteer 等常用服务

4. **JSON-RPC 2.0 规范**  
   `https://www.jsonrpc.org/specification`

5. **OpenAI Function Calling 文档**  
   `https://platform.openai.com/docs/guides/function-calling`  
   MCP 工具声明（inputSchema）和 OpenAI 工具声明（parameters）格式一致，理解二者有助于理解为何可以直接透传
