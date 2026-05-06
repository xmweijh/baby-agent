# 第九章：Agent 技能插件 — Node.js 版本

本目录是第九章的 **Node.js 实现**。这一章的核心议题是：

> **Agent 具备了工具、上下文管理、记忆和安全防护后，如何针对特定场景"更有章法"地执行任务？答案是：技能（Skills）——本质上是一段描述性提示词，告诉模型面对某类任务时该遵循的步骤、检查点和输出格式。**

相较于第八章，本章引入了完整的 **Skills 技能插件系统**：

- **技能即提示**：技能不是代码，而是精心设计的 Markdown 文档
- **渐进式加载**：启动时只注入 name + description（约 50 tokens），完整内容按需加载
- **SkillManager**：自动扫描 `.babyagent/skills/` 目录，发现并管理技能
- **LoadSkillTool**：LLM 通过工具调用按需获取完整技能指令
- **ReadTool**：新增读取文件工具，配合 skills 的 scripts/references

---

## 📁 文件结构

```text
ch09/nodejs/
├── package.json                  # 依赖管理
├── main.js                       # 程序入口：初始化 SkillManager + 注入技能
├── agent.js                      # Agent Loop（继承第八章）
├── prompt.js                     # 系统提示词（新增 {skills} 占位符）
├── vo.js                         # 事件类型（继承第八章）
├── tui.js                        # 命令行 TUI（继承第八章）
├── storage.js                    # Storage（继承自第六章）
├── skill/
│   └── skill.js                  # SkillManager + loadSkill()（第九章核心新增）
├── tool/
│   ├── bash.js                   # BashTool（普通 shell，降级备用）
│   ├── docker_bash.js            # DockerBashTool（Docker 沙盒，来自第八章）
│   ├── factory.js                # createBashTool()（工具工厂，来自第八章）
│   ├── load_storage.js           # LoadStorageTool（来自第六章）
│   ├── read.js                   # ReadTool（第九章新增：读取文件）
│   └── load_skill.js             # LoadSkillTool（第九章新增：按需加载技能）
├── context/
│   └── engine.js                 # ContextEngine（新增 skillsContent + {skills} 替换）
└── memory/                       # MultiLevelMemory（继承自第六章）
```

---

## 🛠 准备工作

### 1. 安装依赖

```bash
cd ch09/nodejs
npm install
```

### 2. 配置环境变量

在项目根目录（`baby-agent/`）的 `.env` 中配置：

```env
# 必填：主模型
OPENAI_API_KEY=sk-your-api-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini

# 可选：记忆更新和摘要策略使用的廉价模型
OPENAI_BACK_MODEL=gpt-4o-mini

# 可选：context window 大小（tokens），默认 128000
CONTEXT_WINDOW=128000
```

### 3. 创建技能（可选）

```bash
mkdir -p .babyagent/skills/code-review
cat > .babyagent/skills/code-review/SKILL.md << 'EOF'
---
name: Code Review
description: Review code for bugs, style issues, and best practices
---

# Code Review Skill

## Steps
1. Read the target file(s)
2. Check for potential bugs and edge cases
3. Verify error handling is complete
4. Assess code readability and maintainability
5. Suggest performance optimizations if applicable

## Output Format
Provide a structured review with:
- **Summary**: Overall code quality assessment
- **Issues**: List of specific problems found
- **Suggestions**: Concrete improvement recommendations
EOF
```

---

## 🚀 运行方式

```bash
cd ch09/nodejs
node main.js
```

### 启动时技能加载日志

**有技能时：**
```
[Skills] 已加载 2 个技能: Code Review, Debug
BabyAgent TUI — ch09 (Skills System)
────────────────────────────────────────────────
欢迎使用，输入问题后回车。当前模型: gpt-4o-mini
```

**无技能时：**
```
[Skills] 未发现技能（.babyagent/skills/ 目录为空或不存在）
         创建 .babyagent/skills/<skill-id>/SKILL.md 以添加技能
BabyAgent TUI — ch09 (Skills System)
```

### 技能加载示例

```
你: 帮我 review 一下 main.js 这个文件

[LLM 识别到"代码审查"场景]
工具调用: load_skill({"name":"code-review"})
工具调用: read({"path":"./main.js"})

回答: 以下是对 main.js 的代码审查结果：

**Summary**: 代码结构清晰，整体质量良好。

**Issues**:
1. 第 42 行：缺少 API key 为空时的错误提示
2. 第 68 行：可以使用可选链运算符简化

**Suggestions**: ...
```

---

## 💡 Node.js 实现要点

### 1. 极简 YAML 解析器（不引入外部依赖）

Go 版本使用 `gopkg.in/yaml.v3` 解析 YAML front matter；Node.js 版本为了避免增加依赖，实现了一个极简的行级 YAML 解析器：

