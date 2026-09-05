/**
 * 豆包适配器：官方 API 为主；页面 DOM 仅在 API 正文扁平无格式时补全 Markdown
 * 自动保存：流式结束 / 历史 Hook / URL 变化 / 定时巡检 → 强制拉新 API（带重试）
 */
const DOUBAO_SELECTORS = {
  breakButton: '[data-testid="chat_input_local_break_button"]',
  sendButton: '[data-testid="chat_input_send_button"]',
  chatContainer:
    '[class*="message-list-"], .container-PvPoAn, .scroll-view-OEiNXD, [data-testid="message-list"], main, [class*="chat"]',
  assistantMarkdown:
    '[class*="markdown-body"], [class*="container-markdown"], [class*="message-content"], [data-testid="message_text_content"], [class*="receive"] [class*="markdown"]'
};

class DoubaoAdapter extends BaseAdapter {
  constructor() {
    super();
    this._autoSaveArmed = false;
    this._wasStreaming = false;
    this._lastAutoFingerprint = '';
    this._autoSaveInFlight = false;
    this._streamPollTimer = null;
    this._autoSaveTimer = null;
    this._urlPollTimer = null;
    this._idlePollTimer = null;
    this._lastPath = location.pathname;
    this._onHistory = null;
    this._onMessage = null;
    this._forceRefreshOnce = false;
  }

  getPlatformName() {
    return 'doubao';
  }

  getConversationTitle() {
    const title = document.title || '';
    const cleaned = title
      .replace(/\s*[-|–—]\s*(豆包|Doubao).*$/i, '')
      .replace(/\s*[-|–—]\s*.*$/, '')
      .trim();
    if (cleaned && cleaned.length > 1) return cleaned;
    return '未命名对话';
  }

  hasConversation() {
    const id =
      typeof getDoubaoConversationId === 'function' ? getDoubaoConversationId() : null;
    return !!id;
  }

  parseConversation() {
    return {
      title: this.getConversationTitle(),
      messages: [],
      url: location.href,
      platform: 'doubao',
      source: 'api',
      error: '豆包仅通过官方 API 保存，请使用 parseConversationAsync'
    };
  }

  async parseConversationAsync(options = {}) {
    // 自动保存路径允许在“刚结束”时拉取；仅手动保存时严格拦截流式
    if (this._isStreaming() && !this._allowFetchWhileSettling) {
      return { error: 'AI正在回答中，请等待完成后再保存' };
    }

    const conversationId =
      typeof getDoubaoConversationId === 'function' ? getDoubaoConversationId() : null;

    if (!conversationId) {
      return {
        error:
          '未识别豆包对话 ID。请打开具体对话页（地址类似 /chat/数字ID）后再保存'
      };
    }

    if (typeof fetchDoubaoConversation !== 'function') {
      return { error: '豆包 API 模块未加载，请刷新页面（F5）后重试' };
    }

    const forceRefresh = !!(options.forceRefresh || this._forceRefreshOnce);
    this._forceRefreshOnce = false;

    try {
      const apiData = await fetchDoubaoConversation(conversationId, { forceRefresh });
      if (apiData?.messages?.length) {
        const messages = this._enrichMessagesFromDom(apiData.messages);
        console.log('[ACM Doubao] API 原文', messages.length, '条', forceRefresh ? '(force)' : '');
        return this._buildResult(messages, null, {
          source: 'api',
          sessionId: conversationId
        });
      }
    } catch (err) {
      console.error('[ACM Doubao] API 获取失败:', err);
      return {
        error: `豆包 API 获取失败，请确认已登录并刷新页面后重试（${String(err?.message || err).slice(0, 120)}）`
      };
    }

    return {
      error: '豆包 API 未返回对话内容，请确认已登录、对话页已加载完成后再保存'
    };
  }

