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

function extractKimiBlocksText(blocks) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.think) continue;
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
    const type = String(block.type || '').toLowerCase();
    if (type === 'text' && (block.msg || block.value)) {
      parts.push(String(block.msg || block.value).trim());
    }
  }
  return parts.filter(Boolean).join('\n\n').trim();
}

function extractKimiMessageContent(raw) {
  if (!raw || typeof raw !== 'object') return '';
  let content =
    extractKimiBlocksText(raw.blocks) ||
    extractKimiBlocksText(raw.contents) ||
    extractKimiBlocksText(raw.content_blocks);

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
  return content;
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
  const messages = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const role =
      normalizeKimiRole(m.role) ||
      normalizeKimiRole(m.author?.role) ||
      normalizeKimiRole(m.sender) ||
      normalizeKimiRole(m.type);
    if (!role) continue;
    let content = extractKimiMessageContent(m);
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

  try {
    const el = document.createElement('script');
    el.textContent = source;
    (document.documentElement || document.head || document.body).appendChild(el);
    el.remove();
  } catch (err) {
    console.warn('[ACM Kimi] hook 注入失败', err);
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.getKimiChatId = getKimiChatId;
  globalThis.fetchKimiConversation = fetchKimiConversation;
  globalThis.injectKimiHook = injectKimiHook;
}
