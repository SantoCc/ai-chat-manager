/**
 * 通义千问适配器
 * 三级兜底：页面状态 chatRounds → chat2-api → DOM
 * 自动保存：流式结束 / DOM 变更 / 定时巡检（对齐豆包）
 */
const QIANWEN_SELECTORS = {
  stopButton: [
    'button[data-testid*="stop"]',
    'button[aria-label*="停止"]',
    'button[aria-label*="Stop"]',
    'button[class*="stop"]'
  ].join(', '),
  chatContainer: 'main, [class*="chat"], [class*="conversation"], #root, #ice-container'
};

class QianwenAdapter extends BaseAdapter {
  constructor() {
    super();
    this._autoSaveArmed = false;
    this._wasStreaming = false;
    this._lastAutoFingerprint = '';
    this._autoSaveInFlight = false;
    this._streamPollTimer = null;
    this._autoSaveTimer = null;
    this._idlePollTimer = null;
  }

  getPlatformName() {
    return 'qianwen';
  }

  getConversationTitle() {
    const title = document.title || '';
    const cleaned = title
      .replace(/\s*[-|–—]\s*(通义千问|千问|Qwen|Tongyi|阿里).*$/i, '')
      .replace(/^Qwen[\d.]*\s*[-|–—]?\s*/i, '')
      .replace(/\s*[-|–—]\s*.*$/, '')
      .trim();
    if (cleaned && cleaned.length > 1 && !/^(千问|通义千问|Qwen)$/i.test(cleaned)) {
      return cleaned;
    }
    return '';
  }

  hasConversation() {
    const id =
      typeof getQianwenSessionId === 'function' ? getQianwenSessionId() : null;
    if (id) return true;
    return this._extractDomMessages().length > 0;
  }

  parseConversation() {
    const messages = this._extractDomMessages();
    if (!messages.length) {
      return {
        title: this.getConversationTitle() || '未命名对话',
        messages: [],
        url: location.href,
        platform: 'qianwen',
        source: 'dom',
        error: '当前页面没有可保存的对话内容'
      };
    }
    return this._buildResult(messages, this._titleFromMessages(messages), {
      source: 'dom',
      sessionId: typeof getQianwenSessionId === 'function' ? getQianwenSessionId() : null
    });
  }

  async parseConversationAsync() {
    if (this._isStreaming()) {
      return { error: 'AI正在回答中，请等待完成后再保存' };
    }

    let sessionId =
      typeof resolveQianwenSessionId === 'function'
        ? await resolveQianwenSessionId()
        : typeof getQianwenSessionId === 'function'
          ? getQianwenSessionId()
          : null;

    let apiError = null;
    let partial = null;

    if (typeof fetchQianwenConversation === 'function') {
      try {
        const apiData = await fetchQianwenConversation(sessionId);
        if (apiData?.messages?.length) {
          let messages = apiData.messages;
          const userCount = messages.filter((m) => m.role === 'user').length;
          const asstCount = messages.filter((m) => m.role === 'assistant').length;
          // 缺轮次，或正文缺少 Markdown 格式时，用 DOM 补齐/保留版式
          const lacksFormat = messages.some(
            (m) =>
              m.role === 'assistant' &&
              m.content &&
              m.content.length > 200 &&
              !/\*\*|^\|.+\|$/m.test(m.content)
          );
          if (asstCount < userCount || asstCount === 0 || userCount === 0 || lacksFormat) {
            const dom = this._extractDomMessages();
            messages = this._mergeMessages(messages, dom);
          }
          if (typeof normalizeQianwenMessages === 'function') {
            messages = normalizeQianwenMessages(messages);
          }
          // 若助手正文仍是卡片 JSON，强制再用 DOM 抽文字说明
          const asstJunk = messages.some(
            (m) =>
              m.role === 'assistant' &&
              typeof isQianwenStructuredJunk === 'function' &&
              isQianwenStructuredJunk(m.content)
          );
          if (asstJunk) {
            const dom = this._extractDomMessages();
            messages = this._mergeMessages(
              messages.filter(
                (m) =>
                  m.role === 'user' ||
                  !(typeof isQianwenStructuredJunk === 'function' && isQianwenStructuredJunk(m.content))
              ),
              dom
            );
          }
          if (messages.some((m) => m.role === 'assistant') || messages.length) {
            const title =
              this._titleFromMessages(messages) ||
              this.getConversationTitle() ||
              '未命名对话';
            console.log(
              '[ACM Qianwen] 保存',
              messages.length,
              '条 via',
              apiData.fetchSource || apiData.source,
              'chars=',
              messages.reduce((n, m) => n + String(m.content || '').length, 0)
            );
            return this._buildResult(messages, title, {
              source: apiData.fetchSource === 'page-state-partial' ? 'dom' : 'api',
              sessionId: apiData.sessionId || sessionId
            });
          }
          partial = apiData.messages;
        }
        apiError = 'api_empty';
      } catch (err) {
        console.error('[ACM Qianwen] API 失败:', err);
        apiError = err?.message || String(err);
      }
    }

    const domMessages = this._extractDomMessages();
    const merged = this._mergeMessages(partial, domMessages);
    if (merged.length) {
      console.warn('[ACM Qianwen] 已回退 DOM/合并', apiError || 'no_session');
      return this._buildResult(
        merged,
        this._titleFromMessages(merged) || this.getConversationTitle() || '未命名对话',
        { source: 'dom', sessionId }
      );
    }

    if (!sessionId) {
      return {
        error: '未识别千问会话。请打开具体对话后再保存（首页空白会话无法保存）'
      };
    }

    if (this._looksLikeDnsOrNetwork(apiError)) {
      return {
        error:
          '千问接口不可达，且页面也未读到完整对话。请刷新后重试；控制台 bilibili/quark 报错多为回答内视频卡片，与保存无关'
      };
    }

    return {
      error: `千问未读到对话内容（${String(apiError || '').slice(0, 80)}）`
    };
  }

