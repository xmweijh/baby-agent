import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * 把 config 的 args 里的 ${workspaceFolder} 替换为实际路径
 */
function replacePlaceholders(serverConfig, workspaceFolder) {
  const result = { ...serverConfig };
  if (result.args) {
    result.args = result.args.map((arg) =>
      arg.replace('${workspaceFolder}', workspaceFolder),
    );
  }
  return result;
}

/**
 * McpClient — 封装对单个 MCP Server 的连接和工具管理
 *
 * 支持两种传输方式：
 *   - stdio：通过子进程 stdin/stdout 通信（本地 MCP 服务器，如 server-filesystem）
 *   - http：通过 HTTP/SSE 通信（远程 MCP 服务器）
 *
 * 工具命名策略（避免不同 MCP Server 工具名冲突）：
 *   给 LLM 看的名字    → babyagent_mcp__{serverName}__{toolName}
 *   给 MCP Server 看的 → 原始 toolName
 */
export class McpClient {
  /**
   * @param {string} name - server 名称（来自 mcp-server.json 的 key）
   * @param {object} serverConfig - { command?, args?, env?, url?, headers? }
   * @param {string} workspaceFolder - 用于替换 ${workspaceFolder} 占位符
   */
  constructor(name, serverConfig, workspaceFolder) {
    this.serverName = name;
    this.serverConfig = replacePlaceholders(serverConfig, workspaceFolder);
    this.client = new Client({ name: 'babyagent-mcp-client', version: '1.0.0' });
    this.connected = false;
    this.mcpTools = [];
  }

  /**
   * 建立与 MCP Server 的连接（幂等：已连接则跳过）
   */
  async #connect() {
    if (this.connected) return;

    let transport;
    if (this.serverConfig.command) {
      // stdio 模式：启动子进程，通过 stdin/stdout 收发 JSON-RPC 消息
      const env = { ...process.env };
      if (this.serverConfig.env) {
        Object.assign(env, this.serverConfig.env);
      }
      transport = new StdioClientTransport({
        command: this.serverConfig.command,
        args: this.serverConfig.args ?? [],
        env,
      });
    } else if (this.serverConfig.url) {
      // HTTP 模式：使用 Streamable HTTP Transport
      transport = new StreamableHTTPClientTransport(
        new URL(this.serverConfig.url),
        { headers: this.serverConfig.headers ?? {} },
      );
    } else {
      throw new Error(`MCP server "${this.serverName}" has no command or url configured`);
    }

    await this.client.connect(transport);
    this.connected = true;
  }

  /**
   * 连接 Server 并拉取最新工具列表，封装为 McpTool 实例数组
   */
  async refreshTools() {
    await this.#connect();

    const result = await this.client.listTools();
    this.mcpTools = (result.tools ?? []).map(
      (tool) => new McpTool(this.serverName, tool, this),
    );
  }

  /**
   * 返回所有已加载的 McpTool 实例
   * @returns {McpTool[]}
   */
  getTools() {
    return this.mcpTools;
  }

  /**
   * 调用 MCP Server 上的工具（原始 toolName，非命名空间化名）
   * @param {string} toolName
   * @param {string} argumentsInJSON
   * @returns {Promise<string>}
   */
  async callTool(toolName, argumentsInJSON) {
    await this.#connect();

    const result = await this.client.callTool({
      name: toolName,
      arguments: JSON.parse(argumentsInJSON),
    });

    // MCP 结果是 content 数组，取出所有 text 类型的内容拼接返回
    if (!result.content || result.content.length === 0) {
      return '';
    }
    return result.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');
  }
}

/**
 * McpTool — 封装单个 MCP 工具，实现与 native tool 相同的三方法接口
 *
 * name()    → 给 Agent/LLM 路由用的命名空间化名称
 * info()    → OpenAI Function Calling 格式的工具声明
 * execute() → 调用 MCP Server 执行工具
 */
export class McpTool {
  /**
   * @param {string} serverName
   * @param {{ name: string, description: string, inputSchema: object }} mcpToolDef
   * @param {McpClient} mcpClient
   */
  constructor(serverName, mcpToolDef, mcpClient) {
    this.serverName = serverName;
    this.toolDef = mcpToolDef;
    this.mcpClient = mcpClient;
  }

  /**
   * 给 LLM 看的命名空间化名称
   * 格式：babyagent_mcp__{serverName}__{toolName}
   */
  name() {
    return `babyagent_mcp__${this.serverName}__${this.toolDef.name}`;
  }

  /**
   * 给 OpenAI API 用的工具声明对象
   */
  info() {
    return {
      type: 'function',
      function: {
        name: this.name(),
        description: this.toolDef.description ?? '',
        parameters: this.toolDef.inputSchema ?? { type: 'object', properties: {} },
      },
    };
  }

  /**
   * 执行工具：把命名空间化名转回原始名再发给 MCP Server
   */
  async execute(argumentsInJSON) {
    return this.mcpClient.callTool(this.toolDef.name, argumentsInJSON);
  }
}

/**
 * 从 mcp-server.json 加载所有 MCP Server 配置
 *
 * @param {string} configPath  - 配置文件路径
 * @param {string} workspaceFolder - 用于替换占位符
 * @returns {Promise<McpClient[]>}
 */
export async function loadMcpClients(configPath, workspaceFolder) {
  const fs = await import('fs');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch {
    // 配置文件不存在，返回空列表
    return [];
  }

  const serverMap = JSON.parse(raw);
  const clients = [];

  for (const [name, config] of Object.entries(serverMap)) {
    const client = new McpClient(name, config, workspaceFolder);
    try {
      await client.refreshTools();
      console.error(`[MCP] Server "${name}" loaded ${client.getTools().length} tools`);
      clients.push(client);
    } catch (err) {
      console.error(`[MCP] Failed to load server "${name}": ${err.message}`);
    }
  }

  return clients;
}