  /**
   * API 常返回无换行/无 Markdown 的扁平正文；用「对应轮次」页面节点补格式与文件卡
   * 注意：禁止把整页附件挂到最后一轮（会串轮）
   */
  _enrichMessagesFromDom(messages) {
    if (!Array.isArray(messages) || !messages.length) return messages;
    if (typeof extractMarkdownFromElement !== 'function') return messages;

    const apiAssistants = messages.filter((m) => m.role === 'assistant');
    if (!apiAssistants.length) return messages;

    const needTextEnrich = apiAssistants.some((m) => this._looksFlatAssistantText(m.content));
    const needFileEnrich = apiAssistants.some((m) => !/@@ACM_FILE:/.test(String(m.content || '')));
    if (!needTextEnrich && !needFileEnrich) return messages;

    const domAssistants = this._extractAssistantDomMarkdowns();
    if (!domAssistants.length) return messages;

    // 助手条数对不齐时宁可不补，避免串轮（多轮附件错挂）
    const alignOk = domAssistants.length === apiAssistants.length;
    if (!alignOk && apiAssistants.length > 1) {
      console.warn(
        '[ACM Doubao] DOM 助手条数与 API 不一致，跳过 DOM 补全',
        domAssistants.length,
        apiAssistants.length
      );
      return messages;
    }

    let domIdx = 0;
    return messages.map((m) => {
      if (m.role !== 'assistant') return m;
      let content = String(m.content || '');
      const domText = domAssistants[domIdx++] || '';
      if (!domText) return m;

      if (this._looksFlatAssistantText(content)) {
        if (this._textRichness(domText) > this._textRichness(content)) {
          const aLen = content.replace(/\s+/g, '').length;
          const dLen = domText.replace(/\s+/g, '').length;
          let ok = true;
          if (aLen > 40 && dLen > 40) {
            const ratio = Math.min(aLen, dLen) / Math.max(aLen, dLen);
            if (ratio < 0.55) ok = false;
          }
          if (ok) content = domText;
        }
      }

      // 仅用「本轮」DOM 正文里的文件卡补全
      if (
        !/@@ACM_FILE:/.test(content) &&
        !/!\[[^\]]*\]\(https?:/.test(content) &&
        /@@ACM_FILE:/.test(domText)
      ) {
        const fromDom = (
          domText.match(/@@ACM_FILE:\{[\s\S]*?\}@@[\s\S]*?(?=\n\n@@ACM_FILE:|$)/g) || []
        ).join('\n\n');
        if (fromDom) content = content ? `${content}\n\n${fromDom}` : fromDom;
      }

      return content === m.content ? m : { ...m, content };
    });
  }