  onConversationUpdate(callback) {
    this._updateCallback = callback;
    this._startObserver();
    this._startQianwenAutoWatch();
    this._queueAutoSave('watch-start');
  }

  _startQianwenAutoWatch() {
    if (this._autoSaveArmed) return;
    this._autoSaveArmed = true;
    console.log('[ACM Qianwen] 自动保存监视已启动');

    this._streamPollTimer = setInterval(() => {
      const streaming = this._isStreaming();
      if (this._wasStreaming && !streaming) {
        this._queueAutoSave('stream-end');
      }
      this._wasStreaming = streaming;
    }, 700);

    this._idlePollTimer = setInterval(() => {
      if (!this._updateCallback || this._isStreaming()) return;
      if (!this.hasConversation() && !this._extractDomMessages().length) return;
      this._queueAutoSave('idle-poll');
    }, 4500);
  }

  _queueAutoSave(reason) {
    if (!this._updateCallback) return;
    clearTimeout(this._autoSaveTimer);
    const delay =
      reason === 'stream-end' ? 2200 : reason === 'idle-poll' ? 500 : 1200;
    this._autoSaveTimer = setTimeout(() => this._runAutoSave(reason, 0), delay);
  }

  async _runAutoSave(reason, attempt) {
    if (!this._updateCallback) return;
    if (this._autoSaveInFlight) {
      this._autoSaveTimer = setTimeout(() => this._runAutoSave(reason, attempt), 800);
      return;
    }
    if (this._isStreaming()) {
      this._wasStreaming = true;
      this._autoSaveTimer = setTimeout(() => this._runAutoSave(reason, attempt), 1200);
      return;
    }

    this._autoSaveInFlight = true;
    try {
      const data = await this.parseConversationAsync();
      if (data?.error || !data?.messages?.length) {
        if (attempt < 6) {
          this._autoSaveTimer = setTimeout(() => {
            this._autoSaveInFlight = false;
            this._runAutoSave(reason, attempt + 1);
          }, 1000 + attempt * 400);
          return;
        }
        return;
      }

      // 自动保存要求至少有一条 AI 回答，避免只存提问
      if (!data.messages.some((m) => m.role === 'assistant')) {
        if (attempt < 5) {
          this._autoSaveTimer = setTimeout(() => {
            this._autoSaveInFlight = false;
            this._runAutoSave(reason, attempt + 1);
          }, 1500);
          return;
        }
      }

      const last = data.messages[data.messages.length - 1];
      const fp = [
        data.sessionId || '',
        data.messages.length,
        last?.role || '',
        String(last?.content || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120)
      ].join('|');
      if (fp === this._lastAutoFingerprint) return;
      this._lastAutoFingerprint = fp;
      console.log('[ACM Qianwen] 自动保存触发:', reason, data.messages.length, '条');
      this._updateCallback(data);
    } catch (err) {
      console.warn('[ACM Qianwen] 自动保存异常:', err);
      if (attempt < 4) {
        this._autoSaveTimer = setTimeout(() => {
          this._autoSaveInFlight = false;
          this._runAutoSave(reason, attempt + 1);
        }, 1500);
        return;
      }
    } finally {
      this._autoSaveInFlight = false;
    }
  }

