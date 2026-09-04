/**
 * 腾讯元宝官方接口读取对话原文
 * 优先：Hook 缓存 / 回放页面真实请求 → 再主动拉 v1/detail（不再盲探 404 路径）
 */
const __acmYuanbaoCache = {
  byId: new Map(),
  latest: null,
  lastRequest: null // { url, body, conversationId, ts }
};

/** 仅保留线上真实存在的 detail 接口，避免 /api/conversation/* 404 刷屏 */
const YUANBAO_DETAIL_PATHS = ['/api/user/agent/conversation/v1/detail'];

const YUANBAO_KNOWN_AGENTS = new Set(['naQivTmsDa', 'nb2blYJvJe']);
const YUANBAO_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isYuanbaoConversationId(id) {
  const s = String(id || '');
  if (!s || s.length < 8) return false;
  if (YUANBAO_KNOWN_AGENTS.has(s)) return false;
  if (YUANBAO_UUID_RE.test(s)) return true;
  // 非短 agent slug：含连字符或较长
  if (s.includes('-') && s.length >= 16) return true;
  if (s.length >= 20) return true;
  return false;
}

function getYuanbaoPathInfo() {
  const path = location.pathname || '';
  // /chat/{agentId}/{conversationId}
  let m = path.match(/\/chat\/([0-9a-zA-Z_-]+)\/([0-9a-zA-Z_-]{8,})/i);
  if (m) {
    return { agentId: m[1], conversationId: isYuanbaoConversationId(m[2]) ? m[2] : null };
  }
  // /chat/{id} — id 可能是 agent 或 conversation
  m = path.match(/\/chat\/([0-9a-zA-Z_-]{6,})/i);
  if (m) {
    const id = m[1];
    if (isYuanbaoConversationId(id)) {
      return { agentId: getYuanbaoAgentIdFromStorage(), conversationId: id };
    }
    if (YUANBAO_KNOWN_AGENTS.has(id) || (id.length <= 12 && !/-/.test(id))) {
      return { agentId: id, conversationId: null };
    }
    return { agentId: null, conversationId: id };
  }
  const q = new URLSearchParams(location.search);
  const qCid =
    q.get('conversationId') ||
    q.get('conversation_id') ||
    q.get('chatId') ||
    q.get('cid') ||
    null;
  return {
    agentId: q.get('agentId') || q.get('agent_id') || null,
    conversationId: qCid && isYuanbaoConversationId(qCid) ? qCid : qCid
  };
}

function getYuanbaoAgentIdFromStorage() {
  try {
    const raw =
      localStorage.getItem('agentId') ||
      sessionStorage.getItem('agentId') ||
      localStorage.getItem('yb_agent_id');
    if (raw) return String(raw).replace(/^"|"$/g, '');
  } catch {
    // ignore
  }
  return 'naQivTmsDa';
}

/**
 * 当前会话 ID：只认 URL / 查询参数 / 本次 detail 请求体里的真实 conversationId
 * 禁止回退到「任意缓存最新一条」，否则会把不同对话串成同一条
 */
function getYuanbaoConversationId() {
  const info = getYuanbaoPathInfo();
  if (info.conversationId && isYuanbaoConversationId(info.conversationId)) {
    return info.conversationId;
  }
  const last = __acmYuanbaoCache.lastRequest;
  if (
    last?.conversationId &&
    isYuanbaoConversationId(last.conversationId) &&
    Date.now() - (last.ts || 0) < 2 * 60 * 1000
  ) {
    // 仅当仍在同一 agent 页时可用（URL 尚未带上 uuid 的 SPA 过渡态）
    const agentNow = info.agentId || getYuanbaoAgentId();
    if (!last.agentId || last.agentId === agentNow) {
      return last.conversationId;
    }
  }
  return null;
}

function getYuanbaoAgentId() {
  const info = getYuanbaoPathInfo();
  if (info.agentId) return info.agentId;
  return getYuanbaoAgentIdFromStorage();
}

