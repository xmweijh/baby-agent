import path from 'path';
import { fileURLToPath } from 'url';
import { config as loadDotenv } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(__dirname, '../../.env') });

import { Agent } from './agent.js';
import { CODING_AGENT_SYSTEM_PROMPT } from './prompt.js';
import { BashTool } from './tool/bash.js';
import { BabyAgentTUI } from './tui.js';

const agent = new Agent({
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY || '',
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  systemPrompt: CODING_AGENT_SYSTEM_PROMPT,
  tools: [new BashTool()],
});

const tui = new BabyAgentTUI(agent, process.env.OPENAI_MODEL || 'gpt-4o-mini');
tui.start();
