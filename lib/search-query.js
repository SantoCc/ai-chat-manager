/**
 * 搜索词解析：支持「豆包+AI趋势」「千问 AI」等多关键词 AND
 * 平台名会识别为平台过滤，其余词需同时命中标题/正文
 */

const PLATFORM_ALIASES = {
  豆包: 'doubao',
  doubao: 'doubao',
  字节豆包: 'doubao',
  千问: 'qianwen',
  通义: 'qianwen',
  通义千问: 'qianwen',
  qianwen: 'qianwen',
  qwen: 'qianwen',
  deepseek: 'deepseek',
  'deep seek': 'deepseek',
  深度求索: 'deepseek',
  元宝: 'yuanbao',
  腾讯元宝: 'yuanbao',
  yuanbao: 'yuanbao',
  kimi: 'kimi',
  月之暗面: 'kimi'
};

const PLATFORM_LABELS = {
  doubao: '豆包',
  qianwen: '千问',
  deepseek: 'DeepSeek',
  yuanbao: '元宝',
  kimi: 'Kimi'
};

/** 拆分查询：+／空格／逗号等 */
export function tokenizeSearchQuery(query) {
  return String(query || '')
    .trim()
    .split(/[\s+＋|｜,，、]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseSearchQuery(query) {
  const raw = String(query || '').trim();
  const parts = tokenizeSearchQuery(raw);
  const platforms = [];
  const terms = [];
  for (const p of parts) {
    const plat = PLATFORM_ALIASES[p] || PLATFORM_ALIASES[p.toLowerCase()];
    if (plat) platforms.push(plat);
    else terms.push(p);
  }
  return {
    raw,
    platforms: [...new Set(platforms)],
    terms,
    /** 用于高亮的词（不含已识别为平台过滤的词，避免全文到处标「豆包」噪音；若仅平台词则高亮平台名） */
    highlightTerms: terms.length ? terms : platforms.map((p) => PLATFORM_LABELS[p] || p)
  };
}

function buildHaystack(conv) {
  const label = PLATFORM_LABELS[conv?.platform] || conv?.platform || '';
  const parts = [conv?.title || '', label, conv?.platform || ''];
  for (const m of conv?.messages || []) {
    if (m?.content) parts.push(String(m.content));
  }
  if (Array.isArray(conv?.tags)) parts.push(conv.tags.join(' '));
  return parts.join('\n').toLowerCase();
}

/** 单条对话是否匹配解析后的查询（与当前 platform 筛选叠加） */
export function conversationMatchesParsedQuery(conv, parsed) {
  if (!parsed || (!parsed.platforms.length && !parsed.terms.length)) return true;
  if (parsed.platforms.length && !parsed.platforms.includes(conv.platform)) {
    return false;
  }
  if (!parsed.terms.length) return true;
  const hay = buildHaystack(conv);
  return parsed.terms.every((t) => hay.includes(String(t).toLowerCase()));
}

export function conversationMatchesSearchQuery(conv, query) {
  return conversationMatchesParsedQuery(conv, parseSearchQuery(query));
}
