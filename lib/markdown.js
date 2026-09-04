/**
 * 简单 Markdown 渲染（无第三方库）
 * 支持：粗体、斜体、标题、链接、列表、代码、GFM 表格
 */

export function renderMarkdown(text) {
  if (!text) return '';

  // 先抽出代码块，避免内部被二次处理
  const codeBlocks = [];
  let src = String(text).replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const token = `@@CODE_BLOCK_${codeBlocks.length}@@`;
    codeBlocks.push({ lang, code: code.trim() });
    return token;
  });

  src = escapeHtml(src);

  // 还原代码块为 HTML
  src = src.replace(/@@CODE_BLOCK_(\d+)@@/g, (_, idx) => {
    const block = codeBlocks[Number(idx)];
    if (!block) return '';
    const langAttr = block.lang ? ` data-lang="${block.lang}"` : '';
    return `<pre class="code-block"${langAttr}><code>${escapeHtml(block.code)}</code><button class="copy-code-btn" type="button" title="复制代码">复制</button></pre>`;
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

  // 链接（URL 内允许括号较少的常见形式）
  src = src.replace(
    /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );

  // 有序 / 无序列表
  src = src.replace(/^\d+\.\s+(.+)$/gm, '<li class="ol-item">$1</li>');
  src = src.replace(/^[-*]\s+(.+)$/gm, '<li class="ul-item">$1</li>');
  src = src.replace(/(?:<li class="ol-item">[\s\S]*?<\/li>\n?)+/g, (match) => `<ol>${match}</ol>`);
  src = src.replace(/(?:<li class="ul-item">[\s\S]*?<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);
  src = src.replace(/\sclass="(?:ol|ul)-item"/g, '');

  // 段落：已是块级标签的不包 p；其余保留换行
  src = src
    .split(/\n{2,}/)
    .map((block) => {
      const t = block.trim();
      if (!t) return '';
      if (/^<(pre|ul|ol|table|h[1-6]|blockquote|div)\b/i.test(t)) return t;
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
  const q = escapeRegExp(query);
  return escaped.replace(new RegExp(`(${q})`, 'gi'), '<mark class="search-highlight">$1</mark>');
}

export function getSearchSnippet(conversation, query, contextLength = 60) {
  if (!query) return conversation.title;
  const q = query.toLowerCase();

  for (const msg of conversation.messages || []) {
    const idx = msg.content.toLowerCase().indexOf(q);
    if (idx !== -1) {
      const start = Math.max(0, idx - contextLength);
      const end = Math.min(msg.content.length, idx + query.length + contextLength);
      let snippet = msg.content.slice(start, end);
      if (start > 0) snippet = '...' + snippet;
      if (end < msg.content.length) snippet = snippet + '...';
      return snippet;
    }
  }
  return conversation.title;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
