/**
 * buildHistory 根据 parent_message_id 沿树向上追溯路径，
 * 将路径上每条消息的 rounds 拼接成 LLM history。
 *
 * @param {Array<{message_id: string, parent_message_id: string, rounds: string}>} allMsgs
 * @param {string} parentMessageId
 * @returns {Array} LLM messages 列表
 */
export function buildHistory(allMsgs, parentMessageId) {
  if (!parentMessageId) return [];

  // 构建 id -> message 索引
  const index = new Map();
  for (const msg of allMsgs) {
    index.set(msg.message_id, msg);
  }

  // 从 parentMessageId 向根节点追溯，收集路径
  // path 顺序：parent -> ... -> 根
  const path = [];
  let cur = parentMessageId;
  while (cur) {
    const msg = index.get(cur);
    if (!msg) break;
    path.push(msg);
    cur = msg.parent_message_id;
  }

  // 反转：变为 根 -> ... -> parent 的顺序
  path.reverse();

  // 拼接每条消息的 rounds
  const history = [];
  for (const msg of path) {
    if (!msg.rounds) continue;
    try {
      const rounds = JSON.parse(msg.rounds);
      history.push(...rounds);
    } catch {
      // 忽略损坏的 JSON
    }
  }
  return history;
}
