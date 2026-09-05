/**
 * DeepSeek 官方 API 读取对话原文
 * 三级兜底：CS fetch → 页面主环境 fetch → Hook 缓存（不用 DOM）
 */
function getDeepSeekSessionId() {
  const path = location.pathname || '';
  const patterns = [
    /\/a\/chat\/s\/([0-9a-f-]{36})/i,
    /\/chat\/s\/([0-9a-f-]{36})/i,
    /\/chat\/([0-9a-f-]{36})/i
  ];
  for (const re of patterns) {
    const m = path.match(re);
    if (m) return m[1];
  }
  return new URLSearchParams(location.search).get('chat_session_id') || null;
}

function getDeepSeekAuthToken() {
  try {
    const raw = localStorage.getItem('userToken');
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed?.value || parsed?.token || null;
    } catch {
      return raw.startsWith('Bearer ') ? raw.slice(7) : raw;
    }
  } catch {
    return null;
  }
}

function normalizeApiRole(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'user' || r === 'request') return 'user';
  if (r === 'assistant' || r === 'response' || r === 'model') return 'assistant';
  return null;
}

function joinFragments(fragments, type) {
  if (!Array.isArray(fragments)) return '';
  return fragments
    .filter((f) => f?.type === type)
    .map((f) => (typeof f?.content === 'string' ? f.content : ''))
    .join('\n')
    .trim();
}

const SKIP_FRAGMENT_TYPES = new Set([
  'THINK',
  'TOOL_SEARCH',
  'TOOL_OPEN',
  'TOOL_RESULT',
  'SEARCH',
  'CITATION',
  // 附件/卡片类：不当正文拼接（防 CSS/JSON 泄漏）
  'FILE',
  'ARTIFACT',
  'ATTACHMENT',
  'DOCUMENT',
  'IMAGE',
  'VIDEO',
  'AUDIO',
  'CARD',
  'WIDGET',
  'CODE_INTERPRETER'
]);

const FILE_FRAGMENT_TYPES = new Set([
  'FILE',
  'ARTIFACT',
  'ATTACHMENT',
  'DOCUMENT',
  'IMAGE',
  'VIDEO',
  'AUDIO',
  'CARD',
  'WIDGET'
]);

function fragmentLooksLikeJunk(content) {
  const s = String(content || '');
  if (!s) return true;
  if (typeof isCssOrStyleLeakText === 'function' && isCssOrStyleLeakText(s)) return true;
  if (typeof isStructuredCardJunkText === 'function' && isStructuredCardJunkText(s)) return true;
  return false;
}

function extractFileCardsFromFragments(fragments) {
  if (!Array.isArray(fragments)) return [];
  const cards = [];
  for (const f of fragments) {
    if (!f || !FILE_FRAGMENT_TYPES.has(f.type)) continue;
    const raw = typeof f.content === 'string' ? f.content : JSON.stringify(f.content || '');
    let title = '生成文件';
    try {
      const obj = typeof f.content === 'object' ? f.content : JSON.parse(raw);
      title =
        obj?.title ||
        obj?.name ||
        obj?.file_name ||
        obj?.filename ||
        obj?.display_name ||
        title;
    } catch {
      const m = String(raw).match(/[\u4e00-\u9fffA-Za-z0-9_\-.]{2,40}/);
      if (m) title = m[0];
    }
    cards.push({
      kind: 'file',
      type: String(f.type || 'generated_file').toLowerCase(),
      title: String(title).slice(0, 80),
      generatedAt: ''
    });
  }
  return cards;
}