/** 规范化保存用 URL，确保不同会话不会因共用 /chat/agentId 而互相覆盖 */
function buildYuanbaoCanonicalUrl(conversationId, agentId) {
  const aid = agentId || getYuanbaoAgentId() || 'naQivTmsDa';
  const cid = conversationId || getYuanbaoConversationId();
  if (cid && isYuanbaoConversationId(cid)) {
    return `https://yuanbao.tencent.com/chat/${aid}/${cid}`;
  }
  try {
    return `${location.origin}${location.pathname}`;
  } catch {
    return `https://yuanbao.tencent.com/chat/${aid}`;
  }
}

function extractYuanbaoIdFromPayload(payload) {
  const d = unwrapYuanbaoDetail(payload) || payload;
  if (!d || typeof d !== 'object') return null;
  const id =
    d.conversationId ||
    d.conversation_id ||
    d.cid ||
    d.id ||
    d.chatId ||
    payload?.conversationId ||
    payload?.data?.conversationId;
  return id && isYuanbaoConversationId(id) ? String(id) : null;
}

function unwrapYuanbaoDetail(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [
    payload,
    payload.data,
    payload.result,
    payload.response,
    payload.payload,
    payload.data?.data,
    payload.result?.result
  ];
  for (const c of candidates) {
    if (c && Array.isArray(c.convs)) return c;
  }
  return null;
}

/**
 * 清洗元宝正文里的内部标记（下划线 / 引用角标 / 媒体占位等）
 * 例：[](@mark_underline=1)[citation:2] (@replace=media_xxx) → 去掉或替换为附件
 */
function cleanYuanbaoMarkup(text, mediaMap = null) {
  let s = String(text || '');
  if (!s) return '';

  // 媒体占位：(@replace=media_xxx) → 尽量还原为图片/文件，否则去掉
  s = s.replace(/\(@replace=([^)]+)\)/gi, (_, rawId) => {
    const id = String(rawId || '').trim();
    if (!id || !mediaMap) return '';
    const media =
      mediaMap.get(id) ||
      mediaMap.get(id.replace(/^media_/i, '')) ||
      mediaMap.get(`media_${id}`);
    if (!media) return '';
    const name = media.fileName || media.name || media.title || '附件';
    const url = media.url || media.fileUrl || media.downloadUrl || '';
    const type = String(media.type || media.fileType || '').toLowerCase();
    if (url && /image|img|png|jpe?g|gif|webp/.test(type + name)) {
      return `\n![${name}](${url})\n`;
    }
    if (url) return `\n[${name}](${url})\n`;
    if (typeof formatGeneratedFileCardsMarkdown === 'function') {
      return (
        '\n' +
        formatGeneratedFileCardsMarkdown([
          { kind: 'file', type: type || 'file', title: name, generatedAt: '' }
        ]) +
        '\n'
      );
    }
    return `\n📎 **${name}**\n`;
  });

  // 其它内部指令：(@xxx=yyy)
  s = s.replace(/\(@[a-zA-Z_][\w]*=[^)]*\)/g, '');

  // 常见组合：[](@mark_underline=n)[citation:m]
  s = s.replace(/\[\s*\]\s*\(@mark_underline=\d+\)/gi, '');
  s = s.replace(/\(@mark_underline=\d+\)/gi, '');
  s = s.replace(/\[citation:\d+\]/gi, '');
  s = s.replace(/\[\s*cite[^\]]*\]/gi, '');
  s = s.replace(/\[\s*ref[^\]]*\]/gi, '');
  // 残留空方括号（引用占位）
  s = s.replace(/\[\s*\]/g, '');
  // 元宝偶发的零宽 / 特殊空白
  s = s.replace(/[\u200b\u200c\u200d\ufeff]/g, '');
  // 标记去掉后可能留下的多余空格
  s = s.replace(/[ \t]{2,}/g, ' ');
  s = s.replace(/ ?([，。！？；：、）】」》])/g, '$1');
  s = s.replace(/([（【「《]) /g, '$1');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function buildYuanbaoMediaMap(data, turns = []) {
  const map = new Map();
  const add = (item) => {
    if (!item || typeof item !== 'object') return;
    const id =
      item.id ||
      item.mediaId ||
      item.media_id ||
      item.fileId ||
      item.file_id ||
      item.key;
    if (!id) return;
    const entry = {
      fileName: item.fileName || item.name || item.title || '',
      url: item.url || item.fileUrl || item.downloadUrl || item.src || '',
      type: item.type || item.fileType || item.mimeType || ''
    };
    map.set(String(id), entry);
    map.set(`media_${id}`, entry);
    const bare = String(id).replace(/^media_/i, '');
    if (bare !== String(id)) map.set(bare, entry);
  };

  const bags = [
    data?.multiMediaInfo,
    data?.multimedia,
    data?.mediaList,
    data?.medias,
    data?.files
  ];
  for (const bag of bags) {
    if (Array.isArray(bag)) bag.forEach(add);
  }

  for (const turn of turns) {
    const speeches = turn?.speechesV2 || turn?.speeches || [];
    for (const speech of speeches) {
      for (const block of speech?.content || []) {
        if (block && (block.fileName || block.url || block.type === 'image')) add(block);
      }
    }
  }
  return map;
}

