/**
 * embedding.js — HTTP Embedding 服务
 *
 * 调用兼容 OpenAI 格式的 Embedding API，将文本转换为高维向量。
 *
 * 默认配置：
 *   - model: 'embedding'
 *   - dimensions: 512
 */

export class HTTPEmbeddingService {
  /**
   * @param {object} config
   * @param {string} config.apiKey
   * @param {string} config.baseURL
   * @param {string} [config.model='embedding']
   * @param {number} [config.dimensions=512]
   */
  constructor({ apiKey, baseURL, model = 'embedding', dimensions = 512 }) {
    this.apiKey = apiKey;
    this.baseURL = baseURL.replace(/\/$/, ''); // 去除末尾斜杠
    this.model = model;
    this.dimensions = dimensions;
  }

  /**
   * 将文本转换为向量
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  async embed(text) {
    const body = {
      model: this.model,
      input: text,
    };

    // 只有非零维度才传递 dimensions 参数
    if (this.dimensions > 0) {
      body.dimensions = this.dimensions;
    }

    const response = await fetch(`${this.baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Embedding API error ${response.status}: ${text}`);
    }

    const data = await response.json();

    if (!data.data || data.data.length === 0) {
      throw new Error('Empty embedding response');
    }

    return data.data[0].embedding;
  }
}

/**
 * 默认配置
 * @param {string} apiKey
 * @returns {object}
 */
export function defaultEmbeddingConfig(apiKey) {
  return {
    apiKey,
    baseURL: '',
    model: 'embedding',
    dimensions: 512,
  };
}
