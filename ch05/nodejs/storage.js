import fs from 'fs';
import path from 'path';

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
 * key 形如 "/offload/20240101_120000_0"，baseDir 下会创建对应子目录和文件。
 * 适合：多次会话间保留卸载内容。
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
