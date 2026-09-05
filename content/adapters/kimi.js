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
        apiData.messages = this._enrichMessagesWithDomImages(apiData.messages);
        apiData.messages = this._enrichMessagesWithDomCode(apiData.messages);
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

  /** API 只有 image_search 占位时，从页面大图补 ACM_FILE（仅助手；URL 去重） */
  _enrichMessagesWithDomImages(messages) {
    if (!Array.isArray(messages) || !messages.length) return messages;
    // 先清掉误挂到用户消息的图卡
    const cleaned = messages.map((m) => {
      if (m?.role !== 'user') return m;
      const c =
        typeof stripKimiUserMediaLeak === 'function'
          ? stripKimiUserMediaLeak(m.content)
          : String(m.content || '')
              .replace(/@@ACM_FILE:\{[\s\S]*?\}@@(?:\n[^\n@]*)?/g, '')
              .trim();
      return { ...m, content: c };
    });

    const needIdx = [];
    for (let i = 0; i < cleaned.length; i++) {
      const m = cleaned[i];
      if (m?.role !== 'assistant') continue;
      const c = String(m.content || '');
      const urlCards = (c.match(/@@ACM_FILE:\{[^}]*"type":"image"[^}]*"url":"https?:[^"]+"/g) || [])
        .length;
      // 已有足够真图卡则不动
      if (urlCards >= 1 && !/image_search:\d+#\d+/i.test(c)) continue;
      if (
        /image_search:\d+#\d+/i.test(c) ||
        (/为你找到了|上图包括|找到了多张图片/i.test(c) && urlCards < 1)
      ) {
        needIdx.push(i);
      }
    }
    if (!needIdx.length) return cleaned;

    const usedGlobally = new Set();
    // 已占用的助手图 URL
    for (const m of cleaned) {
      if (m?.role !== 'assistant') continue;
      const re = /"url":"(https?:[^"]+)"/g;
      let hit;
      while ((hit = re.exec(m.content || ''))) usedGlobally.add(hit[1]);
    }

    const pageImgs = Array.from(document.querySelectorAll('img'))
      .map((img) => {
        const src = String(img.currentSrc || img.src || '').trim();
        if (!src || !/^https?:/i.test(src)) return null;
        if (/avatar|icon|logo|emoji|sprite|favicon|qrcode|badge|loading/i.test(src)) return null;
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        if (w > 0 && h > 0 && (w < 120 || h < 120)) return null;
        const rect = img.getBoundingClientRect();
        if (rect.width > 0 && rect.width < 80) return null;
        const area = Math.max(w * h, (rect.width || 0) * (rect.height || 0));
        return { src, area };
      })
      .filter(Boolean)
      .sort((a, b) => b.area - a.area);

    const uniquePage = [];
    const seenSrc = new Set();
    for (const p of pageImgs) {
      if (seenSrc.has(p.src) || usedGlobally.has(p.src)) continue;
      seenSrc.add(p.src);
      uniquePage.push(p);
    }

    let pageCursor = 0;
    return cleaned.map((m, i) => {
      if (!needIdx.includes(i)) return m;
      let c = String(m.content || '');
      const refs = [...c.matchAll(/image_search:\d+#\d+/gi)];
      const want = Math.min(Math.max(refs.length || 3, 1), 8);
      const entries = [];
      while (entries.length < want && pageCursor < uniquePage.length) {
        const p = uniquePage[pageCursor++];
        entries.push({
          url: p.src,
          title: '图片',
          ref: refs[entries.length] ? refs[entries.length][0] : `image_search:1#${entries.length}`
        });
        usedGlobally.add(p.src);
      }
      if (typeof resolveKimiImageMarkers === 'function') {
        c = resolveKimiImageMarkers(c, entries);
      }
      if (!/"url":"https?:/.test(c) && entries.length && typeof formatGeneratedFileCardsMarkdown === 'function') {
        const block = formatGeneratedFileCardsMarkdown(
          entries.map((e) => ({
            kind: 'file',
            type: 'image',
            title: '图片',
            generatedAt: '',
            url: e.url
          }))
        );
        c = c
          .replace(/image_search:\d+#\d+/gi, '')
          .replace(/(?:🛠️|🛠)/g, '')
          .replace(/[\uE000-\uF8FF]/g, '');
        c = `${c}\n\n${block}`.replace(/\n{3,}/g, '\n\n').trim();
      }
      // 去重同 URL 图卡
      if (typeof dedupeAcmFileCardsInText === 'function') {
        c = dedupeAcmFileCardsInText(c);
      }
      return { ...m, content: c };
    });
  }

  /** 代码被误存成空「文档」卡时，从页面 pre/code 补回 */
  _enrichMessagesWithDomCode(messages) {
    if (!Array.isArray(messages) || !messages.length) return messages;
    const codes = Array.from(
      document.querySelectorAll('pre code, pre, [class*="markdown"] code, [class*="code-block"] code')
    )
      .map((el) => String(el.innerText || el.textContent || '').trim())
      .filter((t) => t.length > 40)
      .sort((a, b) => b.length - a.length);
    if (!codes.length) return messages;

    let used = 0;
    return messages.map((m) => {
      if (m?.role !== 'assistant') return m;
      let c = String(m.content || '');
      const withoutCards = c
        .replace(/@@ACM_FILE:\{[\s\S]*?\}@@/g, '')
        .replace(/📎\s*\*\*[^*]+\*\*/g, '')
        .replace(/（交互式文件[^）]*）/g, '')
        .replace(/生成时间：[^\n]*/g, '')
        .trim();
      const onlyEmptyFileCard =
        /@@ACM_FILE:\{[^}]*"type":"(?:document|generated_file)"[^}]*\}@@/.test(c) &&
        withoutCards.length < 30 &&
        !/```/.test(c);
      const needsCode = onlyEmptyFileCard || (!/```/.test(c) && /代码|实现|function|计算器|html|python|javascript/i.test(c) && c.length < 200);
      if (!needsCode && /```/.test(c)) return m;
      if (!needsCode && !onlyEmptyFileCard) return m;
      const code = codes[Math.min(used, codes.length - 1)];
      if (!code) return m;
      used += 1;
      const fence = '```\n' + code + '\n```';
      if (onlyEmptyFileCard) return { ...m, content: fence };
      return { ...m, content: `${c}\n\n${fence}`.trim() };
    });
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
