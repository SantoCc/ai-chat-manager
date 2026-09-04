/**
 * 豆包页面主环境：缓存历史接口 + 响应 postMessage 主动拉取
 * 目标：/im/chain/*、/alice/message/list*
 * 绝不碰聊天流式接口
 */
(function () {
  if (window.__acmDoubaoHookVer === '4') return;
  window.__acmDoubaoHookVer = '4';
  window.__acmDoubaoHooked = true;

  function isChatStreamUrl(url) {
    if (typeof url !== 'string') return false;
    return (
      /\/chat\/completion/i.test(url) ||
      /\/completion/i.test(url) ||
      /stream_call/i.test(url) ||
      /\/async\/stream/i.test(url) ||
      /\/sse/i.test(url)
    );
  }

  function isHistoryUrl(url) {
    if (typeof url !== 'string' || isChatStreamUrl(url)) return false;
    return /\/im\/chain\//i.test(url) || /\/alice\/message\/list/i.test(url);
  }

  function extractConversationId(url, bodyText) {
    try {
      if (bodyText) {
        const parsed = typeof bodyText === 'string' ? JSON.parse(bodyText) : bodyText;
        const uplink =
          parsed?.uplink_body?.pull_singe_chain_uplink_body ||
          parsed?.pull_singe_chain_uplink_body ||
          parsed;
        const id =
          uplink?.conversation_id ||
          parsed?.conversation_id ||
          parsed?.data?.conversation_id;
        if (id && id !== '0') return String(id);
      }
    } catch {
      // ignore
    }
    try {
      const u = new URL(url, location.origin);
      return u.searchParams.get('conversation_id') || null;
    } catch {
      return null;
    }
  }

  function publish(conversationId, payload, url) {
    document.dispatchEvent(
      new CustomEvent('acm-doubao-history', {
        detail: { conversationId, payload, url, ts: Date.now() },
        bubbles: true
      })
    );
    try {
      window.postMessage(
        {
          source: 'acm-doubao',
          type: 'history',
          conversationId: conversationId || null,
          url: url || '',
          ts: Date.now()
        },
        '*'
      );
    } catch {
      // ignore
    }
  }

  function buildCommonParams() {
    try {
      const live = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .reverse()
        .find((u) => (u.includes('/im/') || u.includes('/alice/')) && u.includes('?'));
      if (live) {
        const p = new URL(live).searchParams;
        p.delete('a_bogus');
        p.delete('msToken');
        if (p.get('aid') || p.get('version_code')) return p;
      }
    } catch {
      // ignore
    }
    const params = new URLSearchParams({
      version_code: '20800',
      language: 'zh',
      device_platform: 'web',
      doubao_device_platform: 'web',
      aid: '497858',
      real_aid: '497858',
      pkg_type: 'release_version',
      region: 'CN',
      sys_region: 'CN',
      samantha_web: '1',
      web_platform: 'browser',
      'use-olympus-account': '1'
    });
    params.set('web_tab_id', String(Date.now()));
    return params;
  }

  function buildImEnvelope(uplinkBody) {
    return {
      cmd: 3100,
      sequence_id: String(Date.now()),
      channel: 2,
      version: '1',
      uplink_body: { pull_singe_chain_uplink_body: uplinkBody }
    };
  }

  const origFetch = window.fetch;

  async function fetchImInPage(uplink) {
    const params = buildCommonParams();
    const url = `${location.origin}/im/chain/single?${params.toString()}`;
    const res = await origFetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json; encoding=utf-8',
        'agw-js-conv': 'str, str',
        Referer: location.href
      },
      body: JSON.stringify(buildImEnvelope(uplink))
    });
    const payload = await res.json();
    publish(uplink?.conversation_id, payload, url);
    return payload;
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'acm-doubao' || data.type !== 'fetch-request') return;
    try {
      const payload = await fetchImInPage(data.uplink);
      window.postMessage(
        {
          source: 'acm-doubao',
          type: 'fetch-response',
          requestId: data.requestId,
          payload,
          ok: !!payload
        },
        '*'
      );
    } catch (err) {
      window.postMessage(
        {
          source: 'acm-doubao',
          type: 'fetch-response',
          requestId: data.requestId,
          payload: null,
          ok: false,
          error: String(err?.message || err)
        },
        '*'
      );
    }
  });

  window.fetch = async function (...args) {
    const input = args[0];
    const init = args[1] || {};
    const url = typeof input === 'string' ? input : input?.url;
    let reqBody = init.body;
    if (!reqBody && input && typeof input !== 'string' && typeof input.clone === 'function') {
      try {
        reqBody = await input.clone().text();
      } catch {
        // ignore
      }
    }

    const res = await origFetch.apply(this, args);
    try {
      if (isHistoryUrl(url)) {
        const clone = res.clone();
        clone
          .json()
          .then((data) => {
            const cid =
              extractConversationId(url, typeof reqBody === 'string' ? reqBody : null) ||
              extractConversationId(url, null);
            publish(cid, data, url);
          })
          .catch(() => {});
      }
    } catch {
      // never block
    }
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__acmUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    this.__acmBody = body;
    if (isHistoryUrl(this.__acmUrl)) {
      this.addEventListener('load', function () {
        try {
          if (this.status >= 200 && this.status < 300) {
            const data = JSON.parse(this.responseText);
            const cid = extractConversationId(
              this.__acmUrl,
              typeof this.__acmBody === 'string' ? this.__acmBody : null
            );
            publish(cid, data, this.__acmUrl);
          }
        } catch {
          // ignore
        }
      });
    }
    return origSend.apply(this, arguments);
  };
})();
