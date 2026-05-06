/**
 * LoadStorageTool — 让 LLM 按 key 取回被卸载的完整内容
 *
 * 与 OffloadPolicy 配合使用：
 *   1. OffloadPolicy 把长内容写入 storage，并在消息里留下提示：
 *      "（更多内容已卸载，如需查看全文请使用 load_storage(key="...") 工具）"
 *   2. LLM 看到提示后，调用 load_storage(key="...")
 *   3. 本工具从 storage 取出完整内容返回给 LLM
 */
export class LoadStorageTool {
  /**
   * @param {import('../storage.js').MemoryStorage} storage
   */
  constructor(storage) {
    this.storage = storage;
  }

  name() { return 'load_storage'; }

  info() {
    return {
      type: 'function',
      function: {
        name: this.name(),
        description: 'Load previously offloaded content from storage by key.',
        parameters: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: 'The storage key provided in the offload notice.',
            },
          },
          required: ['key'],
        },
      },
    };
  }

  async execute(argumentsInJSON) {
    const { key } = JSON.parse(argumentsInJSON);
    return this.storage.load(key);
  }
}
