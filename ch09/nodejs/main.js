/**
 * main.js — ch09 应用程序入口（Skills System）
 *
 * 相较于第八章，本章变化：
 *   1. 初始化 SkillManager，扫描 .babyagent/skills/ 目录
 *   2. 将技能元数据（name + description）注入 ContextEngine
 *      → ContextEngine.buildSystemPrompt() 替换 {skills} 占位符
 *   3. 新增 ReadTool：让 Agent 读取文件内容（配合 skills 的 references）
 *   4. 新增 LoadSkillTool：LLM 按需加载完整技能内容
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
import { ReadTool } from './tool/read.js';
import { LoadStorageTool } from './tool/load_storage.js';
import { LoadSkillTool } from './tool/load_skill.js';    // 第九章新增
import { createBashTool } from './tool/factory.js';
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
import { SkillManager } from './skill/skill.js';          // 第九章新增

// ── 配置 ──────────────────────────────────────────────────────
const BASE_URL   = process.env.OPENAI_BASE_URL  || 'https://api.openai.com/v1';
const API_KEY    = process.env.OPENAI_API_KEY   || '';
const MODEL      = process.env.OPENAI_MODEL     || 'gpt-4o-mini';
const BACK_MODEL = process.env.OPENAI_BACK_MODEL || MODEL;
const CTX_WINDOW = parseInt(process.env.CONTEXT_WINDOW || '128000', 10);

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

// ── Skills（第九章核心）──────────────────────────────────────
//
// SkillManager 扫描 .babyagent/skills/ 目录，加载所有技能元数据（name + description）
// 如果目录不存在或无技能，会静默跳过，系统正常运行
const skillManager = new SkillManager(WORKSPACE_DIR);
skillManager.loadAll();

// 格式化技能列表，用于注入 system prompt 的 {skills} 占位符
const skillsContent = skillManager.formatForPrompt();

if (skillManager.skills.length > 0) {
  console.log(`\x1b[35m[Skills] 已加载 ${skillManager.skills.length} 个技能: ${skillManager.skills.map((s) => s.name).join(', ')}\x1b[0m`);
} else {
  console.log('\x1b[90m[Skills] 未发现技能（.babyagent/skills/ 目录为空或不存在）\x1b[0m');
  console.log('\x1b[90m         创建 .babyagent/skills/<skill-id>/SKILL.md 以添加技能\x1b[0m');
}

// ── Context Engine ────────────────────────────────────────────
const backClient = new OpenAI({ baseURL: BASE_URL, apiKey: API_KEY });
const summarizer = new LLMSummarizer(backClient, BACK_MODEL, CTX_WINDOW, 500);

const policies = [
  new OffloadPolicy(offloadStorage, 0.8, 4, 200),
  new SummaryPolicy(summarizer, 4, 20, 0.85),
  new TruncatePolicy(4, 0.9),
];

// 第九章：ContextEngine 第四个参数传入 skillsContent
const contextEngine = new ContextEngine(policies, memory, CTX_WINDOW, skillsContent);

// ── 工具列表 ──────────────────────────────────────────────────
const bashTool = createBashTool(WORKSPACE_DIR);

const tools = [
  new ReadTool(),                       // 第九章新增：读取文件
  bashTool,                             // 沙盒 bash（来自第八章）
  new LoadStorageTool(offloadStorage),  // 加载卸载内容
  new LoadSkillTool(),                  // 第九章新增：按需加载技能
];

// ── 工具确认配置 ──────────────────────────────────────────────
const confirmConfig = {
  requireConfirmTools: ['bash'],
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
  confirmConfig,
});

// ── TUI ────────────────────────────────────────────────────────
const tui = new BabyAgentTUI(agent, MODEL);
tui.start();
