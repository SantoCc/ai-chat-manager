/**
 * 侧边栏主逻辑
 */
import { renderMarkdown, highlightSearchText, getSearchSnippet } from '../lib/markdown.js';
import { formatDate, getPlatformLabel, getUserMessages, copyText, truncateFolderName, repairMessageRoles, dedupeMessages } from '../utils/helpers-export.js';
import { conversationToMarkdown } from '../lib/export.js';
import { showConfirm, showPrompt } from './dialog.js';

const state = {
  conversations: [],
  folders: [],
  settings: {},
  currentPlatform: '',
  currentFolderId: '',
  searchQuery: '',
  currentConversation: null,
  selectedIds: new Set()
};

// DOM refs
const $ = (sel) => document.querySelector(sel);
const listView = $('#list-view');
const detailView = $('#detail-view');
const settingsView = $('#settings-view');
const conversationList = $('#conversation-list');
const emptyState = $('#empty-state');
const searchInput = $('#search-input');

async function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function showToast(text, duration) {
  const toast = $('#toast');
  toast.textContent = text;
  toast.classList.remove('hidden');
  const ms = duration ?? Math.min(8000, Math.max(2500, String(text || '').length * 60));
  setTimeout(() => toast.classList.add('hidden'), ms);
}

/** 详情页展示时剥离思考过程外壳与卡片 JSON（不改存储；完整正文需重新保存） */
function stripThinkingForDisplay(text) {
  let s = String(text || '').trim();
  if (!s) return '';

  // 平衡括号剔除 JSON 卡片（比按空行切更稳）
  s = stripJsonCardsForDisplay(s);
  if (!s) return '';

  s = s.replace(/^(?:已完成思考|Finished thinking)[^\n]*\n+/i, '');
  s = s.replace(/^参考了\s*\d+\s*篇材料[^\n]*\n+/i, '');
  const start = s.slice(0, 120);
  if (
    /^(已完成思考|Finished thinking|明确选择问题|搜索\s*\d+\s*个关键词|用户想知道|用户想|Thinking)/i.test(
      start
    )
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
  return s.trim();
}

function stripJsonCardsForDisplay(text) {
  let s = String(text || '');
  if (!s || !/[\{\[]/.test(s)) return s;
  const junkRe =
    /"gaokao_choice_report"|gaokao_choice_report|"zhiyuan_table"|"zhiyuan_list"|"initialData"|"school_prob"|"reqId"/;
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
          if (!(junkRe.test(chunk) && chunk.length > 80)) out += chunk;
          i = j + 1;
          break;
        }
      }
    }
    if (j >= s.length) {
      const tail = s.slice(i);
      if (!(junkRe.test(tail) && tail.length > 80)) out += tail;
      break;
    }
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** 详情展示：把挤成一行的标题/条目拆开，便于阅读（不改存储） */
function normalizeAssistantDisplayText(text) {
  let s = String(text || '');
  if (!s) return '';
  // 「稳妥档...) - 学校」或「...)·学校」拆成换行列表
  s = s.replace(/([）\)])\s*[-–—·•]\s+/g, '$1\n- ');
  s = s.replace(/([：:】])\s*[-–—·•]\s+/g, '$1\n- ');
  // 连续「· 学校名」条目
  s = s.replace(/([^\n])\s+[·•]\s+(?=[^\s·•]{2,40}[：:])/g, '$1\n- ');
  // 档位标题后若直接跟条目，尽量断开
  s = s.replace(
    /(冲刺档|稳妥档|保底档|冲档|稳档|保档)([^\n]{0,40}[）\)])\s*(?=[^\n])/g,
    '$1$2\n'
  );
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function showView(view) {
  [listView, detailView, settingsView].forEach((v) => v.classList.remove('active'));
  view.classList.add('active');
}

async function init() {
  await loadSettings();
  applyTheme();
  await loadFolders();
  await loadConversations();
  bindEvents();
  listenForUpdates();
  updateStorageUsage();
}

async function loadSettings() {
  const res = await sendMessage({ type: 'GET_SETTINGS' });
  state.settings = res.data || {};
  $('#auto-save-toggle').checked = !!state.settings.autoSave;
  $('#auto-classify-toggle').checked = !!state.settings.autoClassify;
  $('#theme-toggle').checked = state.settings.theme === 'dark';
  const mode = state.settings.storageMode || 'unlimited';
  document.querySelectorAll('input[name="storage-mode"]').forEach((el) => {
    el.checked = el.value === mode;
  });
  updateStorageSectionSummary();
}

