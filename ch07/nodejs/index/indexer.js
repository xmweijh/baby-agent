/**
 * indexer.js — 代码仓库索引器
 *
 * 将代码仓库的文本文件索引到向量存储中，支持：
 *   - 增量更新（通过文件修改时间去重）
 *   - 并发索引（Promise.allSettled + 并发限制）
 *
 * 索引流程：
 *   文件遍历 → 检查去重 → 文本切分 → Embedding → 批量插入
 */

import { readFile, stat } from 'fs/promises';
import { relative } from 'path';
import { FileWalker } from './file_walker.js';
import { newChunker } from '../rag/chunker.js';

// 索引操作类型
export const IndexAction = {
  NEW: 'new',
  SKIP: 'skip',
  REINDEX: 'reindex',
};

export class Indexer {
  /**
   * @param {object} config
   * @param {string} config.rootPath - 仓库根目录
   * @param {string} [config.chunkerType='line'] - 切分类型
   * @param {number} [config.maxLines=100] - 每块最大行数
   * @param {number} [config.maxChars=2000] - 每块最大字符数
   * @param {object} vectorStore - VectorStore 实例
   * @param {object} embedService - EmbeddingService 实例
   */
  constructor(config, vectorStore, embedService) {
    this.rootPath = config.rootPath;
    this.fileWalker = new FileWalker();
    this.chunker = newChunker(config.chunkerType, config.maxLines, config.maxChars);
    this.vectorStore = vectorStore;
    this.embedService = embedService;
  }

  /**
   * 串行索引整个仓库
   * @returns {Promise<IndexResult>}
   */
  async index() {
    const startTime = Date.now();
    const files = await this.fileWalker.walk(this.rootPath);

    const result = new IndexResult(files.length);

    for (const filePath of files) {
      try {
        const fileResult = await this.#indexFile(filePath);
        result.totalChunks += fileResult.chunks;
        this.#updateStats(result, fileResult.action);
      } catch (err) {
        result.failedFiles++;
        result.errors.push(new Error(`${filePath}: ${err.message}`));
      }
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  /**
   * 并发索引整个仓库
   * @param {number} [concurrency=10] - 并发度
   * @returns {Promise<IndexResult>}
   */
  async indexConcurrent(concurrency = 10) {
    const startTime = Date.now();
    const files = await this.fileWalker.walk(this.rootPath);

    const result = new IndexResult(files.length);
    const mutex = { lock: false }; // 简单互斥（JS 单线程，但 await 会让出）

    // 分批并发处理
    for (let i = 0; i < files.length; i += concurrency) {
      const batch = files.slice(i, i + concurrency);
      const settled = await Promise.allSettled(
        batch.map((filePath) => this.#indexFile(filePath))
      );

      for (let j = 0; j < settled.length; j++) {
        const item = settled[j];
        if (item.status === 'rejected') {
          result.failedFiles++;
          result.errors.push(new Error(`${batch[j]}: ${item.reason?.message ?? item.reason}`));
        } else {
          result.totalChunks += item.value.chunks;
          this.#updateStats(result, item.value.action);
        }
      }
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  /**
   * 索引单个文件（含增量去重逻辑）
   * @param {string} filePath
   * @returns {Promise<{chunks: number, action: string}>}
   */
  async #indexFile(filePath) {
    // 转换为相对路径作为文档 ID
    const relPath = relative(this.rootPath, filePath);

    // 获取文件信息（修改时间）
    const fileInfo = await stat(filePath);
    const modTime = fileInfo.mtime;

    // 检查是否已索引
    const indexedTime = await this.vectorStore.getDocumentIndexedTime(relPath);

    if (indexedTime !== null) {
      // 文件未修改，跳过
      if (modTime <= indexedTime) {
        return { chunks: 0, action: IndexAction.SKIP };
      }
      // 文件已修改，删除旧记录
      await this.vectorStore.deleteByDocument(relPath);
    }

    // 读取文件内容
    const content = await readFile(filePath, 'utf-8');

    // 切分文本
    const chunks = this.chunker.chunk(relPath, content);
    if (chunks.length === 0) {
      return { chunks: 0, action: IndexAction.SKIP };
    }

    // 并发获取向量嵌入
    const vectorPoints = await this.#embedChunks(chunks);

    // 批量插入数据库
    await this.vectorStore.insertBatch(vectorPoints);

    const action = indexedTime !== null ? IndexAction.REINDEX : IndexAction.NEW;
    return { chunks: chunks.length, action };
  }

  /**
   * 并发获取所有 chunks 的向量嵌入
   * @param {Array} chunks
   * @returns {Promise<Array<{vector, chunk}>>}
   */
  async #embedChunks(chunks) {
    const results = await Promise.all(
      chunks.map(async (chunk) => {
        const vector = await this.embedService.embed(chunk.content);
        return { vector, chunk };
      })
    );
    return results;
  }

  /**
   * 更新统计信息
   */
  #updateStats(result, action) {
    switch (action) {
      case IndexAction.SKIP:
        result.skippedFiles++;
        break;
      case IndexAction.REINDEX:
        result.reindexedFiles++;
        result.successFiles++;
        break;
      default:
        result.successFiles++;
    }
  }

  /**
   * 搜索索引
   * @param {string} query
   * @param {number} limit
   */
  async search(query, limit = 5) {
    const queryVector = await this.embedService.embed(query);
    return this.vectorStore.search(queryVector, limit);
  }

  /**
   * 清空索引
   */
  async clear() {
    await this.vectorStore.clear();
  }

  /**
   * 关闭
   */
  async close() {
    await this.vectorStore.close();
  }
}

// ─── IndexResult ──────────────────────────────────────────────────────────────

export class IndexResult {
  constructor(totalFiles) {
    this.totalFiles = totalFiles;
    this.successFiles = 0;
    this.failedFiles = 0;
    this.skippedFiles = 0;
    this.reindexedFiles = 0;
    this.totalChunks = 0;
    this.duration = 0; // ms
    /** @type {Error[]} */
    this.errors = [];
  }

  toString() {
    const lines = [
      `索引完成：${this.totalFiles} 个文件，耗时 ${this.duration}ms`,
      `  新建: ${this.successFiles - this.reindexedFiles}`,
      `  重建: ${this.reindexedFiles}`,
      `  跳过: ${this.skippedFiles}`,
      `  失败: ${this.failedFiles}`,
      `  总块数: ${this.totalChunks}`,
    ];
    if (this.errors.length > 0) {
      lines.push('  错误:');
      for (const e of this.errors.slice(0, 5)) {
        lines.push(`    - ${e.message}`);
      }
      if (this.errors.length > 5) {
        lines.push(`    ... 还有 ${this.errors.length - 5} 个错误`);
      }
    }
    return lines.join('\n');
  }
}
