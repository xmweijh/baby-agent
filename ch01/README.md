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

## 🧠 LLM 原理深度解析（可选阅读）

理解以下原理，将帮助你更好地设计 Prompt、优化性能以及构建更可靠的 AI Agent。

### 神经网络基础

#### 什么是神经网络？

神经网络（Neural Network）受人脑神经元启发，由大量相互连接的"节点"（神经元）组成。每个节点接收输入、经过计算、产生输出。

```
输入层          隐藏层          输出层
 x₁ ─┐
 x₂ ─┼─→ [神经元] ─→ [神经元] ─→ 预测值
 x₃ ─┘
```

核心思想：通过大量数据"训练"，自动学习数据中的规律（即调整每个连接的"权重"）。

#### 激活函数（Activation Function）

神经元的输出经过激活函数处理，引入**非线性**，让网络能学习复杂规律：

```
ReLU:    f(x) = max(0, x)           ← 现在最常用，计算简单
Sigmoid: f(x) = 1 / (1 + e^(-x))   ← 输出 0~1，用于二分类
tanh:    f(x) = (e^x - e^-x) / ... ← 输出 -1~1，用于 RNN/LSTM
Softmax: 多分类输出归一化成概率      ← LLM 最后一层用它输出 token 概率
```

> 如果没有激活函数，多层神经网络等价于单层线性变换，无法学习复杂特征。

#### 训练：反向传播（Backpropagation）

```
前向传播：输入 → 逐层计算 → 得到预测值
                              ↓
                       计算"损失"（预测值与真实值的差距）
                              ↓
反向传播：从输出层往回，计算每个权重对损失的贡献（梯度）
                              ↓
梯度下降：沿着梯度方向微调权重，使损失减小

循环以上过程无数次 → 模型越来越"聪明"
```

### RNN 与 LSTM：处理序列的先驱

在 Transformer 出现之前，自然语言处理（NLP）主要依赖 RNN 和 LSTM。

#### RNN（循环神经网络）

RNN 通过将上一步的隐藏状态传递到下一步，让网络"记住"历史信息：

```
输入: "我" → "爱" → "AI"

[我] ─→ [RNN] ─→ h₁ ─→ [RNN] ─→ h₂ ─→ [RNN] ─→ h₃ → 输出
  ↑          ↑                ↑
 x₁         x₂              x₃

hₜ = tanh(W_h · hₜ₋₁ + W_x · xₜ)
```

**缺陷：梯度消失（Vanishing Gradient）**

序列越长，早期信息越容易被"遗忘"。原因是反向传播时梯度需要连乘多个权重，导致梯度指数级衰减。

#### LSTM（长短期记忆网络）

LSTM 通过三个"门控机制"解决了 RNN 的长距离遗忘问题：

```
┌─────────────────────────────────────────┐
│                LSTM 单元                 │
│                                          │
│   细胞状态 Cₜ（长期记忆传送带）           │
│   ──────────────────────────────────→  │
│          ↑ × f        ↑ × i            │
│   遗忘门(f)         输入门(i)            │
│   决定忘什么        决定记什么            │
│                                          │
│              输出门(o)                   │
│              决定输出什么                 │
└─────────────────────────────────────────┘

f = σ(Wf · [hₜ₋₁, xₜ])     ← 遗忘门：0=全忘，1=全保留
i = σ(Wi · [hₜ₋₁, xₜ])     ← 输入门：决定写入多少新信息
o = σ(Wo · [hₜ₋₁, xₜ])     ← 输出门：决定输出多少
Cₜ = f ⊙ Cₜ₋₁ + i ⊙ tanh(Wc · [hₜ₋₁, xₜ])
hₜ = o ⊙ tanh(Cₜ)
```

> **σ** 是 Sigmoid 函数，输出 0~1；**⊙** 是逐元素乘法（Hadamard 积）。

**局限性**：RNN/LSTM 都是**串行处理**，必须按顺序逐步处理每个 token，无法并行化，训练大规模数据时极慢。

### Transformer：现代 LLM 的基石

2017 年 Google 提出《Attention Is All You Need》，Transformer 彻底改变了 NLP。

#### 核心创新：自注意力机制（Self-Attention）

抛弃了循环结构，让每个 token 直接和序列中所有其他 token 交互：

```
"猫坐在地上"

处理"坐"时，同时关注所有其他词：
坐 → 猫 (0.8)   ← 高相关，猫是动作的主语
坐 → 坐 (1.0)   ← 自身
坐 → 在 (0.3)
坐 → 地 (0.6)   ← 相关，地是动作的位置
坐 → 上 (0.5)
```

#### Q、K、V：注意力的三角

同一份输入 X，通过三个不同的权重矩阵变换出三种角色：

