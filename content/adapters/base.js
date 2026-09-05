/**
 * 基础适配器抽象类
 * 各平台适配器继承此类并实现具体方法
 */
class BaseAdapter {
  constructor() {
    this._updateObserver = null;
    this._updateCallback = null;
    this._debounceTimer = null;
  }

  getPlatformName() {
    throw new Error('子类必须实现 getPlatformName()');
  }

  getConversationTitle() {
    const title = document.title || '';
    const cleaned = title.replace(/\s*[-|–—]\s*.*$/, '').trim();
    if (cleaned && cleaned.length > 1) return cleaned;

    const firstUser = this._getFirstUserMessage();
    if (firstUser) return firstUser.slice(0, 30) + (firstUser.length > 30 ? '...' : '');
    return '未命名对话';
  }

  parseConversation() {
    throw new Error('子类必须实现 parseConversation()');
  }

  hasConversation() {
    try {
      const data = this.parseConversation();
      return data.messages && data.messages.length > 0;
    } catch {
      return false;
    }
  }

  onConversationUpdate(callback) {
    this._updateCallback = callback;
    this._startObserver();
  }

  _getFirstUserMessage() {
    try {
      const data = this.parseConversation();
      const userMsg = (data.messages || []).find((m) => m.role === 'user');
      return userMsg ? userMsg.content : '';
    } catch {
      return '';
    }
  }

  _buildResult(messages, title, meta = {}) {
    return {
      title: title || this.getConversationTitle(),
      messages: messages.map((m) => {
        let content = m.content || '';
        if (
          m.role === 'assistant' &&
          typeof sanitizeAssistantContentForSave === 'function'
        ) {
          content = sanitizeAssistantContentForSave(content);
        }
        return {
          role: m.role,
          content,
          timestamp: m.timestamp || null
        };
      }),
      url: location.href,
      platform: this.getPlatformName(),
      source: meta.source || 'dom',
      sessionId: meta.sessionId || null
    };
  }

  _startObserver() {
    if (this._updateObserver) return;

    const attach = () => {
      const container = this._getObserveTarget();
      if (!container) {
        setTimeout(attach, 500);
        return;
      }

      this._updateObserver = new MutationObserver(() => {
        if (this._isStreaming()) return;

        clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(async () => {
          if (typeof isExtensionContextValid === 'function' && !isExtensionContextValid()) {
            this.destroy();
            if (typeof showExtensionRefreshHint === 'function') showExtensionRefreshHint();
            return;
          }
          if (this._isStreaming()) return;
          if (!this._updateCallback) return;

          // 豆包等适配器自带更稳的自动保存队列
          if (typeof this._queueAutoSave === 'function') {
            this._queueAutoSave('dom-mutation');
            return;
          }

          try {
            let data = null;
            if (typeof this.parseConversationAsync === 'function') {
              data = await this.parseConversationAsync();
            } else if (this.hasConversation()) {
              data = this.parseConversation();
            }

            if (data?.error || !data?.messages?.length) return;
            // 自动保存需至少一对有效问答，避免「新对话」空页写入「未命名对话」
            const hasUser = data.messages.some(
              (m) => m.role === 'user' && String(m.content || '').replace(/\s+/g, '').length > 0
            );
            const hasAssistant = data.messages.some(
              (m) =>
                m.role === 'assistant' && String(m.content || '').replace(/\s+/g, '').length > 0
            );
            if (!hasUser || !hasAssistant) return;
            this._updateCallback(data);
          } catch (e) {
            const msg = e?.message || '';
            if (msg.includes('Extension context invalidated') ||
                (typeof isExtensionContextValid === 'function' && !isExtensionContextValid())) {
              this.destroy();
              if (typeof showExtensionRefreshHint === 'function') showExtensionRefreshHint();
              return;
            }
            console.warn('[ACM] 自动保存解析失败:', msg);
          }
        }, 1200);
      });

      this._updateObserver.observe(container, {
        childList: true,
        subtree: true,
        characterData: true
      });
    };

    attach();
  }

  _getObserveTarget() {
    return document.body;
  }

  _isStreaming() {
    return false;
  }

  _getUserMessageElements() {
    const byDataRole = Array.from(document.querySelectorAll('[data-role="user"]'));
    if (byDataRole.length) return byDataRole;
    return [];
  }

  _normalizeMatchText(text) {
    return typeof normalizeMatchText === 'function'
      ? normalizeMatchText(text)
      : String(text || '').replace(/\s+/g, ' ').trim();
  }

  scrollToUserMessage({ content = '', userIndex = 0, contents = [] } = {}) {
    if (typeof ensureHighlightStyle === 'function') ensureHighlightStyle();

    const elements = this._getUserMessageElements();
    if (!elements.length) return { success: false, error: '未找到用户提问' };

    const needles = [content, ...contents]
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

    if (!target) target = elements[userIndex] || elements[0];
    if (!target) return { success: false, error: '未找到用户提问' };

    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    this._highlightMessage(target);
    return { success: true };
  }

  _highlightMessage(element) {
    element.classList.add('acm-scroll-highlight');
    setTimeout(() => element.classList.remove('acm-scroll-highlight'), 2800);
  }

  destroy() {
    if (this._updateObserver) {
      this._updateObserver.disconnect();
      this._updateObserver = null;
    }
    clearTimeout(this._debounceTimer);
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.BaseAdapter = BaseAdapter;
}
