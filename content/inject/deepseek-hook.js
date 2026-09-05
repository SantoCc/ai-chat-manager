/**
 * 注入页面主环境：仅拦截 history_messages + 代发页面 fetch（不碰聊天流）
 * 由 manifest content_scripts world:MAIN 注入；勿再内联 script（会触发站点 CSP）
 */
(function () {
  if (window.__acmDeepSeekHooked) return;
  window.__acmDeepSeekHooked = true;

  const origFetch = window.fetch;

  function isHistoryUrl(url) {
    return typeof url === 'string' && url.includes('/api/v0/chat/history_messages');
  }

  function extractSessionId(url) {
    try {
      return new URL(url, location.origin).searchParams.get('chat_session_id');
    } catch {
      return null;
    }
  }

  function getAuthToken() {
    try {
      const raw = localStorage.getItem('userToken');
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        return parsed?.value || parsed?.token || null;
      } catch {
        return raw.startsWith('Bearer ') ? raw.slice(7) : raw;
      }
    } catch {
      return null;
    }
  }

  function publishHistory(sessionId, payload) {
    if (!sessionId || !payload) return;
    document.dispatchEvent(
      new CustomEvent('acm-deepseek-history', {
        detail: { sessionId, payload },
        bubbles: true
      })
    );
  }

  async function fetchHistoryInPage(sessionId, offset, limit) {
    const params = new URLSearchParams({ chat_session_id: sessionId });
    if (typeof offset === 'number' && typeof limit === 'number') {
      params.set('offset', String(offset));
      params.set('limit', String(limit));
    }
    const url = `/api/v0/chat/history_messages?${params}`;
    const token = getAuthToken();
    const headers = {
      Accept: 'application/json',
      Referer: `${location.origin}/a/chat/s/${sessionId}`,
      'x-client-platform': 'web',
      'x-client-locale': 'zh_CN'
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await origFetch(url, { credentials: 'include', headers });
    if (!res.ok) return null;
    const payload = await res.json();
    if (payload?.code !== 0 && payload?.code !== undefined) return null;
    publishHistory(sessionId, payload);
    return payload;
  }

  document.addEventListener('acm-deepseek-fetch-request', async (event) => {
    const { requestId, sessionId, offset, limit } = event.detail || {};
    if (!requestId || !sessionId) return;
    try {
      const payload = await fetchHistoryInPage(sessionId, offset, limit);
      document.dispatchEvent(
        new CustomEvent('acm-deepseek-fetch-response', {
          detail: { requestId, sessionId, payload, ok: !!payload },
          bubbles: true
        })
      );
    } catch (err) {
      document.dispatchEvent(
        new CustomEvent('acm-deepseek-fetch-response', {
          detail: {
            requestId,
            sessionId,
            payload: null,
            ok: false,
            error: err?.message
          },
          bubbles: true
        })
      );
    }
  });

  // 仅包装 history 请求；其它 fetch 原样转发，避免站点埋点/DNS 失败红字挂到本文件
  window.fetch = function (...args) {
    const input = args[0];
    const url = typeof input === 'string' ? input : input && input.url;
    if (!isHistoryUrl(url)) {
      return origFetch.apply(this, args);
    }
    return origFetch.apply(this, args).then((res) => {
      try {
        res
          .clone()
          .json()
          .then((data) => publishHistory(extractSessionId(url), data))
          .catch(() => {});
      } catch {
        // ignore
      }
      return res;
    });
  };

  // 不再包装 XHR：DeepSeek 埋点等会走 XHR，包装后失败红字会误标为 deepseek-hook.js
})();
