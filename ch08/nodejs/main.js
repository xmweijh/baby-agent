/**
 * main.js — ch08 应用程序入口（Sandbox & Guardrails）
 *
 * 相较于第七章，本章变化：
 *   1. 使用 createBashTool() 工厂函数替代直接 new BashTool()
 *      → 自动检测 Docker，优先使用 DockerBashTool 沙盒隔离
 *   2. 配置 confirmConfig：bash 工具需要人工确认
 *   3. Agent 构造器新增 confirmConfig 参数
 *   4. 去除了 RAG（ch07 专属），保持代码简洁聚焦本章主题
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { config as loadDotenv } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
loadDotenv({ path: path.join(ROOT, '.env') });

import OpenAI from 'openai';
import { Agent } from './agent.js';
import { CODING_AGENT_SYSTEM_PROMPT } from './prompt.js';
import { LoadStorageTool } from './tool/load_storage.js';
import { createBashTool } from './tool/factory.js';      // 第八章：工具工厂
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

// ── 配置 ──────────────────────────────────────────────────────
const BASE_URL   = process.env.OPENAI_BASE_URL  || 'https://api.openai.com/v1';
const API_KEY    = process.env.OPENAI_API_KEY   || '';
const MODEL      = process.env.OPENAI_MODEL     || 'gpt-4o-mini';
const BACK_MODEL = process.env.OPENAI_BACK_MODEL || MODEL;
const CTX_WINDOW = parseInt(process.env.CONTEXT_WINDOW || '128000', 10);

// 工作区目录（Docker 沙盒卷挂载用）
const WORKSPACE_DIR = process.cwd();

// ── Storage ───────────────────────────────────────────────────
const offloadStorage   = new MemoryStorage();
const globalStorage    = new FileSystemStorage(getGlobalStorageDir());
const workspaceStorage = new FileSystemStorage(getWorkspaceStorageDir());

// ── Memory ────────────────────────────────────────────────────
const memoryUpdater = new LLMMemoryUpdater({
  baseURL: BASE_URL,
  apiKey:  API_KEY,
  model:   BACK_MODEL,
});
const memory = new MultiLevelMemory(globalStorage, workspaceStorage, memoryUpdater);
await memory.load();

// ── Context Engine ────────────────────────────────────────────
const backClient = new OpenAI({ baseURL: BASE_URL, apiKey: API_KEY });
const summarizer = new LLMSummarizer(backClient, BACK_MODEL, CTX_WINDOW, 500);

const policies = [
  new OffloadPolicy(offloadStorage, 0.8, 4, 200),
  new SummaryPolicy(summarizer, 4, 20, 0.85),
  new TruncatePolicy(4, 0.9),
];

const contextEngine = new ContextEngine(policies, memory, CTX_WINDOW);

// ── 工具列表 ──────────────────────────────────────────────────
// createBashTool：自动检测 Docker，有则用 DockerBashTool，无则降级到普通 BashTool
const bashTool = createBashTool(WORKSPACE_DIR);

const tools = [
  bashTool,
  new LoadStorageTool(offloadStorage),
];

// ── 工具确认配置（第八章核心）────────────────────────────────
// requireConfirmTools：执行前需要用户确认的工具名列表
const confirmConfig = {
  requireConfirmTools: ['bash'], // bash 工具执行前需要人工确认
};

// ── Agent ──────────────────────────────────────────────────────
const agent = new Agent({
  baseURL:        BASE_URL,
  apiKey:         API_KEY,
  model:          MODEL,
  contextWindow:  CTX_WINDOW,
  systemPrompt:   CODING_AGENT_SYSTEM_PROMPT,
  tools,
  mcpClients:     [],
  contextEngine,
  confirmConfig,  // 第八章新增
});

// ── TUI ────────────────────────────────────────────────────────
const tui = new BabyAgentTUI(agent, MODEL);
tui.start();
