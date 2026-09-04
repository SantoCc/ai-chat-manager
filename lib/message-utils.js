/**
 * 消息去重与智能合并
 */

export function normalizeContentKey(content) {
  return String(content || '').replace(/\s+/g, ' ').trim();
}

export function isSameMessageContent(a, b) {
  const ka = normalizeContentKey(a);
  const kb = normalizeContentKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;

  const minLen = Math.min(ka.length, kb.length);
  if (minLen < 80) return false;

  // 截断稿 vs 完整稿：一方为另一方前缀
  if (ka.startsWith(kb) || kb.startsWith(ka)) {
    return true;
  }

  // 开头高度重合且长度接近（避免误伤不同回答）
  const probeLen = Math.min(160, minLen);
  const probeA = ka.slice(0, probeLen);
  const probeB = kb.slice(0, probeLen);
  if (probeA !== probeB) return false;
  const maxLen = Math.max(ka.length, kb.length);
  return minLen / maxLen >= 0.7;
}

/** 去掉重复消息（同角色 + 相同/高度相似内容）；相似时保留更长正文 */
export function dedupeMessages(messages) {
  if (!messages?.length) return [];

  const result = [];
  for (const msg of messages) {
    const role = msg.role;
    const content = msg.content || '';
    const idx = result.findIndex(
      (r) => r.role === role && isSameMessageContent(r.content, content)
    );
    if (idx === -1) {
      result.push({
        role: msg.role,
        content: msg.content || '',
        timestamp: msg.timestamp || null
      });
      continue;
    }
    // 已有更短/等长则用更长的替换，避免截断稿覆盖完整稿
    if (String(content).length > String(result[idx].content || '').length) {
      result[idx] = {
        role: msg.role || result[idx].role,
        content,
        timestamp: msg.timestamp || result[idx].timestamp || null
      };
    }
  }
  return result;
}

/**
 * 合并已有消息与新解析结果：
 * - 去重，避免 DOM 重复提取
 * - 同索引保留更长内容
 * - 新解析缺失时保留已有尾部消息（避免丢失后续回答）
 * - 新内容为重复时，不覆盖不同的已有内容
 */
export function mergeMessages(existing = [], incoming = []) {
  const oldList = dedupeMessages(existing);
  const newList = dedupeMessages(incoming);

  if (!oldList.length) return newList;
  if (!newList.length) return oldList;

  // 新列表更短且首条对不上：多半是「只拉到最新一轮」的残片，追加到旧历史而不是按索引覆盖
  if (
    newList.length < oldList.length &&
    !isSameMessageContent(oldList[0]?.content, newList[0]?.content)
  ) {
    const out = oldList.map((m) => ({ ...m }));
    for (const m of newList) {
      if (
        !out.some(
          (o) => o.role === m.role && isSameMessageContent(o.content, m.content)
        )
      ) {
        out.push({
          role: m.role,
          content: m.content || '',
          timestamp: m.timestamp || null
        });
      }
    }
    return dedupeMessages(out);
  }

  const result = [];
  const maxLen = Math.max(oldList.length, newList.length);

  for (let i = 0; i < maxLen; i++) {
    const oldMsg = oldList[i];
    const newMsg = newList[i];

    if (!newMsg && oldMsg) {
      if (!result.some((r) => isSameMessageContent(r.content, oldMsg.content))) {
        result.push({ ...oldMsg });
      }
      continue;
    }

    if (!oldMsg && newMsg) {
      if (!result.some((r) => isSameMessageContent(r.content, newMsg.content))) {
        result.push({ ...newMsg });
      }
      continue;
    }

    const oldContent = String(oldMsg.content || '');
    const newContent = String(newMsg.content || '');

    if (isSameMessageContent(oldContent, newContent)) {
      result.push({
        role: newMsg.role || oldMsg.role,
        content: oldContent.length >= newContent.length ? oldContent : newContent,
        timestamp: newMsg.timestamp || oldMsg.timestamp || null
      });
      continue;
    }

    const newIsDup = result.some((r) => isSameMessageContent(r.content, newContent));
    const oldIsDup = result.some((r) => isSameMessageContent(r.content, oldContent));

    if (newIsDup && !oldIsDup) {
      result.push({ ...oldMsg });
      continue;
    }
    if (oldIsDup && !newIsDup) {
      result.push({ ...newMsg });
      continue;
    }

    result.push({
      role: newMsg.role || oldMsg.role,
      content: newContent.length >= oldContent.length ? newContent : oldContent,
      timestamp: newMsg.timestamp || oldMsg.timestamp || null
    });
  }

  return dedupeMessages(result);
}
