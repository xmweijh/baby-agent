import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import express from 'express';
import { initDB } from './server/db.js';
import { Server } from './server/service.js';
import { createRouter } from './server/router.js';
import { Agent, SystemPrompt } from './agent/agent.js';
import { BashTool } from './agent/tool/bash.js';

// ---- 加载配置 ----
const configPath = resolve(process.cwd(), 'config.json');
let appConf;
try {
  appConf = JSON.parse(readFileSync(configPath, 'utf-8'));
} catch (e) {
  console.error(`Failed to load config.json: ${e.message}`);
  process.exit(1);
}

const modelConf = appConf.llm_providers?.front_model || appConf.front_model;
if (!modelConf?.base_url || !modelConf?.api_key || !modelConf?.model) {
  console.error('config.json missing llm_providers.front_model (base_url, api_key, model)');
  process.exit(1);
}

// ---- 初始化数据库 ----
const db = initDB('ch10.db');
console.log('Database initialized: ch10.db');

// ---- 初始化 Agent ----
const agent = new Agent(
  { model: modelConf.model, apiKey: modelConf.api_key, baseURL: modelConf.base_url },
  SystemPrompt,
  [new BashTool()],
);

// ---- 启动 HTTP 服务 ----
const server = new Server(db, agent);
const app = express();
app.use(express.json());
app.use('/api', createRouter(server));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`BabyAgent ch10 server listening on http://localhost:${PORT}`);
  console.log(`Model: ${modelConf.model}`);
});