function extractYuanbaoBlockText(block, mediaMap = null) {
  if (!block || typeof block !== 'object') return '';
  const type = String(block.type || '').toLowerCase();
  if (type === 'think' || type === 'thinking' || type === 'searchguid') return '';
  if (type === 'text' || !type) {
    const t = block.msg || block.text || block.content || '';
    return cleanYuanbaoMarkup(typeof t === 'string' ? t : '', mediaMap);
  }
  if (block.fileName || block.url || type === 'image' || type === 'pdf' || type === 'code') {
    const title = block.fileName || block.title || type || '附件';
    const url = block.url || '';
    if (url && /image|img|png|jpe?g|gif|webp/i.test(type + title)) {
      return `![${title}](${url})`;
    }
    if (typeof formatGeneratedFileCardsMarkdown === 'function') {
      return formatGeneratedFileCardsMarkdown([
        { kind: 'file', type: type || 'file', title, generatedAt: '' }
      ]);
    }
    return `📎 **${title}**`;
  }
  return '';
}

function extractYuanbaoTurnContent(turn, mediaMap = null) {
  if (!turn || typeof turn !== 'object') return '';
  const parts = [];
  const speeches = turn.speechesV2 || turn.speeches || turn.speechList || [];
  for (const speech of speeches) {
    const blocks = speech?.content || speech?.contents || [];
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        const t = extractYuanbaoBlockText(block, mediaMap);
        if (t) parts.push(t);
      }
    }
    if (typeof speech?.msg === 'string' && speech.msg.trim()) {
      parts.push(cleanYuanbaoMarkup(speech.msg, mediaMap));
    }
    if (typeof speech?.text === 'string' && speech.text.trim()) {
      parts.push(cleanYuanbaoMarkup(speech.text, mediaMap));
    }
  }
  if (!parts.length && typeof turn.displayPrompt === 'string' && turn.displayPrompt.trim()) {
    parts.push(cleanYuanbaoMarkup(turn.displayPrompt, mediaMap));
  }
  if (!parts.length && typeof turn.prompt === 'string' && turn.prompt.trim()) {
    parts.push(cleanYuanbaoMarkup(turn.prompt, mediaMap));
  }
  return cleanYuanbaoMarkup(parts.join('\n\n'), mediaMap);
}

function normalizeYuanbaoRole(speaker) {
  const s = String(speaker || '').toLowerCase();
  if (s === 'human' || s === 'user' || s === '1') return 'user';
  if (s === 'ai' || s === 'assistant' || s === 'bot' || s === 'yuanbao' || s === '2') {
    return 'assistant';
  }
  return null;
}

function countYuanbaoConvs(payload) {
  const d = unwrapYuanbaoDetail(payload);
  return Array.isArray(d?.convs) ? d.convs.length : 0;
}

