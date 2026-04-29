# 第一章：初识 LLM（Raw HTTP 与 OpenAI SDK）

欢迎来到第一章！作为后端工程师，我们每天都在和各种 API 打交道。AI 大模型的调用本质上也是一次 HTTP 请求。

本章的目标是带你**拨开 SDK 的迷雾，直视大模型调用的本质**。我们将分别使用 Go 标准库 `net/http`（原生手写请求）和官方 `openai-go` SDK 来完成同一个任务：向 LLM 发起对话。这不仅能帮助你深刻理解 OpenAI 协议与 SSE（流式输出）机制，更为后续开发健壮的 AI Agent 奠定坚实的基础。

> **Node.js 版本**：如果你更熟悉 JavaScript，可以参考 [nodejs/README.md](./nodejs/README.md)，功能与本章完全对等。

---

## 🎯 你将学到什么

1. **协议本质**：掌握 `chat/completions` 接口的最小化请求和响应结构。
2. **流式输出解析**：深入了解如何解析 Server-Sent Events（SSE）协议，实现"打字机"效果。
3. **工程实践**：对比 Raw HTTP 和官方 SDK 两种使用方式的优劣。
4. **LLM 原理**：从神经网络基础到 Transformer 架构，系统理解大模型的工作原理。

---

## 🛠 准备工作

在开始之前，请确保你已经准备好了环境配置。我们在项目根目录使用 `.env` 文件来管理敏感信息（`main.go` 中通过 `godotenv.Load()` 自动读取）。

在项目根目录创建 `.env` 文件，并填入以下内容：

```env
# 如果你使用的是国内模型（如 DeepSeek/GLM），请修改 Base URL 和 Model
OPENAI_API_KEY=sk-your-api-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

> **💡 小贴士**：得益于 OpenAI 协议的非正式标准化，只需更改 `BASE_URL` 和 `MODEL`，同一套代码就能无缝切换到绝大多数主流大模型厂商（DeepSeek、智谱 GLM、百川等）。

---

## 📖 核心原理解析

### 1. 最小请求结构（Request）

发起一次对话的核心路径是：`POST {OPENAI_BASE_URL}/chat/completions`

发送给大模型的核心请求体（JSON）如下，对应 `raw.go` 中的 `OpenAIChatCompletionRequest`：

```json
{
  "model": "gpt-4o-mini",
  "messages": [
    { "role": "user", "content": "你好" }
  ],
  "stream": false
}
```

- **`model`**：要调用的模型名称。
- **`messages`**：对话历史数组。大模型本身是**无记忆、无状态**的（每次请求独立），因此你需要把之前的聊天记录全部传给它，这就是"上下文"的实现方式。
- **`stream`**：是否开启流式增量返回。开启后将大幅降低首字响应时间（TTFT，Time To First Token）。

`messages` 中每条消息的 `role` 字段有三种取值：

| Role | 含义 | 示例 |
|------|------|------|
| `system` | 系统指令，设置模型行为和角色 | `"你是一名 Go 专家，用中文回答"` |
| `user` | 用户输入 | `"解释一下 goroutine"` |
| `assistant` | 模型的历史回复（用于多轮对话） | `"goroutine 是 Go 的轻量级线程..."` |

### 2. 响应结构（Response）

**非流式模式（`stream: false`）**

模型思考完毕后，一次性返回完整 JSON，对应 `raw.go` 中的 `OpenAIChatCompletionResponse`：

```json
{
  "id": "chatcmpl-xxx",
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "你好！有什么可以帮你的？"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 15,
    "total_tokens": 25
  }
}
```

关键字段：
- `choices[0].message.content`：模型回复的文本内容
- `finish_reason`：生成停止的原因（`stop`=正常完成，`length`=达到 max_tokens 限制，`tool_calls`=需要调用工具）
- `usage`：Token 消耗量（直接影响 API 费用）

### 3. 流式响应与 SSE 协议

**流式模式（`stream: true`）** 是主流 AI 产品的标准体验（如 ChatGPT 的打字机效果）。

**SSE（Server-Sent Events）** 是一种 HTTP 长连接协议，服务端可以持续向客户端推送数据。OpenAI 借助 SSE 实现了流式输出。

如果你使用原生 HTTP（见 `raw.go` 中的 `StreamingRequestRawHTTP`），会看到服务端返回的是逐行纯文本：

```text
data: {"id":"chatcmpl-xxx","choices":[{"delta":{"role":"assistant","content":""}}]}

