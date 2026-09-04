/**
 * Kimi 适配器：仅通过官方接口保存（与 DeepSeek/豆包一致）
 */
const KIMI_SELECTORS = {
  chatContainer: 'main, [class*="chat"], [class*="conversation"], #root',
  stopButton:
    'button[class*="stop"], button[aria-label*="停止"], button[aria-label*="Stop"], [data-testid*="stop"]'
};

class KimiAdapter extends BaseAdapter {
  constructor() {
    super();
    if (typeof injectKimiHook === 'function') injectKimiHook();
    this._sessionId = typeof getKimiChatId === 'function' ? getKimiChatId() : null;
  }

  getPlatformName() {
    return 'kimi';
  }

  getConversationTitle() {
    const title = document.title || '';
    const cleaned = title
      .replace(/\s*[-|–—]\s*(Kimi|Moonshot).*$/i, '')
      .replace(/\s*[-|–—]\s*.*$/, '')
      .trim();
    if (cleaned && cleaned.length > 1) return cleaned;
    return '未命名对话';
  }

  hasConversation() {
    const id =
      (typeof getKimiChatId === 'function' ? getKimiChatId() : null) || this._sessionId;
    return !!id;
  }

  parseConversation() {
    return {
      title: this.getConversationTitle(),
      messages: [],
      url: location.href,
      platform: 'kimi',
      source: 'api',
      error: 'Kimi 仅通过官方 API 保存，请使用 parseConversationAsync'
    };
  }

  async parseConversationAsync() {
    if (this._isStreaming()) {
      return { error: 'AI正在回答中，请等待完成后再保存' };
    }

    const chatId =
      (typeof getKimiChatId === 'function' ? getKimiChatId() : null) || this._sessionId;

    if (!chatId) {
      return {
        error: '未识别 Kimi 会话 ID。请打开具体对话页（地址含 /chat/…）后再保存'
      };
    }

    if (typeof fetchKimiConversation !== 'function') {
      return { error: 'Kimi API 模块未加载，请刷新页面（F5）后重试' };
    }

    try {
      const apiData = await fetchKimiConversation(chatId);
      if (apiData?.messages?.length) {
        console.log('[ACM Kimi] API 原文', apiData.messages.length, '条');
        return this._buildResult(apiData.messages, null, {
          source: 'api',
          sessionId: chatId
        });
      }
    } catch (err) {
      console.error('[ACM Kimi] API 获取失败:', err);
      return {
        error: `Kimi API 获取失败，请确认已登录并刷新页面后重试（${String(err?.message || err).slice(0, 120)}）`
      };
    }

    return {
      error: 'Kimi API 未返回对话内容，请确认已登录、对话页已加载完成后再保存'
    };
  }

  _getObserveTarget() {
    return document.querySelector(KIMI_SELECTORS.chatContainer) || document.body;
  }

  _isStreaming() {
    const stopBtn = document.querySelector(KIMI_SELECTORS.stopButton);
    return !!stopBtn && stopBtn.offsetParent !== null;
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.KimiAdapter = KimiAdapter;
}
