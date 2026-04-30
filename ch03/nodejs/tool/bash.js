import { execSync } from 'child_process';
import os from 'os';

export class BashTool {
  name() {
    return 'bash';
  }

  info() {
    return {
      type: 'function',
      function: {
        name: this.name(),
        description: 'Execute a shell command and return its combined stdout and stderr output. Use with caution.',
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

    if (isWindows) {
      return execSync(command, {
        shell: 'cmd.exe',
        encoding: 'utf-8',
        timeout: 30_000,
      });
    }

    return execSync(command, {
      shell: '/bin/sh',
      encoding: 'utf-8',
      timeout: 30_000,
    });
  }
}
