/**
 * load_skill.js — LoadSkillTool（第九章新增）
 *
 * LLM 在需要技能指导时调用此工具：
 *   1. 接收技能 ID（如 "code-review"）
 *   2. 从 .babyagent/skills/<id>/SKILL.md 读取完整内容
 *   3. 返回格式化后的技能内容给 LLM
 *
 * 配合 SkillManager 的渐进式加载设计：
 *   - 启动时：system prompt 只注入 name + description（轻量）
 *   - 运行时：LLM 按需调用 load_skill 获取完整指令（按需）
 */

import { loadSkill } from '../skill/skill.js';

export class LoadSkillTool {
  name() { return 'load_skill'; }

  info() {
    return {
      type: 'function',
      function: {
        name: this.name(),
        description: 'Load the full content and instructions for a specific skill. Use this when you need detailed guidance for a task that matches a skill\'s purpose.',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The skill ID to load (e.g., "code-review", "debug")',
            },
          },
          required: ['name'],
        },
      },
    };
  }

  async execute(argumentsInJSON) {
    const { name } = JSON.parse(argumentsInJSON);
    if (!name) {
      throw new Error('skill name is required');
    }

    const skill = loadSkill(name);

    // 构建返回内容（与 Go 版本保持一致）
    const lines = [
      `# Skill: ${skill.name}`,
      '',
      '## Main Instruction',
      '',
      skill.mainInstruction,
      '',
      '## Utility Scripts',
    ];

    if (skill.scripts.length === 0) {
      lines.push('- (none)');
    } else {
      for (const filePath of skill.scripts) {
        lines.push(`- ${filePath}`);
      }
    }

    lines.push('');
    lines.push('## References');

    if (skill.references.length === 0) {
      lines.push('- (none)');
    } else {
      for (const filePath of skill.references) {
        lines.push(`- ${filePath}`);
      }
    }

    lines.push('');
    lines.push('You can read the script/reference files above when you need their full content.');

    return lines.join('\n');
  }
}
