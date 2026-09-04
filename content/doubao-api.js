/**
 * 豆包官方接口读取对话原文
 * 三级兜底（不用 DOM）：Hook 缓存 → MAIN 世界 fetch → CS IM/alice
 */
const DOUBAO_USER_TYPE = {
  UNKNOWN: 0,
  HUMAN: 1,
  AIBOT: 2,
  SYSTEM: 3
};

const DOUBAO_DIR = {
  OLDER: 1,
  NEWER: 2,
  FROM_LATEST: 3
};

const DOUBAO_CONV_TYPE = {
  ONE_TO_BOT_CHAT: 3
};

const __acmDoubaoCache = {
  byId: new Map(), // conversationId -> { payload, ts, url }
  latest: null
};

function getDoubaoConversationId() {
  const path = location.pathname || '';
  const m = path.match(/\/chat\/([0-9a-zA-Z_-]{8,})/);
  if (m && m[1].toLowerCase() !== 'new') return m[1];
  const q = new URLSearchParams(location.search);
  return (
    q.get('conversation_id') ||
    q.get('conversationId') ||
    q.get('chat_id') ||
    null
  );
}

function getDoubaoDeviceId() {
  try {
    const tea = localStorage.getItem('__tea_cache_tokens_497858');
    if (tea) {
      const parsed = JSON.parse(tea);
      if (parsed?.web_id) return String(parsed.web_id);
      if (parsed?.user_unique_id) return String(parsed.user_unique_id);
    }
  } catch {
    // ignore
  }
  return '';
}

function buildDoubaoCommonParams() {
  try {
    const live = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .reverse()
      .find((u) => (u.includes('/im/') || u.includes('/alice/')) && u.includes('?'));
    if (live) {
      const params = new URL(live).searchParams;
      // a_bogus / msToken 容易过期，去掉后让服务端按 cookie 鉴权
      params.delete('a_bogus');
      params.delete('msToken');
      if (params.get('aid') || params.get('version_code')) return params;
    }
  } catch {
    // ignore
  }

  const params = new URLSearchParams({
    version_code: '20800',
    language: 'zh',
    device_platform: 'web',
    doubao_device_platform: 'web',
    aid: '497858',
    real_aid: '497858',
    pkg_type: 'release_version',
    region: 'CN',
    sys_region: 'CN',
    samantha_web: '1',
    web_platform: 'browser',
    'use-olympus-account': '1'
  });
  const deviceId = getDoubaoDeviceId();
  if (deviceId) {
    params.set('device_id', deviceId);
    params.set('web_id', deviceId);
    params.set('tea_uuid', deviceId);
  }
  params.set('web_tab_id', crypto.randomUUID?.() || String(Date.now()));
  return params;
}

