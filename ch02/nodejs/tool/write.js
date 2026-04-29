import fs from 'fs';
import path from 'path';

/**
 * WriteTool — 写入文件（覆盖模式）
 *
 * 对应 Go 版本：ch02/tool/write.go
 * 工具名：write
 * 参数：{ path: string, content: string }
 *
 * 注意：如果目标目录不存在会自动创建（使用 recursive: true）。
 */
export class WriteTool {
  name() {
    return 'write';
  }

  info() {
    return {
      type: 'function',
      function: {
        name: this.name(),
        description: 'Write content to a file, overwriting it if it already exists. Creates parent directories automatically.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'The absolute or relative file path to write.',
            },
            content: {
              type: 'string',
              description: 'The text content to write to the file.',
            },
          },
          required: ['path', 'content'],
        },
      },
    };
  }

  async execute(argumentsInJSON) {
    const { path: filePath, content } = JSON.parse(argumentsInJSON);
    const resolved = path.resolve(filePath);

    // 自动创建父目录（如 ./new/dir/file.txt 时创建 ./new/dir/）
    const dir = path.dirname(resolved);
    fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(resolved, content, 'utf-8');
    return '';
  }
}
