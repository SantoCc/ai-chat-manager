/**
 * Service Worker - 消息中转、存储操作、导出
 */
import {
  addConversation,
  getConversationById,
  getConversations,
  deleteConversation,
  updateConversation,
  mergeMessages,
  searchConversations,
  getSettings,
  saveSettings,
  getFolders,
  saveFolders,
  getStorageUsage,
  checkCanSave,
  exportAllData,
  importAllData
} from '../lib/storage.js';

import {
  conversationToMarkdown,
  conversationToHtml,
  downloadFile,
  copyToClipboard
} from '../lib/export.js';

const AI_HOST_HINTS = [
  'doubao.com',
  'qianwen.com',
  'tongyi.com',
  'tongyi.aliyun.com',
  'qianwen.aliyun.com',
  'chat.deepseek.com',
  'yuanbao.tencent.com',
  'kimi.moonshot.cn',
  'kimi.com'
];

const CONTENT_SCRIPT_MAP = [
  {
    test: (url) => /doubao\.com/i.test(url),
    files: [
      'utils/helpers.js',
      'utils/dom.js',
      'content/doubao-api.js',
      'content/adapters/base.js',
      'content/adapters/doubao.js',
      'content/content.js'
    ],
    mainWorldFiles: ['content/inject/doubao-hook.js']
  },
  {
    test: (url) =>
      /qianwen\.com|tongyi\.com|tongyi\.aliyun\.com|qianwen\.aliyun\.com/i.test(url),
    files: [
      'utils/helpers.js',
      'utils/dom.js',
      'content/qianwen-api.js',
      'content/adapters/base.js',
      'content/adapters/qianwen.js',
      'content/content.js'
    ]
  },
  {
    test: (url) => /chat\.deepseek\.com/i.test(url),
    files: [
      'utils/helpers.js',
      'utils/dom.js',
      'content/deepseek-api.js',
      'content/adapters/base.js',
      'content/adapters/deepseek.js',
      'content/content.js'
    ]
  },
  {
    test: (url) => /yuanbao\.tencent\.com/i.test(url),
    files: [
      'utils/helpers.js',
      'utils/dom.js',
      'content/yuanbao-api.js',
      'content/adapters/base.js',
      'content/adapters/yuanbao.js',
      'content/content.js'
    ],
    mainWorldFiles: ['content/inject/yuanbao-hook.js']
  },
  {
    test: (url) => /kimi\.moonshot\.cn|kimi\.com/i.test(url),
    files: [
      'utils/helpers.js',
      'utils/dom.js',
      'content/kimi-api.js',
      'content/adapters/base.js',
      'content/adapters/kimi.js',
      'content/content.js'
    ],
    mainWorldFiles: ['content/inject/kimi-hook.js']
  }
];

// 点击扩展图标打开侧边栏
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((err) => {
    sendResponse({ success: false, error: err.message });
  });
  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'SAVE_CONVERSATION':
      return handleSaveConversation(message.data, message.auto);

    case 'SAVE_CURRENT_TAB':
      // 侧栏发来的消息没有 sender.tab，必须自行定位浏览器标签
      return handleSaveCurrentTab(sender.tab?.id);

    case 'GET_CONVERSATIONS':
      return {
        success: true,
        data: await searchConversations(message.filters || {})
      };

    case 'GET_CONVERSATION':
      return {
        success: true,
        data: await getConversationById(message.id)
      };

    case 'DELETE_CONVERSATION':
      await deleteConversation(message.id);
      return { success: true };

    case 'UPDATE_CONVERSATION':
      return {
        success: true,
        data: await updateConversation(message.id, message.updates)
      };

    case 'GET_SETTINGS':
      return { success: true, data: await getSettings() };

    case 'SAVE_SETTINGS':
      await saveSettings(message.settings);
      return { success: true, data: await getSettings() };

    case 'GET_FOLDERS':
      return { success: true, data: await getFolders() };

    case 'SAVE_FOLDER':
      return handleSaveFolder(message.folder);

    case 'DELETE_FOLDER':
      return handleDeleteFolder(message.id);

    case 'GET_STORAGE_USAGE':
      return { success: true, data: await getStorageUsage() };

    case 'CHECK_CAN_SAVE':
      return { success: true, data: await checkCanSave() };

    case 'EXPORT_CONVERSATIONS':
      return handleExport(message);

    case 'IMPORT_BACKUP':
      return handleImport(message);

    case 'COPY_TO_CLIPBOARD':
      await copyToClipboard(message.text);
      return { success: true };

    case 'OPEN_ORIGINAL_CONVERSATION':
      return handleOpenOriginalConversation(message);

    case 'DOUBAO_MAIN_WORLD_FETCH':
      return handleDoubaoMainWorldFetch(message, sender);

    case 'QIANWEN_MAIN_WORLD_FETCH':
      return handleQianwenMainWorldFetch(message, sender);

    case 'QIANWEN_READ_PAGE_STATE':
      return handleQianwenReadPageState(message, sender);

    default:
      return { success: false, error: '未知消息类型: ' + message.type };
  }
}

/**
 * 在豆包页 MAIN 世界发起 /im/chain/single（绕过页面 CSP / isolated world cookie 差异）
 */
