import Database from 'better-sqlite3';

/**
 * 初始化 SQLite 数据库，创建表结构（如不存在）。
 * @param {string} dbPath - 数据库文件路径，如 'ch10.db'
 * @returns {Database.Database}
 */
export function initDB(dbPath) {
  const db = new Database(dbPath);

  // 开启 WAL 模式提升并发读写性能
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      title           TEXT NOT NULL DEFAULT '',
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_user_id
      ON conversations (user_id);

    CREATE TABLE IF NOT EXISTS chat_messages (
      message_id        TEXT PRIMARY KEY,
      user_id           TEXT NOT NULL,
      conversation_id   TEXT NOT NULL,
      parent_message_id TEXT NOT NULL DEFAULT '',
      query             TEXT NOT NULL DEFAULT '',
      response          TEXT NOT NULL DEFAULT '',
      rounds            TEXT NOT NULL DEFAULT '',
      model             TEXT NOT NULL DEFAULT '',
      usage             TEXT NOT NULL DEFAULT '',
      created_at        INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id
      ON chat_messages (conversation_id);

    CREATE INDEX IF NOT EXISTS idx_chat_messages_user_id
      ON chat_messages (user_id);
  `);

  return db;
}
