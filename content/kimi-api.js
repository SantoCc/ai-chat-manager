/**
 * Kimi 官方接口读取对话原文
 * 三级兜底：CS fetch（ListMessages / segment/scroll）→ 页面主环境 → Hook 缓存
 */
const __acmKimiCache = {
  byId: new Map(),
  latest: null
};

function getKimiChatId() {
  const path = location.pathname || '';
  const patterns = [
    /\/chat\/([0-9a-zA-Z_-]{8,})/i,
    /\/c\/([0-9a-zA-Z_-]{8,})/i
  ];
  for (const re of patterns) {
    const m = path.match(re);
    if (m && !/^(new|home)$/i.test(m[1])) return m[1];
  }
  const q = new URLSearchParams(location.search);
  return q.get('chat_id') || q.get('chatId') || q.get('id') || null;
}

function getKimiAccessToken() {
  try {
    return localStorage.getItem('access_token') || localStorage.getItem('moonshot_access_token') || null;
  } catch {
    return null;
  }
}

function getKimiDeviceMeta() {
  const keys = [
    '__tea_cache_tokens_20001731',
    '__tea_cache_tokens_513641',
    '__tea_cache_tokens'
  ];
  for (const key of keys) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const webId = parsed?.web_id || parsed?.user_unique_id || '';
      if (webId) return { webId: String(webId), userId: String(parsed.user_unique_id || webId) };
    } catch {
      // next
    }
  }
  return { webId: '', userId: '' };
}

function buildKimiHeaders() {
  const token = getKimiAccessToken();
  const { webId, userId } = getKimiDeviceMeta();
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-MSH-Platform': 'web',
    'x-msh-platform': 'web',
    'X-Language': 'zh-CN',
    'x-language': 'zh-CN',
    'R-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    Referer: location.href
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (webId) {
    headers['X-MSH-Device-ID'] = webId;
    headers['x-msh-device-id'] = webId;
  }
  if (userId) headers['X-Traffic-Id'] = userId;
  return headers;
}

function kimiApiOrigins() {
  const set = new Set([location.origin, 'https://kimi.moonshot.cn', 'https://www.kimi.com', 'https://kimi.com']);
  return [...set];
}

function normalizeKimiRole(raw) {
  const v = String(raw || '').toLowerCase();
  if (!v) return null;
  if (v.includes('assistant') || v.includes('bot') || v === 'ai' || v === 'model') return 'assistant';
  if (v.includes('system')) return null;
  if (v.includes('user') || v.includes('human') || v === 'request') return 'user';
  return null;
}

function extractKimiBlocksText(blocks, role = null) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.think) continue;
    const type = String(block.type || block.block_type || '').toLowerCase();

    // 代码块 → markdown fence（须在通用 content 提取前判断）
    if (
      role !== 'user' &&
      (type === 'code' ||
        type === 'code_block' ||
        type === 'sandbox' ||
        type === 'file_code' ||
        block.code ||
        ((block.language != null || block.lang != null) &&
          (block.content || block.text || block.value)))
    ) {
      const lang = String(block.language || block.lang || block.code?.language || '').trim();
      const code = String(
        block.code?.content ||
          block.code?.text ||
          (typeof block.code === 'string' ? block.code : '') ||
          block.content ||
          block.text?.content ||
          block.text ||
          block.value ||
          ''
      ).trim();
      if (code && !/^https?:/i.test(code) && code.length > 2) {
        parts.push('```' + lang + '\n' + code + '\n```');
        continue;
      }
    }

    if (block.text?.content) {
      parts.push(String(block.text.content).trim());
      continue;
    }
    if (typeof block.content === 'string' && block.content.trim()) {
      parts.push(block.content.trim());
      continue;
    }
    if (typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text.trim());
      continue;
    }
    if ((type === 'text' || type === 'markdown' || type === 'md') && (block.msg || block.value)) {
      parts.push(String(block.msg || block.value).trim());
      continue;
    }
    // 图片块：仅助手消息落卡，用户消息忽略媒体
    if (role === 'user') continue;
    const url =
      block.url ||
      block.src ||
      block.image_url ||
      block.imageUrl ||
      (typeof block.image === 'string' ? block.image : block.image?.url);
    if (
      url &&
      /^https?:/i.test(String(url)) &&
      (/image|img|media|picture/i.test(type) || /\.(png|jpe?g|gif|webp)/i.test(url))
    ) {
      const title = block.title || block.alt || block.name || '图片';
      if (typeof formatGeneratedFileCardsMarkdown === 'function') {
        parts.push(
          formatGeneratedFileCardsMarkdown([
            { kind: 'file', type: 'image', title, generatedAt: '', url: String(url) }
          ])
        );
      } else {
        parts.push(`![${title}](${url})`);
      }
    }
  }
  return parts.filter(Boolean).join('\n\n').trim();
}

