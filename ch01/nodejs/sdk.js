/**
 * sdk.js — 使用官方 openai npm 包调用 OpenAI API
 *
 * 本文件演示如何使用官方 SDK（openai）完成同样的调用。
 * 与 raw.js 对比，SDK 封装了：
 *   - HTTP 请求的构造和发送
 *   - JSON 序列化 / 反序列化
 *   - SSE 流式读取和解析
 *   - 自动重试和错误处理
 *
 * 在生产项目中推荐使用 SDK 方式。
 *
 * 对应 Go 版本：sdk.go（使用 github.com/openai/openai-go）
 */

import OpenAI from 'openai';

/**
 * 从环境变量读取模型配置，创建 OpenAI 客户端
 *
 * 对应 Go 版本：
 *   client := openai.NewClient(
 *     option.WithBaseURL(modelConf.BaseURL),
 *     option.WithAPIKey(modelConf.ApiKey),
 *   )
 */
function createClient() {
  return new OpenAI({
    baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY || '',
  });
}

function getModel() {
  return process.env.OPENAI_MODEL || 'gpt-4o-mini';
}

// ─────────────────────────────────────────────────────────────────────────────
// 非流式调用 (Non-Streaming)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 使用 SDK 发起非流式对话请求
 *
 * 对应 Go 版本：NonStreamingRequestSDK()
 */
export async function nonStreamingRequestSDK(query) {
  const client = createClient();

  // 对应 Go 的 openai.ChatCompletionNewParams
  const resp = await client.chat.completions.create({
    model: getModel(),
    messages: [{ role: 'user', content: query }],
    // stream 默认为 false，不需要显式设置
  });

  if (!resp.choices || resp.choices.length === 0) {
    console.log('[SDK NonStream] No choices returned:', resp);
    return;
  }

  // 对应 Go 的 resp.Choices[0].Message.Content
  console.log('[SDK NonStream] resp content:', resp.choices[0].message.content);
  // 对应 Go 的 resp.Usage.RawJSON()
  console.log('[SDK NonStream] token usage:', resp.usage);
}

// ─────────────────────────────────────────────────────────────────────────────
// 流式调用 (Streaming)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 使用 SDK 发起流式对话请求
 *
 * 对应 Go 版本：StreamingRequestSDK()
 *
 * SDK 会自动处理 SSE 解析，暴露一个异步迭代器（AsyncIterable）
 * 我们只需 for await...of 循环取出每个 chunk 即可。
 *
 * 这等价于 Go 版本中的：
 *   stream := client.Chat.Completions.NewStreaming(ctx, req)
 *   for stream.Next() { ... }
 */
export async function streamingRequestSDK(query) {
  const client = createClient();

  // stream: true 让 SDK 返回 Stream 对象（可迭代）
  // 对应 Go 的 client.Chat.Completions.NewStreaming(ctx, req)
  const stream = await client.chat.completions.create({
    model: getModel(),
    messages: [{ role: 'user', content: query }],
    stream: true,
    stream_options: { include_usage: true }, // 让最后一个 chunk 携带 usage 信息
  });

  // for await...of 对应 Go 的 for stream.Next() { chunk := stream.Current() }
  for await (const chunk of stream) {
    console.log('[SDK Stream] chunk:', JSON.stringify(chunk));

    // usage 只在最后一个 chunk 出现（当设置了 stream_options.include_usage 时）
    // 对应 Go 的 if chunk.Usage.TotalTokens != 0 { ... }
    if (chunk.usage && chunk.usage.total_tokens) {
      console.log('[SDK Stream] token usage:', chunk.usage);
    }
  }
}
