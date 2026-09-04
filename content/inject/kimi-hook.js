/**
 * Kimi 页面主环境：缓存 ListMessages / segment/scroll + 响应主动拉取
 * 绝不碰聊天流式接口
 */
(function () {
  if (window.__acmKimiHookVer === '1') return;
  window.__acmKimiHookVer = '1';
  window.__acmKimiHooked = true;

  function isStreamUrl(url) {
    return typeof url === 'string' && /completion|stream|sse|event-stream/i.test(url);
  }

  function isHistoryUrl(url) {
    if (typeof url !== 'string' || isStreamUrl(url)) return false;
    return (
      /ListMessages/i.test(url) ||
      /\/api\/chat\/[^/]+\/segment\/scroll/i.test(url) ||
      /\/api\/chat\/[^/]+\/segment/i.test(url) ||
      (/\/apiv2\/.*ChatService/i.test(url) && /ListMessages|GetChat/i.test(url))
    );
  }

  function extractChatId(url, bodyText) {
    try {
      if (bodyText) {
        const parsed = typeof bodyText === 'string' ? JSON.parse(bodyText) : bodyText;
        const id = parsed?.chat_id || parsed?.chatId || parsed?.id;
        if (id) return String(id);
      }
    } catch {
      // ignore
    }
    try {
      const m = String(url || '').match(/\/api\/chat\/([0-9a-zA-Z_-]{8,})/i);
      if (m) return m[1];
    } catch {
      // ignore
    }
    try {
      const pm = (location.pathname || '').match(/\/chat\/([0-9a-zA-Z_-]{8,})/i);
      if (pm) return pm[1];
    } catch {
      // ignore
    }
    return null;
  }

  function getHeaders() {
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'X-MSH-Platform': 'web',
      'x-language': 'zh-CN'
    };
    try {
      const token = localStorage.getItem('access_token');
      if (token) headers.Authorization = `Bearer ${token}`;
    } catch {
      // ignore
    }
    return headers;
  }

  function publish(chatId, payload) {
    if (!payload) return;
    document.dispatchEvent(
      new CustomEvent('acm-kimi-history', {
        detail: { chatId: chatId || null, payload, ts: Date.now() },
        bubbles: true
      })
    );
  }

  function hasMessages(payload) {
    if (!payload) return false;
    const arr =
      payload.messages ||
      payload.items ||
      payload.data?.messages ||
      payload.data?.items ||
      payload.segments;
    return Array.isArray(arr) && arr.length > 0;
  }

  const origFetch = window.fetch;

  async function fetchInPage(chatId) {
    const endpoints = [
      {
        url: `${location.origin}/apiv2/kimi.gateway.chat.v1.ChatService/ListMessages`,
        body: { chat_id: chatId }
      },
      {
        url: `${location.origin}/apiv2/kimi.gateway.chat.v1.ChatService/ListMessages`,
        body: { chatId }
      },
      {
        url: `${location.origin}/api/chat/${encodeURIComponent(chatId)}/segment/scroll`,
        body: { last_n: 200 }
      },
      {
        url: `${location.origin}/api/chat/${encodeURIComponent(chatId)}/segment/scroll`,
        body: {}
      }
    ];
    for (const ep of endpoints) {
      try {
        const res = await origFetch(ep.url, {
          method: 'POST',
          credentials: 'include',
          headers: getHeaders(),
          body: JSON.stringify(ep.body)
        });
        if (!res.ok) continue;
        const json = await res.json();
        if (!hasMessages(json)) continue;
        publish(chatId, json);
        return json;
      } catch {
        // next
      }
    }
    return null;
  }

  document.addEventListener('acm-kimi-fetch-request', async (event) => {
    const detail = event.detail || {};
    if (!detail.requestId || !detail.chatId) return;
    try {
      const payload = await fetchInPage(detail.chatId);
      document.dispatchEvent(
        new CustomEvent('acm-kimi-fetch-response', {
          detail: {
            requestId: detail.requestId,
            chatId: detail.chatId,
            payload,
            ok: !!payload
          },
          bubbles: true
        })
      );
    } catch (err) {
      document.dispatchEvent(
        new CustomEvent('acm-kimi-fetch-response', {
          detail: {
            requestId: detail.requestId,
            chatId: detail.chatId,
            payload: null,
            ok: false,
            error: err?.message
          },
          bubbles: true
        })
      );
    }
  });

  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      const init = args[1] || {};
      if (isHistoryUrl(url)) {
        res
          .clone()
          .json()
          .then((data) => publish(extractChatId(url, init.body), data))
          .catch(() => {});
      }
    } catch {
      // ignore
    }
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__acmKmUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    this.__acmKmBody = body;
    if (isHistoryUrl(this.__acmKmUrl)) {
      this.addEventListener('load', function () {
        try {
          if (this.status >= 200 && this.status < 300) {
            publish(extractChatId(this.__acmKmUrl, this.__acmKmBody), JSON.parse(this.responseText));
          }
        } catch {
          // ignore
        }
      });
    }
    return origSend.apply(this, arguments);
  };
})();