```
输入 X（每个 token 的向量）
  │
  ├─→ × W_Q ──→ Q（Query，查询）   —— "我要找什么信息？"
  │
  ├─→ × W_K ──→ K（Key，键/标签）  —— "我的标签是什么？"
  │
  └─→ × W_V ──→ V（Value，内容）   —— "我的实际内容是什么？"
```

计算过程：

```
              Q · Kᵀ
Attention = softmax(────────) · V
                √d_k

1. Q · Kᵀ：计算 Query 和每个 Key 的相似度（点积）
2. / √d_k：缩放，防止点积结果过大导致 softmax 梯度消失
3. softmax：归一化成概率（注意力权重）
4. · V：按权重加权求和，得到融合了上下文的新表示
```

> **为什么要有 Q、K、V 三个不同矩阵？** 如果直接用原始输入做注意力，模型只有一种"视角"看数据。三个可学习矩阵让模型分别学会"如何提问"、"如何做索引"、"如何提取特征"，表达能力更强。

#### 多头注意力（Multi-Head Attention）

多个注意力头并行运行，每个头关注不同类型的关系：

```
Head 1 → 学语法关系（主谓宾）
Head 2 → 学语义关系（同义词、反义词）
Head 3 → 学位置关系（前后相邻）
...
所有头的结果拼接 → 线性变换 → 最终输出
```

#### 位置编码（Positional Encoding）

Transformer 并行处理所有 token，天然没有顺序感。因此需要给每个 token 加上位置信息：

```
token 向量 + 位置编码向量 → 带有位置信息的向量

位置编码使用正弦/余弦函数（原始论文）或可学习的参数（GPT-2 之后）
```

#### Transformer 完整架构

```
                    输出概率分布（Softmax）
                           ↑
                    线性变换（Linear）
                           ↑
              ┌────────────────────────┐
              │      Decoder（× N 层）  │
              │  Masked Self-Attention  │ ← 解码器不能"偷看"未来的 token
              │  Cross-Attention        │ ← Q 来自解码器，K/V 来自编码器
              │  Feed-Forward           │
              └────────────┬───────────┘
                           │ （翻译/摘要等 Seq2Seq 任务才有完整编解码器结构）
              ┌────────────┴───────────┐
              │      Encoder（× N 层）  │
              │  Self-Attention         │ ← 每个词和所有词交互
              │  Feed-Forward           │ ← 两层 MLP，增加非线性
              └────────────────────────┘
                           ↑
               输入 Embedding + 位置编码
```

**GPT 系列（包括 ChatGPT、Claude 等）只使用 Decoder 部分**，因为它们的任务是"续写"：给定前文，预测下一个 token。

**BERT 等模型只使用 Encoder 部分**，用于文本理解和分类任务。

### 训练过程：从"续写机器"到"对话助手"

#### 阶段一：预训练（Pre-training）

```
数据：互联网爬取的大量文本（万亿 token 级别）
任务：Next Token Prediction（预测下一个词）
目标：让模型"压缩"人类所有写作，学会语言规律

示例：
  输入: "The Eiffel Tower is located in"
  目标: "Paris"  ← 最大化这个 token 的预测概率
```

- 这个阶段耗费大量算力（GPT-3 训练成本约 460 万美元）
- 训练后模型拥有了世界知识和语言能力，但它只是个"续写机器"，不会遵循指令

#### 阶段二：有监督微调（SFT，Supervised Fine-Tuning）

```
数据：高质量的（指令, 回答）对，由人类标注
示例：
  输入: "解释什么是量子纠缠，用简单易懂的语言"
  输出: "量子纠缠是指两个粒子..."

目标：让模型学会"回答问题"而不是"继续写文章"
```

#### 阶段三：对齐训练（RLHF，基于人类反馈的强化学习）

```
步骤：
1. 用 SFT 模型生成多个答案
2. 人类标注员对答案排序（哪个更好）
3. 训练"奖励模型"（Reward Model）学习人类偏好
4. 用强化学习（PPO 算法）优化 LLM，使其生成奖励更高的答案

目标：让模型更安全、更有用、更诚实（OpenAI 的"对齐"目标）
```

> 近年出现了更高效的对齐方法，如 **DPO（Direct Preference Optimization）**，直接从偏好数据中优化，不需要单独训练奖励模型。

### Token：模型的基本单位

LLM 不直接处理文字，而是将文本切分成 **Token**。

**分词算法**：主流使用 **BPE（Byte Pair Encoding）** 或 **SentencePiece**：

