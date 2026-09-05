/**
 * 简单 Markdown 渲染（无第三方库）
 * 支持：粗体、斜体、标题、链接、列表、代码、GFM 表格
 */

import { parseSearchQuery } from './search-query.js';

/** 修复全是「1.」的列表（跨 bullet 全局重排） */
function fixOrderedListMarkdownLocal(text) {
  let s = String(text || '');
  if (!s) return '';
  s = s.replace(/(^|\n)(\d+\.\s+[^\n]+)\n{2,}(?=\d+\.\s+)/gm, '$1$2\n');
  const lines = s.split('\n');
  const numberedIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\d+\.\s+/.test(lines[i])) numberedIdx.push(i);
  }
  if (numberedIdx.length >= 2) {
    const nums = numberedIdx.map((i) => Number(lines[i].match(/^(\d+)\./)[1]));
    const ones = nums.filter((n) => n === 1).length;
    if (ones === nums.length || ones >= Math.max(2, Math.ceil(nums.length * 0.5))) {
      let n = 1;
      for (const i of numberedIdx) {
        lines[i] = lines[i].replace(/^\d+\./, `${n}.`);
        n += 1;
      }
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 修复 ** 与正文被拆行的残缺粗体 */
function repairBrokenMarkdownLocal(text) {
  let s = String(text || '');
  if (!s) return '';
  s = s.replace(/\*\*[ \t]*\r?\n+[ \t]*([^*\n][^\n]*)\r?\n+[ \t]*\*\*/g, '**$1**');
  s = s.replace(/^[ \t]*\*\*[ \t]*$/gm, '');
  s = s.replace(/^([-*+]|\d+\.)\s*\*\*[ \t]*$/gm, '$1 ');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

export function renderMarkdown(text) {
  if (!text) return '';

  // 先抽出代码块，避免内部被二次处理
  const codeBlocks = [];
  let src = String(text).replace(/```(\w*)[ \t]*\r?\n([\s\S]*?)```/g, (_, lang, code) => {
    const token = `@@CODE_BLOCK_${codeBlocks.length}@@`;
    // 保留内部换行；仅去掉首尾空行
    const body = String(code || '').replace(/^\r?\n+/, '').replace(/\r?\n+$/, '');
    codeBlocks.push({ lang, code: body });
    return token;
  });

  // 修复「全是 1.」以及条目间空行 / 残缺 ** 导致的错乱（展示层）
  src = repairBrokenMarkdownLocal(src);
  src = fixOrderedListMarkdownLocal(src);

  src = escapeHtml(src);

  // 还原代码块为 HTML（data-code 供复制，避免 DOM/样式影响剪贴板）
  src = src.replace(/@@CODE_BLOCK_(\d+)@@/g, (_, idx) => {
    const block = codeBlocks[Number(idx)];
    if (!block) return '';
    const langAttr = block.lang ? ` data-lang="${block.lang}"` : '';
    const rawAttr = ` data-code="${encodeURIComponent(block.code)}"`;
    return `<pre class="code-block"${langAttr}${rawAttr}><code>${escapeHtml(block.code)}</code><button class="copy-code-btn" type="button" title="复制代码">复制</button></pre>`;
  });

  // GFM 表格
  src = renderTables(src);

  // 标题
  src = src.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
  src = src.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
  src = src.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
  src = src.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  src = src.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  src = src.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // 行内代码
  src = src.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

  // 粗体（同一行内；避免跨行误吞后半段正文）
  src = src.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  src = src.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  // 斜体：仅匹配单侧 *text*，且不与粗体冲突
  src = src.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

  // 链接 / 图片（图片优先，避免被当成普通链接）
  src = src.replace(
    /!\[([^\]]*)\]\((https?:[^)\s]+|data:image\/[^)\s]+)\)/g,
    '<img class="md-image" src="$2" alt="$1" loading="lazy" referrerpolicy="no-referrer" />'
  );
  src = src.replace(
    /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );

  // 有序 / 无序列表：保留原文数字（value/start），避免被 bullet 拆开后每个 <ol> 都从 1 起
  src = src.replace(/^(\d+)\.\s+(.+)$/gm, '<li class="ol-item" value="$1">$2</li>');
  src = src.replace(/^[-*]\s+(.+)$/gm, '<li class="ul-item">$1</li>');
  src = src.replace(/(?:<li class="ol-item"[^>]*>[\s\S]*?<\/li>\s*)+/g, (match) => {
    const items = match.match(/<li class="ol-item"[^>]*>[\s\S]*?<\/li>/g) || [];
    const firstVal = Number((items[0] || '').match(/value="(\d+)"/)?.[1]) || 1;
    return `<ol start="${firstVal}">${items.join('')}</ol>`;
  });
  src = src.replace(/(?:<li class="ul-item">[\s\S]*?<\/li>\s*)+/g, (match) => {
    const items = match.match(/<li class="ul-item">[\s\S]*?<\/li>/g) || [];
    return `<ul>${items.join('')}</ul>`;
  });
  src = src.replace(/\sclass="(?:ol|ul)-item"/g, '');

  // 段落：已是块级标签的不包 p；其余保留换行
  src = src
    .split(/\n{2,}/)
    .map((block) => {
      const t = block.trim();
      if (!t) return '';
      if (/^<(pre|ul|ol|table|h[1-6]|blockquote|div|img)\b/i.test(t)) return t;
      return `<p>${t.replace(/\n/g, '<br>')}</p>`;
    })
    .join('');

  return src;
}

