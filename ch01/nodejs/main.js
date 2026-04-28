/**
 * main.js — Chapter 01 Node.js 版本入口
 *
 * 用法：
 *   node main.js [选项]
 *
 * 选项（对应 Go 版本的命令行 Flags）：
 *   --raw        使用原生 fetch 而非 SDK（默认：使用 SDK）
 *   --stream     使用流式响应（默认：非流式）
 *   --q <text>   对话内容（默认："hello"）
 *
 * 示例：
 *   node main.js -q "讲一个关于程序员的冷笑话"
 *   node main.js --stream -q "从 1 数到 5"
 *   node main.js --raw -q "什么是大语言模型？"
 *   node main.js --raw --stream -q "从 1 数到 5"
 */

// dotenv：从项目根目录的 .env 文件加载环境变量
// 对应 Go 版本的 godotenv.Load()
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// 找到项目根目录（ch01/nodejs/main.js → 向上两级）
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../../.env');
config({ path: envPath }); // 加载 .env 文件

import { nonStreamingRequestRawHTTP, streamingRequestRawHTTP } from './raw.js';
import { nonStreamingRequestSDK, streamingRequestSDK } from './sdk.js';

// ─────────────────────────────────────────────────────────────────────────────
// 命令行参数解析
// 对应 Go 版本中的 flag.Bool / flag.String / flag.Parse()
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2); // 去掉 "node" 和 "main.js"

let useRaw = false;
let useStream = false;
let query = 'hello';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--raw' || args[i] === '-raw') {
    useRaw = true;
  } else if (args[i] === '--stream' || args[i] === '-stream') {
    useStream = true;
  } else if ((args[i] === '-q' || args[i] === '--q') && args[i + 1]) {
    query = args[++i];
  }
}

console.log(
  `[Config] useRaw=${useRaw}, useStream=${useStream}, query="${query}"`
);
console.log(`[Config] model=${process.env.OPENAI_MODEL || 'gpt-4o-mini'}`);
console.log('─'.repeat(60));

// ─────────────────────────────────────────────────────────────────────────────
// 根据参数组合调用对应函数
// 对应 Go 版本中的 switch { case *useRaw && *useStream: ... }
// ─────────────────────────────────────────────────────────────────────────────

try {
  if (useRaw && useStream) {
    // 组合1：Raw HTTP + 流式  → 手写 SSE 解析，最接近底层
    await streamingRequestRawHTTP(query);
  } else if (useRaw) {
    // 组合2：Raw HTTP + 非流式 → 手写请求，理解协议细节
    await nonStreamingRequestRawHTTP(query);
  } else if (useStream) {
    // 组合3：SDK + 流式         → 推荐的生产实践（流式体验）
    await streamingRequestSDK(query);
  } else {
    // 组合4：SDK + 非流式        → 最简洁的调用方式（默认）
    await nonStreamingRequestSDK(query);
  }
} catch (err) {
  console.error('[Error]', err.message);
  process.exit(1);
}
