/**
 * docker_bash.js — Docker 沙盒 bash 工具（第八章新增）
 *
 * 在 Docker 容器中隔离执行 bash 命令，保障本地环境安全。
 *
 * 核心特性：
 *   - Lazy Initialization：首次 execute() 时才启动/创建容器
 *   - 工作区隔离：每个工作区使用独立容器（容器名含项目名称）
 *   - 卷挂载：将项目目录挂载到容器的 /workspace
 *   - 优雅降级：容器启动失败会抛出错误（由 factory.js 兜底到普通 bash）
 *   - 保持运行：容器使用 sleep infinity 持续运行
 */

import { execSync, execFileSync } from 'child_process';
import path from 'path';

const DEFAULT_SANDBOX_IMAGE     = 'alpine:3.19';
const DEFAULT_SANDBOX_CONTAINER = 'babyagent-sandbox';

/**
 * 根据工作区目录生成唯一容器名
 * 例：/home/user/project-a → babyagent-sandbox-project-a
 * @param {string} workspaceDir
 * @returns {string}
 */
function generateContainerName(workspaceDir) {
  const projectName = path.basename(workspaceDir);
  if (!projectName || projectName === '.' || projectName === '/') {
    return DEFAULT_SANDBOX_CONTAINER;
  }
  return `${DEFAULT_SANDBOX_CONTAINER}-${projectName}`;
}

export class DockerBashTool {
  /**
   * @param {object} options
   * @param {string} [options.containerName]  - 容器名，为空则按 workspaceDir 自动生成
   * @param {string} options.workspaceDir     - 挂载到容器 /workspace 的宿主机目录
   * @param {string} [options.image]          - 容器镜像，默认 alpine:3.19
   */
  constructor({ containerName, workspaceDir, image } = {}) {
    this.workspaceDir  = workspaceDir || process.cwd();
    this.containerName = containerName || generateContainerName(this.workspaceDir);
    this.image         = image || DEFAULT_SANDBOX_IMAGE;

    // Lazy init 状态
    this._initialized = false;
    this._initError   = null;
    this._initPromise = null; // 确保并发调用时只启动一次
  }

  name() { return 'bash'; }

  info() {
    return {
      type: 'function',
      function: {
        name: this.name(),
        description: 'Execute a bash command in a Docker sandbox container (isolated environment).',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'The bash command to execute in the sandbox container.',
            },
          },
          required: ['command'],
        },
      },
    };
  }

  async execute(argumentsInJSON) {
    // Lazy 初始化：首次使用时启动容器
    await this.#ensureInitialized();

    if (this._initError) {
      throw new Error(`Failed to start sandbox container: ${this._initError.message}`);
    }

    const { command } = JSON.parse(argumentsInJSON);

    try {
      // docker exec <container> sh -c "<command>"
      const output = execFileSync('docker', [
        'exec',
        this.containerName,
        'sh', '-c', command,
      ], {
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output;
    } catch (err) {
      // docker exec 失败时，返回 stdout+stderr（与普通 BashTool 行为一致）
      return err.stdout || err.stderr || err.message;
    }
  }

  // ─── 内部方法 ────────────────────────────────────────────────

  /**
   * 确保容器已初始化（并发安全，只初始化一次）
   */
  async #ensureInitialized() {
    if (this._initialized) return;
    if (!this._initPromise) {
      this._initPromise = this.#startSandboxContainer()
        .then(() => {
          this._initialized = true;
        })
        .catch((err) => {
          this._initError = err;
          this._initialized = true; // 标记已尝试，避免重复初始化
        });
    }
    await this._initPromise;
  }

  /**
   * 启动或创建沙盒容器
   *
   * 优先尝试 start 已存在的容器；
   * 若不存在则 run 创建新容器。
   */
  async #startSandboxContainer() {
    // 1. 尝试启动已存在的容器
    try {
      execFileSync('docker', ['start', this.containerName], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return; // 容器已存在且启动成功
    } catch {
      // 容器不存在，继续创建
    }

    // 2. 创建新容器
    //    -d：后台运行
    //    --name：容器名
    //    --restart unless-stopped：宿主机重启后自动启动
    //    -v workspaceDir:/workspace:rw：挂载工作区
    //    -w /workspace：工作目录
    //    sleep infinity：保持容器运行
    try {
      execFileSync('docker', [
        'run', '-d',
        '--name', this.containerName,
        '--restart', 'unless-stopped',
        '-v', `${this.workspaceDir}:/workspace:rw`,
        '-w', '/workspace',
        this.image,
        'sleep', 'infinity',
      ], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      throw new Error(
        `Failed to create sandbox container '${this.containerName}': ${err.stderr || err.message}`,
      );
    }
  }
}