/** 合并多次 detail 响应的 convs（按 index+speaker），避免 Hook 只带回最新一轮 */
function mergeYuanbaoDetailPayloads(payloads) {
  const list = (payloads || []).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];

  const byKey = new Map();
  let base = null;
  let title = '';

  for (const p of list) {
    const d = unwrapYuanbaoDetail(p);
    if (!d) continue;
    if (!base) base = { ...d };
    title = d.sessionTitle || d.title || title;
    // 合并多媒体元数据
    if (Array.isArray(d.multiMediaInfo) && d.multiMediaInfo.length) {
      const prev = Array.isArray(base.multiMediaInfo) ? base.multiMediaInfo : [];
      const seen = new Set(prev.map((x) => x?.id || x?.url || JSON.stringify(x)));
      for (const m of d.multiMediaInfo) {
        const k = m?.id || m?.url || JSON.stringify(m);
        if (!seen.has(k)) {
          prev.push(m);
          seen.add(k);
        }
      }
      base.multiMediaInfo = prev;
    }
    for (const turn of d.convs || []) {
      const role = turn?.speaker || turn?.role || '';
      const key = `${turn?.index ?? ''}::${role}::${turn?.id || turn?.speechId || ''}`;
      const altKey = `${turn?.index ?? ''}::${role}`;
      const prev = byKey.get(key) || byKey.get(altKey);
      const curLen = extractYuanbaoTurnContent(turn).length;
      const prevLen = prev ? extractYuanbaoTurnContent(prev).length : -1;
      if (!prev || curLen >= prevLen) {
        byKey.set(altKey, turn);
        byKey.set(key, turn);
      }
    }
  }

  if (!base) return list[0];
  const convs = [];
  const seenAlt = new Set();
  for (const [k, turn] of byKey) {
    const role = turn?.speaker || turn?.role || '';
    const altKey = `${turn?.index ?? ''}::${role}`;
    if (k !== altKey) continue;
    if (seenAlt.has(altKey)) continue;
    seenAlt.add(altKey);
    convs.push(turn);
  }
  convs.sort((a, b) => (Number(a?.index) || 0) - (Number(b?.index) || 0));
  return {
    ...base,
    convs,
    sessionTitle: title || base.sessionTitle || base.title || ''
  };
}

function parseYuanbaoDetailPayload(payload) {
  const data = unwrapYuanbaoDetail(payload);
  if (!data) return { messages: [], title: '' };

  const convs = Array.isArray(data.convs) ? [...data.convs] : [];
  convs.sort((a, b) => (Number(a?.index) || 0) - (Number(b?.index) || 0));
  const mediaMap = buildYuanbaoMediaMap(data, convs);

  const messages = [];
  for (const turn of convs) {
    const role = normalizeYuanbaoRole(turn?.speaker || turn?.role);
    if (!role) continue;
    let content = extractYuanbaoTurnContent(turn, mediaMap);
    if (!content) continue;
    if (role === 'assistant' && typeof sanitizeAssistantContentForSave === 'function') {
      content = sanitizeAssistantContentForSave(content);
    }
    if (!content) continue;
    const ts = turn.createTime || turn.createdAt || turn.create_time || null;
    messages.push({
      role,
      content,
      timestamp: typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts
    });
  }

  const title =
    data.sessionTitle ||
    data.title ||
    data.conversationTitle ||
    data.name ||
    '';
  return { messages, title: String(title || '').trim() };
}

function rememberYuanbaoPayload(conversationId, payload, meta = null) {
  const payloadId =
    (conversationId && isYuanbaoConversationId(conversationId) ? String(conversationId) : null) ||
    extractYuanbaoIdFromPayload(payload) ||
    (meta?.conversationId && isYuanbaoConversationId(meta.conversationId)
      ? String(meta.conversationId)
      : null);

  // 没有明确会话 ID 时不写入 byId / latest，避免污染其它对话
  if (!payloadId) return;

  const prev = __acmYuanbaoCache.byId.get(payloadId)?.payload;
  const merged = mergeYuanbaoDetailPayloads([prev, payload].filter(Boolean)) || payload;
  const entry = { payload: merged, ts: Date.now(), conversationId: payloadId };
  __acmYuanbaoCache.byId.set(payloadId, entry);
  __acmYuanbaoCache.latest = entry;

  if (meta?.url || meta?.body) {
    const prevN = countYuanbaoConvs(prev);
    const nextN = countYuanbaoConvs(payload);
    if (
      !__acmYuanbaoCache.lastRequest ||
      __acmYuanbaoCache.lastRequest.conversationId !== payloadId ||
      nextN >= prevN
    ) {
      __acmYuanbaoCache.lastRequest = {
        url: meta.url || '',
        body: meta.body || null,
        conversationId: payloadId,
        agentId: getYuanbaoAgentId(),
        ts: Date.now()
      };
    }
  }
}

