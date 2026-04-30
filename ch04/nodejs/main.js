import path from 'path';
import { fileURLToPath } from 'url';
import { config as loadDotenv } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
loadDotenv({ path: path.join(ROOT, '.env') });

import { Agent } from './agent.js';
import { CODING_AGENT_SYSTEM_PROMPT } from './prompt.js';
import { BashTool } from './tool/bash.js';
import { BabyAgentTUI } from './tui.js';
import { loadMcpClients } from './mcp.js';

// 获取当前工作目录（用于替换 ${workspaceFolder}）
const workspaceFolder = process.cwd();
const mcpConfigPath = path.join(ROOT, 'mcp-server.json');

console.error('[main] Loading MCP servers from', mcpConfigPath);
const mcpClients = await loadMcpClients(mcpConfigPath, workspaceFolder);

const agent = new Agent({
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY || '',
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  systemPrompt: CODING_AGENT_SYSTEM_PROMPT,
  tools: [new BashTool()],
  mcpClients,
});

const tui = new BabyAgentTUI(agent, process.env.OPENAI_MODEL || 'gpt-4o-mini');
tui.start();
