/**
 * semantic_search.js — 语义搜索工具
 *
 * 将语义搜索能力封装为 Agent 工具，让 LLM 可以自主调用。
 *
 * 搜索流程（两阶段）：
 *   1. Embedding：将 query 转换为向量
 *   2. 向量检索：从向量库召回 Top-K×2 候选
 *   3. Rerank（可选）：对候选文档精细排序
 *   4. 返回格式化结果
 */

export const TOOL_SEMANTIC_SEARCH = 'semantic_search';

export class SemanticSearchTool {
  /**
   * @param {object} embedService - HTTPEmbeddingService 实例
   * @param {object} vectorStore  - InMemoryVectorStore 实例
   * @param {object|null} [rerankService] - HTTPRerankService 实例（可选）
   */
  constructor(embedService, vectorStore, rerankService = null) {
    this.embedService = embedService;
    this.vectorStore = vectorStore;
    this.rerankService = rerankService;
  }

  name() {
    return TOOL_SEMANTIC_SEARCH;
  }

  info() {
    return {
      type: 'function',
      function: {
        name: TOOL_SEMANTIC_SEARCH,
        description: '在向量库中进行语义搜索，查找与查询相关的文档片段。当需要了解代码库中某个功能的实现、查找相关文档或代码片段时使用。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '搜索查询文本，例如："如何处理错误" 或 "error handling"',
            },
            top_k: {
              type: 'integer',
              description: '返回结果数量，默认为 5',
            },
          },
          required: ['query'],
        },
      },
    };
  }

  /**
   * 执行语义搜索
   * @param {string} argumentsInJSON
   * @returns {Promise<string>}
   */
  async execute(argumentsInJSON) {
    let params;
    try {
      params = JSON.parse(argumentsInJSON);
    } catch (err) {
      throw new Error(`Failed to parse arguments: ${err.message}`);
    }

    const { query, top_k: topK = 5 } = params;

    if (!query) throw new Error('query is required');

    // 1. 将 query 转换为向量
    const queryVector = await this.embedService.embed(query);

    // 2. 向量检索（召回 Top-K×2 以备重排序）
    const vectorResults = await this.vectorStore.search(queryVector, topK * 2);

    if (vectorResults.length === 0) {
      return '未找到相关结果';
    }

    // 3. 提取候选文档块
    const candidates = vectorResults.map((r) => r.chunk);

    // 4. 重排序（如果配置了 rerank 服务）
    let finalChunks;
    if (this.rerankService) {
      try {
        finalChunks = await this.rerankService.rerank(query, candidates);
      } catch {
        // 重排序失败，回退到向量检索原始结果
        finalChunks = candidates;
      }
    } else {
      finalChunks = candidates;
    }

    // 5. 截取 top_k 个结果
    finalChunks = finalChunks.slice(0, topK);

    // 6. 格式化结果
    return this.#formatResults(query, finalChunks, vectorResults.length);
  }

  #formatResults(query, chunks, totalCandidates) {
    let result = `语义搜索结果 (查询: ${query})\n`;
    result += `从 ${totalCandidates} 个候选中${this.rerankService ? '重排序后' : ''}返回前 ${chunks.length} 个结果：\n\n`;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      result += `--- 结果 ${i + 1} ---\n`;
      result += `文档: ${chunk.meta.documentId}\n`;
      result += `位置: 行 ${chunk.meta.startPos}-${chunk.meta.endPos}\n`;
      result += `内容:\n${chunk.content}\n\n`;
    }

    return result;
  }
}
