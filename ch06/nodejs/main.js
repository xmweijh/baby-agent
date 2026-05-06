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
import { BabyAgentTUI } from './tui.js';
import { MemoryStorage, FileSystemStorage, getGlobalStorageDir, getWorkspaceStorageDir } from './storage.js';
import { ContextEngine } from './context/engine.js';
import { TruncatePolicy } from './context/policy_truncate.js';
import { OffloadPolicy } from './context/policy_offload.js';
import { SummaryPolicy, LLMSummarizer } from './context/policy_summary.js';
import { MultiLevelMemory } from './memory/memory.js';
import { LLMMemoryUpdater } from './memory/update.js';

// ── 配置 ──────────────────────────────────────────────────────
const BASE_URL   = process.env.OPENAI_BASE_URL  || 'https://api.openai.com/v1';
const API_KEY    = process.env.OPENAI_API_KEY   || '';
const MODEL      = process.env.OPENAI_MODEL     || 'gpt-4o-mini';
// back_model：用于摘要和记忆更新，推荐使用更便宜的模型
const BACK_MODEL = process.env.OPENAI_BACK_MODEL || MODEL;
const CTX_WINDOW = parseInt(process.env.CONTEXT_WINDOW || '128000', 10);

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

// 从磁盘加载已有记忆（异步，但可以先等一下）
await memory.load();

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

// ── Agent ──────────────────────────────────────────────────────
const agent = new Agent({
  baseURL:       BASE_URL,
  apiKey:        API_KEY,
  model:         MODEL,
  contextWindow: CTX_WINDOW,
  systemPrompt:  CODING_AGENT_SYSTEM_PROMPT,
  tools: [
    new BashTool(),
    new LoadStorageTool(offloadStorage),
  ],
  mcpClients: [],
  contextEngine,
});

// ── TUI ────────────────────────────────────────────────────────
const tui = new BabyAgentTUI(agent, MODEL);
tui.start();