function extractContentFromFragments(fragments, role) {
  if (!Array.isArray(fragments) || !fragments.length) return '';

  const fileCards = extractFileCardsFromFragments(fragments);
  const fileBlock =
    typeof formatGeneratedFileCardsMarkdown === 'function'
      ? formatGeneratedFileCardsMarkdown(fileCards)
      : '';

  const primaryType = role === 'user' ? 'REQUEST' : 'RESPONSE';
  let content = joinFragments(fragments, primaryType);

  if (!content && role === 'assistant') {
    content = fragments
      .filter((f) => f?.type === 'RESPONSE' || f?.type === 'TEXT')
      .map((f) => (typeof f?.content === 'string' ? f.content : ''))
      .filter((t) => t && !fragmentLooksLikeJunk(t))
      .join('\n')
      .trim();
  }

  // 仅回退到「像正文」的未知类型；绝不拼 FILE/TOOL/CSS
  if (!content) {
    content = fragments
      .filter((f) => f?.type && !SKIP_FRAGMENT_TYPES.has(f.type) && !FILE_FRAGMENT_TYPES.has(f.type))
      .map((f) => (typeof f?.content === 'string' ? f.content : ''))
      .filter((t) => t && !fragmentLooksLikeJunk(t) && t.length < 50000)
      .join('\n')
      .trim();
  }

  if (typeof sanitizeAssistantContentForSave === 'function') {
    content = sanitizeAssistantContentForSave(content);
  } else if (typeof stripCssLeakText === 'function') {
    content = stripCssLeakText(content);
  }

  if (fileBlock) {
    content = content ? `${content}\n\n${fileBlock}` : fileBlock;
  }
  return content;
}

function extractApiMessageContent(msg) {
  if (!msg) return '';
  let out = '';
  if (typeof msg.content === 'string') {
    out = msg.content.trim();
  } else {
    const content = msg.content;
    if (content && typeof content === 'object') {
      if (Array.isArray(content.parts)) {
        out = content.parts
          .map((p) => (typeof p === 'string' ? p : p?.text || p?.content || ''))
          .join('')
          .trim();
      } else if (typeof content.text === 'string') {
        out = content.text.trim();
      }
    }
  }

  if (!out) {
    const role = normalizeApiRole(msg.role) || 'assistant';
    if (Array.isArray(msg.fragments)) {
      return extractContentFromFragments(msg.fragments, role);
    }
    out = String(msg.text || msg.message || '').trim();
  }

  if (typeof sanitizeAssistantContentForSave === 'function') {
    return sanitizeAssistantContentForSave(out);
  }
  if (typeof stripCssLeakText === 'function') {
    return stripCssLeakText(out);
  }
  return out;
}

function parseLegacyMessages(raw) {
  return raw
    .map((m) => {
      const role = normalizeApiRole(m?.role);
      if (!role) return null;
      const content = extractApiMessageContent(m);
      if (!content) return null;
      return {
        role,
        content,
        timestamp: m.created_at || m.inserted_at || m.create_time || null
      };
    })
    .filter(Boolean);
}

function inferMessageRole(msg, byId) {
  const role = normalizeApiRole(msg?.role);
  if (role) return role;

  if (Array.isArray(msg?.fragments)) {
    if (msg.fragments.some((f) => f?.type === 'REQUEST')) return 'user';
    if (msg.fragments.some((f) => f?.type === 'RESPONSE')) return 'assistant';
  }

  if (byId && msg?.parent_id != null) {
    const parent = byId.get(msg.parent_id);
    if (parent) {
      const parentRole = inferMessageRole(parent, byId);
      if (parentRole === 'assistant') return 'user';
      if (parentRole === 'user') return 'assistant';
    }
  }

  return null;
}

function linearizeChatMessages(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];

  const byId = new Map();
  for (const m of raw) {
    if (m?.message_id != null) byId.set(m.message_id, m);
  }

  if (!byId.size) return [...raw];

  const parentIds = new Set(raw.map((m) => m.parent_id).filter((id) => id != null));
  const leaves = raw.filter((m) => m.message_id != null && !parentIds.has(m.message_id));
  const start =
    leaves.length > 0
      ? leaves.reduce((a, b) => ((a.message_id || 0) > (b.message_id || 0) ? a : b))
      : raw.reduce((a, b) => ((a.message_id || 0) > (b.message_id || 0) ? a : b));

  const chain = [];
  const seen = new Set();
  let cur = start;
  while (cur && cur.message_id != null && !seen.has(cur.message_id)) {
    seen.add(cur.message_id);
    chain.push(cur);
    cur = cur.parent_id != null ? byId.get(cur.parent_id) : null;
  }

  if (chain.length >= 2) {
    chain.reverse();
    return chain;
  }

  return [...raw].sort((a, b) => (a.message_id || 0) - (b.message_id || 0));
}