function toggleSettingsSection(toggleId, bodyId) {
  const toggle = document.getElementById(toggleId);
  const body = document.getElementById(bodyId);
  if (!toggle || !body) return;

  const chevron = toggle.querySelector('.settings-chevron');
  const expanded = body.classList.toggle('collapsed') === false;
  toggle.setAttribute('aria-expanded', String(expanded));
  if (chevron) chevron.textContent = expanded ? '▼' : '▶';
}

function updateStorageSectionSummary() {
  const summary = $('#storage-section-summary');
  if (!summary) return;

  const modeLabel = state.settings.storageMode === 'limited' ? 'A · 10 MB' : 'B · 无上限';
  const amountEl = $('#storage-usage-amount');
  const shortUsage = amountEl?.textContent?.trim();

  if (shortUsage && shortUsage !== '-') {
    summary.textContent = `${modeLabel} · ${shortUsage}`;
  } else {
    summary.textContent = modeLabel;
  }
}

function getFolderLabel(folderId) {
  if (!folderId) return '';
  const folder = state.folders.find((f) => f.id === folderId);
  return folder ? ` · 📁 ${truncateFolderName(folder.name)}` : '';
}

function populateFolderSelect(selectedId) {
  const select = $('#move-folder-select');
  if (!select) return;
  select.innerHTML = '<option value="">📁 未分类</option>';
  state.folders.forEach((folder) => {
    const opt = document.createElement('option');
    opt.value = folder.id;
    opt.textContent = `📁 ${truncateFolderName(folder.name)}`;
    opt.title = folder.name;
    select.appendChild(opt);
  });
  select.value = selectedId || '';
}

async function loadFolders() {
  const res = await sendMessage({ type: 'GET_FOLDERS' });
  state.folders = res.data || [];
  renderFolders();
}

async function loadConversations() {
  const res = await sendMessage({
    type: 'GET_CONVERSATIONS',
    filters: {
      query: state.searchQuery,
      platform: state.currentPlatform,
      folderId: state.currentFolderId
    }
  });
  state.conversations = res.data || [];
  renderConversationList();
}

function updateDeleteFolderBtn() {
  const btn = $('#delete-folder-btn');
  if (btn) btn.classList.toggle('hidden', !state.currentFolderId);
}

function renderFolders() {
  const container = $('#folders-list');
  container.innerHTML = '';

  const allChip = document.createElement('span');
  allChip.className = 'folder-chip' + (state.currentFolderId === '' ? ' active' : '');
  allChip.textContent = '全部';
  allChip.addEventListener('click', () => {
    state.currentFolderId = '';
    loadConversations();
    renderFolders();
  });
  container.appendChild(allChip);

  state.folders.forEach((folder) => {
    const chip = document.createElement('span');
    chip.className = 'folder-chip' + (state.currentFolderId === folder.id ? ' active' : '');
    chip.textContent = truncateFolderName(folder.name);
    chip.title = folder.name;
    chip.addEventListener('click', () => {
      state.currentFolderId = folder.id;
      loadConversations();
      renderFolders();
    });
    container.appendChild(chip);
  });

  updateDeleteFolderBtn();
}