async function handleDoubaoMainWorldFetch(message, sender) {
  const uplink = message?.uplink;
  if (!uplink?.conversation_id) {
    return { ok: false, error: '缺少 uplink' };
  }

  let tabId = sender?.tab?.id || null;
  if (!tabId) {
    try {
      const tabs = await chrome.tabs.query({
        url: ['*://*.doubao.com/*', '*://doubao.com/*', '*://www.doubao.com/*']
      });
      const preferred =
        tabs.find((t) => /\/chat\//i.test(t.url || '')) ||
        tabs.find((t) => t.active) ||
        tabs[0];
      tabId = preferred?.id || null;
    } catch {
      tabId = null;
    }
  }
  if (!tabId) {
    return { ok: false, error: '未找到豆包标签页' };
  }

  if (!chrome.scripting?.executeScript) {
    return { ok: false, error: '无 scripting 权限' };
  }

  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [uplink],
      func: async (uplinkBody) => {
        function buildParams() {
          try {
            const live = performance
              .getEntriesByType('resource')
              .map((e) => e.name)
              .reverse()
              .find(
                (u) =>
                  (u.includes('/im/') || u.includes('/alice/')) && u.includes('?')
              );
            if (live) {
              const p = new URL(live).searchParams;
              p.delete('a_bogus');
              p.delete('msToken');
              if (p.get('aid') || p.get('version_code')) return p;
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
          params.set('web_tab_id', String(Date.now()));
          return params;
        }

        const params = buildParams();
        const url = `${location.origin}/im/chain/single?${params.toString()}`;
        const body = {
          cmd: 3100,
          sequence_id: String(Date.now()),
          channel: 2,
          version: '1',
          uplink_body: { pull_singe_chain_uplink_body: uplinkBody }
        };
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: {
            Accept: 'application/json, text/plain, */*',
            'Content-Type': 'application/json; encoding=utf-8',
            'agw-js-conv': 'str, str',
            Referer: location.href
          },
          body: JSON.stringify(body)
        });
        return await res.json();
      }
    });

    if (result && typeof result === 'object') {
      return { ok: true, payload: result };
    }
    return { ok: false, error: 'MAIN fetch 无结果' };
  } catch (err) {
    console.warn('[ACM] DOUBAO_MAIN_WORLD_FETCH failed', err);
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * 在千问页 MAIN 世界请求 chat2-api 历史消息
 */
async function handleQianwenMainWorldFetch(message, sender) {
  const sessionId = message?.sessionId;
  if (!sessionId) return { ok: false, error: '缺少 sessionId' };

  let tabId = sender?.tab?.id || null;
  if (!tabId) {
    try {
      const tabs = await chrome.tabs.query({
        url: [
          '*://*.qianwen.com/*',
          '*://qianwen.com/*',
          '*://www.qianwen.com/*',
          '*://tongyi.aliyun.com/*',
          '*://*.tongyi.com/*'
        ]
      });
      const preferred =
        tabs.find((t) => /session|chat/i.test(t.url || '')) ||
        tabs.find((t) => t.active) ||
        tabs[0];
      tabId = preferred?.id || null;
    } catch {
      tabId = null;
    }
  }
  if (!tabId) return { ok: false, error: '未找到千问标签页' };
  if (!chrome.scripting?.executeScript) {
    return { ok: false, error: '无 scripting 权限' };
  }

  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [
        {
          sessionId: String(sessionId),
          page: message.page || 1,
          pageSize: message.pageSize || 50,
          ut: message.ut || '',
          referer: message.referer || ''
        }
      ],
      func: async (opts) => {
        function getUt() {
          if (opts.ut) return opts.ut;
          try {
            const m = document.cookie.match(/(?:^|;\\s*)b-user-id=([^;]+)/);
            if (m?.[1]) return decodeURIComponent(m[1]);
          } catch {
            // ignore
          }
          try {
            const live = performance
              .getEntriesByType('resource')
              .map((e) => e.name)
              .reverse()
              .find((u) => /chat2-api/i.test(u) && /[?&]ut=/.test(u));
            if (live) return new URL(live).searchParams.get('ut');
          } catch {
            // ignore
          }
          return '';
        }

        function origins() {
          const found = [];
          try {
            for (const e of performance.getEntriesByType('resource')) {
              try {
                const u = new URL(e.name);
                if (/chat2-api[^/]*\\.qianwen\\.com$/i.test(u.host)) {
                  if (!found.includes(u.origin)) found.push(u.origin);
                }
              } catch {
                // ignore
              }
            }
          } catch {
            // ignore
          }
          for (const d of [
            'https://chat2-api.qianwen.com',
            'https://chat2-api-router.qianwen.com',
            'https://chat2-api-na.qianwen.com'
          ]) {
            if (!found.includes(d)) found.push(d);
          }
          return found;
        }

        const params = new URLSearchParams({
          biz_id: 'ai_qwen',
          chat_client: 'h5',
          device: 'pc',
          fr: 'pc',
          pr: 'qwen',
          session_id: opts.sessionId,
          page_size: String(opts.pageSize || 50),
          page: String(opts.page || 1),
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
        const ut = getUt();
        if (ut) params.set('ut', ut);

        let lastErr = null;
        for (const origin of origins()) {
          try {
            const url = `${origin}/api/v1/session/msg/list?${params}`;
            const res = await fetch(url, {
              credentials: 'include',
              headers: {
                Accept: 'application/json, text/plain, */*',
                Referer: opts.referer || location.href,
                'x-platform': 'pc_tongyi'
              }
            });
            if (!res.ok) {
              lastErr = `HTTP ${res.status}`;
              continue;
            }
            return await res.json();
          } catch (err) {
            lastErr = String(err && err.message ? err.message : err);
          }
        }
        throw new Error(lastErr || 'MAIN qianwen fetch failed');
      }
    });

    if (result && typeof result === 'object') {
      return { ok: true, payload: result };
    }
    return { ok: false, error: 'MAIN fetch 无结果' };
  } catch (err) {
    console.warn('[ACM] QIANWEN_MAIN_WORLD_FETCH failed', err);
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * 从千问页内存状态读取 chatRounds（不依赖外部 API DNS）
 */
async function handleQianwenReadPageState(message, sender) {
  let tabId = sender?.tab?.id || null;
  if (!tabId) {
    try {
      const tabs = await chrome.tabs.query({
        url: [
          '*://*.qianwen.com/*',
          '*://qianwen.com/*',
          '*://www.qianwen.com/*',
          '*://tongyi.aliyun.com/*',
          '*://*.tongyi.com/*'
        ]
      });
      tabId =
        tabs.find((t) => t.active)?.id ||
        tabs.find((t) => /qianwen\.com/i.test(t.url || ''))?.id ||
        tabs[0]?.id ||
        null;
    } catch {
      tabId = null;
    }
  }
  if (!tabId) return { ok: false, error: '未找到千问标签页' };
  if (!chrome.scripting?.executeScript) {
    return { ok: false, error: '无 scripting 权限' };
  }

  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        function isNonTextType(node) {
          if (!node || typeof node !== 'object') return false;
          const t = String(
            node.contentType || node.mime_type || node.type || ''
          ).toLowerCase();
          const card = String(node.cardCode || '').toLowerCase();
          const plugin = String(node.pluginCode || '').toLowerCase();
          // 只保留纯文本类
          if (t && !/^(text|text2image|markdown|plain)$/i.test(t)) return true;
          if (/deep.?think|think|planning|ppt|aippt|wanx|quark|search|gaokao|zhiyuan|report|plugin/i.test(card)) {
            return true;
          }
          if (/deep.?think|think|planning|search|gaokao|zhiyuan|report/i.test(plugin)) {
            return true;
          }
          if (/^(image|video|audio|iframe)$/i.test(t) || /video|audio|image\//i.test(t)) {
            return true;
          }
          if (
            node.type === 'gaokao_choice_report' ||
            node.zhiyuan_table ||
            node.zhiyuan_list ||
            node.initialData ||
            (node.data && (node.data.initialData || node.data.type === 'gaokao_choice_report'))
          ) {
            return true;
          }
          return false;
        }

        function isStructuredJunk(text) {
          const s = String(text || '').trim();
          if (!s) return true;
          if (
            /"gaokao_choice_report"|gaokao_choice_report|"zhiyuan_table"|"zhiyuan_list"|"initialData"|"school_prob"|"new_major_group_id"|"new_major_id"|"major_prob"/.test(
              s
            )
          ) {
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

        function collectTexts(node, depth, out) {
          if (node == null || depth > 14) return;
          if (typeof node === 'string' || typeof node === 'number') {
            const s = String(node).trim();
            if (s && !isThinkingFragment(s) && !isStructuredJunk(s)) {
              const c = coerceContent(s);
              if (c && !isStructuredJunk(c)) out.push(c);
            }
            return;
          }
          if (Array.isArray(node)) {
            for (const n of node) collectTexts(n, depth + 1, out);
            return;
          }
          if (typeof node !== 'object') return;
          if (isNonTextType(node)) return;

          const type = String(node.contentType || '').toLowerCase();
          if (type && !/^(text|text2image|markdown|plain)$/i.test(type)) {
            return;
          }

          // 先挖嵌套容器，禁止顶层短 markdown/content 提前 return 导致截断
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
          const before = out.length;
          for (const k of nestedKeys) {
            if (node[k] == null) continue;
            collectTexts(node[k], depth + 1, out);
          }
          if (out.length > before) return;

          if (typeof node.markdown === 'string' && node.markdown.trim()) {
            const s = coerceContent(node.markdown);
            if (s && !isThinkingFragment(s) && !isStructuredJunk(s)) out.push(s);
            return;
          }
          if (typeof node.text === 'string' && node.text.trim()) {
            const s = coerceContent(node.text);
            if (s && !isThinkingFragment(s) && !isStructuredJunk(s)) out.push(s);
            return;
          }
          if (typeof node.content === 'string' && node.content.trim()) {
            const s = coerceContent(node.content);
            if (s && !isThinkingFragment(s) && !isStructuredJunk(s)) out.push(s);
            return;
          }
          if (node.content && typeof node.content === 'object') {
            if (
              node.content.zhiyuan_table ||
              node.content.zhiyuan_list ||
              node.content.type === 'gaokao_choice_report'
            ) {
              return;
            }
            collectTexts(node.content, depth + 1, out);
          }
        }

        function extractText(node) {
          const out = [];
          collectTexts(node, 0, out);
          if (!out.length) return '';
          const uniq = [];
          const seen = new Set();
          for (const t of out) {
            const s = String(t || '').trim();
            if (!s || isStructuredJunk(s)) continue;
            const key = s.replace(/\s+/g, ' ').trim().slice(0, 160);
            if (seen.has(key)) continue;
            let replaced = false;
            for (let i = 0; i < uniq.length; i++) {
              if (uniq[i].includes(s) && uniq[i].length >= s.length) {
                replaced = true;
                break;
              }
              if (s.includes(uniq[i]) && s.length > uniq[i].length) {
                uniq[i] = s;
                replaced = true;
                break;
              }
            }
            if (replaced) continue;
            seen.add(key);
            uniq.push(s);
          }
          return stripThinking(uniq.join('\n\n'));
        }

        function pickAnswer(question) {
          const answers = question?.answers || [];
          if (!answers.length) return null;
          const idx =
            typeof question.currentAnswerIndex === 'number'
              ? question.currentAnswerIndex
              : answers.length - 1;
          return answers[idx] || answers[answers.length - 1] || null;
        }

        function extractAssistant(ans, question) {
          if (!ans && !question) return '';
          const candidates = [
            ans?.answerItemModels,
            ans?.contents,
            ans?.rawMessage?.qwen_response_messages,
            ans?.rawMessage?.response_messages,
            ans?.rawMessage?.contents,
            question?.rawMessage?.qwen_response_messages,
            ans?.content,
            ans?.markdown,
            ans?.text,
            ans?.message,
            ans?.data
          ];
          // 取最长完整稿，避免流式半截 / 思考碎片抢先返回
          let best = '';
          for (const c of candidates) {
            const t = stripThinking(extractText(c));
            if (t && t.length > best.length) best = t;
          }
          return best;
        }

        function extractUser(q) {
          const candidates = [
            q?.rawMessage?.request_messages,
            q?.rawMessage?.prompt,
            q?.rawMessage?.contents,
            q?.contents,
            q?.content,
            q?.text,
            q?.question,
            q?.prompt,
            q?.message
          ];
          for (const c of candidates) {
            const t = extractText(c);
            if (t) return t;
          }
          return '';
        }

        function isThinkingFragment(text) {
          const s = String(text || '').replace(/\s+/g, ' ').trim();
          if (!s) return true;
          if (isStructuredJunk(text)) return true;
          if (/^(已完成思考|Finished thinking|Thinking\.\.\.|正在思考)/i.test(s)) return true;
          if (/参考了\s*\d+\s*篇材料/.test(s) && s.length < 80) return true;
          if (
            /(明确选择问题|搜索\s*\d+\s*个关键词|site_name|web_search|deep_thinking)/i.test(s) &&
            !/(^|\n)\s*([一二三四五六七八九十]+[、．.]|#{1,3}\s+)/.test(String(text))
          ) {
            return true;
          }
          if (/^(用户想|用户希望|我先|接下来我将|当前已查)/i.test(s) && s.length < 500) {
            return true;
          }
          return false;
        }

        function coerceContent(s) {
          const raw = String(s || '').trim();
          if (!raw || isStructuredJunk(raw)) return '';
          if (/<\/?[a-z][\s\S]*>/i.test(raw)) {
            const wrap = document.createElement('div');
            wrap.innerHTML = raw;
            const md = htmlToMarkdown(wrap) || raw;
            return isStructuredJunk(md) ? '' : md;
          }
          return stripThinking(raw);
        }

        function stripThinking(text) {
          let s = String(text || '').trim();
          if (!s) return '';
          // 剔除混排 JSON 卡片
          s = stripStructuredJson(s);
          if (!s) return '';
          s = s.replace(/^(?:已完成思考|Finished thinking)[^\n]*\n+/i, '');
          s = s.replace(/^参考了\s*\d+\s*篇材料[^\n]*\n+/i, '');
          const start = s.slice(0, 120);
          if (
            /^(已完成思考|Finished thinking|明确选择问题|搜索\s*\d+\s*个关键词|用户想知道|用户想|Thinking)/i.test(
              start
            ) ||
            (/deep_thinking|web_search|site_name/i.test(start) &&
              !/^[一二三四五六七八九十]/.test(start))
          ) {
            const patterns = [
              /(?:^|\n)((?:#{1,6}\s+)?(?:\*\*)?[一二三四五六七八九十]+[、．.])/,
              /(?:^|\n)((?:#{1,6}\s+)?(?:\*\*)?\d+[\.、]\s*)/,
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
          return stripStructuredJson(
            s
              .split('\n')
              .filter((line) => {
                const t = line.replace(/\s+/g, '').trim();
                if (!t) return true;
                if (
                  /^(已完成思考|Finishedthinking|参考了\d+篇材料|表格|下载为表格|导出为图片)$/i.test(
                    t
                  )
                ) {
                  return false;
                }
                return true;
              })
              .join('\n')
              .replace(/\n{3,}/g, '\n\n')
              .trim()
          );
        }

        function stripStructuredJson(text) {
          let s = String(text || '');
          if (!s || !/[\{\[]/.test(s)) return s;
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
                  if (!isStructuredJunk(chunk)) out += chunk;
                  i = j + 1;
                  break;
                }
              }
            }
            if (j >= s.length) {
              const tail = s.slice(i);
              if (!isStructuredJunk(tail) && !/"reqId"|"zhiyuan_table"|"initialData"/.test(tail)) {
                out += tail;
              }
              break;
            }
          }
          return out.replace(/\n{3,}/g, '\n\n').trim();
        }

        function normalizeMessages(list) {
          const out = [];
          for (const m of list || []) {
            if (!m?.content) continue;
            let content = String(m.content).trim();
            if (!content) continue;
            const role = m.role === 'user' ? 'user' : 'assistant';
            if (role === 'assistant') {
              if (isThinkingFragment(content) && content.length < 800) continue;
              content = stripThinking(content);
              if (!content) continue;
            }
            const prev = out[out.length - 1];
            if (prev && prev.role === role && prev.content === content) continue;
            if (
              prev &&
              prev.role === role &&
              (content.startsWith(prev.content.slice(0, 80)) ||
                prev.content.startsWith(content.slice(0, 80)))
            ) {
              if (content.length > prev.content.length) prev.content = content;
              continue;
            }
            out.push({ role, content, timestamp: m.timestamp || null });
          }
          return out;
        }

        function cellText(cell) {
          return String(cell?.innerText || cell?.textContent || '')
            .replace(/\s+/g, ' ')
            .replace(/\|/g, '\\|')
            .trim();
        }

        function tableToMarkdown(table) {
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
          return [
            `| ${header.join(' | ')} |`,
            `| ${sep.join(' | ')} |`,
            ...body.map((r) => `| ${r.join(' | ')} |`)
          ].join('\n');
        }

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
                '[class*="card_card_gaokao"]'
              ].join(',')
            )
          );
          const cards = [];
          const seen = new Set();
          for (const el of nodes) {
            if (nodes.some((o) => o !== el && o.contains(el))) continue;
            const raw = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (!raw || raw.length > 500) continue;
            let title = '生成文件';
            const titleMatch = raw.match(/志愿报告\s*[\d\-—_]+|志愿报告/);
            if (titleMatch) title = titleMatch[0].trim();
            else if (/PPT|幻灯片/i.test(raw)) title = raw.slice(0, 40);
            else if (/报告|文档|文件/.test(raw)) title = raw.slice(0, 40);
            let generatedAt = '';
            const timeMatch =
              raw.match(/(?:Generated on|生成于|生成时间)[:\s]*([\d/\-.\s:]+)/i) ||
              raw.match(/(\d{2}-\d{2}\s+\d{2}:\d{2})/) ||
              raw.match(/(20\d{2}-\d{2}-\d{2}[^\d]*\d{0,2}:?\d{0,2})/);
            if (timeMatch) generatedAt = timeMatch[1].trim();
            const key = `${title}::${generatedAt}`;
            if (seen.has(key)) continue;
            seen.add(key);
            cards.push({
              kind: 'file',
              type: /志愿|gaokao|zhiyuan/i.test(title + raw)
                ? 'gaokao_zhiyuan_report'
                : 'generated_file',
              title,
              generatedAt
            });
          }
          return cards;
        }

        function formatGeneratedFileCardsMarkdown(cards) {
          if (!Array.isArray(cards) || !cards.length) return '';
          return cards
            .map((c) => {
              const meta = {
                kind: 'file',
                type: c.type || 'generated_file',
                title: c.title || '生成文件',
                generatedAt: c.generatedAt || ''
              };
              return [
                `@@ACM_FILE:${JSON.stringify(meta)}@@`,
                `📎 **${meta.title}**`,
                meta.generatedAt ? `生成时间：${meta.generatedAt}` : '',
                '（交互式文件请点击「原始对话」在千问中打开查看）'
              ]
                .filter(Boolean)
                .join('\n');
            })
            .join('\n\n');
        }

        function stripCssLeakText(text) {
          let s = String(text || '');
          if (!s) return '';
          if (
            /sourceMappingURL|\.css\.map|card_card_gaokao_zhiyuan_report|zhiyuan-report-card-|progressWrap-|progressTrack-|progressBar-/.test(
              s
            )
          ) {
            if (
              (s.match(/[{};]/g) || []).length > 15 ||
              /flex\s*;\s*width\s*:\s*\d+px/i.test(s) ||
              /sourceMappingURL/.test(s)
            ) {
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
          s = s.replace(/[^\n]{0,40}\.card\.card_card_gaokao[\s\S]{20,8000?}(?=\n|$)/g, '');
          s = s.replace(/\/\*#\s*sourceMappingURL=[\s\S]*$/g, '');
          return s.replace(/\n{3,}/g, '\n\n').trim();
        }

        function htmlToMarkdown(element) {
          if (!element) return '';
          const clone = element.cloneNode(true);
          clone
            .querySelectorAll('style, script, noscript, link[rel="stylesheet"], template')
            .forEach((el) => el.remove());
          const fileCards = extractGeneratedFileCardsFromDom(clone);
          clone
            .querySelectorAll(
              [
                'button',
                'svg',
                'img',
                'video',
                'audio',
                'iframe',
                '[aria-hidden="true"]',
                '[class*="toolbar"]',
                '[class*="Toolbar"]',
                '[class*="table-action"]',
                '[class*="export"]',
                '[class*="download"]',
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
          clone.querySelectorAll('div, section, details, article').forEach((el) => {
            if (!el || !el.parentNode) return;
            const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (!t || t.length > 2500) return;
            if (/已完成思考|Finished thinking|Thinking\.\.\.|参考了\s*\d+\s*篇材料/.test(t)) {
              if (
                !/(?:^|\n)\s*[一二三四五六七八九十]+[、．.]/.test(el.innerText || '') &&
                !el.querySelector('table')
              ) {
                el.remove();
              }
            }
          });
          clone.querySelectorAll('span, div, p, a').forEach((el) => {
            const t = (el.textContent || '').replace(/\s+/g, '').trim();
            if (/^(表格|下载为表格|导出为图片|复制|分享)$/.test(t) && !el.querySelector('table')) {
              el.remove();
            }
          });
          clone.querySelectorAll('table').forEach((table) => {
            const md = tableToMarkdown(table);
            table.replaceWith(document.createTextNode(md ? `\n\n${md}\n\n` : ''));
          });
          clone.querySelectorAll('pre').forEach((pre) => {
            const code = pre.querySelector('code');
            const text = (code || pre).innerText || '';
            pre.replaceWith(document.createTextNode(`\n\`\`\`\n${text.trim()}\n\`\`\`\n`));
          });
          clone.querySelectorAll('code').forEach((code) => {
            if (code.closest('pre')) return;
            code.replaceWith(
              document.createTextNode('`' + (code.innerText || '').trim() + '`')
            );
          });
          for (let level = 6; level >= 1; level--) {
            clone.querySelectorAll(`h${level}`).forEach((h) => {
              const text = (h.innerText || '').trim();
              h.replaceWith(document.createTextNode(`\n${'#'.repeat(level)} ${text}\n\n`));
            });
          }
          clone.querySelectorAll('strong, b').forEach((el) => {
            const text = (el.innerText || '').trim();
            if (text) el.replaceWith(document.createTextNode(`**${text}**`));
            else el.remove();
          });
          clone.querySelectorAll('em, i').forEach((el) => {
            const text = (el.innerText || '').trim();
            if (text) el.replaceWith(document.createTextNode(`*${text}*`));
            else el.remove();
          });
          clone.querySelectorAll('a[href]').forEach((a) => {
            const text = (a.innerText || '').trim();
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
          clone.querySelectorAll('li').forEach((li) => {
            const parent = li.parentElement;
            const ordered = parent && parent.tagName === 'OL';
            const idx = ordered
              ? Array.from(parent.children).filter((c) => c.tagName === 'LI').indexOf(li) + 1
              : 0;
            const prefix = ordered ? `${idx}. ` : '- ';
            li.replaceWith(
              document.createTextNode(prefix + (li.innerText || '').trim() + '\n')
            );
          });
          clone.querySelectorAll('br').forEach((br) => {
            br.replaceWith(document.createTextNode('\n'));
          });
          let text = (clone.innerText || clone.textContent || '').trim();
          text = text
            .replace(/^\s*(表格|下载为表格|导出为图片)\s*$/gm, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          text = stripCssLeakText(text);
          text = stripThinking(text);
          const fileBlock = formatGeneratedFileCardsMarkdown(fileCards);
          if (fileBlock) {
            text = text ? `${text}\n\n${fileBlock}` : fileBlock;
          }
          return text;
        }

        function readAnswerFromWrap(wrap) {
          if (!wrap) return '';
          const clone = wrap.cloneNode(true);
          // 优先：仅拼接正式 markdown 正文块（排除思考区）
          const mds = Array.from(
            clone.querySelectorAll('.qk-markdown, [class*="qk-markdown"]')
          ).filter((el) => {
            if (
              el.closest(
                '[class*="deep_think"], [class*="deep-think"], [class*="DeepThink"], [class*="thinking"], [class*="ThinkBlock"], [data-content-type="think"]'
              )
            ) {
              return false;
            }
            const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (!t || t.length < 2) return false;
            if (isThinkingFragment(t) && t.length < 800) return false;
            return true;
          });
          if (mds.length) {
            const parts = mds
              .map((el) => htmlToMarkdown(el))
              .filter((t) => t && !(isThinkingFragment(t) && t.length < 800));
            if (parts.length) return stripThinking(parts.join('\n\n'));
          }
          return htmlToMarkdown(clone);
        }

        function extractDomPairs() {
          const qNodes = Array.from(
            document.querySelectorAll(
              '[class*="message-select-wrapper-question"], [class*="questionItem"], [class*="wrapper-question"], [data-role="user"]'
            )
          );
          const aWraps = Array.from(
            document.querySelectorAll(
              [
                '[class*="message-select-wrapper-answer"]',
                '[class*="messageSelectWrapperAnswer"]',
                '[class*="wrapper-answer"]'
              ].join(',')
            )
          );
          const users = [];
          for (const el of qNodes) {
            if (
              el.closest(
                '[class*="deep_think"], [class*="deep-think"], [class*="DeepThink"], nav, aside, header, footer'
              )
            ) {
              continue;
            }
            const t = (el.innerText || '').trim();
            if (t && t.length < 20000) users.push({ role: 'user', content: t });
          }
          const assistants = [];
          for (const wrap of aWraps) {
            const t = readAnswerFromWrap(wrap);
            if (t && t.length < 200000) assistants.push({ role: 'assistant', content: t });
          }
          return { users, assistants };
        }

        const state =
          window.__qianwenChatAPI?.sharedValues?.chatAPI?.state || null;
        const rounds = Array.isArray(state?.chatRounds) ? state.chatRounds : [];
        const sessionId = state?.currentSessionId || '';
        let messages = [];

        for (const round of rounds) {
          const questions = Array.isArray(round?.questions) ? round.questions : [];
          for (const q of questions) {
            const userText = extractUser(q);
            const ans = pickAnswer(q);
            const assistantText = extractAssistant(ans, q);

            if (userText) {
              messages.push({
                role: 'user',
                content: userText,
                timestamp: q?.createTime || q?.create_time || null
              });
            }
            if (assistantText) {
              messages.push({
                role: 'assistant',
                content: assistantText,
                timestamp: ans?.createTime || ans?.create_time || null
              });
            }
          }
        }

        // DOM 补缺；若状态里是纯文本而 DOM 含表格/粗体 Markdown，则用 DOM 保留格式
        {
          const dom = extractDomPairs();
          const users = messages.filter((m) => m.role === 'user');
          const asst = messages.filter((m) => m.role === 'assistant');
          const isJunkMsg = (m) => {
            if (!m?.content) return true;
            const s = String(m.content);
            return (
              /"gaokao_choice_report"|gaokao_choice_report|"zhiyuan_table"|"initialData"|"school_prob"|"reqId"/.test(
                s
              ) && (s.length > 120 || /^\s*[\{\[]/.test(s))
            );
          };
          const richer = (a, b) => {
            if (!a || isJunkMsg(a)) return b && !isJunkMsg(b) ? b : a || b;
            if (!b || isJunkMsg(b)) return a;
            // 永远优先明显更长的完整稿（但 JSON 卡片不算）
            if (b.content.length > a.content.length * 1.1) return b;
            if (a.content.length > b.content.length * 1.1) return a;
            const aMd = /\*\*|\n\|.+\|\n\|?\s*-{3,}/.test(a.content);
            const bMd = /\*\*|\n\|.+\|\n\|?\s*-{3,}/.test(b.content);
            if (!aMd && bMd && b.content.length >= a.content.length * 0.9) return b;
            if (aMd && !bMd && a.content.length < b.content.length * 0.9) return b;
            return a.content.length >= b.content.length ? a : b;
          };
          const mergedUsers = [];
          const mergedAsst = [];
          for (let i = 0; i < Math.max(users.length, dom.users.length); i++) {
            mergedUsers.push(richer(users[i], dom.users[i]));
          }
          for (let i = 0; i < Math.max(asst.length, dom.assistants.length); i++) {
            mergedAsst.push(richer(asst[i], dom.assistants[i]));
          }
          if (mergedUsers.length || mergedAsst.length) {
            const paired = [];
            const n = Math.max(mergedUsers.length, mergedAsst.length);
            for (let i = 0; i < n; i++) {
              if (mergedUsers[i]) paired.push(mergedUsers[i]);
              if (mergedAsst[i]) paired.push(mergedAsst[i]);
            }
            messages = paired;
          }
        }

        if (!messages.length) {
          const dom = extractDomPairs();
          const n = Math.max(dom.users.length, dom.assistants.length);
          for (let i = 0; i < n; i++) {
            if (dom.users[i]) messages.push(dom.users[i]);
            if (dom.assistants[i]) messages.push(dom.assistants[i]);
          }
        }

        messages = normalizeMessages(messages);

        return {
          sessionId: sessionId || null,
          isLogin: !!state?.isLogin,
          isGenerating: !!(state?.isGenerating || state?.isTyping),
          roundCount: rounds.length,
          messages,
          stats: {
            user: messages.filter((m) => m.role === 'user').length,
            assistant: messages.filter((m) => m.role === 'assistant').length
          }
        };
      }
    });

    if (result && typeof result === 'object') {
      return { ok: true, data: result };
    }
    return { ok: false, error: '页面状态为空' };
  } catch (err) {
    console.warn('[ACM] QIANWEN_READ_PAGE_STATE failed', err);
    return { ok: false, error: String(err?.message || err) };
  }
}

async function handleSaveConversation(data, auto = false) {
  if (!data || !data.messages?.length) {
    return { success: false, error: '没有可保存的对话内容' };
  }

  const existing = await getConversations();
  const sameSession =
    data.sessionId &&
    existing.find(
      (c) =>
        c.sessionId &&
        c.sessionId === data.sessionId &&
        (!data.platform || c.platform === data.platform)
    );
  // 同 URL 匹配：若新记录带 sessionId，则要求已有记录也有相同 sessionId，
  // 避免元宝多会话共用 /chat/agentId 时全部覆盖第一条
  let sameUrl = null;
  if (!sameSession && data.url) {
    sameUrl = existing.find((c) => {
      if (c.url !== data.url) return false;
      if (data.sessionId) {
        return c.sessionId === data.sessionId;
      }
      return !c.sessionId;
    });
  }
  const same = sameSession || sameUrl;

  // 自动保存：仅在已有同会话/同 URL 时更新；没有则新建
  if (auto && !same) {
    // fall through to add
  }

  if (same) {
    try {
      if (same.source === 'api' && data.source !== 'api') {
        notifySaved(same, auto);
        return {
          success: true,
          data: same,
          updated: false,
          keptApiSource: true,
          source: 'api'
        };
      }

      const messages = mergeMessages(
        same.messages || [],
        data.messages || [],
        data.platform || same.platform
      );
      const updated = await updateConversation(same.id, {
        messages,
        title: data.title || same.title,
        source: data.source || same.source || 'dom',
        url: data.url || same.url,
        sessionId: data.sessionId || same.sessionId || null
      });
      notifySaved(updated, auto);
      return {
        success: true,
        data: updated,
        updated: true,
        source: data.source || same.source || 'dom'
      };
    } catch (err) {
      return formatSaveError(err);
    }
  }

  try {
    const conversation = await addConversation(data);
    notifySaved(conversation, auto);
    return { success: true, data: conversation, source: data.source || 'dom' };
  } catch (err) {
    return formatSaveError(err);
  }
}

function formatSaveError(err) {
  if (err?.message === 'STORAGE_LIMIT_EXCEEDED') {
    return {
      success: false,
      error: '存储空间已达上限，请导出备份后清理，或在设置中切换为无上限模式'
    };
  }
  return { success: false, error: err?.message || '保存失败' };
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      setTimeout(resolve, 900);
    };

    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };

    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);

    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') finish();
    }).catch(() => finish());
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSupportedAiUrl(url = '') {
  return AI_HOST_HINTS.some((h) => url.includes(h));
}

function getInjectFilesForUrl(url = '') {
  const hit = CONTENT_SCRIPT_MAP.find((item) => item.test(url));
  return hit?.files || null;
}

async function collectCandidateTabIds(preferredId) {
  const ids = [];
  const push = (id) => {
    if (id && !ids.includes(id)) ids.push(id);
  };

  push(preferredId);

  try {
    const [last] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    push(last?.id);
  } catch {
    // ignore
  }

  try {
    const [cur] = await chrome.tabs.query({ active: true, currentWindow: true });
    push(cur?.id);
  } catch {
    // ignore
  }

  try {
    const all = await chrome.tabs.query({});
    // 优先豆包（用户最近常卡在这里），再其他 AI 页
    const sorted = [...all].sort((a, b) => {
      const score = (t) => {
        const u = t.url || '';
        if (/doubao\.com/i.test(u)) return 0;
        if (isSupportedAiUrl(u)) return 1;
        return 2;
      };
      return score(a) - score(b);
    });
    for (const t of sorted) {
      if (isSupportedAiUrl(t.url || '')) push(t.id);
    }
  } catch {
    // ignore
  }

  return ids;
}

async function tryParseTab(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: 'PARSE_CONVERSATION' });
}

async function ensureContentScript(tabId, url) {
  const hit = CONTENT_SCRIPT_MAP.find((item) => item.test(url));
  const files = hit?.files || null;
  if (!files || !chrome.scripting?.executeScript) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files
    });
    if (hit.mainWorldFiles?.length) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          files: hit.mainWorldFiles
        });
      } catch (mainErr) {
        console.warn('[ACM] MAIN inject failed', tabId, mainErr);
      }
    }
    await delay(120);
    return true;
  } catch (err) {
    console.warn('[ACM] inject failed', tabId, err);
    return false;
  }
}

