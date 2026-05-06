/**
 * tui.js — 命令行终端 UI（第九章版本，继承第八章）
 *
 * 相较于第七章，本章新增：
 *   1. 工具确认框（ToolConfirmBox）：在执行敏感工具前弹出交互式确认框
 *      - 三个选项：允许 / 拒绝 / 始终允许
 *      - 上下方向键选择，Enter 确认，Esc 拒绝
 *   2. stateAwaitingConfirmation：等待用户确认的 TUI 状态
 *   3. ESC 取消改进：在确认状态下 ESC 发送拒绝而非取消整轮
 *   4. askConfirm()：返回 Promise，让 Agent 能等待用户确认结果
 *
 * Node.js 中没有 Bubble Tea 这样的 TUI 框架，采用原生 readline + raw mode
 * 来实现方向键导航和确认框交互。
 */

import readline from 'readline';
import {
  MessageTypeContent,
  MessageTypeError,
  MessageTypeMemory,
  MessageTypePolicy,
  MessageTypeReasoning,
  MessageTypeToolCall,
  MessageTypeToolConfirm,
  ConfirmationAction,
} from './vo.js';

// ── 终端颜色 ──────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  gray:   '\x1b[90m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  white:  '\x1b[37m',
  cyan:   '\x1b[1;36m',
  green:  '\x1b[32m',
  purple: '\x1b[35m',
  blue:   '\x1b[34m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
};
const col = (c, t) => `${c}${t}${C.reset}`;

// ── 确认框渲染 ────────────────────────────────────────────────

const CONFIRM_OPTIONS = [
  { label: '允许',    action: ConfirmationAction.allow },
  { label: '拒绝',    action: ConfirmationAction.reject },
  { label: '始终允许', action: ConfirmationAction.alwaysAllow },
];

/**
 * 渲染确认框到 stdout
 * @param {string} toolName   - 工具名
 * @param {string} args       - 工具参数 JSON
 * @param {number} selectedIdx - 当前高亮选项索引
 */
function renderConfirmBox(toolName, args, selectedIdx) {
  const lines = [
    col(C.bold + C.yellow, '┌─── 工具确认 ────────────────────────────────────┐'),
    col(C.yellow, `│ 工具: ${toolName}`),
    col(C.gray,   `│ 参数: ${args.slice(0, 60)}${args.length > 60 ? '...' : ''}`),
    col(C.yellow, '│'),
  ];

  for (let i = 0; i < CONFIRM_OPTIONS.length; i++) {
    const opt = CONFIRM_OPTIONS[i];
    if (i === selectedIdx) {
      lines.push(col(C.cyan, `│   ▶ ${opt.label}`));
    } else {
      lines.push(col(C.gray, `│     ${opt.label}`));
    }
  }

  lines.push(col(C.bold + C.yellow, '└────────────────────────────────────────────────┘'));
  lines.push(col(C.gray, '  ↑↓ 选择  Enter 确认  Esc 拒绝'));

  // 先清屏已有确认框（如果有），再输出新内容
  process.stdout.write('\n' + lines.join('\n') + '\n');
}

// ── TUI 主类 ──────────────────────────────────────────────────

export class BabyAgentTUI {
  constructor(agent, modelName) {
    this.agent     = agent;
    this.modelName = modelName;
    this.rl        = null;

    // 流控状态
    this.isRunning        = false;
    this.abortController  = null;
    this.reasoningOpen    = false;
    this.answerOpen       = false;

    // 确认框状态（第八章新增）
    this.awaitingConfirm  = false;
    this.confirmResolve   = null; // Promise resolve 函数
    this.confirmSelectedIdx = 0;  // 当前选中的确认选项索引
    this.confirmToolName  = '';
    this.confirmArgs      = '';
  }

