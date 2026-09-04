/**
 * 导出功能
 */

import { getPlatformLabel } from '../utils/helpers-export.js';

export function conversationToMarkdown(conversation) {
  const lines = [
    `# ${conversation.title}`,
    '',
    `> 平台: ${getPlatformLabel(conversation.platform)} | 保存: ${conversation.createdAt}`,
    conversation.url ? `> 链接: ${conversation.url}` : '',
    ''
  ].filter(Boolean);

  for (const msg of conversation.messages || []) {
    const label = msg.role === 'user' ? '**用户**' : '**AI**';
    lines.push(`${label}:`, '', msg.content, '', '---', '');
  }
  return lines.join('\n');
}

export function conversationToHtml(conversation) {
  const messagesHtml = (conversation.messages || []).map((msg) => {
    const role = msg.role === 'user' ? '用户' : 'AI';
    const cls = msg.role === 'user' ? 'msg-user' : 'msg-assistant';
    const content = escapeHtml(msg.content).replace(/\n/g, '<br>');
    return `<div class="message ${cls}"><div class="role">${role}</div><div class="content">${content}</div></div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(conversation.title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }
  h1 { border-bottom: 1px solid #ddd; padding-bottom: 0.5rem; }
  .meta { color: #666; font-size: 0.9rem; margin-bottom: 2rem; }
  .message { margin: 1rem 0; padding: 1rem; border-radius: 8px; }
  .msg-user { background: #e8f4fd; }
  .msg-assistant { background: #f5f5f5; }
  .role { font-weight: bold; margin-bottom: 0.5rem; color: #333; }
</style>
</head>
<body>
<h1>${escapeHtml(conversation.title)}</h1>
<div class="meta">平台: ${getPlatformLabel(conversation.platform)} | 保存: ${conversation.createdAt}</div>
${messagesHtml}
</body>
</html>`;
}

export async function downloadFile(content, filename, mimeType) {
  // Service Worker 中无 URL.createObjectURL，改用 data URL
  const base64 = btoa(unescape(encodeURIComponent(content)));
  const dataUrl = `data:${mimeType};base64,${base64}`;
  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: true
  });
  if (downloadId === undefined && chrome.runtime.lastError) {
    throw new Error(chrome.runtime.lastError.message || '下载失败');
  }
}

export async function copyToClipboard(text) {
  await navigator.clipboard.writeText(text);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
