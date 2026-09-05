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
  chatContainer: 'main, [class*="chat"], [class*="conversation"], #root, #ice-container',
  markdownRoot: [
    '#qk-markdown-react',
    '[id*="qk-markdown"]',
    '.qk-markdown',
    '[class*="qk-markdown"]',
    '[class*="qwen-markdown"]',
    '[class*="QwenMarkdown"]',
    '[class*="custom-qwen-markdown"]',
    '[class*="phase-answer"]',
    '[class*="response-message-content"]'
  ].join(', '),
  answerWrap: [
    '[data-chat-answers-wrap]',
    '[class*="message-select-wrapper-answer"]',
    '[class*="messageSelectWrapperAnswer"]',
    '[class*="wrapper-answer"]',
    '[class*="answer-common-card"]',
    '[class*="qwen-chat-message-assistant"]',
    '[class*="chat-response-message"]',
    '[class*="answerItem"]'
  ].join(', '),
  questionWrap: [
    '[data-chat-question-wrap]',
    '[class*="message-select-wrapper-question"]',
    '[class*="messageSelectWrapperQuestion"]',
    '[class*="wrapper-question"]',
    '[class*="question-text-card"]',
    '[class*="questionItem"]'
  ].join(', ')
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
    if (this._isStreaming() || this._isImageGenPending()) {
      return { error: 'AI正在生成中（含生图），请等待完成后再保存' };
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
          // DOM 作主键合并 API：版式以页面渲染为准，API 仅补缺轮/补图卡
          const dom = this._extractDomMessages();
          if (dom.length) {
            messages = this._mergeMessages(dom, messages);
            messages = this._forceDomFormat(messages, dom);
            if (asstCount < userCount || asstCount === 0 || userCount === 0) {
              console.warn('[ACM Qianwen] 轮次不齐，已与 DOM 合并', {
                apiUsers: userCount,
                apiAsst: asstCount,
                dom: dom.length
              });
            }
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

  /**
   * 页面可见 Markdown 优先：状态扁平（无换行/无粗体）时整段换 DOM，不改写原文。
   * 完整度优先：半截折叠 DOM 绝不能盖掉更长的 API/状态正文。
   */
  _forceDomFormat(messages, dom) {
    const domAsst = (dom || []).filter((m) => m.role === 'assistant');
    if (!domAsst.length) return messages;
    let ai = 0;
    const looksTruncated = (text) => {
      if (typeof looksLikeTruncatedAssistantText === 'function') {
        return looksLikeTruncatedAssistantText(text);
      }
      const t = String(text || '').trim();
      if (!t) return true;
      if (/^[，、。；：！？,.!?]/.test(t)) return true;
      if (/^(本的|的安全感|温饱与爱|而言，|维度来)/.test(t)) return true;
      return false;
    };
    const isPrefix = (short, long) =>
      typeof isQianwenContentPrefixOf === 'function'
        ? isQianwenContentPrefixOf(short, long)
        : false;
    const hasFormat = (t) => {
      const s = String(t || '');
      return (
        (s.match(/\n/g) || []).length >= 1 ||
        /\*\*[^*\n]+\*\*/.test(s) ||
        /^(\d+\.|[-*+])\s/m.test(s) ||
        (typeof hasMarkdownTable === 'function' && hasMarkdownTable(s)) ||
        /^\|.+\|/m.test(s)
      );
    };
    const mashed =
      typeof looksLikeMashedTable === 'function'
        ? looksLikeMashedTable
        : (t) => /表格下载为表格|章节内容摘要/.test(String(t || '').replace(/\s+/g, ''));
    const hasTable =
      typeof hasMarkdownTable === 'function'
        ? hasMarkdownTable
        : (t) => /^\|.+\|/m.test(String(t || '')) && /\|?\s*:?-{3,}/m.test(String(t || ''));
    const norm = (t) => String(t || '').replace(/\s+/g, '');
    const keepApi = (m, api) => {
      if (typeof stripQianwenCardSoup === 'function') {
        return { ...m, content: stripQianwenCardSoup(api) };
      }
      return m;
    };
    return (messages || []).map((m) => {
      if (m.role !== 'assistant') return m;
      const d = domAsst[ai++];
      if (!d?.content) return m;
      const api = String(m.content || '');
      const domText = String(d.content || '');
      const soup =
        typeof looksLikeQianwenCardSoup === 'function' && looksLikeQianwenCardSoup(api);
      const domSoup =
        typeof looksLikeQianwenCardSoup === 'function' && looksLikeQianwenCardSoup(domText);
      const missingHead =
        norm(domText).length > 40 && !norm(api).includes(norm(domText).slice(0, 16));
      const apiFlat = !hasFormat(api);
      const domRich = hasFormat(domText);
      const domCut = looksTruncated(domText);
      const apiCut = looksTruncated(api);

      const domIsRealAnswer =
        /已为您生成|论文概要|这就为您|Qwen-Image/.test(domText) ||
        ((domText.match(/^\d+\.\s/gm) || []).length >= 2 && /[。]/.test(domText));
      const apiIsSearchWall =
        (typeof looksLikeQianwenSearchResultWall === 'function' &&
          looksLikeQianwenSearchResultWall(api)) ||
        (soup && !/已为您生成|论文概要/.test(api));
      const domIsSearchWall =
        (typeof looksLikeQianwenSearchResultWall === 'function' &&
          looksLikeQianwenSearchResultWall(domText)) ||
        (domSoup && !domIsRealAnswer);

      // 真回答 DOM vs 检索墙 API → 用 DOM
      if (domIsRealAnswer && apiIsSearchWall) {
        return { ...m, content: domText };
      }
      // DOM 整段是检索/推荐墙 → 绝不覆盖 API
      if (domIsSearchWall && !apiIsSearchWall && api.length > 40) {
        return keepApi(m, api);
      }
      if (domSoup && !soup && api.length > 40 && !domIsRealAnswer) {
        return keepApi(m, api);
      }
      if (domSoup && soup) {
        const cleanedApi =
          typeof stripQianwenCardSoup === 'function' ? stripQianwenCardSoup(api) : api;
        const cleanedDom =
          typeof stripQianwenCardSoup === 'function' ? stripQianwenCardSoup(domText) : domText;
        const pick =
          cleanedApi && !looksLikeQianwenCardSoup?.(cleanedApi)
            ? cleanedApi
            : cleanedDom || cleanedApi || api;
        return keepApi(m, pick);
      }

      // 硬规则：DOM 是更短截断稿 → 保留更完整的 API
      if (
        api.length > 80 &&
        domText.length + 40 < api.length &&
        (domCut || isPrefix(domText, api)) &&
        !apiCut
      ) {
        return keepApi(m, api);
      }
      if (
        api.length > domText.length * 1.2 &&
        isPrefix(domText, api) &&
        !soup
      ) {
        return keepApi(m, api);
      }

      // 硬规则：DOM 有版式而状态没有 → 用 DOM（但 DOM 本身不能是截断稿/墙）
      if (
        domRich &&
        !domCut &&
        !domSoup &&
        domText.length >= api.length * 0.85 &&
        (apiFlat || looksTruncated(api) || missingHead || soup)
      ) {
        return { ...m, content: domText };
      }
      // DOM 有真表格 / API 是压扁表 → 强制 DOM
      if (
        !domCut &&
        ((hasTable(domText) && !hasTable(api)) || (mashed(api) && !mashed(domText)))
      ) {
        return { ...m, content: domText };
      }
      const dn = (domText.match(/\n/g) || []).length;
      const an = (api.match(/\n/g) || []).length;
      if (!domCut && dn > an + 1 && domText.length > 80 && domText.length >= api.length * 0.85) {
        return { ...m, content: domText };
      }
      const ds =
        typeof scoreQianwenStructure === 'function' ? scoreQianwenStructure(domText) : dn;
      const as =
        typeof scoreQianwenStructure === 'function' ? scoreQianwenStructure(api) : an;
      if (!domCut && ds > as + 4 && domText.length > 60 && domText.length >= api.length * 0.85) {
        return { ...m, content: domText };
      }
      // 同分：保留更有版式的一侧（完整度够时）
      if (!domCut && ds >= as && domRich && domText.length >= api.length * 0.9) {
        return { ...m, content: domText };
      }
      return keepApi(m, api);
    });
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
    const structureScore = (text) => {
      if (typeof scoreQianwenStructure === 'function') return scoreQianwenStructure(text);
      const t = String(text || '');
      return (t.match(/\n/g) || []).length + (t.match(/\*\*/g) || []).length;
    };
    const stripSoup =
      typeof stripQianwenCardSoup === 'function'
        ? stripQianwenCardSoup
        : (c) => String(c || '');
    const isSoup =
      typeof looksLikeQianwenCardSoup === 'function'
        ? looksLikeQianwenCardSoup
        : (c) => /bili_\w+|#/.test(String(c || ''));
    const stripMedia = (c) =>
      String(c || '')
        .replace(/@@ACM_FILE:\{[\s\S]*?\}@@[\s\S]*?(?=\n\n@@ACM_FILE:|$)/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    const richer = (x, y) => {
      // x = DOM 主键，y = API/page-state
      if (!x || isJunk(x)) return y && !isJunk(y) ? y : x || y;
      if (!y || isJunk(y)) return x;
      const xMedia = /@@ACM_FILE:/.test(x.content);
      const yMedia = /@@ACM_FILE:/.test(y.content);
      const pullMedia = (c) =>
        (String(c).match(/@@ACM_FILE:\{[\s\S]*?\}@@[\s\S]*?(?=\n\n@@ACM_FILE:|$)/g) || [])
          // 丢掉推荐图/视频卡，保留正文图、文档、报告
          .filter((block) => {
            try {
              const raw = block.match(/@@ACM_FILE:(\{[\s\S]*?\})@@/);
              const meta = raw ? JSON.parse(raw[1]) : null;
              if (!meta) return false;
              const hint = `${meta.type || ''} ${meta.title || ''} ${meta.url || ''}`;
              if (/bili_|quark|recommend|reference|#成长|#情绪/i.test(hint)) return false;
              return true;
            } catch {
              return false;
            }
          })
          .join('\n\n')
          .trim();

      let xText = stripSoup(stripMedia(x.content));
      let yText = stripSoup(stripMedia(y.content));
      if (typeof promoteFilenameLinesToFileCards === 'function') {
        xText = promoteFilenameLinesToFileCards(xText);
        yText = promoteFilenameLinesToFileCards(yText);
      }
      const xScore = structureScore(x.content);
      const yScore = structureScore(y.content);
      const xSoup = isSoup(x.content);
      const ySoup = isSoup(y.content);
      const xTable =
        typeof hasMarkdownTable === 'function'
          ? hasMarkdownTable(xText)
          : /^\|.+\|/m.test(xText);
      const yTable =
        typeof hasMarkdownTable === 'function'
          ? hasMarkdownTable(yText)
          : /^\|.+\|/m.test(yText);
      const xMashed =
        typeof looksLikeMashedTable === 'function' ? looksLikeMashedTable(xText) : false;
      const yMashed =
        typeof looksLikeMashedTable === 'function' ? looksLikeMashedTable(yText) : false;

      let bestText = xText;
      let bestMeta = x;
      const xCut =
        typeof looksLikeTruncatedAssistantText === 'function' &&
        looksLikeTruncatedAssistantText(xText);
      const yCut =
        typeof looksLikeTruncatedAssistantText === 'function' &&
        looksLikeTruncatedAssistantText(yText);
      const xIsPrefix =
        typeof isQianwenContentPrefixOf === 'function' &&
        isQianwenContentPrefixOf(xText, yText);
      const yIsPrefix =
        typeof isQianwenContentPrefixOf === 'function' &&
        isQianwenContentPrefixOf(yText, xText);

      // 完整度优先：半截 DOM / 检索墙不得压过更长 API
      const xSearch =
        typeof looksLikeQianwenSearchResultWall === 'function' &&
        looksLikeQianwenSearchResultWall(xText);
      const ySearch =
        typeof looksLikeQianwenSearchResultWall === 'function' &&
        looksLikeQianwenSearchResultWall(yText);
      const xReal =
        /已为您生成|论文概要|这就为您/.test(xText) ||
        ((xText.match(/^\d+\.\s/gm) || []).length >= 2 && /[。]/.test(xText));
      const yReal =
        /已为您生成|论文概要|这就为您/.test(yText) ||
        ((yText.match(/^\d+\.\s/gm) || []).length >= 2 && /[。]/.test(yText));

      if (xReal && (ySearch || ySoup) && !yReal) {
        bestText = xText;
        bestMeta = x;
      } else if (yReal && (xSearch || xSoup) && !xReal) {
        bestText = yText;
        bestMeta = y;
      } else if (xSoup && !ySoup && yText.length > 40) {
        bestText = yText;
        bestMeta = y;
      } else if (ySoup && !xSoup && xText.length > 40 && !xCut) {
        bestText = xText;
        bestMeta = x;
      } else if ((xCut || xIsPrefix) && !yCut && yText.length > xText.length + 40 && !ySoup) {
        bestText = yText;
        bestMeta = y;
      } else if ((yCut || yIsPrefix) && !xCut && xText.length > yText.length + 40 && !xSoup) {
        bestText = xText;
        bestMeta = x;
      } else if (ySoup && !xSoup && xText && !xCut) {
        bestText = xText;
        bestMeta = x;
      } else if (xSoup && !ySoup && yText && !yCut) {
        bestText = yText;
        bestMeta = y;
      } else if (xTable && !yTable && !xCut) {
        bestText = xText;
        bestMeta = x;
      } else if (yTable && !xTable && !yCut) {
        bestText = yText;
        bestMeta = y;
      } else if (yMashed && !xMashed && xText && !xCut) {
        bestText = xText;
        bestMeta = x;
      } else if (xMashed && !yMashed && yText && !yCut) {
        bestText = yText;
        bestMeta = y;
      } else if (yScore > xScore + 2 && !yCut) {
        bestText = yText;
        bestMeta = y;
      } else if (xScore > yScore + 2 && !xCut) {
        bestText = xText;
        bestMeta = x;
      } else {
        const xMd = /\*\*|^#{1,6}\s|^(\d+\.|[-*+])\s|^\|/m.test(xText);
        const yMd = /\*\*|^#{1,6}\s|^(\d+\.|[-*+])\s|^\|/m.test(yText);
        if (xCut && !yCut && yText) {
          bestText = yText;
          bestMeta = y;
        } else if (!xMd && yMd && !yCut) {
          bestText = yText;
          bestMeta = y;
        } else if (yText.length > xText.length * 1.25 && !ySoup && !yMashed && !yCut) {
          bestText = yText;
          bestMeta = y;
        } else if (!xCut) {
          bestText = xText || yText;
          bestMeta = xText ? x : y;
        } else {
          bestText = yText || xText;
          bestMeta = yText ? y : x;
        }
      }

      const media = [xMedia ? pullMedia(x.content) : '', yMedia ? pullMedia(y.content) : '']
        .filter(Boolean)
        .join('\n\n');
      const mediaParts = media
        ? [...new Set(media.split(/\n\n(?=@@ACM_FILE:)/).filter(Boolean))]
        : [];
      const mediaJoined = mediaParts.join('\n\n');
      let content = mediaJoined
        ? `${bestText}\n\n${mediaJoined}`.trim()
        : bestText;
      if (typeof promoteFilenameLinesToFileCards === 'function') {
        content = promoteFilenameLinesToFileCards(content);
      }
      return {
        role: bestMeta.role || x.role || y.role,
        content,
        timestamp: bestMeta.timestamp || x.timestamp || y.timestamp || null
      };
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
    this._expandCollapsedAnswers();
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

  /** 点击回答区「展开」以露出全文（折叠态 innerText 常被截断） */
  _expandCollapsedAnswers() {
    const wraps = Array.from(
      document.querySelectorAll(
        [
          typeof QIANWEN_SELECTORS !== 'undefined' ? QIANWEN_SELECTORS.answerWrap : '',
          '[data-chat-answers-wrap]',
          '[class*="answer-common-card"]',
          '[class*="wrapper-answer"]',
          '#qk-markdown-react'
        ]
          .filter(Boolean)
          .join(', ')
      )
    );
    const roots = wraps.length ? wraps : [document.body];
    for (const root of roots) {
      if (!root?.querySelectorAll) continue;
      const candidates = Array.from(
        root.querySelectorAll('button, a, [role="button"], span, div')
      );
      for (const el of candidates) {
        if (!el || el.querySelector?.('p, li, pre, table, #qk-markdown-react')) continue;
        const t = (el.textContent || '').replace(/\s+/g, '').trim();
        if (!/^(展开|展开全部|查看全部|显示更多|See more|Show more)$/i.test(t)) continue;
        try {
          el.click();
        } catch {
          // ignore
        }
      }
    }
  }

  _byRoleAttrs() {
    const nodes = Array.from(
      document.querySelectorAll(
        [
          '[data-role="user"]',
          '[data-role="assistant"]',
          '[data-message-role]',
          '[data-chat-question-wrap]',
          '[data-chat-answers-wrap]',
          '[class*="questionItem"]',
          '[class*="answerItem"]',
          '[class*="user-message"]',
          '[class*="assistant-message"]',
          '[class*="message-select-wrapper-question"]',
          '[class*="message-select-wrapper-answer"]',
          '[class*="messageSelectWrapperQuestion"]',
          '[class*="messageSelectWrapperAnswer"]',
          '[class*="qwen-chat-message-assistant"]',
          '[class*="chat-response-message"]',
          '[class*="answer-common-card"]'
        ].join(', ')
      )
    );
    const messages = [];
    for (const el of nodes) {
      if (this._isNoise(el)) continue;
      const md = el.querySelector?.(QIANWEN_SELECTORS.markdownRoot);
      const content = this._read(md || el);
      if (!content || content.length < 1) continue;
      let role = null;
      const dr =
        el.getAttribute('data-role') ||
        el.getAttribute('data-message-role') ||
        '';
      if (/user|human|question/i.test(dr) || el.hasAttribute('data-chat-question-wrap')) {
        role = 'user';
      } else if (
        /assistant|bot|answer|ai/i.test(dr) ||
        el.hasAttribute('data-chat-answers-wrap')
      ) {
        role = 'assistant';
      } else {
        const cls = (el.className || '').toString();
        if (/question|user-message|userMsg|wrapper-question/i.test(cls)) role = 'user';
        else if (/answer|assistant|bot|wrapper-answer|response-message/i.test(cls)) {
          role = 'assistant';
        }
      }
      if (role) messages.push({ role, content });
    }
    return messages;
  }

  _byQwenLikeBlocks() {
    const questionNodes = Array.from(document.querySelectorAll(QIANWEN_SELECTORS.questionWrap));
    const answerWrappers = Array.from(document.querySelectorAll(QIANWEN_SELECTORS.answerWrap));

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

    // 每个回答容器：先抽文件/图片卡，再清推荐墙与思考区
    const assistants = [];
    for (const wrap of answerWrappers) {
      if (this._isNoise(wrap)) continue;
      const clone = wrap.cloneNode(true);

      // 1) 先抽出大纲卡 / 生成图（之后可能被清理逻辑碰到）
      let earlyCards = [];
      if (typeof extractGeneratedFileCardsFromDom === 'function') {
        earlyCards = extractGeneratedFileCardsFromDom(clone);
      }

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
            // 仅删明确推荐/夸克容器；勿用过宽的 search/reference/cite（会误删正文）
            '[class*="recommend"]',
            '[class*="Recommend"]',
            '[class*="quark"]',
            '[class*="Quark"]',
            '[class*="paa"]',
            '[class*="Paa"]',
            '[class*="feed-card"]',
            '[class*="FeedCard"]',
            '[data-testid*="recommend"]',
            '[data-testid*="paa"]',
            // 生图进度条
            '[class*="progressWrap"]',
            '[class*="progressTrack"]',
            '[class*="progressBar"]',
            '[class*="Progress"]',
            '[class*="progress"]'
          ].join(',')
        )
        .forEach((el) => {
          // 进度节点：勿误删含大图的容器
          const cls = String(el.className || '');
          if (/progress/i.test(cls) && el.querySelector?.('img')) {
            const imgs = el.querySelectorAll('img');
            let keep = false;
            imgs.forEach((img) => {
              const w = Number(img.naturalWidth || img.width || 0);
              if (w >= 80 || /https?:/i.test(img.currentSrc || img.src || '')) keep = true;
            });
            if (keep) return;
          }
          el.remove();
        });

      // 推荐卡只移除、不落库；单张正文图已在 earlyCards
      this._extractMediaCardsFromRoot(clone);

      const mds = Array.from(clone.querySelectorAll(QIANWEN_SELECTORS.markdownRoot)).filter(
        (el) => {
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
        }
      );

      let content = '';
      if (mds.length && typeof extractMarkdownFromElement === 'function') {
        content = mds
          .map((el) => this._stripCardSoupText(extractMarkdownFromElement(el)))
          .filter(Boolean)
          .join('\n\n');
        // markdown 根外的表格
        const extras = [];
        clone.querySelectorAll('table, [role="table"], [role="grid"]').forEach((table) => {
          if (mds.some((md) => md.contains(table))) return;
          if (typeof tableToMarkdown === 'function' && table.tagName === 'TABLE') {
            const md = tableToMarkdown(table);
            if (md) extras.push(md);
          } else if (typeof extractMarkdownFromElement === 'function') {
            const md = extractMarkdownFromElement(table);
            if (md && /^\|/.test(md.trim())) extras.push(md.trim());
          }
        });
        if (extras.length) {
          content = [content, ...extras].filter(Boolean).join('\n\n');
        }
      } else if (typeof extractMarkdownFromElement === 'function') {
        content = this._stripCardSoupText(extractMarkdownFromElement(clone));
      } else {
        content = this._read(clone);
      }

      // 合并文件/图片卡（缺啥补啥）；生图只保留一张（优先有 URL）
      if (
        /Qwen-Image|绘制|生成.*图|文生图|生图/i.test(content) &&
        !/"type":"image"/.test(content) &&
        typeof extractGeneratedFileCardsFromDom === 'function'
      ) {
        const liveCards = extractGeneratedFileCardsFromDom(wrap);
        for (const c of liveCards) {
          if (c.type === 'image') earlyCards.push(c);
        }
      }
      if (typeof dedupeGeneratedFileCards === 'function') {
        earlyCards = dedupeGeneratedFileCards(earlyCards);
      } else {
        const imgs = earlyCards.filter((c) => c.type === 'image');
        const rest = earlyCards.filter((c) => c.type !== 'image');
        if (imgs.length > 1) {
          imgs.sort((a, b) => (b.url ? 1 : 0) - (a.url ? 1 : 0));
          earlyCards = [...rest, imgs[0]];
        }
      }
      if (
        /Qwen-Image|绘制|生成.*图|文生图|生图/i.test(content) &&
        !earlyCards.some((c) => c.type === 'image') &&
        !/"type":"image"/.test(content)
      ) {
        earlyCards.push({
          kind: 'file',
          type: 'image',
          title: '图片',
          generatedAt: '',
          url: ''
        });
      }
      if (typeof mergeFileCardsIntoContent === 'function') {
        content = mergeFileCardsIntoContent(content, earlyCards);
      } else {
        if (earlyCards.length && typeof formatGeneratedFileCardsMarkdown === 'function') {
          if (typeof dedupeQianwenCardTitlesInText === 'function') {
            content = dedupeQianwenCardTitlesInText(content, earlyCards);
          }
          const block = formatGeneratedFileCardsMarkdown(earlyCards);
          if (block && !/@@ACM_FILE:/.test(content)) {
            content = content ? `${content}\n\n${block}` : block;
          } else if (block) {
            for (const c of earlyCards) {
              if (c.url && !content.includes(c.url)) {
                const one = formatGeneratedFileCardsMarkdown([c]);
                if (one) content = `${content}\n\n${one}`;
              } else if (!c.url && c.title && !content.includes(`"title":${JSON.stringify(c.title)}`)) {
                const one = formatGeneratedFileCardsMarkdown([c]);
                if (one) content = `${content}\n\n${one}`;
              }
            }
          }
        }
        if (typeof promoteFilenameLinesToFileCards === 'function') {
          content = promoteFilenameLinesToFileCards(content);
        }
      }
      if (typeof stripQianwenTrailingRecommendWall === 'function') {
        content = stripQianwenTrailingRecommendWall(content);
      }
      if (typeof stripQianwenUiChrome === 'function') {
        content = stripQianwenUiChrome(content);
      }
      if (typeof stripQianwenThinkingProcess === 'function') {
        content = stripQianwenThinkingProcess(content);
      }
      content = this._stripCardSoupText(content);
      if (typeof promoteFilenameLinesToFileCards === 'function') {
        content = promoteFilenameLinesToFileCards(content);
      }
      // 仅当清完后仍几乎全是墙才丢弃（正常回答一律保留）
      if (
        typeof isQianwenMostlyCardSoup === 'function'
          ? isQianwenMostlyCardSoup(content)
          : typeof looksLikeQianwenCardSoup === 'function' &&
            looksLikeQianwenCardSoup(content) &&
            content.length < 120 &&
            !/[。]/.test(content)
      ) {
        continue;
      }
      // 去掉相邻重复段落（大纲卡前后常各留一遍导语）
      {
        const parts = String(content || '').split(/\n{2,}/);
        const out = [];
        for (const p of parts) {
          const norm = p.replace(/\s+/g, '');
          if (!norm) continue;
          const prev = out[out.length - 1];
          if (prev && prev.replace(/\s+/g, '') === norm) continue;
          // 短标题行若已在 ACM_FILE 里出现过则跳过
          if (
            /@@ACM_FILE:/.test(content) &&
            p.length < 80 &&
            /大纲\s*\||创建于\s*\d/.test(p) &&
            !/@@ACM_FILE:/.test(p)
          ) {
            continue;
          }
          out.push(p);
        }
        content = out.join('\n\n').trim();
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
    const mdBlocks = Array.from(document.querySelectorAll(QIANWEN_SELECTORS.markdownRoot)).filter(
      (el) => {
        if (this._isNoise(el)) return false;
        const t = (el.innerText || '').trim();
        return t.length >= 2 && t.length < 50000;
      }
    );

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

  /**
   * 千问横向推荐墙：只删多图/明确推荐容器；单张正文生成图必须保留
   */
  _extractMediaCardsFromRoot(root) {
    if (!root?.querySelectorAll) return [];
    const toRemove = new Set();

    const cardNodes = Array.from(
      root.querySelectorAll(
        [
          '[class*="swiper-slide"]',
          '[class*="swiper"]',
          '[class*="carousel"]',
          '[class*="recommend"]',
          '[class*="Recommend"]',
          '[class*="knowledge"]',
          '[class*="Knowledge"]',
          '[class*="reference"]',
          '[class*="Reference"]',
          '[class*="quark"]',
          '[class*="Quark"]',
          '[class*="pc-card"]',
          '[class*="PcCard"]',
          '[class*="paa"]',
          '[class*="Paa"]',
          '[class*="suggest"]',
          '[class*="Suggest"]',
          '[class*="related"]',
          '[class*="Related"]',
          '[class*="feed-card"]',
          '[class*="FeedCard"]',
          '[data-testid*="recommend"]',
          '[data-testid*="paa"]'
        ].join(',')
      )
    );

    for (const el of cardNodes) {
      if (!el?.parentNode) continue;
      if (cardNodes.some((o) => o !== el && o.contains?.(el))) continue;
      if (el.querySelector?.('table, [role="table"], pre, #qk-markdown-react')) continue;
      // 大纲/文件卡不要当推荐删
      const t0 = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (/大纲\s*\||创建于\s*\d|文件名\s*[：:]/.test(t0) && !el.querySelectorAll('img').length) {
        continue;
      }
      const cls = `${el.className || ''} ${el.getAttribute?.('data-testid') || ''}`;
      const imgCount = el.querySelectorAll?.('img')?.length || 0;
      const t = t0;
      const isRecommendCls = /recommend|quark|paa|swiper|carousel|suggest|related|feed/i.test(cls);
      // 单张大图 + 工具条 ≠ 推荐墙
      if (imgCount === 1 && !isRecommendCls && !/#|bili_|秒懂：|直击心灵/.test(t)) {
        continue;
      }
      const looksCardWall =
        isRecommendCls ||
        imgCount >= 2 ||
        /#/.test(t) ||
        /bili_/i.test(t) ||
        /秒懂：|直击心灵|情感能量棒|恋爱能量|豆豆妈|赋能型父母|父母核心准则|苔藓|素素社会|清华护肤|清醒记录|情绪收纳|治愈系|和父母沟通|合格的父母|足够好|关键词/.test(
          t
        );
      // 多条短标题拼在一起（推荐墙文本特征）
      const shortBits = t.split(/\s{2,}|\n/).filter((x) => x && x.length <= 40);
      if (!looksCardWall && shortBits.length >= 4 && t.length < 400 && imgCount >= 1) {
        toRemove.add(el);
        continue;
      }
      if (!looksCardWall && t.length > 200) continue;
      toRemove.add(el);
    }

    // 多图短文横向条
    root.querySelectorAll('div, section').forEach((el) => {
      if (!el?.parentNode || toRemove.has(el)) return;
      if (el.querySelector?.('table, pre, #qk-markdown-react, [class*="qk-markdown"]')) return;
      const imgs = el.querySelectorAll?.('img') || [];
      if (imgs.length < 2) return;
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 360) return;
      if (/大纲\s*\||创建于\s*\d/.test(t)) return;
      const parts = t.split(/\s{2,}|\n/).filter(Boolean);
      if (imgs.length >= 2 && (parts.length >= 3 || t.length < 280)) {
        toRemove.add(el);
      }
    });

    for (const el of toRemove) {
      try {
        el.remove();
      } catch {
        // ignore
      }
    }

    // 工具条按钮文案节点
    root.querySelectorAll('button, a, span, div').forEach((el) => {
      if (!el?.parentNode) return;
      if (el.querySelector?.('img, table, pre, p')) return;
      const t = (el.textContent || '').replace(/\s+/g, '').trim();
      if (/^(收起|展开|添加到对话|下载|复制|分享|点赞|踩)$/.test(t)) {
        try {
          el.remove();
        } catch {
          // ignore
        }
      }
    });

    return [];
  }

  /** 去掉误抽进正文的卡片标题墙（含大量 #话题 / bili_ / 时长） */
  _stripCardSoupText(text) {
    if (typeof stripQianwenCardSoup === 'function') {
      return stripQianwenCardSoup(text);
    }
    let s = String(text || '');
    if (!s) return '';
    s = s.replace(/(?:[^\n#]{0,40}#[\u4e00-\u9fffA-Za-z0-9_]{2,24}){2,}/g, '\n');
    s = s.replace(/\d{2}:\d{2}[^\n]{0,60}bili_\w+/gi, '');
    s = s.replace(/bili_\w+/gi, '');
    const lines = s.split(/\n+/);
    const kept = lines.filter((line) => {
      const t = line.trim();
      if (!t) return false;
      const hashCount = (t.match(/#/g) || []).length;
      if (hashCount >= 2 && t.length < 240) return false;
      if (/成长情绪|财经速记|心灵成长|彩虹情绪|合格爸爸如何陪伴/i.test(t) && t.length < 200) {
        return false;
      }
      if (/\d{2}:\d{2}/.test(t) && t.length < 80 && !/[:：]\s*\d/.test(t)) return false;
      if (t.length <= 16 && /室|店|盘|记$/.test(t)) return false;
      return true;
    });
    return kept.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  _read(el) {
    if (!el) return '';
    if (typeof extractMarkdownFromElement === 'function') {
      // 必须 clone，避免从真实页面 DOM 删除卡片节点
      const clone = el.cloneNode(true);
      // 推荐卡只剔除，正文图留给 Markdown
      this._extractMediaCardsFromRoot(clone);
      let md = extractMarkdownFromElement(clone).trim();
      if (typeof promoteFilenameLinesToFileCards === 'function') {
        md = promoteFilenameLinesToFileCards(md);
      }
      return this._stripCardSoupText(md);
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
    return this._isImageGenPending();
  }

  /** 生图进度未完成（页面上还有 0%~99% 且无成品大图） */
  _isImageGenPending() {
    const wraps = Array.from(
      document.querySelectorAll(
        [QIANWEN_SELECTORS.answerWrap, '[data-chat-answers-wrap]'].filter(Boolean).join(', ')
      )
    );
    const roots = wraps.length ? wraps : [];
    for (const wrap of roots) {
      const t = (wrap.innerText || '').replace(/\s+/g, ' ');
      if (!/Qwen-Image|绘制一张|生成一张|文生图|生图|生成.*图片|本次使用.+模型生成/i.test(t)) {
        continue;
      }
      const hasPercent = /\b([0-9]|[1-9][0-9])\s*%/.test(t);
      const hasProgressEl = !!wrap.querySelector?.(
        '[class*="progress"], [class*="Progress"], [class*="loading"], [class*="Loading"]'
      );
      if (!hasPercent && !hasProgressEl) continue;
      let hasBigImg = false;
      wrap.querySelectorAll?.('img').forEach((img) => {
        const src = String(img.currentSrc || img.src || img.getAttribute('src') || '');
        const w = Number(img.naturalWidth || img.width || img.getAttribute('width') || 0);
        if (/^(https?:|data:image\/)/i.test(src) && (w >= 80 || /cdn|oss|image/i.test(src))) {
          hasBigImg = true;
        }
      });
      if (!hasBigImg) return true;
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