function getCachedYuanbaoPayload(conversationId) {
  if (!conversationId || !isYuanbaoConversationId(conversationId)) return null;
  const hit = __acmYuanbaoCache.byId.get(String(conversationId));
  if (hit && Date.now() - (hit.ts || 0) < 10 * 60 * 1000) return hit.payload;
  return null;
}

async function waitForYuanbaoCache(conversationId, ms = 2500) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const cached = getCachedYuanbaoPayload(conversationId);
    if (cached && unwrapYuanbaoDetail(cached)) return cached;
    await new Promise((r) => setTimeout(r, 200));
  }
  return getCachedYuanbaoPayload(conversationId);
}

function buildYuanbaoDetailBodies(conversationId) {
  const agentId = getYuanbaoAgentId();
  const bodies = [
    { conversationId, offset: 0, limit: 200 },
    { conversationId, agentId, offset: 0, limit: 200 },
    { conversationId },
    { conversationId, agentId },
    { conversationId, agent_id: agentId },
    { conversation_id: conversationId, agentId },
    { cid: conversationId, agentId }
  ];
  // 回放页面真实成功请求体（最优先，强制写入目标 conversationId）
  const lastMeta = __acmYuanbaoCache.lastRequest;
  const last = lastMeta?.body;
  const lastCid =
    lastMeta?.conversationId ||
    last?.conversationId ||
    last?.conversation_id ||
    last?.cid ||
    null;
  if (last && typeof last === 'object' && (!lastCid || String(lastCid) === String(conversationId))) {
    bodies.unshift({
      ...last,
      conversationId,
      offset: last.offset ?? 0,
      limit: Math.max(Number(last.limit) || 0, 200) || 200
    });
  }
  return bodies;
}

async function postYuanbaoDetail(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`https://yuanbao.tencent.com${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        Referer: location.href,
        Origin: 'https://yuanbao.tencent.com'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!unwrapYuanbaoDetail(json)) return null;
    return json;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchYuanbaoDetailCs(conversationId) {
  // 1) 回放拦截到的真实 URL + body（仅当属于同一会话，避免串内容）
  const last = __acmYuanbaoCache.lastRequest;
  const lastCid =
    last?.conversationId ||
    last?.body?.conversationId ||
    last?.body?.conversation_id ||
    last?.body?.cid ||
    null;
  if (last?.url && last?.body && (!lastCid || String(lastCid) === String(conversationId))) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(last.url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          Referer: location.href,
          Origin: 'https://yuanbao.tencent.com'
        },
        body: JSON.stringify({
          ...last.body,
          conversationId
        }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.ok) {
        const json = await res.json();
        if (unwrapYuanbaoDetail(json)) {
          rememberYuanbaoPayload(conversationId, json, {
            url: last.url,
            body: { ...last.body, conversationId },
            conversationId
          });
          return json;
        }
      }
    } catch {
      // fall through
    }
  }

  // 2) 仅打已知有效路径，每种 body 失败静默继续（不探 404 路径）
  for (const path of YUANBAO_DETAIL_PATHS) {
    for (const body of buildYuanbaoDetailBodies(conversationId)) {
      const payload = await postYuanbaoDetail(path, body);
      if (payload) {
        rememberYuanbaoPayload(conversationId, payload, { url: path, body });
        return payload;
      }
    }
  }
  return null;
}

function requestYuanbaoPageFetch(conversationId, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const requestId = `yb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      document.removeEventListener('acm-yuanbao-fetch-response', onResp);
      resolve(null);
    }, timeoutMs);

    function onResp(event) {
      const detail = event?.detail;
      if (!detail || detail.requestId !== requestId) return;
      clearTimeout(timer);
      document.removeEventListener('acm-yuanbao-fetch-response', onResp);
      resolve(detail.ok ? detail.payload : null);
    }

    document.addEventListener('acm-yuanbao-fetch-response', onResp);
    document.dispatchEvent(
      new CustomEvent('acm-yuanbao-fetch-request', {
        detail: {
          requestId,
          conversationId,
          agentId: getYuanbaoAgentId(),
          lastRequest: __acmYuanbaoCache.lastRequest || null
        },
        bubbles: true
      })
    );
  });
}

