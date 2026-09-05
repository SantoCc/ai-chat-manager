/**
 * DOM 工具函数
 */

function getTextContent(element) {
  if (!element) return '';
  // pre/code 必须用 textContent，innerText 在部分样式下会丢掉换行
  const tag = element.tagName;
  if (tag === 'PRE' || tag === 'CODE' || element.closest?.('pre')) {
    return String(element.textContent || '').replace(/^\r?\n+|\r?\n+$/g, '');
  }
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

/** 解开折叠/截断样式，让 clone 上的 innerText 能读到全文 */
function revealCollapsedContentInDom(root) {
  if (!root?.querySelectorAll) return;
  try {
    root.querySelectorAll('[hidden]').forEach((el) => {
      el.hidden = false;
    });
    root.querySelectorAll('[aria-hidden="true"]').forEach((el) => {
      // 工具图标等仍可隐藏；正文容器放行
      if (el.matches?.('svg, img, button, [class*="icon"], [class*="Icon"]')) return;
      el.removeAttribute('aria-hidden');
    });
  } catch {
    // ignore
  }
  root.querySelectorAll('*').forEach((el) => {
    if (!el || el.nodeType !== 1) return;
    const cls = String(el.className || '');
    const st = el.getAttribute?.('style') || '';
    const need =
      /display\s*:\s*none|visibility\s*:\s*hidden|max-height\s*:\s*0|-webkit-line-clamp\s*:/i.test(
        st
      ) ||
      /collapse|collapsed|folded|fold-up|line-clamp|truncate|ellipsis|hide-content|is-clamp|折叠/i.test(
        cls
      );
    if (!need) return;
    try {
      el.style.setProperty('display', 'block', 'important');
      el.style.setProperty('visibility', 'visible', 'important');
      el.style.setProperty('max-height', 'none', 'important');
      el.style.setProperty('-webkit-line-clamp', 'unset', 'important');
      el.style.setProperty('overflow', 'visible', 'important');
    } catch {
      // ignore
    }
  });
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
/**
 * 判断 Markdown 是否被错误拆开（如 ** 与正文分行）——此类结果绝不能参与择优
 */
function isBrokenMarkdown(text) {
  const t = String(text || '');
  if (!t) return true;
  // 单独一行的 **，或 ** 与正文被拆成三行
  if (/^\s*\*\*\s*$/m.test(t)) return true;
  if (/\*\*[ \t]*\r?\n[ \t]*\*\*/.test(t)) return true;
  if (/\*\*[ \t]*\r?\n+[ \t]*[^*\n][^\n]*\r?\n+[ \t]*\*\*/.test(t)) return true;
  if (/^[-*•]\s*\*\*\s*$/m.test(t)) return true;
  const marks = (t.match(/\*\*/g) || []).length;
  const pairs = (t.match(/\*\*[^*\n]+\*\*/g) || []).length;
  if (marks >= 4 && pairs === 0) return true;
  return false;
}

/** 修复已落库的残缺粗体标记（展示/二次抽取） */
function repairBrokenMarkdown(text) {
  let s = String(text || '');
  if (!s) return '';
  // **\n正文\n** → **正文**
  s = s.replace(/\*\*[ \t]*\r?\n+[ \t]*([^*\n][^\n]*)\r?\n+[ \t]*\*\*/g, '**$1**');
  // 行首孤立 ** 去掉
  s = s.replace(/^[ \t]*\*\*[ \t]*$/gm, '');
  s = s.replace(/^([-*+]|\d+\.)\s*\*\*[ \t]*$/gm, '$1 ');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

/**
 * HTML→Markdown：一律走 DOM（禁止用正则把 span 换成换行，否则会拆开 **粗体**）
 */
function simpleHtmlToMarkdown(html) {
  const raw = String(html || '');
  if (!raw || !/<\/?[a-z]/i.test(raw)) return '';
  try {
    const wrap = document.createElement('div');
    wrap.innerHTML = raw;
    convertInlineAndListsInPlace(wrap);
    let text = (wrap.innerText || wrap.textContent || '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    text = repairBrokenMarkdown(text);
    return fixOrderedListMarkdown(text);
  } catch {
    return '';
  }
}

/**
 * 就地转换：先 inline 标记，再自内向外拆列表（千问「编号标题 + 嵌套要点」）
 */
/** 就地把 HTML / role 表格转成 GFM，避免 innerText 把单元格粘成「章节内容摘要…」 */
function convertTablesInPlace(root) {
  if (!root?.querySelectorAll) return;
  root.querySelectorAll('table').forEach((table) => {
    const md = tableToMarkdown(table);
    table.replaceWith(document.createTextNode(md ? `\n\n${md}\n\n` : ''));
  });
  // 少数站点用 role=table / grid 而非 <table>
  root.querySelectorAll('[role="table"], [role="grid"]').forEach((grid) => {
    if (grid.querySelector('table')) return;
    const rows = Array.from(
      grid.querySelectorAll('[role="row"], tr')
    );
    const matrix = rows
      .map((row) =>
        Array.from(row.querySelectorAll('[role="columnheader"], [role="rowheader"], [role="cell"], [role="gridcell"], th, td'))
          .map(cellText)
          .filter(Boolean)
      )
      .filter((r) => r.length);
    if (matrix.length < 2) return;
    const colCount = Math.max(...matrix.map((r) => r.length));
    const norm = matrix.map((r) => {
      const copy = r.slice();
      while (copy.length < colCount) copy.push('');
      return copy;
    });
    const header = norm[0];
    const sep = header.map(() => '---');
    const body = norm.slice(1);
    const md = [
      `| ${header.join(' | ')} |`,
      `| ${sep.join(' | ')} |`,
      ...body.map((r) => `| ${r.join(' | ')} |`)
    ].join('\n');
    grid.replaceWith(document.createTextNode(md ? `\n\n${md}\n\n` : ''));
  });
}

function convertInlineAndListsInPlace(root) {
  if (!root?.querySelectorAll) return;

  root.querySelectorAll('style, script, noscript, template').forEach((el) => el.remove());

  // 表格必须先于段落/列表，否则 innerText 会压扁
  convertTablesInPlace(root);

  // strong/em：用纯文本包裹，禁止内部再插换行
  root.querySelectorAll('strong, b').forEach((el) => {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) el.replaceWith(document.createTextNode(`**${text}**`));
    else el.remove();
  });
  root.querySelectorAll('em, i').forEach((el) => {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) el.replaceWith(document.createTextNode(`*${text}*`));
    else el.remove();
  });
  root.querySelectorAll('br').forEach((br) => {
    br.replaceWith(document.createTextNode('\n'));
  });

  // 列表自内向外
  let guard = 0;
  while (guard++ < 24) {
    const lists = Array.from(root.querySelectorAll('ol, ul')).filter(
      (list) => !list.querySelector('ol, ul')
    );
    if (!lists.length) break;
    for (const list of lists) {
      const ordered = list.tagName === 'OL';
      const items = Array.from(list.children).filter((c) => c.tagName === 'LI');
      const lines = items
        .map((li, idx) => {
          let body = (li.innerText || li.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
          if (!body) return '';
          if (ordered) {
            // 保留 li 自带编号 / value，避免每个独立 <ol> 都写成 1.
            const existing = body.match(/^(\d+)\.\s+/);
            if (existing) return body;
            const val = Number(li.getAttribute('value'));
            const start = Number(list.getAttribute('start')) || 1;
            const n = Number.isFinite(val) && val > 0 ? val : start + idx;
            return `${n}. ${body}`;
          }
          return `- ${body}`;
        })
        .filter(Boolean);
      list.replaceWith(
        document.createTextNode(lines.length ? `\n\n${lines.join('\n')}\n\n` : '')
      );
    }
  }

  // 叶子块段落
  root.querySelectorAll('p, div, section, article').forEach((p) => {
    if (p.querySelector('p, div, table, pre, ul, ol, h1, h2, h3, h4, h5, h6')) return;
    const text = (p.innerText || p.textContent || '').trim();
    if (text) p.replaceWith(document.createTextNode(text + '\n\n'));
  });
}

/**
 * 修复「全是 1.」的有序列表。
 * 千问常见「1. 标题 + 子 bullet + 1. 下一节」：子项会打断连续编号组，
 * 必须跨 bullet 全局重排，否则渲染成多个 <ol> 全显示 1。
 */
function fixOrderedListMarkdown(text) {
  let s = String(text || '');
  if (!s) return '';
  // 相邻编号项之间的空行压成单换行
  s = s.replace(/(^|\n)(\d+\.\s+[^\n]+)\n{2,}(?=\d+\.\s+)/gm, '$1$2\n');

  const lines = s.split('\n');
  const numberedIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\d+\.\s+/.test(lines[i])) numberedIdx.push(i);
  }
  if (numberedIdx.length >= 2) {
    const nums = numberedIdx.map((i) => Number(lines[i].match(/^(\d+)\./)[1]));
    const ones = nums.filter((n) => n === 1).length;
    // 全是 1，或超过一半是 1（被拆成多个单条 ol）
    const needsRenumber = ones === nums.length || ones >= Math.max(2, Math.ceil(nums.length * 0.5));
    if (needsRenumber) {
      let n = 1;
      for (const i of numberedIdx) {
        lines[i] = lines[i].replace(/^\d+\./, `${n}.`);
        n += 1;
      }
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 是否像被压扁的表格（工具条文案 + 单元格无 | 分隔） */
function looksLikeMashedTable(text) {
  const t = String(text || '').replace(/\s+/g, '');
  if (!t) return false;
  if (/表格下载为表格|导出为图片/.test(t) && !/\|/.test(String(text || ''))) return true;
  if (/章节内容摘要|章节内容一、|章节内容二、/.test(t) && !/\|/.test(String(text || ''))) {
    return true;
  }
  return false;
}

function hasMarkdownTable(text) {
  const t = String(text || '');
  return /^\|.+\|/m.test(t) && /^\|?\s*:?-{3,}/m.test(t);
}

function scoreMarkdownStructure(text) {
  const t = String(text || '');
  if (!t.trim()) return -1;
  if (isBrokenMarkdown(t)) return -100;
  let score = 0;
  score += Math.min(80, (t.match(/\n/g) || []).length * 3);
  score += (t.match(/\n\n/g) || []).length * 4;
  score += (t.match(/\*\*[^*\n]+\*\*/g) || []).length * 6;
  // 有序编号比无序圆点更贴近千问原文
  score += (t.match(/^\d+\.\s/gm) || []).length * 12;
  score += (t.match(/^[-*+]\s/gm) || []).length * 4;
  score += (t.match(/^#{1,6}\s/gm) || []).length * 8;
  score += (t.match(/^\|.+\|/gm) || []).length * 10;
  if (hasMarkdownTable(t)) score += 40;
  if (looksLikeMashedTable(t)) score -= 80;
  if (!/\n/.test(t) && t.length > 160) score -= 40;
  return score;
}

function pickRicherMarkdown(a, b) {
  const x = repairBrokenMarkdown(String(a || '').trim());
  const y = repairBrokenMarkdown(String(b || '').trim());
  if (!x) return y;
  if (!y) return x;
  const xBroken = isBrokenMarkdown(x);
  const yBroken = isBrokenMarkdown(y);
  if (xBroken && !yBroken) return y;
  if (yBroken && !xBroken) return x;
  // 有「1. 标题」而另一侧只有子 bullet → 绝不能丢标题
  const xHeads = (x.match(/^\d+\.\s+/gm) || []).length;
  const yHeads = (y.match(/^\d+\.\s+/gm) || []).length;
  if (xHeads >= 2 && yHeads === 0) return x;
  if (yHeads >= 2 && xHeads === 0) return y;
  const sx = scoreMarkdownStructure(x);
  const sy = scoreMarkdownStructure(y);
  if (sy > sx + 2) return y;
  if (sx > sy + 2) return x;
  return x.length >= y.length ? x : y;
}

function extractMarkdownFromElement(element) {
  if (!element) return '';

  const clone = element.cloneNode(true);

  // 必须挂到文档里再读 innerText，否则脱离文档的 clone 会丢 CSS 换行（千问等站点尤其明显）
  const host = document.createElement('div');
  host.setAttribute('data-acm-md-host', '1');
  host.style.cssText =
    'position:fixed;left:-10000px;top:0;width:720px;opacity:0;pointer-events:none;z-index:-1;';
  host.appendChild(clone);
  (document.body || document.documentElement).appendChild(host);

  try {
    const viaMounted = repairBrokenMarkdown(extractMarkdownFromElementMounted(clone));
    // 仅当挂载路径几乎无版式时，才用 HTML-DOM 兜底；残缺 ** 结果一律丢弃
    if (!isBrokenMarkdown(viaMounted) && scoreMarkdownStructure(viaMounted) >= 8) {
      return viaMounted;
    }
    const viaHtml = simpleHtmlToMarkdown(element.innerHTML || '');
    if (isBrokenMarkdown(viaHtml)) return viaMounted;
    return pickRicherMarkdown(viaMounted, viaHtml);
  } finally {
    try {
      host.remove();
    } catch {
      // ignore
    }
  }
}

function extractMarkdownFromElementMounted(clone) {
  if (!clone) return '';

  // 先摘掉 style/script，避免 CSS 源码泄漏进正文（志愿报告卡片曾整段 CSS 进详情）
  clone
    .querySelectorAll('style, script, noscript, link[rel="stylesheet"], template')
    .forEach((el) => el.remove());

  // 展开折叠/截断样式，避免 innerText 丢掉 display:none / line-clamp 后半段
  if (typeof revealCollapsedContentInDom === 'function') {
    revealCollapsedContentInDom(clone);
  } else {
    clone.querySelectorAll('[hidden], [aria-hidden="true"]').forEach((el) => {
      try {
        el.hidden = false;
        el.removeAttribute('aria-hidden');
      } catch {
        // ignore
      }
    });
    clone.querySelectorAll('*').forEach((el) => {
      const st = el.getAttribute?.('style') || '';
      if (
        /display\s*:\s*none|visibility\s*:\s*hidden|max-height\s*:\s*0|-webkit-line-clamp\s*:/i.test(
          st
        )
      ) {
        el.style.setProperty('display', 'block', 'important');
        el.style.setProperty('visibility', 'visible', 'important');
        el.style.setProperty('max-height', 'none', 'important');
        el.style.setProperty('-webkit-line-clamp', 'unset', 'important');
        el.style.setProperty('overflow', 'visible', 'important');
      }
    });
  }

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

  // 内容图先转 Markdown，再清工具条（绝不能删掉含 table 的容器）
  clone.querySelectorAll('img').forEach((img) => {
    const cands = [
      img.currentSrc,
      img.src,
      img.getAttribute('src'),
      img.getAttribute('data-src'),
      img.getAttribute('data-original'),
      img.getAttribute('data-url'),
      img.getAttribute('data-lazy-src')
    ];
    let src = '';
    for (const u of cands) {
      const s = String(u || '').trim();
      if (/^(https?:|data:image\/|blob:)/i.test(s)) {
        src = s;
        break;
      }
    }
    if (!src) {
      const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
      const m = srcset.match(/(https?:[^\\\s,]+)/i);
      if (m) src = m[1].trim();
    }
    const w = Number(img.naturalWidth || img.width || img.getAttribute('width') || 0);
    const h = Number(img.naturalHeight || img.height || img.getAttribute('height') || 0);
    const alt = (img.alt || img.getAttribute('alt') || '图片').trim() || '图片';
    const isIcon =
      (w > 0 && w < 40) ||
      (h > 0 && h < 40) ||
      /icon|avatar|emoji|logo|spinner|loading/i.test(
        `${img.className || ''} ${img.id || ''} ${src}`
      );
    if (!isIcon && /^(https?:|data:image\/|blob:)/i.test(src)) {
      // blob 无法在侧栏打开，仍留占位，后续 promote 成卡片
      img.replaceWith(document.createTextNode(`\n\n![${alt}](${src})\n\n`));
    } else {
      img.remove();
    }
  });

  // 表格先转 GFM，再删工具条，避免 download/export class 误删整表
  convertTablesInPlace(clone);

  const isUiChrome = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.querySelector?.('table, tr, td, th, [role="table"], [role="grid"]')) return false;
    const cls = `${el.className || ''} ${el.id || ''}`;
    const tag = el.tagName || '';
    if (/^(BUTTON|SVG|VIDEO|AUDIO|IFRAME)$/i.test(tag)) return true;
    if (el.getAttribute?.('aria-hidden') === 'true') return true;
    if (/toolbar|Toolbar|table-action|TableAction|icon-btn|copy-btn/i.test(cls)) return true;
    // download/export：仅短文案工具条，不碰长正文容器
    if (/download|Download|export|Export/i.test(cls)) {
      const t = (el.innerText || '').replace(/\s+/g, '').trim();
      return !t || t.length < 40 || /^(表格|下载为表格|导出为图片|复制|分享)/.test(t);
    }
    return false;
  };

  clone
    .querySelectorAll(
      [
        'button',
        'svg',
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
    .forEach((el) => {
      if (isUiChrome(el)) el.remove();
    });

  // 去掉仅含「表格 / 下载 / 导出」类文案的装饰节点
  clone.querySelectorAll('span, div, p, a').forEach((el) => {
    const t = (el.textContent || '').replace(/\s+/g, '').trim();
    if (/^(表格|下载为表格|导出为图片|复制|分享)$/.test(t) && !el.querySelector('table')) {
      el.remove();
    }
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

  // 粗体 / 斜体：整段纯文本包裹，禁止内部换行拆开 **
  clone.querySelectorAll('strong, b').forEach((el) => {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) el.replaceWith(document.createTextNode(`**${text}**`));
    else el.remove();
  });
  clone.querySelectorAll('em, i').forEach((el) => {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
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

  // 列表：自内向外转换，保留「1. 标题」+ 嵌套要点，避免外层 li 被内层 </li> 截断
  {
    let guard = 0;
    while (guard++ < 24) {
      const lists = Array.from(clone.querySelectorAll('ol, ul')).filter(
        (list) => !list.querySelector('ol, ul')
      );
      if (!lists.length) break;
      for (const list of lists) {
        const ordered = list.tagName === 'OL';
        const items = Array.from(list.children).filter((c) => c.tagName === 'LI');
        const lines = items
          .map((li, idx) => {
            let body = getTextContent(li).replace(/\n{3,}/g, '\n\n').trim();
            if (!body) return '';
            if (ordered) {
              if (/^\d+\.\s+/.test(body)) return body;
              const val = Number(li.getAttribute('value'));
              const start = Number(list.getAttribute('start')) || 1;
              const n = Number.isFinite(val) && val > 0 ? val : start + idx;
              return `${n}. ${body}`;
            }
            return `- ${body}`;
          })
          .filter(Boolean);
        list.replaceWith(
          document.createTextNode(lines.length ? `\n\n${lines.join('\n')}\n\n` : '')
        );
      }
    }
  }

  // 换行 / 段落
  clone.querySelectorAll('br').forEach((br) => {
    br.replaceWith(document.createTextNode('\n'));
  });

  // 块级 span / 段落类节点（千问常用 span+CSS 做「一句一段」）
  clone.querySelectorAll('span, [class*="paragraph"], [class*="Paragraph"], [class*="para"]').forEach((el) => {
    if (!el?.parentNode) return;
    if (el.querySelector('p, div, table, pre, ul, ol, h1, h2, h3, h4, h5, h6, br')) return;
    let blockish = /paragraph|Paragraph|para|block/i.test(
      `${el.className || ''} ${el.getAttribute?.('data-type') || ''}`
    );
    if (!blockish) {
      try {
        const d = getComputedStyle(el).display;
        blockish = d === 'block' || d === 'flex' || d === 'grid' || d === 'list-item';
      } catch {
        blockish = false;
      }
    }
    if (!blockish) return;
    const text = getTextContent(el);
    if (text && text.length >= 2) {
      el.replaceWith(document.createTextNode(text + '\n\n'));
    }
  });

  clone.querySelectorAll('p, div, section, article').forEach((p) => {
    // 只处理叶子块，避免把整棵树压扁丢换行
    if (p.querySelector('p, div, table, pre, ul, ol, h1, h2, h3, h4, h5, h6')) return;
    const text = getTextContent(p);
    if (text) p.replaceWith(document.createTextNode(text + '\n\n'));
  });

  // 若根下仍有多个直接子节点文案，强制用空行拼接（兜底）
  if (clone.children && clone.children.length >= 2) {
    const parts = [];
    Array.from(clone.childNodes).forEach((node) => {
      if (node.nodeType === 3) {
        const t = String(node.textContent || '').trim();
        if (t) parts.push(t);
        return;
      }
      if (node.nodeType === 1) {
        const t = getTextContent(node);
        if (t) parts.push(t);
      }
    });
    if (parts.length >= 2 && parts.every((p) => p.length < 4000)) {
      const joined = parts.join('\n\n');
      if ((joined.match(/\n/g) || []).length > (getTextContent(clone).match(/\n/g) || []).length) {
        clone.textContent = '';
        clone.appendChild(document.createTextNode(joined));
      }
    }
  }

  let text = getTextContent(clone);
  // 清理多余空行与表格工具残留词 / CSS 泄漏
  text = text
    .replace(/表格下载为表格/g, '')
    .replace(/导出为图片/g, '')
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
    text = dedupeQianwenCardTitlesInText(text, fileCards);
    text = text ? `${text}\n\n${fileBlock}` : fileBlock;
  }
  text = promoteFilenameLinesToFileCards(text);
  text = dedupeAcmFileCardsInText(text);
  text = stripQianwenTrailingRecommendWall(text);
  text = stripQianwenUiChrome(text);
  return fixOrderedListMarkdown(repairBrokenMarkdown(text));
}

/** 从 DOM 提取「AI 生成文件」卡片元信息（志愿报告 / 大纲卡 / 生成图等） */
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
        '[class*="card_card_gaokao"]',
        '[class*="file-card"]',
        '[class*="FileCard"]',
        '[class*="fileCard"]',
        '[class*="attachment-card"]',
        '[class*="AttachmentCard"]',
        '[class*="doc-card"]',
        '[class*="DocCard"]',
        '[class*="sheet-card"]',
        '[class*="SheetCard"]',
        '[class*="artifact-card"]',
        '[class*="ArtifactCard"]',
        '[class*="generated-file"]',
        '[class*="GeneratedFile"]',
        '[class*="upload-file"]',
        '[class*="UploadFile"]',
        '[class*="file-item"]',
        '[class*="FileItem"]',
        '[class*="attach-item"]',
        '[class*="outline"]',
        '[class*="Outline"]',
        '[class*="writing-card"]',
        '[class*="WritingCard"]',
        '[class*="doc-result"]',
        '[class*="DocResult"]',
        '[data-testid*="file_card"]',
        '[data-testid*="attachment_card"]',
        '[data-testid*="doc_card"]',
        '[data-testid*="file-item"]',
        '[data-testid*="outline"]'
      ].join(',')
    )
  );

  const pickHttpUrl = (cands) => {
    for (const u of cands) {
      const s = String(u || '').trim();
      if (/^(https?:|data:image\/)/i.test(s)) return s;
    }
    return '';
  };

  const resolveImgUrl = (img) => {
    if (!img) return '';
    const cands = [
      img.currentSrc,
      img.src,
      img.getAttribute?.('src'),
      img.getAttribute?.('data-src'),
      img.getAttribute?.('data-original'),
      img.getAttribute?.('data-url'),
      img.getAttribute?.('data-lazy-src'),
      img.getAttribute?.('data-actualsrc')
    ];
    let url = pickHttpUrl(cands);
    if (url) return url;
    const srcset = img.getAttribute?.('srcset') || img.getAttribute?.('data-srcset') || '';
    const m = srcset.match(/(https?:[^\\\s,]+)/i);
    if (m) return m[1].trim();
    // picture > source
    const pic = img.closest?.('picture');
    if (pic) {
      for (const src of Array.from(pic.querySelectorAll('source'))) {
        const ss = src.getAttribute('srcset') || src.getAttribute('src') || '';
        const mm = ss.match(/(https?:[^\\\s,]+)/i);
        if (mm) return mm[1].trim();
      }
    }
    // 父链上的下载/预览链接
    const a = img.closest?.('a[href]');
    if (a) {
      const href = String(a.getAttribute('href') || '').trim();
      if (/^(https?:|data:image\/)/i.test(href)) return href;
    }
    return '';
  };

  // 千问：短节点含「文件名：xxx.docx」
  root.querySelectorAll('div, section, article, a, li, span').forEach((el) => {
    if (!el || nodes.includes(el)) return;
    const raw = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!raw || raw.length < 4 || raw.length > 120) return;
    if (!/文件名\s*[：:]\s*\S+\.(?:docx?|pdf|xlsx?|pptx?|zip|png|jpe?g)/i.test(raw)) return;
    if (el.querySelector?.('pre, table, h1, h2, h3')) return;
    nodes.push(el);
  });

  // 千问/豆包：短节点含「创建于 / 创建时间 / 生成于」——大纲卡等
  root.querySelectorAll('div, section, article, a, li').forEach((el) => {
    if (!el || nodes.includes(el)) return;
    const raw = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!raw || raw.length < 4 || raw.length > 140) return;
    if (
      !/(?:创建时间|创建于|生成时间|生成于|Generated on)\s*[:：]?\s*[\d/]/i.test(raw) &&
      !/大纲\s*\|/.test(raw)
    ) {
      return;
    }
    if (raw.split(/\s+/).length > 24) return;
    if (el.querySelector?.('pre, table, h1, h2, h3')) return;
    const longP = Array.from(el.querySelectorAll?.('p') || []).some(
      (p) => ((p.innerText || '').trim().length || 0) > 100
    );
    if (longP) return;
    nodes.push(el);
  });

  // 千问：Word/PPT「文档已生成完毕」类结果卡（无文件名行时也收）
  root.querySelectorAll('div, section, article, a, li').forEach((el) => {
    if (!el || nodes.includes(el)) return;
    const raw = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!raw || raw.length < 6 || raw.length > 180) return;
    if (
      !/(?:Word|PPT|Excel|PDF|文档|表格|幻灯片).{0,12}已生成|已生成完毕|可直接下载使用|点击下载/i.test(
        raw
      )
    ) {
      return;
    }
    if (el.querySelector?.('pre, table, h1, h2, h3')) return;
    if (raw.split(/\s+/).length > 36) return;
    nodes.push(el);
  });

  // 下载链接 → 文档卡
  root.querySelectorAll('a[href], a[download]').forEach((a) => {
    if (!a || nodes.includes(a)) return;
    const href = String(a.getAttribute('href') || a.href || '').trim();
    const name = String(a.getAttribute('download') || a.innerText || '').trim();
    if (
      !/\.(docx?|pdf|xlsx?|pptx?|zip|txt|csv)(\?|$)/i.test(`${href} ${name}`) &&
      !/download|attachment/i.test(href)
    ) {
      return;
    }
    if (/javascript:|#|login|signin/i.test(href)) return;
    nodes.push(a);
  });

  const cards = [];
  const seen = new Set();
  const pushCard = (card) => {
    if (!card) return;
    const key = `${card.type || ''}::${card.url || ''}::${card.title || ''}::${card.generatedAt || ''}`;
    if (seen.has(key)) return;
    if (card.url && seen.has(`url::${card.url}`)) return;
    seen.add(key);
    if (card.url) seen.add(`url::${card.url}`);
    cards.push(card);
  };

  // 大图 → 图片卡（多图缩略墙时取最大的一张，不整组丢弃）
  const imgCandidates = [];
  root.querySelectorAll('img').forEach((img) => {
    if (!img) return;
    if (
      img.closest?.(
        '[class*="recommend"], [class*="Recommend"], [class*="swiper"], [class*="carousel"], [class*="quark"], [class*="paa"], [class*="Paa"], [class*="suggest"], [class*="related"], [class*="feed-card"], [class*="FeedCard"]'
      )
    ) {
      return;
    }
    const src = resolveImgUrl(img);
    if (!src) return;
    const w = Number(img.naturalWidth || img.width || img.getAttribute('width') || 0);
    const h = Number(img.naturalHeight || img.height || img.getAttribute('height') || 0);
    if ((w > 0 && w < 64) || (h > 0 && h < 64)) return;
    if (/icon|avatar|emoji|logo|spinner|loading|sprite|qrcode/i.test(`${img.className || ''} ${src}`)) {
      return;
    }
    const area = (w || 400) * (h || 400);
    imgCandidates.push({
      img,
      src,
      area,
      alt: (img.alt || '图片').trim() || '图片'
    });
  });

  // CSS background-image（部分生成图不用 <img>）
  root.querySelectorAll('[style*="background"], [style*="Background"]').forEach((el) => {
    if (
      el.closest?.(
        '[class*="recommend"], [class*="Recommend"], [class*="swiper"], [class*="quark"], [class*="paa"]'
      )
    ) {
      return;
    }
    const style = el.getAttribute?.('style') || '';
    const m = style.match(/url\(\s*['"]?(https?:[^'")\s]+)/i);
    if (!m) return;
    const src = m[1].trim();
    if (/icon|avatar|logo|sprite|emoji/i.test(`${el.className || ''} ${src}`)) return;
    imgCandidates.push({ img: el, src, area: 160000, alt: '图片' });
  });

  imgCandidates.sort((a, b) => b.area - a.area);
  // 同容器多缩略图：只保留面积最大的若干张（通常 1 张正文图）
  const byHost = new Map();
  for (const c of imgCandidates) {
    const host =
      c.img.closest?.(
        '[class*="image"], [class*="Image"], [class*="picture"], [class*="Picture"], [class*="generate"], [class*="Generate"], [class*="wanx"], [class*="result"], [data-chat-answers-wrap]'
      ) ||
      c.img.parentElement ||
      c.img;
    const list = byHost.get(host) || [];
    list.push(c);
    byHost.set(host, list);
  }
  for (const list of byHost.values()) {
    list.sort((a, b) => b.area - a.area);
    // 同容器只留最大的一张，避免缩略图+正图重复落卡
    const keep = list.slice(0, 1);
    for (const c of keep) {
      pushCard({
        kind: 'file',
        type: 'image',
        title: String(c.alt || '图片').slice(0, 80),
        generatedAt: '',
        url: c.src
      });
    }
  }

  // blob: 图无法持久化 URL，仍落一张「图片」卡（侧栏可点回原对话）
  if (!cards.some((c) => c.type === 'image')) {
    root.querySelectorAll('img').forEach((img) => {
      if (
        img.closest?.(
          '[class*="recommend"], [class*="Recommend"], [class*="swiper"], [class*="quark"], [class*="paa"]'
        )
      ) {
        return;
      }
      const raw = String(img.currentSrc || img.src || img.getAttribute('src') || '').trim();
      if (!/^blob:/i.test(raw)) return;
      const w = Number(img.naturalWidth || img.width || img.getAttribute('width') || 0);
      const h = Number(img.naturalHeight || img.height || img.getAttribute('height') || 0);
      if ((w > 0 && w < 80) || (h > 0 && h < 80)) return;
      pushCard({
        kind: 'file',
        type: 'image',
        title: ((img.alt || '图片').trim() || '图片').slice(0, 80),
        generatedAt: '',
        url: ''
      });
    });
  }

  for (const el of nodes) {
    if (nodes.some((o) => o !== el && o.contains?.(el))) continue;
    if (el.tagName === 'IMG') continue;
    const raw = (el.innerText || '').replace(/\s+/g, ' ').trim();
    const href = el.tagName === 'A' ? String(el.getAttribute('href') || el.href || '').trim() : '';
    if ((!raw || raw.length > 500) && !href) continue;

    let title = '生成文件';
    const fileNameMatch = (raw || '').match(
      /文件名\s*[：:]\s*([^\s]+?\.(?:docx?|pdf|xlsx?|pptx?|zip|txt|csv|png|jpe?g|gif|webp))/i
    );
    const outlineMatch = (raw || '').match(/((?:大纲|论文|文档|PPT|报告)\s*\|\s*[^创建生成]{2,40})/);
    const dlName = String(el.getAttribute?.('download') || '').trim();
    if (fileNameMatch) title = fileNameMatch[1].trim();
    else if (outlineMatch) title = outlineMatch[1].replace(/\s+/g, ' ').trim();
    else if (dlName) title = dlName.slice(0, 80);
    else if (/\.(docx?|pdf|xlsx?|pptx?)(\?|$)/i.test(href)) {
      try {
        title = decodeURIComponent(href.split('/').pop().split('?')[0]).slice(0, 80) || '文档';
      } catch {
        title = '文档';
      }
    } else {
      const titleMatch = (raw || '').match(/志愿报告\s*[\d\-—_]+|志愿报告/);
      if (titleMatch) title = titleMatch[0].trim();
      else if (/Word/i.test(raw || '')) title = 'Word 文档';
      else if (/PPT|幻灯片/i.test(raw || '')) title = 'PPT';
      else if (/Excel|表格/i.test(raw || '')) title = '表格';
      else if (/PDF/i.test(raw || '')) title = 'PDF 文档';
      else {
        const beforeTime = (raw || '')
          .split(/(?:创建时间|创建于|生成时间|生成于|Generated on|已生成)/i)[0]
          .replace(/[:：]\s*$/, '')
          .trim();
        if (beforeTime && beforeTime.length <= 60) title = beforeTime;
        else if (/报告|文档|文件|模板|表格|大纲/.test(raw || '')) {
          title = beforeTime || (raw || '').slice(0, 40);
        }
      }
    }

    let generatedAt = '';
    const timeMatch =
      (raw || '').match(/(?:Generated on|生成于|生成时间|创建时间|创建于)[:\s：]*([\d/\-.\s:]+)/i) ||
      (raw || '').match(/(\d{2}-\d{2}\s+\d{2}:\d{2})/) ||
      (raw || '').match(/(\d{1,2}:\d{2})/) ||
      (raw || '').match(/(20\d{2}-\d{2}-\d{2}[^\d]*\d{0,2}:?\d{0,2})/);
    if (timeMatch) generatedAt = timeMatch[1].trim();

    let type = /志愿|gaokao|zhiyuan/i.test(title + (raw || ''))
      ? 'gaokao_zhiyuan_report'
      : /表格|sheet|excel|xls|csv|spreadsheet/i.test(title + (raw || '') + href)
        ? 'spreadsheet'
        : /PPT|幻灯|演示/i.test(title + (raw || ''))
          ? 'presentation'
          : /大纲|文档|doc|pdf|论文|报告|Word|已生成完毕|可直接下载/i.test(
                title + (raw || '') + href
              )
            ? 'document'
            : 'generated_file';

    const img = el.querySelector?.('img');
    const imgUrl = resolveImgUrl(img);
    let url = '';
    if (/^(https?:)/i.test(href) && /\.(docx?|pdf|xlsx?|pptx?|zip|png|jpe?g|gif|webp)(\?|$)/i.test(href)) {
      url = href;
    } else if (imgUrl) {
      url = imgUrl;
    }
    if (imgUrl && type === 'generated_file') {
      type = 'image';
      if (title === '生成文件') title = (img?.alt || '图片').trim() || '图片';
    }

    pushCard({
      kind: 'file',
      type,
      title: String(title || '生成文件').slice(0, 80),
      generatedAt,
      url: url || ''
    });
  }
  return cards;
}

function formatGeneratedFileCardsMarkdown(cards) {
  if (!Array.isArray(cards) || !cards.length) return '';
  const deduped = dedupeGeneratedFileCards(cards);
  return deduped
    .map((c) => {
      const meta = {
        kind: 'file',
        type: c.type || 'generated_file',
        title: c.title || (/image/i.test(c.type || '') ? '图片' : '生成文件'),
        generatedAt: c.generatedAt || '',
        url: c.url || ''
      };
      // 机器可读标记 + 纯文本兜底（有预览 URL 的图卡不再附重复标题行）
      return [
        `@@ACM_FILE:${JSON.stringify(meta)}@@`,
        meta.type === 'image' ? '' : `📎 **${meta.title}**`,
        meta.type === 'image' ? '' : meta.generatedAt ? `生成时间：${meta.generatedAt}` : '',
        meta.type === 'image'
          ? ''
          : '（交互式文件请在原对话中打开查看）'
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

/** 图片/文件卡去重：同 URL 只留一张；无 URL 占位最多一张且让位给有 URL 的；允许多张不同 URL 图 */
function dedupeGeneratedFileCards(cards) {
  if (!Array.isArray(cards) || !cards.length) return [];
  const out = [];
  const seenUrl = new Set();
  const sorted = [...cards].sort((a, b) => {
    const au = a?.url ? 1 : 0;
    const bu = b?.url ? 1 : 0;
    if (bu !== au) return bu - au;
    return String(b?.url || '').length - String(a?.url || '').length;
  });
  let keptUrlLessImage = false;
  let imageWithUrlCount = 0;
  for (const c of sorted) {
    if (!c) continue;
    const type = String(c.type || '');
    const url = String(c.url || '').trim();
    const isImage = /image/i.test(type);
    if (url) {
      const key = url.replace(/[?#].*$/, '');
      if (seenUrl.has(key) || seenUrl.has(url)) continue;
      seenUrl.add(key);
      seenUrl.add(url);
      if (isImage && imageWithUrlCount >= 12) continue;
      out.push(c);
      if (isImage) {
        imageWithUrlCount += 1;
        keptUrlLessImage = true;
      }
      continue;
    }
    if (isImage) {
      if (keptUrlLessImage || imageWithUrlCount > 0) continue;
      if (out.some((x) => /image/i.test(x.type || '') && !x.url)) continue;
      keptUrlLessImage = true;
      out.push(c);
      continue;
    }
    const title = String(c.title || '');
    if (out.some((x) => x.type === type && x.title === title && !x.url)) continue;
    out.push(c);
  }
  return out;
}

/** 正文里重复的 @@ACM_FILE 图片卡：同 URL 合并；无 URL 让位给有 URL */
function dedupeAcmFileCardsInText(text) {
  let s = String(text || '');
  if (!s || !/@@ACM_FILE:/.test(s)) return s;
  const blocks = [];
  s = s.replace(/@@ACM_FILE:(\{[\s\S]*?\})@@(?:\n(?:📎[^\n]*|生成时间：[^\n]*|（交互式文件[^\n]*）))*/g, (full, json) => {
    try {
      blocks.push(JSON.parse(json));
    } catch {
      blocks.push(null);
    }
    return `\n%%ACM_DEDUP_${blocks.length - 1}%%\n`;
  });
  const keep = dedupeGeneratedFileCards(blocks.filter(Boolean));
  const keepKeys = new Set(
    keep.map((c) => {
      const url = String(c.url || '').trim();
      if (/image/i.test(c.type || '') && url) return `imgurl::${url.replace(/[?#].*$/, '')}`;
      if (/image/i.test(c.type || '')) return 'imgempty';
      return `file::${c.type}|${c.title}|${url}`;
    })
  );
  const used = new Set();
  s = s.replace(/%%ACM_DEDUP_(\d+)%%/g, (_, i) => {
    const c = blocks[Number(i)];
    if (!c) return '';
    const url = String(c.url || '').trim();
    const key =
      /image/i.test(c.type || '') && url
        ? `imgurl::${url.replace(/[?#].*$/, '')}`
        : /image/i.test(c.type || '')
          ? 'imgempty'
          : `file::${c.type}|${c.title}|${url}`;
    if (!keepKeys.has(key) || used.has(key)) return '';
    used.add(key);
    return formatGeneratedFileCardsMarkdown([c]);
  });
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** 去掉千问工具条 / 生图进度条文案 */
function stripQianwenUiChrome(text) {
  let s = String(text || '');
  if (!s) return '';
  s = s.replace(
    /(^|\n)\s*(收起|展开|添加到对话|下载|复制|分享|点赞|踩|重新生成|下载为表格|导出为图片|表格)\s*(?=\n|$)/g,
    '$1'
  );
  // 生图/任务进度：单独一行的 0% / 37% / 100%
  s = s.replace(/(^|\n)\s*\d{1,3}\s*%\s*(?=\n|$)/g, '$1');
  s = s.replace(
    /(^|\n)\s*(生成中|绘制中|加载中|上传中|请稍候|正在生成|生图中)[^\n]{0,20}\s*(?=\n|$)/g,
    '$1'
  );
  // 正文末尾残留的百分比
  s = s.replace(/\s+\d{1,3}\s*%\s*$/g, '');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 文末推荐墙：从尾部连续撕掉推荐标题/账号名；
 * 绝不把「带？的短标题」当成真正文（否则 lastProse 会被推到墙末尾导致清不掉）。
 */
function stripQianwenTrailingRecommendWall(text) {
  const raw = String(text || '');
  if (!raw.trim()) return '';
  const lines = raw.split(/\n/);
  if (lines.length < 2) return raw.trim();

  const isMedia = (t) => /^@@ACM_FILE:/.test(t) || /^!\[/.test(t) || /^\|/.test(t);
  const isRealProse = (t) => {
    if (!t || isMedia(t)) return false;
    if (typeof isQianwenRecommendCardLine === 'function' && isQianwenRecommendCardLine(t)) {
      return false;
    }
    // 短问句/无句号短标题：一律不当真正文
    if (t.length <= 50 && /[？?]$/.test(t) && !/[。]/.test(t)) return false;
    if (t.length <= 42 && /[，、]/.test(t) && !/[。]/.test(t)) return false;
    if (/^(\d+\.|[-*+]\s|#{1,6}\s)/.test(t) && t.length > 8) return true;
    if (/[。]/.test(t) && t.length >= 18) return true;
    if (
      t.length >= 36 &&
      /[。；]/.test(t) &&
      !/^[？?]/.test(t)
    ) {
      return true;
    }
    if (
      /你现在是遇到了|如果愿意|可以说说看|我们一起探讨|方便告诉我|这就为您|为确保完全符合|最后，请给自己/.test(
        t
      )
    ) {
      return true;
    }
    return false;
  };

  // 1) 从文末连续删除推荐行
  let cut = lines.length;
  let streak = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) {
      if (streak > 0) {
        cut = i;
        continue;
      }
      break;
    }
    if (isMedia(t)) break;
    const recommend =
      (typeof isQianwenRecommendCardLine === 'function' && isQianwenRecommendCardLine(t)) ||
      (t.length <= 50 && /[？?]$/.test(t) && !/[。]/.test(t)) ||
      (t.length <= 18 && !/[。；]/.test(t));
    if (recommend) {
      streak += 1;
      cut = i;
      continue;
    }
    break;
  }
  let out = streak >= 2 ? lines.slice(0, cut) : lines.slice();

  // 2) 再按「最后真正文」截尾（防止漏网短行）
  let lastProse = -1;
  for (let i = 0; i < out.length; i++) {
    const t = out[i].trim();
    if (!t) continue;
    if (isMedia(t) || isRealProse(t)) lastProse = i;
  }
  if (lastProse >= 0 && lastProse < out.length - 1) {
    const tail = out
      .slice(lastProse + 1)
      .map((l) => l.trim())
      .filter(Boolean);
    const junk = tail.filter((t) => {
      if (isMedia(t)) return false;
      if (isRealProse(t)) return false;
      return (
        (typeof isQianwenRecommendCardLine === 'function' && isQianwenRecommendCardLine(t)) ||
        t.length <= 72
      );
    });
    if (junk.length >= 2 && junk.length >= Math.ceil(tail.length * 0.5)) {
      out = out.slice(0, lastProse + 1);
    }
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 正文里已出现的卡片标题去掉，避免「大纲|xxx」纯文本与文件卡重复 */
function dedupeQianwenCardTitlesInText(text, cards) {
  let s = String(text || '');
  if (!s || !Array.isArray(cards) || !cards.length) return s;
  for (const c of cards) {
    const title = String(c?.title || '').trim();
    if (!title || title.length < 4) continue;
    const esc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`(^|\\n)\\s*\\*?\\*?${esc}\\*?\\*?\\s*(?=\\n|$)`, 'g'), '$1');
    if (c.generatedAt) {
      const ga = String(c.generatedAt).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      s = s.replace(new RegExp(`(^|\\n)\\s*创建于\\s*${ga}\\s*(?=\\n|$)`, 'g'), '$1');
      s = s.replace(new RegExp(`(^|\\n)\\s*生成时间：\\s*${ga}\\s*(?=\\n|$)`, 'g'), '$1');
    }
  }
  // 残留「创建于 MM-DD HH:MM」孤立行
  s = s.replace(/(^|\n)\s*创建于\s*\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}\s*(?=\n|$)/g, '$1');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** 把 Markdown 图 / 文件名行 / 大纲卡 / 「文档已生成」提升为统一 ACM_FILE 卡片 */
function promoteFilenameLinesToFileCards(text) {
  let s = String(text || '');
  if (!s) return '';

  const hasUrl = (url) => {
    if (!url) return false;
    return s.includes(url) && /@@ACM_FILE:/.test(s) && s.includes(`"url":"${url}"`);
  };

  // ![alt](https...) → 图片卡（与豆包等平台统一）
  s = s.replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, (full, alt, url) => {
    const u = String(url || '').trim();
    if (!u) return '';
    if (/bili_|quark|recommend|icon|avatar|logo|emoji/i.test(`${alt} ${u}`)) return '';
    if (hasUrl(u) || s.includes(`"url":"${u}"`)) return '';
    const meta = {
      kind: 'file',
      type: 'image',
      title: String(alt || '图片').trim().slice(0, 80) || '图片',
      generatedAt: '',
      url: u
    };
    return `\n@@ACM_FILE:${JSON.stringify(meta)}@@\n`;
  });
  // blob: 图 → 无 URL 图片卡（侧栏提示回原对话查看）
  s = s.replace(/!\[([^\]]*)\]\((blob:[^)\s]+)\)/g, (full, alt) => {
    if (/@@ACM_FILE:\{[^}]*"type":"image"/.test(s)) return '';
    const meta = {
      kind: 'file',
      type: 'image',
      title: String(alt || '图片').trim().slice(0, 80) || '图片',
      generatedAt: '',
      url: ''
    };
    return `\n@@ACM_FILE:${JSON.stringify(meta)}@@\n`;
  });

  const re =
    /(^|\n)\s*文件名\s*[：:]\s*([^\n]+?\.(?:docx?|pdf|xlsx?|pptx?|zip|txt|csv|md|png|jpe?g|gif|webp))\s*(?=\n|$)/gi;
  s = s.replace(re, (_, lead, name) => {
    const title = String(name || '').trim();
    if (!title) return _;
    if (s.includes(`"title":"${title}"`) && /@@ACM_FILE:/.test(s)) return lead;
    const isImage = /\.(png|jpe?g|gif|webp)$/i.test(title);
    const meta = {
      kind: 'file',
      type: isImage ? 'image' : 'document',
      title,
      generatedAt: '',
      url: ''
    };
    return `${lead}\n@@ACM_FILE:${JSON.stringify(meta)}@@\n📎 **${title}**\n（交互式文件请在原对话中打开查看）\n`;
  });

  // 大纲 | 标题 \n 创建于 xx
  s = s.replace(
    /(^|\n)\s*\*{0,2}((?:大纲|论文|文档|PPT|报告)\s*\|\s*[^\n*]{2,40})\*{0,2}\s*\n+\s*创建于\s*([\d/\-.\s:]+)\s*(?=\n|$)/g,
    (full, lead, title, time) => {
      const meta = {
        kind: 'file',
        type: 'document',
        title: String(title || '').trim(),
        generatedAt: String(time || '').trim(),
        url: ''
      };
      return `${lead}\n@@ACM_FILE:${JSON.stringify(meta)}@@\n📎 **${meta.title}**\n生成时间：${meta.generatedAt}\n（交互式文件请在原对话中打开查看）\n`;
    }
  );

  // 千问：已为您生成文件：《xxx》.docx
  s = s.replace(
    /(^|\n)([^\n]*已为您生成(?:相关)?文件[：:，,\s]*)[《「]?([^\n》」]+?\.(?:docx?|pdf|xlsx?|pptx?))[》」]?\s*(?=\n|$)/gi,
    (full, lead, prefix, name) => {
      const title = String(name || '').trim();
      if (!title) return full;
      if (s.includes(`"title":${JSON.stringify(title)}`)) return `${lead}${prefix}《${title}》`;
      const meta = {
        kind: 'file',
        type: 'document',
        title,
        generatedAt: '',
        url: ''
      };
      return `${lead}${prefix}《${title}》\n@@ACM_FILE:${JSON.stringify(meta)}@@\n📎 **${title}**\n（交互式文件请在原对话中打开查看）\n`;
    }
  );

  // 孤立 《文件名.docx》
  s = s.replace(
    /(^|\n)\s*[《「]([^\n》」]+?\.(?:docx?|pdf|xlsx?|pptx?))[》」]\s*(?=\n|$)/gi,
    (full, lead, name) => {
      const title = String(name || '').trim();
      if (!title) return full;
      if (s.includes(`"title":${JSON.stringify(title)}`)) return full;
      const meta = {
        kind: 'file',
        type: 'document',
        title,
        generatedAt: '',
        url: ''
      };
      return `${lead}\n@@ACM_FILE:${JSON.stringify(meta)}@@\n📎 **${title}**\n（交互式文件请在原对话中打开查看）\n`;
    }
  );

  // 千问：Word/PPT「文档已生成完毕」——正文里没有文件名时也出卡
  s = s.replace(
    /(^|\n)([^\n]{0,100}?(?:Word\s*)?(?:PPT\s*)?(?:Excel\s*)?(?:PDF\s*)?(?:文档|表格|幻灯片)?已生成完毕[^\n]{0,50})(?=\n|$)/gi,
    (full, lead, line) => {
      const t = String(line || '').trim();
      if (!t) return full;
      let type = 'document';
      let title = '生成文档';
      if (/PPT|幻灯/i.test(t)) {
        type = 'presentation';
        title = 'PPT';
      } else if (/Excel|表格/i.test(t)) {
        type = 'spreadsheet';
        title = '表格';
      } else if (/Word/i.test(t)) {
        title = 'Word 文档';
      } else if (/PDF/i.test(t)) {
        title = 'PDF 文档';
      }
      if (s.includes(`"title":${JSON.stringify(title)}`)) return `${lead}${t}`;
      const meta = { kind: 'file', type, title, generatedAt: '', url: '' };
      return `${lead}${t}\n@@ACM_FILE:${JSON.stringify(meta)}@@\n📎 **${title}**\n（交互式文件请在原对话中打开查看）\n`;
    }
  );

  return dedupeAcmFileCardsInText(stripQianwenUiChrome(s.replace(/\n{3,}/g, '\n\n').trim()));
}

/** 把卡片列表并入正文（缺啥补啥，不覆盖已有） */
function mergeFileCardsIntoContent(content, cards) {
  let out = String(content || '').trim();
  if (!Array.isArray(cards) || !cards.length) {
    out =
      typeof promoteFilenameLinesToFileCards === 'function'
        ? promoteFilenameLinesToFileCards(out)
        : out;
    return dedupeAcmFileCardsInText(out);
  }
  if (typeof dedupeQianwenCardTitlesInText === 'function') {
    out = dedupeQianwenCardTitlesInText(out, cards);
  }
  const missing = dedupeGeneratedFileCards(cards).filter((c) => {
    if (!c) return false;
    if (c.url && out.includes(c.url)) return false;
    if (/image/i.test(c.type || '') && /"type":"image"/.test(out) && c.url && out.includes(c.url)) {
      return false;
    }
    if (/image/i.test(c.type || '') && /"type":"image"/.test(out) && !c.url) return false;
    if (c.title && out.includes(`"title":${JSON.stringify(c.title)}`) && !c.url) return false;
    return true;
  });
  if (missing.length && typeof formatGeneratedFileCardsMarkdown === 'function') {
    const block = formatGeneratedFileCardsMarkdown(missing);
    if (block) out = out ? `${out}\n\n${block}` : block;
  }
  out = promoteFilenameLinesToFileCards(out);
  return dedupeAcmFileCardsInText(out);
}

/** 是否像正常代码/网页源码（勿当 CSS 泄漏清掉） */
function looksLikeProgrammingCode(text) {
  const s = String(text || '');
  if (!s || s.length < 20) return false;
  if (/```[\w+-]*\r?\n[\s\S]{15,}```/.test(s)) return true;
  if (
    /(?:^|\n)\s*(?:function\b|const\b|let\b|var\b|class\b|def\b|async\s+function\b|export\s+|import\s+|from\s+['"]|#include\b|package\s+\w+|public\s+class\b)/.test(
      s
    )
  ) {
    return true;
  }
  if (/\bdocument\.(?:getElementById|querySelector|createElement|addEventListener)\b/.test(s)) {
    return true;
  }
  if (/<\/?(?:html|head|body|div|button|input|script|style|span)\b/i.test(s) && /[{};=]/.test(s)) {
    return true;
  }
  if (/\b(?:console\.log|window\.|addEventListener|innerHTML|onclick)\b/.test(s)) return true;
  return false;
}

/** 是否像 CSS / 构建产物泄漏进正文 */
function isCssOrStyleLeakText(text) {
  const s = String(text || '');
  if (!s || s.length < 40) return false;
  // 正常代码/HTML 不当泄漏
  if (looksLikeProgrammingCode(s)) return false;
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
  if (looksLikeProgrammingCode(s)) return false;
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
    !/[\u4e00-\u9fff]{20}/.test(s.slice(0, 400)) &&
    !looksLikeProgrammingCode(s)
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
  } else if (
    /(?:已为您生成|生成了).{0,12}文档|(?:^|[\s「])文档(?:[\s」]|$)|文件名\s*[：:].+\.pdf|\.pdf(\?|$)/i.test(
      s
    )
  ) {
    // 勿用裸 document（会误伤 document.getElementById 代码）
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
  // 代码/HTML 源码原样保留，禁止误换成「文档」卡
  if (looksLikeProgrammingCode(s)) return s;
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
    if (looksLikeProgrammingCode(text)) return String(text || '').trim();
    return formatGeneratedFileCardsMarkdown([guessGeneratedFileMetaFromText(text)]);
  }
  if (hadJunk && s.trim()) {
    if (looksLikeProgrammingCode(s)) return s;
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
  globalThis.simpleHtmlToMarkdown = simpleHtmlToMarkdown;
  globalThis.fixOrderedListMarkdown = fixOrderedListMarkdown;
  globalThis.repairBrokenMarkdown = repairBrokenMarkdown;
  globalThis.isBrokenMarkdown = isBrokenMarkdown;
  globalThis.pickRicherMarkdown = pickRicherMarkdown;
  globalThis.scoreMarkdownStructure = scoreMarkdownStructure;
  globalThis.htmlOrTextToMarkdown = htmlOrTextToMarkdown;
  globalThis.tableToMarkdown = tableToMarkdown;
  globalThis.convertTablesInPlace = convertTablesInPlace;
  globalThis.hasMarkdownTable = hasMarkdownTable;
  globalThis.looksLikeMashedTable = looksLikeMashedTable;
  globalThis.promoteFilenameLinesToFileCards = promoteFilenameLinesToFileCards;
  globalThis.mergeFileCardsIntoContent = mergeFileCardsIntoContent;
  globalThis.stripQianwenUiChrome = stripQianwenUiChrome;
  globalThis.stripQianwenTrailingRecommendWall = stripQianwenTrailingRecommendWall;
  globalThis.dedupeQianwenCardTitlesInText = dedupeQianwenCardTitlesInText;
  globalThis.waitForStableContent = waitForStableContent;
  globalThis.normalizeMatchText = normalizeMatchText;
  globalThis.ensureHighlightStyle = ensureHighlightStyle;
  globalThis.sleep = sleep;
  globalThis.stripCssLeakText = stripCssLeakText;
  globalThis.isCssOrStyleLeakText = isCssOrStyleLeakText;
  globalThis.isStructuredCardJunkText = isStructuredCardJunkText;
  globalThis.sanitizeAssistantContentForSave = sanitizeAssistantContentForSave;
  globalThis.looksLikeProgrammingCode = looksLikeProgrammingCode;
  globalThis.formatGeneratedFileCardsMarkdown = formatGeneratedFileCardsMarkdown;
  globalThis.extractGeneratedFileCardsFromDom = extractGeneratedFileCardsFromDom;
  globalThis.dedupeGeneratedFileCards = dedupeGeneratedFileCards;
  globalThis.dedupeAcmFileCardsInText = dedupeAcmFileCardsInText;
  globalThis.guessGeneratedFileMetaFromText = guessGeneratedFileMetaFromText;
  globalThis.revealCollapsedContentInDom = revealCollapsedContentInDom;
}
