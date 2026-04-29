import fs from 'fs';
import path from 'path';

/**
 * ReadTool — 读取本地文件内容
 *
 * 对应 Go 版本：ch02/tool/read.go
 * 工具名：read
 * 参数：{ path: string }
 */
export class ReadTool {
  /** 工具名称，用于路由调用 */
  name() {
    return 'read';
  }

  /**
   * 返回 OpenAI Function Calling 格式的工具定义（JSON Schema）。
   * SDK 会将这个对象放入 `tools` 数组发给模型。
   */
  info() {
    return {
      type: 'function',
      function: {
        name: this.name(),
        description: 'Read the content of a local file and return it as a string.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'The absolute or relative file path to read.',
            },
          },
          required: ['path'],
        },
      },
    };
  }

  /**
   * 执行工具：读取文件并返回内容字符串。
   * @param {string} argumentsInJSON - 模型传入的 JSON 字符串，如 '{"path":"./README.md"}'
   * @returns {Promise<string>} 文件内容
   */
  async execute(argumentsInJSON) {
    const { path: filePath } = JSON.parse(argumentsInJSON);
    const resolved = path.resolve(filePath);

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      throw new Error(`Path is a directory: ${resolved}`);
    }

    return fs.readFileSync(resolved, 'utf-8');
  }
}