function renderConversationList() {
  conversationList.innerHTML = '';
  updateRecordCount(state.conversations.length);

  if (state.conversations.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  // 简单虚拟滚动：超过100条只渲染可见区域附近
  const items = state.conversations;
  const useVirtual = items.length > 100;
  const renderItems = useVirtual ? items.slice(0, 100) : items;

  if (useVirtual) {
    const notice = document.createElement('div');
    notice.className = 'conv-meta';
    notice.style.padding = '8px 14px';
    notice.textContent = `显示前 100 / 共 ${items.length} 条，请使用搜索缩小范围`;
    conversationList.appendChild(notice);
  }

  renderItems.forEach((conv) => {
    const el = document.createElement('div');
    el.className = 'conversation-item' + (conv.favorite ? ' favorite' : '');
    el.dataset.id = conv.id;

    const snippet = state.searchQuery
      ? getSearchSnippet(conv, state.searchQuery)
      : (conv.messages?.[0]?.content?.slice(0, 50) || '');

    el.innerHTML = `
      <span class="conv-icon">📄</span>
      <div class="conv-body">
        <div class="conv-title">${escapeHtml(conv.title)}</div>
        <div class="conv-meta">${getPlatformLabel(conv.platform)} · ${formatDate(conv.createdAt)}${getFolderLabel(conv.folderId)}</div>
        ${state.searchQuery ? `<div class="conv-snippet">${highlightSearchText(snippet, state.searchQuery)}</div>` : ''}
      </div>
    `;

    el.addEventListener('click', () => openDetail(conv.id));
    conversationList.appendChild(el);
  });
}

async function openDetail(id) {
  const res = await sendMessage({ type: 'GET_CONVERSATION', id });
  const conv = res.data;
  if (!conv) return;

  state.currentConversation = conv;
  const displayMessages =
    conv.source === 'api'
      ? dedupeMessages(conv.messages || [])
      : conv.platform === 'deepseek'
        ? dedupeMessages(repairMessageRoles(conv.messages, conv.platform))
        : dedupeMessages(conv.messages || []);
  state.currentConversation = { ...conv, messages: displayMessages };

  $('#detail-title').textContent = conv.title;
  $('#detail-info').textContent = `${getPlatformLabel(conv.platform)} · ${formatDate(conv.createdAt)}`;
  $('#favorite-btn').textContent = conv.favorite ? '★' : '☆';

  populateFolderSelect(conv.folderId);

  const tagsEl = $('#detail-tags');
  tagsEl.innerHTML = (conv.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');

  const contentEl = $('#detail-content');
  contentEl.innerHTML = displayMessages.map((msg) => {
    const roleLabel = msg.role === 'user' ? '用户' : 'AI';
    let body = msg.content || '';
    if (msg.role === 'assistant') {
      body = sanitizeAssistantBodyForDisplay(body, conv);
    }
    const html = renderAssistantMessageHtml(body);
    // 全文进 DOM；折叠仅用 CSS 三行截断（不改存储）
    return `<div class="message-block ${msg.role}">
      <div class="message-role">${roleLabel}</div>
      <div class="message-body is-clamped">${html}</div>
      <button type="button" class="msg-expand-btn hidden" aria-expanded="false">展开</button>
    </div>`;
  }).join('');

  contentEl.querySelectorAll('.copy-code-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const code = e.target.closest('.code-block')?.querySelector('code')?.textContent;
      if (code) {
        navigator.clipboard.writeText(code);
        showToast('代码已复制');
      }
    });
  });

  contentEl.querySelectorAll('.acm-file-open').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (conv.url) chrome.tabs.create({ url: conv.url });
      else showToast('没有原始对话链接');
    });
  });

  bindMessageExpandControls(contentEl);
  showView(detailView);
}

/** 详情页：CSS 三行折叠 + 展开（视觉折叠，不截断存储/DOM 全文） */
function bindMessageExpandControls(root) {
  if (!root) return;
  const apply = () => {
    root.querySelectorAll('.message-block').forEach((block) => {
      const body = block.querySelector('.message-body');
      const btn = block.querySelector('.msg-expand-btn');
      if (!body || !btn) return;

      body.classList.add('is-clamped');
      body.classList.remove('is-expanded');
      const needsExpand = body.scrollHeight > body.clientHeight + 1;
      if (!needsExpand) {
        body.classList.remove('is-clamped');
        btn.classList.add('hidden');
        return;
      }

      btn.classList.remove('hidden');
      btn.textContent = '展开';
      btn.setAttribute('aria-expanded', 'false');
      btn.onclick = () => {
        const expanded = !body.classList.contains('is-expanded');
        body.classList.toggle('is-expanded', expanded);
        body.classList.toggle('is-clamped', !expanded);
        btn.textContent = expanded ? '收起' : '展开';
        btn.setAttribute('aria-expanded', String(expanded));
      };
    });
  };
  // 等布局完成再测高度，避免误判为无需展开
  requestAnimationFrame(apply);
}

