/**
 * 豆包适配器：仅通过官方 API 保存（与 DeepSeek 一致，不做 DOM 兜底）
 * 自动保存：流式结束 / 历史 Hook / URL 变化 / 定时巡检 → API 拉取（带重试）
 */
const DOUBAO_SELECTORS = {
  breakButton: '[data-testid="chat_input_local_break_button"]',
  sendButton: '[data-testid="chat_input_send_button"]',
  chatContainer:
    '[class*="message-list-"], .container-PvPoAn, .scroll-view-OEiNXD, [data-testid="message-list"], main, [class*="chat"]'
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

  async parseConversationAsync() {
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

    try {
      const apiData = await fetchDoubaoConversation(conversationId);
      if (apiData?.messages?.length) {
        console.log('[ACM Doubao] API 原文', apiData.messages.length, '条');
        return this._buildResult(apiData.messages, null, {
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
        this._queueAutoSave('url-change');
      }
    }, 800);

    // 兜底巡检：有对话 ID 且空闲时周期性尝试（指纹去重，不会刷屏）
    this._idlePollTimer = setInterval(() => {
      if (!this._updateCallback) return;
      if (this._isStreaming()) return;
      if (!this.hasConversation()) return;
      this._queueAutoSave('idle-poll');
    }, 4000);
  }

  _queueAutoSave(reason) {
    if (!this._updateCallback) return;
    clearTimeout(this._autoSaveTimer);
    const delay =
      reason === 'stream-end' ? 2000 : reason === 'idle-poll' ? 400 : 1000;
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
    try {
      const data = await this.parseConversationAsync();
      if (data?.error || !data?.messages?.length) {
        if (attempt < 8) {
          console.warn(
            '[ACM Doubao] 自动保存重试',
            reason,
            attempt + 1,
            data?.error || 'empty'
          );
          this._autoSaveTimer = setTimeout(() => {
            this._autoSaveInFlight = false;
            this._allowFetchWhileSettling = false;
            this._runAutoSave(reason, attempt + 1);
          }, 1000 + attempt * 400);
          return;
        }
        console.warn('[ACM Doubao] 自动保存放弃:', reason, data?.error || 'empty');
        return;
      }

      const last = data.messages[data.messages.length - 1];
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