function parseChatMessages(raw) {
  const sorted = linearizeChatMessages(raw);
  const byId = new Map();
  for (const m of sorted) {
    if (m?.message_id != null) byId.set(m.message_id, m);
  }

  const latestAssistantByParent = new Map();
  for (const m of sorted) {
    const role = inferMessageRole(m, byId);
    if (role === 'assistant' && m.parent_id != null) {
      const prev = latestAssistantByParent.get(m.parent_id);
      if (!prev || (m.message_id || 0) > (prev.message_id || 0)) {
        latestAssistantByParent.set(m.parent_id, m);
      }
    }
  }

  const result = [];
  for (const m of sorted) {
    const role = inferMessageRole(m, byId);
    if (!role) continue;

    if (role === 'assistant' && m.parent_id != null) {
      const latest = latestAssistantByParent.get(m.parent_id);
      if (latest && latest.message_id !== m.message_id) continue;
    }

    const content = Array.isArray(m.fragments)
      ? extractContentFromFragments(m.fragments, role)
      : extractApiMessageContent(m);

    if (!content) continue;

    result.push({
      role,
      content,
      timestamp: m.inserted_at || m.created_at || null
    });
  }

  return result;
}

function parseHistoryPayload(payload) {
  if (!payload || (payload.code !== 0 && payload.code !== undefined)) return [];

  const biz = payload?.data?.biz_data;
  if (!biz) return [];

  if (Array.isArray(biz.chat_messages) && biz.chat_messages.length) {
    return parseChatMessages(biz.chat_messages);
  }

  if (Array.isArray(biz.messages) && biz.messages.length) {
    return parseLegacyMessages(biz.messages);
  }

  return [];
}

function mergeHistoryPayloads(prev, next) {
  const prevBiz = prev?.data?.biz_data;
  const nextBiz = next?.data?.biz_data;
  if (!prevBiz || !nextBiz) return next;

  if (Array.isArray(prevBiz.chat_messages) || Array.isArray(nextBiz.chat_messages)) {
    const byId = new Map();
    for (const m of [...(prevBiz.chat_messages || []), ...(nextBiz.chat_messages || [])]) {
      if (m?.message_id != null) byId.set(m.message_id, m);
      else byId.set(`_${byId.size}`, m);
    }
    const chat_messages = [...byId.values()].sort(
      (a, b) => (a.message_id || 0) - (b.message_id || 0)
    );
    return {
      ...next,
      data: {
        ...next.data,
        biz_data: { ...nextBiz, chat_messages }
      }
    };
  }

  return next;
}

function pageHasMore(payload, batch, offset) {
  const biz = payload?.data?.biz_data;
  if (biz?.has_more === false || biz?.hasMore === false) return false;
  if (biz?.has_more === true || biz?.hasMore === true) return true;

  const total = biz?.total ?? biz?.total_count ?? biz?.message_count;
  if (typeof total === 'number') {
    return offset + batch.length < total;
  }

  return true;
}

function countRawMessages(payload) {
  const biz = payload?.data?.biz_data;
  return (biz?.chat_messages || biz?.messages || []).length;
}