function stripYuanbaoMarkupForDisplay(text) {
  let s = String(text || '');
  if (!s) return '';
  if (!/@mark_underline|\[citation:\d+\]|\[\s*\]|@replace=|\(@[a-zA-Z_]/.test(s)) {
    return s;
  }
  s = s.replace(/\(@replace=[^)]*\)/gi, '');
  s = s.replace(/\(@[a-zA-Z_][\w]*=[^)]*\)/g, '');
  s = s.replace(/\[\s*\]\s*\(@mark_underline=\d+\)/gi, '');
  s = s.replace(/\(@mark_underline=\d+\)/gi, '');
  s = s.replace(/\[citation:\d+\]/gi, '');
  s = s.replace(/\[\s*\]/g, '');
  s = s.replace(/[\u200b\u200c\u200d\ufeff]/g, '');
  s = s.replace(/[ \t]{2,}/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function sanitizeAssistantBodyForDisplay(body, conv) {
  const original = String(body || '');
  let s = original;
  const hadFileLeak =
    /sourceMappingURL|\.css\.map|card_card_gaokao|zhiyuan-report-card-|gaokao_choice_report|"zhiyuan_table"|flex;width:\d+px/.test(
      original
    ) ||
    ((original.match(/[{};]/g) || []).length > 20 &&
      /margin|padding|border-radius|flex\s*:/.test(original) &&
      original.length > 150);

  // 各平台：去掉思考外壳 / 卡片 JSON / CSS
  if (
    conv?.platform === 'qianwen' ||
    conv?.platform === 'deepseek' ||
    conv?.platform === 'doubao' ||
    conv?.platform === 'yuanbao' ||
    conv?.platform === 'kimi' ||
    hadFileLeak ||
    /"initialData"|"reqId"/.test(s)
  ) {
    s = stripThinkingForDisplay(s);
  }
  // 元宝：展示时清掉引用/下划线内部标记（兼容旧记录）
  if (conv?.platform === 'yuanbao' || /@mark_underline|\[citation:\d+\]|@replace=|\(@[a-zA-Z_]/.test(s)) {
    s = stripYuanbaoMarkupForDisplay(s);
  }
  s = stripCssLeakForDisplay(s);
  s = normalizeAssistantDisplayText(s);

  const stillJunk =
    !s.trim() ||
    (/^\s*[\{\[]/.test(s) && /"gaokao_choice_report"|"zhiyuan_table"|"initialData"|"reqId"/.test(s)) ||
    /sourceMappingURL|card_card_gaokao_zhiyuan_report/.test(s) ||
    ((s.match(/[{};]/g) || []).length > 20 && /flex\s*:|border-radius/.test(s));

  if ((stillJunk || hadFileLeak) && !/@@ACM_FILE:/.test(original) && !/@@ACM_FILE:/.test(s)) {
    const meta = guessFileMetaForDisplay(original);
    const card = [
      `@@ACM_FILE:${JSON.stringify(meta)}@@`,
      `📎 **${meta.title || '生成文件'}**`,
      '（交互式文件请点击下方按钮在原对话中打开查看）'
    ].join('\n');
    const proseOk =
      s.trim().length > 40 && !/[{};]/.test(s) && /[\u4e00-\u9fff]{8}/.test(s);
    return proseOk ? `${s}\n\n${card}` : card;
  }
  return s;
}

function guessFileMetaForDisplay(text) {
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
  return { kind: 'file', type, title, generatedAt: '' };
}

function stripCssLeakForDisplay(text) {
  let s = String(text || '');
  if (!s) return '';
  if (
    /sourceMappingURL|\.css\.map|card_card_gaokao_zhiyuan_report|zhiyuan-report-card-|progressWrap-|flex;width:\d+px/.test(
      s
    )
  ) {
    const keep = s
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => {
        if (!line) return false;
        if (/@@ACM_FILE:/.test(line)) return true;
        if (/[{};]|sourceMappingURL|card_card_|progressWrap|flex:0|margin-left:\d|width:\d+px/.test(line)) {
          return false;
        }
        if (/^[\.\#\[]/.test(line) && /\{|:/.test(line)) return false;
        return true;
      });
    s = keep.join('\n');
  }
  s = s.replace(/\/\*#\s*sourceMappingURL=[\s\S]*$/g, '');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** 渲染助手消息：支持生成文件卡片标记 */
function renderAssistantMessageHtml(text) {
  const raw = String(text || '');
  const fileRe = /@@ACM_FILE:(\{[\s\S]*?\})@@/g;
  const parts = [];
  let last = 0;
  let m;
  while ((m = fileRe.exec(raw))) {
    if (m.index > last) {
      parts.push({ type: 'md', text: raw.slice(last, m.index) });
    }
    try {
      parts.push({ type: 'file', meta: JSON.parse(m[1]) });
    } catch {
      parts.push({ type: 'md', text: m[0] });
    }
    last = m.index + m[0].length;
  }
  if (last < raw.length) parts.push({ type: 'md', text: raw.slice(last) });

  if (!parts.length) return renderMarkdown(raw);

  return parts
    .map((p) => {
      if (p.type === 'file') return renderGeneratedFileCard(p.meta);
      const t = String(p.text || '')
        .replace(/📎\s*\*\*[^*]+\*\*[\s\S]*?（交互式文件[\s\S]*?）/g, '')
        .trim();
      return t ? renderMarkdown(t) : '';
    })
    .filter(Boolean)
    .join('');
}

function renderGeneratedFileCard(meta) {
  const title = escapeHtml(meta?.title || '生成文件');
  const time = meta?.generatedAt ? escapeHtml(meta.generatedAt) : '';
  const typeLabel =
    meta?.type === 'gaokao_zhiyuan_report'
      ? '高考志愿报告'
      : meta?.type === 'presentation'
        ? '演示文稿'
        : meta?.type === 'document'
          ? '文档'
          : meta?.type === 'spreadsheet'
            ? '表格'
            : /image|img/i.test(meta?.type || '')
              ? '图片'
              : /video/i.test(meta?.type || '')
                ? '视频'
                : 'AI 生成文件';
  return `
    <div class="acm-file-card">
      <div class="acm-file-icon" aria-hidden="true">📄</div>
      <div class="acm-file-body">
        <div class="acm-file-type">${typeLabel}</div>
        <div class="acm-file-title">${title}</div>
        ${time ? `<div class="acm-file-time">生成于 ${time}</div>` : ''}
        <div class="acm-file-hint">侧栏无法打开交互卡片，请在原对话中查看完整内容</div>
        <button type="button" class="acm-file-open action-btn">打开原始对话</button>
      </div>
    </div>`;
}

function bindEvents() {
  searchInput.addEventListener('input', debounce((e) => {
    state.searchQuery = e.target.value.trim();
    loadConversations();
  }, 300));

  document.querySelectorAll('.platform-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.platform-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      state.currentPlatform = tab.dataset.platform;
      loadConversations();
    });
  });

  $('#save-btn').addEventListener('click', async () => {
    const btn = $('#save-btn');
    btn.disabled = true;
    btn.textContent = '保存中...';
    try {
      const res = await sendMessage({ type: 'SAVE_CURRENT_TAB' });
      if (res.success) {
        await loadFolders();
        let msg = '对话已保存';
        if (res.source === 'api') {
          const platform = res.data?.platform;
          if (platform === 'deepseek') msg = '已从 DeepSeek 官方 API 获取原文并保存';
          else if (platform === 'qianwen') msg = '已从千问页面状态/接口获取原文并保存';
          else if (platform === 'doubao') msg = '已从豆包官方接口获取原文并保存';
          else if (platform === 'yuanbao') msg = '已从元宝官方接口获取原文并保存';
          else if (platform === 'kimi') msg = '已从 Kimi 官方接口获取原文并保存';
          else msg = '已获取原文并保存';
        } else if (res.data?.platform === 'qianwen' && res.source === 'dom') {
          msg = '千问接口不可达，已保存页面可见内容';
        }
        if (res.data?.folderId) {
          const folder = state.folders.find((f) => f.id === res.data.folderId);
          if (folder) msg += ` → 📁 ${truncateFolderName(folder.name)}`;
        }
        showToast(msg);
        await loadConversations();
        updateStorageUsage();
      } else {
        showToast(res.error || '保存失败');
      }
    } finally {
      btn.disabled = false;
      btn.textContent = '💾 保存本轮';
    }
  });

  $('#export-btn').addEventListener('click', async () => {
    const btn = $('#export-btn');
    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = '导出中...';
    try {
      const res = await sendMessage({ type: 'EXPORT_CONVERSATIONS', format: 'markdown' });
      if (res.success) showToast('导出成功');
      else showToast(res.error || '导出失败');
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
    }
  });

  $('#back-btn').addEventListener('click', () => showView(listView));

  $('#favorite-btn').addEventListener('click', async () => {
    if (!state.currentConversation) return;
    const fav = !state.currentConversation.favorite;
    await sendMessage({
      type: 'UPDATE_CONVERSATION',
      id: state.currentConversation.id,
      updates: { favorite: fav }
    });
    state.currentConversation.favorite = fav;
    $('#favorite-btn').textContent = fav ? '★' : '☆';
    await loadConversations();
  });

  $('#copy-questions-btn').addEventListener('click', async () => {
    if (!state.currentConversation) return;
    const questions = getUserMessages(state.currentConversation).join('\n\n---\n\n');
    if (await copyText(questions)) showToast('提问内容已复制');
    else showToast('没有可复制的提问，请重新保存该对话');
  });

  $('#copy-all-btn').addEventListener('click', async () => {
    if (!state.currentConversation) return;
    const md = conversationToMarkdown(state.currentConversation);
    if (await copyText(md)) showToast('全文已复制');
    else showToast('没有可复制的内容');
  });

  $('#open-url-btn').addEventListener('click', async () => {
    if (!state.currentConversation?.url) return;
    const users = getUserMessages(state.currentConversation);
    const res = await sendMessage({
      type: 'OPEN_ORIGINAL_CONVERSATION',
      url: state.currentConversation.url,
      userContent: users[0] || '',
      userIndex: 0,
      contents: users
    });
    if (res.warning) showToast(res.warning);
  });

  $('#delete-btn').addEventListener('click', async () => {
    if (!state.currentConversation) return;
    const ok = await showConfirm({
      title: '删除对话',
      message: '确定删除这条对话吗？此操作不可撤销。',
      confirmText: '删除',
      cancelText: '取消',
      danger: true
    });
    if (!ok) return;
    await sendMessage({ type: 'DELETE_CONVERSATION', id: state.currentConversation.id });
    showToast('已删除');
    state.currentConversation = null;
    showView(listView);
    await loadConversations();
    updateStorageUsage();
  });

  $('#settings-btn').addEventListener('click', () => {
    showView(settingsView);
    updateStorageUsage();
  });

  $('#storage-warning-settings-btn').addEventListener('click', () => {
    showView(settingsView);
    updateStorageUsage();
  });

  $('#settings-back-btn').addEventListener('click', () => {
    showView(listView);
    updateStorageUsage();
  });

  $('#storage-section-toggle').addEventListener('click', () => {
    toggleSettingsSection('storage-section-toggle', 'storage-section-body');
  });

  $('#data-section-toggle').addEventListener('click', () => {
    toggleSettingsSection('data-section-toggle', 'data-section-body');
  });

  $('#auto-save-toggle').addEventListener('change', async (e) => {
    await sendMessage({ type: 'SAVE_SETTINGS', settings: { autoSave: e.target.checked } });
    showToast(e.target.checked ? '自动保存已开启' : '自动保存已关闭');
  });

  $('#auto-classify-toggle').addEventListener('change', async (e) => {
    await sendMessage({ type: 'SAVE_SETTINGS', settings: { autoClassify: e.target.checked } });
    showToast(e.target.checked ? '自动分类已开启' : '自动分类已关闭');
  });

  $('#move-folder-select').addEventListener('change', async (e) => {
    if (!state.currentConversation) return;
    const folderId = e.target.value || null;
    await sendMessage({
      type: 'UPDATE_CONVERSATION',
      id: state.currentConversation.id,
      updates: { folderId }
    });
    state.currentConversation.folderId = folderId;
    const label = folderId
      ? state.folders.find((f) => f.id === folderId)?.name || '文件夹'
      : '未分类';
    showToast(`已移动到：${label}`);
    await loadConversations();
  });

  $('#theme-toggle').addEventListener('change', async (e) => {
    const theme = e.target.checked ? 'dark' : 'light';
    await sendMessage({ type: 'SAVE_SETTINGS', settings: { theme } });
    state.settings.theme = theme;
    applyTheme();
  });

  document.querySelectorAll('input[name="storage-mode"]').forEach((radio) => {
    radio.addEventListener('change', async (e) => {
      if (!e.target.checked) return;
      const storageMode = e.target.value;
      await sendMessage({ type: 'SAVE_SETTINGS', settings: { storageMode } });
      state.settings.storageMode = storageMode;
      const label = storageMode === 'limited' ? 'A · 10 MB 上限' : 'B · 无上限';
      showToast(`已切换为 ${label}`);
      updateStorageSectionSummary();
      updateStorageUsage();
    });
  });

  $('#export-json-btn').addEventListener('click', async () => {
    const btn = $('#export-json-btn');
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `
      <span class="data-action-icon" aria-hidden="true">…</span>
      <span class="data-action-copy">
        <span class="data-action-title">导出中...</span>
        <span class="data-action-desc">请稍候</span>
      </span>`;
    try {
      const res = await sendMessage({ type: 'EXPORT_CONVERSATIONS', format: 'json' });
      if (res.success) showToast('JSON 备份已导出');
      else showToast(res.error || '导出失败');
    } finally {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  });

  let pendingImportMode = 'merge';

  $('#import-json-merge-btn').addEventListener('click', () => {
    pendingImportMode = 'merge';
    $('#import-json-input').click();
  });

  $('#import-json-replace-btn').addEventListener('click', async () => {
    const ok = await showConfirm({
      title: '替换全部数据',
      message: '将覆盖现有所有对话和文件夹，此操作不可撤销。确定继续？',
      confirmText: '继续替换',
      cancelText: '取消',
      danger: true
    });
    if (!ok) return;
    pendingImportMode = 'replace';
    $('#import-json-input').click();
  });

  $('#import-json-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const count = Array.isArray(data.conversations) ? data.conversations.length : 0;

      if (pendingImportMode === 'merge') {
        const ok = await showConfirm({
          title: '合并导入',
          message: `备份含 ${count} 条对话。\n\n合并到现有数据，相同 ID 的对话保留较新版本。`,
          confirmText: '开始合并',
          cancelText: '取消'
        });
        if (!ok) return;
      }

      showToast('导入中...', 1500);
      const res = await sendMessage({
        type: 'IMPORT_BACKUP',
        data,
        mode: pendingImportMode
      });

      if (!res.success) {
        showToast(res.error || '导入失败');
        return;
      }

      await loadSettings();
      await loadFolders();
      await loadConversations();
      updateStorageUsage();
      applyTheme();

      const r = res.data;
      if (r.mode === 'replace') {
        showToast(`已替换：${r.conversations} 条对话，${r.folders} 个文件夹`);
      } else {
        showToast(`合并完成：新增 ${r.added} 条，更新 ${r.updated} 条，共 ${r.total} 条`);
      }
    } catch (err) {
      showToast(err.message?.includes('JSON') ? 'JSON 文件格式错误' : (err.message || '导入失败'));
    }
  });

  $('#add-folder-btn').addEventListener('click', async () => {
    const name = await showPrompt({
      title: '新建文件夹',
      message: '输入文件夹名称，自动分类将按名称匹配对话。',
      placeholder: '例如：编程学习',
      confirmText: '创建',
      cancelText: '取消'
    });
    if (!name?.trim()) return;
    await sendMessage({
      type: 'SAVE_FOLDER',
      folder: { name: name.trim(), keywords: [name.trim()] }
    });
    await loadFolders();
    showToast(`文件夹「${name.trim()}」已创建`);
  });

  $('#delete-folder-btn').addEventListener('click', async () => {
    const folderId = state.currentFolderId;
    if (!folderId) return;
    const folder = state.folders.find((f) => f.id === folderId);
    if (!folder) return;
    const ok = await showConfirm({
      title: '删除文件夹',
      message: `确定删除文件夹「${folder.name}」？\n其中的对话将变为「未分类」，不会被删除。`,
      confirmText: '删除',
      cancelText: '取消',
      danger: true
    });
    if (!ok) return;
    await sendMessage({ type: 'DELETE_FOLDER', id: folderId });
    state.currentFolderId = '';
    await loadFolders();
    await loadConversations();
    showToast(`文件夹「${folder.name}」已删除`);
  });
}

function updateRecordCount(count) {
  const el = $('#record-count');
  if (!el) return;
  const n = Number(count) || 0;
  const filtered =
    !!state.searchQuery || !!state.currentPlatform || !!state.currentFolderId;
  el.textContent = filtered ? `当前 ${n} 条` : `共 ${n} 条`;
  el.title = filtered ? '当前筛选条件下的对话数量' : '已保存的对话总数';
}

function isSameConversation(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id && a.id === b.id) return true;
  if (a.url && b.url && a.url === b.url) return true;
  if (a.sessionId && b.sessionId && a.sessionId === b.sessionId) return true;
  return false;
}

let _detailRefreshTimer = null;
async function refreshDetailIfMatching(saved) {
  if (!detailView.classList.contains('active')) return;
  const current = state.currentConversation;
  if (!current || !saved || !isSameConversation(current, saved)) return;

  clearTimeout(_detailRefreshTimer);
  _detailRefreshTimer = setTimeout(async () => {
    if (!detailView.classList.contains('active')) return;
    const cur = state.currentConversation;
    if (!cur || !isSameConversation(cur, saved)) return;

    const contentEl = $('#detail-content');
    const prevScroll = contentEl?.scrollTop || 0;
    const nearBottom =
      !!contentEl &&
      contentEl.scrollHeight - contentEl.scrollTop - contentEl.clientHeight < 96;

    await openDetail(saved.id || cur.id);

    const next = $('#detail-content');
    if (!next) return;
    if (nearBottom) next.scrollTop = next.scrollHeight;
    else next.scrollTop = prevScroll;
  }, 60);
}

function listenForUpdates() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'CONVERSATION_SAVED') {
      loadConversations();
      updateStorageUsage();
      refreshDetailIfMatching(message.data);
      if (message.auto) showToast('对话已自动保存');
    }
  });

  // 兜底：storage 变更时若仍在详情页，按 id 再拉一次（防消息漏收）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.acm_conversations) return;
    if (!detailView.classList.contains('active') || !state.currentConversation?.id) {
      return;
    }
    const list = changes.acm_conversations.newValue;
    if (!Array.isArray(list)) return;
    const latest = list.find((c) => isSameConversation(c, state.currentConversation));
    if (!latest) return;
    const cur = state.currentConversation;
    const sameLen = (latest.messages || []).length === (cur.messages || []).length;
    const sameTail =
      String(latest.messages?.[(latest.messages || []).length - 1]?.content || '') ===
      String(cur.messages?.[(cur.messages || []).length - 1]?.content || '');
    if (sameLen && sameTail) return;
    refreshDetailIfMatching(latest);
    loadConversations();
  });
}

