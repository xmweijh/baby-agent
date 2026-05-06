import path from 'path';
import { fileURLToPath } from 'url';
import { config as loadDotenv } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
loadDotenv({ path: path.join(ROOT, '.env') });

import OpenAI from 'openai';
import { Agent } from './agent.js';
import { CODING_AGENT_SYSTEM_PROMPT } from './prompt.js';
import { BashTool } from './tool/bash.js';
import { LoadStorageTool } from './tool/load_storage.js';
import { SemanticSearchTool } from './tool/semantic_search.js';
import { BabyAgentTUI } from './tui.js';
import {
  MemoryStorage,
  FileSystemStorage,
  getGlobalStorageDir,
  getWorkspaceStorageDir,
} from './storage.js';
import { ContextEngine } from './context/engine.js';
import { TruncatePolicy } from './context/policy_truncate.js';
import { OffloadPolicy } from './context/policy_offload.js';
import { SummaryPolicy, LLMSummarizer } from './context/policy_summary.js';
import { MultiLevelMemory } from './memory/memory.js';
import { LLMMemoryUpdater } from './memory/update.js';
import { HTTPEmbeddingService } from './rag/embedding.js';
import { HTTPRerankService } from './rag/rerank.js';
import { InMemoryVectorStore } from './db/vectorstore.js';
import { Indexer } from './index/indexer.js';
import { ChunkerType } from './rag/chunker.js';

// ── 配置 ──────────────────────────────────────────────────────
const BASE_URL   = process.env.OPENAI_BASE_URL  || 'https://api.openai.com/v1';
const API_KEY    = process.env.OPENAI_API_KEY   || '';
const MODEL      = process.env.OPENAI_MODEL     || 'gpt-4o-mini';
// back_model：用于摘要和记忆更新，推荐使用更便宜的模型
const BACK_MODEL = process.env.OPENAI_BACK_MODEL || MODEL;
const CTX_WINDOW = parseInt(process.env.CONTEXT_WINDOW || '128000', 10);

// Embedding 和 Rerank 配置（可选，不配置则不启用 RAG）
const EMBED_BASE_URL = process.env.EMBED_BASE_URL || '';
const EMBED_API_KEY  = process.env.EMBED_API_KEY  || API_KEY;
const EMBED_MODEL    = process.env.EMBED_MODEL    || 'text-embedding-3-small';
const RERANK_BASE_URL = process.env.RERANK_BASE_URL || '';
const RERANK_API_KEY  = process.env.RERANK_API_KEY  || API_KEY;
const RERANK_MODEL    = process.env.RERANK_MODEL    || 'rerank';

// 要索引的代码库路径（默认为当前工作目录）
const INDEX_PATH = process.env.INDEX_PATH || process.cwd();

// ── Storage ───────────────────────────────────────────────────
// Offload 策略使用内存 Storage（进程内临时存储）
const offloadStorage = new MemoryStorage();

// 记忆使用文件系统 Storage（跨会话持久化）
const globalStorage    = new FileSystemStorage(getGlobalStorageDir());
const workspaceStorage = new FileSystemStorage(getWorkspaceStorageDir());

// ── Memory ────────────────────────────────────────────────────
const memoryUpdater = new LLMMemoryUpdater({
  baseURL:  BASE_URL,
  apiKey:   API_KEY,
  model:    BACK_MODEL,
});
const memory = new MultiLevelMemory(globalStorage, workspaceStorage, memoryUpdater);
await memory.load();

// ── RAG 组件（可选） ─────────────────────────────────────────
// 如果没有配置 EMBED_BASE_URL，则跳过 RAG 功能
let semanticSearchTool = null;
let indexer = null;

if (EMBED_BASE_URL) {
  // Embedding 服务
  const embedService = new HTTPEmbeddingService({
    apiKey:     EMBED_API_KEY,
    baseURL:    EMBED_BASE_URL,
    model:      EMBED_MODEL,
    dimensions: parseInt(process.env.EMBED_DIMENSIONS || '512', 10),
  });

  // Rerank 服务（可选）
  let rerankService = null;
  if (RERANK_BASE_URL) {
    rerankService = new HTTPRerankService({
      apiKey:  RERANK_API_KEY,
      baseURL: RERANK_BASE_URL,
      model:   RERANK_MODEL,
    });
  }

  // 向量存储（内存版本）
  const vectorStore = new InMemoryVectorStore();

  // 语义搜索工具
  semanticSearchTool = new SemanticSearchTool(embedService, vectorStore, rerankService);

  // 索引器
  indexer = new Indexer(
    {
      rootPath:    INDEX_PATH,
      chunkerType: ChunkerType.LINE,
      maxLines:    100,
      maxChars:    2000,
    },
    vectorStore,
    embedService,
  );

  // 后台启动索引（不阻塞 TUI 启动）
  console.log(`\x1b[34m[RAG] 正在索引代码库: ${INDEX_PATH}\x1b[0m`);
  indexer.indexConcurrent(10)
    .then((result) => {
      console.log(`\x1b[34m[RAG] ${result.toString()}\x1b[0m`);
    })
    .catch((err) => {
      console.error(`\x1b[31m[RAG] 索引失败: ${err.message}\x1b[0m`);
    });
} else {
  console.log('\x1b[90m[RAG] 未配置 EMBED_BASE_URL，跳过 RAG 功能\x1b[0m');
  console.log('\x1b[90m      设置 EMBED_BASE_URL 环境变量以启用语义搜索\x1b[0m');
}

// ── 策略 ──────────────────────────────────────────────────────
const backClient = new OpenAI({ baseURL: BASE_URL, apiKey: API_KEY });
const summarizer = new LLMSummarizer(backClient, BACK_MODEL, CTX_WINDOW, 500);

const policies = [
  new OffloadPolicy(offloadStorage, 0.8, 4, 200),
  new SummaryPolicy(summarizer, 4, 20, 0.85),
  new TruncatePolicy(4, 0.9),
];

// ── ContextEngine ─────────────────────────────────────────────
const contextEngine = new ContextEngine(policies, memory, CTX_WINDOW);

// ── 工具列表 ──────────────────────────────────────────────────
const tools = [
  new BashTool(),
  new LoadStorageTool(offloadStorage),
];

// 如果 RAG 已配置，加入语义搜索工具
if (semanticSearchTool) {
  tools.push(semanticSearchTool);
}

// ── Agent ──────────────────────────────────────────────────────
const agent = new Agent({
  baseURL:       BASE_URL,
  apiKey:        API_KEY,
  model:         MODEL,
  contextWindow: CTX_WINDOW,
  systemPrompt:  CODING_AGENT_SYSTEM_PROMPT,
  tools,
  mcpClients: [],
  contextEngine,
});

// ── TUI ────────────────────────────────────────────────────────
const tui = new BabyAgentTUI(agent, MODEL);
tui.start();
