/**
 * 通义千问：三级兜底（对齐 DeepSeek/豆包）
 * 1) 页面内存 chatRounds（MAIN，不依赖 DNS）
 * 2) chat2-api 官方历史
 * 3) 适配器 DOM（qk-markdown）
 * 注意：www.qianwen.com 同源没有 /api/v1/session/msg/list（会 404），不要当兜底
 */
function getQianwenSessionIdFromLocation() {
  const path = location.pathname || '';
  const hash = location.hash || '';
  const patterns = [
    /\/chat\/([0-9a-zA-Z_-]{8,})/i,
    /\/s\/([0-9a-f-]{16,})/i,
    /\/session\/([0-9a-f-]{16,})/i,
    /[?&#]session[_-]?id=([0-9a-zA-Z_-]{8,})/i
  ];
  for (const re of patterns) {
    const m = path.match(re) || hash.match(re) || location.href.match(re);
    if (m && m[1] && m[1].toLowerCase() !== 'new') return m[1];
  }
  const q = new URLSearchParams(location.search);
  return q.get('session_id') || q.get('sessionId') || null;
}

function getQianwenSessionId() {
  // URL 永远优先；禁止用旧缓存顶掉新对话
  const fromUrl = getQianwenSessionIdFromLocation();
  if (fromUrl) {
    window.__acmQianwenSessionIdCache = fromUrl;
    return fromUrl;
  }
  return window.__acmQianwenSessionIdCache || null;
}

async function resolveQianwenSessionId() {
  const fromUrl = getQianwenSessionIdFromLocation();
  if (fromUrl) {
    window.__acmQianwenSessionIdCache = fromUrl;
    return fromUrl;
  }
  try {
    const page = await requestQianwenPageState();
    if (page?.sessionId) {
      window.__acmQianwenSessionIdCache = page.sessionId;
      return page.sessionId;
    }
  } catch {
    // ignore
  }
  // 无 URL、无页面状态：清空脏缓存，避免串台
  window.__acmQianwenSessionIdCache = null;
  return null;
}

function getQianwenUt() {
  try {
    const m = document.cookie.match(/(?:^|;\s*)b-user-id=([^;]+)/);
    if (m?.[1]) return decodeURIComponent(m[1]);
  } catch {
    // ignore
  }
  try {
    const live = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .reverse()
      .find((u) => /chat2-api[^/]*\.qianwen\.com/i.test(u) && /[?&]ut=/.test(u));
    if (live) return new URL(live).searchParams.get('ut');
  } catch {
    // ignore
  }
  return '';
}

function discoverQianwenApiOrigins() {
  const found = [];
  try {
    for (const e of performance.getEntriesByType('resource')) {
      try {
        const u = new URL(e.name);
        if (/chat2-api[^/]*\.qianwen\.com$/i.test(u.host)) {
          const origin = u.origin;
          if (!found.includes(origin)) found.push(origin);
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  const defaults = [
    'https://chat2-api.qianwen.com',
    'https://chat2-api-router.qianwen.com',
    'https://chat2-api-na.qianwen.com'
  ];
  for (const d of defaults) {
    if (!found.includes(d)) found.push(d);
  }
  return found;
}

/** 非对话正文的结构类型（跳过，不是改写正文） */
function isQianwenNonTextType(type, cardCode, pluginCode) {
  const t = String(type || '').toLowerCase();
  const card = String(cardCode || '').toLowerCase();
  const plugin = String(pluginCode || '').toLowerCase();

  if (/recommend|reference|knowledge|quark|media.?card|pc.?card|reftext|ref_text|paa/i.test(card + plugin + t)) {
    return true;
  }
  if (/deep.?think|think|planning|ppt|aippt|wanx|quark|search|gaokao|zhiyuan|plugin/i.test(card)) {
    return true;
  }
  if (/deep.?think|think|planning|search|gaokao|zhiyuan/i.test(plugin)) {
    return true;
  }
  if (/image|video|audio|iframe/.test(t)) return true;

  // 允许 text / 写作文档类；card 仅拦推荐检索
  if (t && !/^(text|text2image|markdown|plain|document|writing|file|report)$/i.test(t)) {
    if (/^card$/i.test(t)) {
      return /recommend|quark|paa|search|ref|gaokao|zhiyuan/i.test(card + plugin);
    }
    return true;
  }
  return false;
}

/** 结构化卡片 / JSON 脏数据（志愿报告等），不能当正文展示 */
function isQianwenStructuredJunk(text) {
  const s = String(text || '').trim();
  if (!s) return true;

  // CSS / 构建产物泄漏
  if (
    /sourceMappingURL|\.css\.map|card_card_gaokao_zhiyuan_report|zhiyuan-report-card-|progressWrap-|progressTrack-|progressBar-/.test(
      s
    )
  ) {
    return true;
  }
  if (
    (s.match(/[{};]/g) || []).length > 20 &&
    /margin|padding|border-radius|background|flex\s*:/.test(s) &&
    s.length > 150
  ) {
    return true;
  }

  // 含卡片特征字段即判脏（不一定整段以 { 开头）
  if (
    /"gaokao_choice_report"|gaokao_choice_report|"zhiyuan_table"|"zhiyuan_list"|"initialData"|"school_prob"|"new_major_group_id"|"new_major_id"|"major_prob"/.test(
      s
    )
  ) {
    // 短提及可放过；大段或 JSON 形态则干掉
    if (s.length > 120 || /^\s*[\{\[]/.test(s) || s.includes('"reqId"')) return true;
  }

  if (!s.startsWith('{') && !s.startsWith('[')) return false;

  if (s.length > 80) {
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') {
        if (o.type === 'gaokao_choice_report' || o?.data?.initialData || o?.zhiyuan_table) {
          return true;
        }
        if (o.data && typeof o.data === 'object') return true;
        if (o.reqId && o.content) return true;
      }
    } catch {
      if (/"data"\s*:\s*\{/.test(s) && s.length > 150) return true;
      if (/"reqId"\s*:/.test(s) && s.length > 150) return true;
    }
  }
  return false;
}

/** 从混排正文中剔除 JSON 卡片块，保留自然语言 */
function stripQianwenStructuredJson(text) {
  let s = String(text || '');
  if (!s) return '';
  if (!/[\{\[]/.test(s)) return s;

  let out = '';
  for (let i = 0; i < s.length; ) {
    const ch = s[i];
    if (ch !== '{' && ch !== '[') {
      out += ch;
      i += 1;
      continue;
    }
    const open = ch;
    const close = ch === '{' ? '}' : ']';
    let depth = 0;
    let j = i;
    let inStr = false;
    let esc = false;
    for (; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === open) depth += 1;
      else if (c === close) {
        depth -= 1;
        if (depth === 0) {
          const chunk = s.slice(i, j + 1);
          if (!isQianwenStructuredJunk(chunk)) out += chunk;
          i = j + 1;
          break;
        }
      }
    }
    if (j >= s.length) {
      // 未闭合：若像卡片 JSON 则丢弃尾部
      const tail = s.slice(i);
      if (!isQianwenStructuredJunk(tail) && !/"reqId"|"zhiyuan_table"|"initialData"/.test(tail)) {
        out += tail;
      }
      break;
    }
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** 是否像「思考过程 / 检索计划」碎片（不是最终回答） */
function isQianwenThinkingFragment(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return true;
  if (isQianwenStructuredJunk(text)) return true;
  if (/^(已完成思考|Finished thinking|Thinking\.\.\.|正在思考)/i.test(s)) return true;
  if (/参考了\s*\d+\s*篇材料/.test(s) && s.length < 80) return true;
  if (
    /(明确选择问题|搜索\s*\d+\s*个关键词|site_name|web_search|deep_thinking)/i.test(s) &&
    !/(^|\n)\s*([一二三四五六七八九十]+[、．.]|#{1,3}\s+)/.test(String(text))
  ) {
    return true;
  }
  if (/^(用户想|用户希望|我先|接下来我将|当前已查)/i.test(s) && s.length < 500) return true;
  return false;
}

/**
 * 去掉回答开头的思考过程外壳。绝不切片改写正文（避免截断「想要…」这类正常开场）。
 */
function stripQianwenThinkingProcess(text) {
  let s = stripQianwenStructuredJson(String(text || '').trim());
  if (!s) return '';

  // 只删明确的思考壳行，不动正文
  s = s.replace(/^(?:已完成思考|Finished thinking)[^\n]*\n+/i, '');
  s = s.replace(/^参考了\s*\d+\s*篇材料[^\n]*\n+/i, '');
  // 连续多行检索/思考计划前缀（整行像工具日志才删）
  s = s
    .split('\n')
    .filter((line, idx, arr) => {
      const t = line.replace(/\s+/g, '').trim();
      if (!t) return true;
      if (/^(已完成思考|Finishedthinking|参考了\d+篇材料|表格|下载为表格|导出为图片)$/i.test(t)) {
        return false;
      }
      // 仅删文首几行的明显思考日志，避免误伤正文
      if (
        idx < 8 &&
        /^(明确选择问题|搜索\d+个关键词|site_name|web_search|deep_thinking|用户想知道|用户希望|接下来我将|当前已查)/i.test(
          t
        ) &&
        t.length < 200 &&
        !/想要成为|具体而言|首先|可以|建议/.test(t)
      ) {
        return false;
      }
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return stripQianwenStructuredJson(s);
}

/**
 * 原样抽出文本：不改写语义；HTML 转 Markdown 仅用于保留粗体/表格等格式。
 * 跳过 think/媒体等非回答结构类型。
 * 多段正文按顺序拼接（禁止只取最长一段，否则会截断）。
 */
function extractQianwenText(parts) {
  if (!parts) return '';
  if (typeof parts === 'string') {
    return coerceQianwenContent(parts);
  }
  if (typeof parts === 'number') return String(parts);

  if (!Array.isArray(parts)) {
    if (isQianwenNonTextType(parts.contentType, parts.cardCode, parts.pluginCode)) {
      return '';
    }
    // 志愿报告等结构化对象整棵跳过，避免把 JSON 字段拼进正文
    if (
      parts.type === 'gaokao_choice_report' ||
      parts.zhiyuan_table ||
      parts.zhiyuan_list ||
      parts.initialData ||
      (parts.data && (parts.data.initialData || parts.data.type === 'gaokao_choice_report'))
    ) {
      return '';
    }

    // 先挖嵌套富文本容器，避免顶层短 markdown/content 提前截断
    const nestedKeys = [
      'answerItemModels',
      'qwen_response_messages',
      'response_messages',
      'request_messages',
      'contents',
      'parts',
      'list',
      'blocks',
      'items'
    ];
    const nestedBits = [];
    for (const k of nestedKeys) {
      if (parts[k] == null) continue;
      const t = extractQianwenText(parts[k]);
      if (t && !isQianwenStructuredJunk(t)) nestedBits.push(t);
    }
    if (nestedBits.length) {
      return stripQianwenThinkingProcess(nestedBits.join('\n\n'));
    }

    if (typeof parts.markdown === 'string' && parts.markdown.trim()) {
      return coerceQianwenContent(parts.markdown);
    }
    if (typeof parts.content === 'string' && parts.content.trim()) {
      return coerceQianwenContent(parts.content);
    }
    if (typeof parts.text === 'string' && parts.text.trim()) {
      return coerceQianwenContent(parts.text);
    }
    if (parts.content && typeof parts.content === 'object') {
      // 对象 content 若是卡片数据则跳过
      if (
        parts.content.zhiyuan_table ||
        parts.content.zhiyuan_list ||
        parts.content.type === 'gaokao_choice_report'
      ) {
        return '';
      }
      return extractQianwenText(parts.content);
    }
    return '';
  }

  const texts = [];
  for (const p of parts) {
    if (typeof p === 'string') {
      const s = coerceQianwenContent(p);
      if (s && !isQianwenThinkingFragment(s) && !isQianwenStructuredJunk(s)) texts.push(s);
      continue;
    }
    if (!p || typeof p !== 'object') continue;
    if (isQianwenNonTextType(p.contentType, p.cardCode, p.pluginCode)) continue;
    const type = String(p.contentType || p.mime_type || p.type || '').toLowerCase();
    if (/image|video|audio|iframe|gaokao/.test(type)) continue;
    // card/report：仍尝试抽内嵌文本（写作概要常挂在这类节点）；纯推荐卡由 isQianwenNonTextType 拦
    if (/^(card)$/i.test(type) && /recommend|quark|paa|search|ref/i.test(String(p.cardCode || ''))) {
      continue;
    }
    const piece = extractQianwenText(p);
    const s = coerceQianwenContent(piece);
    if (s && !isQianwenThinkingFragment(s) && !isQianwenStructuredJunk(s)) texts.push(s);
  }
  if (!texts.length) return '';
  // 去重保序；丢掉检索墙段，优先保留「已为您生成 / 论文概要 / 列表」真回答
  const uniq = [];
  const seen = new Set();
  for (const t of texts) {
    if (isQianwenStructuredJunk(t)) continue;
    if (looksLikeQianwenSearchResultWall(t)) continue;
    const key = t.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(t);
  }
  let pool = uniq;
  if (!pool.length) {
    // 全是墙时再回退，避免空回答（后续 normalize 仍可能丢掉）
    for (const t of texts) {
      if (isQianwenStructuredJunk(t)) continue;
      const key = t.replace(/\s+/g, ' ').trim().slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push(t);
    }
  }
  if (pool.length > 1) {
    const scored = pool.map((t) => ({ t, s: scoreQianwenAnswerPiece(t) }));
    const best = Math.max(...scored.map((x) => x.s));
    if (best >= 30) {
      pool = scored.filter((x) => x.s >= 20).map((x) => x.t);
    }
  }
  return stripQianwenThinkingProcess(pool.join('\n\n'));
}

function coerceQianwenContent(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (isQianwenStructuredJunk(s)) return '';
  let out = s;
  if (typeof htmlOrTextToMarkdown === 'function') {
    out = htmlOrTextToMarkdown(s);
  }
  if (isQianwenStructuredJunk(out)) return '';
  return out;
}

/**
 * 千问常把「一句一段」渲成视觉段落，但状态里是无换行长文。
 * 注意：禁止按句号「发明」换行（会改写 AI 原文结构）。格式只能来自 DOM/Markdown。
 */
function ensureQianwenParagraphBreaks(text) {
  return String(text || '').trim();
}

/** 检索结果标题墙（报告/蓝皮书堆叠，常被误当成助手正文） */
function looksLikeQianwenSearchResultWall(text) {
  const t = String(text || '');
  if (!t || t.length < 40) return false;
  // 真回答特征：有这些则不当整段检索墙
  if (/已为您生成|论文概要|这就为您|Qwen-Image|@@ACM_FILE:/.test(t) && /[。]/.test(t)) {
    return false;
  }
  const reportHits = (
    t.match(/20\d{2}[^\n。]{0,20}(趋势|报告|蓝皮书|白皮书|行业发展|大模型)/g) || []
  ).length;
  if (reportHits >= 3) return true;
  const mdLinks = t.match(/\[[^\]]{4,50}\]\(https?:[^)]+\)/g) || [];
  if (mdLinks.length >= 4) return true;
  // 裸链标题密堆积
  const lines = t
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length >= 4) {
    const titleLike = lines.filter(
      (l) =>
        l.length <= 70 &&
        /20\d{2}|报告|蓝皮书|白皮书|趋势|解读|行动路线/.test(l) &&
        !/[。]/.test(l)
    );
    if (titleLike.length >= 3 && titleLike.length >= Math.ceil(lines.length * 0.5)) {
      return true;
    }
  }
  return false;
}

/** 推荐卡 / 检索引用墙（必须强特征，禁止把正常育儿/论文回答误判成墙） */
function looksLikeQianwenCardSoup(text) {
  const t = String(text || '');
  if (!t) return false;
  if (looksLikeQianwenSearchResultWall(t)) return true;
  if (/bili_\w+/i.test(t)) return true;
  if ((t.match(/#/g) || []).length >= 3) return true;

  // 检索/资讯墙：多条短引号标题
  const quoted = t.match(/[“"][^”"\n]{4,50}[”"]/g) || [];
  const shortQuoted = quoted.filter((q) => q.length <= 44);
  if (shortQuoted.length >= 3) return true;
  if (/专家解读\s*\||权威发布\s*\|/.test(t) && shortQuoted.length >= 2) return true;

  // 多行短标题墙（推荐卡片文案）
  const lines = t
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length >= 4) {
    const rec = lines.filter((l) => isQianwenRecommendCardLine(l));
    if (rec.length >= 3 && rec.length >= Math.ceil(lines.length * 0.55)) return true;
  }

  // 纯推荐账号/栏目名拼盘（几乎无句号）
  if (
    t.length < 220 &&
    !/[。]/.test(t) &&
    /情感能量棒|恋爱能量收集|豆豆妈育儿|秒懂：|直击心灵|清华护肤学长|清醒记录仪|情绪收纳箱|治愈系心灵屋|营薛心灵|苔藓心灵|素素社会/.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

/** 一段候选正文的「像真回答」分，用于多段拼接时丢掉检索墙 */
function scoreQianwenAnswerPiece(text) {
  const s = String(text || '');
  if (!s) return -100;
  let n = 0;
  if (/已为您生成|论文概要|相关文件|这就为您/.test(s)) n += 60;
  if (/《[^》]+\.(docx?|pdf|xlsx?|pptx?)》|\.docx/i.test(s)) n += 40;
  if ((s.match(/^\d+\.\s/gm) || []).length >= 2) n += 30;
  if (/[。]/.test(s)) n += 8;
  if (/\*\*[^*\n]+\*\*/.test(s)) n += 6;
  if (looksLikeQianwenSearchResultWall(s)) n -= 100;
  if (looksLikeQianwenCardSoup(s) && !/已为您生成|论文概要/.test(s)) n -= 50;
  return n;
}

/** 清完墙后几乎不剩论述 → 才视为「整段是墙」 */
function isQianwenMostlyCardSoup(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (/@@ACM_FILE:|已为您生成|论文概要|这就为您|Qwen-Image/.test(raw)) return false;
  if (!looksLikeQianwenCardSoup(raw)) return false;
  const stripped =
    typeof stripQianwenCardSoup === 'function' ? stripQianwenCardSoup(raw) : raw;
  if (stripped.length >= 80 && /[。]/.test(stripped)) return false;
  if (stripped.length >= Math.max(60, raw.length * 0.45)) return false;
  return stripped.length < 48 || looksLikeQianwenCardSoup(stripped);
}

/** 是否像千问助手口吻（用于纠正角色串台） */
function looksLikeQianwenAssistantVoice(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (
    /^(没问题|好的[，,]|已为您|这就为您|我来帮|当然可以|根据您|可以的|收到[，,]|没问题[，！!])/.test(
      t
    )
  ) {
    return true;
  }
  if (/Qwen-Image|已为您生成|论文概要|本次使用.+模型|霸气女王范/.test(t)) return true;
  if (/^#{1,3}\s|^\d+\.\s.+\n\d+\.\s/m.test(t) && t.length > 120) return true;
  return false;
}

/**
 * 助手正文是否像「折叠/截断稿」（句中突然结束）。
 * 用于避免用半截 DOM 覆盖完整 API/状态正文。
 */
function looksLikeTruncatedAssistantText(text) {
  const s = String(text || '').replace(/\s+$/g, '');
  if (!s || s.length < 48) return false;
  const tail = s.slice(-48);
  if (/@@ACM_FILE:/.test(tail)) return false;
  if (/[。！？…」』”）)\]]$/.test(s)) return false;
  if (/\|\s*$/.test(s) && /\|/.test(s)) return false;
  // 未闭合引号
  if (/[“「『"][^”」』"]*$/.test(tail)) return true;
  // 介词/结构助词收尾，像话没说完
  if (/[到的了与和从是在把被让给用其及或而]$/.test(s)) return true;
  // 标题/列表起了个头就断了
  if (/\d+\.\s*\S{0,20}$/.test(s) && !/[。！？]/.test(tail)) return true;
  // 末尾无句末标点，且落在明显半截语气上
  if (
    s.length >= 120 &&
    !/[。！？\n]/.test(s.slice(-30)) &&
    (/[到的了与和从是在把被让给用其及或而，“「]$/.test(s) || /[：:]\s*\S{0,12}$/.test(s))
  ) {
    return true;
  }
  return false;
}

/** short 归一化后是否为 long 的前缀残片 */
function isQianwenContentPrefixOf(shortText, longText) {
  const a = String(shortText || '')
    .replace(/\s+/g, '')
    .replace(/@@ACM_FILE:\{[\s\S]*?\}@@/g, '');
  const b = String(longText || '')
    .replace(/\s+/g, '')
    .replace(/@@ACM_FILE:\{[\s\S]*?\}@@/g, '');
  if (a.length < 60 || b.length <= a.length + 24) return false;
  const probe = a.slice(0, Math.min(120, a.length));
  return b.startsWith(probe) || b.includes(probe);
}

/** 单行是否像推荐卡标题或账号名 */
function isQianwenRecommendCardLine(line) {
  const t = String(line || '').trim();
  if (!t || t.length > 72) return false;
  if (/^(\d+\.|[-*+]|#{1,6}|@@ACM_FILE:|\|)/.test(t)) return false;
  if (/@@ACM_FILE:|!\[[^\]]*\]\(/.test(t)) return false;
  if (/^(收起|展开|添加到对话|下载|复制|分享)$/.test(t)) return true;
  // 完整论述句（有句号且较长）不是卡
  if (/[。]/.test(t) && t.length > 28) return false;
  if (
    /你现在是遇到了|如果愿意|可以说说看|我们一起探讨|最后，请给自己|方便告诉我|这就为您|为确保完全符合/.test(
      t
    )
  ) {
    return false;
  }
  if (
    /^(秒懂：|直击心灵|想做个好父母|如何做赋能型父母|父母核心准则|做个好父母|情感能量棒|恋爱能量收集站|豆豆妈育儿分享|营薛心灵拓印集|苔藓心灵拓印集|素素社会备忘录|合格的父母|足够好|清华护肤学长|清醒记录仪|情绪收纳箱|治愈系心灵屋|时间流逝前为父母|和父母沟通怎么那么痛苦|好父母的\d+个关键词)/i.test(
      t
    )
  ) {
    return true;
  }
  // 推荐墙常见：短问句标题（无句号）——仅很短且像标题
  if (t.length <= 28 && /[？?]$/.test(t) && !/[。]/.test(t)) return true;
  if (t.length <= 28 && /[：:]$/.test(t) && !/文件名|生成时间|创建时间|创建于/.test(t)) return true;
  // 账号 / 短昵称
  if (
    t.length >= 2 &&
    t.length <= 14 &&
    !/[。；;？?]/.test(t) &&
    /^[\u4e00-\u9fffA-Za-z0-9]+$/.test(t) &&
    !/^(首先|其次|然后|另外|总之|因此|所以|比如|例如|注意|建议|最后|补充|一是|二是)/.test(t)
  ) {
    return true;
  }
  return false;
}

/** 从正文里撕掉推荐卡标题碎片，避免拼进 AI 回答 */
function stripQianwenCardSoup(text) {
  let s = String(text || '');
  if (!s) return '';
  s = s.replace(/(?:[^\n#]{0,40}#[\u4e00-\u9fffA-Za-z0-9_]{2,24}){2,}/g, '\n');
  s = s.replace(/\d{2}:\d{2}[^\n]{0,60}bili_\w+/gi, '');
  s = s.replace(/bili_\w+/gi, '');

  if (typeof stripQianwenUiChrome === 'function') {
    s = stripQianwenUiChrome(s);
  } else {
    s = s.replace(
      /(^|\n)\s*(收起|展开|添加到对话|下载|复制|分享|点赞|踩|重新生成)\s*(?=\n|$)/g,
      '$1'
    );
  }

  // 优先：最后一段真正文之后的短行墙整段丢掉
  if (typeof stripQianwenTrailingRecommendWall === 'function') {
    s = stripQianwenTrailingRecommendWall(s);
  } else {
    const lines = s.split(/\n/);
    let cut = lines.length;
    let streak = 0;
    let strongHits = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (!t) {
        if (streak > 0) {
          cut = i;
          continue;
        }
        break;
      }
      if (isQianwenRecommendCardLine(t)) {
        streak += 1;
        if (
          /秒懂：|直击心灵|赋能型|父母核心|情感能量|恋爱能量|豆豆妈|营薛|苔藓|素素|家长必看|做到这|[：:]|[?？!]{1,3}$|，/.test(
            t
          )
        ) {
          strongHits += 1;
        }
        cut = i;
        continue;
      }
      break;
    }
    if (streak >= 2 || (streak >= 1 && strongHits >= 1)) {
      s = lines.slice(0, cut).join('\n');
    }
  }

  const lines = s.split(/\n+/);
  const kept = lines.filter((line) => {
    const t = line.trim();
    if (!t) return false;
    if (/^@@ACM_FILE:/.test(t) || /^!\[/.test(t) || /^\|/.test(t)) return true;
    if (isQianwenRecommendCardLine(t)) return false;
    const hashCount = (t.match(/#/g) || []).length;
    if (hashCount >= 2 && t.length < 240) return false;
    if (/\d{2}:\d{2}/.test(t) && /bili_|#/.test(t) && t.length < 100) return false;
    if (/^(收起|展开|添加到对话|下载|复制|分享)$/.test(t)) return false;
    if (/^(秒懂：|直击心灵)/.test(t) && t.length < 60) return false;
    return true;
  });
  return kept.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 版式丰富度：换行 / 标题 / 列表 / 粗体。
 * 评分前先清推荐卡墙，避免「卡片标题\\n\\n卡片标题」伪装成高结构分盖掉真正 Markdown。
 */
function scoreQianwenStructure(text) {
  const t = stripQianwenCardSoup(String(text || ''));
  if (!t.trim()) return -1;
  const body = t
    .replace(/@@ACM_FILE:\{[\s\S]*?\}@@/g, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '');
  if (!body.trim()) return -1;
  let score = 0;
  score += Math.min(80, (body.match(/\n/g) || []).length * 3);
  score += (body.match(/\n\n/g) || []).length * 4;
  score += (body.match(/\*\*[^*\n]+\*\*/g) || []).length * 5;
  score += (body.match(/^#{1,6}\s/gm) || []).length * 10;
  score += (body.match(/^\d+\.\s/gm) || []).length * 12;
  score += (body.match(/^[-*+]\s/gm) || []).length * 4;
  score += (body.match(/^\|.+\|/gm) || []).length * 10;
  if (/^\|.+\|/m.test(body) && /^\|?\s*:?-{3,}/m.test(body)) score += 40;
  if (
    typeof looksLikeMashedTable === 'function'
      ? looksLikeMashedTable(body)
      : /表格下载为表格|章节内容摘要/.test(body.replace(/\s+/g, ''))
  ) {
    score -= 80;
  }
  // 真 Markdown 加分；纯话题墙 / 超长单行降权
  if (!/\n/.test(body) && body.length > 160) score -= 60;
  if (looksLikeQianwenCardSoup(body)) score -= 80;
  // 大量短行且几乎无列表/粗体 → 多半是卡标题碎片
  const lines = body.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const shortLines = lines.filter((l) => l.length > 0 && l.length < 42);
  if (
    shortLines.length >= 4 &&
    shortLines.length >= lines.length * 0.45 &&
    !/\*\*|^(\d+\.|[-*+])\s|^#{1,6}\s/m.test(body)
  ) {
    score -= 50;
  }
  score -= Math.min(40, (body.match(/#/g) || []).length * 3);
  return score;
}

function qianwenLacksRichFormat(text) {
  const t = String(text || '');
  if (t.length < 80) return false;
  return scoreQianwenStructure(t) < 12;
}

/** 从千问 parts 中收集图片/视频卡（原先被当成 non-text 直接丢弃） */
function collectQianwenMediaCards(node, depth = 0, out = [], seen = null) {
  const bag = seen || new Set();
  if (!node || depth > 8) return out;
  if (typeof node === 'string') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectQianwenMediaCards(item, depth + 1, out, bag);
    return out;
  }
  if (typeof node !== 'object') return out;

  const type = String(node.contentType || node.type || node.mime_type || '').toLowerCase();
  const card = String(node.cardCode || node.card_code || node.pluginCode || '').toLowerCase();
  const title =
    node.title ||
    node.name ||
    node.alt ||
    node.fileName ||
    node.file_name ||
    node.displayName ||
    '';
  const urlCandidates = [
    node.url,
    node.src,
    node.imageUrl,
    node.image_url,
    node.coverUrl,
    node.cover_url,
    node.thumbnail,
    node.thumbnailUrl,
    node.thumbUrl,
    node.downloadUrl,
    node.download_url,
    node.resourceUrl,
    node.resource_url,
    node.ossUrl,
    node.oss_url,
    node.cdnUrl,
    node.cdn_url,
    node.fileUrl,
    node.file_url,
    node.docUrl,
    node.doc_url,
    node.previewUrl,
    node.preview_url,
    node.resultUrl,
    node.result_url,
    typeof node.image === 'string' ? node.image : null,
    node.image?.url,
    node.image?.src,
    node.content?.url,
    node.content?.imageUrl,
    node.content?.coverUrl,
    node.content?.downloadUrl,
    node.extra?.url,
    node.extraInfo?.url,
    node.meta?.url
  ];
  let url = '';
  for (const u of urlCandidates) {
    if (typeof u === 'string' && /^(https?:|data:image\/)/i.test(u.trim())) {
      url = u.trim();
      break;
    }
  }
  // 数组里的图：images / imageList / results
  if (!url) {
    for (const key of ['images', 'imageList', 'image_list', 'results', 'resultList', 'files', 'fileList']) {
      const arr = node[key];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (typeof item === 'string' && /^(https?:|data:image\/)/i.test(item.trim())) {
          url = item.trim();
          break;
        }
        if (item && typeof item === 'object') {
          for (const k of ['url', 'src', 'imageUrl', 'downloadUrl', 'ossUrl']) {
            const u = item[k];
            if (typeof u === 'string' && /^(https?:|data:image\/)/i.test(u.trim())) {
              url = u.trim();
              break;
            }
          }
        }
        if (url) break;
      }
      if (url) break;
    }
  }

  const looksDocHint =
    /file|doc|pdf|attachment|document|ppt|sheet|excel|writing|outline|artifact|docx?/i.test(
      `${type} ${card}`
    ) ||
    /\.(docx?|pdf|xlsx?|pptx?)(\?|$)/i.test(`${url} ${title}`) ||
    /Word\s*文档|已生成完毕|大纲\s*\|/i.test(String(title));
  const looksImageHint =
    /image|img|text2image|wanx|picture|photo|draw/i.test(`${type} ${card}`) ||
    /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(url + title);
  const looksMedia =
    (!!url && (looksImageHint || looksDocHint || /video|audio|iframe|card/.test(type))) ||
    (looksDocHint &&
      (!!url ||
        /\.(docx?|pdf|xlsx?|pptx?)(\?|$)/i.test(String(title)) ||
        /Word|已生成|大纲\s*\|/i.test(String(title)))) ||
    (looksImageHint && !!url);

  if (looksMedia) {
    let mediaType = /video|mp4|webm|bili/i.test(`${type} ${card} ${url}`)
      ? 'video'
      : looksDocHint && !looksImageHint
        ? /ppt|演示/i.test(`${type} ${card} ${title}`)
          ? 'presentation'
          : /sheet|excel|xls|csv/i.test(`${type} ${card} ${title}`)
            ? 'spreadsheet'
            : 'document'
        : 'image';
    if (!url && mediaType === 'image') {
      mediaType = 'document';
    }
    // 过滤推荐墙
    if (/bili_|quark|recommend|reference|#成长|#情绪/i.test(`${title} ${url} ${card}`)) {
      // skip
    } else {
      const key = `${mediaType}::${url || title}`;
      if (!bag.has(key)) {
        bag.add(key);
        out.push({
          kind: 'file',
          type: mediaType,
          title: String(
            title ||
              (mediaType === 'video'
                ? '视频'
                : mediaType === 'document' || mediaType === 'presentation' || mediaType === 'spreadsheet'
                  ? '文档'
                  : '图片')
          ).slice(0, 80),
          generatedAt: '',
          url: url || ''
        });
      }
    }
  }

  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') collectQianwenMediaCards(v, depth + 1, out, bag);
  }
  return out;
}

function appendQianwenMediaCards(text, partsList) {
  const base = String(text || '').trim();
  const cards = [];
  for (const parts of partsList || []) {
    collectQianwenMediaCards(parts, 0, cards);
  }
  // 过滤推荐墙；保留正文图 / 文档
  const keep = cards.filter((c) => {
    const hint = `${c.type || ''} ${c.title || ''} ${c.url || ''}`;
    if (/bili_|quark|recommend|reference|#成长|#情绪|财经速记|心灵成长/i.test(hint)) {
      return false;
    }
    return true;
  });
  if (typeof mergeFileCardsIntoContent === 'function') {
    return mergeFileCardsIntoContent(base, keep);
  }
  if (!keep.length) {
    return typeof promoteFilenameLinesToFileCards === 'function'
      ? promoteFilenameLinesToFileCards(base)
      : base;
  }
  const block =
    typeof formatGeneratedFileCardsMarkdown === 'function'
      ? formatGeneratedFileCardsMarkdown(keep)
      : '';
  let out = base;
  if (block && !/@@ACM_FILE:/.test(base)) {
    out = base ? `${base}\n\n${block}` : block;
  } else if (block) {
    for (const c of keep) {
      if (c.url && out.includes(c.url)) continue;
      if (c.title && out.includes(`"title":${JSON.stringify(c.title)}`)) continue;
      const one =
        typeof formatGeneratedFileCardsMarkdown === 'function'
          ? formatGeneratedFileCardsMarkdown([c])
          : '';
      if (one) out = out ? `${out}\n\n${one}` : one;
    }
  }
  if (typeof promoteFilenameLinesToFileCards === 'function') {
    out = promoteFilenameLinesToFileCards(out);
  }
  return out;
}

/**
 * 规范化：去思考/JSON 脏数据；强制按轮次 user→assistant 顺序，不打乱
 */
function normalizeQianwenMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) return [];

  const cleaned = [];
  for (const m of messages) {
    if (!m?.content) continue;
    let content = String(m.content).trim();
    if (!content) continue;
    if (isQianwenStructuredJunk(content)) continue;
    let role = m.role === 'user' ? 'user' : 'assistant';
    // 纠正：助手口吻被标成用户
    if (role === 'user' && looksLikeQianwenAssistantVoice(content)) {
      role = 'assistant';
    }
    if (role === 'assistant') {
      if (isQianwenThinkingFragment(content) && content.length < 800) continue;
      content = stripQianwenThinkingProcess(content);
      content = stripQianwenCardSoup(content);
      if (!content || isQianwenStructuredJunk(content)) continue;
      // 仅当清完后仍几乎全是墙时才丢弃（禁止误杀正常育儿长文）
      if (isQianwenMostlyCardSoup(content)) continue;
    } else {
      // 用户提问里偶尔混进推荐碎片：仅短墙丢弃
      if (isQianwenMostlyCardSoup(content) && content.length < 160) continue;
    }
    cleaned.push({
      role,
      content,
      timestamp: m.timestamp || null
    });
  }

  // 同角色相邻：若一段是另一段前缀，保留版式更好的；否则都保留（多轮）
  const pickRicher = (a, b) => {
    const soupA = looksLikeQianwenCardSoup(a);
    const soupB = looksLikeQianwenCardSoup(b);
    if (soupA && !soupB) return b;
    if (soupB && !soupA) return a;
    const sa = scoreQianwenStructure(a);
    const sb = scoreQianwenStructure(b);
    if (sb > sa + 2) return b;
    if (sa > sb + 2) return a;
    return a.length >= b.length ? a : b;
  };

  const collapsed = [];
  for (const m of cleaned) {
    const prev = collapsed[collapsed.length - 1];
    if (!prev) {
      collapsed.push(m);
      continue;
    }
    if (prev.role === m.role) {
      const a = prev.content;
      const b = m.content;
      if (a === b) continue;
      const na = a.replace(/\s+/g, '');
      const nb = b.replace(/\s+/g, '');
      if (na === nb) continue;
      if (
        b.startsWith(a.slice(0, Math.min(120, a.length))) ||
        a.startsWith(b.slice(0, Math.min(120, b.length))) ||
        nb.startsWith(na.slice(0, Math.min(80, na.length))) ||
        na.startsWith(nb.slice(0, Math.min(80, nb.length)))
      ) {
        prev.content = pickRicher(a, b);
        continue;
      }
      // 同角色两段都不像延续：助手优先去卡墙后拼接，避免墙文污染
      if (m.role === 'assistant') {
        if (looksLikeQianwenCardSoup(a) && !looksLikeQianwenCardSoup(b)) {
          prev.content = b;
        } else if (looksLikeQianwenCardSoup(b) && !looksLikeQianwenCardSoup(a)) {
          prev.content = a;
        } else {
          prev.content = `${stripQianwenCardSoup(a)}\n\n${stripQianwenCardSoup(b)}`.trim();
        }
        continue;
      }
    }
    // 用户与助手正文完全相同（角色串台后的重复）
    if (
      prev.role !== m.role &&
      prev.content.replace(/\s+/g, '') === m.content.replace(/\s+/g, '')
    ) {
      if (m.role === 'assistant') {
        prev.role = 'assistant';
        prev.content = m.content;
      }
      continue;
    }
    collapsed.push(m);
  }

  // 若整体不是 user/assistant 交替，按角色分桶再按索引配对
  const users = collapsed.filter((m) => m.role === 'user');
  const assistants = collapsed.filter((m) => m.role === 'assistant');
  if (!users.length || !assistants.length) return collapsed;

  let alternating = collapsed.length >= 2 && collapsed[0].role === 'user';
  if (alternating) {
    for (let i = 0; i < collapsed.length; i++) {
      const expect = i % 2 === 0 ? 'user' : 'assistant';
      if (collapsed[i].role !== expect) {
        alternating = false;
        break;
      }
    }
  }
  if (alternating) return collapsed;

  const out = [];
  const n = Math.max(users.length, assistants.length);
  for (let i = 0; i < n; i++) {
    if (users[i]) out.push(users[i]);
    if (assistants[i]) out.push(assistants[i]);
  }
  return out;
}

// 兼容旧调用名（不再做内容过滤）
function isQianwenNoiseText() {
  return false;
}
function isQianwenNoiseContentType(type, cardCode, pluginCode) {
  return isQianwenNonTextType(type, cardCode, pluginCode);
}

function parseQianwenHistoryPayload(payload) {
  if (payload && payload.success === false && payload.code !== 0) return [];

  const list =
    payload?.data?.list ||
    payload?.data?.messages ||
    payload?.data ||
    payload?.list ||
    [];

  if (!Array.isArray(list)) return [];

  const messages = [];
  for (const item of list) {
    const req =
      item.request_messages ||
      item.requestMessages ||
      item.user_messages ||
      item.userMessages;
    const res =
      item.qwen_response_messages ||
      item.qwenResponseMessages ||
      item.response_messages ||
      item.responseMessages ||
      item.assistant_messages;

    const userText = extractQianwenText(req) || extractQianwenText(item.prompt) || '';
    let assistantText =
      extractQianwenText(res) ||
      extractQianwenText(item.contents) ||
      extractQianwenText(item.content) ||
      '';
    assistantText = appendQianwenMediaCards(assistantText, [
      res,
      item.contents,
      item.content,
      item.qwen_response_messages,
      item.response_messages
    ]);

    if (!userText && !assistantText) {
      const role = String(item.role || '').toLowerCase();
      let content = extractQianwenText(item.contents || item.content || item.message);
      if (role === 'assistant') {
        content = appendQianwenMediaCards(content, [item.contents, item.content, item.message]);
      }
      if ((role === 'user' || role === 'assistant') && content) {
        messages.push({
          role,
          content,
          timestamp: item.create_time || item.created_at || null
        });
      }
      continue;
    }

    if (userText) {
      messages.push({
        role: 'user',
        content: userText,
        timestamp: item.create_time || item.created_at || null
      });
    }
    if (assistantText) {
      messages.push({
        role: 'assistant',
        content: assistantText,
        timestamp: item.create_time || item.created_at || null
      });
    }
  }

  return normalizeQianwenMessages(messages);
}

function mergeQianwenPayloads(prev, next) {
  const prevList = prev?.data?.list || prev?.list || [];
  const nextList = next?.data?.list || next?.list || [];
  if (!Array.isArray(prevList) && !Array.isArray(nextList)) return next;

  const seen = new Set();
  const list = [];
  for (const item of [...prevList, ...nextList]) {
    const key =
      item?.msg_id ||
      item?.msgId ||
      item?.req_id ||
      item?.request_id ||
      JSON.stringify(item).slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(item);
  }

  return {
    ...(next || prev),
    success: true,
    data: {
      ...((next || prev)?.data || {}),
      list
    }
  };
}

function buildQianwenListParams(sessionId, page = 1, pageSize = 50) {
  const params = new URLSearchParams({
    biz_id: 'ai_qwen',
    chat_client: 'h5',
    device: 'pc',
    fr: 'pc',
    pr: 'qwen',
    session_id: sessionId,
    page_size: String(pageSize),
    page: String(page),
    forward: 'false',
    include_pos: 'false',
    return_response_messages: 'true',
    event_filter: 'all',
    la: 'zh-CN',
    tz: 'Asia/Shanghai',
    wv: '4.4.1',
    ve: '4.4.1',
    nonce: Math.random().toString(36).slice(2, 14),
    timestamp: String(Date.now())
  });
  const ut = getQianwenUt();
  if (ut) params.set('ut', ut);
  return params;
}

async function fetchHistoryPage(sessionId, page = 1, pageSize = 50) {
  const params = buildQianwenListParams(sessionId, page, pageSize);
  const origins = discoverQianwenApiOrigins();
  const urls = origins.map((o) => `${o}/api/v1/session/msg/list?${params}`);

  let lastErr = null;
  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, {
        credentials: 'include',
        headers: {
          Accept: 'application/json, text/plain, */*',
          Referer: location.href,
          'x-platform': 'pc_tongyi'
        },
        signal: controller.signal
      });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status} @ ${new URL(url).host}`);
        continue;
      }
      const json = await res.json();
      // 业务失败也返回，让上层判断
      if (json && json.success === false && json.code && json.code !== 0) {
        // session 不存在等：换 host 无意义，直接抛
        if (json.code === 10008) {
          throw new Error(json.msg || 'session不存在');
        }
        lastErr = new Error(`${json.code}: ${json.msg || '业务错误'}`);
        continue;
      }
      return json;
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }

  // MAIN 世界再试（页面上下文，cookie 更完整）
  try {
    const viaMain = await requestQianwenMainWorldFetch(sessionId, page, pageSize);
    if (viaMain) return viaMain;
  } catch (err) {
    lastErr = err;
  }

  if (lastErr) throw lastErr;
  return null;
}

function requestQianwenMainWorldFetch(sessionId, page, pageSize, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      chrome.runtime.sendMessage(
        {
          type: 'QIANWEN_MAIN_WORLD_FETCH',
          sessionId: String(sessionId),
          page,
          pageSize,
          ut: getQianwenUt(),
          referer: location.href
        },
        (res) => {
          if (chrome.runtime.lastError) {
            finish(null);
            return;
          }
          finish(res?.ok ? res.payload : null);
        }
      );
    } catch {
      finish(null);
    }
  });
}

async function fetchAllQianwenHistory(sessionId) {
  let merged = null;
  let networkFailed = false;
  let lastErr = null;

  for (let page = 1; page <= 50; page++) {
    let payload;
    try {
      payload = await fetchHistoryPage(sessionId, page, 50);
    } catch (err) {
      lastErr = err;
      networkFailed = true;
      if (page === 1) throw err;
      break;
    }
    if (!payload) {
      if (page === 1) networkFailed = true;
      break;
    }

    const batch = payload?.data?.list || payload?.list || [];
    if (!Array.isArray(batch) || !batch.length) break;

    merged = merged ? mergeQianwenPayloads(merged, payload) : payload;
    if (payload?.data?.have_next_page === false) break;
    if (batch.length < 50) break;
  }

  if (!merged && networkFailed) {
    throw lastErr || new Error('ERR_NAME_NOT_RESOLVED_OR_NETWORK');
  }
  return merged;
}

async function fetchQianwenConversation(sessionId) {
  // 三级兜底（对齐 DeepSeek/豆包思路，千问多一层页面状态）：
  // 1) 页面内存 chatRounds（不依赖 DNS）
  // 2) chat2-api 官方历史
  // 3) 由适配器做 DOM 兜底
  let pageMessages = null;
  let pageSessionId = sessionId || null;

  try {
    const page = await requestQianwenPageState();
    if (page?.sessionId) {
      window.__acmQianwenSessionIdCache = page.sessionId;
      pageSessionId = page.sessionId;
    }
    if (page?.messages?.length) {
      pageMessages = page.messages;
      const hasUser = pageMessages.some((m) => m.role === 'user');
      const hasAsst = pageMessages.some((m) => m.role === 'assistant');
      console.log('[ACM Qianwen] 页面状态', page.stats || {}, 'via page-state');
      // 问答齐全才直接采用；只有提问则继续走 API，最终再合并
      if (hasUser && hasAsst) {
        return {
          messages: normalizeQianwenMessages(pageMessages),
          source: 'api',
          sessionId: pageSessionId,
          fetchSource: 'page-state'
        };
      }
    }
  } catch (err) {
    console.warn('[ACM Qianwen] 页面状态读取失败:', err);
  }

  const sid = pageSessionId || sessionId || window.__acmQianwenSessionIdCache;
  if (sid) {
    try {
      const payload = await fetchAllQianwenHistory(sid);
      if (payload) {
        const messages = parseQianwenHistoryPayload(payload);
        if (messages.length) {
          const merged = mergeQianwenMessageLists(pageMessages, messages);
          console.log('[ACM Qianwen] API 解析', merged.length, '条');
          return {
            messages: merged,
            source: 'api',
            sessionId: sid,
            fetchSource: 'chat2-api'
          };
        }
      }
    } catch (err) {
      // 保留 pageMessages 给上层
      if (!pageMessages?.length) throw err;
      console.warn('[ACM Qianwen] API 失败，回退页面状态:', err);
    }
  }

  if (pageMessages?.length) {
    return {
      messages: normalizeQianwenMessages(pageMessages),
      source: 'api',
      sessionId: sid,
      fetchSource: 'page-state-partial'
    };
  }

  return null;
}

function mergeQianwenMessageLists(a, b) {
  // 主键优先（a），仅用 b 补缺轮次；不改写已有正文
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  const byRole = (list, role) =>
    list.filter((m) => m?.role === role && String(m.content || '').trim());
  const usersL = byRole(left, 'user');
  const usersR = byRole(right, 'user');
  const asstL = byRole(left, 'assistant');
  const asstR = byRole(right, 'assistant');
  const users = [];
  const assistants = [];
  const nu = Math.max(usersL.length, usersR.length);
  const na = Math.max(asstL.length, asstR.length);
  for (let i = 0; i < nu; i++) users.push(usersL[i] || usersR[i]);
  for (let i = 0; i < na; i++) assistants.push(asstL[i] || asstR[i]);
  const paired = [];
  const n = Math.max(users.length, assistants.length);
  for (let i = 0; i < n; i++) {
    if (users[i]) paired.push(users[i]);
    if (assistants[i]) paired.push(assistants[i]);
  }
  return normalizeQianwenMessages(paired.length ? paired : [...left, ...right]);
}

function requestQianwenPageState(timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      chrome.runtime.sendMessage({ type: 'QIANWEN_READ_PAGE_STATE' }, (res) => {
        if (chrome.runtime.lastError) {
          finish(null);
          return;
        }
        finish(res?.ok ? res.data : null);
      });
    } catch {
      finish(null);
    }
  });
}

function injectQianwenHook() {}

if (typeof globalThis !== 'undefined') {
  globalThis.injectQianwenHook = injectQianwenHook;
  globalThis.getQianwenSessionId = getQianwenSessionId;
  globalThis.resolveQianwenSessionId = resolveQianwenSessionId;
  globalThis.fetchQianwenConversation = fetchQianwenConversation;
  globalThis.parseQianwenHistoryPayload = parseQianwenHistoryPayload;
  globalThis.normalizeQianwenMessages = normalizeQianwenMessages;
  globalThis.stripQianwenThinkingProcess = stripQianwenThinkingProcess;
  globalThis.isQianwenThinkingFragment = isQianwenThinkingFragment;
  globalThis.stripQianwenStructuredJson = stripQianwenStructuredJson;
  globalThis.isQianwenStructuredJunk = isQianwenStructuredJunk;
  globalThis.isQianwenNoiseText = isQianwenNoiseText;
  globalThis.requestQianwenPageState = requestQianwenPageState;
  globalThis.scoreQianwenStructure = scoreQianwenStructure;
  globalThis.qianwenLacksRichFormat = qianwenLacksRichFormat;
  globalThis.stripQianwenCardSoup = stripQianwenCardSoup;
  globalThis.looksLikeQianwenCardSoup = looksLikeQianwenCardSoup;
  globalThis.looksLikeQianwenSearchResultWall = looksLikeQianwenSearchResultWall;
  globalThis.scoreQianwenAnswerPiece = scoreQianwenAnswerPiece;
  globalThis.isQianwenMostlyCardSoup = isQianwenMostlyCardSoup;
  globalThis.looksLikeQianwenAssistantVoice = looksLikeQianwenAssistantVoice;
  globalThis.looksLikeTruncatedAssistantText = looksLikeTruncatedAssistantText;
  globalThis.isQianwenContentPrefixOf = isQianwenContentPrefixOf;
  globalThis.isQianwenRecommendCardLine = isQianwenRecommendCardLine;
  globalThis.ensureQianwenParagraphBreaks = ensureQianwenParagraphBreaks;
}
