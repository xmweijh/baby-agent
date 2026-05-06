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
import { MemoryStorage } from './storage.js';
import { ContextEngine } from './context/engine.js';
import { TruncatePolicy } from './context/policy_truncate.js';
import { OffloadPolicy } from './context/policy_offload.js';
import { SummaryPolicy, LLMSummarizer } from './context/policy_summary.js';

// ── 配置 ──────────────────────────────────────────────────────
const BASE_URL      = process.env.OPENAI_BASE_URL  || 'https://api.openai.com/v1';
const API_KEY       = process.env.OPENAI_API_KEY   || '';
const MODEL         = process.env.OPENAI_MODEL     || 'gpt-4o-mini';
// back_model 用于摘要，推荐使用更便宜的模型
const BACK_MODEL    = process.env.OPENAI_BACK_MODEL || MODEL;
const CTX_WINDOW    = parseInt(process.env.CONTEXT_WINDOW || '128000', 10);

// ── Storage ──────────────────────────────────────────────────
const storage = new MemoryStorage();

// ── 策略 ──────────────────────────────────────────────────────
// 三种策略按需启用，门槛依次升高：
//   offload  → 先卸载长工具消息 (>80% 使用率触发)
//   truncate → 直接截断旧消息   (>90% 触发)
//   summarize→ LLM 压缩成摘要   (>85% 触发，需要 back_model)
const backClient = new OpenAI({ baseURL: BASE_URL, apiKey: API_KEY });
const summarizer = new LLMSummarizer(backClient, BACK_MODEL, CTX_WINDOW, 500);

const policies = [
  new OffloadPolicy(storage, 0.8, 4, 200),
  new SummaryPolicy(summarizer, 4, 20, 0.85),
  new TruncatePolicy(4, 0.9),
];

// ── ContextEngine ─────────────────────────────────────────────
const contextEngine = new ContextEngine(policies, CTX_WINDOW);

// ── Agent ──────────────────────────────────────────────────────
const agent = new Agent({
  baseURL:       BASE_URL,
  apiKey:        API_KEY,
  model:         MODEL,
  contextWindow: CTX_WINDOW,
  systemPrompt:  CODING_AGENT_SYSTEM_PROMPT,
  tools: [
    new BashTool(),
    new LoadStorageTool(storage),
  ],
  mcpClients: [],
  contextEngine,
});

// ── TUI ────────────────────────────────────────────────────────
const tui = new BabyAgentTUI(agent, MODEL);
tui.start();
