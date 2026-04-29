/**
 * main.js — BabyAgent Ch02 入口
 *
 * 对应 Go 版本：ch02/main/main.go
 *
 * 用法：
 *   node main.js -q "请读取 README.md 并总结项目目标"
 *   node main.js -q "在 ch02 目录下创建 TODO.md，内容为 1. 研究 agent"
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { config as loadDotenv } from 'dotenv';

// 加载根目录 .env（向上两级）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(__dirname, '../../.env') });

import { Agent } from './agent.js';
import { ReadTool }  from './tool/read.js';
import { WriteTool } from './tool/write.js';
import { EditTool }  from './tool/edit.js';
import { BashTool }  from './tool/bash.js';

// ---------- 解析命令行参数 ----------
function parseArgs(argv) {
  const args = argv.slice(2);
  let query = 'hello';
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-q' || args[i] === '--query') && args[i + 1]) {
      query = args[++i];
    }
  }
  return { query };
}

const { query } = parseArgs(process.argv);

// ---------- 系统提示词（对应 Go 的 CodingAgentSystemPrompt） ----------
const SYSTEM_PROMPT = `# BabyAgent

You are BabyAgent, a helpful coding assistant.

## Guidelines
- State intent before tool calls, but NEVER predict or claim results before receiving them.
- Before modifying a file, read it first. Do not assume files or directories exist.
- After writing or editing a file, re-read it if accuracy matters.
- If a tool call fails, analyze the error before retrying with a different approach.
- Ask for clarification when the request is ambiguous.

Reply directly with text for conversations.
`;

// ---------- 创建 Agent，注册四个工具 ----------
const agent = new Agent({
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  apiKey:  process.env.OPENAI_API_KEY  || '',
  model:   process.env.OPENAI_MODEL    || 'gpt-4o-mini',
  systemPrompt: SYSTEM_PROMPT,
  tools: [
    new ReadTool(),
    new WriteTool(),
    new EditTool(),
    new BashTool(),
  ],
});

// ---------- 运行 ----------
try {
  const result = await agent.run(query);
  console.log(result);
} catch (err) {
  console.error('[main] Agent run error:', err.message);
  process.exit(1);
}
