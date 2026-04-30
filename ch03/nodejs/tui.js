import readline from 'readline';
import {
  MessageTypeContent,
  MessageTypeError,
  MessageTypeReasoning,
  MessageTypeToolCall,
} from './vo.js';

const COLOR = {
  reset: '\x1b[0m',
  blue: '\x1b[36m',
  gray: '\x1b[90m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  white: '\x1b[37m',
  cyanBold: '\x1b[1;36m',
};

function colorize(color, text) {
  return `${color}${text}${COLOR.reset}`;
}

export class BabyAgentTUI {
  constructor(agent, modelName) {
    this.agent = agent;
    this.modelName = modelName;
    this.rl = null;
    this.abortController = null;
    this.isRunning = false;
    this.sessionClosed = false;

    this.currentReasoningOpen = false;
    this.currentAnswerOpen = false;
  }

  start() {
    this.renderWelcome();

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '>>> ',
      terminal: true,
    });

    this.rl.on('line', async (line) => {
      const query = line.trim();
      if (!query) {
        this.rl.prompt();
        return;
      }

      if (query === '/clear') {
        this.agent.resetSession();
        console.log(colorize(COLOR.yellow, '会话已清空（仅保留 system prompt）。'));
        this.rl.prompt();
        return;
      }

      if (this.isRunning) {
        console.log(colorize(COLOR.yellow, '模型响应中，请稍候。'));
        return;
      }

      await this.runTurn(query);
      if (!this.sessionClosed) {
        this.rl.prompt();
      }
    });

    this.rl.on('SIGINT', () => {
      if (this.isRunning && this.abortController) {
        console.log();
        console.log(colorize(COLOR.yellow, '正在取消当前流式输出...'));
        this.abortController.abort();
        return;
      }
      this.close();
    });

    this.rl.on('close', () => {
      this.sessionClosed = true;
      console.log();
      console.log(colorize(COLOR.gray, 'Bye.'));
      process.exit(0);
    });

    this.rl.prompt();
  }

  async runTurn(query) {
    this.isRunning = true;
    this.currentReasoningOpen = false;
    this.currentAnswerOpen = false;
    this.abortController = new AbortController();

    console.log();
    console.log(colorize(COLOR.white, `你: ${query}`));

    try {
      await this.agent.runStreaming(
        query,
        (event) => this.handleEvent(event),
        this.abortController.signal,
      );
      this.endOpenSections();
      console.log(colorize(COLOR.gray, '────────────────────────────────────────────────')); 
    } catch (err) {
      this.endOpenSections();
      if (this.abortController.signal.aborted) {
        console.log(colorize(COLOR.yellow, '已取消本轮输入。'));
      } else {
        console.log(colorize(COLOR.red, `错误: ${err.message}`));
      }
      console.log(colorize(COLOR.gray, '────────────────────────────────────────────────'));
    } finally {
      this.isRunning = false;
      this.abortController = null;
    }
  }

  handleEvent(event) {
    switch (event.type) {
      case MessageTypeReasoning:
        if (!this.currentReasoningOpen) {
          this.endAnswerSection();
          process.stdout.write(colorize(COLOR.gray, '推理: '));
          this.currentReasoningOpen = true;
        }
        process.stdout.write(colorize(COLOR.gray, event.reasoningContent));
        break;
      case MessageTypeContent:
        if (!this.currentAnswerOpen) {
          this.endReasoningSection();
          process.stdout.write(colorize(COLOR.cyanBold, '回答: '));
          this.currentAnswerOpen = true;
        }
        process.stdout.write(colorize(COLOR.white, event.content));
        break;
      case MessageTypeToolCall:
        this.endOpenSections();
        console.log(colorize(COLOR.yellow, `工具调用: ${event.toolCall.name}(${event.toolCall.arguments})`));
        break;
      case MessageTypeError:
        this.endOpenSections();
        console.log(colorize(COLOR.red, `错误: ${event.content}`));
        break;
      default:
        break;
    }
  }

  endReasoningSection() {
    if (this.currentReasoningOpen) {
      process.stdout.write('\n');
      this.currentReasoningOpen = false;
    }
  }

  endAnswerSection() {
    if (this.currentAnswerOpen) {
      process.stdout.write('\n');
      this.currentAnswerOpen = false;
    }
  }

  endOpenSections() {
    this.endReasoningSection();
    this.endAnswerSection();
  }

  renderWelcome() {
    console.log(colorize(COLOR.cyanBold, 'BabyAgent TUI (Node.js)'));
    console.log(colorize(COLOR.gray, '────────────────────────────────────────────────'));
    console.log(`欢迎使用，输入问题后回车。当前模型: ${this.modelName}`);
    console.log(colorize(COLOR.gray, '快捷键: Ctrl+C 取消当前流式；空闲时 Ctrl+C 退出'));
    console.log(colorize(COLOR.gray, '命令: /clear 清空会话'));
    console.log();
  }

  close() {
    if (this.rl) {
      this.rl.close();
    }
  }
}
