/**
 * skill.js — Skills 技能系统（第九章核心新增）
 *
 * Skills 是描述性提示词，不是代码：
 *   - 告诉模型面对某类任务时的步骤、检查点、输出格式
 *   - 工具（bash/read/write）不变，只是更有章法地使用
 *
 * 技能文件结构（Markdown + YAML front matter）：
 *   .babyagent/skills/<skill-id>/SKILL.md
 *   ├── YAML front matter（name, description）
 *   ├── 主体指令（MainInstruction）
 *   ├── scripts/（辅助脚本，相对路径）
 *   └── references/（参考文档，相对路径）
 *
 * 渐进式加载策略（节省 token）：
 *   - 启动时：仅加载 name + description（约 50 tokens/技能）
 *   - 运行时：LLM 调用 load_skill(name="...") 时加载完整内容（约 500 tokens）
 */

import fs from 'fs';
import path from 'path';
import process from 'process';

// ── Skill 数据结构 ────────────────────────────────────────────

/**
 * @typedef {object} Skill
 * @property {string} id              - 技能 ID（目录名）
 * @property {string} name            - 技能名称（front matter）
 * @property {string} description     - 技能描述（front matter）
 * @property {string} mainInstruction - 主体指令（SKILL.md 正文）
 * @property {string[]} scripts       - scripts/ 下的文件相对路径
 * @property {string[]} references    - references/ 下的文件相对路径
 */

// ── YAML front matter 解析 ────────────────────────────────────

/**
 * 极简 YAML front matter 解析器
 * 只解析 key: value 格式，满足 name/description 等简单字段即可。
 * 不依赖 yaml 包，避免增加依赖。
 *
 * @param {string} yamlText
 * @returns {Record<string, string>}
 */
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

// ── 递归列出文件 ─────────────────────────────────────────────

/**
 * 递归列出 baseDir 下所有文件，返回相对于 workspaceDir 的路径数组（已排序）
 * @param {string} baseDir
 * @param {string} workspaceDir
 * @returns {string[]}
 */
function listFiles(baseDir, workspaceDir) {
  if (!fs.existsSync(baseDir)) return [];

  const results = [];

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        // 转为相对于 workspaceDir 的路径，使用 posix 分隔符（与 Go 版本一致）
        const rel = path.relative(workspaceDir, fullPath).replace(/\\/g, '/');
        results.push(rel);
      }
    }
  }

  walk(baseDir);
  results.sort();
  return results;
}

// ── 单个技能加载 ──────────────────────────────────────────────

/**
 * 加载单个技能
 * @param {string} id           - 技能 ID（目录名）
 * @param {string} [workspaceDir] - 工作区目录（默认 process.cwd()）
 * @returns {Skill}
 */
export function loadSkill(id, workspaceDir = process.cwd()) {
  const skillDir       = path.join(workspaceDir, '.babyagent', 'skills', id);
  const instructionPath = path.join(skillDir, 'SKILL.md');

  if (!fs.existsSync(instructionPath)) {
    throw new Error(`Skill file not found: ${instructionPath}`);
  }

  const text = fs.readFileSync(instructionPath, 'utf-8');

  // 解析 YAML front matter：--- 分隔符
  const parts = text.split('---');
  if (parts.length < 3) {
    throw new Error(`Skill file must have YAML front matter enclosed in \`---\`: ${instructionPath}`);
  }

  // parts[0] = 空（第一个 --- 之前）
  // parts[1] = YAML front matter
  // parts[2] = 主体内容
  const fm = parseSimpleYAML(parts[1]);

  if (!fm.name) {
    throw new Error(`Skill must have a 'name' field in front matter: ${instructionPath}`);
  }
  if (!fm.description) {
    throw new Error(`Skill must have a 'description' field in front matter: ${instructionPath}`);
  }

  const scripts    = listFiles(path.join(skillDir, 'scripts'),    workspaceDir);
  const references = listFiles(path.join(skillDir, 'references'), workspaceDir);

  return {
    id,
    name:            fm.name,
    description:     fm.description,
    mainInstruction: parts[2].trim(),
    scripts,
    references,
  };
}

// ── Skill Manager ─────────────────────────────────────────────

/**
 * SkillManager — 技能管理器
 *
 * 负责：
 *   1. 扫描 .babyagent/skills/ 目录，发现所有技能
 *   2. 加载技能元数据（name + description）
 *   3. 格式化技能列表，注入 system prompt 的 {skills} 占位符
 */
export class SkillManager {
  /**
   * @param {string} [workspaceDir] - 工作区目录，默认 process.cwd()
   */
  constructor(workspaceDir = process.cwd()) {
    this.workspaceDir = workspaceDir;
    this.skillsDir    = path.join(workspaceDir, '.babyagent', 'skills');
    /** @type {Skill[]} */
    this.skills = [];
  }

  /**
   * 扫描并加载所有技能元数据
   * 如果 .babyagent/skills/ 不存在，静默跳过（不报错）
   * @returns {void}
   */
  loadAll() {
    if (!fs.existsSync(this.skillsDir)) {
      return; // 技能目录不存在，静默跳过
    }

    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillId = entry.name;
      try {
        const skill = loadSkill(skillId, this.workspaceDir);
        this.skills.push(skill);
      } catch (err) {
        // 加载失败不中断，打印警告继续
        console.warn(`[Skills] Warning: failed to load skill '${skillId}': ${err.message}`);
      }
    }
  }

  /**
   * 格式化技能列表，用于注入 system prompt 的 {skills} 占位符
   *
   * 仅包含 name + description（渐进式加载：节省 token）
   * @returns {string}
   */
  formatForPrompt() {
    if (this.skills.length === 0) {
      return 'No skills available.';
    }

    const lines = [
      'You have access to the following skills. ',
      'When a user request matches a skill\'s purpose, use the `load_skill` tool to load the full skill instructions.\n',
    ];

    for (const skill of this.skills) {
      lines.push(`- **${skill.name}**: ${skill.description}`);
    }

    return lines.join('\n');
  }
}
