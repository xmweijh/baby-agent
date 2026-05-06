/**
 * factory.js — bash 工具工厂（第八章新增）
 *
 * 自动检测 Docker 是否可用，智能选择工具实现：
 *   - Docker 可用 + 工作区目录非空 → DockerBashTool（沙盒隔离）
 *   - Docker 不可用 / 工作区目录为空 → BashTool（普通 shell）
 */

import { execFileSync } from 'child_process';
import { BashTool } from './bash.js';
import { DockerBashTool } from './docker_bash.js';

/**
 * 检测 Docker 守护进程是否运行
 * 使用 `docker ps` 作为探针：成功则 Docker 可用，失败则不可用
 * @returns {boolean}
 */
function checkDockerAvailable() {
  try {
    execFileSync('docker', ['ps'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 创建 bash 工具实例
 *
 * @param {string} [workspaceDir] - 工作区目录（DockerBashTool 挂载用），为空则降级到普通 BashTool
 * @returns {BashTool | DockerBashTool}
 */
export function createBashTool(workspaceDir) {
  if (!checkDockerAvailable()) {
    console.log('[Tool] Docker not available, using regular BashTool');
    return new BashTool();
  }
  if (!workspaceDir) {
    console.log('[Tool] Docker available but workspaceDir is empty, using regular BashTool');
    return new BashTool();
  }
  const tool = new DockerBashTool({ workspaceDir });
  console.log(`[Tool] Docker available, using DockerBashTool with container '${tool.containerName}'`);
  return tool;
}
