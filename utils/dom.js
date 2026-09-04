/**
 * DOM 工具函数
 */

function getTextContent(element) {
  if (!element) return '';
  return (element.innerText || element.textContent || '').trim();
}

function queryAll(root, selector) {
  if (!root || !selector) return [];
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function queryOne(root, selector) {
  if (!root || !selector) return null;
  try {
    return root.querySelector(selector);
  } catch {
    return null;
  }
}

function cellText(cell) {
  return getTextContent(cell).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

function tableToMarkdown(table) {
  if (!table) return '';
  const rows = Array.from(table.querySelectorAll('tr'))
    .map((tr) => Array.from(tr.querySelectorAll('th, td')).map(cellText))
    .filter((r) => r.length && r.some((c) => c));
  if (!rows.length) return '';

  const colCount = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => {
    const copy = r.slice();
    while (copy.length < colCount) copy.push('');
    return copy;
  });

  const header = norm[0];
  const sep = header.map(() => '---');
  const body = norm.slice(1);
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`)
  ];
  return lines.join('\n');
}

/**
 * 将富文本 DOM 转为 Markdown（保留粗体、表格、标题、列表等）
 */
function extractMarkdownFromElement(element) {
  if (!element) return '';

  const clone = element.cloneNode(true);

  // 先摘掉 style/script，避免 CSS 源码泄漏进正文（志愿报告卡片曾整段 CSS 进详情）
  clone
    .querySelectorAll('style, script, noscript, link[rel="stylesheet"], template')
    .forEach((el) => el.remove());

  // 生成文件卡片：先记下元信息，再删节点，避免只剩 CSS/JSON
  const fileCards = extractGeneratedFileCardsFromDom(clone);

  // 去掉思考 / 检索 / 志愿卡片相关节点
  clone
    .querySelectorAll(
      [
        '[class*="deep_think"]',
        '[class*="deep-think"]',
        '[class*="DeepThink"]',
        '[class*="thinking"]',
        '[class*="Thinking"]',
        '[class*="think-"]',
        '[class*="ThinkBlock"]',
        '[class*="plugin-deep"]',
        '[data-content-type="think"]',
        '[data-type="think"]',
        '[class*="gaokao"]',
        '[class*="Gaokao"]',
        '[class*="zhiyuan"]',
        '[class*="Zhiyuan"]',
        '[class*="choice-report"]',
        '[class*="choiceReport"]',
        '[class*="report-card"]',
        '[class*="ReportCard"]',
        '[class*="progressWrap"]',
        '[class*="progressTrack"]',
        '[class*="progressBar"]'
      ].join(',')
    )
    .forEach((el) => el.remove());

  // 文案特征：含「已完成思考」的折叠块（避免误删整段超长回答）
  clone.querySelectorAll('div, section, details, article').forEach((el) => {
    if (!el || !el.parentNode) return;
    const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 2500) return;
    if (/已完成思考|Finished thinking|Thinking\.\.\.|参考了\s*\d+\s*篇材料/.test(t)) {
      // 若块内没有正式章节/表格，视为思考区
      if (!/(?:^|\n)\s*[一二三四五六七八九十]+[、．.]/.test(el.innerText || '') && !el.querySelector('table')) {
        el.remove();
      }
    }
    // 卡片 JSON 泄漏
    if (/^\s*[\{\[]/.test(t) && /"reqId"|"zhiyuan_table"|"gaokao_choice_report"/.test(t)) {
      el.remove();
    }
  });

  // 移除按钮、图标、表格工具条等 UI 噪点
  clone
    .querySelectorAll(
      [
        'button',
        'svg',
        'img',
        'video',
        'audio',
        'iframe',
        '[aria-hidden="true"]',
        '[class*="toolbar"]',
        '[class*="Toolbar"]',
        '[class*="table-action"]',
        '[class*="TableAction"]',
        '[class*="export"]',
        '[class*="Export"]',
        '[class*="download"]',
        '[class*="Download"]',
        '[class*="copy-btn"]',
        '[class*="icon-btn"]'
      ].join(',')
    )
    .forEach((el) => el.remove());

  // 去掉仅含「表格 / 下载 / 导出」类文案的装饰节点
  clone.querySelectorAll('span, div, p, a').forEach((el) => {
    const t = (el.textContent || '').replace(/\s+/g, '').trim();
    if (/^(表格|下载为表格|导出为图片|复制|分享)$/.test(t) && !el.querySelector('table')) {
      el.remove();
    }
  });

  // 表格 → GFM（先于其他转换，避免破坏结构）
  clone.querySelectorAll('table').forEach((table) => {
    const md = tableToMarkdown(table);
    table.replaceWith(document.createTextNode(md ? `\n\n${md}\n\n` : ''));
  });

  // 代码块
  clone.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code');
    let lang = '';
    if (code && code.className) {
      const match = code.className.match(/language-(\w+)/);
      if (match) lang = match[1];
    }
    const text = code ? getTextContent(code) : getTextContent(pre);
    pre.replaceWith(document.createTextNode(`\n\`\`\`${lang}\n${text}\n\`\`\`\n`));
  });

  // 行内代码
  clone.querySelectorAll('code').forEach((code) => {
    if (code.closest('pre')) return;
    code.replaceWith(document.createTextNode('`' + getTextContent(code) + '`'));
  });

  // 标题
  for (let level = 6; level >= 1; level--) {
    clone.querySelectorAll(`h${level}`).forEach((h) => {
      const text = getTextContent(h);
      h.replaceWith(document.createTextNode(`\n${'#'.repeat(level)} ${text}\n\n`));
    });
  }

  // 粗体 / 斜体（后处理嵌套时先处理内层：先 em 再 strong 也可；这里先 strong）
  clone.querySelectorAll('strong, b').forEach((el) => {
    const text = getTextContent(el);
    if (text) el.replaceWith(document.createTextNode(`**${text}**`));
    else el.remove();
  });
  clone.querySelectorAll('em, i').forEach((el) => {
    const text = getTextContent(el);
    if (text) el.replaceWith(document.createTextNode(`*${text}*`));
    else el.remove();
  });

  // 常见「伪粗体」样式
  clone.querySelectorAll('[style*="font-weight"], [class*="bold"], [class*="Bold"]').forEach((el) => {
    if (el.closest('strong, b')) return;
    const style = (el.getAttribute('style') || '').toLowerCase();
    const cls = String(el.className || '');
    const heavy =
      /font-weight\s*:\s*(bold|[6-9]00)/i.test(style) || /bold|font-bold|fw-bold/i.test(cls);
    if (!heavy) return;
    const text = getTextContent(el);
    if (text && !/^\*\*/.test(text)) {
      el.replaceWith(document.createTextNode(`**${text}**`));
    }
  });

  // 链接
  clone.querySelectorAll('a[href]').forEach((a) => {
    const text = getTextContent(a);
    const href = a.getAttribute('href') || '';
    if (!text) {
      a.remove();
      return;
    }
    if (/^(javascript:|#)/i.test(href) || /下载|导出|复制/.test(text)) {
      a.replaceWith(document.createTextNode(text));
      return;
    }
    a.replaceWith(document.createTextNode(`[${text}](${href})`));
  });

  // 列表
  clone.querySelectorAll('li').forEach((li) => {
    const parent = li.parentElement;
    const ordered = parent && parent.tagName === 'OL';
    const idx = ordered
      ? Array.from(parent.children).filter((c) => c.tagName === 'LI').indexOf(li) + 1
      : 0;
    const prefix = ordered ? `${idx}. ` : '- ';
    li.replaceWith(document.createTextNode(prefix + getTextContent(li) + '\n'));
  });

  // 换行 / 段落
  clone.querySelectorAll('br').forEach((br) => {
    br.replaceWith(document.createTextNode('\n'));
  });
  clone.querySelectorAll('p, div, section, article').forEach((p) => {
    // 只处理叶子块，避免把整棵树压扁丢换行
    if (p.querySelector('p, div, table, pre, ul, ol, h1, h2, h3, h4, h5, h6')) return;
    const text = getTextContent(p);
    if (text) p.replaceWith(document.createTextNode(text + '\n\n'));
  });

  let text = getTextContent(clone);
  // 清理多余空行与表格工具残留词 / CSS 泄漏
  text = text
    .replace(/^\s*(表格|下载为表格|导出为图片)\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  text = stripCssLeakText(text);

  if (typeof stripQianwenThinkingProcess === 'function') {
    text = stripQianwenThinkingProcess(text);
  } else {
    text = text.replace(/^(?:已完成思考|Finished thinking)[^\n]*\n+/i, '').trim();
  }

  const fileBlock = formatGeneratedFileCardsMarkdown(fileCards);
  if (fileBlock) {
    text = text ? `${text}\n\n${fileBlock}` : fileBlock;
  }
  return text;
}

/** 从 DOM 提取「AI 生成文件」卡片元信息（志愿报告等） */
function extractGeneratedFileCardsFromDom(root) {
  if (!root?.querySelectorAll) return [];
  const nodes = Array.from(
    root.querySelectorAll(
      [
        '[class*="gaokao_zhiyuan_report"]',
        '[class*="zhiyuan_report"]',
        '[class*="zhiyuan-report"]',
        '[class*="choice-report"]',
        '[class*="choiceReport"]',
        '[class*="report-card"]',
        '[class*="ReportCard"]',
        '[class*="card_card_gaokao"]'
      ].join(',')
    )
  );
  const cards = [];
  const seen = new Set();
  for (const el of nodes) {
    // 只要最外层卡片，避免子节点重复
    if (nodes.some((o) => o !== el && o.contains(el))) continue;
    const raw = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!raw || raw.length > 500) continue;
    let title = '生成文件';
    const titleMatch = raw.match(/志愿报告\s*[\d\-—_]+|志愿报告/);
    if (titleMatch) title = titleMatch[0].trim();
    else if (/PPT|幻灯片/i.test(raw)) title = raw.slice(0, 40);
    else if (/报告|文档|文件/.test(raw)) title = raw.slice(0, 40);

    let generatedAt = '';
    const timeMatch =
      raw.match(/(?:Generated on|生成于|生成时间)[:\s]*([\d/\-.\s:]+)/i) ||
      raw.match(/(\d{2}-\d{2}\s+\d{2}:\d{2})/) ||
      raw.match(/(20\d{2}-\d{2}-\d{2}[^\d]*\d{0,2}:?\d{0,2})/);
    if (timeMatch) generatedAt = timeMatch[1].trim();

    const key = `${title}::${generatedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push({
      kind: 'file',
      type: /志愿|gaokao|zhiyuan/i.test(title + raw) ? 'gaokao_zhiyuan_report' : 'generated_file',
      title,
      generatedAt
    });
  }
  return cards;
}

function formatGeneratedFileCardsMarkdown(cards) {
  if (!Array.isArray(cards) || !cards.length) return '';
  return cards
    .map((c) => {
      const meta = {
        kind: 'file',
        type: c.type || 'generated_file',
        title: c.title || '生成文件',
        generatedAt: c.generatedAt || ''
      };
      // 机器可读标记 + 纯文本兜底
      return [
        `@@ACM_FILE:${JSON.stringify(meta)}@@`,
        `📎 **${meta.title}**`,
        meta.generatedAt ? `生成时间：${meta.generatedAt}` : '',
        '（交互式文件请在原对话中打开查看）'
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

/** 是否像 CSS / 构建产物泄漏进正文 */
function isCssOrStyleLeakText(text) {
  const s = String(text || '');
  if (!s || s.length < 40) return false;
  if (/sourceMappingURL|\.css\.map/.test(s)) return true;
  if (/card_card_gaokao_zhiyuan_report|zhiyuan-report-card-|progressWrap-|progressTrack-|progressBar-/.test(s)) {
    return true;
  }
  if (
    (s.match(/[{};]/g) || []).length > 20 &&
    /margin|padding|border-radius|background|flex\s*:|width\s*:\s*\d+px/.test(s) &&
    s.length > 150
  ) {
    return true;
  }
  return false;
}

/** 是否像结构化卡片 JSON（志愿报告 / 附件元数据等） */
function isStructuredCardJunkText(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (isCssOrStyleLeakText(s)) return true;
  if (
    /"gaokao_choice_report"|gaokao_choice_report|"zhiyuan_table"|"zhiyuan_list"|"initialData"|"school_prob"|"reqId"/.test(
      s
    )
  ) {
    if (s.length > 120 || /^\s*[\{\[]/.test(s)) return true;
  }
  // 大段裸 JSON 且几乎没有自然语言
  if (
    /^\s*[\{\[]/.test(s) &&
    s.length > 200 &&
    (s.match(/[{}\[\]"]/g) || []).length > 40 &&
    !/[\u4e00-\u9fff]{20}/.test(s.slice(0, 400))
  ) {
    return true;
  }
  return false;
}

function guessGeneratedFileMetaFromText(text) {
  const s = String(text || '');
  let title = '生成文件';
  let type = 'generated_file';
  if (/志愿报告|gaokao|zhiyuan/i.test(s)) {
    title = (s.match(/志愿报告\s*[\d\-—_]+/) || ['志愿报告'])[0];
    type = 'gaokao_zhiyuan_report';
  } else if (/PPT|幻灯片|演示文稿/i.test(s)) {
    title = '演示文稿';
    type = 'presentation';
  } else if (/表格|spreadsheet|excel/i.test(s)) {
    title = '表格文件';
    type = 'spreadsheet';
  } else if (/文档|document|pdf/i.test(s)) {
    title = '文档';
    type = 'document';
  }
  let generatedAt = '';
  const timeMatch =
    s.match(/(?:Generated on|生成于|生成时间)[:\s]*([\d/\-.\s:]+)/i) ||
    s.match(/(\d{2}-\d{2}\s+\d{2}:\d{2})/);
  if (timeMatch) generatedAt = timeMatch[1].trim();
  return { kind: 'file', type, title, generatedAt };
}

/**
 * 保存前清洗助手正文：去 CSS/卡片 JSON，必要时换成文件卡片标记
 * DeepSeek / 豆包 / 千问共用
 */
function sanitizeAssistantContentForSave(text) {
  let s = String(text || '').trim();
  if (!s) return '';
  if (/@@ACM_FILE:/.test(s) && !isCssOrStyleLeakText(s) && !isStructuredCardJunkText(s)) {
    return s;
  }
  const hadJunk = isCssOrStyleLeakText(s) || isStructuredCardJunkText(s);
  s = stripCssLeakText(s);
  if (typeof stripQianwenStructuredJson === 'function') {
    try {
      s = stripQianwenStructuredJson(s) || s;
    } catch {
      // ignore
    }
  }
  if (hadJunk && (isCssOrStyleLeakText(s) || isStructuredCardJunkText(s) || !s.trim())) {
    return formatGeneratedFileCardsMarkdown([guessGeneratedFileMetaFromText(text)]);
  }
  if (hadJunk && s.trim()) {
    const card = formatGeneratedFileCardsMarkdown([guessGeneratedFileMetaFromText(text)]);
    return card ? `${s}\n\n${card}` : s;
  }
  return s;
}

/** 过滤误抽进正文的 CSS / sourceMap */
function stripCssLeakText(text) {
  let s = String(text || '');
  if (!s) return '';
  if (
    /sourceMappingURL|\.css\.map|card_card_gaokao_zhiyuan_report|zhiyuan-report-card-|progressWrap-|progressTrack-|progressBar-/.test(
      s
    )
  ) {
    // 整段像 CSS 则清空
    if (
      (s.match(/[{};]/g) || []).length > 15 ||
      /flex\s*;\s*width\s*:\s*\d+px/i.test(s) ||
      /sourceMappingURL/.test(s)
    ) {
      // 尝试只保留不像 CSS 的中文说明句
      const keep = s
        .split(/\n+/)
        .map((line) => line.trim())
        .filter((line) => {
          if (!line) return false;
          if (/[{};]|sourceMappingURL|card_card_|progressWrap|flex:0|margin-left:\d/.test(line)) {
            return false;
          }
          if (/^[\.\#\[]/.test(line) && /\{|:/.test(line)) return false;
          return /[\u4e00-\u9fff]/.test(line);
        });
      s = keep.join('\n');
    }
  }
  // 行内夹杂的超长 CSS 串
  s = s.replace(/[^\n]{0,40}\.card\.card_card_gaokao[\s\S]{20,8000?}(?=\n|$)/g, '');
  s = s.replace(/\/\*#\s*sourceMappingURL=[\s\S]*$/g, '');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 若字符串像 HTML，则转 Markdown；否则原样返回
 */
function htmlOrTextToMarkdown(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (!/<\/?[a-z][\s\S]*>/i.test(s)) return s;
  try {
    const wrap = document.createElement('div');
    wrap.innerHTML = s;
    return extractMarkdownFromElement(wrap) || s;
  } catch {
    return s;
  }
}

function normalizeMatchText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function ensureHighlightStyle() {
  if (document.getElementById('acm-highlight-style')) return;
  const style = document.createElement('style');
  style.id = 'acm-highlight-style';
  style.textContent = `
    .acm-scroll-highlight {
      outline: 2px solid #FF6B35 !important;
      outline-offset: 3px;
      border-radius: 8px;
      animation: acm-highlight-pulse 1.2s ease-in-out 2;
    }
    @keyframes acm-highlight-pulse {
      0%, 100% { outline-color: #FF6B35; }
      50% { outline-color: rgba(255, 107, 53, 0.35); }
    }
  `;
  document.head.appendChild(style);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForStableContent(element, stableMs = 500, timeoutMs = 60000) {
  return new Promise((resolve) => {
    if (!element) {
      resolve('');
      return;
    }

    let lastContent = getTextContent(element);
    let stableTimer = null;
    let timeoutTimer = null;

    const finish = () => {
      observer.disconnect();
      clearTimeout(stableTimer);
      clearTimeout(timeoutTimer);
      resolve(lastContent);
    };

    const checkStable = () => {
      clearTimeout(stableTimer);
      stableTimer = setTimeout(finish, stableMs);
    };

    const observer = new MutationObserver(() => {
      lastContent = getTextContent(element);
      checkStable();
    });

    observer.observe(element, { childList: true, subtree: true, characterData: true });
    checkStable();

    timeoutTimer = setTimeout(finish, timeoutMs);
  });
}

if (typeof globalThis !== 'undefined') {
  globalThis.getTextContent = getTextContent;
  globalThis.queryAll = queryAll;
  globalThis.queryOne = queryOne;
  globalThis.extractMarkdownFromElement = extractMarkdownFromElement;
  globalThis.htmlOrTextToMarkdown = htmlOrTextToMarkdown;
  globalThis.tableToMarkdown = tableToMarkdown;
  globalThis.waitForStableContent = waitForStableContent;
  globalThis.normalizeMatchText = normalizeMatchText;
  globalThis.ensureHighlightStyle = ensureHighlightStyle;
  globalThis.sleep = sleep;
  globalThis.stripCssLeakText = stripCssLeakText;
  globalThis.isCssOrStyleLeakText = isCssOrStyleLeakText;
  globalThis.isStructuredCardJunkText = isStructuredCardJunkText;
  globalThis.sanitizeAssistantContentForSave = sanitizeAssistantContentForSave;
  globalThis.formatGeneratedFileCardsMarkdown = formatGeneratedFileCardsMarkdown;
  globalThis.guessGeneratedFileMetaFromText = guessGeneratedFileMetaFromText;
}