function extractDoubaoText(content) {
  if (content == null) return '';

  // content_blocks / content_blocks_v2 直接是数组
  if (Array.isArray(content)) {
    return content
      .map((b) => extractDoubaoBlock(b))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (!trimmed) return '';
    // HTML：转 Markdown 并去掉 style（防 CSS 泄漏）
    if (/<\/?[a-z][\s\S]*>/i.test(trimmed) && typeof htmlOrTextToMarkdown === 'function') {
      const md = htmlOrTextToMarkdown(trimmed);
      if (md) return md;
    }
    // 豆包常把正文包成 JSON 字符串
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        return extractDoubaoText(JSON.parse(trimmed));
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  if (typeof content !== 'object') return String(content).trim();

  // text_block: { text: "..." }
  if (content.text_block && typeof content.text_block === 'object') {
    const t = extractDoubaoText(content.text_block);
    if (t) return t;
  }

  if (typeof content.text === 'string' && content.text.trim()) {
    return content.text.trim();
  }
  if (typeof content.content === 'string') {
    const t = extractDoubaoText(content.content);
    if (t) return t;
  }
  if (content.content && typeof content.content === 'object') {
    const t = extractDoubaoText(content.content);
    if (t) return t;
  }
  if (typeof content.rich_text === 'string') {
    const t = extractDoubaoText(content.rich_text);
    if (t) return t;
  }
  if (content.delta && typeof content.delta.text === 'string') {
    return content.delta.text.trim();
  }
  if (Array.isArray(content.parts)) {
    return content.parts
      .map((p) => (typeof p === 'string' ? p : extractDoubaoText(p)))
      .filter(Boolean)
      .join('')
      .trim();
  }

  const blocks =
    content.content_blocks ||
    content.content_blocks_v2 ||
    content.blocks ||
    content.block_list;
  if (Array.isArray(blocks)) {
    return blocks
      .map((b) => extractDoubaoBlock(b))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  return '';
}

function getDoubaoBlockKind(block) {
  if (!block || typeof block !== 'object') return '';
  return String(
    block.block_type ||
      block.type ||
      block.content_type ||
      block.blockType ||
      block.content?.block_type ||
      block.content?.type ||
      ''
  ).toLowerCase();
}

const DOUBAO_SKIP_BLOCK_KINDS =
  /^(suggest|suggestion|feedback|loading|divider|separator|hint|toast|banner)$/i;
const DOUBAO_FILE_BLOCK_KINDS =
  /^(image|img|video|audio|file|attachment|card|widget|document|doc|ppt|pdf|artifact|canvas|code_file|spreadsheet|excel|zip)$/i;

function looksLikeDoubaoFileBlock(block) {
  if (!block || typeof block !== 'object') return false;
  const kind = getDoubaoBlockKind(block);
  if (DOUBAO_FILE_BLOCK_KINDS.test(kind)) return true;
  if (block.file_info || block.file || block.attachment || block.image_url || block.video_url) {
    return true;
  }
  if (block.content?.file_info || block.content?.image || block.content?.video) return true;
  return false;
}

function formatDoubaoFileBlock(block) {
  const kind = getDoubaoBlockKind(block) || 'generated_file';
  const src =
    block.file_info ||
    block.file ||
    block.attachment ||
    block.content?.file_info ||
    block.content?.file ||
    block.content ||
    block;
  let title =
    src?.title ||
    src?.name ||
    src?.file_name ||
    src?.filename ||
    src?.display_name ||
    block.title ||
    block.name ||
    '';
  if (!title) {
    if (/image|img/.test(kind)) title = '图片';
    else if (/video/.test(kind)) title = '视频';
    else if (/ppt|演示/.test(kind)) title = '演示文稿';
    else if (/pdf|doc/.test(kind)) title = '文档';
    else title = '生成文件';
  }
  const meta = {
    kind: 'file',
    type: kind || 'generated_file',
    title: String(title).slice(0, 80),
    generatedAt: ''
  };
  if (typeof formatGeneratedFileCardsMarkdown === 'function') {
    return formatGeneratedFileCardsMarkdown([meta]);
  }
  return `📎 **${meta.title}**`;
}

function extractDoubaoBlock(block) {
  if (block == null) return '';
  if (typeof block === 'string') return extractDoubaoText(block);
  if (typeof block !== 'object') return String(block).trim();

  const kind = getDoubaoBlockKind(block);
  if (DOUBAO_SKIP_BLOCK_KINDS.test(kind)) return '';

  // 附件 / 卡片：存成文件卡片，不展开 JSON/CSS
  if (looksLikeDoubaoFileBlock(block)) {
    // 仍优先拿同块内真正正文（若有）
    const fromTextBlock =
      block.content?.text_block?.text ||
      block.text_block?.text ||
      block.content_obj?.text_block?.text;
    const textPart =
      typeof fromTextBlock === 'string' && fromTextBlock.trim() ? fromTextBlock.trim() : '';
    const filePart = formatDoubaoFileBlock(block);
    if (textPart && filePart) return `${textPart}\n\n${filePart}`;
    return filePart || textPart;
  }

  // 跳过纯建议/附件等非正文块（仍尽量抽文本）
  const fromTextBlock =
    block.content?.text_block?.text ||
    block.text_block?.text ||
    block.content_obj?.text_block?.text;
  if (typeof fromTextBlock === 'string' && fromTextBlock.trim()) {
    return fromTextBlock.trim();
  }

  if (typeof block.text === 'string' && block.text.trim()) return block.text.trim();

  // block.content 可能是对象 { text_block: { text } }
  if (block.content != null) {
    const t = extractDoubaoText(block.content);
    if (t) return t;
  }
  if (block.content_obj != null) {
    const t = extractDoubaoText(block.content_obj);
    if (t) return t;
  }
  if (block.content_block != null) {
    const t = extractDoubaoText(block.content_block);
    if (t) return t;
  }
  if (block.payload != null) {
    const t = extractDoubaoText(block.payload);
    if (t) return t;
  }
  if (block.data != null) {
    const t = extractDoubaoText(block.data);
    if (t) return t;
  }
  return '';
}

function normalizeDoubaoRole(msg) {
  const utRaw =
    msg?.user_type ??
    msg?.userType ??
    msg?.ext?.user_type ??
    msg?.ext?.userType;
  const ut =
    typeof utRaw === 'string' && /^\d+$/.test(utRaw.trim())
      ? Number(utRaw.trim())
      : utRaw;

  if (
    ut === DOUBAO_USER_TYPE.HUMAN ||
    ut === 'HUMAN' ||
    ut === 'Human' ||
    ut === 'user' ||
    ut === 'USER'
  ) {
    return 'user';
  }
  if (
    ut === DOUBAO_USER_TYPE.AIBOT ||
    ut === 'AIBOT' ||
    ut === 'Bot' ||
    ut === 'BOT' ||
    ut === 'assistant' ||
    ut === 'ASSISTANT'
  ) {
    return 'assistant';
  }
  if (ut === DOUBAO_USER_TYPE.SYSTEM || ut === 'SYSTEM') return null;

  const role = String(msg?.role || msg?.sender_type || msg?.ext?.role || '').toLowerCase();
  if (role === 'user' || role === 'human' || role === '1') return 'user';
  if (role === 'assistant' || role === 'bot' || role === 'aibot' || role === '2') {
    return 'assistant';
  }

  // 无 user_type 时：仅用明确的 bot 回复标记
  if (utRaw == null || utRaw === '' || utRaw === DOUBAO_USER_TYPE.UNKNOWN) {
    if (msg?.bot_reply_message_id) return 'assistant';
  }
  return null;
}

function flattenDeepArrays(node, depth = 0, out = []) {
  if (depth > 6 || node == null) return out;
  if (Array.isArray(node)) {
    if (node.length && typeof node[0] === 'object' && node[0]) {
      const sample = node[0];
      if (
        'content' in sample ||
        'user_type' in sample ||
        'message_id' in sample ||
        'display_content' in sample
      ) {
        out.push(node);
      }
    }
    for (const item of node) flattenDeepArrays(item, depth + 1, out);
    return out;
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node)) flattenDeepArrays(v, depth + 1, out);
  }
  return out;
}

