/**
 * 通用工具函数
 */

function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function truncateContent(content, maxLength = Infinity) {
  if (!content) return content || '';
  if (!Number.isFinite(maxLength) || content.length <= maxLength) return content;
  return content.slice(0, maxLength) + '\n\n...(内容过长，已截断)';
}

function formatDate(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getPlatformLabel(platform) {
  const labels = {
    doubao: '豆包',
    qianwen: '通义千问',
    deepseek: 'DeepSeek',
    yuanbao: '腾讯元宝',
    kimi: 'Kimi'
  };
  return labels[platform] || platform;
}

function conversationToMarkdown(conversation) {
  const lines = [`# ${conversation.title}`, '', `> 平台: ${getPlatformLabel(conversation.platform)} | 保存时间: ${formatDate(conversation.createdAt)}`, ''];
  for (const msg of conversation.messages || []) {
    const role = msg.role === 'user' ? '**用户**' : '**AI**';
    lines.push(`${role}:`, '', msg.content, '');
  }
  return lines.join('\n');
}

function getUserMessages(conversation) {
  return (conversation.messages || []).filter((m) => m.role === 'user').map((m) => m.content);
}

/** 扩展上下文是否仍有效（重载扩展后旧页面的 content script 会失效） */
function isExtensionContextValid() {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

let _refreshHintShown = false;

/** 扩展已重载时提示用户刷新页面，并避免重复弹出 */
function showExtensionRefreshHint() {
  if (_refreshHintShown || !document.body) return;
  _refreshHintShown = true;

  const bar = document.createElement('div');
  bar.id = 'acm-refresh-hint';
  bar.textContent = 'AI对话管理器已更新，请刷新本页（F5）后继续使用保存功能';
  bar.style.cssText = [
    'position:fixed', 'bottom:16px', 'left:50%', 'transform:translateX(-50%)',
    'z-index:99999', 'padding:10px 16px', 'background:#0078d4', 'color:#fff',
    'border-radius:8px', 'font-size:13px', 'box-shadow:0 2px 8px rgba(0,0,0,.2)',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
  ].join(';');
  document.body.appendChild(bar);
  setTimeout(() => bar.remove(), 8000);
}

// 导出到全局（content script 非 module 环境）
if (typeof globalThis !== 'undefined') {
  globalThis.generateId = generateId;
  globalThis.truncateContent = truncateContent;
  globalThis.formatDate = formatDate;
  globalThis.debounce = debounce;
  globalThis.escapeHtml = escapeHtml;
  globalThis.getPlatformLabel = getPlatformLabel;
  globalThis.conversationToMarkdown = conversationToMarkdown;
  globalThis.getUserMessages = getUserMessages;
  globalThis.isExtensionContextValid = isExtensionContextValid;
  globalThis.showExtensionRefreshHint = showExtensionRefreshHint;
}