async function fetchYuanbaoConversation(conversationId) {
  if (!conversationId) return null;
  injectYuanbaoHook();

  const collected = [];

  // 1) 已有 Hook 缓存（可能只含最新一轮，后面会合并）
  const cached = getCachedYuanbaoPayload(conversationId);
  if (cached && unwrapYuanbaoDetail(cached)) collected.push(cached);

  // 2) 页面主环境主动拉（回放真实请求）
  const pagePayload = await requestYuanbaoPageFetch(conversationId);
  if (pagePayload && unwrapYuanbaoDetail(pagePayload)) collected.push(pagePayload);

  // 3) CS 主动拉 detail（带 offset/limit，尽量全量）
  const csPayload = await fetchYuanbaoDetailCs(conversationId);
  if (csPayload && unwrapYuanbaoDetail(csPayload)) collected.push(csPayload);

  // 4) 再等一会儿页面自己刷新的缓存
  if (!collected.length || Math.max(...collected.map(countYuanbaoConvs)) < 2) {
    const late = await waitForYuanbaoCache(conversationId, 2000);
    if (late && unwrapYuanbaoDetail(late)) collected.push(late);
  }

  const payload = mergeYuanbaoDetailPayloads(collected);
  if (!payload) return null;

  const parsed = parseYuanbaoDetailPayload(payload);
  if (!parsed.messages.length) return null;

  const resolvedId =
    conversationId ||
    extractYuanbaoIdFromPayload(payload) ||
    getYuanbaoConversationId();
  if (resolvedId) {
    rememberYuanbaoPayload(resolvedId, payload);
  }

  const source =
    collected.length > 1
      ? 'merged'
      : csPayload
        ? 'api-fetch'
        : pagePayload
          ? 'page-fetch'
          : 'hook-cache';

  console.log(
    '[ACM Yuanbao] API 解析',
    parsed.messages.length,
    '条 / convs=',
    countYuanbaoConvs(payload),
    'cid=',
    resolvedId,
    '来源:',
    source
  );

  const title =
    parsed.title ||
    (() => {
      const u = parsed.messages.find((m) => m.role === 'user');
      if (!u) return null;
      const t = String(u.content).replace(/\s+/g, ' ').trim();
      return t.slice(0, 40) + (t.length > 40 ? '…' : '');
    })();

  return {
    messages: parsed.messages,
    title: title || null,
    source: 'api',
    sessionId: resolvedId,
    url: buildYuanbaoCanonicalUrl(resolvedId),
    fetchSource: source
  };
}

function setupYuanbaoCacheListener() {
  if (window.__acmYuanbaoCacheListening) return;
  window.__acmYuanbaoCacheListening = true;
  document.addEventListener('acm-yuanbao-history', (event) => {
    const { conversationId, payload, url, body } = event.detail || {};
    if (!payload) return;
    rememberYuanbaoPayload(conversationId || getYuanbaoConversationId(), payload, {
      url,
      body,
      conversationId
    });
  });
}

