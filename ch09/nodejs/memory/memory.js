/**
 * memory.js — 两层记忆系统
 *
 * Memory 接口约定（鸭子类型）：
 *   toString(): string          — 返回注入 System Prompt 的记忆文本
 *   update(newMessages): Promise<void> — 根据本轮对话更新记忆
 *
 * MultiLevelMemory 实现两层记忆：
 *   - Global Memory   (~/.babyagent/memory/MEMORY.md)：跨项目、跨会话的用户偏好
 *   - Workspace Memory ({cwd}/.babyagent/memory/MEMORY.md)：当前项目的知识
 */

const MEMORY_KEY = '/memory/MEMORY.md';

const MEMORY_PROMPT_TEMPLATE = `### Global Memory
Here is the memory about the user among all conversations:
{global_memory}

### Workspace Memory
The memory of the current workspace is:
{workspace_memory}
`;

/**
 * MemoryContent — 记忆内容值对象
 */
export class MemoryContent {
  /**
   * @param {string} globalMemory
   * @param {string} workspaceMemory
   */
  constructor(globalMemory = '', workspaceMemory = '') {
    this.globalMemory = globalMemory;
    this.workspaceMemory = workspaceMemory;
  }

  /** 渲染为 System Prompt 中的记忆段落 */
  toString() {
    return MEMORY_PROMPT_TEMPLATE
      .replace('{global_memory}', this.globalMemory)
      .replace('{workspace_memory}', this.workspaceMemory);
  }
}

/**
 * MultiLevelMemory — 双层记忆实现
 *
 * @param {import('../storage.js').FileSystemStorage} globalStorage   - 全局记忆存储（~/.babyagent）
 * @param {import('../storage.js').FileSystemStorage} workspaceStorage - 工作区记忆存储（{cwd}/.babyagent）
 * @param {object} updater - 实现 update(oldMemory, newMessages) => Promise<MemoryContent> 的记忆更新器
 */
export class MultiLevelMemory {
  constructor(globalStorage, workspaceStorage, updater) {
    this.globalStorage = globalStorage;
    this.workspaceStorage = workspaceStorage;
    this.updater = updater;
    this.content = new MemoryContent(); // 延迟加载，load() 时填充
  }

  /**
   * 从磁盘加载记忆（应在 Agent 启动时调用）
   */
  async load() {
    const [globalMemory, workspaceMemory] = await Promise.all([
      this.globalStorage.load(MEMORY_KEY),
      this.workspaceStorage.load(MEMORY_KEY),
    ]);
    this.content = new MemoryContent(globalMemory, workspaceMemory);
  }

  /**
   * 返回注入 System Prompt 的记忆文本
   */
  toString() {
    return this.content.toString();
  }

  /**
   * 根据本轮对话消息更新记忆（调用 LLM 提取，然后持久化）
   * @param {object[]} newMessages - 本轮新增的对话消息
   */
  async update(newMessages) {
    if (!newMessages || newMessages.length === 0) return;

    const newContent = await this.updater.update(this.content, newMessages);

    // 持久化到磁盘
    await Promise.all([
      this.globalStorage.store(MEMORY_KEY, newContent.globalMemory),
      this.workspaceStorage.store(MEMORY_KEY, newContent.workspaceMemory),
    ]);

    // 更新内存中的 content
    this.content = newContent;
  }
}