```
BPE 原理：
1. 初始把每个字节视为独立 token
2. 统计所有相邻 token 对的频率
3. 把最频繁的 token 对合并成新 token
4. 重复直到达到词表大小（如 50,000）

示例（近似）：
"Hello, world!" → ["Hello", ",", " world", "!"]
"人工智能"      → ["人工", "智能"] 或 ["人", "工智", "能"]
"gpt-4o-mini"   → ["g", "pt", "-", "4", "o", "-", "mini"]
```

**Token 的重要性**：
- **计费单位**：API 调用按 Token 数量计费（通常分输入/输出 Token，价格不同）
- **上下文窗口限制**：模型有最大 Token 数限制（如 GPT-4o 的 128K），超出则早期内容被截断
- **语言密度差异**：英文约 1 个词 = 1~1.5 个 Token；中文通常每个汉字 = 1~2 个 Token（取决于分词器）

### 生成原理：下一个 Token 预测 + 采样策略

LLM 的生成是**自回归（Autoregressive）**过程：每次预测一个 token，将其加入输入，再预测下一个：

```
Step 1: 输入 "法国的首都是"
        → 模型输出所有 token 的概率分布
        → " 巴黎": 0.85, " 里昂": 0.03, " 马赛": 0.02, ...

Step 2: 采样选择 " 巴黎"，加入输入
        输入变为 "法国的首都是 巴黎"
        → 模型输出新的概率分布
        → "。": 0.6, "，": 0.2, " 是": 0.1, ...

Step 3: 选择 "。"，生成结束（或遇到 <|endoftext|> token）
```

**关键采样参数**：

| 参数 | 默认 | 含义 |
|------|------|------|
| `temperature` | 1.0 | 控制随机性。`0` = 确定性（总选概率最高的），`2` = 非常随机。写代码时建议 `0`~`0.3`，创意写作用 `0.7`~`1.2` |
| `top_p` | 1.0 | 核采样（Nucleus Sampling）：只从累积概率达到 p 的 top token 中采样，过滤低质量选项。通常设为 `0.9` |
| `top_k` | 无限制 | 只从概率最高的 k 个 token 中采样 |
| `max_tokens` | 模型上限 | 限制输出的最大 Token 数 |
| `presence_penalty` | 0 | 惩罚已出现的 token，减少重复（正值减少，负值增加） |
| `frequency_penalty` | 0 | 按出现频率惩罚 token，减少高频词重复 |

> `temperature` 和 `top_p` 通常只调其一，不要同时修改。

### 为什么 LLM 会"幻觉"？

"幻觉"（Hallucination）指模型生成看起来合理但实际错误的内容（如编造不存在的论文、错误的事实）。

原因分析：
1. **本质是统计**：模型学的是文本的统计规律，而非"真理"。它生成的是"听起来像正确答案的文字"，而非"查询到的事实"
2. **训练数据有截止日期**：模型不了解知识截止日期之后发生的事
3. **长尾知识不足**：训练数据中稀少的知识，模型会"脑补"
4. **自回归的累积误差**：一旦某步生成了偏差，后续会继续在错误基础上延伸

应对方法（后续章节会深入讲解）：
- **RAG（检索增强生成）**：把外部知识库的相关内容注入 Prompt（第 7 章）
- **Tool Use（工具调用）**：让模型调用搜索引擎、数据库等工具获取准确信息（第 2 章起）
- **低 temperature**：减少随机性，降低幻觉概率
- **思维链（Chain of Thought）**：让模型一步步推理，减少跳跃性错误

---

## 📚 扩展阅读与参考资料

1. **[OpenAI API Reference - Chat Completions](https://platform.openai.com/docs/api-reference/chat)**
   了解所有可用的请求参数（`temperature`、`top_p`、`presence_penalty` 等）以及完整的响应数据结构。这是构建任何基于 OpenAI 协议的 Agent 的基础文档。

2. **[MDN Web Docs - Server-sent events（SSE）](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)**
   SSE 协议的完整规范，包括 `data:`、`event:`、`id:`、`retry:` 等字段的含义。理解 SSE 有助于排查大模型流式输出的异常问题。

3. **[openai-go SDK GitHub](https://github.com/openai/openai-go)**
   官方 Go SDK 源码。阅读其 `streaming.go` 可以了解 SSE 解析、自动重试、错误处理的完整实现。

4. **[Attention Is All You Need（原论文）](https://arxiv.org/abs/1706.03762)**
   Transformer 架构的奠基论文（2017，Google Brain），建议至少阅读 Abstract 和 Introduction。

5. **[The Illustrated Transformer](https://jalammar.github.io/illustrated-transformer/)**
   Jay Alammar 的可视化讲解，图文并茂地解释 Transformer 的每个组件，是理解注意力机制最好的入门资料。

6. **[DeepSeek API Docs](https://api-docs.deepseek.com)**
   国内主流模型的 API 文档示例，只需替换 `base_url` 和 `model` 即可与本章代码兼容。
