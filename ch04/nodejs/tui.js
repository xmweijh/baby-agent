import readline from 'readline';
import {
  MessageTypeContent,
  MessageTypeError,
  MessageTypeReasoning,
  MessageTypeToolCall,
} from './vo.js';

const C = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  white: '\x1b[37m',
  cyan: '\x1b[1;36m',
};
const col = (c, t) => `${c}${t}${C.reset}`;

export class BabyAgentTUI {
  constructor(agent, modelName) {
    this.agent = agent;
    this.modelName = modelName;
    this.rl = null;
    this.abortController = null;
    this.isRunning = false;
    this.reasoningOpen = false;
    this.answerOpen = false;
  }

  start() {
    this.#renderWelcome();
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '>>> ',
      terminal: true,
    });

    this.rl.on('line', async (line) => {
      const query = line.trim();
      if (!query) { this.rl.prompt(); return; }
      if (query === '/clear') {
        this.agent.resetSession();
        console.log(col(C.yellow, '会话已清空。'));
        this.rl.prompt();
        return;
      }
      if (this.isRunning) {
        console.log(col(C.yellow, '模型响应中，请稍候。'));
        return;
      }
      await this.#runTurn(query);
      if (this.rl) this.rl.prompt();
    });

    this.rl.on('SIGINT', () => {
      if (this.isRunning && this.abortController) {
        process.stdout.write('\n');
        console.log(col(C.yellow, '正在取消...'));
        this.abortController.abort();
        return;
      }
      console.log(); console.log(col(C.gray, 'Bye.'));
      process.exit(0);
    });

    this.rl.on('close', () => {
      console.log(); console.log(col(C.gray, 'Bye.'));
      process.exit(0);
    });

    this.rl.prompt();
  }

  async #runTurn(query) {
    this.isRunning = true;
    this.reasoningOpen = false;
    this.answerOpen = false;
    this.abortController = new AbortController();

    console.log();
    console.log(col(C.white, `你: ${query}`));

    try {
      await this.agent.runStreaming(query, (e) => this.#handleEvent(e), this.abortController.signal);
      this.#endSections();
      console.log(col(C.gray, '────────────────────────────────────────────────'));
    } catch (err) {
      this.#endSections();
      if (this.abortController.signal.aborted) {
        console.log(col(C.yellow, '已取消本轮输入。'));
      } else {
        console.log(col(C.red, `错误: ${err.message}`));
      }
      console.log(col(C.gray, '────────────────────────────────────────────────'));
    } finally {
      this.isRunning = false;
      this.abortController = null;
    }
  }

  #handleEvent(event) {
    switch (event.type) {
      case MessageTypeReasoning:
        if (!this.reasoningOpen) {
          this.#endAnswer();
          process.stdout.write(col(C.gray, '推理: '));
          this.reasoningOpen = true;
        }
        process.stdout.write(col(C.gray, event.reasoningContent));
        break;
      case MessageTypeContent:
        if (!this.answerOpen) {
          this.#endReasoning();
          process.stdout.write(col(C.cyan, '回答: '));
          this.answerOpen = true;
        }
        process.stdout.write(col(C.white, event.content));
        break;
      case MessageTypeToolCall:
        this.#endSections();
        console.log(col(C.yellow, `工具调用: ${event.toolCall.name}(${event.toolCall.arguments})`));
        break;
      case MessageTypeError:
        this.#endSections();
        console.log(col(C.red, `错误: ${event.content}`));
        break;
      default: break;
    }
  }

  #endReasoning() {
    if (this.reasoningOpen) { process.stdout.write('\n'); this.reasoningOpen = false; }
  }
  #endAnswer() {
    if (this.answerOpen) { process.stdout.write('\n'); this.answerOpen = false; }
  }
  #endSections() { this.#endReasoning(); this.#endAnswer(); }

  #renderWelcome() {
    console.log(col(C.cyan, 'BabyAgent TUI — ch04 (MCP)'));
    console.log(col(C.gray, '────────────────────────────────────────────────'));
    console.log(`欢迎使用，输入问题后回车。当前模型: ${this.modelName}`);
    console.log(col(C.gray, '快捷键: Ctrl+C 取消流式；空闲时退出'));
    console.log(col(C.gray, '命令: /clear 清空会话'));
    console.log();
  }
}