  start() {
    this.#renderWelcome();
    this.rl = readline.createInterface({
      input:    process.stdin,
      output:   process.stdout,
      prompt:   '>>> ',
      terminal: true,
    });

    this.rl.on('line', async (line) => {
      // 确认状态下忽略普通输入（通过 raw mode 处理方向键/Enter）
      if (this.awaitingConfirm) return;

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

    // 处理 Ctrl+C（SIGINT）
    this.rl.on('SIGINT', () => {
      if (this.awaitingConfirm) {
        // 确认状态下 Ctrl+C = 拒绝
        this.#resolveConfirm(ConfirmationAction.reject);
        return;
      }
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

    // 开启 raw mode 以接收方向键、ESC 等特殊按键
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.on('data', (buf) => this.#handleRawKey(buf));

    this.rl.prompt();
  }

  // ── 核心对话轮次 ──────────────────────────────────────────────

  async #runTurn(query) {
    this.isRunning       = true;
    this.reasoningOpen   = false;
    this.answerOpen      = false;
    this.abortController = new AbortController();

    console.log();
    console.log(col(C.white, `你: ${query}`));

    try {
      await this.agent.runStreaming(
        query,
        (e) => this.#handleEvent(e),
        this.abortController.signal,
        () => this.#askConfirm(), // 第八章：传入确认回调
      );
      this.#endSections();
      console.log(col(C.gray, '────────────────────────────────────────────────'));
    } catch (err) {
      this.#endSections();
      if (this.abortController?.signal.aborted) {
        console.log(col(C.yellow, '用户取消了 agent loop，消息已保留。'));
      } else {
        console.log(col(C.red, `错误: ${err.message}`));
      }
      console.log(col(C.gray, '────────────────────────────────────────────────'));
    } finally {
      this.isRunning = false;
      this.abortController = null;
    }
  }

  // ── 确认框交互（第八章核心）──────────────────────────────────

  /**
   * 显示确认框，返回 Promise<ConfirmationAction>
   * Agent.runStreaming 的 askConfirm 回调会 await 此 Promise。
   */
  #askConfirm() {
    return new Promise((resolve) => {
      this.awaitingConfirm     = true;
      this.confirmResolve      = resolve;
      this.confirmSelectedIdx  = 0;
      // 确认框的渲染在 handleEvent(MessageTypeToolConfirm) 时已完成
    });
  }

  /**
   * 确认框选择结果：resolve Promise 并清理状态
   * @param {string} action - ConfirmationAction.*
   */
  #resolveConfirm(action) {
    if (!this.awaitingConfirm) return;
    this.awaitingConfirm = false;
    const resolve = this.confirmResolve;
    this.confirmResolve = null;

    // 打印用户的选择
    const label = CONFIRM_OPTIONS.find((o) => o.action === action)?.label ?? action;
    console.log(col(action === ConfirmationAction.reject ? C.red : C.green, `> ${label}`));
    console.log();

    resolve(action);
  }

  // ── 原始键处理（方向键、Enter、ESC）─────────────────────────

  /**
   * 处理 raw mode 下的按键
   * 只在确认状态下拦截上下/Enter/ESC；其他状态交给 readline 处理。
   */
  #handleRawKey(buf) {
    const key = buf.toString();

    if (this.awaitingConfirm) {
      // 上方向键
      if (key === '\x1b[A') {
        this.confirmSelectedIdx = (this.confirmSelectedIdx - 1 + CONFIRM_OPTIONS.length) % CONFIRM_OPTIONS.length;
        this.#rerenderConfirmBox();
        return;
      }
      // 下方向键
      if (key === '\x1b[B') {
        this.confirmSelectedIdx = (this.confirmSelectedIdx + 1) % CONFIRM_OPTIONS.length;
        this.#rerenderConfirmBox();
        return;
      }
      // Enter（\r 或 \n）
      if (key === '\r' || key === '\n') {
        const action = CONFIRM_OPTIONS[this.confirmSelectedIdx].action;
        this.#resolveConfirm(action);
        return;
      }
      // ESC = 拒绝
      if (key === '\x1b') {
        this.#resolveConfirm(ConfirmationAction.reject);
        return;
      }
      return; // 其他键在确认状态下忽略
    }

    // 非确认状态：ESC = 取消当前流式
    if (key === '\x1b' && !this.awaitingConfirm) {
      if (this.isRunning && this.abortController) {
        process.stdout.write('\n');
        console.log(col(C.yellow, '正在取消...'));
        this.abortController.abort();
      }
    }
    // 其他键交给 readline 的正常处理（readline 会读取 stdin 事件）
  }

  /**
   * 重新渲染确认框（方向键移动选项时）
   * 用 ANSI 转义码清除已输出的确认框行，再重新输出
   */
  #rerenderConfirmBox() {
    const lineCount = CONFIRM_OPTIONS.length + 5; // 头部 + 选项 + 底部 + 提示
    // 上移 lineCount 行并清除
    process.stdout.write(`\x1b[${lineCount}A`);
    for (let i = 0; i < lineCount; i++) {
      process.stdout.write('\x1b[2K\n');
    }
    process.stdout.write(`\x1b[${lineCount}A`);
    renderConfirmBox(this.confirmToolName, this.confirmArgs, this.confirmSelectedIdx);
  }

  // ── 事件处理 ──────────────────────────────────────────────────

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

      case MessageTypePolicy:
        this.#endSections();
        if (event.policy.running) {
          process.stdout.write(col(C.green, `[策略] ${event.policy.name} 执行中...`));
        } else if (event.policy.err) {
          console.log(col(C.red, ` 失败: ${event.policy.err.message}`));
        } else {
          console.log(col(C.green, ' 完成'));
        }
        break;

      case MessageTypeMemory:
        this.#endSections();
        if (event.memory.running) {
          process.stdout.write(col(C.purple, '记忆更新: (运行中...)'));
        } else if (event.memory.err) {
          console.log(col(C.red, ` 记忆更新失败: ${event.memory.err.message}`));
        } else {
          console.log(col(C.purple, ' (已完成)'));
        }
        break;

      case MessageTypeToolConfirm:
        // 工具确认请求（第八章新增）
        this.#endSections();
        if (!event.toolConfirmRequest) break;
        this.confirmToolName = event.toolConfirmRequest.toolName;
        this.confirmArgs     = event.toolConfirmRequest.arguments;
        renderConfirmBox(this.confirmToolName, this.confirmArgs, this.confirmSelectedIdx);
        break;

      default: break;
    }
  }

  // ── 辅助方法 ──────────────────────────────────────────────────

  #endReasoning() {
    if (this.reasoningOpen) { process.stdout.write('\n'); this.reasoningOpen = false; }
  }
  #endAnswer() {
    if (this.answerOpen) { process.stdout.write('\n'); this.answerOpen = false; }
  }
  #endSections() { this.#endReasoning(); this.#endAnswer(); }

  #renderWelcome() {
    console.log(col(C.cyan, 'BabyAgent TUI — ch09 (Skills System)'));
    console.log(col(C.gray, '────────────────────────────────────────────────'));
    console.log(`欢迎使用，输入问题后回车。当前模型: ${this.modelName}`);
    console.log(col(C.gray, '快捷键: Ctrl+C / Esc 取消流式；空闲时退出'));
    console.log(col(C.gray, '命令: /clear 清空会话'));
    console.log(col(C.yellow, '提示: 执行 bash 命令前会弹出确认框（↑↓ 选择，Enter 确认）'));
    console.log();
  }
}