```javascript
function parseSimpleYAML(yamlText) {
  const result = {};
  for (const line of yamlText.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key   = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}
```

**局限性**：仅支持 `key: value` 格式，不支持嵌套、数组等复杂 YAML。对于技能系统只需 `name` 和 `description`，这已经足够。

**如果需要完整 YAML 支持**，可以添加 `js-yaml` 包：

```bash
npm install js-yaml
```

```javascript
import { load as parseYAML } from 'js-yaml';
const fm = parseYAML(parts[1]);
```

---

### 2. 渐进式加载的 token 节省原理

技能系统的核心设计是"先轻后重"：

```
启动时（每次对话）：
  {skills} = "You have access to the following skills...\n- **Code Review**: Review code..."
  约 50 tokens / 技能

用户请求时（按需）：
  load_skill("code-review") → 返回完整 500 token 内容
```

**对比直接注入所有内容**：

| 技能数量 | 直接注入所有内容 | 渐进式加载 |
|---------|----------------|-----------|
| 5 个   | 2500 tokens    | 250 tokens + 500 tokens（按需） |
| 10 个  | 5000 tokens    | 500 tokens + 500 tokens（按需） |
| 20 个  | 10000 tokens   | 1000 tokens + 500 tokens（按需） |

渐进式加载在技能增多时优势越来越明显。

---

### 3. SkillManager vs Go 版本的差异

Go 版本使用全局 `Manager` 结构体，技能目录固定为 `<workspaceDir>/.babyagent/skills/`；Node.js 版本 `SkillManager` 支持自定义工作区目录（方便测试）：

```javascript
// 默认使用当前目录
const skillManager = new SkillManager();

// 也可以指定目录（方便测试）
const skillManager = new SkillManager('/path/to/workspace');
```

---

### 4. ContextEngine 的 skillsContent 参数

第九章对 `ContextEngine` 做了最小改动，只增加了第四个可选参数 `skillsContent`：

```javascript
// ch08 用法（无 skills，向后兼容）
const contextEngine = new ContextEngine(policies, memory, CTX_WINDOW);

// ch09 用法（传入技能内容）
const skillsContent = skillManager.formatForPrompt();
const contextEngine = new ContextEngine(policies, memory, CTX_WINDOW, skillsContent);
```

`buildSystemPrompt()` 中新增一行替换：
```javascript
.replace('{skills}', skillsContent);
```

这种设计保持了向后兼容性：如果 system prompt 模板中没有 `{skills}`，替换不会有任何影响。

---

### 5. ReadTool — 为什么第九章才加入？

Go 版本在第九章才加入 `ReadTool`，原因是：
- 第六/七/八章的 bash 工具可以用 `cat` 读文件，不需要专门的 read 工具
- 第九章的技能引入了 `references/` 机制，需要 Agent 读取指定路径的参考文档
- 专门的 `ReadTool` 语义更清晰，且不依赖 Docker 沙盒（bash 在沙盒里，而沙盒中访问文件需要挂载）

Node.js 版本的 `ReadTool` 使用 `fs.readFileSync` 同步读取，简单可靠：

```javascript
async execute(argumentsInJSON) {
  const { path: filePath } = JSON.parse(argumentsInJSON);
  return fs.readFileSync(filePath, 'utf-8');
}
```

---

### 6. 技能文件格式解析流程

```
SKILL.md 内容：
  ---
  name: Code Review
  description: Review code for bugs...
  ---
  
  # Code Review Skill
  ...

解析步骤：
  1. text.split('---')  →  ['', 'name: ...\ndescription: ...\n', '\n# Code Review...']
  2. parts[1]           →  YAML front matter
  3. parts[2]           →  主体内容（mainInstruction）
  4. parseSimpleYAML    →  { name, description }
  5. listFiles(scripts/)  →  脚本文件路径数组
  6. listFiles(references/) →  参考文件路径数组
```

**注意**：`parts.length < 3` 时抛出错误，确保技能文件格式正确。

---

### 7. LoadSkillTool 的返回格式

LLM 调用 `load_skill("code-review")` 后，工具返回格式化的 Markdown：

```markdown
# Skill: Code Review

## Main Instruction

[完整技能正文内容...]

## Utility Scripts
- .babyagent/skills/code-review/scripts/check.sh

## References
- .babyagent/skills/code-review/references/style-guide.md

You can read the script/reference files above when you need their full content.
```

这个格式设计让 LLM 知道：
1. 应该遵循的步骤（Main Instruction）
2. 有哪些辅助脚本可以执行（Utility Scripts）
3. 有哪些参考文档可以读取（References）

---

## 📊 模块关系速览

