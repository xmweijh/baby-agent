# 第七章：Agentic RAG — Node.js 版本

本目录是第七章的 **Node.js 实现**。这一章的核心议题是：

> **Agent 能做事、能管理上下文、有记忆，但面对百万行代码库或海量文档时，靠 LLM 自己"背下来"是不可能的——你需要一套让 Agent 按需检索知识的机制。**

相较于第六章，本章引入了完整的 **Agentic RAG** 能力：

- **文本切分（Chunking）**：把长文档切成可检索的小块
- **向量嵌入（Embedding）**：用 Embedding 模型把文本转成高维向量
- **向量存储与检索**：内存 KNN 搜索（学习版）/ pgvector（生产版）
- **重排序（Reranking）**：两阶段检索，用 Reranker 提升精排质量
- **语义搜索工具**：封装为 Agent 工具，让 LLM 自主决定何时检索
- **增量索引**：基于文件修改时间的去重策略，避免重复 Embedding
- **代码库索引**：一个完整的并发索引系统

---

## 📁 文件结构

```text
ch07/nodejs/
├── package.json                  # 依赖管理
├── main.js                       # 程序入口：组装 RAG 组件 / Memory / 策略 / Agent
├── agent.js                      # Agent Loop（与 ch06 基本一致）
├── prompt.js                     # 系统提示词（新增 semantic_search 工具说明）
├── vo.js                         # 事件类型（新增 MessageTypeIndex / indexMessage）
├── tui.js                        # 命令行 TUI（新增索引事件展示，蓝色）
├── storage.js                    # Storage（继承自第六章）
├── rag/
│   ├── chunker.js                # LineChunker + ParagraphChunker
│   ├── embedding.js              # HTTPEmbeddingService（fetch 调用 OpenAI 兼容 API）
│   └── rerank.js                 # HTTPRerankService（fetch 调用 Rerank API）
├── db/
│   └── vectorstore.js            # InMemoryVectorStore（余弦相似度，无需数据库）
├── index/
│   ├── file_walker.js            # FileWalker（递归遍历，自动排除 node_modules 等）
│   └── indexer.js                # Indexer（增量更新 + 并发 indexConcurrent）
├── tool/
│   ├── bash.js                   # BashTool（继承自第六章）
│   ├── load_storage.js           # LoadStorageTool（继承自第六章）
│   └── semantic_search.js        # SemanticSearchTool（新增）
├── context/                      # ContextEngine + 三大策略（继承自第六章）
└── memory/                       # MultiLevelMemory + LLMMemoryUpdater（继承自第六章）
```

---

## 🛠 准备工作

### 1. 安装依赖

```bash
cd ch07/nodejs
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

# ── RAG 相关（不配置则跳过 RAG 功能）──────────────────────

# Embedding 服务（必须配置才能启用语义搜索）
EMBED_BASE_URL=https://api.openai.com/v1
EMBED_API_KEY=sk-your-api-key-here       # 不填则复用 OPENAI_API_KEY
EMBED_MODEL=text-embedding-3-small
EMBED_DIMENSIONS=512                      # 向量维度，默认 512

# Rerank 服务（可选，不配置则跳过重排序，仍可使用向量检索）
RERANK_BASE_URL=https://api.openai.com/v1
RERANK_API_KEY=sk-your-api-key-here
RERANK_MODEL=rerank

# 要索引的代码库路径（默认为当前工作目录）
INDEX_PATH=/path/to/your/project
```

---

## 🚀 运行方式

```bash
cd ch07/nodejs
node main.js
```

启动时，如果配置了 `EMBED_BASE_URL`，会在后台自动索引 `INDEX_PATH` 指定的代码库：

```
[RAG] 正在索引代码库: /path/to/your/project
[RAG] 索引完成：127 个文件，耗时 8432ms
  新建: 127
  重建: 0
  跳过: 0
  失败: 0
  总块数: 891
BabyAgent TUI — ch07 (Agentic RAG)
────────────────────────────────────────────────
欢迎使用，输入问题后回车。当前模型: gpt-4o-mini
>>>
```

