/**
 * 腾讯元宝适配器：官方 detail 接口保存 + 自动同步监视（对齐豆包/千问）
 */
const YUANBAO_SELECTORS = {
  chatContainer: 'main, [class*="chat"], [class*="conversation"], #root, [class*="Chat"]',
  stopButton: [
    'button[class*="stop"]',
    'button[aria-label*="停止"]',
    'button[aria-label*="Stop"]',
    'button[aria-label*="stop"]',
    '[data-testid*="stop"]',
    '[class*="stop-btn"]',
    '[class*="StopBtn"]',
    '[class*="generating"] button',
    'button:has(svg[class*="stop"])'
  ].join(', ')
};

class YuanbaoAdapter extends BaseAdapter {
  constructor() {
    super();
    if (typeof injectYuanbaoHook === 'function') injectYuanbaoHook();
    this._sessionId =
      typeof getYuanbaoConversationId === 'function' ? getYuanbaoConversationId() : null;
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
    this._allowFetchWhileSettling = false;
  }

  getPlatformName() {
    return 'yuanbao';
  }

  getConversationTitle() {
    const title = document.title || '';
    const cleaned = title
      .replace(/\s*[-|–—]\s*(腾讯元宝|元宝|Yuanbao).*$/i, '')
      .replace(/\s*[-|–—]\s*.*$/, '')
      .trim();
    if (cleaned && cleaned.length > 1) return cleaned;
    return '未命名对话';
  }

  hasConversation() {
    const id =
      (typeof getYuanbaoConversationId === 'function' ? getYuanbaoConversationId() : null) ||
      this._sessionId;
    return !!id;
  }

  parseConversation() {
    return {
      title: this.getConversationTitle(),
      messages: [],
      url: location.href,
      platform: 'yuanbao',
      source: 'api',
      error: '元宝仅通过官方 API 保存，请使用 parseConversationAsync'
    };
  }

  async parseConversationAsync() {
    // 自动保存允许在刚结束时拉取；手动保存仍拦截流式中
    if (this._isStreaming() && !this._allowFetchWhileSettling) {
      return { error: 'AI正在回答中，请等待完成后再保存' };
    }

    const conversationId =
      (typeof getYuanbaoConversationId === 'function' ? getYuanbaoConversationId() : null) ||
      this._sessionId;

    if (!conversationId) {
      return {
        error:
          '未识别元宝会话 ID。请打开具体对话（地址类似 /chat/会话ID，不要停在智能体首页）后再保存'
      };
    }
    this._sessionId = conversationId;

    if (typeof fetchYuanbaoConversation !== 'function') {
      return { error: '元宝 API 模块未加载，请刷新页面（F5）后重试' };
    }

    try {
      const apiData = await fetchYuanbaoConversation(conversationId);
      if (apiData?.messages?.length) {
        console.log('[ACM Yuanbao] API 原文', apiData.messages.length, '条');
        const result = this._buildResult(apiData.messages, apiData.title || null, {
          source: 'api',
          sessionId: apiData.sessionId || conversationId
        });
        // 强制使用带 conversationId 的规范 URL，避免多会话共用 /chat/agentId 互相覆盖
        if (apiData.url) result.url = apiData.url;
        else if (typeof buildYuanbaoCanonicalUrl === 'function') {
          result.url = buildYuanbaoCanonicalUrl(apiData.sessionId || conversationId);
        }
        return result;
      }
    } catch (err) {
      console.error('[ACM Yuanbao] API 获取失败:', err);
      return {
        error: `元宝 API 获取失败，请确认已登录并刷新页面后重试（${String(err?.message || err).slice(0, 120)}）`
      };
    }

    return {
      error: '元宝 API 未返回对话内容，请确认已登录、对话页已加载完成后再保存'
    };
  }

  onConversationUpdate(callback) {
    this._updateCallback = callback;
    this._startObserver();
    this._startYuanbaoAutoWatch();
    this._queueAutoSave('watch-start');
  }

