import fs from 'fs';
import path from 'path';
import os from 'os';
import process from 'process';

/**
 * Storage 接口约定（鸭子类型）：
 *   store(key: string, value: string): Promise<void>
 *   load(key: string): Promise<string>
 */

/**
 * MemoryStorage — 内存 KV 存储，进程退出后数据消失。
 * 适合：测试、本地单次会话。
 */
export class MemoryStorage {
  constructor() {
    this.data = new Map();
  }

  async store(key, value) {
    this.data.set(key, value);
  }

  async load(key) {
    return this.data.get(key) ?? '';
  }
}

/**
 * FileSystemStorage — 持久化到磁盘，每个 key 对应一个文件。
 * key 形如 "/memory/MEMORY.md" 或 "/offload/20240101_120000_0"。
 * baseDir 下会自动创建对应子目录和文件。
 */
export class FileSystemStorage {
  /**
   * @param {string} baseDir - 存储根目录，不存在则自动创建
   */
  constructor(baseDir) {
    this.baseDir = baseDir;
    fs.mkdirSync(baseDir, { recursive: true });
  }

  #filePath(key) {
    // key 已含 '/' 前缀，去掉后作为相对路径
    const rel = key.startsWith('/') ? key.slice(1) : key;
    return path.join(this.baseDir, rel);
  }

  async store(key, value) {
    const fp = this.#filePath(key);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, value, 'utf-8');
  }

  async load(key) {
    const fp = this.#filePath(key);
    try {
      return fs.readFileSync(fp, 'utf-8');
    } catch {
      return '';
    }
  }
}

/**
 * 返回全局记忆存储根目录：~/.babyagent
 */
export function getGlobalStorageDir() {
  return path.join(os.homedir(), '.babyagent');
}

/**
 * 返回工作区记忆存储根目录：{cwd}/.babyagent
 */
export function getWorkspaceStorageDir() {
  return path.join(process.cwd(), '.babyagent');
}
