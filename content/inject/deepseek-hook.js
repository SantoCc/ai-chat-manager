/**
 * 注入页面主环境：仅拦截 history_messages + 代发页面 fetch（不碰聊天流）
 * 实际注入由 content/deepseek-api.js 内联完成；本文件保留作对照。
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

  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (isHistoryUrl(url)) {
        res
          .clone()
          .json()
          .then((data) => publishHistory(extractSessionId(url), data))
          .catch(() => {});
      }
    } catch {
      // ignore
    }
    return res;
  };
})();
