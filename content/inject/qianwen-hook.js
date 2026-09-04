/**
 * 千问页面主环境：仅拦截 session/msg/list，绝不碰 /chat 流式接口
 */
(function () {
  if (window.__acmQianwenHooked) return;
  window.__acmQianwenHooked = true;

  function isChatStreamUrl(url) {
    if (typeof url !== 'string') return false;
    return /\/api\/v2\/chat(\?|$)/i.test(url) || /\/chat\?/.test(url) || /event-stream/i.test(url);
  }

  function isHistoryUrl(url) {
    if (typeof url !== 'string' || isChatStreamUrl(url)) return false;
    return /\/session\/msg\/list/i.test(url) || /\/session\/.*\/history/i.test(url);
  }

  function extractSessionId(url) {
    try {
      const u = new URL(url, location.origin);
      return u.searchParams.get('session_id') || u.searchParams.get('sessionId');
    } catch {
      return null;
    }
  }

  function isJsonResponse(res) {
    const ct = (res.headers && res.headers.get('content-type')) || '';
    return /application\/json/i.test(ct) || /text\/json/i.test(ct) || /text\/plain/i.test(ct);
  }

  function publish(sessionId, payload) {
    if (!payload) return;
    document.dispatchEvent(
      new CustomEvent('acm-qianwen-history', {
        detail: { sessionId, payload },
        bubbles: true
      })
    );
  }

  async function fetchHistoryInPage(sessionId, page = 1, pageSize = 50) {
    const params = new URLSearchParams({
      biz_id: 'ai_qwen',
      chat_client: 'h5',
      device: 'pc',
      fr: 'pc',
      pr: 'qwen',
      session_id: sessionId,
      page_size: String(pageSize),
      page: String(page),
      forward: 'false',
      include_pos: 'false',
      return_response_messages: 'true',
      event_filter: 'all',
      nonce: Math.random().toString(36).slice(2, 14),
      timestamp: String(Date.now())
    });

    const hosts = [
      'https://chat2-api.qianwen.com/api/v1/session/msg/list',
      'https://chat2.qianwen.com/api/v1/session/msg/list'
    ];

    for (const base of hosts) {
      try {
        const res = await origFetch(`${base}?${params}`, {
          credentials: 'include',
          headers: {
            Accept: 'application/json, text/plain, */*',
            'x-platform': 'pc_tongyi'
          }
        });
        if (!res.ok) continue;
        const payload = await res.json();
        publish(sessionId, payload);
        return payload;
      } catch {
        // try next host
      }
    }
    return null;
  }

  document.addEventListener('acm-qianwen-fetch-request', async (event) => {
    const { requestId, sessionId, page, pageSize } = event.detail || {};
    if (!requestId || !sessionId) return;
    try {
      const payload = await fetchHistoryInPage(sessionId, page || 1, pageSize || 50);
      document.dispatchEvent(
        new CustomEvent('acm-qianwen-fetch-response', {
          detail: { requestId, sessionId, payload, ok: !!payload },
          bubbles: true
        })
      );
    } catch (err) {
      document.dispatchEvent(
        new CustomEvent('acm-qianwen-fetch-response', {
          detail: { requestId, sessionId, payload: null, ok: false, error: err?.message },
          bubbles: true
        })
      );
    }
  });

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (isHistoryUrl(url) && isJsonResponse(res)) {
        const clone = res.clone();
        clone
          .json()
          .then((data) => publish(extractSessionId(url), data))
          .catch(() => {});
      }
    } catch {
      // ignore
    }
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__acmUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (isHistoryUrl(this.__acmUrl)) {
      this.addEventListener('load', function () {
        try {
          if (this.status >= 200 && this.status < 300) {
            publish(extractSessionId(this.__acmUrl), JSON.parse(this.responseText));
          }
        } catch {
          // ignore
        }
      });
    }
    return origSend.apply(this, args);
  };
})();
