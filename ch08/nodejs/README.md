# 第八章：沙盒与安全防御 — Node.js 版本

本目录是第八章的 **Node.js 实现**。这一章的核心议题是：

> **当 Agent 能够执行任意 bash 命令时，安全性变得至关重要。本章引入 Docker 沙盒隔离和人工确认机制（Human-in-the-loop），在能力与安全之间取得平衡。**

相较于第七章，本章引入了两大安全防护能力：

- **Docker 沙盒隔离（DockerBashTool）**：bash 命令在 Docker 容器中执行，保护宿主机系统
- **工具调用确认（Human-in-the-loop）**：危险操作前弹出交互式确认框
- **三种确认选项**：允许 / 拒绝 / 始终允许
- **ESC 取消支持**：用户可随时取消 Agent Loop，消息自动保留
- **工具工厂模式**：自动检测 Docker，优雅降级到普通 bash

---

## 📁 文件结构

```text
ch08/nodejs/
├── package.json                  # 依赖管理
├── main.js                       # 程序入口：组装沙盒工具 / 确认配置 / Agent
├── agent.js                      # Agent Loop（新增确认流程 + ESC 取消）
├── prompt.js                     # 系统提示词
├── vo.js                         # 事件类型（新增 MessageTypeToolConfirm / ConfirmationAction）
├── tui.js                        # 命令行 TUI（新增交互式确认框，方向键导航）
├── storage.js                    # Storage（继承自第六章）
├── tool/
│   ├── bash.js                   # BashTool（普通 shell，降级备用）
│   ├── docker_bash.js            # DockerBashTool（第八章新增：Docker 沙盒工具）
│   ├── factory.js                # createBashTool()（第八章新增：工具工厂）
│   └── load_storage.js           # LoadStorageTool（继承自第六章）
├── context/                      # ContextEngine + 三大策略（继承自第六章，新增 skipPoliciesAndMemory）
└── memory/                       # MultiLevelMemory + LLMMemoryUpdater（继承自第六章）
```

---

## 🛠 准备工作

### 1. 安装依赖

```bash
cd ch08/nodejs
npm install
```

### 2. 配置环境变量

在项目根目录（`baby-agent/`）的 `.env` 中配置：

```env
# 必填：主模型
OPENAI_API_KEY=sk-your-api-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini

# 可选：记忆更新和摘要策略使用的廉价模型
OPENAI_BACK_MODEL=gpt-4o-mini

# 可选：context window 大小（tokens），默认 128000
CONTEXT_WINDOW=128000
```

### 3. 安装 Docker（可选但推荐）

Docker 沙盒需要本地运行 Docker：

