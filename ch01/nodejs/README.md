# 第一章：初识 LLM — Node.js 版本

本目录是第一章的 **Node.js 实现**，与 Go 版本（`../README.md`）功能完全对等。如果你更熟悉 JavaScript / TypeScript 生态，可以从这里入手。

---

## 📁 文件结构

```
ch01/nodejs/
├── package.json    # 依赖管理（对应 Go 的 go.mod）
├── main.js         # 入口，解析命令行参数（对应 Go 的 main/main.go）
├── raw.js          # 原生 fetch 实现（对应 Go 的 raw.go）
└── sdk.js          # 官方 SDK 实现（对应 Go 的 sdk.go）
```

---

## 🛠 准备工作

### 1. 环境要求

- **Node.js 18+**（需要内置 `fetch` API）
- 如果你的版本低于 18，需额外安装 `node-fetch`

### 2. 安装依赖

```bash
cd ch01/nodejs
npm install
```

本项目依赖：
- `openai`：官方 Node.js SDK
- `dotenv`：从 `.env` 文件加载环境变量（对应 Go 的 `godotenv`）

### 3. 配置环境变量

在**项目根目录**（`baby-agent/`）创建 `.env` 文件：

```env
# 如果你使用国内模型（如 DeepSeek/GLM），修改 Base URL 和 Model
OPENAI_API_KEY=sk-your-api-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

> `main.js` 会自动向上两级找到根目录的 `.env` 文件加载。

---

## 🚀 动手运行

在 `ch01/nodejs/` 目录下执行：

```bash
# 1. 基础调用（SDK + 非流式，默认）
node main.js -q "讲一个关于程序员的冷笑话"

# 2. 体验流式输出（SDK + 流式）
node main.js --stream -q "用 JavaScript 写一个 Hello World"

# 3. 探索底层原理（原生 fetch + 非流式）
node main.js --raw -q "什么是大语言模型？用一句话解释"