data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"你"}}]}

data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"好"}}]}

data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"！"}}],"usage":{...}}

data: [DONE]
```

解析规则：
1. 每行格式为 `data: <JSON>`
2. 提取 `data:` 之后的内容
3. 若内容为 `[DONE]`，说明生成结束
4. 否则解析 JSON，取 `choices[0].delta.content` 并拼接
5. 注意：第一个 chunk 的 `delta` 通常包含 `role` 字段，后续只有 `content`

在 Go 中使用 `bufio.NewScanner(httpResp.Body)` 逐行读取，天然处理了行切割。`delta` 与非流式的 `message` 字段对应，只是每次只返回一小段"增量"内容，因此叫 `delta`（增量）。

---

## 💻 代码实现对比

本章提供了两套完整实现，通过命令行参数切换。

### 方式一：官方 SDK（`sdk.go`）——推荐在生产使用

使用 `github.com/openai/openai-go`，代码非常简洁：

```go
// 流式调用核心逻辑
stream := client.Chat.Completions.NewStreaming(ctx, req)
for stream.Next() {
    chunk := stream.Current()
    log.Printf("stream chunk: %v", chunk)
}
if stream.Err() != nil {
    log.Fatalf("stream error: %v", stream.Err())
}
```

SDK 封装了底层的 HTTP 请求、JSON 序列化、SSE 解析以及错误重试逻辑。在后续章节中，我们将统一采用这种方式。

### 方式二：原生 HTTP（`raw.go`）——推荐用于学习原理

使用 Go 标准库 `net/http`，手工构造请求和解析响应：

```go
// 非流式：直接读取全部响应体
respBodyBytes, err := io.ReadAll(httpResp.Body)
json.Unmarshal(respBodyBytes, &resp)

// 流式：逐行扫描 SSE 数据
scanner := bufio.NewScanner(httpResp.Body)
for scanner.Scan() {
    line := scanner.Text()
    if strings.HasPrefix(line, "data:") {
        v := strings.TrimPrefix(line, "data:")
        if strings.TrimSpace(v) == "[DONE]" { break }
        json.Unmarshal([]byte(v), &chunk)
    }
}
```

这对于排查网络问题、理解底层通信机制、或在不方便引入庞大 SDK 的极简项目中非常有帮助。

---

## 🚀 动手运行

进入项目**根目录**后执行：

```bash
# 1. 基础调用（SDK + 非流式，默认）
go run ./ch01/main -q "讲一个关于程序员的冷笑话"

# 2. 体验流式输出（SDK + 流式）
# 注意观察控制台日志，体会 chunk 是一块块返回的
go run ./ch01/main --stream -q "用 Go 语言写一个 Hello World"

# 3. 探索底层原理（Raw HTTP + 非流式）
go run ./ch01/main --raw -q "什么是大语言模型？用一句话解释"

# 4. 终极挑战：手写 SSE 解析（Raw HTTP + 流式）
go run ./ch01/main --raw --stream -q "从 1 数到 5"
```

---

## 🧠 LLM 原理深度解析

LLM 原理（神经网络基础、RNN/LSTM、Transformer、训练流程、Token、采样策略、幻觉等）统一收录在 Node.js 版本文档中，避免重复维护：

👉 [nodejs/README.md — LLM 原理深度解析](./nodejs/README.md#-llm-原理深度解析可选阅读)

---

## 📚 扩展阅读与参考资料

1. **[OpenAI API Reference - Chat Completions](https://platform.openai.com/docs/api-reference/chat)**
   了解所有可用的请求参数（`temperature`、`top_p`、`presence_penalty` 等）以及完整的响应数据结构。

2. **[MDN Web Docs - Server-sent events（SSE）](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)**
   SSE 协议的完整规范，包括 `data:`、`event:`、`id:`、`retry:` 等字段的含义。

3. **[openai-go SDK GitHub](https://github.com/openai/openai-go)**
   官方 Go SDK 源码。阅读其 `streaming.go` 可以了解 SSE 解析、自动重试、错误处理的完整实现。

4. **[DeepSeek API Docs](https://api-docs.deepseek.com)**
   国内主流模型的 API 文档示例，只需替换 `base_url` 和 `model` 即可与本章代码兼容。