  _titleFromMessages(messages) {
    const user = (messages || []).find((m) => m.role === 'user' && m.content);
    if (!user) return '';
    const t = String(user.content).replace(/\s+/g, ' ').trim();
    return t.slice(0, 40) + (t.length > 40 ? '…' : '');
  }

  _mergeMessages(a, b) {
    // 主键 a 优先；若 a 为纯文本而 b 含 Markdown 格式（粗体/表格），选用 b 以保留版式
    const left = Array.isArray(a) ? a : [];
    const right = Array.isArray(b) ? b : [];
    const byRole = (list, role) =>
      list.filter((m) => m?.role === role && String(m.content || '').trim());
    const isJunk = (m) => {
      if (!m?.content) return true;
      if (typeof isQianwenStructuredJunk === 'function') {
        return isQianwenStructuredJunk(m.content);
      }
      return (
        /"gaokao_choice_report"|"zhiyuan_table"|"initialData"|"reqId"/.test(m.content) &&
        m.content.length > 120
      );
    };
    const richer = (x, y) => {
      if (!x || isJunk(x)) return y && !isJunk(y) ? y : x || y;
      if (!y || isJunk(y)) return x;
      // 永远不要用更长的 JSON 卡片覆盖自然语言
      if (y.content.length > x.content.length * 1.1) return y;
      if (x.content.length > y.content.length * 1.1) return x;
      const xMd = /\*\*|\n\|.+\|\n\|?\s*-{3,}/.test(x.content);
      const yMd = /\*\*|\n\|.+\|\n\|?\s*-{3,}/.test(y.content);
      if (!xMd && yMd && y.content.length >= x.content.length * 0.9) return y;
      if (xMd && !yMd && x.content.length < y.content.length * 0.9) return y;
      return x.content.length >= y.content.length ? x : y;
    };
    const usersL = byRole(left, 'user');
    const usersR = byRole(right, 'user');
    const asstL = byRole(left, 'assistant');
    const asstR = byRole(right, 'assistant');
    const users = [];
    const assistants = [];
    for (let i = 0; i < Math.max(usersL.length, usersR.length); i++) {
      users.push(richer(usersL[i], usersR[i]));
    }
    for (let i = 0; i < Math.max(asstL.length, asstR.length); i++) {
      assistants.push(richer(asstL[i], asstR[i]));
    }
    const paired = [];
    const n = Math.max(users.length, assistants.length);
    for (let i = 0; i < n; i++) {
      if (users[i]) {
        paired.push({
          role: 'user',
          content: String(users[i].content).trim(),
          timestamp: users[i].timestamp || null
        });
      }
      if (assistants[i]) {
        paired.push({
          role: 'assistant',
          content: String(assistants[i].content).trim(),
          timestamp: assistants[i].timestamp || null
        });
      }
    }
    if (typeof normalizeQianwenMessages === 'function') {
      return normalizeQianwenMessages(paired);
    }
    return paired;
  }

  _looksLikeDnsOrNetwork(msg) {
    const s = String(msg || '').toLowerCase();
    return (
      s.includes('failed to fetch') ||
      s.includes('networkerror') ||
      s.includes('dns') ||
      s.includes('name_not_resolved') ||
      s.includes('err_name') ||
      s.includes('abort') ||
      s.includes('unreachable')
    );
  }

  _extractDomMessages() {
    const strategies = [
      () => this._byRoleAttrs(),
      () => this._byQwenLikeBlocks(),
      () => this._byAlternatingBubbles()
    ];
    for (const fn of strategies) {
      const msgs = fn();
      // 优先返回同时含问答的结果
      if (msgs.some((m) => m.role === 'user') && msgs.some((m) => m.role === 'assistant')) {
        return this._dedupe(msgs);
      }
    }
    for (const fn of strategies) {
      const msgs = fn();
      if (msgs.length >= 1) return this._dedupe(msgs);
    }
    return [];
  }

