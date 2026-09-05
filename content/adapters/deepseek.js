/**
 * DeepSeek 平台适配器（仅 API 保存，DOM 仅用于页面定位）
 */
const DEEPSEEK_SELECTORS = {
  dsMessage: 'div.ds-message',
  stopButton: 'button[class*="stop"], button[aria-label*="停止"], button[aria-label*="Stop"]',
  chatContainer: 'main, [class*="chat"], [class*="conversation"], #root'
};

class DeepSeekAdapter extends BaseAdapter {
  constructor() {
    super();
    if (typeof injectDeepSeekHook === 'function') injectDeepSeekHook();
    this._sessionId = typeof getDeepSeekSessionId === 'function' ? getDeepSeekSessionId() : null;
  }

  getPlatformName() {
    return 'deepseek';
  }

  getConversationTitle() {
    const title = document.title || '';
    const cleaned = title.replace(/\s*[-|–—]\s*.*$/, '').trim();
    if (cleaned && cleaned.length > 1 && !/^DeepSeek$/i.test(cleaned)) return cleaned;
    return '未命名对话';
  }

  hasConversation() {
    const sessionId =
      typeof getDeepSeekSessionId === 'function' ? getDeepSeekSessionId() : null;
    if (sessionId) this._sessionId = sessionId;
    return !!sessionId && !/\/sign_in/i.test(location.pathname);
  }

  parseConversation() {
    return {
      title: this.getConversationTitle(),
      messages: [],
      url: location.href,
      platform: 'deepseek',
      source: 'api',
      error: 'DeepSeek 仅通过官方 API 保存，请使用 parseConversationAsync'
    };
  }

  async parseConversationAsync() {
    if (this._isStreaming && this._isStreaming()) {
      return { error: 'AI正在回答中，请等待完成后再保存' };
    }

    // 只用 URL 上的实时 session，禁止回退旧 _sessionId（新对话页会串成「未命名」脏记录）
    const sessionId =
      typeof getDeepSeekSessionId === 'function' ? getDeepSeekSessionId() : null;
    if (sessionId) this._sessionId = sessionId;
    else this._sessionId = null;

    if (!sessionId) {
      return { error: '没有可保存的对话内容' };
    }

    if (typeof fetchDeepSeekConversation !== 'function') {
      return { error: 'DeepSeek API 模块未加载，请刷新页面（F5）后重试' };
    }

    try {
      const apiData = await fetchDeepSeekConversation(sessionId);
      if (apiData?.messages?.length) {
        console.log('[ACM DeepSeek] API 原文', apiData.messages.length, '条');
        const titleFromUser = (() => {
          const u = apiData.messages.find((m) => m.role === 'user');
          if (!u) return null;
          const t = String(u.content || '')
            .replace(/\s+/g, ' ')
            .trim();
          if (!t) return null;
          return t.slice(0, 40) + (t.length > 40 ? '…' : '');
        })();
        return this._buildResult(apiData.messages, titleFromUser, {
          source: 'api',
          sessionId
        });
      }
    } catch (err) {
      console.error('[ACM DeepSeek] API 获取失败:', err);
      return {
        error: 'DeepSeek API 获取失败，请确认已登录并刷新页面后重试'
      };
    }

    return { error: '没有可保存的对话内容' };
  }

  _getUserMessageElements() {
    const byRole = Array.from(document.querySelectorAll('[data-role="user"]'));
    if (byRole.length) return byRole;

    const container = document.querySelector(DEEPSEEK_SELECTORS.chatContainer) || document.body;
    return Array.from(container.querySelectorAll(DEEPSEEK_SELECTORS.dsMessage)).filter((el) => {
      if (el.parentElement?.closest('div.ds-message')) return false;
      return this._isUserLayout(el);
    });
  }

  _isUserLayout(el) {
    let node = el;
    for (let depth = 0; depth < 8 && node && node !== document.body; depth++, node = node.parentElement) {
      const align = node.getAttribute?.('data-align');
      if (align === 'end') return true;
      if (align === 'start') return false;
      try {
        const style = window.getComputedStyle(node);
        if (style.flexDirection === 'row-reverse') return true;
        if (depth <= 4 && style.alignSelf === 'flex-end') return true;
        if (style.marginLeft === 'auto' && style.marginRight !== 'auto' && depth <= 5) return true;
      } catch {
        // ignore
      }
    }
    return false;
  }

  scrollToUserMessage(options = {}) {
    const elements = this._getUserMessageElements();
    if (!elements.length) return super.scrollToUserMessage(options);

    if (typeof ensureHighlightStyle === 'function') ensureHighlightStyle();

    const needles = [options.content, ...(options.contents || [])]
      .map((t) => this._normalizeMatchText(t).slice(0, 150))
      .filter(Boolean);

    let target = null;
    for (const needle of needles) {
      target = elements.find((el) => {
        const text = this._normalizeMatchText(getTextContent(el));
        return text.includes(needle) || (needle.length > 40 && needle.includes(text.slice(0, 150)));
      });
      if (target) break;
    }

    if (!target) target = elements[options.userIndex || 0] || elements[0];
    if (!target) return { success: false, error: '未找到用户提问' };

    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    this._highlightMessage(target);
    return { success: true };
  }

  _getObserveTarget() {
    return document.querySelector(DEEPSEEK_SELECTORS.chatContainer) || document.body;
  }

  _isStreaming() {
    const stopBtn = document.querySelector(DEEPSEEK_SELECTORS.stopButton);
    return !!stopBtn && stopBtn.offsetParent !== null;
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.DeepSeekAdapter = DeepSeekAdapter;
}