async function fetchHistoryPage(sessionId, offset, limit) {
  const token = getDeepSeekAuthToken();
  const params = new URLSearchParams({ chat_session_id: sessionId });
  if (typeof offset === 'number' && typeof limit === 'number') {
    params.set('offset', String(offset));
    params.set('limit', String(limit));
  }
  const url = `https://chat.deepseek.com/api/v0/chat/history_messages?${params}`;

  const headers = {
    Accept: 'application/json',
    Referer: `https://chat.deepseek.com/a/chat/s/${sessionId}`,
    'x-client-platform': 'web',
    'x-client-locale': 'zh_CN'
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(url, {
      credentials: 'include',
      headers,
      signal: controller.signal
    });
    if (!res.ok) return null;
    const payload = await res.json();
    if (payload?.code !== 0 && payload?.code !== undefined) return null;
    return payload;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 页面主环境代发 history 请求 */
function requestDeepSeekPageFetch(sessionId, offset, limit, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const requestId = `ds_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      document.removeEventListener('acm-deepseek-fetch-response', onResp);
      resolve(null);
    }, timeoutMs);

    function onResp(event) {
      const detail = event?.detail;
      if (!detail || detail.requestId !== requestId) return;
      clearTimeout(timer);
      document.removeEventListener('acm-deepseek-fetch-response', onResp);
      resolve(detail.ok ? detail.payload : null);
    }

    document.addEventListener('acm-deepseek-fetch-response', onResp);
    document.dispatchEvent(
      new CustomEvent('acm-deepseek-fetch-request', {
        detail: { requestId, sessionId, offset, limit },
        bubbles: true
      })
    );
  });
}

async function fetchAllHistoryPayload(sessionId, pageFetcher) {
  let merged = null;
  const limit = 50;
  let offset = 0;

  for (let pageIndex = 0; pageIndex < 200; pageIndex++) {
    const page = await pageFetcher(sessionId, offset, limit);
    if (!page) break;

    const batch =
      page?.data?.biz_data?.chat_messages || page?.data?.biz_data?.messages || [];
    if (!Array.isArray(batch) || !batch.length) break;

    const beforeCount = countRawMessages(merged);
    merged = merged ? mergeHistoryPayloads(merged, page) : page;
    const afterCount = countRawMessages(merged);

    if (afterCount === beforeCount) break;
    if (!pageHasMore(page, batch, offset)) break;

    offset += batch.length;
  }

  if (!merged) {
    merged = await pageFetcher(sessionId);
  }

  return merged;
}

function getCachedDeepSeekPayload(sessionId) {
  const hit = __acmDeepSeekCache[sessionId];
  if (!hit?.payload) return null;
  if (Date.now() - (hit.ts || 0) > 10 * 60 * 1000) return null;
  return hit.payload;
}

async function waitForDeepSeekCache(sessionId, ms = 1500) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const cached = getCachedDeepSeekPayload(sessionId);
    if (cached && countRawMessages(cached) > 0) return cached;
    await new Promise((r) => setTimeout(r, 200));
  }
  return getCachedDeepSeekPayload(sessionId);
}

async function fetchDeepSeekConversation(sessionId) {
  if (!sessionId) return null;
  injectDeepSeekHook();

  // 1) Content Script 主动拉取
  let payload = await fetchAllHistoryPayload(sessionId, fetchHistoryPage);
  let source = 'api-fetch';

  // 2) 页面主环境 fetch
  if (!payload || !countRawMessages(payload)) {
    console.warn('[ACM DeepSeek] CS fetch 无数据，尝试页面主环境 fetch');
    payload = await fetchAllHistoryPayload(sessionId, requestDeepSeekPageFetch);
    source = 'page-fetch';
  }

  // 3) Hook 缓存
  if (!payload || !countRawMessages(payload)) {
    console.warn('[ACM DeepSeek] 页面 fetch 无数据，等待 Hook 缓存');
    payload = await waitForDeepSeekCache(sessionId, 2000);
    source = 'hook-cache';
  }

  if (!payload) return null;

  const messages = parseHistoryPayload(payload);
  if (!messages.length) return null;

  console.log('[ACM DeepSeek] API 解析', messages.length, '条，来源:', source);
  return { messages, source: 'api', sessionId, fetchSource: source };
}

const __acmDeepSeekCache = {};

function setupDeepSeekCacheListener() {
  if (window.__acmDeepSeekCacheListening) return;
  window.__acmDeepSeekCacheListening = true;
  document.addEventListener('acm-deepseek-history', (event) => {
    const { sessionId, payload } = event.detail || {};
    if (!sessionId || !payload) return;
    const prev = __acmDeepSeekCache[sessionId]?.payload;
    __acmDeepSeekCache[sessionId] = {
      payload: prev ? mergeHistoryPayloads(prev, payload) : payload,
      ts: Date.now()
    };
  });
}

function injectDeepSeekHook() {
  setupDeepSeekCacheListener();
  if (document.documentElement?.getAttribute('data-acm-ds-hook') === '1') return;
  try {
    document.documentElement?.setAttribute('data-acm-ds-hook', '1');
  } catch {
    // ignore
  }

  const source = `
(function () {
  if (window.__acmDeepSeekHooked) return;
  window.__acmDeepSeekHooked = true;
  var origFetch = window.fetch;

  function isHistoryUrl(url) {
    return typeof url === 'string' && url.indexOf('/api/v0/chat/history_messages') !== -1;
  }
  function extractSessionId(url) {
    try { return new URL(url, location.origin).searchParams.get('chat_session_id'); }
    catch (e) { return null; }
  }
  function getAuthToken() {
    try {
      var raw = localStorage.getItem('userToken');
      if (!raw) return null;
      try {
        var parsed = JSON.parse(raw);
        return parsed && (parsed.value || parsed.token) || null;
      } catch (e) {
        return raw.indexOf('Bearer ') === 0 ? raw.slice(7) : raw;
      }
    } catch (e) { return null; }
  }
  function publishHistory(sessionId, payload) {
    if (!sessionId || !payload) return;
    document.dispatchEvent(new CustomEvent('acm-deepseek-history', {
      detail: { sessionId: sessionId, payload: payload },
      bubbles: true
    }));
  }
  async function fetchHistoryInPage(sessionId, offset, limit) {
    var params = new URLSearchParams({ chat_session_id: sessionId });
    if (typeof offset === 'number' && typeof limit === 'number') {
      params.set('offset', String(offset));
      params.set('limit', String(limit));
    }
    var url = '/api/v0/chat/history_messages?' + params.toString();
    var token = getAuthToken();
    var headers = {
      Accept: 'application/json',
      Referer: location.origin + '/a/chat/s/' + sessionId,
      'x-client-platform': 'web',
      'x-client-locale': 'zh_CN'
    };
    if (token) headers.Authorization = 'Bearer ' + token;
    var res = await origFetch(url, { credentials: 'include', headers: headers });
    if (!res.ok) return null;
    var payload = await res.json();
    if (payload && payload.code !== 0 && payload.code !== undefined) return null;
    publishHistory(sessionId, payload);
    return payload;
  }

  document.addEventListener('acm-deepseek-fetch-request', async function (event) {
    var detail = event.detail || {};
    var requestId = detail.requestId;
    var sessionId = detail.sessionId;
    if (!requestId || !sessionId) return;
    try {
      var payload = await fetchHistoryInPage(sessionId, detail.offset, detail.limit);
      document.dispatchEvent(new CustomEvent('acm-deepseek-fetch-response', {
        detail: { requestId: requestId, sessionId: sessionId, payload: payload, ok: !!payload },
        bubbles: true
      }));
    } catch (err) {
      document.dispatchEvent(new CustomEvent('acm-deepseek-fetch-response', {
        detail: { requestId: requestId, sessionId: sessionId, payload: null, ok: false, error: String(err && err.message || err) },
        bubbles: true
      }));
    }
  });

  window.fetch = async function () {
    var res = await origFetch.apply(this, arguments);
    try {
      var input = arguments[0];
      var url = typeof input === 'string' ? input : (input && input.url);
      if (isHistoryUrl(url)) {
        res.clone().json().then(function (data) {
          publishHistory(extractSessionId(url), data);
        }).catch(function () {});
      }
    } catch (e) {}
    return res;
  };

  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__acmUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (isHistoryUrl(this.__acmUrl)) {
      this.addEventListener('load', function () {
        try {
          if (this.status >= 200 && this.status < 300) {
            publishHistory(extractSessionId(this.__acmUrl), JSON.parse(this.responseText));
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

setupDeepSeekCacheListener();
injectDeepSeekHook();

if (typeof globalThis !== 'undefined') {
  globalThis.injectDeepSeekHook = injectDeepSeekHook;
  globalThis.getDeepSeekSessionId = getDeepSeekSessionId;
  globalThis.fetchDeepSeekConversation = fetchDeepSeekConversation;
  globalThis.parseHistoryPayload = parseHistoryPayload;
}