function collectMessageArrays(payload) {
  if (!payload || typeof payload !== 'object') return [];

  const down =
    payload?.downlink_body?.pull_singe_chain_downlink_body ||
    payload?.data?.pull_singe_chain_downlink_body ||
    null;

  const candidates = [
    down?.messages,
    down?.message_list,
    down?.msg_list,
    down?.messageList,
    payload?.downlink_body?.messages,
    payload?.downlink_body?.message_list,
    payload?.data?.message_list,
    payload?.data?.messages,
    payload?.data?.msg_list,
    payload?.data?.messageList,
    payload?.message_list,
    payload?.messages,
    payload?.msg_list,
    payload?.data
  ];

  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c;
  }

  // 兜底：深度搜索像消息的数组
  const found = flattenDeepArrays(payload);
  if (found.length) {
    return found.sort((a, b) => b.length - a.length)[0];
  }
  return [];
}

function parseDoubaoHistoryPayload(payload) {
  if (!payload) return [];

  const status = payload.status_code ?? payload.code;
  const raw = collectMessageArrays(payload);

  // 即使业务码非 0，只要有消息数组也尽量解析（避免空结果误判）
  if (status != null && status !== 0 && !raw.length) return [];

  const messages = [];
  let skippedNoRole = 0;
  let skippedNoContent = 0;

  for (const msg of raw) {
    if (!msg || typeof msg !== 'object') continue;
    const role = normalizeDoubaoRole(msg);
    if (!role) {
      skippedNoRole += 1;
      continue;
    }

    const content =
      extractDoubaoText(msg.content_blocks_v2) ||
      extractDoubaoText(msg.content_blocks) ||
      extractDoubaoText(msg.content) ||
      extractDoubaoText(msg.display_content) ||
      extractDoubaoText(msg.text) ||
      extractDoubaoText(msg.brief) ||
      extractDoubaoText(msg.content_block) ||
      extractDoubaoText(msg.content_obj);

    if (!content) {
      skippedNoContent += 1;
      continue;
    }

    const cleaned =
      typeof sanitizeAssistantContentForSave === 'function' && role === 'assistant'
        ? sanitizeAssistantContentForSave(content)
        : typeof stripCssLeakText === 'function' && role === 'assistant'
          ? stripCssLeakText(content)
          : content;
    if (!cleaned) {
      skippedNoContent += 1;
      continue;
    }

    messages.push({
      role,
      content: cleaned,
      timestamp: msg.create_time || msg.created_at || msg.update_time || null,
      id: msg.message_id || msg.id || msg.local_message_id || null,
      index: msg.index_in_conv ?? msg.index ?? null
    });
  }

  const userCount = messages.filter((m) => m.role === 'user').length;
  const asstCount = messages.filter((m) => m.role === 'assistant').length;
  if (raw.length && (skippedNoContent || skippedNoRole || !userCount)) {
    console.warn('[ACM Doubao] 解析统计', {
      status,
      raw: raw.length,
      user: userCount,
      assistant: asstCount,
      skippedNoRole,
      skippedNoContent,
      sample: raw.slice(0, 3).map((m) => ({
        user_type: m?.user_type,
        content_type: m?.content_type,
        keys: m && Object.keys(m).slice(0, 16),
        hasBlocksV2: Array.isArray(m?.content_blocks_v2),
        blocksV2Preview: Array.isArray(m?.content_blocks_v2)
          ? JSON.stringify(m.content_blocks_v2?.[0]).slice(0, 120)
          : null,
        contentType: typeof m?.content,
        contentPreview: String(m?.content || m?.brief || '').slice(0, 80)
      }))
    });
  }

  if (!messages.length && raw.length) {
    console.warn('[ACM Doubao] 有原始消息但解析为空', {
      status,
      raw: raw.length,
      skippedNoRole,
      skippedNoContent
    });
  }

  messages.sort((a, b) => {
    const ia = Number(a.index);
    const ib = Number(b.index);
    if (!Number.isNaN(ia) && !Number.isNaN(ib) && ia !== ib) return ia - ib;
    const ta = Number(a.timestamp) || 0;
    const tb = Number(b.timestamp) || 0;
    if (ta && tb && ta !== tb) return ta - tb;
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });

  const seen = new Set();
  const out = [];
  for (const m of messages) {
    const key = `${m.role}::${String(m.content).replace(/\s+/g, ' ').trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ role: m.role, content: m.content, timestamp: m.timestamp });
  }
  return out;
}

function rememberDoubaoPayload(conversationId, payload, url) {
  const entry = { payload, url: url || '', ts: Date.now() };
  __acmDoubaoCache.latest = entry;
  if (conversationId) {
    __acmDoubaoCache.byId.set(String(conversationId), entry);
  }
}

function getCachedDoubaoPayload(conversationId) {
  if (conversationId && __acmDoubaoCache.byId.has(String(conversationId))) {
    return __acmDoubaoCache.byId.get(String(conversationId));
  }
  // 最近一条且未超时（10 分钟）
  if (__acmDoubaoCache.latest && Date.now() - __acmDoubaoCache.latest.ts < 10 * 60 * 1000) {
    return __acmDoubaoCache.latest;
  }
  return null;
}

async function postDoubaoJson(path, body) {
  const params = buildDoubaoCommonParams();
  const url = `https://www.doubao.com${path}?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json; encoding=utf-8',
        'agw-js-conv': 'str, str',
        Referer: location.href
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`豆包接口返回非 JSON (HTTP ${res.status})`);
    }
    if (!res.ok) {
      throw new Error(`豆包接口 HTTP ${res.status}: ${json?.msg || json?.status_desc || text.slice(0, 120)}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function buildPullChainBody(conversationId, overrides = {}) {
  const body = {
    conversation_id: String(conversationId),
    anchor_index: overrides.anchor_index ?? 0,
    conversation_type: DOUBAO_CONV_TYPE.ONE_TO_BOT_CHAT,
    direction: overrides.direction ?? DOUBAO_DIR.FROM_LATEST,
    limit: overrides.limit ?? 100,
    ext: overrides.ext || {},
    evaluate_ab_params: '',
    evaluate_common_params: ''
  };
  const filter = {};
  if (Array.isArray(overrides.index_list) && overrides.index_list.length) {
    filter.index_list = overrides.index_list;
  }
  if (overrides.bot_id) filter.bot_id = overrides.bot_id;
  if (Object.keys(filter).length) body.filter = filter;
  return body;
}

function buildImEnvelope(uplinkBody) {
  return {
    cmd: 3100, // PULL_SINGLE_CHAIN
    sequence_id: String(Date.now()),
    channel: 2,
    version: '1',
    uplink_body: {
      pull_singe_chain_uplink_body: uplinkBody
    }
  };
}

async function fetchViaImChain(conversationId) {
  const attempts = [
    buildPullChainBody(conversationId, { direction: DOUBAO_DIR.FROM_LATEST, anchor_index: 0 }),
    buildPullChainBody(conversationId, { direction: DOUBAO_DIR.OLDER, anchor_index: 999999 }),
    buildPullChainBody(conversationId, { direction: DOUBAO_DIR.OLDER, anchor_index: 1000000 }),
    buildPullChainBody(conversationId, {
      direction: DOUBAO_DIR.NEWER,
      anchor_index: 0
    })
  ];

  let lastErr = null;
  for (const uplink of attempts) {
    try {
      const payload = await postDoubaoJson('/im/chain/single', buildImEnvelope(uplink));
      const status = payload?.status_code ?? payload?.code;
      const messages = parseDoubaoHistoryPayload(payload);
      if (messages.length) {
        rememberDoubaoPayload(conversationId, payload, '/im/chain/single');
        return { messages, path: '/im/chain/single', payload };
      }
      console.warn('[ACM Doubao] IM 响应未解析出消息', {
        status,
        status_desc: payload?.status_desc || payload?.msg,
        downKeys: Object.keys(payload?.downlink_body || {}),
        dataKeys: Object.keys(payload?.data || {})
      });
      if (status != null && status !== 0) {
        lastErr = new Error(
          `IM ${status}: ${payload?.status_desc || payload?.msg || '系统错误'}`
        );
        continue;
      }
      lastErr = new Error('IM 拉链未返回消息');
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('IM 拉链失败');
}

async function fetchViaAliceList(conversationId) {
  const attempts = [
    {
      path: '/alice/message/list/v2',
      body: {
        conversation_id: String(conversationId),
        start_index: 0,
        batch_size: 100,
        is_reverse: true
      }
    },
    {
      path: '/alice/message/list',
      body: {
        conversation_id: String(conversationId),
        cursor: '0',
        batch_size: 100
      }
    }
  ];

  let lastErr = null;
  for (const item of attempts) {
    try {
      const payload = await postDoubaoJson(item.path, item.body);
      const messages = parseDoubaoHistoryPayload(payload);
      if (messages.length) {
        rememberDoubaoPayload(conversationId, payload, item.path);
        return { messages, path: item.path, payload };
      }
      if (payload?.code != null && payload.code !== 0) {
        lastErr = new Error(`alice ${payload.code}: ${payload.msg || ''}`);
        continue;
      }
      lastErr = new Error('alice 列表为空');
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('alice 列表失败');
}

async function requestDoubaoPageFetch(conversationId, uplink, timeoutMs = 15000) {
  // A) 优先：background 在 MAIN 世界直接执行（绕过 CSP / isolated cookie 差异）
  try {
    const viaSw = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          {
            type: 'DOUBAO_MAIN_WORLD_FETCH',
            conversationId: String(conversationId),
            uplink
          },
          (res) => {
            if (chrome.runtime.lastError) {
              console.warn('[ACM Doubao] MAIN SW 消息失败:', chrome.runtime.lastError.message);
              resolve(null);
              return;
            }
            if (!res?.ok) {
              console.warn('[ACM Doubao] MAIN SW fetch 失败:', res?.error || 'unknown');
              resolve(null);
              return;
            }
            resolve(res.payload || null);
          }
        );
      } catch (err) {
        console.warn('[ACM Doubao] MAIN SW 调用异常:', err);
        resolve(null);
      }
    });
    if (viaSw) return viaSw;
  } catch {
    // continue
  }

  // B) postMessage 桥（manifest MAIN hook / 内联 hook 已注入时）
  return new Promise((resolve) => {
    const requestId = `db_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMsg);
      resolve(null);
    }, timeoutMs);

    function onMsg(event) {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== 'acm-doubao' || data.type !== 'fetch-response') return;
      if (data.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      resolve(data.ok ? data.payload : null);
    }

    window.addEventListener('message', onMsg);
    window.postMessage(
      {
        source: 'acm-doubao',
        type: 'fetch-request',
        requestId,
        conversationId: String(conversationId),
        uplink
      },
      '*'
    );
  });
}