async function handleSaveCurrentTab(tabId) {
  const candidates = await collectCandidateTabIds(tabId);
  if (!candidates.length) {
    return { success: false, error: '无法获取当前标签页' };
  }

  let sawSupportedUrl = false;
  let lastSupportedUrl = '';

  for (const id of candidates) {
    let tab;
    try {
      tab = await chrome.tabs.get(id);
    } catch {
      continue;
    }
    const url = tab.url || '';
    if (isSupportedAiUrl(url)) {
      sawSupportedUrl = true;
      lastSupportedUrl = url;
    }

    try {
      const response = await tryParseTab(id);
      if (response?.success) return handleSaveConversation(response.data);
      if (response && response.success === false) {
        return { success: false, error: response.error || '解析对话失败' };
      }
    } catch {
      // 扩展重载后旧标签未注入：尝试动态注入再解析
      if (isSupportedAiUrl(url)) {
        const injected = await ensureContentScript(id, url);
        if (injected) {
          try {
            const response = await tryParseTab(id);
            if (response?.success) return handleSaveConversation(response.data);
            if (response && response.success === false) {
              return { success: false, error: response.error || '解析对话失败' };
            }
          } catch {
            // continue
          }
        }
      }
    }
  }

  if (sawSupportedUrl) {
    return {
      success: false,
      error: `已检测到 AI 页面但扩展未生效，请刷新该标签页（F5）后再点「保存本轮」。地址：${lastSupportedUrl.slice(0, 80)}`
    };
  }

  return {
    success: false,
    error: '当前没有可用的 AI 平台标签页。请先打开豆包/千问等对话页，点一下该标签使其前置，再保存'
  };
}