```
main.js
  ├── SkillManager.loadAll()              # 扫描 .babyagent/skills/
  │     └── loadSkill(id)                # 解析每个 SKILL.md
  │           ├── parseSimpleYAML()       # 解析 YAML front matter
  │           └── listFiles(scripts/, references/)
  │
  ├── skillsContent = skillManager.formatForPrompt()
  │     └── "- **Code Review**: ..."     # 只有 name + description
  │
  ├── ContextEngine(policies, memory, CTX_WINDOW, skillsContent)
  │     └── buildSystemPrompt()
  │           └── .replace('{skills}', skillsContent)  # 注入 system prompt
  │
  └── Agent(tools=[ReadTool, bash, LoadStorageTool, LoadSkillTool])
        └── runStreaming(query, onEvent, signal, askConfirm)
              ├── [LLM 识别到技能场景]
              ├── load_skill("code-review")   # LoadSkillTool.execute()
              │     └── loadSkill("code-review") → 完整内容
              └── read("./main.js")           # ReadTool.execute()
                    └── fs.readFileSync()
```

---

## 🆚 与 Go 版本对比

| 特性               | Go 版本                    | Node.js 版本               |
|-------------------|---------------------------|--------------------------|
| YAML 解析          | `gopkg.in/yaml.v3`        | 自制极简解析器（无额外依赖）   |
| 技能目录扫描        | `os.ReadDir()`            | `fs.readdirSync()`       |
| 文件遍历           | `filepath.WalkDir()`      | 自制递归 `walk()` 函数       |
| 路径分隔符          | `filepath.ToSlash()`      | `.replace(/\\/g, '/')`   |
| ContextEngine 扩展 | 独立字段 + Init 方法        | 第四个构造参数（向后兼容）     |

---

## 📖 与前序章节对比

| 功能                   | ch06 | ch07 | ch08 | ch09 |
|-----------------------|------|------|------|------|
| 工具调用               | ✅   | ✅   | ✅   | ✅   |
| Context 策略           | ✅   | ✅   | ✅   | ✅   |
| Memory 记忆            | ✅   | ✅   | ✅   | ✅   |
| Agentic RAG            | ❌   | ✅   | ❌   | ❌*  |
| Docker 沙盒            | ❌   | ❌   | ✅   | ✅   |
| Human-in-the-Loop      | ❌   | ❌   | ✅   | ✅   |
| ReadTool               | ❌   | ❌   | ❌   | ✅   |
| Skills 技能系统         | ❌   | ❌   | ❌   | ✅   |

> *可以将 ch07 的 SemanticSearchTool 加回到工具列表中，实现完整叠加。

---

## 📚 延伸知识

### 提示词工程（Prompt Engineering）

Skills 本质上是结构化的提示词工程产物：

**好的技能文档应包含**：
- **Context**：任务背景和适用场景
- **Steps**：具体执行步骤（有序）
- **Criteria**：评判标准或检查清单
- **Output Format**：期望的输出格式和示例
- **Anti-patterns**：常见错误和应避免的做法

**技能粒度建议**：
- 太细：每个操作一个技能，会导致技能列表过长，LLM 路由困难
- 太粗：技能内容过于宽泛，指导性不强
- 建议：一个技能对应一类完整的工作流程（如"代码审查"、"性能分析"）

---

### Agent 能力边界与技能路由

技能路由是 LLM 的推理能力体现：
- LLM 读取 system prompt 中的技能列表（name + description）
- 分析用户请求的意图
- 决定是否需要加载某个技能（通过 load_skill 工具）
- 不一定每次都需要技能，简单问答可以直接回答

**常见路由失败场景**：
- 技能 description 太模糊，LLM 无法判断是否适用
- 用户请求措辞与技能描述相差太远（可以在 description 中加关键词）
- 技能过多时 LLM 可能"选择困难"

---

### 技能的版本管理

技能文件存放在 `.babyagent/skills/` 下，可以纳入 git 版本控制：

```bash
# 查看技能修改历史
git log .babyagent/skills/code-review/SKILL.md

# 不同项目使用不同技能
git checkout feature-branch -- .babyagent/skills/
```

这样每个项目/分支都可以有定制化的技能集。

---

## 🔗 精选扩展阅读

- [Anthropic Prompt Engineering Guide](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/overview) — Anthropic 官方提示词工程指南
- [OpenAI Prompt Engineering](https://platform.openai.com/docs/guides/prompt-engineering) — OpenAI 提示词最佳实践
- [ReAct: Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629) — LLM 推理+行动的经典论文
- [YAML Spec](https://yaml.org/spec/1.2.2/) — YAML 完整规范
- [js-yaml](https://github.com/nodeca/js-yaml) — Node.js 完整 YAML 解析库
