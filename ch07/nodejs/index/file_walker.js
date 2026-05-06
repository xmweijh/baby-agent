/**
 * file_walker.js — 文件遍历器
 *
 * 递归遍历目录，找到所有可索引的文本文件。
 * 自动排除常见的非文本目录（.git、node_modules 等）。
 */

import { readdir, stat } from 'fs/promises';
import { join, extname, basename } from 'path';

// 默认排除的目录
const DEFAULT_EXCLUDE_DIRS = new Set([
  '.git', '.idea', '.vscode', 'node_modules',
  'vendor', 'dist', 'build', 'target', 'bin',
  '.venv', 'venv', '__pycache__', '.cache',
  '.next', '.nuxt', 'coverage', '.nyc_output',
]);

// 默认支持的文件扩展名
const DEFAULT_EXTENSIONS = new Set([
  '.go', '.js', '.ts', '.tsx', '.jsx',
  '.py', '.java', '.c', '.cpp', '.h', '.hpp',
  '.rs', '.rb', '.php', '.cs', '.swift',
  '.kt', '.scala', '.sh', '.bash', '.zsh',
  '.md', '.txt', '.json', '.yaml', '.yml',
  '.toml', '.xml', '.html', '.css', '.scss',
  '.sql', '.graphql', '.proto',
]);

export class FileWalker {
  constructor() {
    this.excludeDirs = new Set(DEFAULT_EXCLUDE_DIRS);
    this.extensions = new Set(DEFAULT_EXTENSIONS);
  }

  /**
   * 添加需要排除的目录
   * @param {string[]} dirs
   * @returns {FileWalker}
   */
  withExcludeDirs(dirs) {
    for (const d of dirs) this.excludeDirs.add(d);
    return this;
  }

  /**
   * 添加支持的文件扩展名
   * @param {string[]} exts
   * @returns {FileWalker}
   */
  withExtensions(exts) {
    for (const e of exts) this.extensions.add(e);
    return this;
  }

  /**
   * 遍历指定路径，返回所有文本文件的绝对路径列表
   * @param {string} rootPath
   * @returns {Promise<string[]>}
   */
  async walk(rootPath) {
    const files = [];
    await this.#walkDir(rootPath, files);
    return files;
  }

  async #walkDir(dirPath, files) {
    let entries;
    try {
      entries = await readdir(dirPath);
    } catch {
      return; // 无法读取目录，跳过
    }

    for (const entry of entries) {
      const fullPath = join(dirPath, entry);

      let info;
      try {
        info = await stat(fullPath);
      } catch {
        continue;
      }

      if (info.isDirectory()) {
        // 检查是否在排除列表中
        if (!this.excludeDirs.has(basename(fullPath))) {
          await this.#walkDir(fullPath, files);
        }
      } else if (info.isFile()) {
        const ext = extname(entry).toLowerCase();
        if (this.extensions.has(ext)) {
          files.push(fullPath);
        }
      }
    }
  }

  /**
   * 检查文件是否是支持的文本文件
   * @param {string} filePath
   * @returns {boolean}
   */
  isTextFile(filePath) {
    const ext = extname(filePath).toLowerCase();
    return this.extensions.has(ext);
  }

  /**
   * 检查目录是否应该被排除
   * @param {string} dirName
   * @returns {boolean}
   */
  shouldExcludeDir(dirName) {
    return this.excludeDirs.has(dirName);
  }
}
