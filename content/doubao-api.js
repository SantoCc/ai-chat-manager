/**
 * 豆包官方接口读取对话原文
 * 三级兜底：MAIN 世界 fetch → CS IM/alice → Hook 缓存（缓存仅作失败兜底，避免末轮延迟）
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

/** 结构化程度：优先选带换行 / Markdown / HTML 的候选，避免扁平 text_block 抢先 */
function scoreDoubaoTextRichness(text) {
  const t = String(text || '');
  if (!t.trim()) return -1;
  let score = Math.min(t.length, 8000);
  score += (t.match(/\n/g) || []).length * 28;
  score += (t.match(/\*\*[^*\n]+\*\*|__[^_\n]+__/g) || []).length * 45;
  score += (t.match(/^#{1,6}\s/gm) || []).length * 55;
  score += (t.match(/^(\d+\.|[-*+])\s/gm) || []).length * 32;
  score += (t.match(/<\/?(h[1-6]|p|li|ul|ol|strong|em|pre|code|blockquote|br)\b/gi) || [])
    .length * 40;
  // 超长单行墙文降权（常见于丢格式后的 brief / plain）
  if (!/\n/.test(t) && t.length > 180) score -= 120;
  return score;
}

function pickRichestDoubaoText(candidates, depth = 0) {
  let best = '';
  let bestScore = -1;
  for (const raw of candidates) {
    if (raw == null || raw === '') continue;
    const t = extractDoubaoText(raw, depth + 1);
    if (!t) continue;
    const score = scoreDoubaoTextRichness(t);
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return best;
}

function extractDoubaoText(content, depth = 0) {
  if (content == null || depth > 10) return '';

  // content_blocks / content_blocks_v2 直接是数组
  if (Array.isArray(content)) {
    return content
      .map((b) => extractDoubaoBlock(b, depth + 1))
      .filter(Boolean)
      .join('\n\n')
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
        return extractDoubaoText(JSON.parse(trimmed), depth + 1);
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  if (typeof content !== 'object') return String(content).trim();

  // 同层多字段：取结构最丰富的一份（勿被扁平 text 抢先）
  const layered = pickRichestDoubaoText(
    [
      content.markdown,
      content.md,
      content.html,
      content.rich_text,
      content.richText,
      content.display_html,
      content.formatted_text,
      content.text_block?.markdown,
      content.text_block?.html,
      content.text_block?.rich_text,
      content.text_block?.text,
      typeof content.text === 'string' ? content.text : null,
      typeof content.content === 'string' ? content.content : null,
      content.content && typeof content.content === 'object' ? content.content : null,
      content.delta?.text,
      Array.isArray(content.parts) ? content.parts : null,
      content.content_blocks_v2,
      content.content_blocks,
      content.blocks,
      content.block_list
    ],
    depth
  );
  if (layered) return layered;

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
  /^(image|img|video|audio|file|attachment|card|widget|document|doc|ppt|pdf|artifact|canvas|code_file|spreadsheet|excel|zip|sheet|bitable|lark|feishu)$/i;
/** 豆包数字 block_type：附件 / 生成文档 / 图片视频 */
const DOUBAO_FILE_BLOCK_TYPE_IDS = new Set([
  '10052', // attachment_block
  '10054',
  '10055',
  '10056',
  '10100',
  '10110',
  '2009', // SamanthaImageInput
  '2010', // SamanthaImageOutput
  '2020', // video in
  '2021' // video out
]);

function resolveDoubaoMediaUrl(node) {
  if (!node || typeof node !== 'object') {
    if (typeof node === 'string' && /^(https?:|data:image\/)/i.test(node)) return node;
    return '';
  }
  const nested =
    typeof node.image_url === 'object' && node.image_url
      ? node.image_url.url || node.image_url.src || ''
      : typeof node.image_url === 'string'
        ? node.image_url
        : '';
  const candidates = [
    node.url,
    nested,
    node.src,
    node.preview_url,
    node.download_url,
    node.file_url,
    node.origin_url,
    node.ori_url,
    node.thumbnail_url,
    node.thumb_url,
    node.link,
    typeof node.image === 'string' ? node.image : null,
    typeof node.image === 'object' ? resolveDoubaoMediaUrl(node.image) : null
  ];
  for (const u of candidates) {
    if (typeof u === 'string' && /^(https?:|data:image\/)/i.test(u.trim())) return u.trim();
  }
  return '';
}

function getDoubaoBlockTypeId(block) {
  if (!block || typeof block !== 'object') return '';
  const raw =
    block.block_type ??
    block.type ??
    block.content_type ??
    block.content?.block_type ??
    block.content?.type;
  if (raw == null || raw === '') return '';
  return String(raw);
}

function looksLikeDoubaoFileBlock(block) {
  if (!block || typeof block !== 'object') return false;
  const kind = getDoubaoBlockKind(block);
  if (DOUBAO_FILE_BLOCK_KINDS.test(kind)) return true;
  if (DOUBAO_FILE_BLOCK_TYPE_IDS.has(getDoubaoBlockTypeId(block))) return true;

  const hasVal = (v) => {
    if (v == null || v === '') return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return true;
  };

  if (
    hasVal(block.file_info) ||
    hasVal(block.file) ||
    hasVal(block.attachment) ||
    block.image_url ||
    block.video_url ||
    hasVal(block.image_block) ||
    hasVal(block.image) ||
    hasVal(block.images)
  ) {
    return true;
  }
  if (
    hasVal(block.attachment_block) ||
    hasVal(block.attachments) ||
    hasVal(block.file_card) ||
    hasVal(block.artifact_block)
  ) {
    return true;
  }

  const c = block.content;
  if (c && typeof c === 'object' && !Array.isArray(c)) {
    if (
      hasVal(c.file_info) ||
      hasVal(c.file) ||
      hasVal(c.image) ||
      hasVal(c.images) ||
      hasVal(c.image_block) ||
      hasVal(c.image_url) ||
      hasVal(c.video) ||
      hasVal(c.video_block) ||
      hasVal(c.attachment_block) ||
      hasVal(c.attachments) ||
      hasVal(c.file_card) ||
      hasVal(c.artifact_block) ||
      hasVal(c.sheet_block) ||
      hasVal(c.spreadsheet) ||
      hasVal(c.bitable) ||
      hasVal(c.lark_file) ||
      hasVal(c.feishu_file) ||
      hasVal(c.doc_block) ||
      hasVal(c.document_block)
    ) {
      return true;
    }
  }

  // 启发式：块 JSON 像附件/飞书表/图片，且不是纯文本块
  try {
    const blob = JSON.stringify(block).slice(0, 2500);
    if (
      /attachment_block|"attachments"\s*:|image_block|"image_url"|tos-cn-i-|spreadsheet|bitable|feishu\.cn|larksuite\.com|file_url|download_url|byteimg\.com|imagex/i.test(
        blob
      ) &&
      /"name"|"title"|"file_name"|"filename"|"display_name"|"url"|"src"/i.test(blob)
    ) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function digDoubaoFileMeta(node, depth = 0, out = []) {
  if (!node || depth > 6) return out;
  if (Array.isArray(node)) {
    for (const item of node) digDoubaoFileMeta(item, depth + 1, out);
    return out;
  }
  if (typeof node !== 'object') return out;

  const title =
    node.title ||
    node.name ||
    node.file_name ||
    node.filename ||
    node.display_name ||
    node.doc_name ||
    node.sheet_name ||
    node.alt ||
    '';
  const generatedAt =
    node.created_at ||
    node.create_time ||
    node.generated_at ||
    node.generate_time ||
    node.update_time ||
    '';
  const url = resolveDoubaoMediaUrl(node);

  const typeHint = String(
    node.type ?? node.file_type ?? node.content_type ?? node.mime_type ?? ''
  ).toLowerCase();
  // attachment type: 1=image, 3=file（豆包约定）
  const isImageAtt = typeHint === '1' || typeHint === 'image' || typeHint === 'img';

  if (title || url || isImageAtt) {
    let type = 'generated_file';
    const hint = `${title} ${typeHint} ${url}`.toLowerCase();
    if (isImageAtt || /image|img|png|jpe?g|gif|webp|bmp|svg/.test(hint)) type = 'image';
    else if (/sheet|excel|xls|csv|表格|spreadsheet|bitable/.test(hint)) type = 'spreadsheet';
    else if (/ppt|幻灯|演示/.test(hint)) type = 'presentation';
    else if (/pdf|doc|docx|文档/.test(hint)) type = 'document';
    else if (/video|mp4|webm/.test(hint)) type = 'video';
    else if (/attachment|file/.test(hint)) type = 'file';

    let timeStr = '';
    if (generatedAt != null && generatedAt !== '') {
      const n = Number(generatedAt);
      if (!Number.isNaN(n) && n > 1e11) {
        const d = new Date(n);
        timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      } else if (!Number.isNaN(n) && n > 1e9) {
        const d = new Date(n * 1000);
        timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      } else {
        timeStr = String(generatedAt).slice(0, 32);
      }
    }

    out.push({
      kind: 'file',
      type,
      title: String(title || (type === 'image' ? '图片' : '生成文件')).slice(0, 80),
      generatedAt: timeStr,
      url: url || ''
    });
  }

  for (const key of [
    'attachment_block',
    'attachments',
    'file',
    'file_info',
    'files',
    'artifact_block',
    'file_card',
    'sheet_block',
    'spreadsheet',
    'bitable',
    'doc_block',
    'document_block',
    'image_block',
    'image',
    'images',
    'image_list',
    'image_url',
    'video_block',
    'video',
    'content',
    'payload',
    'data'
  ]) {
    if (node[key] != null) digDoubaoFileMeta(node[key], depth + 1, out);
  }
  return out;
}

function formatDoubaoFileBlock(block) {
  const metas = digDoubaoFileMeta(block);
  const seen = new Set();
  const cards = [];
  for (const m of metas) {
    const key = `${m.title}::${m.type}::${m.url || m.generatedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push(m);
  }

  if (!cards.length) {
    if (!looksLikeDoubaoFileBlock(block)) return '';
    const kind = getDoubaoBlockKind(block) || getDoubaoBlockTypeId(block) || 'generated_file';
    let title = '生成文件';
    let type = kind || 'generated_file';
    if (/^(2009|2010)$/.test(String(kind)) || /image|img/.test(String(kind))) {
      title = '图片';
      type = 'image';
    } else if (/video/.test(String(kind)) || /^(2020|2021)$/.test(String(kind))) {
      title = '视频';
      type = 'video';
    } else if (/ppt|演示/.test(String(kind))) title = '演示文稿';
    else if (/sheet|excel|spreadsheet|表格/.test(String(kind))) {
      title = '表格';
      type = 'spreadsheet';
    } else if (/pdf|doc/.test(String(kind))) title = '文档';
    cards.push({ kind: 'file', type, title, generatedAt: '', url: '' });
  }

  if (typeof formatGeneratedFileCardsMarkdown === 'function') {
    return formatGeneratedFileCardsMarkdown(cards);
  }
  return cards.map((c) => `📎 **${c.title}**`).join('\n\n');
}

function extractDoubaoBlock(block, depth = 0) {
  if (block == null || depth > 10) return '';
  if (typeof block === 'string') return extractDoubaoText(block, depth + 1);
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

  // 块内多字段择优（含 markdown/html），避免只取扁平 text
  return pickRichestDoubaoText(
    [
      block.content?.text_block,
      block.text_block,
      block.content_obj?.text_block,
      block.markdown,
      block.html,
      block.rich_text,
      block.text,
      block.content,
      block.content_obj,
      block.content_block,
      block.payload,
      block.data
    ],
    depth
  );
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

    // 多字段择优：content_blocks 的 plain text 常丢标题/加粗，HTML/markdown 更完整
    let content = pickRichestDoubaoText([
      msg.content_blocks_v2,
      msg.content_blocks,
      msg.content,
      msg.display_content,
      msg.display_html,
      msg.markdown,
      msg.html,
      msg.rich_text,
      msg.text,
      msg.brief,
      msg.content_block,
      msg.content_obj
    ]);

    // 消息级附件 / 生成文件（可能不在 content_blocks 文本里）
    const fileBits = [];
    for (const node of [
      msg.attachments,
      msg.files,
      msg.file_list,
      msg.artifacts,
      msg.cards,
      msg.attachment_block,
      msg.file_card
    ]) {
      if (node == null || (Array.isArray(node) && !node.length)) continue;
      const wrap = { content: node, attachment_block: node };
      if (!looksLikeDoubaoFileBlock(wrap) && !looksLikeDoubaoFileBlock(node)) continue;
      const bit = formatDoubaoFileBlock(wrap);
      if (bit && !fileBits.includes(bit)) fileBits.push(bit);
    }
    // 块数组里再扫一遍附件块（防止被 skip / 扁平文本路径丢掉）
    const blockArrays = [msg.content_blocks_v2, msg.content_blocks, msg.blocks].filter(Array.isArray);
    for (const arr of blockArrays) {
      for (const b of arr) {
        if (!looksLikeDoubaoFileBlock(b)) continue;
        const bit = formatDoubaoFileBlock(b);
        if (bit && !fileBits.includes(bit)) fileBits.push(bit);
      }
    }
    if (fileBits.length) {
      const joined = fileBits.join('\n\n');
      if (!content) content = joined;
      else if (!/@@ACM_FILE:/.test(content)) content = `${content}\n\n${joined}`;
    }

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

function invalidateDoubaoCache(conversationId) {
  if (conversationId) {
    __acmDoubaoCache.byId.delete(String(conversationId));
  }
  __acmDoubaoCache.latest = null;
}

function getCachedDoubaoPayload(conversationId, maxAgeMs = 10 * 60 * 1000) {
  const pick = (entry) => {
    if (!entry?.payload) return null;
    if (Date.now() - (entry.ts || 0) > maxAgeMs) return null;
    return entry;
  };
  if (conversationId && __acmDoubaoCache.byId.has(String(conversationId))) {
    const hit = pick(__acmDoubaoCache.byId.get(String(conversationId)));
    if (hit) return hit;
  }
  return pick(__acmDoubaoCache.latest);
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

async function fetchDoubaoMessageList(conversationId, options = {}) {
  injectDoubaoHook();
  const forceRefresh = !!options.forceRefresh;

  // 1) 页面 MAIN 世界 fetch（始终优先拉新；避免 Hook 旧缓存卡住末轮）
  try {
    console.warn('[ACM Doubao] 尝试页面主环境 fetch', forceRefresh ? '(force)' : '');
    return await fetchViaPageImChain(conversationId);
  } catch (pageErr) {
    console.warn('[ACM Doubao] 页面 fetch 失败:', pageErr);
  }

  // 2) Content Script 主动拉 IM / alice
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

  // 3) Hook 缓存兜底（force 时仅接受极短窗口内的新鲜缓存）
  const cacheMaxAge = forceRefresh ? 8000 : 10 * 60 * 1000;
  const cached = getCachedDoubaoPayload(conversationId, cacheMaxAge);
  if (cached?.payload) {
    const messages = parseDoubaoHistoryPayload(cached.payload);
    if (messages.length) {
      return { messages, path: `hook-cache:${cached.url || 'history'}`, payload: cached.payload };
    }
  }

  // 再等一小会儿 Hook 缓存（页面可能刚加载完）
  const start = Date.now();
  while (Date.now() - start < 2500) {
    await new Promise((r) => setTimeout(r, 250));
    const again = getCachedDoubaoPayload(conversationId, cacheMaxAge);
    if (again?.payload) {
      const messages = parseDoubaoHistoryPayload(again.payload);
      if (messages.length) {
        return { messages, path: 'hook-cache-wait', payload: again.payload };
      }
    }
  }

  throw new Error('豆包 API 三级兜底均失败，请确认已登录并刷新对话页');
}

async function fetchDoubaoConversation(conversationId, options = {}) {
  if (!conversationId) return null;
  if (options.forceRefresh && typeof invalidateDoubaoCache === 'function') {
    invalidateDoubaoCache(conversationId);
  }
  const { messages, path } = await fetchDoubaoMessageList(conversationId, options);
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

  // 禁止内联 script（会触发站点 CSP 红字）。页面 hook 仅由 manifest world:MAIN 注入。
  void source;
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
  globalThis.invalidateDoubaoCache = invalidateDoubaoCache;
  globalThis.scoreDoubaoTextRichness = scoreDoubaoTextRichness;
}
