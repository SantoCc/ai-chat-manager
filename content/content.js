/**
 * Content Script 入口 - 根据域名分发到对应适配器
 */
(function () {
  const ADAPTER_MAP = {
    'doubao.com': () => new DoubaoAdapter(),
    'tongyi.aliyun.com': () => new QianwenAdapter(),
    'tongyi.com': () => new QianwenAdapter(),
    'qianwen.com': () => new QianwenAdapter(),
    'qianwen.aliyun.com': () => new QianwenAdapter(),
    'chat.deepseek.com': () => new DeepSeekAdapter(),
    'yuanbao.tencent.com': () => new YuanbaoAdapter(),
    'kimi.moonshot.cn': () => new KimiAdapter(),
    'kimi.com': () => new KimiAdapter()
  };

  function getAdapter() {
    const host = location.hostname;
    for (const [domain, factory] of Object.entries(ADAPTER_MAP)) {
      if (host.includes(domain.replace('*.', ''))) {
        return factory();
      }
    }
    return null;
  }

  if (!isExtensionContextValid()) return;

  const adapter = getAdapter();
  if (!adapter) return;

  console.log('[ACM] 已加载适配器:', adapter.getPlatformName());

  function safeSendMessage(message, callback) {
    if (!isExtensionContextValid()) {
      adapter.destroy();
      showExtensionRefreshHint();
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          if (err.message?.includes('Extension context invalidated')) {
            adapter.destroy();
            showExtensionRefreshHint();
            return;
          }
        }
        if (callback) callback(response);
      });
    } catch (e) {
      if (e.message?.includes('Extension context invalidated')) {
        adapter.destroy();
        showExtensionRefreshHint();
      }
    }
  }

  // 监听来自 service worker / side panel 的消息
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isExtensionContextValid()) {
      sendResponse({ success: false, error: '扩展已更新，请刷新本页（F5）后重试' });
      return false;
    }
    if (message.type === 'PARSE_CONVERSATION') {
      handleParse(sendResponse);
      return true;
    }
    if (message.type === 'PING') {
      sendResponse({ ok: true, platform: adapter.getPlatformName() });
      return false;
    }
    if (message.type === 'GET_PLATFORM') {
      sendResponse({ platform: adapter.getPlatformName() });
      return false;
    }
    if (message.type === 'CHECK_CONVERSATION') {
      sendResponse({ hasConversation: adapter.hasConversation() });
      return false;
    }
    if (message.type === 'SCROLL_TO_USER_MESSAGE') {
      handleScrollToUserMessage(message, sendResponse);
      return true;
    }
    return false;
  });

  async function handleScrollToUserMessage(message, sendResponse) {
    const maxAttempts = 20;
    for (let i = 0; i < maxAttempts; i++) {
      const result = adapter.scrollToUserMessage({
        content: message.content || '',
        userIndex: message.userIndex || 0,
        contents: message.contents || []
      });
      if (result.success) {
        sendResponse(result);
        return;
      }
      if (typeof sleep === 'function') await sleep(500);
    }
    sendResponse({ success: false, error: '页面加载超时，未能定位到提问' });
  }

  async function handleParse(sendResponse) {
    try {
      let data;
      if (typeof adapter.parseConversationAsync === 'function') {
        data = await adapter.parseConversationAsync();
      } else {
        if (adapter._isStreaming && adapter._isStreaming()) {
          sendResponse({ success: false, error: 'AI正在回答中，请等待完成后再保存' });
          return;
        }
        data = adapter.parseConversation();
      }

      if (data.error) {
        sendResponse({ success: false, error: data.error });
        return;
      }

      if (!data.messages || data.messages.length === 0) {
        sendResponse({ success: false, error: '当前页面没有可保存的对话内容' });
        return;
      }

      sendResponse({ success: true, data });
    } catch (err) {
      sendResponse({ success: false, error: err.message || '解析对话失败' });
    }
  }

  // 自动保存（支持设置热更新，无需刷新页面）
  let autoSaveEnabled = false;

  function enableAutoSave() {
    if (autoSaveEnabled) return;
    autoSaveEnabled = true;
    adapter.onConversationUpdate((conversationData) => {
      safeSendMessage({
        type: 'SAVE_CONVERSATION',
        data: conversationData,
        auto: true
      });
    });
    console.log('[ACM] 自动保存已开启:', adapter.getPlatformName());
  }

  function disableAutoSave() {
    if (!autoSaveEnabled) return;
    autoSaveEnabled = false;
    if (typeof adapter.destroy === 'function') {
      // 只停观察器，保留适配器实例；重新绑定回调需再次 enable
      adapter.destroy();
    }
    adapter._updateCallback = null;
    console.log('[ACM] 自动保存已关闭:', adapter.getPlatformName());
  }

  try {
    chrome.storage.local.get('acm_settings', (result) => {
      if (chrome.runtime.lastError) return;
      const settings = result.acm_settings || {};
      // 未写入过设置时默认开启自动保存
      const enabled = settings.autoSave !== false;
      if (enabled) enableAutoSave();
      else console.log('[ACM] 自动保存已关闭（设置中）:', adapter.getPlatformName());
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.acm_settings) return;
      const next = changes.acm_settings.newValue || {};
      if (next.autoSave !== false) enableAutoSave();
      else disableAutoSave();
    });
  } catch {
    // 扩展上下文已失效，忽略
  }
})();