  _byRoleAttrs() {
    const nodes = Array.from(
      document.querySelectorAll(
        [
          '[data-role="user"]',
          '[data-role="assistant"]',
          '[data-message-role]',
          '[class*="questionItem"]',
          '[class*="answerItem"]',
          '[class*="user-message"]',
          '[class*="assistant-message"]',
          '[class*="message-select-wrapper-question"]',
          '[class*="message-select-wrapper-answer"]',
          '[class*="messageSelectWrapperQuestion"]',
          '[class*="messageSelectWrapperAnswer"]'
        ].join(', ')
      )
    );
    const messages = [];
    for (const el of nodes) {
      if (this._isNoise(el)) continue;
      const md = el.querySelector?.('.qk-markdown, [class*="qk-markdown"]');
      const content = this._read(md || el);
      if (!content || content.length < 1) continue;
      let role = null;
      const dr =
        el.getAttribute('data-role') ||
        el.getAttribute('data-message-role') ||
        '';
      if (/user|human|question/i.test(dr)) role = 'user';
      else if (/assistant|bot|answer|ai/i.test(dr)) role = 'assistant';
      else {
        const cls = (el.className || '').toString();
        if (/question|user-message|userMsg|wrapper-question/i.test(cls)) role = 'user';
        else if (/answer|assistant|bot|wrapper-answer/i.test(cls)) role = 'assistant';
      }
      if (role) messages.push({ role, content });
    }
    return messages;
  }

  _byQwenLikeBlocks() {
    const questionNodes = Array.from(
      document.querySelectorAll(
        '[class*="message-select-wrapper-question"], [class*="questionItem"], [class*="wrapper-question"]'
      )
    );
    const answerWrappers = Array.from(
      document.querySelectorAll(
        [
          '[class*="message-select-wrapper-answer"]',
          '[class*="messageSelectWrapperAnswer"]',
          '[class*="wrapper-answer"]'
        ].join(',')
      )
    );

    const users = [];
    for (const el of questionNodes) {
      if (this._isNoise(el)) continue;
      // 跳过思考折叠区里的伪提问
      if (el.closest?.('[class*="deep_think"], [class*="deep-think"], [class*="DeepThink"]')) {
        continue;
      }
      const content = this._read(el);
      if (content) users.push({ role: 'user', content });
    }

    // 每个回答容器：去掉思考区后转 Markdown；多块正文按顺序拼接
    const assistants = [];
    for (const wrap of answerWrappers) {
      if (this._isNoise(wrap)) continue;
      const clone = wrap.cloneNode(true);
      clone
        .querySelectorAll(
          [
            '[class*="deep_think"]',
            '[class*="deep-think"]',
            '[class*="DeepThink"]',
            '[class*="thinking"]',
            '[class*="Thinking"]',
            '[class*="ThinkBlock"]',
            '[class*="plugin-deep"]',
            '[data-content-type="think"]',
            '[data-type="think"]',
            'script',
            'noscript',
            '[class*="gaokao"]',
            '[class*="Gaokao"]',
            '[class*="zhiyuan"]',
            '[class*="Zhiyuan"]',
            '[class*="choice-report"]',
            '[class*="choiceReport"]',
            '[class*="report-card"]',
            '[class*="ReportCard"]'
          ].join(',')
        )
        .forEach((el) => el.remove());

      const mds = Array.from(
        clone.querySelectorAll('.qk-markdown, [class*="qk-markdown"]')
      ).filter((el) => {
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!t) return false;
        if (
          typeof isQianwenThinkingFragment === 'function' &&
          isQianwenThinkingFragment(t) &&
          t.length < 800
        ) {
          return false;
        }
        if (/^(已完成思考|Finished thinking)/i.test(t) && t.length < 800) return false;
        return true;
      });

      let content = '';
      if (mds.length && typeof extractMarkdownFromElement === 'function') {
        content = mds
          .map((el) => extractMarkdownFromElement(el))
          .filter(Boolean)
          .join('\n\n');
      } else if (typeof extractMarkdownFromElement === 'function') {
        content = extractMarkdownFromElement(clone);
      } else {
        content = this._read(clone);
      }
      if (typeof stripQianwenThinkingProcess === 'function') {
        content = stripQianwenThinkingProcess(content);
      }
      if (content) assistants.push({ role: 'assistant', content });
    }

    if (users.length || assistants.length) {
      const messages = [];
      const n = Math.max(users.length, assistants.length);
      for (let i = 0; i < n; i++) {
        if (users[i]) messages.push(users[i]);
        if (assistants[i]) messages.push(assistants[i]);
      }
      return messages;
    }

