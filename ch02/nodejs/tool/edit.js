import fs from 'fs';
import path from 'path';

/**
 * EditTool — 按文本内容替换修改文件
 *
 * 对应 Go 版本：ch02/tool/edit.go
 * 工具名：edit
 * 参数：{ path: string, before: string, after: string }
 *
 * 实现策略：
 *   1. 读取原文件内容
 *   2. 创建 .bak 备份文件（防止写入失败后数据丢失）
 *   3. 将 before 文本替换为 after（全局替换）
 *   4. 写回文件，写成功后删除备份
 *   5. 如写入失败，从备份还原
 */
export class EditTool {
  name() {
    return 'edit';
  }

  info() {
    return {
      type: 'function',
      function: {
        name: this.name(),
        description: 'Edit a file by replacing all occurrences of the "before" text with "after" text. Creates a .bak backup before modifying.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'The absolute or relative file path to edit.',
            },
            before: {
              type: 'string',
              description: 'The exact text content to search for and replace.',
            },
            after: {
              type: 'string',
              description: 'The text content to replace the matched text with.',
            },
          },
          required: ['path', 'before', 'after'],
        },
      },
    };
  }

  async execute(argumentsInJSON) {
    const { path: filePath, before, after } = JSON.parse(argumentsInJSON);
    const resolved = path.resolve(filePath);
    const backupPath = resolved + '.bak';

    const original = fs.readFileSync(resolved, 'utf-8');

    // 创建备份
    fs.writeFileSync(backupPath, original, 'utf-8');

    try {
      // 全局替换（replaceAll 等价于 Go 的 strings.ReplaceAll）
      const updated = original.split(before).join(after);
      fs.writeFileSync(resolved, updated, 'utf-8');
      // 写入成功，删除备份
      fs.unlinkSync(backupPath);
    } catch (err) {
      // 写入失败，从备份还原
      try { fs.renameSync(backupPath, resolved); } catch (_) { /* ignore */ }
      throw err;
    }

    return '';
  }
}