function notifySaved(conversation, auto = false) {
  chrome.runtime.sendMessage({
    type: 'CONVERSATION_SAVED',
    data: conversation,
    auto: !!auto
  }).catch(() => {});
}

async function handleSaveFolder(folder) {
  const folders = await getFolders();
  if (folder.id) {
    const idx = folders.findIndex((f) => f.id === folder.id);
    if (idx >= 0) folders[idx] = { ...folders[idx], ...folder };
  } else {
    folders.push({
      id: crypto.randomUUID(),
      name: folder.name,
      keywords: folder.keywords?.length ? folder.keywords : [folder.name],
      createdAt: new Date().toISOString(),
      order: folders.length
    });
  }
  await saveFolders(folders);
  return { success: true, data: folders };
}

async function handleDeleteFolder(id) {
  const folders = await getFolders();
  await saveFolders(folders.filter((f) => f.id !== id));
  const conversations = await getConversations();
  for (const c of conversations) {
    if (c.folderId === id) {
      await updateConversation(c.id, { folderId: null });
    }
  }
  return { success: true };
}

async function handleExport(message) {
  const { format, ids } = message;

  try {
    const timestamp = new Date().toISOString().slice(0, 10);

    if (format === 'json') {
      const data = await exportAllData();
      await downloadFile(
        JSON.stringify(data, null, 2),
        `ai-chat-backup-${timestamp}.json`,
        'application/json'
      );
      return { success: true };
    }

    const list = ids?.length
      ? (await Promise.all(ids.map((id) => getConversationById(id)))).filter(Boolean)
      : await getConversations();

    if (!list.length) return { success: false, error: '没有可导出的对话' };

    if (format === 'markdown') {
      const md = list.map(conversationToMarkdown).join('\n\n---\n\n');
      await downloadFile(md, `ai-chat-export-${timestamp}.md`, 'text/markdown');
      return { success: true };
    }

    if (format === 'html') {
      const html = list.map(conversationToHtml).join('\n<hr/>\n');
      await downloadFile(html, `ai-chat-export-${timestamp}.html`, 'text/html');
      return { success: true };
    }

    return { success: false, error: '不支持的导出格式' };
  } catch (err) {
    return { success: false, error: err.message || '导出失败' };
  }
}

async function handleImport(message) {
  try {
    const result = await importAllData(message.data, message.mode || 'merge');
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message || '导入失败' };
  }
}

async function handleOpenOriginalConversation(message) {
  const { url, content, userIndex } = message;
  if (!url) return { success: false, error: '没有原始链接' };

  const tab = await chrome.tabs.create({ url, active: true });
  await waitForTabComplete(tab.id);

  for (let i = 0; i < 8; i++) {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, {
        type: 'SCROLL_TO_USER_MESSAGE',
        content: content || '',
        userIndex: userIndex || 0
      });
      if (result?.success) return result;
    } catch {
      // content script may not be ready
    }
    await delay(500);
  }

  return { success: true, warning: '页面已打开，但未能自动定位到提问' };
}
