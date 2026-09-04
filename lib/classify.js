/**
 * 按文件夹名称/关键词自动分类对话
 */

export function classifyConversation(conversation, folders) {
  if (!folders?.length || !conversation) return null;

  const text = buildSearchText(conversation);
  if (!text) return null;

  let bestId = null;
  let bestScore = 0;

  for (const folder of folders) {
    for (const keyword of getFolderKeywords(folder)) {
      if (keyword.length < 2) continue;
      if (!text.includes(keyword)) continue;

      let score = keyword.length;
      const title = (conversation.title || '').toLowerCase();
      if (title.includes(keyword)) score += 20;

      if (score > bestScore) {
        bestScore = score;
        bestId = folder.id;
      }
    }
  }

  return bestId;
}

export function getFolderKeywords(folder) {
  const raw = folder.keywords?.length ? folder.keywords : [folder.name];
  return [...new Set(raw.map((k) => String(k).trim().toLowerCase()).filter(Boolean))];
}

function buildSearchText(conversation) {
  const parts = [conversation.title || ''];
  for (const msg of conversation.messages || []) {
    if (msg.role === 'user') {
      parts.push((msg.content || '').slice(0, 800));
    }
  }
  return parts.join('\n').toLowerCase();
}

export function getFolderNameById(folders, folderId) {
  if (!folderId) return null;
  return folders.find((f) => f.id === folderId)?.name || null;
}