  _looksFlatAssistantText(text) {
    const t = String(text || '').trim();
    if (!t) return true;
    const newlines = (t.match(/\n/g) || []).length;
    const mdMarks = (t.match(/\*\*|__|^#{1,6}\s|^(\d+\.|[-*+])\s|```/gm) || []).length;
    if (newlines >= 3 || mdMarks >= 2) return false;
    // 长文几乎无结构 → 视为扁平
    return t.length > 120 && newlines < 2;
  }

  _textRichness(text) {
    if (typeof scoreDoubaoTextRichness === 'function') {
      return scoreDoubaoTextRichness(text);
    }
    return String(text || '').length;
  }

  _extractAssistantDomMarkdowns() {
    const roots = [];
    const seen = new Set();

    const push = (el) => {
      if (!el || seen.has(el)) return;
      // 跳过用户气泡
      if (
        el.closest?.(
          '[class*="bg-g-send-msg-bubble"], [data-testid="send_message"], [data-testid="user_message"]'
        )
      ) {
        return;
      }
      seen.add(el);
      roots.push(el);
    };

    document.querySelectorAll(DOUBAO_SELECTORS.assistantMarkdown).forEach((el) => {
      // 取较完整的内容容器，避免只抓到一行 span
      const host =
        el.closest(
          '[data-testid="message_text_content"], [class*="message-content"], [class*="markdown"]'
        ) || el;
      push(host);
    });

    // 兜底：整页非用户气泡的大段正文块
    if (!roots.length) {
      document
        .querySelectorAll('[data-testid="message_text_content"], [class*="message-content"]')
        .forEach((el) => push(el));
    }

    const out = [];
    for (const el of roots) {
      try {
        const md = extractMarkdownFromElement(el);
        const cleaned =
          typeof sanitizeAssistantContentForSave === 'function'
            ? sanitizeAssistantContentForSave(md)
            : md;
        if (cleaned && cleaned.replace(/\s+/g, '').length > 0) out.push(cleaned.trim());
      } catch {
        // ignore
      }
    }
    return out;
  }

  onConversationUpdate(callback) {
    this._updateCallback = callback;
    this._startObserver();
    this._startDoubaoAutoWatch();
    // 立即尝试一次（已打开的对话）
    this._queueAutoSave('watch-start');
  }

  _startDoubaoAutoWatch() {
    if (this._autoSaveArmed) return;
    this._autoSaveArmed = true;
    console.log('[ACM Doubao] 自动保存监视已启动');

    this._onHistory = () => this._queueAutoSave('history-hook');
    document.addEventListener('acm-doubao-history', this._onHistory);

    // MAIN hook 也会 postMessage，避免 CustomEvent 偶发丢事件
    this._onMessage = (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== 'acm-doubao') return;
      if (data.type === 'history' || data.type === 'fetch-response') {
        this._queueAutoSave('postmessage');
      }
    };
    window.addEventListener('message', this._onMessage);

    // 流式边沿：break 可见 → 不可见
    this._streamPollTimer = setInterval(() => {
      const streaming = this._isStreaming();
      if (this._wasStreaming && !streaming) {
        this._forceRefreshOnce = true;
        if (typeof invalidateDoubaoCache === 'function') {
          const id =
            typeof getDoubaoConversationId === 'function' ? getDoubaoConversationId() : null;
          invalidateDoubaoCache(id);
        }
        this._queueAutoSave('stream-end');
      } else if (!this._wasStreaming && streaming) {
        console.log('[ACM Doubao] 检测到生成中');
      }
      this._wasStreaming = streaming;
    }, 600);

    // SPA URL 变化
    this._urlPollTimer = setInterval(() => {
      const path = location.pathname;
      if (path === this._lastPath) return;
      this._lastPath = path;
      if (/\/chat\/[0-9a-zA-Z_-]{8,}/.test(path)) {
        this._forceRefreshOnce = true;
        this._queueAutoSave('url-change');
      }
    }, 800);

    // 兜底巡检：有对话 ID 且空闲时周期性强制拉新（指纹去重，不会刷屏）
    this._idlePollTimer = setInterval(() => {
      if (!this._updateCallback) return;
      if (this._isStreaming()) return;
      if (!this.hasConversation()) return;
      this._forceRefreshOnce = true;
      this._queueAutoSave('idle-poll');
    }, 4000);
  }

  _queueAutoSave(reason) {
    if (!this._updateCallback) return;
    clearTimeout(this._autoSaveTimer);
    const delay =
      reason === 'stream-end' ? 1500 : reason === 'idle-poll' ? 400 : 1000;
    this._autoSaveTimer = setTimeout(() => {
      this._runAutoSave(reason, 0);
    }, delay);
  }

  async _runAutoSave(reason, attempt) {
    if (!this._updateCallback) return;

    if (this._autoSaveInFlight) {
      // 进行中则延后，避免丢掉本轮结束事件
      this._autoSaveTimer = setTimeout(
        () => this._runAutoSave(reason, attempt),
        800
      );
      return;
    }

    if (this._isStreaming()) {
      this._wasStreaming = true;
      // 关键：生成中不要直接放弃，结束后再跑
      this._autoSaveTimer = setTimeout(
        () => this._runAutoSave(reason, attempt),
        1200
      );
      return;
    }

    const conversationId =
      typeof getDoubaoConversationId === 'function' ? getDoubaoConversationId() : null;
    if (!conversationId) {
      if (attempt < 12) {
        this._autoSaveTimer = setTimeout(
          () => this._runAutoSave(reason, attempt + 1),
          800
        );
      }
      return;
    }

    this._autoSaveInFlight = true;
    this._allowFetchWhileSettling = true;
    const forceRefresh =
      reason === 'stream-end' ||
      reason === 'idle-poll' ||
      reason === 'url-change' ||
      attempt > 0;
    try {
      const data = await this.parseConversationAsync({ forceRefresh });
      if (data?.error || !data?.messages?.length) {
        if (attempt < 10) {
          console.warn(
            '[ACM Doubao] 自动保存重试',
            reason,
            attempt + 1,
            data?.error || 'empty'
          );
          this._autoSaveTimer = setTimeout(() => {
            this._autoSaveInFlight = false;
            this._allowFetchWhileSettling = false;
            this._forceRefreshOnce = true;
            this._runAutoSave(reason, attempt + 1);
          }, 900 + attempt * 350);
          return;
        }
        console.warn('[ACM Doubao] 自动保存放弃:', reason, data?.error || 'empty');
        return;
      }

      const last = data.messages[data.messages.length - 1];
      // 流式刚结束时若末条仍是用户，说明服务端历史未落库，继续重试
      if (
        (reason === 'stream-end' || reason === 'idle-poll') &&
        last?.role !== 'assistant' &&
        attempt < 12
      ) {
        console.warn('[ACM Doubao] 末轮助手未就绪，重试', reason, attempt + 1);
        this._autoSaveTimer = setTimeout(() => {
          this._autoSaveInFlight = false;
          this._allowFetchWhileSettling = false;
          this._forceRefreshOnce = true;
          this._runAutoSave(reason, attempt + 1);
        }, 1000 + attempt * 400);
        return;
      }

      const fp = [
        data.sessionId || conversationId,
        data.messages.length,
        last?.role || '',
        String(last?.content || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 160)
      ].join('|');

      if (fp === this._lastAutoFingerprint) {
        return;
      }
      this._lastAutoFingerprint = fp;
      console.log('[ACM Doubao] 自动保存触发:', reason, data.messages.length, '条');
      this._updateCallback(data);
    } catch (err) {
      console.warn('[ACM Doubao] 自动保存异常:', err);
      if (attempt < 5) {
        this._autoSaveTimer = setTimeout(() => {
          this._autoSaveInFlight = false;
          this._allowFetchWhileSettling = false;
          this._forceRefreshOnce = true;
          this._runAutoSave(reason, attempt + 1);
        }, 1500);
        return;
      }
    } finally {
      this._autoSaveInFlight = false;
      this._allowFetchWhileSettling = false;
    }
  }

  _getUserMessageElements() {
    return Array.from(
      document.querySelectorAll(
        '[class*="bg-g-send-msg-bubble"], [data-testid="send_message"], [data-testid="message_text_content"]'
      )
    );
  }

  _getObserveTarget() {
    return document.querySelector(DOUBAO_SELECTORS.chatContainer) || document.body;
  }

  _isElementVisiblyPresent(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.hidden) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(el);
    if (
      !style ||
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0'
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  }

  /**
   * 只认官方停止按钮，避免 class*=stop / generating 误判把自动保存永久卡住
   */
  _isStreaming() {
    const breakBtn = document.querySelector(DOUBAO_SELECTORS.breakButton);
    if (this._isElementVisiblyPresent(breakBtn)) return true;

    // 少数布局：break 与 send 互斥，send 消失也视为生成中
    const sendBtn = document.querySelector(DOUBAO_SELECTORS.sendButton);
    if (breakBtn && sendBtn) {
      const breakVisible = this._isElementVisiblyPresent(breakBtn);
      const sendVisible = this._isElementVisiblyPresent(sendBtn);
      if (breakVisible && !sendVisible) return true;
    }

    return false;
  }

  destroy() {
    if (this._onHistory) {
      document.removeEventListener('acm-doubao-history', this._onHistory);
      this._onHistory = null;
    }
    if (this._onMessage) {
      window.removeEventListener('message', this._onMessage);
      this._onMessage = null;
    }
    if (this._streamPollTimer) {
      clearInterval(this._streamPollTimer);
      this._streamPollTimer = null;
    }
    if (this._urlPollTimer) {
      clearInterval(this._urlPollTimer);
      this._urlPollTimer = null;
    }
    if (this._idlePollTimer) {
      clearInterval(this._idlePollTimer);
      this._idlePollTimer = null;
    }
    clearTimeout(this._autoSaveTimer);
    this._autoSaveArmed = false;
    super.destroy();
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.DoubaoAdapter = DoubaoAdapter;
}