function injectYuanbaoHook() {
  setupYuanbaoCacheListener();
  if (document.documentElement?.getAttribute('data-acm-yb-hook') === '1') return;
  try {
    document.documentElement?.setAttribute('data-acm-yb-hook', '1');
  } catch {
    // ignore
  }

  // 内联兜底；正式 MAIN 注入见 content/inject/yuanbao-hook.js
  const source = `
(function () {
  if (window.__acmYuanbaoHooked) return;
  window.__acmYuanbaoHooked = true;
  var origFetch = window.fetch;
  function isHistoryUrl(url) {
    if (typeof url !== 'string') return false;
    if (/\\/api\\/chat\\//i.test(url) && /stream|sse|completion/i.test(url)) return false;
    return /\\/api\\/user\\/agent\\/conversation\\/v?\\d*\\/?detail/i.test(url);
  }
  function extractId(bodyText) {
    try {
      var parsed = typeof bodyText === 'string' ? JSON.parse(bodyText) : bodyText;
      var id = parsed && (parsed.conversationId || parsed.conversation_id || parsed.cid || parsed.chatId || parsed.id);
      if (id) return String(id);
    } catch (e) {}
    return null;
  }
  function parseBody(body) {
    if (!body) return null;
    if (typeof body === 'string') {
      try { return JSON.parse(body); } catch (e) { return null; }
    }
    if (typeof body === 'object') return body;
    return null;
  }
  function hasConvs(json) {
    return !!(json && (json.convs || (json.data && json.data.convs) ||
      (json.data && json.data.data && json.data.data.convs)));
  }
  function publish(conversationId, payload, url, body) {
    if (!payload || !hasConvs(payload)) return;
    document.dispatchEvent(new CustomEvent('acm-yuanbao-history', {
      detail: { conversationId: conversationId || null, payload: payload, url: url || '', body: body || null, ts: Date.now() },
      bubbles: true
    }));
  }
  async function fetchDetailInPage(conversationId, agentId, lastRequest) {
    if (lastRequest && lastRequest.url && lastRequest.body) {
      try {
        var replayCid = lastRequest.conversationId || extractId(lastRequest.body);
        if (!replayCid || String(replayCid) === String(conversationId)) {
          var replayBody = Object.assign({}, lastRequest.body, { conversationId: conversationId });
          var r0 = await origFetch(lastRequest.url, {
            method: 'POST', credentials: 'include',
            headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', Referer: location.href },
            body: JSON.stringify(replayBody)
          });
          if (r0.ok) {
            var j0 = await r0.json();
            if (hasConvs(j0)) { publish(conversationId, j0, lastRequest.url, replayBody); return j0; }
          }
        }
      } catch (e0) {}
    }
    var path = '/api/user/agent/conversation/v1/detail';
    var bodies = [
      { conversationId: conversationId },
      { conversationId: conversationId, agentId: agentId || 'naQivTmsDa' }
    ];
    for (var j = 0; j < bodies.length; j++) {
      try {
        var res = await origFetch(path, {
          method: 'POST', credentials: 'include',
          headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', Referer: location.href },
          body: JSON.stringify(bodies[j])
        });
        if (!res.ok) continue;
        var json = await res.json();
        if (!hasConvs(json)) continue;
        publish(conversationId, json, path, bodies[j]);
        return json;
      } catch (e) {}
    }
    return null;
  }
  document.addEventListener('acm-yuanbao-fetch-request', async function (event) {
    var detail = event.detail || {};
    if (!detail.requestId || !detail.conversationId) return;
    try {
      var payload = await fetchDetailInPage(detail.conversationId, detail.agentId, detail.lastRequest);
      document.dispatchEvent(new CustomEvent('acm-yuanbao-fetch-response', {
        detail: { requestId: detail.requestId, conversationId: detail.conversationId, payload: payload, ok: !!payload },
        bubbles: true
      }));
    } catch (err) {
      document.dispatchEvent(new CustomEvent('acm-yuanbao-fetch-response', {
        detail: { requestId: detail.requestId, conversationId: detail.conversationId, payload: null, ok: false, error: String(err && err.message || err) },
        bubbles: true
      }));
    }
  });
  window.fetch = async function () {
    var input = arguments[0];
    var init = arguments[1] || {};
    var url = typeof input === 'string' ? input : (input && input.url);
    var bodyRaw = init.body;
    if (!bodyRaw && input && typeof input !== 'string' && input.method) {
      try { bodyRaw = input.__acmBody || null; } catch (e) {}
    }
    var res = await origFetch.apply(this, arguments);
    try {
      if (isHistoryUrl(url)) {
        var parsedBody = parseBody(bodyRaw);
        res.clone().json().then(function (data) {
          publish(extractId(bodyRaw) || extractId(parsedBody), data, url, parsedBody);
        }).catch(function () {});
      }
    } catch (e) {}
    return res;
  };
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__acmYbUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    this.__acmYbBody = body;
    if (isHistoryUrl(this.__acmYbUrl)) {
      this.addEventListener('load', function () {
        try {
          if (this.status >= 200 && this.status < 300) {
            var parsedBody = parseBody(this.__acmYbBody);
            publish(extractId(this.__acmYbBody), JSON.parse(this.responseText), this.__acmYbUrl, parsedBody);
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
    console.warn('[ACM Yuanbao] hook 注入失败', err);
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.getYuanbaoConversationId = getYuanbaoConversationId;
  globalThis.getYuanbaoAgentId = getYuanbaoAgentId;
  globalThis.buildYuanbaoCanonicalUrl = buildYuanbaoCanonicalUrl;
  globalThis.fetchYuanbaoConversation = fetchYuanbaoConversation;
  globalThis.injectYuanbaoHook = injectYuanbaoHook;
}