**交互命令**：

- `Enter`：提交当前输入
- `Ctrl+C`：流式输出时取消当前轮；空闲状态退出程序
- `/clear`：清空当前会话（记忆不受影响）

**验证语义搜索**：

```text
>>> 这个项目的 Agent 循环是怎么实现的？
工具调用: semantic_search({"query": "Agent loop implementation streaming"})
回答: 根据检索结果，Agent 循环在 agent.js 中实现，核心是 while(true) 循环...
```

---

## 🎯 这一章到底学什么

前六章的 Agent 只能调用 `bash` 工具来搜索代码（`grep`、`find`）。这在小型项目里够用，但当代码库规模增大时：

- `grep` 不理解语义——你问"怎么处理认证"，但函数叫 `checkPermission`
- `grep` 速度慢——扫描几十万个文件需要几十秒
- LLM 的 context 放不下整个代码库——你只能给它"相关"的片段

本章的解法是：**在 Agent 之外维护一个向量索引**，把代码切成小块 → 转成向量 → 存起来，然后在每次请求时通过"语义距离"快速定位相关片段，精准注入 context。这是工业界所有 Coding Agent（Cursor、Copilot 等）都在用的核心技术。

---

## 📖 核心原理详解

### 1. 为什么需要文档切分（Chunking）

文档切分并不是可选的优化，而是 RAG 系统能工作的**前提条件**。

**① Embedding 模型有输入长度限制**

`text-embedding-3-small` 等模型的输入通常在 512～8192 token 之间。一个真实项目里的文件可以轻松超过这个限制，截断后后半部分信息完全丢失。

**② 整文件 Embedding 会"稀释"语义**

把 1000 行代码压成一个向量，这个向量要同时表达所有函数的语义，结果是任何查询跟它都"有点像"却又"不够像"——相似度分布趋于平坦，检索区分度大幅下降：

```text
整文件 Embedding：
  查询"如何处理错误" → 余弦相似度 0.72（噪声太多）

切分后 Embedding：
  查询"如何处理错误" → error_handler 块相似度 0.91 ✅
                    → add_user 块相似度 0.31     ❌（被过滤）
```

**③ 召回结果必须能放进 context 窗口**

RAG 的目的是把相关内容送给 LLM。如果召回的是整个 10000 行文件，它本身就会撑爆 context。切分后 Top-K 召回的是若干小块，总 token 量可控。

**切分粒度的权衡**：

```text
块太小 → 上下文不足，LLM 看不到完整逻辑
块太大 → 语义稀释，噪声多，context 压力大
```

没有最优块大小，必须根据文档类型和任务通过实验确定。

---

### 2. Embedding 是什么，为什么有效

Embedding（向量嵌入）把文本映射到一个高维向量空间，使得**语义相近的文本在空间中距离更近**。

```text
"如何处理错误"    → [0.12, -0.45, 0.87, ...]   ← 512 维向量
"error handling" → [0.11, -0.43, 0.85, ...]   ← 与上面方向接近
"用户登录流程"    → [-0.33, 0.92, -0.12, ...]  ← 方向差异很大
```

这个"语义距离"用**余弦相似度**来衡量：

```text
余弦相似度 = (A · B) / (|A| × |B|)
```

只关心向量方向，不受向量长度影响。相似度接近 1 → 语义相近；接近 0 → 无关；接近 -1 → 语义相反。

**为什么能做到这一点？**

Embedding 模型是在海量语料上训练的，学会了把语义相似的词句映射到相近方向。这个映射是在训练时"编码"进模型权重里的，推理时只是执行一次前向计算，速度极快（几毫秒）。

**代码实现**（`db/vectorstore.js`）：

