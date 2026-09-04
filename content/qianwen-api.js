/**
 * 通义千问：三级兜底（对齐 DeepSeek/豆包）
 * 1) 页面内存 chatRounds（MAIN，不依赖 DNS）
 * 2) chat2-api 官方历史
 * 3) 适配器 DOM（qk-markdown）
 * 注意：www.qianwen.com 同源没有 /api/v1/session/msg/list（会 404），不要当兜底
 */
function getQianwenSessionId() {
  if (window.__acmQianwenSessionIdCache) return window.__acmQianwenSessionIdCache;

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

async function resolveQianwenSessionId() {
  const fromUrl = getQianwenSessionId();
  if (fromUrl) return fromUrl;
  try {
    const page = await requestQianwenPageState();
    if (page?.sessionId) {
      window.__acmQianwenSessionIdCache = page.sessionId;
      return page.sessionId;
    }
  } catch {
    // ignore
  }
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

  // 有明确类型时：只保留纯文本类，其余（card / gaokao_choice_report / think…）一律跳过
  if (t && !/^(text|text2image|markdown|plain)$/i.test(t)) {
    return true;
  }
  if (/deep.?think|think|planning|ppt|aippt|wanx|quark|search|gaokao|zhiyuan|report|plugin/i.test(card)) {
    return true;
  }
  if (/deep.?think|think|planning|search|gaokao|zhiyuan|report/i.test(plugin)) {
    return true;
  }
  if (/image|video|audio|iframe/.test(t)) return true;
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
 * 去掉回答开头的思考过程，保留正式正文（不改写正文内容）
 */
function stripQianwenThinkingProcess(text) {
  let s = stripQianwenStructuredJson(String(text || '').trim());
  if (!s) return '';

  // 去掉开头的「已完成思考…」一行/短段落
  s = s.replace(/^(?:已完成思考|Finished thinking)[^\n]*\n+/i, '');
  s = s.replace(/^参考了\s*\d+\s*篇材料[^\n]*\n+/i, '');

  // 仅当全文以思考/检索计划开头时，才裁到第一个正式章节
  const start = s.slice(0, 120);
  if (
    /^(已完成思考|Finished thinking|明确选择问题|搜索\s*\d+\s*个关键词|用户想知道|用户想|Thinking)/i.test(
      start
    ) ||
    (/deep_thinking|web_search|site_name/i.test(start) && !/^[一二三四五六七八九十]/.test(start))
  ) {
    const patterns = [
      /(?:^|\n)((?:#{1,6}\s+)?(?:\*\*)?[一二三四五六七八九十]+[、．.])/u,
      /(?:^|\n)((?:#{1,6}\s+)?(?:\*\*)?\d+[\.、]\s*)/u,
      /(?:^|\n)(\| .+\|)/,
      /(?:^|\n)((?:#{1,6}\s+).+)/
    ];
    let cut = -1;
    for (const re of patterns) {
      const m = s.match(re);
      if (m && typeof m.index === 'number') {
        const idx = m.index + (m[0].startsWith('\n') ? 1 : 0);
        if (cut < 0 || idx < cut) cut = idx;
      }
    }
    if (cut > 20) s = s.slice(cut).trim();
  }

  s = s
    .split('\n')
    .filter((line) => {
      const t = line.replace(/\s+/g, '').trim();
      if (!t) return true;
      if (/^(已完成思考|Finishedthinking|参考了\d+篇材料|表格|下载为表格|导出为图片)$/i.test(t)) {
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
    if (/image|video|audio|iframe|card|gaokao|report/.test(type)) continue;
    const piece = extractQianwenText(p);
    const s = coerceQianwenContent(piece);
    if (s && !isQianwenThinkingFragment(s) && !isQianwenStructuredJunk(s)) texts.push(s);
  }
  if (!texts.length) return '';
  // 去重保序；正文优先于残留 JSON
  const uniq = [];
  const seen = new Set();
  for (const t of texts) {
    if (isQianwenStructuredJunk(t)) continue;
    const key = t.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(t);
  }
  return stripQianwenThinkingProcess(uniq.join('\n\n'));
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
    const role = m.role === 'user' ? 'user' : 'assistant';
    if (role === 'assistant') {
      if (isQianwenThinkingFragment(content) && content.length < 800) continue;
      content = stripQianwenThinkingProcess(content);
      if (!content || isQianwenStructuredJunk(content)) continue;
    }
    cleaned.push({
      role,
      content,
      timestamp: m.timestamp || null
    });
  }

  // 同角色相邻：若一段是另一段前缀，保留更长；否则都保留（多轮）
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
      if (b.startsWith(a.slice(0, Math.min(120, a.length))) || a.startsWith(b.slice(0, Math.min(120, b.length)))) {
        if (b.length > a.length) prev.content = b;
        continue;
      }
      // 同角色两段都不像延续：合并为一段（避免详情出现多段错乱 AI）
      if (m.role === 'assistant') {
        prev.content = `${a}\n\n${b}`.trim();
        continue;
      }
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
    const assistantText =
      extractQianwenText(res) ||
      extractQianwenText(item.contents) ||
      extractQianwenText(item.content) ||
      '';

    if (!userText && !assistantText) {
      const role = String(item.role || '').toLowerCase();
      const content = extractQianwenText(item.contents || item.content || item.message);
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
}
