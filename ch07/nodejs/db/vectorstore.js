/**
 * vectorstore.js — 内存向量存储
 *
 * 用纯 JavaScript 实现一个内存版向量存储，方便本地开发和学习使用。
 * 无需安装 PostgreSQL，直接在内存中完成向量相似度检索。
 *
 * 生产环境建议替换为 pgvector（参考 Go 版本 ch07/db/pgvector.go）。
 *
 * 接口与 Go 版本的 VectorStore 一致：
 *   - insertBatch(vectorPoints)
 *   - search(queryVector, limit)
 *   - deleteByDocument(documentId)
 *   - getDocumentIndexedTime(documentId)
 *   - clear()
 *
 * 向量相似度：余弦相似度（Cosine Similarity）
 */

// ─── 余弦相似度 ───────────────────────────────────────────────────────────────

/**
 * 计算两个向量的余弦相似度
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} 相似度，范围 [-1, 1]，值越大越相似
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── InMemoryVectorStore ──────────────────────────────────────────────────────

/**
 * 内存向量存储
 *
 * 存储结构：
 *   points: Array<{ vector, chunk: { content, meta: { documentId, startPos, endPos } }, indexedAt }>
 *   documentTimes: Map<documentId, Date>  // 每个文档最后索引时间
 */
export class InMemoryVectorStore {
  constructor() {
    /** @type {Array<{vector: number[], chunk: object, indexedAt: Date}>} */
    this.points = [];

    /** @type {Map<string, Date>} documentId -> indexedAt */
    this.documentTimes = new Map();
  }

  /**
   * 批量插入向量点
   * @param {Array<{vector: number[], chunk: {content: string, meta: {documentId: string, startPos: number, endPos: number}}}>} vectorPoints
   */
  async insertBatch(vectorPoints) {
    const now = new Date();

    for (const vp of vectorPoints) {
      this.points.push({
        vector: vp.vector,
        chunk: vp.chunk,
        indexedAt: now,
      });

      // 更新文档索引时间（取最新的）
      const docId = vp.chunk.meta.documentId;
      const existing = this.documentTimes.get(docId);
      if (!existing || now > existing) {
        this.documentTimes.set(docId, now);
      }
    }
  }

  /**
   * 向量相似度搜索
   * @param {number[]} queryVector
   * @param {number} limit
   * @returns {Promise<Array<{vector, chunk, score}>>}
   */
  async search(queryVector, limit) {
    if (this.points.length === 0) return [];

    // 计算所有点的余弦相似度
    const scored = this.points.map((p) => ({
      vector: p.vector,
      chunk: p.chunk,
      score: cosineSimilarity(queryVector, p.vector),
    }));

    // 按相似度降序排序，取前 limit 个
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * 删除指定文档的所有向量
   * @param {string} documentId
   */
  async deleteByDocument(documentId) {
    this.points = this.points.filter((p) => p.chunk.meta.documentId !== documentId);
    this.documentTimes.delete(documentId);
  }

  /**
   * 获取文档的索引时间（用于增量更新去重）
   * @param {string} documentId
   * @returns {Promise<Date|null>} null 表示文档未索引
   */
  async getDocumentIndexedTime(documentId) {
    return this.documentTimes.get(documentId) ?? null;
  }

  /**
   * 清空所有向量数据
   */
  async clear() {
    this.points = [];
    this.documentTimes.clear();
  }

  /**
   * 关闭（内存版本无需操作）
   */
  async close() {}

  /**
   * 获取统计信息
   * @returns {{totalPoints: number, totalDocuments: number}}
   */
  stats() {
    return {
      totalPoints: this.points.length,
      totalDocuments: this.documentTimes.size,
    };
  }
}