```js
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

---

### 3. 两阶段检索：召回（Recall）+ 精排（Rerank）

向量检索快但不够精准，Rerank 精准但慢。两阶段结合取长补短：

```text
查询 → Embedding → 向量搜索(Top-50，粗排) → Rerank(Top-10，精排) → 注入 context
```

**为什么不直接用 Rerank？**

Rerank 模型是"Cross-Encoder"：把查询和每个候选文档拼在一起让模型打分，需要对每个候选分别做一次前向计算。Top-50 意味着 50 次模型调用，速度太慢。

**为什么不只用向量检索？**

向量 Embedding 是"Bi-Encoder"：查询和文档分别编码，用余弦相似度近似语义距离。因为是"近似"，所以精度不如 Cross-Encoder。

| 特性 | Embedding（Bi-Encoder） | Reranker（Cross-Encoder） |
|------|------------------------|--------------------------|
| 架构 | 查询/文档分别编码 | 查询+文档拼接后联合编码 |
| 速度 | 快（O(1) 相似度查找） | 慢（每个候选一次前向计算）|
| 精度 | 中等（近似匹配） | 高（精确语义理解） |
| 用途 | 从百万文档中召回候选 | 对几十个候选精细排序 |

**Node.js 实现**（`tool/semantic_search.js`）：

```js
async execute(argumentsInJSON) {
  // 阶段一：向量召回 Top-K×2（粗排，快）
  const queryVector = await this.embedService.embed(query);
  const vectorResults = await this.vectorStore.search(queryVector, topK * 2);

  // 阶段二：Rerank 精排（可选，慢但精准）
  if (this.rerankService) {
    finalChunks = await this.rerankService.rerank(query, candidates);
  }

  return this.#formatResults(query, finalChunks.slice(0, topK));
}
```

---

### 4. 内存向量存储 vs pgvector

Go 版本使用 PostgreSQL + pgvector，因为 Go 更适合生产服务。Node.js 版本使用纯内存实现：

```js
// db/vectorstore.js
export class InMemoryVectorStore {
  async search(queryVector, limit) {
    const scored = this.points.map((p) => ({
      ...p,
      score: cosineSimilarity(queryVector, p.vector),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}
```

暴力搜索的复杂度是 O(n × d)（n 个向量，d 维），百万条以内完全够用。

**权衡对比**：

| 特性 | InMemoryVectorStore | pgvector |
|------|---------------------|---------|
| 安装成本 | 零 | 需要 PostgreSQL |
| 数据持久化 | 进程退出后丢失 | 持久化到磁盘 |
| 搜索性能 | O(n)，暴力搜索 | IVFFlat/HNSW 索引加速 |
| 百万级数据 | 开始变慢（~100ms） | 仍然快（<10ms） |
| 适用场景 | 本地开发 / 学习 | 生产环境 |

> 进程重启后，内存数据清空，启动时会重新索引所有文件（因为 `getDocumentIndexedTime` 返回 `null`）。这在小型项目上可以接受（通常几秒内完成），大型项目需要换 pgvector。

---

### 5. 增量更新：文件修改时间去重

每次启动都对整个代码库重新做 Embedding 既慢又浪费 API 调用次数。`Indexer` 通过对比**文件修改时间**和**上次索引时间**来跳过未修改的文件：

```js
// index/indexer.js
const indexedTime = await this.vectorStore.getDocumentIndexedTime(relPath);

if (indexedTime !== null) {
  if (modTime <= indexedTime) {
    return { chunks: 0, action: IndexAction.SKIP };  // ✅ 跳过
  }
  await this.vectorStore.deleteByDocument(relPath);   // 先删旧记录
}
// 重新索引...
```

三种操作状态：

| 状态 | 说明 |
|------|------|
| `IndexAction.NEW` | 新文件，首次索引 |
| `IndexAction.SKIP` | 文件未修改，跳过 |
| `IndexAction.REINDEX` | 文件有更新，先删后建 |

> **注意**：内存 VectorStore 重启后没有历史记录，所以每次启动都会把所有文件当成 `NEW` 重新索引。这是内存存储的局限性；pgvector 的 `GetDocumentIndexedTime` 从数据库读取，可以跨进程持久化增量状态。

---

### 6. 并发索引：`Promise.allSettled` 分批

Go 版本用 goroutine + WaitGroup 做真正的多线程并发。JavaScript 是单线程，但**网络 I/O 天然并发**——等待 Embedding API 响应时，事件循环可以同时处理其他请求：

```js
// index/indexer.js
async indexConcurrent(concurrency = 10) {
  const files = await this.fileWalker.walk(this.rootPath);

  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);

    // 一批内的所有文件同时发起 HTTP 请求（不等待上一个完成）
    const settled = await Promise.allSettled(
      batch.map((f) => this.#indexFile(f))
    );

    // allSettled 保证所有 Promise 都 resolve/reject 后才继续
    // 即使某个文件失败，也不影响其他文件的结果
    for (const result of settled) { /* 统计成功/失败 */ }
  }
}
```

**为什么用 `allSettled` 而不是 `Promise.all`？**

- `Promise.all`：任何一个 Promise reject 就立刻抛异常，其他正在进行的请求结果丢失
- `Promise.allSettled`：等所有 Promise 结束（无论成功还是失败），逐个检查结果

索引代码库时，单个文件失败（如二进制文件被误匹配）不应该中断整个索引，所以用 `allSettled`。

**并发度的选择**：

- 太低（1-2）：几乎串行，慢
- 太高（100+）：同时发起太多请求，可能触发 API 限流（Rate Limit）
- 默认 10：在速度和限流风险之间的合理平衡

---

### 7. fetch API 替代 axios/resty

Go 版本使用 `resty` 作为 HTTP 客户端。Node.js 版本直接使用 Node.js 18+ 内置的 `fetch` API，无需额外安装依赖：

```js
// rag/embedding.js
const response = await fetch(`${this.baseURL}/embeddings`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${this.apiKey}`,
  },
  body: JSON.stringify({ model: this.model, input: text, dimensions: this.dimensions }),
});

if (!response.ok) {
  const text = await response.text();
  throw new Error(`Embedding API error ${response.status}: ${text}`);
}
```

**为什么不用 `openai` SDK 的 Embedding 接口？**

`openai` SDK 的 `embeddings.create` 接口只支持 OpenAI 官方格式。本章的 Embedding 和 Rerank 服务可能来自不同提供商（如 Jina、Cohere、本地模型），所以直接用 `fetch` 更灵活，只需保证 API 格式兼容即可。

---

### 8. RAG 工具的可选降级设计

`main.js` 检查 `EMBED_BASE_URL` 是否配置，决定是否启用 RAG：

```js
if (EMBED_BASE_URL) {
  const embedService  = new HTTPEmbeddingService({ apiKey, baseURL: EMBED_BASE_URL, model, dimensions });
  const rerankService = RERANK_BASE_URL ? new HTTPRerankService({ ... }) : null;
  const vectorStore   = new InMemoryVectorStore();

  semanticSearchTool = new SemanticSearchTool(embedService, vectorStore, rerankService);
  tools.push(semanticSearchTool);

  // 后台启动索引（不阻塞 TUI）
  indexer.indexConcurrent(10).then(result => console.log(result.toString()));
} else {
  console.log('[RAG] 未配置 EMBED_BASE_URL，跳过 RAG 功能');
}
```

三层可选性：
- **不配置 `EMBED_BASE_URL`**：跳过整个 RAG，Agent 仍可正常使用 `bash` 等工具
- **配置 Embedding，不配置 Rerank**：使用单阶段向量检索（粗排），无重排序
- **同时配置 Embedding + Rerank**：完整两阶段检索，精排质量最高

---

### 9. Agentic RAG vs 传统 RAG

**传统 RAG**：固定的检索流程，每次用户问问题都先检索再生成：

```text
用户输入 → 强制检索（无论是否需要）→ 固定 Top-K → LLM 生成
```

**Agentic RAG**：LLM 自主决定是否检索、检索什么、检索多少次：

```text
用户输入 → LLM 判断（需要检索吗？）
             ├── 不需要 → 直接回答
             └── 需要  → 自主生成查询 → 动态调整 Top-K → 看结果
                           └── 还不够？ → 换查询词再检索...
```

本章通过把 `semantic_search` 封装成 Agent 工具实现 Agentic RAG：LLM 完全自主控制检索时机和策略，不需要外层硬编码"先检索再生成"的逻辑。

**实际效果对比**：

```text
用户：2 + 2 等于多少？
传统 RAG：强制检索 "2 + 2" → 找到不相关文档 → LLM 还是自己算 → 浪费资源
Agentic RAG：LLM 判断不需要检索 → 直接回答 4 → 节省一次 Embedding + 向量搜索

用户：这个项目里错误处理的模式是什么？
传统 RAG：检索 "错误处理" → 返回 5 个片段 → LLM 基于固定片段回答
Agentic RAG：LLM 先搜 "error handling pattern" → 看结果 → 发现需要更多上下文
           → 再搜 "try catch wrapper" → 汇总两次结果 → 给出完整回答
```

---

### 10. Coding Agent 为什么不总用 RAG

学完本章，你可能想把所有 Coding Agent 都改成 RAG。但实际上，知名 Coding Agent（如 Claude Code）在检索代码时更多使用 `grep`、`find`、`read` 等文件系统工具，而不是向量检索。原因有以下几点：

**① 代码标识符本身就是精确语义锚点**

函数叫 `deleteUser`，调用它的地方也写 `deleteUser`。`grep` 能做到 100% 召回、0 误召回。而 Embedding 把精确问题变成了近似问题：

```text
Embedding 检索"删除用户函数":
  → deleteUser() 相似度 0.91 ✅
  → removeAccount() 相似度 0.87（可能是误召回）
  → createUser() 相似度 0.61（引入噪声）

Grep 检索 "deleteUser":
  → 精确命中所有调用点，无误召回
```

**② 向量索引会过时，文件系统永远最新**

开发者每次修改文件，向量索引就变脏了。Agent 检索到的块可能是修改前的旧代码。`grep` 每次都直接读文件系统，永远反映当前真实状态。

**③ 构建和维护索引的成本高**

| 环节 | 代价 |
|------|------|
| 初次建索引 | 对每个文件调用 Embedding API，耗时且有费用 |
| 保持新鲜 | 需要 file watcher / git hook 持续触发增量更新 |
| 存储 | 需要运行向量数据库 |

而 `grep` 的代价是零：无需预处理、无需外部服务、无需维护。

**④ 上下文窗口变大改变了权衡**

早期 LLM 上下文窗口只有 4K～8K token，RAG 是对小上下文窗口的补偿方案。现在主流模型达到 128K～200K token，可以直接把整个相关文件塞进上下文，不再需要切片。

**RAG 在 Coding 场景的适用边界**：

| 场景 | 推荐方案 |
|------|----------|
| 超大规模代码库（数百万行），无法枚举文件 | Embedding + 向量检索粗筛，再 grep 精确定位 |
| 文档/注释/Changelog 的自然语言问答 | RAG 效果好，grep 不适用 |
| 跨语言语义搜索（"实现了 X 功能的函数"）| Embedding 优于精确匹配 |
| 代码库实时变化、索引难以保鲜 | grep / 文件系统工具 |

---

## 💻 模块关系速览

```text
main.js
  ├── HTTPEmbeddingService(EMBED_BASE_URL)  ─┐
  ├── HTTPRerankService(RERANK_BASE_URL)    ─┤ → SemanticSearchTool → tools[]
  ├── InMemoryVectorStore                   ─┘
  │
  ├── Indexer(rootPath, vectorStore, embedService)  [后台并发索引]
  │     ├── FileWalker.walk()               → 遍历代码文件（跳过 node_modules 等）
  │     ├── chunker.chunk(docId, content)   → 切分为 Chunk[]
  │     │     ├── LineChunker               → 按行数+字符数切分（适合代码）
  │     │     └── ParagraphChunker          → 按空行段落切分（适合文档）
  │     ├── embedService.embed(chunk)       → 调用 Embedding API → float32[]
  │     └── vectorStore.insertBatch(points) → 存入内存向量表
  │
  ├── FileSystemStorage(globalDir)      ─┐
  ├── FileSystemStorage(workspaceDir)   ─┤ → MultiLevelMemory
  ├── LLMMemoryUpdater(back_model)      ─┘
  ├── MemoryStorage (offload 用)
  ├── OffloadPolicy / SummaryPolicy / TruncatePolicy → policies[]
  ├── ContextEngine(policies, memory)
  └── Agent(contextEngine, tools)
        └── runStreaming(query)
              ├── LLM 判断：需要语义搜索吗？
              │     └── SemanticSearchTool.execute({"query": "..."})
              │           ├── embedService.embed(query)          → 查询向量
              │           ├── vectorStore.search(vector, topK*2) → 粗排候选
              │           └── rerankService.rerank(query, cands) → 精排 [可选]
              └── commitTurn(draft)
                    ├── applyPolicies()
                    └── memory.update(draft.newMessages)
```

---

## ✅ 相比第六章，你现在多掌握了什么

如果说第六章是：

> "你的 Agent 有记忆了，重启后它还记得你。"

那么第七章就是：

> "你的 Agent 会主动检索知识库了，在百万行代码里也能自主找到相关内容。"

你现在已经掌握：

- **文档切分的必要性**：Embedding 长度限制 / 语义稀释 / context 控制，三重原因
- **余弦相似度的原理**：只看向量方向，不看长度，纯数学计算几毫秒
- **Embedding 模型的工作方式**：训练时编码语义距离，推理时只是前向计算
- **两阶段检索的分工**：Bi-Encoder（快，粗排）→ Cross-Encoder（慢，精排）
- **内存存储 vs pgvector 的权衡**：暴力 O(n) 搜索适合学习，生产要用索引
- **增量更新策略**：文件修改时间去重，三种操作状态（NEW / SKIP / REINDEX）
- **`Promise.allSettled` 分批并发**：控制并发度防止限流，失败不阻断全局
- **`fetch` vs SDK**：原生 fetch 更灵活，适合对接多种 Embedding/Rerank 提供商
- **RAG 工具的可选降级设计**：三层可选性，不配置也能运行
- **Agentic RAG vs 传统 RAG**：自主决策 vs 固定流程，LLM 控制检索策略
- **为什么 Coding Agent 更常用 grep**：标识符精确性 / 索引实时性 / 零成本

---

## 📚 扩展阅读

1. **[pgvector GitHub](https://github.com/pgvector/pgvector)**
   — 生产级向量存储，替换 `InMemoryVectorStore` 的首选方案

2. **[text-embedding-3-small 模型卡](https://platform.openai.com/docs/models/text-embedding-3-small)**
   — 了解 OpenAI Embedding 模型的维度、性能和定价

3. **[Cohere Rerank API](https://docs.cohere.com/reference/rerank)**
   — 业界常用的 Rerank 服务，了解 Cross-Encoder 的 API 规范

4. **[LangChain RAG 教程](https://python.langchain.com/docs/tutorials/rag/)**
   — 工业级框架的 RAG 实现，对比可理解本章的简化之处

5. **[向量索引算法：HNSW 详解](https://www.pinecone.io/learn/series/faiss/hnsw/)**
   — 理解 pgvector 的 HNSW 索引为什么比暴力搜索快，以及它的空间-速度权衡

6. **[RAG vs Long Context](https://arxiv.org/abs/2407.16833)**
   — 2024 年的研究：随着上下文窗口扩大，RAG 的必要性如何变化