async function fetchViaPageImChain(conversationId) {
  const attempts = [
    buildPullChainBody(conversationId, { direction: DOUBAO_DIR.FROM_LATEST, anchor_index: 0 }),
    buildPullChainBody(conversationId, { direction: DOUBAO_DIR.OLDER, anchor_index: 999999 }),
    buildPullChainBody(conversationId, { direction: DOUBAO_DIR.OLDER, anchor_index: 1000000 })
  ];

  let lastErr = null;
  for (const uplink of attempts) {
    try {
      const payload = await requestDoubaoPageFetch(conversationId, uplink);
      if (!payload) {
        lastErr = new Error('页面主环境无响应');
        continue;
      }
      const status = payload?.status_code ?? payload?.code;
      const messages = parseDoubaoHistoryPayload(payload);
      if (messages.length) {
        rememberDoubaoPayload(conversationId, payload, 'page:/im/chain/single');
        return { messages, path: 'page:/im/chain/single', payload };
      }
      if (status != null && status !== 0) {
        lastErr = new Error(`page IM ${status}: ${payload?.status_desc || payload?.msg || ''}`);
        continue;
      }
      lastErr = new Error('页面 IM 未返回消息');
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('页面主环境 IM 失败');
}

async function fetchDoubaoMessageList(conversationId) {
  injectDoubaoHook();

  // 1) Hook 缓存
  const cached = getCachedDoubaoPayload(conversationId);
  if (cached?.payload) {
    const messages = parseDoubaoHistoryPayload(cached.payload);
    if (messages.length) {
      return { messages, path: `hook-cache:${cached.url || 'history'}`, payload: cached.payload };
    }
  }

  // 2) 页面 MAIN 世界 fetch（scripting，最稳；优先于 CS isolated fetch）
  try {
    console.warn('[ACM Doubao] 尝试页面主环境 fetch');
    return await fetchViaPageImChain(conversationId);
  } catch (pageErr) {
    console.warn('[ACM Doubao] 页面 fetch 失败:', pageErr);
  }

  // 3) Content Script 主动拉 IM / alice（兜底）
  try {
    return await fetchViaImChain(conversationId);
  } catch (imErr) {
    console.warn('[ACM Doubao] CS IM 失败:', imErr);
    try {
      return await fetchViaAliceList(conversationId);
    } catch (aliceErr) {
      console.warn('[ACM Doubao] CS alice 失败:', aliceErr);
    }
  }

  // 再等一小会儿 Hook 缓存（页面可能刚加载完）
  const start = Date.now();
  while (Date.now() - start < 2500) {
    await new Promise((r) => setTimeout(r, 250));
    const again = getCachedDoubaoPayload(conversationId);
    if (again?.payload) {
      const messages = parseDoubaoHistoryPayload(again.payload);
      if (messages.length) {
        return { messages, path: 'hook-cache-wait', payload: again.payload };
      }
    }
  }

  throw new Error('豆包 API 三级兜底均失败，请确认已登录并刷新对话页');
}

async function fetchDoubaoConversation(conversationId) {
  if (!conversationId) return null;
  const { messages, path } = await fetchDoubaoMessageList(conversationId);
  console.log('[ACM Doubao] API 解析', messages.length, '条 via', path);
  return { messages, source: 'api', sessionId: conversationId, fetchSource: path };
}

function injectDoubaoHook() {
  const HOOK_VER = '4';
  if (document.documentElement?.getAttribute('data-acm-doubao-hook') === HOOK_VER) return;
  try {
    document.documentElement?.setAttribute('data-acm-doubao-hook', HOOK_VER);
  } catch {
    // ignore
  }

  const source = `
(function(){
  if (window.__acmDoubaoHookVer === '4') return;
  window.__acmDoubaoHookVer = '4';
  window.__acmDoubaoHooked = true;
  var origFetch = window.fetch;

  function isChatStreamUrl(url){
    if (typeof url !== 'string') return false;
    return /\\/chat\\/completion/i.test(url) || /\\/completion/i.test(url) || /stream_call/i.test(url) || /\\/async\\/stream/i.test(url) || /\\/sse/i.test(url);
  }
  function isHistoryUrl(url){
    if (typeof url !== 'string' || isChatStreamUrl(url)) return false;
    return /\\/im\\/chain\\//i.test(url) || /\\/alice\\/message\\/list/i.test(url);
  }
  function extractConversationId(url, bodyText){
    try{
      if (bodyText){
        var parsed = typeof bodyText === 'string' ? JSON.parse(bodyText) : bodyText;
        var uplink = (parsed && parsed.uplink_body && parsed.uplink_body.pull_singe_chain_uplink_body) || parsed;
        var id = uplink && (uplink.conversation_id || parsed.conversation_id);
        if (id && id !== '0') return String(id);
      }
    }catch(e){}
    try{
      return new URL(url, location.origin).searchParams.get('conversation_id');
    }catch(e){ return null; }
  }
  function publish(conversationId, payload, url){
    document.dispatchEvent(new CustomEvent('acm-doubao-history',{
      detail:{conversationId:conversationId,payload:payload,url:url,ts:Date.now()},
      bubbles:true
    }));
    try {
      window.postMessage({
        source:'acm-doubao', type:'history',
        conversationId: conversationId || null,
        url: url || '', ts: Date.now()
      }, '*');
    } catch (e) {}
  }
  function buildCommonParams(){
    try{
      var live = performance.getEntriesByType('resource').map(function(e){return e.name;}).reverse()
        .find(function(u){ return (u.indexOf('/im/')!==-1 || u.indexOf('/alice/')!==-1) && u.indexOf('?')!==-1; });
      if (live) {
        var p = new URL(live).searchParams;
        p.delete('a_bogus'); p.delete('msToken');
        if (p.get('aid') || p.get('version_code')) return p;
      }
    }catch(e){}
    var params = new URLSearchParams({
      version_code:'20800', language:'zh', device_platform:'web', doubao_device_platform:'web',
      aid:'497858', real_aid:'497858', pkg_type:'release_version', region:'CN', sys_region:'CN',
      samantha_web:'1', web_platform:'browser', 'use-olympus-account':'1'
    });
    params.set('web_tab_id', String(Date.now()));
    return params;
  }
  function buildImEnvelope(uplinkBody){
    return {
      cmd: 3100,
      sequence_id: String(Date.now()),
      channel: 2,
      version: '1',
      uplink_body: { pull_singe_chain_uplink_body: uplinkBody }
    };
  }
  async function fetchImInPage(uplink){
    var params = buildCommonParams();
    var url = location.origin + '/im/chain/single?' + params.toString();
    var res = await origFetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json; encoding=utf-8',
        'agw-js-conv': 'str, str',
        'Referer': location.href
      },
      body: JSON.stringify(buildImEnvelope(uplink))
    });
    var payload = await res.json();
    publish(uplink && uplink.conversation_id, payload, url);
    return payload;
  }

  window.addEventListener('message', async function(event){
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.source !== 'acm-doubao' || data.type !== 'fetch-request') return;
    try {
      var payload = await fetchImInPage(data.uplink);
      window.postMessage({
        source: 'acm-doubao', type: 'fetch-response', requestId: data.requestId,
        payload: payload, ok: !!payload
      }, '*');
    } catch (err) {
      window.postMessage({
        source: 'acm-doubao', type: 'fetch-response', requestId: data.requestId,
        payload: null, ok: false, error: String(err && err.message || err)
      }, '*');
    }
  });

  window.fetch = async function(){
    var args = arguments;
    var input = args[0];
    var init = args[1] || {};
    var url = typeof input === 'string' ? input : (input && input.url);
    var reqBody = init.body;
    var res = await origFetch.apply(this, args);
    try{
      if (isHistoryUrl(url)){
        res.clone().json().then(function(data){
          publish(extractConversationId(url, typeof reqBody === 'string' ? reqBody : null), data, url);
        }).catch(function(){});
      }
    }catch(e){}
    return res;
  };
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url){
    this.__acmUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body){
    this.__acmBody = body;
    if (isHistoryUrl(this.__acmUrl)){
      this.addEventListener('load', function(){
        try{
          if (this.status >= 200 && this.status < 300){
            publish(extractConversationId(this.__acmUrl, typeof this.__acmBody === 'string' ? this.__acmBody : null), JSON.parse(this.responseText), this.__acmUrl);
          }
        }catch(e){}
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
    console.warn('[ACM Doubao] hook 注入失败', err);
  }
}

function setupDoubaoCacheListener() {
  if (window.__acmDoubaoCacheListening) return;
  window.__acmDoubaoCacheListening = true;
  document.addEventListener('acm-doubao-history', (event) => {
    const detail = event?.detail;
    if (!detail?.payload) return;
    rememberDoubaoPayload(detail.conversationId, detail.payload, detail.url);
  });
}

setupDoubaoCacheListener();
injectDoubaoHook();

if (typeof globalThis !== 'undefined') {
  globalThis.injectDoubaoHook = injectDoubaoHook;
  globalThis.getDoubaoConversationId = getDoubaoConversationId;
  globalThis.fetchDoubaoConversation = fetchDoubaoConversation;
  globalThis.parseDoubaoHistoryPayload = parseDoubaoHistoryPayload;
}
