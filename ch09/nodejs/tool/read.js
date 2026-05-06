/**
 * read.js — ReadTool（第九章新增）
 *
 * 让 Agent 读取文件内容。配合 Skills 系统使用：
 *   - LLM 通过 load_skill 获得 scripts/references 文件路径
 *   - 然后调用 read(path="...") 读取文件内容
 *   - 支持读取代码文件、配置文件等任意文本文件
 */

import fs from 'fs';

export class ReadTool {
  name() { return 'read'; }

  info() {
    return {
      type: 'function',
      function: {
        name: this.name(),
        description: 'Read the content of a file.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'The file path to read.',
            },
          },
          required: ['path'],
        },
      },
    };
  }

  async execute(argumentsInJSON) {
    const { path: filePath } = JSON.parse(argumentsInJSON);

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      throw new Error(`Path is a directory: ${filePath}`);
    }

    return fs.readFileSync(filePath, 'utf-8');
  }
}
