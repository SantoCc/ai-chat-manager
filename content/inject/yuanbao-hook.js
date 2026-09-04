/**
 * 元宝页面主环境：只拦截真实 detail 成功响应；主动拉取时回放真实请求
 * 不再盲探 /api/conversation/*（会 404）
 */
(function () {
  if (window.__acmYuanbaoHookVer === '3') return;
  window.__acmYuanbaoHookVer = '3';
  window.__acmYuanbaoHooked = true;

  const DETAIL_PATH = '/api/user/agent/conversation/v1/detail';
  let lastGoodRequest = null; // { url, body, conversationId }

  function isChatStreamUrl(url) {
    if (typeof url !== 'string') return false;
    return /\/api\/chat\//i.test(url) && /stream|sse|completion/i.test(url);
  }

  function isHistoryUrl(url) {
    if (typeof url !== 'string' || isChatStreamUrl(url)) return false;
    // 只认 user/agent/conversation/*/detail，避免误拦其它接口
    return /\/api\/user\/agent\/conversation\/v?\d*\/?detail/i.test(url);
  }

  function parseBody(body) {
    if (!body) return null;
    if (typeof body === 'string') {
      try {
        return JSON.parse(body);
      } catch {
        return null;
      }
    }
    if (typeof body === 'object') return body;
    return null;
  }

  function extractId(bodyObjOrText) {
    const parsed =
      typeof bodyObjOrText === 'string' ? parseBody(bodyObjOrText) : bodyObjOrText;
    if (!parsed || typeof parsed !== 'object') return null;
    const id =
      parsed.conversationId ||
      parsed.conversation_id ||
      parsed.cid ||
      parsed.chatId ||
      parsed.id;
    return id ? String(id) : null;
  }

  function hasConvs(json) {
    return !!(
      json &&
      (json.convs ||
        json.data?.convs ||
        json.data?.data?.convs ||
        json.result?.convs)
    );
  }

  function publish(conversationId, payload, url, body) {
    if (!payload || !hasConvs(payload)) return;
    if (url || body) {
      lastGoodRequest = {
        url: url || DETAIL_PATH,
        body: body || { conversationId },
        conversationId: conversationId || extractId(body)
      };
    }
    document.dispatchEvent(
      new CustomEvent('acm-yuanbao-history', {
        detail: {
          conversationId: conversationId || null,
          payload,
          url: url || '',
          body: body || null,
          ts: Date.now()
        },
        bubbles: true
      })
    );
  }

  const origFetch = window.fetch;

  async function fetchDetailInPage(conversationId, agentId, lastRequest) {
    const replay = lastRequest || lastGoodRequest;
    const replayCid =
      replay?.conversationId || extractId(replay?.body) || null;
    if (
      replay?.url &&
      replay?.body &&
      (!replayCid || String(replayCid) === String(conversationId))
    ) {
      try {
        const body = { ...replay.body, conversationId };
        const res = await origFetch(replay.url, {
          method: 'POST',
          credentials: 'include',
          headers: {
            Accept: 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            Referer: location.href
          },
          body: JSON.stringify(body)
        });
        if (res.ok) {
          const json = await res.json();
          if (hasConvs(json)) {
            publish(conversationId, json, replay.url, body);
            return json;
          }
        }
      } catch {
        // fall through
      }
    }

    const bodies = [
      { conversationId },
      { conversationId, agentId: agentId || 'naQivTmsDa' }
    ];
    for (const body of bodies) {
      try {
        const res = await origFetch(DETAIL_PATH, {
          method: 'POST',
          credentials: 'include',
          headers: {
            Accept: 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            Referer: location.href
          },
          body: JSON.stringify(body)
        });
        if (!res.ok) continue;
        const json = await res.json();
        if (!hasConvs(json)) continue;
        publish(conversationId, json, DETAIL_PATH, body);
        return json;
      } catch {
        // next
      }
    }
    return null;
  }

  document.addEventListener('acm-yuanbao-fetch-request', async (event) => {
    const detail = event.detail || {};
    if (!detail.requestId || !detail.conversationId) return;
    try {
      const payload = await fetchDetailInPage(
        detail.conversationId,
        detail.agentId,
        detail.lastRequest
      );
      document.dispatchEvent(
        new CustomEvent('acm-yuanbao-fetch-response', {
          detail: {
            requestId: detail.requestId,
            conversationId: detail.conversationId,
            payload,
            ok: !!payload
          },
          bubbles: true
        })
      );
    } catch (err) {
      document.dispatchEvent(
        new CustomEvent('acm-yuanbao-fetch-response', {
          detail: {
            requestId: detail.requestId,
            conversationId: detail.conversationId,
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
    const input = args[0];
    const init = args[1] || {};
    const url = typeof input === 'string' ? input : input?.url;
    let bodyRaw = init.body;
    // Request 对象：尽量记下 body 供拦截用
    if (!bodyRaw && input && typeof input !== 'string') {
      try {
        bodyRaw = input.__acmBody || null;
      } catch {
        // ignore
      }
    }
    const res = await origFetch.apply(this, args);
    try {
      if (isHistoryUrl(url) && res.ok) {
        const parsedBody = parseBody(bodyRaw);
        res
          .clone()
          .json()
          .then((data) => {
            publish(extractId(parsedBody) || extractId(bodyRaw), data, url, parsedBody);
          })
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
    this.__acmYbUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    this.__acmYbBody = body;
    if (isHistoryUrl(this.__acmYbUrl)) {
      this.addEventListener('load', function () {
        try {
          if (this.status >= 200 && this.status < 300) {
            const parsedBody = parseBody(this.__acmYbBody);
            publish(
              extractId(parsedBody),
              JSON.parse(this.responseText),
              this.__acmYbUrl,
              parsedBody
            );
          }
        } catch {
          // ignore
        }
      });
    }
    return origSend.apply(this, arguments);
  };
})();