function renderTables(html) {
  const lines = html.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const headerCells = splitRow(line);
      i += 2;
      const body = [];
      while (i < lines.length && isTableRow(lines[i])) {
        body.push(splitRow(lines[i]));
        i += 1;
      }
      const thead = `<thead><tr>${headerCells.map((c) => `<th>${c}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${body
        .map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join('')}</tr>`)
        .join('')}</tbody>`;
      out.push(`<div class="md-table-wrap"><table class="md-table">${thead}${tbody}</table></div>`);
      continue;
    }
    out.push(line);
    i += 1;
  }

  return out.join('\n');
}

function isTableRow(line) {
  const s = String(line || '').trim();
  return s.startsWith('|') && s.endsWith('|') && s.includes('|');
}

function isTableSep(line) {
  const s = String(line || '').trim();
  if (!isTableRow(s)) return false;
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(s);
}

function splitRow(line) {
  const s = String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '');
  return s.split('|').map((c) => c.trim());
}

export function highlightSearchText(text, query) {
  if (!query || !text) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const parsed = parseSearchQuery(query);
  const terms = (parsed.highlightTerms || []).filter(Boolean);
  if (!terms.length) {
    const q = escapeRegExp(String(query).trim());
    if (!q) return escaped;
    return escaped.replace(new RegExp(`(${q})`, 'gi'), '<mark class="search-hit">$1</mark>');
  }
  // 按长度降序，避免短词先替换破坏长词
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  const pattern = sorted.map((t) => escapeRegExp(t)).join('|');
  if (!pattern) return escaped;
  return escaped.replace(new RegExp(`(${pattern})`, 'gi'), '<mark class="search-hit">$1</mark>');
}

/** 摘要用轻量清洗（保留关键字，去掉机器标记） */
function cleanTextForSnippet(text) {
  return String(text || '')
    .replace(/@@ACM_FILE:\{[\s\S]*?\}@@/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`]+/g, ' ')
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/(?:🛠️|🛠)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 搜索摘要：围绕内容关键词命中（忽略平台过滤词）
 */
export function getSearchSnippet(source, query, radiusBefore = 8, radiusAfter = 42) {
  const parsed = parseSearchQuery(query);
  const focusTerms = parsed.terms.length ? parsed.terms : parsed.highlightTerms || [];
  const q = focusTerms[0] || String(query || '').trim();
  if (!q) {
    const raw =
      typeof source === 'string'
        ? source
        : source?.messages?.[0]?.content || source?.title || '';
    return cleanTextForSnippet(raw).slice(0, 56);
  }

  /** @type {{ text: string, idx: number, score: number, term: string }[]} */
  const hits = [];
  const pushHit = (text, scoreBase) => {
    const raw = cleanTextForSnippet(text);
    if (!raw) return;
    const lower = raw.toLowerCase();
    for (const term of focusTerms) {
      const t = String(term).toLowerCase();
      if (!t) continue;
      const idx = lower.indexOf(t);
      if (idx < 0) continue;
      hits.push({ text: raw, idx, term, score: scoreBase + t.length - idx / 10000 });
    }
  };

  if (typeof source === 'string') {
    pushHit(source, 100);
  } else if (source && typeof source === 'object') {
    for (const m of source.messages || []) {
      if (!m?.content) continue;
      pushHit(m.content, m.role === 'assistant' ? 200 : 150);
    }
    if (source.title) pushHit(source.title, 50);
  }

  if (!hits.length && source && typeof source === 'object') {
    for (const m of source.messages || []) {
      const raw = String(m?.content || '').replace(/\s+/g, ' ').trim();
      const lower = raw.toLowerCase();
      for (const term of focusTerms) {
        const idx = lower.indexOf(String(term).toLowerCase());
        if (idx >= 0) {
          hits.push({ text: raw, idx, term, score: 80 });
          break;
        }
      }
      if (hits.length) break;
    }
  }

  if (!hits.length) return '';

  hits.sort((a, b) => b.score - a.score);
  const best = hits[0];
  const termLen = String(best.term || q).length;
  const start = Math.max(0, best.idx - radiusBefore);
  const end = Math.min(best.text.length, best.idx + termLen + radiusAfter);
  let snippet = best.text.slice(start, end);
  if (start > 0) snippet = `…${snippet}`;
  if (end < best.text.length) snippet = `${snippet}…`;
  const need = String(best.term || q).toLowerCase();
  if (!snippet.toLowerCase().includes(need)) {
    snippet = best.text.slice(best.idx, Math.min(best.text.length, best.idx + termLen + radiusAfter));
    if (best.idx + termLen + radiusAfter < best.text.length) snippet += '…';
  }
  return snippet;
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
