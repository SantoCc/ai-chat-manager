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
  setupUninstallReminder();
});

chrome.runtime.onStartup.addListener(() => {
  setupUninstallReminder();
});

/** 卸载后打开说明页（浏览器无法在点「移除」前弹出拦截框） */
function setupUninstallReminder() {
  const url = 'https://github.com/SantoCc/ai-chat-manager/blob/main/UNINSTALL.md';
  try {
    chrome.runtime.setUninstallURL(url, () => {
      const err = chrome.runtime.lastError;
      if (err) console.warn('[ACM] setUninstallURL failed:', err.message);
    });
  } catch (e) {
    console.warn('[ACM] setUninstallURL error:', e);
  }
}

// 启动时也设置一次（扩展重载后生效）
setupUninstallReminder();

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
          if (/deep.?think|think|planning|ppt|aippt|wanx|quark|search|gaokao|zhiyuan|report|plugin|recommend|reference|knowledge/i.test(card)) {
            return true;
          }
          if (/deep.?think|think|planning|search|gaokao|zhiyuan|report|recommend|reference|quark/i.test(plugin)) {
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
              // 跳过推荐卡标题墙碎片
              if (
                (s.match(/#/g) || []).length >= 2 &&
                s.length < 240
              ) {
                return;
              }
              if (/bili_\w+/i.test(s) && s.length < 200) return;
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
          // 版式优先，其次长度；避免卡片标题墙靠「更长」抢赢
          let best = '';
          let bestScore = -99999;
          for (const c of candidates) {
            const t = stripCardSoupText(stripThinking(extractText(c)));
            if (!t) continue;
            const score = structureScore(t) * 1000 + Math.min(t.length, 8000);
            if (score > bestScore) {
              best = t;
              bestScore = score;
            }
          }
          return stripCardSoupText(best);
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
          s = stripStructuredJson(s);
          if (!s) return '';
          // 只删思考壳行，禁止 slice 裁到「1.」——会截断正常开场白
          s = s.replace(/^(?:已完成思考|Finished thinking)[^\n]*\n+/i, '');
          s = s.replace(/^参考了\s*\d+\s*篇材料[^\n]*\n+/i, '');
          return stripStructuredJson(
            s
              .split('\n')
              .filter((line, idx) => {
                const t = line.replace(/\s+/g, '').trim();
                if (!t) return true;
                if (
                  /^(已完成思考|Finishedthinking|参考了\d+篇材料|表格|下载为表格|导出为图片)$/i.test(
                    t
                  )
                ) {
                  return false;
                }
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
              content = stripCardSoupText(content);
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
              // 版式优先，禁止更长的卡墙盖掉带换行正文
              const a = prev.content;
              const b = content;
              const sa = structureScore(a);
              const sb = structureScore(b);
              if (sb > sa + 2) prev.content = b;
              else if (sa > sb + 2) {
                /* keep a */
              } else if (looksLikeCardSoup(a) && !looksLikeCardSoup(b)) prev.content = b;
              else if (!looksLikeCardSoup(a) && looksLikeCardSoup(b)) {
                /* keep a */
              } else if (b.length > a.length) prev.content = b;
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
                '[class*="card_card_gaokao"]',
                '[class*="file-card"]',
                '[class*="FileCard"]',
                '[class*="fileCard"]',
                '[class*="attachment-card"]',
                '[class*="doc-card"]',
                '[class*="DocCard"]',
                '[class*="file-item"]',
                '[class*="FileItem"]',
                '[class*="artifact"]',
                '[class*="Artifact"]',
                '[class*="writing-card"]',
                '[class*="WritingCard"]',
                '[data-testid*="file_card"]',
                '[data-testid*="attachment_card"]'
              ].join(',')
            )
          );
          const pickHttp = (cands) => {
            for (const u of cands) {
              const s = String(u || '').trim();
              if (/^(https?:|data:image\/)/i.test(s)) return s;
            }
            return '';
          };
          const resolveImgUrl = (img) => {
            if (!img) return '';
            let url = pickHttp([
              img.currentSrc,
              img.src,
              img.getAttribute?.('src'),
              img.getAttribute?.('data-src'),
              img.getAttribute?.('data-original'),
              img.getAttribute?.('data-url')
            ]);
            if (url) return url;
            const srcset = img.getAttribute?.('srcset') || '';
            const m = srcset.match(/(https?:[^\\\s,]+)/i);
            return m ? m[1].trim() : '';
          };
          root.querySelectorAll('div, section, article, a, li, span').forEach((el) => {
            if (!el || nodes.includes(el)) return;
            const raw = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (!raw || raw.length < 4 || raw.length > 180) return;
            if (
              /文件名\s*[：:]\s*\S+\.(?:docx?|pdf|xlsx?|pptx?|zip|png|jpe?g)/i.test(raw) ||
              /(?:创建时间|创建于|生成时间|生成于)\s*[:：]?\s*[\d/]/i.test(raw) ||
              /大纲\s*\|/.test(raw) ||
              /(?:Word|PPT|Excel|PDF|文档|表格).{0,12}已生成完毕|可直接下载使用/i.test(raw)
            ) {
              if (el.querySelector?.('pre, table, h1, h2, h3')) return;
              nodes.push(el);
            }
          });
          const cards = [];
          const seen = new Set();
          const pushCard = (c) => {
            const key = `${c.type}::${c.url || ''}::${c.title || ''}`;
            if (seen.has(key)) return;
            if (c.url && seen.has('url::' + c.url)) return;
            seen.add(key);
            if (c.url) seen.add('url::' + c.url);
            cards.push(c);
          };
          root.querySelectorAll('img').forEach((img) => {
            if (
              img.closest?.(
                '[class*="recommend"], [class*="Recommend"], [class*="swiper"], [class*="quark"], [class*="paa"]'
              )
            ) {
              return;
            }
            const src = resolveImgUrl(img);
            if (!src) return;
            const w = Number(img.naturalWidth || img.width || img.getAttribute('width') || 0);
            const h = Number(img.naturalHeight || img.height || img.getAttribute('height') || 0);
            if ((w > 0 && w < 64) || (h > 0 && h < 64)) return;
            if (/icon|avatar|emoji|logo|spinner|loading/i.test(`${img.className || ''} ${src}`)) {
              return;
            }
            pushCard({
              kind: 'file',
              type: 'image',
              title: ((img.alt || '图片').trim() || '图片').slice(0, 80),
              generatedAt: '',
              url: src
            });
          });
          for (const el of nodes) {
            if (nodes.some((o) => o !== el && o.contains(el))) continue;
            const raw = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (!raw || raw.length > 500) continue;
            let title = '生成文件';
            const fileNameMatch = raw.match(
              /文件名\s*[：:]\s*([^\s]+?\.(?:docx?|pdf|xlsx?|pptx?|zip|txt|csv|png|jpe?g|gif|webp))/i
            );
            if (fileNameMatch) title = fileNameMatch[1].trim();
            else if (/Word/i.test(raw)) title = 'Word 文档';
            else if (/PPT|幻灯/i.test(raw)) title = 'PPT';
            else {
              const titleMatch = raw.match(/志愿报告\s*[\d\-—_]+|志愿报告/);
              if (titleMatch) title = titleMatch[0].trim();
              else if (/PPT|幻灯片/i.test(raw)) title = raw.slice(0, 40);
              else if (/报告|文档|文件|大纲/.test(raw)) title = raw.slice(0, 40);
            }
            let generatedAt = '';
            const timeMatch =
              raw.match(/(?:Generated on|生成于|生成时间|创建时间|创建于)[:\s：]*([\d/\-.\s:]+)/i) ||
              raw.match(/(\d{2}-\d{2}\s+\d{2}:\d{2})/) ||
              raw.match(/(20\d{2}-\d{2}-\d{2}[^\d]*\d{0,2}:?\d{0,2})/);
            if (timeMatch) generatedAt = timeMatch[1].trim();
            const imgUrl = resolveImgUrl(el.querySelector?.('img'));
            let type = /志愿|gaokao|zhiyuan/i.test(title + raw)
              ? 'gaokao_zhiyuan_report'
              : /PPT|幻灯/i.test(title + raw)
                ? 'presentation'
                : /文档|doc|pdf|Word|已生成完毕|大纲|报告/i.test(title + raw)
                  ? 'document'
                  : imgUrl
                    ? 'image'
                    : 'generated_file';
            pushCard({
              kind: 'file',
              type,
              title: String(title).slice(0, 80),
              generatedAt,
              url: imgUrl || ''
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
                title: c.title || (/image/i.test(c.type || '') ? '图片' : '生成文件'),
                generatedAt: c.generatedAt || '',
                url: c.url || ''
              };
              return [
                `@@ACM_FILE:${JSON.stringify(meta)}@@`,
                meta.type === 'image' ? '' : `📎 **${meta.title}**`,
                meta.type === 'image' ? '' : meta.generatedAt ? `生成时间：${meta.generatedAt}` : '',
                meta.type === 'image'
                  ? ''
                  : '（交互式文件请点击「原始对话」在千问中打开查看）'
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

        function structureScore(text) {
          // 先清推荐卡墙，再评版式（否则卡片标题换行会伪装高分）
          const cleaned = stripCardSoupText(String(text || ''));
          const body = cleaned
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
          {
            const flat = body.replace(/\s+/g, '');
            if (
              (/表格下载为表格|导出为图片/.test(flat) && !/\|/.test(body)) ||
              (/章节内容摘要|章节内容一、/.test(flat) && !/\|/.test(body))
            ) {
              score -= 80;
            }
          }
          if (!/\n/.test(body) && body.length > 160) score -= 60;
          if (/bili_\w+/i.test(String(text || '')) || (String(text || '').match(/#/g) || []).length >= 3) {
            score -= 80;
          }
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

        function looksLikeCardSoup(text) {
          const t = String(text || '');
          if (/bili_\w+/i.test(t)) return true;
          if ((t.match(/#/g) || []).length >= 3) return true;
          if (
            /高情商爸爸|成长情绪|财经速记|心灵成长|彩虹情绪|合格爸爸如何陪伴|怎样提供情绪价值/i.test(
              t
            ) &&
            (/#/.test(t) || /bili_/i.test(t) || t.length < 280)
          ) {
            return true;
          }
          return false;
        }

        function stripCardSoupText(text) {
          let s = String(text || '');
          if (!s) return '';
          s = s.replace(/(?:[^\n#]{0,40}#[\u4e00-\u9fffA-Za-z0-9_]{2,24}){2,}/g, '\n');
          s = s.replace(/\d{2}:\d{2}[^\n]{0,60}bili_\w+/gi, '');
          s = s.replace(/bili_\w+/gi, '');
          // 文末推荐卡墙
          {
            const isCardLine = (line) => {
              const t = String(line || '').trim();
              if (!t || t.length > 60) return false;
              if (/^(\d+\.|[-*+]|#{1,6}|\|)/.test(t)) return false;
              if (/你现在是遇到了|如果愿意|可以说说看|我们一起探讨|最后，请给自己/.test(t)) return false;
              if (/[。！]/.test(t) && t.length > 28) return false;
              if (
                /秒懂：|直击心灵|想做个好父母|如何做赋能型父母|父母核心准则|做个好父母|情感能量棒|恋爱能量收集|豆豆妈|营薛|心灵拓印|育儿分享/i.test(
                  t
                )
              ) {
                return true;
              }
              if (t.length <= 40 && /[：:]/.test(t) && !/文件名|生成时间/.test(t)) return true;
              if (t.length <= 36 && /[?？]{1,3}$/.test(t)) return true;
              if (
                t.length >= 3 &&
                t.length <= 14 &&
                !/[，,。；;：:？?！!\s]/.test(t) &&
                /^[\u4e00-\u9fffA-Za-z0-9]+$/.test(t)
              ) {
                return true;
              }
              return false;
            };
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
              if (isCardLine(t)) {
                streak += 1;
                if (
                  /秒懂：|直击心灵|赋能型|父母核心|情感能量|恋爱能量|豆豆妈|营薛|[：:]|[?？]{1,3}$/.test(t)
                ) {
                  strongHits += 1;
                }
                cut = i;
                continue;
              }
              break;
            }
            if (streak >= 3 || (streak >= 2 && strongHits >= 1)) {
              s = lines.slice(0, cut).join('\n');
            }
          }
          const lines = s.split(/\n+/);
          const kept = lines.filter((line) => {
            const t = line.trim();
            if (!t) return false;
            const hashCount = (t.match(/#/g) || []).length;
            if (hashCount >= 2 && t.length < 240) return false;
            if (
              /成长情绪|财经速记|心灵成长|彩虹情绪|合格爸爸如何陪伴|高情商爸爸|情感能量棒|恋爱能量收集站|豆豆妈育儿分享|营薛心灵拓印集/i.test(
                t
              ) &&
              t.length < 220
            ) {
              return false;
            }
            if (
              /^(秒懂：|直击心灵|想做个好父母|如何做赋能型父母|父母核心准则|做个好父母)/.test(t) &&
              t.length < 50
            ) {
              return false;
            }
            if (/\d{2}:\d{2}/.test(t) && t.length < 80) return false;
            if (t.length <= 16 && /室|店|盘|记$/.test(t)) return false;
            return true;
          });
          return ensureParagraphBreaks(kept.join('\n\n').replace(/\n{3,}/g, '\n\n').trim());
        }

        function ensureParagraphBreaks(text) {
          // 禁止按句号发明换行（会改写 AI 原文）；格式只信 DOM/Markdown
          return String(text || '').trim();
        }

        function pullMediaCardsFromRoot(root) {
          // 只剔除推荐墙；正文图留给后续 ![ ]() 转换
          const remove = new Set();
          const cardSel = [
            '[class*="swiper-slide"]',
            '[class*="recommend"]',
            '[class*="Recommend"]',
            '[class*="knowledge"]',
            '[class*="Knowledge"]',
            '[class*="reference"]',
            '[class*="Reference"]',
            '[class*="media-card"]',
            '[class*="MediaCard"]',
            '[class*="quark"]',
            '[class*="Quark"]',
            '[class*="pc-card"]',
            '[class*="PcCard"]',
            '[data-testid*="card"]'
          ].join(',');

          root.querySelectorAll(cardSel).forEach((el) => {
            if (el.querySelector?.('table, [role="table"]')) return;
            const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (t.length > 400 && !/#/.test(t) && !/bili_/i.test(t)) return;
            remove.add(el);
          });

          remove.forEach((el) => {
            try {
              el.remove();
            } catch (e) {}
          });
          root
            .querySelectorAll(
              '[class*="swiper"],[class*="carousel"],[class*="recommend"],[class*="quark"]'
            )
            .forEach((el) => {
              if (el.querySelector('table, pre, #qk-markdown-react, [class*="qk-markdown"]')) return;
              const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
              if (!t || (t.length < 500 && (/#/.test(t) || /bili_/i.test(t)))) {
                try {
                  el.remove();
                } catch (e) {}
              }
            });
          return [];
        }

        function htmlToMarkdown(element) {
          if (!element) return '';
          const clone = element.cloneNode(true);
          // 挂载后再读 innerText，保留 CSS 换行
          const host = document.createElement('div');
          host.style.cssText =
            'position:fixed;left:-10000px;top:0;width:720px;opacity:0;pointer-events:none;z-index:-1;';
          host.appendChild(clone);
          document.body.appendChild(host);
          try {
            // 推荐卡只剔除节点，不写入正文；志愿报告等生成文件仍保留
            pullMediaCardsFromRoot(clone);
            clone
              .querySelectorAll('style, script, noscript, link[rel="stylesheet"], template')
              .forEach((el) => el.remove());
            const fileCards = extractGeneratedFileCardsFromDom(clone);
            // 内容图先转 Markdown
            clone.querySelectorAll('img').forEach((img) => {
              const src = (img.currentSrc || img.src || img.getAttribute('src') || '').trim();
              const alt = (img.alt || '图片').trim() || '图片';
              const w = Number(img.naturalWidth || img.width || 0);
              const h = Number(img.naturalHeight || img.height || 0);
              if (
                /^(https?:|data:image\/)/i.test(src) &&
                !((w > 0 && w < 40) || (h > 0 && h < 40)) &&
                !/icon|avatar|emoji|logo/i.test((img.className || '') + src)
              ) {
                img.replaceWith(document.createTextNode('\n\n![' + alt + '](' + src + ')\n\n'));
              } else {
                img.remove();
              }
            });
            // 表格必须先于 download/export 清理，否则整表可能被误删后只剩工具条文案
            clone.querySelectorAll('table').forEach((table) => {
              const md = tableToMarkdown(table);
              table.replaceWith(document.createTextNode(md ? `\n\n${md}\n\n` : ''));
            });
            clone
              .querySelectorAll(
                [
                  'button',
                  'svg',
                  'video',
                  'audio',
                  'iframe',
                  '[aria-hidden="true"]',
                  '[class*="toolbar"]',
                  '[class*="Toolbar"]',
                  '[class*="table-action"]',
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
              .forEach((el) => {
                if (el.querySelector?.('table, tr, td, th')) return;
                el.remove();
              });
            // download/export：仅短工具条
            clone
              .querySelectorAll('[class*="export"], [class*="Export"], [class*="download"], [class*="Download"]')
              .forEach((el) => {
                if (el.querySelector?.('table, tr, td, th')) return;
                const t = (el.innerText || '').replace(/\s+/g, '').trim();
                if (!t || t.length < 40 || /^(表格|下载为表格|导出为图片|复制|分享)/.test(t)) {
                  el.remove();
                }
              });
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
            // 注意：table 已在上方转换，此处不再重复
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
              let body = (li.innerText || '').trim();
              if (!body) {
                li.remove();
                return;
              }
              if (ordered) {
                if (!/^\d+\.\s+/.test(body)) {
                  const val = Number(li.getAttribute('value'));
                  const start = Number(parent.getAttribute('start')) || 1;
                  const idx =
                    Array.from(parent.children).filter((c) => c.tagName === 'LI').indexOf(li) + 1;
                  const n = Number.isFinite(val) && val > 0 ? val : start + idx - 1;
                  body = n + '. ' + body;
                }
              } else if (!/^[-*+]\s+/.test(body)) {
                body = '- ' + body;
              }
              li.replaceWith(document.createTextNode(body + '\n'));
            });
            clone.querySelectorAll('br').forEach((br) => {
              br.replaceWith(document.createTextNode('\n'));
            });
            // 块级 span：千问「一句一段」常用
            clone.querySelectorAll('span, [class*="paragraph"], [class*="Paragraph"]').forEach((el) => {
              if (!el?.parentNode) return;
              if (el.querySelector('p, div, table, pre, ul, ol, h1, h2, h3, h4, h5, h6, br')) return;
              let blockish = /paragraph|Paragraph|para|block/i.test(String(el.className || ''));
              if (!blockish) {
                try {
                  const d = getComputedStyle(el).display;
                  blockish = d === 'block' || d === 'flex' || d === 'grid' || d === 'list-item';
                } catch (e) {
                  blockish = false;
                }
              }
              if (!blockish) return;
              const text = (el.innerText || '').trim();
              if (text && text.length >= 2) {
                el.replaceWith(document.createTextNode(text + '\n\n'));
              }
            });
            // 叶子块强制换行（千问大量用 div 排版）
            clone.querySelectorAll('p, div, section, article').forEach((p) => {
              if (p.querySelector('p, div, table, pre, ul, ol, h1, h2, h3, h4, h5, h6')) return;
              const text = (p.innerText || '').trim();
              if (text) p.replaceWith(document.createTextNode(text + '\n\n'));
            });
            // 多子节点兜底：按块拼接
            if (clone.children && clone.children.length >= 2) {
              const parts = [];
              Array.from(clone.childNodes).forEach((node) => {
                if (node.nodeType === 3) {
                  const t = String(node.textContent || '').trim();
                  if (t) parts.push(t);
                } else if (node.nodeType === 1) {
                  const t = (node.innerText || node.textContent || '').trim();
                  if (t) parts.push(t);
                }
              });
              if (parts.length >= 2) {
                const joined = parts.join('\n\n');
                const cur = (clone.innerText || '').trim();
                if ((joined.match(/\n/g) || []).length > (cur.match(/\n/g) || []).length) {
                  clone.textContent = '';
                  clone.appendChild(document.createTextNode(joined));
                }
              }
            }
            let text = (clone.innerText || clone.textContent || '').trim();
            text = text
              .replace(/表格下载为表格/g, '')
              .replace(/导出为图片/g, '')
              .replace(/^\s*(表格|下载为表格|导出为图片)\s*$/gm, '')
              .replace(/\n{3,}/g, '\n\n')
              .trim();
            text = stripCssLeakText(text);
            text = stripThinking(text);
            text = stripCardSoupText(text);
            text = repairBrokenMarkdown(text);
            // 仅当正文几乎无版式时才用 HTML-DOM 兜底；残缺 ** 一律不用
            const viaHtml = simpleHtmlToMarkdown(element.innerHTML || '');
            if (!isBrokenMarkdown(viaHtml) && structureScore(text) < 8) {
              text = pickRicherMarkdown(text, stripCardSoupText(stripThinking(viaHtml)));
            }
            text = fixOrderedListMarkdown(repairBrokenMarkdown(text));
            const fileBlock = formatGeneratedFileCardsMarkdown(fileCards);
            if (fileBlock && !/@@ACM_FILE:/.test(text)) {
              text = text ? `${text}\n\n${fileBlock}` : fileBlock;
            } else if (fileBlock && fileCards.length) {
              for (const c of fileCards) {
                if (c.url && text.includes(c.url)) continue;
                if (c.title && text.includes('"title":' + JSON.stringify(c.title))) continue;
                const one = formatGeneratedFileCardsMarkdown([c]);
                if (one) text = text ? `${text}\n\n${one}` : one;
              }
            }
            // Markdown 图 → 统一卡片
            text = String(text || '').replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, (_, alt, url) => {
              const u = String(url || '').trim();
              if (!u || /bili_|quark|recommend|icon|avatar/i.test(`${alt} ${u}`)) return '';
              if (text.includes('"url":"' + u + '"')) return '';
              const meta = {
                kind: 'file',
                type: 'image',
                title: String(alt || '图片').trim().slice(0, 80) || '图片',
                generatedAt: '',
                url: u
              };
              return '\n@@ACM_FILE:' + JSON.stringify(meta) + '@@\n';
            });
            // 「文件名：xxx.docx」/「已生成完毕」提升为文件卡
            text = String(text || '').replace(
              /(^|\n)\s*文件名\s*[：:]\s*([^\n]+?\.(?:docx?|pdf|xlsx?|pptx?|zip|txt|csv|md|png|jpe?g|gif|webp))\s*(?=\n|$)/gi,
              (_, lead, name) => {
                const title = String(name || '').trim();
                if (!title) return _;
                const isImage = /\.(png|jpe?g|gif|webp)$/i.test(title);
                const meta = {
                  kind: 'file',
                  type: isImage ? 'image' : 'document',
                  title,
                  generatedAt: '',
                  url: ''
                };
                return (
                  lead +
                  '\n@@ACM_FILE:' +
                  JSON.stringify(meta) +
                  '@@\n📎 **' +
                  title +
                  '**\n（交互式文件请在原对话中打开查看）\n'
                );
              }
            );
            text = String(text || '').replace(
              /(^|\n)([^\n]{0,100}?(?:Word\s*)?(?:PPT\s*)?(?:文档|表格|幻灯片)?已生成完毕[^\n]{0,50})(?=\n|$)/gi,
              (full, lead, line) => {
                const t = String(line || '').trim();
                if (!t) return full;
                let type = 'document';
                let title = '生成文档';
                if (/PPT|幻灯/i.test(t)) {
                  type = 'presentation';
                  title = 'PPT';
                } else if (/Word/i.test(t)) title = 'Word 文档';
                if (text.includes('"title":' + JSON.stringify(title))) return lead + t;
                const meta = { kind: 'file', type, title, generatedAt: '', url: '' };
                return (
                  lead +
                  t +
                  '\n@@ACM_FILE:' +
                  JSON.stringify(meta) +
                  '@@\n📎 **' +
                  title +
                  '**\n（交互式文件请在原对话中打开查看）\n'
                );
              }
            );
            return text.replace(/\n{3,}/g, '\n\n').trim();
          } finally {
            try {
              host.remove();
            } catch (e) {}
          }
        }

        function isBrokenMarkdown(text) {
          const t = String(text || '');
          if (!t) return true;
          if (/^\s*\*\*\s*$/m.test(t)) return true;
          if (/\*\*[ \t]*\r?\n[ \t]*\*\*/.test(t)) return true;
          if (/\*\*[ \t]*\r?\n+[ \t]*[^*\n][^\n]*\r?\n+[ \t]*\*\*/.test(t)) return true;
          if (/^[-*•]\s*\*\*\s*$/m.test(t)) return true;
          const marks = (t.match(/\*\*/g) || []).length;
          const pairs = (t.match(/\*\*[^*\n]+\*\*/g) || []).length;
          if (marks >= 4 && pairs === 0) return true;
          return false;
        }

        function repairBrokenMarkdown(text) {
          let s = String(text || '');
          if (!s) return '';
          s = s.replace(/\*\*[ \t]*\r?\n+[ \t]*([^*\n][^\n]*)\r?\n+[ \t]*\*\*/g, '**$1**');
          s = s.replace(/^[ \t]*\*\*[ \t]*$/gm, '');
          s = s.replace(/^([-*+]|\d+\.)\s*\*\*[ \t]*$/gm, '$1 ');
          return s.replace(/\n{3,}/g, '\n\n').trim();
        }

        function simpleHtmlToMarkdown(html) {
          const raw = String(html || '');
          if (!raw || !/<\/?[a-z]/i.test(raw)) return '';
          try {
            const wrap = document.createElement('div');
            wrap.innerHTML = raw;
            wrap.querySelectorAll('style, script, noscript, template').forEach((el) => el.remove());
            wrap.querySelectorAll('table').forEach((table) => {
              const md = tableToMarkdown(table);
              table.replaceWith(document.createTextNode(md ? `\n\n${md}\n\n` : ''));
            });
            wrap.querySelectorAll('strong, b').forEach((el) => {
              const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
              if (text) el.replaceWith(document.createTextNode('**' + text + '**'));
              else el.remove();
            });
            wrap.querySelectorAll('em, i').forEach((el) => {
              const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
              if (text) el.replaceWith(document.createTextNode('*' + text + '*'));
              else el.remove();
            });
            wrap.querySelectorAll('br').forEach((br) => {
              br.replaceWith(document.createTextNode('\n'));
            });
            let guard = 0;
            while (guard++ < 24) {
              const lists = Array.from(wrap.querySelectorAll('ol, ul')).filter(
                (list) => !list.querySelector('ol, ul')
              );
              if (!lists.length) break;
              for (const list of lists) {
                const ordered = list.tagName === 'OL';
                const items = Array.from(list.children).filter((c) => c.tagName === 'LI');
                const lines = items
                  .map((li, idx) => {
                    let body = (li.innerText || li.textContent || '')
                      .replace(/\n{3,}/g, '\n\n')
                      .trim();
                    if (!body) return '';
                    if (ordered) {
                      if (/^\d+\.\s+/.test(body)) return body;
                      const val = Number(li.getAttribute('value'));
                      const start = Number(list.getAttribute('start')) || 1;
                      const n = Number.isFinite(val) && val > 0 ? val : start + idx;
                      return n + '. ' + body;
                    }
                    return '- ' + body;
                  })
                  .filter(Boolean);
                list.replaceWith(
                  document.createTextNode(lines.length ? '\n\n' + lines.join('\n') + '\n\n' : '')
                );
              }
            }
            wrap.querySelectorAll('p, div, section, article').forEach((p) => {
              if (p.querySelector('p, div, table, pre, ul, ol, h1, h2, h3, h4, h5, h6')) return;
              const text = (p.innerText || p.textContent || '').trim();
              if (text) p.replaceWith(document.createTextNode(text + '\n\n'));
            });
            let text = (wrap.innerText || wrap.textContent || '')
              .replace(/\n{3,}/g, '\n\n')
              .trim();
            return fixOrderedListMarkdown(repairBrokenMarkdown(text));
          } catch (e) {
            return '';
          }
        }

        function fixOrderedListMarkdown(text) {
          let s = String(text || '');
          if (!s) return '';
          s = s.replace(/(^|\n)(\d+\.\s+[^\n]+)\n{2,}(?=\d+\.\s+)/gm, '$1$2\n');
          const lines = s.split('\n');
          const numberedIdx = [];
          for (let i = 0; i < lines.length; i++) {
            if (/^\d+\.\s+/.test(lines[i])) numberedIdx.push(i);
          }
          if (numberedIdx.length >= 2) {
            const nums = numberedIdx.map((i) => Number(lines[i].match(/^(\d+)\./)[1]));
            const ones = nums.filter((n) => n === 1).length;
            if (ones === nums.length || ones >= Math.max(2, Math.ceil(nums.length * 0.5))) {
              let n = 1;
              for (const i of numberedIdx) {
                lines[i] = lines[i].replace(/^\d+\./, n + '.');
                n += 1;
              }
            }
          }
          return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
        }

        function pickRicherMarkdown(a, b) {
          const x = repairBrokenMarkdown(String(a || '').trim());
          const y = repairBrokenMarkdown(String(b || '').trim());
          if (!x) return y;
          if (!y) return x;
          if (isBrokenMarkdown(x) && !isBrokenMarkdown(y)) return y;
          if (isBrokenMarkdown(y) && !isBrokenMarkdown(x)) return x;
          const xHeads = (x.match(/^\d+\.\s+/gm) || []).length;
          const yHeads = (y.match(/^\d+\.\s+/gm) || []).length;
          if (xHeads >= 2 && yHeads === 0) return x;
          if (yHeads >= 2 && xHeads === 0) return y;
          const sx = structureScore(x);
          const sy = structureScore(y);
          if (sy > sx + 2) return y;
          if (sx > sy + 2) return x;
          return x.length >= y.length ? x : y;
        }

        function readAnswerFromWrap(wrap) {
          if (!wrap) return '';
          const clone = wrap.cloneNode(true);
          // 推荐卡只剔除，不落库
          pullMediaCardsFromRoot(clone);
          const mdSel = [
            '#qk-markdown-react',
            '[id*="qk-markdown"]',
            '.qk-markdown',
            '[class*="qk-markdown"]',
            '[class*="qwen-markdown"]',
            '[class*="custom-qwen-markdown"]',
            '[class*="phase-answer"]'
          ].join(',');
          const mds = Array.from(clone.querySelectorAll(mdSel)).filter((el) => {
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
          let text = '';
          if (mds.length) {
            const parts = mds
              .map((el) => htmlToMarkdown(el))
              .filter((t) => t && !(isThinkingFragment(t) && t.length < 800));
            if (parts.length) text = stripThinking(parts.join('\n\n'));
          }
          if (!text) text = htmlToMarkdown(clone);
          text = stripCardSoupText(text);
          return text;
        }

        function extractDomPairs() {
          const qNodes = Array.from(
            document.querySelectorAll(
              [
                '[data-chat-question-wrap]',
                '[class*="message-select-wrapper-question"]',
                '[class*="questionItem"]',
                '[class*="wrapper-question"]',
                '[class*="question-text-card"]',
                '[data-role="user"]'
              ].join(',')
            )
          );
          const aWraps = Array.from(
            document.querySelectorAll(
              [
                '[data-chat-answers-wrap]',
                '[class*="message-select-wrapper-answer"]',
                '[class*="messageSelectWrapperAnswer"]',
                '[class*="wrapper-answer"]',
                '[class*="answer-common-card"]',
                '[class*="qwen-chat-message-assistant"]',
                '[class*="chat-response-message"]'
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
            // a = page-state，b = DOM（页面可见版式）
            if (!a || isJunkMsg(a)) return b && !isJunkMsg(b) ? b : a || b;
            if (!b || isJunkMsg(b)) return a;
            const pullMedia = (c) =>
              (String(c || '').match(/@@ACM_FILE:\{[\s\S]*?\}@@[\s\S]*?(?=\n\n@@ACM_FILE:|$)/g) || [])
                .filter((block) => {
                  try {
                    const raw = block.match(/@@ACM_FILE:(\{[\s\S]*?\})@@/);
                    const meta = raw ? JSON.parse(raw[1]) : null;
                    if (!meta) return false;
                    // 推荐图/视频卡不合并；正文图与文档保留
                    const hint = `${meta.type || ''} ${meta.title || ''} ${meta.url || ''}`;
                    if (/bili_|quark|recommend|reference|#成长|#情绪/i.test(hint)) return false;
                    return true;
                  } catch (e) {
                    return false;
                  }
                })
                .join('\n\n')
                .trim();
            const stripMedia = (c) =>
              String(c || '')
                .replace(/@@ACM_FILE:\{[\s\S]*?\}@@[\s\S]*?(?=\n\n@@ACM_FILE:|$)/g, '')
                .trim();
            const aRaw = String(a.content || '');
            const bRaw = String(b.content || '');
            const aText = stripCardSoupText(stripMedia(aRaw));
            const bText = stripCardSoupText(stripMedia(bRaw));
            const aScore = structureScore(aRaw);
            const bScore = structureScore(bRaw);
            const aSoup = looksLikeCardSoup(aRaw);
            const bSoup = looksLikeCardSoup(bRaw);
            const norm = (t) => String(t || '').replace(/\s+/g, '');
            const looksTruncated = (t) => {
              const s = String(t || '').trim();
              if (!s) return true;
              if (/^[，、。；：！？,.!?]/.test(s)) return true;
              if (/^(本的|的安全感|温饱与爱|而言，|维度来|情绪稳定是妈妈)/.test(s)) return true;
              return false;
            };
            const missingHead =
              norm(bText).length > 40 && !norm(aText).includes(norm(bText).slice(0, 16));

            let bestText = aText;
            let bestMeta = a;
            const hasFmt = (t) =>
              (String(t).match(/\n/g) || []).length >= 1 ||
              /\*\*[^*\n]+\*\*/.test(t) ||
              /^(\d+\.|[-*+])\s/m.test(t) ||
              /^\|.+\|/m.test(t);
            const hasTable = (t) => /^\|.+\|/m.test(t) && /^\|?\s*:?-{3,}/m.test(t);
            const mashed = (t) => {
              const s = String(t || '').replace(/\s+/g, '');
              return (
                (/表格下载为表格|导出为图片/.test(s) && !/\|/.test(String(t || ''))) ||
                (/章节内容摘要|章节内容一、|章节内容二、/.test(s) && !/\|/.test(String(t || '')))
              );
            };
            // 半截稿 / 缺开场 / 状态扁平而 DOM 有版式 → 一律用页面 DOM 原文
            if (
              bText &&
              (looksTruncated(aText) ||
                missingHead ||
                (!hasFmt(aText) && hasFmt(bText)) ||
                (hasTable(bText) && !hasTable(aText)) ||
                (mashed(aText) && !mashed(bText)) ||
                ((aText.match(/\n/g) || []).length + 1 < (bText.match(/\n/g) || []).length &&
                  bText.length > 80))
            ) {
              bestText = bText;
              bestMeta = b;
            } else if (aSoup && !bSoup && bText) {
              bestText = bText;
              bestMeta = b;
            } else if (bSoup && !aSoup && aText) {
              bestText = aText;
              bestMeta = a;
            } else if (bScore > aScore + 2) {
              bestText = bText;
              bestMeta = b;
            } else if (aScore > bScore + 2) {
              bestText = aText;
              bestMeta = a;
            } else {
              // 同分：默认 DOM
              const aMd = /\*\*|^#{1,6}\s|^(\d+\.|[-*+])\s|^\|/m.test(aText);
              const bMd = /\*\*|^#{1,6}\s|^(\d+\.|[-*+])\s|^\|/m.test(bText);
              if (!aMd && bMd) {
                bestText = bText;
                bestMeta = b;
              } else if (aMd && !bMd) {
                bestText = aText;
                bestMeta = a;
              } else if (bText) {
                bestText = bText;
                bestMeta = b;
              }
            }

            const media = [pullMedia(aRaw), pullMedia(bRaw)].filter(Boolean).join('\n\n');
            const mediaParts = media
              ? [...new Set(media.split(/\n\n(?=@@ACM_FILE:)/).filter(Boolean))]
              : [];
            const mediaJoined = mediaParts.join('\n\n');
            const content = mediaJoined
              ? `${bestText}\n\n${mediaJoined}`.trim()
              : bestText;
            return {
              role: bestMeta.role || a.role || b.role,
              content,
              timestamp: bestMeta.timestamp || a.timestamp || b.timestamp || null
            };
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
        messages = messages.map((m) => {
          if (m.role !== 'assistant') return m;
          return { ...m, content: ensureParagraphBreaks(stripCardSoupText(m.content)) };
        });

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

/** 是否包含至少一对有效问答（用于自动保存门槛） */
function hasCompleteQaPair(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const hasUser = list.some(
    (m) => m?.role === 'user' && String(m.content || '').replace(/\s+/g, '').length > 0
  );
  const hasAssistant = list.some(
    (m) => m?.role === 'assistant' && String(m.content || '').replace(/\s+/g, '').length > 0
  );
  return hasUser && hasAssistant;
}

async function handleSaveConversation(data, auto = false) {
  if (!data || !data.messages?.length) {
    return { success: false, error: '没有可保存的对话内容' };
  }

  // 自动保存：必须已有至少一条有效用户提问 + 一条助手回复，
  // 避免 DeepSeek「开启新对话」等空会话被存成「未命名对话」
  if (auto && !hasCompleteQaPair(data.messages)) {
    return {
      success: false,
      skipped: true,
      error: '自动保存跳过：尚无完整问答'
    };
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
      // 千问 /chat 无 session 时禁止按 URL 合并，否则多会话全部串进一条
      if (data.platform === 'qianwen' || /qianwen\.com|tongyi\./i.test(data.url || '')) {
        if (!data.sessionId || !c.sessionId) return false;
        return c.sessionId === data.sessionId;
      }
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
        // 千问：API/状态常混进检索墙，允许后续 DOM/纠偏写回
        const isQianwen =
          data.platform === 'qianwen' ||
          same.platform === 'qianwen' ||
          /qianwen\.com|tongyi\./i.test(data.url || same.url || '');
        if (!isQianwen) {
          if (!auto) notifySaved(same, false);
          return {
            success: true,
            data: same,
            updated: false,
            keptApiSource: true,
            unchanged: true,
            source: 'api'
          };
        }
      }

      const messages = mergeMessages(
        same.messages || [],
        data.messages || [],
        data.platform || same.platform
      );
      const firstUser = (messages || []).find((m) => m.role === 'user' && String(m.content || '').trim());
      const nextTitle = firstUser
        ? String(firstUser.content)
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 40)
        : data.title || same.title;
      const unchanged =
        auto &&
        conversationContentFingerprint(same) ===
          conversationContentFingerprint({
            ...same,
            messages,
            title: nextTitle
          });
      if (unchanged) {
        return {
          success: true,
          data: same,
          updated: false,
          unchanged: true,
          source: data.source || same.source || 'dom'
        };
      }
      const updated = await updateConversation(same.id, {
        messages,
        title: nextTitle,
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

/** 用于判断自动保存是否真有内容变化（避免连弹 Toast） */
function conversationContentFingerprint(conv) {
  const msgs = conv?.messages || [];
  const last = msgs[msgs.length - 1];
  return [
    conv?.sessionId || '',
    conv?.platform || '',
    msgs.length,
    String(conv?.title || '').trim(),
    last?.role || '',
    String(last?.content || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160)
  ].join('|');
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