  _startYuanbaoAutoWatch() {
    if (this._autoSaveArmed) return;
    this._autoSaveArmed = true;
    console.log('[ACM Yuanbao] 自动保存监视已启动');

    this._onHistory = (event) => {
      const cid = event?.detail?.conversationId;
      if (cid) this._sessionId = String(cid);
      this._queueAutoSave('history-hook');
    };
    document.addEventListener('acm-yuanbao-history', this._onHistory);

    // 流式边沿：生成中 → 结束
    this._streamPollTimer = setInterval(() => {
      const streaming = this._isStreaming();
      if (this._wasStreaming && !streaming) {
        this._queueAutoSave('stream-end');
      } else if (!this._wasStreaming && streaming) {
        console.log('[ACM Yuanbao] 检测到生成中');
      }
      this._wasStreaming = streaming;
    }, 600);

    // SPA URL 变化
    this._urlPollTimer = setInterval(() => {
      const path = location.pathname;
      if (path === this._lastPath) return;
      this._lastPath = path;
      this._sessionId =
        typeof getYuanbaoConversationId === 'function' ? getYuanbaoConversationId() : null;
      if (this.hasConversation()) {
        this._lastAutoFingerprint = '';
        this._queueAutoSave('url-change');
      }
    }, 800);

    // 兜底巡检（指纹去重）
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
      reason === 'stream-end'
        ? 2200
        : reason === 'history-hook'
          ? 1200
          : reason === 'idle-poll'
            ? 500
            : 1000;
    this._autoSaveTimer = setTimeout(() => this._runAutoSave(reason, 0), delay);
  }

  async _runAutoSave(reason, attempt) {
    if (!this._updateCallback) return;

    if (this._autoSaveInFlight) {
      this._autoSaveTimer = setTimeout(() => this._runAutoSave(reason, attempt), 800);
      return;
    }

    if (this._isStreaming()) {
      this._wasStreaming = true;
      this._autoSaveTimer = setTimeout(() => this._runAutoSave(reason, attempt), 1200);
      return;
    }

    const conversationId =
      (typeof getYuanbaoConversationId === 'function' ? getYuanbaoConversationId() : null) ||
      this._sessionId;
    if (!conversationId) {
      if (attempt < 12) {
        this._autoSaveTimer = setTimeout(() => this._runAutoSave(reason, attempt + 1), 800);
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
            '[ACM Yuanbao] 自动保存重试',
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
        console.warn('[ACM Yuanbao] 自动保存放弃:', reason, data?.error || 'empty');
        return;
      }

      if (!data.messages.some((m) => m.role === 'assistant')) {
        if (attempt < 5) {
          this._autoSaveTimer = setTimeout(() => {
            this._autoSaveInFlight = false;
            this._allowFetchWhileSettling = false;
            this._runAutoSave(reason, attempt + 1);
          }, 1500);
          return;
        }
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

      if (fp === this._lastAutoFingerprint) return;
      this._lastAutoFingerprint = fp;
      console.log('[ACM Yuanbao] 自动保存触发:', reason, data.messages.length, '条');
      this._updateCallback(data);
    } catch (err) {
      console.warn('[ACM Yuanbao] 自动保存异常:', err);
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

  _getObserveTarget() {
    return document.querySelector(YUANBAO_SELECTORS.chatContainer) || document.body;
  }

  _isElementVisiblyPresent(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.hidden) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    try {
      const style = window.getComputedStyle(el);
      if (
        !style ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0'
      ) {
        return false;
      }
    } catch {
      // ignore
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  }

  _isStreaming() {
    // 停止按钮可见
    const stopCandidates = document.querySelectorAll(YUANBAO_SELECTORS.stopButton);
    for (const btn of stopCandidates) {
      if (this._isElementVisiblyPresent(btn)) {
        const t = (btn.innerText || btn.getAttribute('aria-label') || '').trim();
        if (!t || /停止|Stop|取消/i.test(t) || btn.querySelector('svg')) return true;
      }
    }

    // 文案/状态：生成中
    const statusNodes = document.querySelectorAll(
      '[class*="generating"], [class*="Generating"], [class*="streaming"], [class*="Typing"], [data-status="generating"]'
    );
    for (const el of statusNodes) {
      if (this._isElementVisiblyPresent(el)) return true;
    }

    // 底部操作区出现「停止生成」纯文本按钮
    const buttons = document.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      if (!this._isElementVisiblyPresent(btn)) continue;
      const t = (btn.innerText || btn.getAttribute('aria-label') || '').replace(/\s+/g, '');
      if (/^停止生成$|^停止$|^Stop$/i.test(t)) return true;
    }

    return false;
  }

  destroy() {
    if (this._onHistory) {
      document.removeEventListener('acm-yuanbao-history', this._onHistory);
      this._onHistory = null;
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
  globalThis.YuanbaoAdapter = YuanbaoAdapter;
}