    const messages = [];
    const mdBlocks = Array.from(
      document.querySelectorAll('.qk-markdown, [class*="qk-markdown"]')
    ).filter((el) => {
      if (this._isNoise(el)) return false;
      const t = (el.innerText || '').trim();
      return t.length >= 2 && t.length < 50000;
    });

    for (const el of mdBlocks) {
      const content = this._read(el);
      if (!content) continue;
      const role = this._inferRole(el) || 'assistant';
      messages.push({ role, content });
    }
    return messages;
  }

  _byAlternatingBubbles() {
    const main =
      document.querySelector('main') ||
      document.querySelector('[class*="conversation"]') ||
      document.querySelector('#ice-container') ||
      document.body;

    const blocks = Array.from(main.querySelectorAll('div, article, section')).filter((el) => {
      if (this._isNoise(el)) return false;
      if (el.children.length > 12) return false;
      const t = (el.innerText || '').trim();
      if (t.length < 4 || t.length > 12000) return false;
      const childTextLen = Array.from(el.children).reduce(
        (s, c) => s + ((c.innerText || '').trim().length || 0),
        0
      );
      return childTextLen < t.length * 0.95;
    });

    const top = blocks
      .filter((el) => !blocks.some((o) => o !== el && o.contains(el)))
      .slice(0, 40);

    const messages = [];
    for (const el of top) {
      const content = this._read(el);
      if (!content) continue;
      if (/^(向千问提问|登录|新对话|发送)$/i.test(content)) continue;
      const role = this._inferRole(el);
      if (!role) continue;
      messages.push({ role, content });
    }
    return messages;
  }

  _inferRole(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const cls = (n.className || '').toString().toLowerCase();
      const roleAttr = (n.getAttribute?.('data-role') || '').toLowerCase();
      if (roleAttr === 'user' || /question|user-msg|usermessage|human|wrapper-question/.test(cls)) {
        return 'user';
      }
      if (
        roleAttr === 'assistant' ||
        /answer|assistant|bot-msg|aimessage|response|wrapper-answer/.test(cls)
      ) {
        return 'assistant';
      }
    }
    try {
      let n = el;
      for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
        const style = window.getComputedStyle(n);
        if (style.alignSelf === 'flex-end' || style.marginLeft === 'auto') return 'user';
        if (style.alignSelf === 'flex-start') return 'assistant';
      }
    } catch {
      // ignore
    }
    return null;
  }

  _isNoise(el) {
    if (!el || !el.closest) return true;
    if (el.closest('nav, aside, header, footer, [class*="sidebar"], [class*="SideBar"]')) {
      return true;
    }
    if (el.closest('textarea, input, [contenteditable="true"]')) return true;
    // 深度思考折叠区
    if (
      el.closest(
        '[class*="deep_think"], [class*="deep-think"], [class*="DeepThink"], [class*="thinking"]'
      )
    ) {
      return true;
    }
    return false;
  }

  _isNoiseText() {
    return false;
  }

  _read(el) {
    if (!el) return '';
    if (typeof extractMarkdownFromElement === 'function') {
      return extractMarkdownFromElement(el).trim();
    }
    return (el.innerText || el.textContent || '').trim();
  }

  _dedupe(messages) {
    const result = [];
    for (const msg of messages) {
      const content = String(msg.content || '').trim();
      if (!content) continue;
      const prev = result[result.length - 1];
      if (prev && prev.role === msg.role && String(prev.content).trim() === content) {
        continue;
      }
      result.push(msg);
    }
    if (typeof normalizeQianwenMessages === 'function') {
      return normalizeQianwenMessages(result);
    }
    return result;
  }

  _getObserveTarget() {
    return document.querySelector(QIANWEN_SELECTORS.chatContainer) || document.body;
  }

  _isStreaming() {
    const stopBtn = document.querySelector(QIANWEN_SELECTORS.stopButton);
    if (stopBtn) {
      const style = window.getComputedStyle?.(stopBtn);
      const visible =
        stopBtn.offsetParent !== null ||
        (style && style.display !== 'none' && style.visibility !== 'hidden');
      if (visible) return true;
    }
    return false;
  }

  destroy() {
    if (this._streamPollTimer) {
      clearInterval(this._streamPollTimer);
      this._streamPollTimer = null;
    }
    if (this._idlePollTimer) {
      clearInterval(this._idlePollTimer);
      this._idlePollTimer = null;
    }
    clearTimeout(this._autoSaveTimer);
    this._autoSaveArmed = false;
    super.destroy();
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.QianwenAdapter = QianwenAdapter;
}
