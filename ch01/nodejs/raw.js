/**
 * raw.js — 原生 fetch 实现 OpenAI API 调用
 *
 * 本文件演示如何不借助任何 SDK，直接使用 Node.js 原生 fetch（Node 18+）
 * 手工构造 HTTP 请求并解析响应。
 *
 * 目的：理解 OpenAI API 的底层协议细节：
 *   1. 请求结构（JSON Body）
 *   2. 非流式响应（完整 JSON 一次性返回）
 *   3. 流式响应（SSE，Server-Sent Events）
 */

/**
 * 从环境变量读取模型配置
 * 对应 Go 版本的 shared.NewModelConfig()
 */
function getModelConfig() {
  return {
    baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 非流式调用 (Non-Streaming)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 使用原生 fetch 发起非流式对话请求
 *
 * 对应 Go 版本：NonStreamingRequestRawHTTP()
 *
 * 请求体（JSON）：
 * {
 *   "model": "gpt-4o-mini",
 *   "messages": [{ "role": "user", "content": "..." }],
 *   "stream": false
 * }
 *
 * 响应体：模型思考完毕后，一次性返回完整 JSON
 * {
 *   "choices": [{ "message": { "role": "assistant", "content": "..." } }],
 *   "usage": { "prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30 }
 * }
 */
export async function nonStreamingRequestRawHTTP(query) {
  const conf = getModelConfig();

  // 构造请求体 —— 对应 Go 的 json.Marshal(requestBody)
  const requestBody = {
    model: conf.model,
    messages: [{ role: 'user', content: query }],
    stream: false,
  };

  // 发起 HTTP POST 请求
  // 对应 Go 的 http.NewRequestWithContext + client.Do
  const response = await fetch(`${conf.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${conf.apiKey}`,
    },
    body: JSON.stringify(requestBody), // 对应 Go 的 json.Marshal
  });

  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
  }

  // 读取响应体 —— 对应 Go 的 io.ReadAll(httpResp.Body)
  // 然后解析 JSON —— 对应 Go 的 json.Unmarshal
  const resp = await response.json();

  if (!resp.choices || resp.choices.length === 0) {
    console.log('No choices returned:', resp);
    return;
  }

  console.log('[NonStream] resp content:', resp.choices[0].message.content);
  console.log('[NonStream] token usage:', resp.usage);
}

// ─────────────────────────────────────────────────────────────────────────────
// 流式调用 (Streaming / SSE)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 使用原生 fetch + ReadableStream 实现流式 SSE 解析
 *
 * 对应 Go 版本：StreamingRequestRawHTTP()
 *
 * OpenAI 流式响应的协议（SSE，Server-Sent Events）：
 * 每一行数据格式为：
 *   data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n
 *   data: {"choices":[{"delta":{"content":"!"}}]}\n\n
 *   data: [DONE]\n\n
 *
 * 解析规则：
 *   1. 每行以 "data: " 开头
 *   2. 去掉前缀，得到 JSON 字符串
 *   3. 若内容为 "[DONE]"，说明生成结束
 *   4. 否则解析 JSON，取 choices[0].delta.content
 *   5. 把每个 chunk 的 content 拼接起来就是完整回复
 */
export async function streamingRequestRawHTTP(query) {
  const conf = getModelConfig();

  const requestBody = {
    model: conf.model,
    messages: [{ role: 'user', content: query }],
    stream: true, // 关键！开启流式模式
  };

  const response = await fetch(`${conf.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${conf.apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
  }

  // ── 关键：读取流式响应 ──────────────────────────────────────────────────────
  // response.body 是一个 ReadableStream<Uint8Array>
  // 对应 Go 的 bufio.NewScanner(httpResp.Body)
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');

  let buffer = ''; // 用于处理跨 chunk 的行切割

  while (true) {
    // 对应 Go 的 scanner.Scan()，每次读取一批字节
    const { done, value } = await reader.read();
    if (done) break;

    // Uint8Array → 字符串
    buffer += decoder.decode(value, { stream: true });

    // 按换行符切割，逐行处理
    // 对应 Go 的 line := scanner.Text()
    const lines = buffer.split('\n');

    // 最后一个元素可能是未完成的行，保留到下次
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();

      // 空行：SSE 协议中事件之间用空行分隔，直接跳过
      // 对应 Go 的 if line == "" { continue }
      if (!trimmed) continue;

      // 检查是否以 "data:" 开头
      // 对应 Go 的 strings.HasPrefix(line, "data:")
      if (!trimmed.startsWith('data:')) continue;

      // 去掉 "data:" 前缀
      // 对应 Go 的 strings.TrimPrefix(line, "data:")
      const data = trimmed.slice('data:'.length).trim();

      // 流结束标志
      // 对应 Go 的 if strings.TrimSpace(v) == "[DONE]" { break }
      if (data === '[DONE]') {
        console.log('[Stream] Done.');
        return;
      }

      // 解析 JSON chunk
      // 对应 Go 的 json.Unmarshal([]byte(v), &chunk)
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch (err) {
        console.error('[Stream] Failed to parse chunk:', err.message, data);
        continue;
      }

      console.log('[Stream] chunk:', data);

      // 如果有 token 用量（通常在最后一个 chunk），打印出来
      if (chunk.usage && chunk.usage.total_tokens) {
        console.log('[Stream] token usage:', chunk.usage);
      }
    }
  }
}