/** 从消息/载荷里收集图片 URL（含 image_search 结果） */
function collectKimiImageEntries(root) {
  const out = [];
  const seen = new Set();
  const push = (url, title, ref) => {
    const u = String(url || '').trim();
    if (!u || !/^https?:/i.test(u)) return;
    if (/avatar|icon|logo|emoji|favicon|sprite|loading\.|placeholder/i.test(u)) return;
    if (
      !/\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(u) &&
      !/\/image|img|cdn|zimgs|moonshot|kimi-web|mshcdn|byteimg/i.test(u)
    ) {
      return;
    }
    if (seen.has(u)) return;
    seen.add(u);
    out.push({
      url: u,
      title: String(title || '图片').slice(0, 80),
      ref: ref ? String(ref) : ''
    });
  };
  const walk = (node, depth) => {
    if (!node || depth > 14) return;
    if (typeof node === 'string') {
      if (/^https?:\/\//i.test(node)) push(node, '图片', '');
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((n) => walk(n, depth + 1));
      return;
    }
    if (typeof node !== 'object') return;
    const ref =
      node.ref ||
      node.cite ||
      node.image_id ||
      node.imageId ||
      node.id ||
      node.key ||
      '';
    const url =
      node.url ||
      node.src ||
      node.image_url ||
      node.imageUrl ||
      node.thumbnail ||
      node.thumb_url ||
      node.origin_url ||
      node.originUrl ||
      (typeof node.image === 'string' ? node.image : node.image?.url);
    const title = node.title || node.alt || node.name || node.desc || '';
    if (url) {
      const refStr = String(ref || '');
      if (/image_search:\d+#\d+/i.test(refStr)) push(url, title, refStr);
      else push(url, title, /image_search/i.test(refStr) ? refStr : '');
    }
    for (const [k, v] of Object.entries(node)) {
      if (/think|thinking|password|token|authorization/i.test(k)) continue;
      walk(v, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

function formatKimiImageCards(entries) {
  if (!entries?.length) return '';
  const cards = entries.map((e) => ({
    kind: 'file',
    type: 'image',
    title: e.title || '图片',
    generatedAt: '',
    url: e.url || ''
  }));
  if (typeof formatGeneratedFileCardsMarkdown === 'function') {
    return formatGeneratedFileCardsMarkdown(cards);
  }
  return cards.map((c) => (c.url ? `![${c.title}](${c.url})` : '')).filter(Boolean).join('\n\n');
}

/**
 * 把 Kimi 正文里的 image_search 占位符替换成图片卡
 * 例：image🛠image_search:1#0🛠image_search:1#1
 */
function resolveKimiImageMarkers(text, imageEntries) {
  let s = String(text || '');
  if (!s) return '';
  const entries = Array.isArray(imageEntries) ? imageEntries : [];
  const byRef = new Map();
  for (const e of entries) {
    if (e.ref && /image_search:\d+#\d+/i.test(e.ref)) {
      byRef.set(e.ref.toLowerCase(), e);
    }
  }
  const ordered = entries.filter((e) => e.url);

  const markerRe =
    /(?:[\uE000-\uF8FF]\s*)?(?:\[\s*\])?\s*image\s*(?:🛠️|🛠|\u{1F6E0}\uFE0F?)\s*((?:image_search:\d+#\d+\s*(?:🛠️|🛠|\u{1F6E0}\uFE0F?)?\s*)+)(?:[\uE000-\uF8FF]\s*)?(?:\[\s*\])?/giu;

  const replaceRefs = (refsPart) => {
    const refs = [...String(refsPart || '').matchAll(/image_search:(\d+)#(\d+)/gi)];
    if (!refs.length) return '';
    const picked = [];
    const usedUrl = new Set();
    for (const m of refs) {
      const key = m[0].toLowerCase();
      let hit = byRef.get(key);
      if (!hit) {
        const idx = Number(m[2]);
        hit = ordered[idx] || ordered[picked.length];
      }
      if (hit?.url && !usedUrl.has(hit.url)) {
        usedUrl.add(hit.url);
        picked.push(hit);
      }
    }
    if (!picked.length && ordered.length) {
      // 按出现数量取前 N 张
      for (const e of ordered.slice(0, Math.min(refs.length, 8))) {
        if (!usedUrl.has(e.url)) {
          usedUrl.add(e.url);
          picked.push(e);
        }
      }
    }
    if (!picked.length) {
      // 去掉标记，不落空占位（避免与后续真图卡重复）
      return '';
    }
    return formatKimiImageCards(picked);
  };

  if (markerRe.test(s)) {
    markerRe.lastIndex = 0;
    s = s.replace(markerRe, (_, refsPart) => `\n\n${replaceRefs(refsPart)}\n\n`);
  } else if (/image_search:\d+#\d+/i.test(s)) {
    // 宽松兜底：整段引用串
    s = s.replace(
      /(?:\[\s*\])?\s*image\s*(?:🛠️|🛠)?\s*((?:image_search:\d+#\d+\s*(?:🛠️|🛠)?\s*)+)/gi,
      (_, refsPart) => `\n\n${replaceRefs(refsPart)}\n\n`
    );
    s = s.replace(/(?:🛠️|🛠)?\s*image_search:\d+#\d+/gi, '');
  }

  // 清掉残留特殊符号 / 空 []
  s = s.replace(/[\uE000-\uF8FF]/g, '');
  s = s.replace(/\[\s*\]/g, '');
  s = s.replace(/(?:🛠️|🛠){2,}/g, '');
  if (typeof promoteFilenameLinesToFileCards === 'function') {
    s = promoteFilenameLinesToFileCards(s);
  }
  if (typeof dedupeAcmFileCardsInText === 'function') {
    s = dedupeAcmFileCardsInText(s);
  }
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function extractKimiMessageContent(raw, imageEntries = null, role = null) {
  if (!raw || typeof raw !== 'object') return '';
  let content =
    extractKimiBlocksText(raw.blocks, role) ||
    extractKimiBlocksText(raw.contents, role) ||
    extractKimiBlocksText(raw.content_blocks, role);

  if (!content && typeof raw.content === 'string') content = raw.content.trim();
  if (!content && typeof raw.text === 'string') content = raw.text.trim();
  if (!content && Array.isArray(raw.segments)) {
    content = raw.segments
      .map((s) => {
        if (typeof s === 'string') return s;
        if (s?.type === 'think' || s?.role === 'think') return '';
        return s?.text || s?.content || s?.markdown || '';
      })
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }

  // 用户提问：绝不挂图片卡（「生成一张…图片」会被误匹配）
  if (role === 'user') {
    return stripKimiUserMediaLeak(content);
  }

  const imgs = imageEntries || collectKimiImageEntries(raw);
  const hadMarkers = /image_search:\d+#\d+/i.test(content);
  content = resolveKimiImageMarkers(content, imgs);

  // 仅助手 + 明确搜图/上图语境才补卡；禁止仅因含「图片」二字就灌图
  if (
    imgs.length &&
    !/"type":"image"/.test(content) &&
    !/!\[[^\]]*\]\(https?:/.test(content) &&
    (hadMarkers || /为你找到了|上图包括|找到了多张图片/i.test(content))
  ) {
    const block = formatKimiImageCards(imgs.slice(0, 8));
    if (block) content = `${content}\n\n${block}`.trim();
  }
  return content;
}

/** 去掉误挂到用户消息上的图片卡 / 搜图标记 */
function stripKimiUserMediaLeak(text) {
  let s = String(text || '');
  if (!s) return '';
  s = s.replace(
    /@@ACM_FILE:(\{[\s\S]*?\})@@(?:\n(?:📎[^\n]*|生成时间：[^\n]*|（交互式文件[^\n]*）))*/g,
    ''
  );
  s = s.replace(/!\[[^\]]*\]\(https?:[^)]+\)/g, '');
  s = s.replace(
    /(?:[\uE000-\uF8FF]\s*)?(?:\[\s*\])?\s*image\s*(?:🛠️|🛠|\u{1F6E0}\uFE0F?)[\s\S]{0,400}?(?:[\uE000-\uF8FF]\s*)?(?:\[\s*\])?/giu,
    ''
  );
  s = s.replace(/(?:🛠️|🛠)?\s*image_search:\d+#\d+/gi, '');
  s = s.replace(/(?:🛠️|🛠)/g, '');
  s = s.replace(/[\uE000-\uF8FF]/g, '');
  s = s.replace(/\[\s*\]/g, '');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function collectKimiMessageArrays(payload) {
  if (!payload) return [];
  const candidates = [
    payload.messages,
    payload.items,
    payload.data?.messages,
    payload.data?.items,
    payload.result?.messages,
    payload.segments,
    payload.data?.segments,
    payload.list
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c;
  }
  return [];
}

function parseKimiHistoryPayload(payload) {
  const raw = collectKimiMessageArrays(payload);
  const globalImages = collectKimiImageEntries(payload);
  const messages = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const role =
      normalizeKimiRole(m.role) ||
      normalizeKimiRole(m.author?.role) ||
      normalizeKimiRole(m.sender) ||
      normalizeKimiRole(m.type);
    if (!role) continue;

    let content;
    if (role === 'user') {
      content = extractKimiMessageContent(m, null, 'user');
    } else {
      const localImages = collectKimiImageEntries(m);
      // 先取纯文本看本条引用了哪些 image_search
      const peek =
        extractKimiBlocksText(m.blocks, 'user') ||
        (typeof m.content === 'string' ? m.content : '') ||
        (typeof m.text === 'string' ? m.text : '');
      const refs = new Set(
        [...String(peek).matchAll(/image_search:\d+#\d+/gi)].map((x) => x[0].toLowerCase())
      );
      const mergedImages = [...localImages];
      const seen = new Set(localImages.map((x) => x.url).filter(Boolean));
      // 只用「本条引用到的」全局图，禁止整会话灌进每一轮
      for (const g of globalImages) {
        if (!g.url || seen.has(g.url)) continue;
        if (g.ref && refs.has(String(g.ref).toLowerCase())) {
          seen.add(g.url);
          mergedImages.push(g);
        }
      }
      // 本条有引用但本地无 URL：按 #index 从全局有序列表补（仍限制数量）
      if (refs.size && !mergedImages.some((x) => x.url)) {
        const ordered = globalImages.filter((x) => x.url);
        for (const ref of refs) {
          const mIdx = /#(\d+)$/.exec(ref);
          const idx = mIdx ? Number(mIdx[1]) : mergedImages.length;
          const hit = ordered[idx] || ordered[mergedImages.length];
          if (hit?.url && !seen.has(hit.url)) {
            seen.add(hit.url);
            mergedImages.push({ ...hit, ref });
          }
        }
      }
      content = extractKimiMessageContent(m, mergedImages, 'assistant');
    }
    if (!content) continue;
    if (role === 'assistant' && typeof sanitizeAssistantContentForSave === 'function') {
      content = sanitizeAssistantContentForSave(content);
    }
    if (!content) continue;
    messages.push({
      role,
      content,
      timestamp: m.createTime || m.created_at || m.timestamp || m.ctime || null,
      id: m.id || m.message_id || null
    });
  }

  // 时间排序；无时间则保序
  const indexed = messages.map((m, i) => ({ m, i }));
  indexed.sort((a, b) => {
    const ta = a.m.timestamp ? String(a.m.timestamp) : '';
    const tb = b.m.timestamp ? String(b.m.timestamp) : '';
    if (ta && tb && ta !== tb) return ta < tb ? -1 : 1;
    return a.i - b.i;
  });

  const seen = new Set();
  const out = [];
  for (const { m } of indexed) {
    const key = `${m.role}::${String(m.content).replace(/\s+/g, ' ').trim().slice(0, 200)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ role: m.role, content: m.content, timestamp: m.timestamp });
  }
  return out;
}

function rememberKimiPayload(chatId, payload) {
  const entry = { payload, ts: Date.now() };
  __acmKimiCache.latest = entry;
  if (chatId) __acmKimiCache.byId.set(String(chatId), entry);
}

function getCachedKimiPayload(chatId) {
  if (chatId && __acmKimiCache.byId.has(String(chatId))) {
    const hit = __acmKimiCache.byId.get(String(chatId));
    if (hit && Date.now() - (hit.ts || 0) < 10 * 60 * 1000) return hit.payload;
  }
  if (__acmKimiCache.latest && Date.now() - __acmKimiCache.latest.ts < 10 * 60 * 1000) {
    return __acmKimiCache.latest.payload;
  }
  return null;
}

async function waitForKimiCache(chatId, ms = 1800) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const cached = getCachedKimiPayload(chatId);
    if (cached && parseKimiHistoryPayload(cached).length) return cached;
    await new Promise((r) => setTimeout(r, 200));
  }
  return getCachedKimiPayload(chatId);
}

async function postKimiJson(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: buildKimiHeaders(),
      body: JSON.stringify(body ?? {}),
      signal: controller.signal
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchKimiListMessages(chatId) {
  const bodies = [{ chat_id: chatId }, { chatId }, { id: chatId }];
  for (const origin of kimiApiOrigins()) {
    const url = `${origin}/apiv2/kimi.gateway.chat.v1.ChatService/ListMessages`;
    for (const body of bodies) {
      const json = await postKimiJson(url, body);
      if (json && parseKimiHistoryPayload(json).length) {
        rememberKimiPayload(chatId, json);
        return json;
      }
    }
  }
  return null;
}

async function fetchKimiSegmentScroll(chatId) {
  const bodies = [
    { last_n: 200 },
    { lastN: 200 },
    { limit: 200 },
    {}
  ];
  for (const origin of kimiApiOrigins()) {
    const url = `${origin}/api/chat/${encodeURIComponent(chatId)}/segment/scroll`;
    for (const body of bodies) {
      const json = await postKimiJson(url, body);
      if (json && parseKimiHistoryPayload(json).length) {
        rememberKimiPayload(chatId, json);
        return json;
      }
    }
  }
  return null;
}

async function fetchKimiHistoryCs(chatId) {
  return (
    (await fetchKimiListMessages(chatId)) ||
    (await fetchKimiSegmentScroll(chatId))
  );
}

function requestKimiPageFetch(chatId, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const requestId = `km_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      document.removeEventListener('acm-kimi-fetch-response', onResp);
      resolve(null);
    }, timeoutMs);

    function onResp(event) {
      const detail = event?.detail;
      if (!detail || detail.requestId !== requestId) return;
      clearTimeout(timer);
      document.removeEventListener('acm-kimi-fetch-response', onResp);
      resolve(detail.ok ? detail.payload : null);
    }

    document.addEventListener('acm-kimi-fetch-response', onResp);
    document.dispatchEvent(
      new CustomEvent('acm-kimi-fetch-request', {
        detail: { requestId, chatId },
        bubbles: true
      })
    );
  });
}

async function fetchKimiConversation(chatId) {
  if (!chatId) return null;
  injectKimiHook();

  let payload = await fetchKimiHistoryCs(chatId);
  let source = 'api-fetch';

  if (!payload || !parseKimiHistoryPayload(payload).length) {
    console.warn('[ACM Kimi] CS fetch 无数据，尝试页面主环境 fetch');
    payload = await requestKimiPageFetch(chatId);
    source = 'page-fetch';
  }

  if (!payload || !parseKimiHistoryPayload(payload).length) {
    console.warn('[ACM Kimi] 页面 fetch 无数据，等待 Hook 缓存');
    payload = await waitForKimiCache(chatId, 2000);
    source = 'hook-cache';
  }

  if (!payload) return null;
  const messages = parseKimiHistoryPayload(payload);
  if (!messages.length) return null;

  console.log('[ACM Kimi] API 解析', messages.length, '条，来源:', source);
  return {
    messages,
    source: 'api',
    sessionId: chatId,
    fetchSource: source
  };
}

function setupKimiCacheListener() {
  if (window.__acmKimiCacheListening) return;
  window.__acmKimiCacheListening = true;
  document.addEventListener('acm-kimi-history', (event) => {
    const { chatId, payload } = event.detail || {};
    if (!payload) return;
    rememberKimiPayload(chatId || getKimiChatId(), payload);
  });
}

function injectKimiHook() {
  setupKimiCacheListener();
  if (document.documentElement?.getAttribute('data-acm-km-hook') === '1') return;
  try {
    document.documentElement?.setAttribute('data-acm-km-hook', '1');
  } catch {
    // ignore
  }

  const source = `
(function () {
  if (window.__acmKimiHooked) return;
  window.__acmKimiHooked = true;
  var origFetch = window.fetch;

  function isStreamUrl(url) {
    return typeof url === 'string' && /completion|stream|sse|event-stream/i.test(url);
  }
  function isHistoryUrl(url) {
    if (typeof url !== 'string' || isStreamUrl(url)) return false;
    return /ListMessages/i.test(url) ||
      /\\/api\\/chat\\/[^/]+\\/segment\\/scroll/i.test(url) ||
      /\\/api\\/chat\\/[^/]+\\/segment/i.test(url) ||
      (/\\/apiv2\\/.*ChatService/i.test(url) && /ListMessages|GetChat/i.test(url));
  }
  function extractChatId(url, bodyText) {
    try {
      if (bodyText) {
        var parsed = typeof bodyText === 'string' ? JSON.parse(bodyText) : bodyText;
        var id = parsed && (parsed.chat_id || parsed.chatId || parsed.id);
        if (id) return String(id);
      }
    } catch (e) {}
    try {
      var m = String(url || '').match(/\\/api\\/chat\\/([0-9a-zA-Z_-]{8,})/i);
      if (m) return m[1];
    } catch (e2) {}
    try {
      var pm = (location.pathname || '').match(/\\/chat\\/([0-9a-zA-Z_-]{8,})/i);
      if (pm) return pm[1];
    } catch (e3) {}
    return null;
  }
  function getToken() {
    try { return localStorage.getItem('access_token'); } catch (e) { return null; }
  }
  function getHeaders() {
    var headers = {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'X-MSH-Platform': 'web',
      'x-language': 'zh-CN'
    };
    var token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
  }
  function publish(chatId, payload) {
    if (!payload) return;
    document.dispatchEvent(new CustomEvent('acm-kimi-history', {
      detail: { chatId: chatId || null, payload: payload, ts: Date.now() },
      bubbles: true
    }));
  }
  function hasMessages(payload) {
    if (!payload) return false;
    var arr = payload.messages || payload.items || (payload.data && (payload.data.messages || payload.data.items)) || payload.segments;
    return Array.isArray(arr) && arr.length > 0;
  }
  async function fetchInPage(chatId) {
    var endpoints = [
      { url: location.origin + '/apiv2/kimi.gateway.chat.v1.ChatService/ListMessages', body: { chat_id: chatId } },
      { url: location.origin + '/apiv2/kimi.gateway.chat.v1.ChatService/ListMessages', body: { chatId: chatId } },
      { url: location.origin + '/api/chat/' + encodeURIComponent(chatId) + '/segment/scroll', body: { last_n: 200 } },
      { url: location.origin + '/api/chat/' + encodeURIComponent(chatId) + '/segment/scroll', body: {} }
    ];
    for (var i = 0; i < endpoints.length; i++) {
      try {
        var res = await origFetch(endpoints[i].url, {
          method: 'POST',
          credentials: 'include',
          headers: getHeaders(),
          body: JSON.stringify(endpoints[i].body)
        });
        if (!res.ok) continue;
        var json = await res.json();
        if (!hasMessages(json)) continue;
        publish(chatId, json);
        return json;
      } catch (e) {}
    }
    return null;
  }

  document.addEventListener('acm-kimi-fetch-request', async function (event) {
    var detail = event.detail || {};
    if (!detail.requestId || !detail.chatId) return;
    try {
      var payload = await fetchInPage(detail.chatId);
      document.dispatchEvent(new CustomEvent('acm-kimi-fetch-response', {
        detail: { requestId: detail.requestId, chatId: detail.chatId, payload: payload, ok: !!payload },
        bubbles: true
      }));
    } catch (err) {
      document.dispatchEvent(new CustomEvent('acm-kimi-fetch-response', {
        detail: { requestId: detail.requestId, chatId: detail.chatId, payload: null, ok: false, error: String(err && err.message || err) },
        bubbles: true
      }));
    }
  });

  window.fetch = async function () {
    var res = await origFetch.apply(this, arguments);
    try {
      var input = arguments[0];
      var init = arguments[1] || {};
      var url = typeof input === 'string' ? input : (input && input.url);
      if (isHistoryUrl(url)) {
        res.clone().json().then(function (data) {
          publish(extractChatId(url, init.body), data);
        }).catch(function () {});
      }
    } catch (e) {}
    return res;
  };

  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__acmKmUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    this.__acmKmBody = body;
    if (isHistoryUrl(this.__acmKmUrl)) {
      this.addEventListener('load', function () {
        try {
          if (this.status >= 200 && this.status < 300) {
            publish(extractChatId(this.__acmKmUrl, this.__acmKmBody), JSON.parse(this.responseText));
          }
        } catch (e) {}
      });
    }
    return origSend.apply(this, arguments);
  };
})();`;

  // 禁止内联 script（会触发站点 CSP 红字）。页面 hook 仅由 manifest world:MAIN 注入。
  void source;
}

if (typeof globalThis !== 'undefined') {
  globalThis.getKimiChatId = getKimiChatId;
  globalThis.fetchKimiConversation = fetchKimiConversation;
  globalThis.injectKimiHook = injectKimiHook;
  globalThis.resolveKimiImageMarkers = resolveKimiImageMarkers;
  globalThis.stripKimiUserMediaLeak = stripKimiUserMediaLeak;
}