async function updateStorageUsage() {
  const res = await sendMessage({ type: 'GET_STORAGE_USAGE' });
  if (!res.data) return;

  const data = res.data;
  state.settings.storageMode = data.storageMode || state.settings.storageMode || 'unlimited';

  const isLimited = data.storageMode === 'limited';
  const warningBanner = $('#storage-warning');
  const progressWrap = $('#storage-progress-wrap');
  const metaEl = $('#storage-usage-meta');
  const tipLimited = $('#storage-tip-limited');
  const usageNote = $('#storage-usage-note');

  $('#storage-usage-amount').textContent = data.formatted;

  if (isLimited) {
    metaEl.textContent = `${data.percent}% / ${data.quotaFormatted} 上限`;
    metaEl.className = 'storage-usage-meta';
    if (data.level === 'critical') metaEl.classList.add('critical');
    else if (data.level === 'warn') metaEl.classList.add('warn');
    else metaEl.classList.add('ok');

    usageNote.classList.add('hidden');

    $('#storage-progress-fill').style.width = `${data.percent}%`;
    $('#storage-progress-fill').className = 'storage-progress-fill ' + (data.level || 'ok');

    const showTip = data.level === 'warn' || data.level === 'critical';
    progressWrap.classList.toggle('hidden', showTip);
    tipLimited.classList.toggle('hidden', !showTip);
    tipLimited.classList.toggle('critical', data.level === 'critical');
    if (showTip) {
      const remain = formatBytes(Math.max(0, data.quotaBytes - data.bytes));
      tipLimited.textContent = data.level === 'critical'
        ? `剩余约 ${remain}，继续保存将被拒绝`
        : `建议导出备份或清理旧对话`;
    }

    $('#storage-usage').textContent = `${data.formatted} / ${data.quotaFormatted}`;
    $('#storage-percent').textContent = `${data.percent}%`;

    const showWarn = data.level === 'warn' || data.level === 'critical';
    warningBanner.classList.toggle('hidden', !showWarn);
    warningBanner.classList.toggle('critical', data.level === 'critical');

    if (showWarn) {
      const remain = formatBytes(Math.max(0, data.quotaBytes - data.bytes));
      const text = data.level === 'critical'
        ? `已用 ${data.formatted}，剩余约 ${remain}，继续保存将被拒绝。`
        : `已用 ${data.formatted}（${data.percent}%），建议尽快备份或清理。`;
      $('#storage-warning-text').textContent =
        text + ' 可导出备份、删除旧对话，或在设置中切换为 B 方案无上限。';
    }
  } else {
    metaEl.textContent = '充足 / 无上限';
    metaEl.className = 'storage-usage-meta ok';
    progressWrap.classList.add('hidden');
    tipLimited.classList.add('hidden');
    usageNote.classList.remove('hidden');

    $('#storage-usage').textContent = `${data.formatted} / 无上限`;
    warningBanner.classList.add('hidden');
  }

  updateStorageSectionSummary();
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function applyTheme() {
  const theme = state.settings.theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

init();
