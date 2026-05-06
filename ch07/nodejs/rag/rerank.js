/**
 * rerank.js — HTTP Rerank 服务
 *
 * 调用兼容格式的 Rerank API，对向量检索召回的候选文档进行精细排序。
 *
 * 两阶段检索流程：
 *   向量检索（召回 Top-50）→ Rerank（精排 Top-10）
 */

export class HTTPRerankService {
  /**
   * @param {object} config
   * @param {string} config.apiKey
   * @param {string} config.baseURL
   * @param {string} [config.model='rerank']
   */
  constructor({ apiKey, baseURL, model = 'rerank' }) {
    this.apiKey = apiKey;
    this.baseURL = baseURL.replace(/\/$/, '');
    this.model = model;
  }

  /**
   * 对候选文档进行重排序
   * @param {string} query - 查询文本
   * @param {Array<{content: string, meta: object}>} candidates - 候选文档块数组
   * @returns {Promise<Array<{content: string, meta: object}>>} 重排序后的文档块（按相关性降序）
   */
  async rerank(query, candidates) {
    if (candidates.length === 0) return candidates;

    const documents = candidates.map((c) => c.content);

    const response = await fetch(`${this.baseURL}/rerank`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents,
        top_n: candidates.length,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Rerank API error ${response.status}: ${text}`);
    }

    const data = await response.json();

    if (!data.results || data.results.length === 0) {
      return candidates;
    }

    // 根据 rerank 结果的顺序重新组织候选文档
    return data.results.map((item) => candidates[item.index]);
  }
}

/**
 * 默认配置
 * @param {string} apiKey
 */
export function defaultRerankConfig(apiKey) {
  return {
    apiKey,
    baseURL: '',
    model: 'rerank',
  };
}