- macOS：[Docker Desktop](https://docs.docker.com/desktop/mac/)
- Linux：`apt install docker.io` 或 `yum install docker`

**不安装 Docker 也可以运行**：工具工厂会自动降级到普通 `BashTool`，只是缺少沙盒隔离保护。

---

## 🚀 运行方式

```bash
cd ch08/nodejs
node main.js
```

### 启动时 Docker 检测日志

**Docker 可用时：**
```
[Tool] Docker available, using DockerBashTool with container 'babyagent-sandbox-baby-agent'
BabyAgent TUI — ch08 (Sandbox & Guardrails)
────────────────────────────────────────────────
欢迎使用，输入问题后回车。当前模型: gpt-4o-mini
快捷键: Ctrl+C / Esc 取消流式；空闲时退出
命令: /clear 清空会话
提示: 执行 bash 命令前会弹出确认框（↑↓ 选择，Enter 确认）
```

**Docker 不可用时：**
```
[Tool] Docker not available, using regular BashTool
BabyAgent TUI — ch08 (Sandbox & Guardrails)
```

### 工具确认示例

```
你: 列出当前目录

[模型决定调用 bash 工具]

┌─── 工具确认 ────────────────────────────────────┐
│ 工具: bash
│ 参数: {"command":"ls -la"}
│
│   ▶ 允许
│     拒绝
│     始终允许
└────────────────────────────────────────────────┘
  ↑↓ 选择  Enter 确认  Esc 拒绝

> 允许

工具调用: bash({"command":"ls -la"})
回答: 当前目录包含以下文件...
```

### ESC 取消示例

```
你: 帮我执行一个耗时操作

[按下 Esc 或 Ctrl+C]

正在取消...
用户取消了 agent loop，消息已保留。
────────────────────────────────────────────────

你: 继续之前的话题

[Agent 从上次消息继续，上下文完整保留]
```

---

## 💡 Node.js 实现要点

### 1. 工具工厂模式（factory.js）

Go 版本在 `tool/factory.go` 使用 `exec.Command("docker", "ps")` 检测 Docker；Node.js 版本用 `execFileSync` 同步检测，在启动时执行一次：

```javascript
function checkDockerAvailable() {
  try {
    execFileSync('docker', ['ps'], { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

export function createBashTool(workspaceDir) {
  if (!checkDockerAvailable()) return new BashTool(); // 降级
  return new DockerBashTool({ workspaceDir });
}
```

**为什么用 `execFileSync` 而非 `execSync`？**

`execFileSync` 不经过 shell 解析，直接执行二进制文件，更安全、更快速，适合执行固定命令。`execSync` 会先启动 shell（`/bin/sh -c`），适合需要 shell 特性（管道、重定向）的命令。

---

### 2. Lazy Initialization（docker_bash.js）

Docker 容器启动需要时间，使用 Lazy Init 模式确保只启动一次，且不阻塞 main.js 的初始化：

```javascript
async execute(argumentsInJSON) {
  await this.#ensureInitialized(); // 首次调用时才启动容器
  // ...
}

async #ensureInitialized() {
  if (this._initialized) return;
  if (!this._initPromise) {
    this._initPromise = this.#startSandboxContainer()
      .then(() => { this._initialized = true; })
      .catch((err) => { this._initError = err; this._initialized = true; });
  }
  await this._initPromise; // 并发调用时等待同一个 Promise
}
```

**为什么用 Promise 缓存而非 `once`？**

`this._initPromise` 缓存了初始化 Promise，保证并发的多个 `execute()` 调用都等待同一个初始化完成，不会重复启动容器。这是 Node.js 中常见的"单次异步初始化"模式。

---

### 3. Human-in-the-Loop 的 Promise 实现

Go 版本通过 channel 实现 Agent ↔ TUI 的双向通信：

```go
// TUI 侧发送确认结果
confirmCh <- ConfirmAllow
// Agent 侧等待
action := <-confirmCh
```

Node.js 没有 channel，使用 **Promise + resolve 回调** 实现相同效果：

```javascript
// tui.js: 挂起一个 Promise，等待用户操作
#askConfirm() {
  return new Promise((resolve) => {
    this.confirmResolve = resolve; // 保存 resolve
    this.awaitingConfirm = true;
  });
}

// tui.js: 用户按 Enter 后 resolve
#resolveConfirm(action) {
  this.confirmResolve?.(action); // 唤醒 Agent
}

// agent.js: await 等待用户选择
const action = await askConfirm();
```

这是 Node.js 将回调式 API 转为 async/await 的标准模式（Promisification）。

---

### 4. Raw Mode 实现方向键导航

标准 `readline` 接口处理不了原始的方向键（`\x1b[A`/`\x1b[B`）。第八章 TUI 通过开启 raw mode 并监听 `stdin data` 事件来捕获这些特殊按键：

```javascript
// 开启 raw mode（逐字节读取，不等换行）
if (process.stdin.isTTY) process.stdin.setRawMode(true);

process.stdin.on('data', (buf) => {
  const key = buf.toString();
  if (this.awaitingConfirm) {
    if (key === '\x1b[A') { /* 上方向键 */ this.confirmSelectedIdx--; }
    if (key === '\x1b[B') { /* 下方向键 */ this.confirmSelectedIdx++; }
    if (key === '\r')     { /* Enter */    this.#resolveConfirm(action); }
    if (key === '\x1b')   { /* ESC */      this.#resolveConfirm(reject); }
  }
});
```

**常见终端按键编码**：

| 按键       | 字节序列   |
|-----------|-----------|
| ↑ 上方向键 | `\x1b[A`  |
| ↓ 下方向键 | `\x1b[B`  |
| Enter     | `\r`      |
| ESC       | `\x1b`    |
| Ctrl+C    | `\x03`    |

---

### 5. ESC 取消与 commitTurn(skipPoliciesAndMemory)

Go 版本通过 `context.WithCancel()` 实现取消，取消后调用：

```go
a.contextEngine.CommitTurn(ctx, draft, usage, true) // true = skipPoliciesAndMemory
```

Node.js 版本通过 `AbortController` 实现，在 `stream` 的 `catch` 块中检测：

```javascript
try {
  for await (const chunk of stream) { /* ... */ }
} catch (err) {
  if (signal?.aborted) {
    // ESC 取消：保存草稿消息，跳过策略和记忆更新
    await this.contextEngine.commitTurn(draft, true);
    return;
  }
  throw err;
}
```

**为什么取消时要保存消息？**

如果什么都不保存，用户只能重新开始对话。保存消息后，用户可以继续追问或修改，对话上下文不会丢失，体验更接近 Claude Code 的行为。

---

### 6. ConfirmReject 的语义差异

Go 版本 `ConfirmReject` 会返回 error 终止整个 loop：

```go
case ConfirmReject:
  toolMsg := openai.ToolMessage("user rejected tool call", toolCall.ID)
  messages = append(messages, toolMsg)
  continue  // 继续循环，LLM 会回应拒绝
```

Node.js 版本同样发送拒绝消息给 LLM，让 LLM 自然给出最终回复，而不是强制中断：

```javascript
if (action === ConfirmationAction.reject) {
  const rejectMsg = { role: 'tool', content: 'User rejected the tool call.' };
  messages.push(rejectMsg);
  continue; // LLM 会给出"已理解，不执行"的回复
}
```

这样 LLM 能优雅地回应"用户拒绝了操作"，而不是返回一个错误。

---

### 7. alwaysAllowTools 与会话生命周期

`alwaysAllowTools` 是一个 `Set`，存储用户本次会话选择"始终允许"的工具名。它与会话绑定，`resetSession()` 时会清空：

```javascript
resetSession() {
  this.contextEngine.reset();
  this.alwaysAllowTools.clear(); // 清空"始终允许"记录
}
```

**为什么不持久化？**

"始终允许"是用户在当前信任上下文下的决定，不同会话的上下文不同。跨会话持久化可能导致用户忘记授权过某些工具，产生安全隐患。

---

### 8. 容器命名规则与工作区隔离

容器名使用工作区目录的 `basename` 作为后缀，确保每个项目有独立沙盒：

```
/home/user/project-a  →  babyagent-sandbox-project-a
/home/user/project-b  →  babyagent-sandbox-project-b
```

若多个项目共享同一工作区名称，则共享同一容器（容器名冲突）。这是有意为之的简化——生产环境可以用完整路径 hash 生成唯一名称。

---

### 9. 重新渲染确认框（ANSI 控制码）

每次用户按方向键移动选项时，需要更新确认框的选中状态。Node.js TUI 使用 ANSI 控制码清除并重绘：

```javascript
#rerenderConfirmBox() {
  const lineCount = CONFIRM_OPTIONS.length + 5;
  process.stdout.write(`\x1b[${lineCount}A`); // 上移 N 行
  for (let i = 0; i < lineCount; i++) {
    process.stdout.write('\x1b[2K\n');         // 清除当前行
  }
  process.stdout.write(`\x1b[${lineCount}A`); // 再次上移
  renderConfirmBox(this.confirmToolName, this.confirmArgs, this.confirmSelectedIdx);
}
```

**ANSI 控制码速查**：
- `\x1b[nA`：上移 n 行
- `\x1b[2K`：清除当前行全部内容
- `\x1b[0m`：重置所有样式（颜色等）

---

### 10. 为什么去掉了 RAG（ch07）？

第八章在 ch07 基础上聚焦安全主题，RAG 组件不是本章教学目标，故暂时移除以保持代码简洁。

在真实项目中，可以将两章特性叠加：

```javascript
const tools = [
  createBashTool(WORKSPACE_DIR), // ch08：沙盒 bash
  new LoadStorageTool(offloadStorage),
  semanticSearchTool,             // ch07：语义搜索（可选）
];
```

---

## 📊 模块关系速览

```
main.js
  ├── createBashTool(workspaceDir)   → DockerBashTool | BashTool
  │     └── docker_bash.js          → execFileSync "docker exec ..."
  │         factory.js              → checkDockerAvailable()
  ├── Agent(confirmConfig)
  │     ├── requireConfirmTools: Set<string>
  │     ├── alwaysAllowTools: Set<string>   (会话级)
  │     └── runStreaming(query, onEvent, signal, askConfirm)
  │           ├── [signal.aborted] → commitTurn(draft, true)  ← ESC 取消
  │           ├── [needConfirm]    → onEvent(toolConfirmMessage)
  │           │                      action = await askConfirm()
  │           └── [normal end]     → commitTurn(draft, false)
  ├── BabyAgentTUI
  │     ├── awaitingConfirm: bool
  │     ├── #askConfirm() → new Promise(resolve => ...)
  │     ├── #handleRawKey(buf) → ↑↓/Enter/ESC → #resolveConfirm
  │     └── #handleEvent(MessageTypeToolConfirm) → renderConfirmBox()
  └── ContextEngine.commitTurn(draft, skipPoliciesAndMemory)
        ├── skipPoliciesAndMemory=false → 正常: applyPolicies + memory.update
        └── skipPoliciesAndMemory=true  → ESC: 仅保存消息，跳过策略和记忆
```

---

## 🆚 与 Go 版本对比

| 特性                | Go 版本                                 | Node.js 版本                              |
|--------------------|-----------------------------------------|------------------------------------------|
| 确认 channel       | `chan ConfirmationAction`（goroutine）   | `Promise` + `resolve` 回调               |
| ESC 取消           | `context.WithCancel()` → `ctx.Done()`  | `AbortController` → `signal.aborted`    |
| 方向键导航          | Bubble Tea 框架内置                     | `stdin.setRawMode(true)` + 手动 ANSI 解析 |
| 容器启动           | `sync.Once`（goroutine 安全）           | `_initPromise` 缓存（Promise 安全）        |
| TUI 确认框重绘      | Bubble Tea 自动 diff 重绘               | 手动 ANSI 转义码清除重绘                   |
| 工具工厂           | `CreateBashTool()` / `checkDockerAvailable()` | `createBashTool()` / `execFileSync`  |

---

## 📚 延伸知识

### Node.js Process 与终端交互

**TTY（Teletypewriter）**：
- `process.stdin.isTTY`：为 true 时表示 stdin 连接到终端（非管道/重定向）
- `process.stdin.setRawMode(true)`：关闭行缓冲，逐字节读取，可捕获 Ctrl、方向键等特殊按键
- 注意：`setRawMode` 后 Ctrl+C 不会自动发送 SIGINT，需要手动监听 `\x03`

**readline 与 raw mode 共存**：
- readline 在 `line` 事件中处理普通文本输入（带行缓冲）
- raw mode 在 `data` 事件中处理特殊按键（逐字节）
- 两者监听同一 stdin，需要区分哪些按键由 readline 处理，哪些由 raw mode 处理

---

### Docker 容器与沙盒安全

**为什么用 alpine 镜像？**
- alpine:3.19 只有约 7MB，启动速度快
- 最小化攻击面（减少预装软件）
- 足够运行大多数 shell 命令

**沙盒局限性**：
- 容器共享宿主机内核，内核漏洞可能逃逸
- 工作区目录以 rw 模式挂载，Agent 仍可修改项目文件
- 更强的隔离需要 gVisor（用户态内核）或 Firecracker（轻量虚拟机）

**生产级加固建议**：
```bash
docker run -d \
  --name babyagent-sandbox \
  --memory=512m --cpus=0.5 \     # 资源限制
  --network=none \                # 禁止网络访问
  --read-only \                   # 只读文件系统
  -v /project:/workspace:rw \
  alpine:3.19 sleep infinity
```

---

### Human-in-the-Loop 设计原则

**何时需要确认？**
- **副作用不可逆**：删除文件、执行 `rm -rf`、发送网络请求
- **影响范围广**：修改系统配置、安装软件包
- **非预期操作**：LLM 误解意图时，确认框是最后防线

**三档确认策略（参考 Claude Code）**：
1. `allow`：允许本次，下次同工具仍需确认
2. `alwaysAllow`：本会话内该工具免确认（临时信任）
3. `reject`：拒绝，LLM 得到反馈后可以调整策略

**更细粒度的确认（扩展方向）**：
- 按命令前缀：`rm*` 开头需要确认
- 按正则匹配：`/etc/` 路径相关操作需要确认
- 按风险评分：LLM 自评风险分数，高于阈值才确认

---

## 📖 与前序章节对比

| 功能                  | ch06 | ch07 | ch08 |
|----------------------|------|------|------|
| 工具调用              | ✅   | ✅   | ✅   |
| Context 策略          | ✅   | ✅   | ✅   |
| Memory 记忆           | ✅   | ✅   | ✅   |
| Agentic RAG           | ❌   | ✅   | ❌*  |
| Docker 沙盒           | ❌   | ❌   | ✅   |
| Human-in-the-Loop     | ❌   | ❌   | ✅   |
| ESC 取消保留上下文    | ❌   | ❌   | ✅   |

> *ch08 去掉了 RAG 以聚焦安全主题。两章可以结合使用（在 ch08 基础上加入 ch07 的 SemanticSearchTool）。

---

## 🔗 精选扩展阅读

- [Docker Security Docs](https://docs.docker.com/engine/security/) — Docker 官方安全指南
- [OWASP LLM Top 10](https://owasp.org/www-project-top-10-for-large-language-model-applications/) — LLM 应用十大安全风险
- [E2B — Code Interpreter SDK](https://e2b.dev/) — 专为 AI Agent 设计的沙盒环境
- [gVisor](https://gvisor.dev/) — Google 开源的用户态内核，更强容器隔离
- [Node.js readline 文档](https://nodejs.org/api/readline.html) — Node.js 官方 readline API
- [ANSI Escape Codes](https://en.wikipedia.org/wiki/ANSI_escape_code) — 终端控制码完整参考
