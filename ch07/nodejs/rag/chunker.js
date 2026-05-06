/**
 * chunker.js — 文本切分器
 *
 * 提供两种切分策略：
 *   - LineChunker：按行数 + 字符数切分，适合代码文件
 *   - ParagraphChunker：按空行段落切分，适合文档/Markdown
 *
 * 每个 Chunk 格式：
 *   { content: string, meta: { documentId, startPos, endPos } }
 */

// ─── ChunkerType ────────────────────────────────────────────────────────────

export const ChunkerType = {
  LINE: 'line',
  PARAGRAPH: 'paragraph',
};

// ─── 工厂函数 ────────────────────────────────────────────────────────────────

/**
 * 创建切分器
 * @param {string} type - ChunkerType.LINE | ChunkerType.PARAGRAPH
 * @param {number} maxLines - 每块最大行数（LineChunker），或每块最大段落数（ParagraphChunker）
 * @param {number} maxChars - 每块最大字符数（LineChunker 专用）
 */
export function newChunker(type, maxLines, maxChars) {
  switch (type) {
    case ChunkerType.PARAGRAPH:
      return new ParagraphChunker(maxLines);
    case ChunkerType.LINE:
    default:
      return new LineChunker(maxLines, maxChars);
  }
}

// ─── LineChunker ─────────────────────────────────────────────────────────────

/**
 * 按行数和字符数切分
 */
export class LineChunker {
  /**
   * @param {number} maxLines - 每块最大行数，默认 100
   * @param {number} maxChars - 每块最大字符数，默认 2000
   */
  constructor(maxLines = 100, maxChars = 2000) {
    this.maxLines = maxLines > 0 ? maxLines : 100;
    this.maxChars = maxChars > 0 ? maxChars : 2000;
  }

  /**
   * @param {string} documentId
   * @param {string} content
   * @returns {Array<{content: string, meta: {documentId: string, startPos: number, endPos: number}}>}
   */
  chunk(documentId, content) {
    const chunks = [];
    const lines = content.split('\n');

    let currentLines = [];
    let startLine = 1;
    let currentSize = 0;

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];
      const lineSize = line.length;

      // 检查是否需要开始新的块
      if (
        currentLines.length > 0 &&
        (currentLines.length >= this.maxLines || currentSize + lineSize > this.maxChars)
      ) {
        chunks.push({
          content: currentLines.join('\n'),
          meta: {
            documentId,
            startPos: startLine,
            endPos: lineNum - 1,
          },
        });
        currentLines = [];
        startLine = lineNum;
        currentSize = 0;
      }

      currentLines.push(line);
      currentSize += lineSize;
    }

    // 保存最后一个块
    if (currentLines.length > 0) {
      chunks.push({
        content: currentLines.join('\n'),
        meta: {
          documentId,
          startPos: startLine,
          endPos: lines.length,
        },
      });
    }

    return chunks;
  }
}

// ─── ParagraphChunker ────────────────────────────────────────────────────────

/**
 * 按空行分隔的段落切分，适合 Markdown 文档
 */
export class ParagraphChunker {
  /**
   * @param {number} maxParagraphs - 每块最大段落数，默认 5
   */
  constructor(maxParagraphs = 5) {
    this.maxParagraphs = maxParagraphs > 0 ? maxParagraphs : 5;
  }

  /**
   * @param {string} documentId
   * @param {string} content
   * @returns {Array<{content: string, meta: {documentId: string, startPos: number, endPos: number}}>}
   */
  chunk(documentId, content) {
    const chunks = [];
    const lines = content.split('\n');

    let currentParagraphs = [];
    let startLine = 1;
    let currentLine = 1;

    for (const line of lines) {
      // 空行表示段落结束
      if (line.trim() === '') {
        if (currentParagraphs.length > 0) {
          chunks.push({
            content: currentParagraphs.join('\n'),
            meta: {
              documentId,
              startPos: startLine,
              endPos: currentLine - 1,
            },
          });
          currentParagraphs = [];
        }
        currentLine++;
        startLine = currentLine;
        continue;
      }

      currentParagraphs.push(line);
      currentLine++;

      // 超过最大段落数时切分
      if (currentParagraphs.length >= this.maxParagraphs) {
        chunks.push({
          content: currentParagraphs.join('\n'),
          meta: {
            documentId,
            startPos: startLine,
            endPos: currentLine - 1,
          },
        });
        currentParagraphs = [];
        startLine = currentLine;
      }
    }

    // 处理最后一个段落
    if (currentParagraphs.length > 0) {
      chunks.push({
        content: currentParagraphs.join('\n'),
        meta: {
          documentId,
          startPos: startLine,
          endPos: currentLine - 1,
        },
      });
    }

    return chunks;
  }
}
