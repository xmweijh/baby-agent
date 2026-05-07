import { execSync } from 'child_process';
import os from 'os';

export class BashTool {
  toolName() { return 'bash'; }

  info() {
    return {
      type: 'function',
      function: {
        name: this.toolName(),
        description: 'Execute a shell command and return its combined stdout and stderr output.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The shell command to execute.' },
          },
          required: ['command'],
        },
      },
    };
  }

  async execute(argumentsInJSON) {
    const { command } = JSON.parse(argumentsInJSON);
    try {
      return execSync(command, {
        shell: os.platform() === 'win32' ? 'cmd.exe' : '/bin/sh',
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      return err.stdout || err.stderr || err.message;
    }
  }
}
