import { execSync } from 'child_process';
import os from 'os';

/**
 * BashTool — 执行 Shell 命令并返回输出
 *
 * 对应 Go 版本：ch02/tool/bash.go
 * 工具名：bash
 * 参数：{ command: string }
 *
 * 平台适配：
 *   - macOS/Linux：使用 sh -c
 *   - Windows：使用 cmd /C
 *
 * ⚠️ 安全警告：这是一个高风险工具！
 *   - 大模型可能因幻觉或 Prompt Injection 执行危险命令（如 rm -rf）
 *   - 生产环境必须引入：命令白名单 / 人工确认 / Docker 沙盒隔离
 *   - 参见第八章：沙盒与安全策略
 */
export class BashTool {
  name() {
    return 'bash';
  }

  info() {
    return {
      type: 'function',
      function: {
        name: this.name(),
        description: 'Execute a shell command and return its combined stdout+stderr output. Use with caution.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'The shell command to execute.',
            },
          },
          required: ['command'],
        },
      },
    };
  }

  async execute(argumentsInJSON) {
    const { command } = JSON.parse(argumentsInJSON);

    const isWindows = os.platform() === 'win32';

    // execSync 会合并 stdout + stderr，超时 30 秒
    // Windows 使用 cmd /C，Unix 使用 sh -c
    let output;
    if (isWindows) {
      output = execSync(command, {
        shell: 'cmd.exe',
        encoding: 'utf-8',
        timeout: 30_000,
      });
    } else {
      output = execSync(command, {
        shell: '/bin/sh',
        encoding: 'utf-8',
        timeout: 30_000,
      });
    }

    return output;
  }
}