# 4. 手写 SSE 解析（原生 fetch + 流式）
node main.js --raw --stream -q "从 1 数到 5"
```

命令行参数说明：

| 参数 | 说明 | 默认 |
|------|------|------|
| `--raw` | 使用原生 fetch 而非 SDK | 关（使用 SDK） |
| `--stream` | 开启流式响应 | 关（非流式） |
| `-q <text>` | 对话内容 | `"hello"` |

---

## 💻 代码实现详解

### raw.js — 原生 fetch 实现

不依赖任何 AI SDK，直接使用 Node.js 18+ 内置的 `fetch` API 手工完成 HTTP 请求。

#### 非流式调用

```js
const response = await fetch(`${baseURL}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: query }],
    stream: false,
  }),
});

const resp = await response.json();
console.log(resp.choices[0].message.content);
```

#### 流式调用（手写 SSE 解析）

流式响应的 HTTP body 是一个 `ReadableStream`，需要通过 `getReader()` 逐块读取：

```js
const reader = response.body.getReader();
const decoder = new TextDecoder('utf-8');
let buffer = '';   // 跨 chunk 的行切割缓冲区

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  // Uint8Array → 字符串（stream: true 告知 decoder 数据未结束）
  buffer += decoder.decode(value, { stream: true });

  // 按换行符切割，逐行处理
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';   // 最后一行可能不完整，留到下次

  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice('data:'.length).trim();
    if (data === '[DONE]') return;            // 流结束
    const chunk = JSON.parse(data);
    // chunk.choices[0].delta.content 是这次的增量文字
  }
}
```

> **与 Go 版本的关键差异**：Go 使用 `bufio.Scanner` 按行扫描，天然处理了行切割；Node.js 的网络数据包（chunk）不一定按换行符对齐，需要手动维护 `buffer` 拼接后再切割。

### sdk.js — 官方 SDK 实现

使用 `openai` npm 包，SDK 封装了所有底层细节：

```js
import OpenAI from 'openai';

const client = new OpenAI({ baseURL, apiKey });

// 非流式
const resp = await client.chat.completions.create({
  model,
  messages: [{ role: 'user', content: query }],
});
console.log(resp.choices[0].message.content);

// 流式 — SDK 返回 AsyncIterable，用 for await...of 迭代
const stream = await client.chat.completions.create({
  model,
  messages: [{ role: 'user', content: query }],
  stream: true,
  stream_options: { include_usage: true },  // 让最后一个 chunk 携带 token 用量
});

for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content ?? '';
  process.stdout.write(content);  // 逐字打印，实现打字机效果
}
```

`for await...of` 是 ES2018 的异步迭代语法，对应 Go 版本中的 `for stream.Next() { chunk := stream.Current() }`。

---

## 🔍 Go vs Node.js 对照表

| 功能 | Go | Node.js |
|------|----|---------|
| 环境变量加载 | `godotenv.Load()` | `dotenv.config()` |
| HTTP 请求 | `net/http` | `fetch`（Node 18+ 内置） |
| JSON 序列化 | `json.Marshal()` | `JSON.stringify()` |
| JSON 反序列化 | `json.Unmarshal()` | `JSON.parse()` / `response.json()` |
| 流式读取 | `bufio.NewScanner()` | `response.body.getReader()` |
| 官方 SDK 流式 | `for stream.Next()` | `for await (const chunk of stream)` |
| 错误处理 | 返回值 `err`，显式判断 | `try/catch` 或 `Promise.catch()` |
| 模块系统 | `package` | ES Module（`import/export`） |

---

## 🧠 LLM 原理深度解析（可选阅读）

理解以下原理，将帮助你更好地设计 Prompt、优化性能以及构建更可靠的 AI Agent。

### 神经网络基础

#### 什么是神经网络？

神经网络的核心世界观和数学中的函数求解**完全一致**：

> 世界上的规律，都可以用一个函数来描述：`y = f(x)`

区别只在于**求解方式**：

| | 传统数学 | 神经网络 |
|---|---|---|
| 目标 | 找到 f(x) | 找到 f(x) |
| 已知 | 规律（公式） | 大量 (x, y) 样本 |
| 求解方式 | 推导/解析 | 从数据中反向拟合 |
| 参数 | 精确值 | 海量权重（近似） |

神经网络受人脑神经元启发，用大量相互连接的"节点"来**逼近**这个未知函数。每个节点接收输入、乘以权重、累加后输出：

```
输入层          隐藏层          输出层
 x₁ ─┐
 x₂ ─┼─→ [神经元] ─→ [神经元] ─→ 预测值 ŷ
 x₃ ─┘

每个神经元：output = activation( w₁x₁ + w₂x₂ + ... + b )
                                  ↑ 权重（待学习的参数）
```

**训练的本质**：给定大量 (x, y) 样本，不断调整所有节点的权重 w，让 `f(x) ≈ y` 尽可能准确。这和用最小二乘法拟合曲线是同一件事，只是神经网络可以拟合极其复杂的非线性函数。

#### 激活函数（Activation Function）

神经元的输出经过激活函数处理，引入**非线性**，让网络能学习复杂规律：

```
ReLU:    f(x) = max(0, x)           ← 现在最常用，计算简单
Sigmoid: f(x) = 1 / (1 + e^(-x))   ← 输出 0~1，用于二分类
tanh:    f(x) = (e^x - e^-x) / (e^x + e^-x)  ← 输出 -1~1，用于 RNN/LSTM
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

## 📚 相关资料

- [第一章 Go 版本说明](../README.md) — 包含完整的 LLM 原理深度解析（神经网络、Transformer、训练流程等）
- [openai-node SDK GitHub](https://github.com/openai/openai-node) — 官方 Node.js SDK 源码
- [OpenAI API Reference](https://platform.openai.com/docs/api-reference/chat) — 完整请求/响应参数文档
- [MDN — Server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) — SSE 协议规范
