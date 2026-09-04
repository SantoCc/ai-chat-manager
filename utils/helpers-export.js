export function getPlatformLabel(platform) {
  const labels = {
    doubao: '豆包',
    qianwen: '通义千问',
    deepseek: 'DeepSeek',
    yuanbao: '腾讯元宝',
    kimi: 'Kimi'
  };
  return labels[platform] || platform;
}

export function truncateFolderName(name, maxLen = 4) {
  if (!name) return '';
  const str = String(name);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}

export {
  scoreAssistantReply,
  scoreUserQuestion,
  normalizeMessageRoles,
  repairMessageRoles
} from '../lib/role-heuristics.js';

export { dedupeMessages, mergeMessages as mergeMessageLists, isSameMessageContent } from '../lib/message-utils.js';

export function formatDate(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function getUserMessages(conversation) {
  const messages = (conversation.messages || []).filter((m) => (m.content || '').trim());
  if (!messages.length) return [];

  const users = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content.trim());

  if (users.length) return users;

  // 角色全部丢失时的兜底：对话通常以用户提问开始，取偶数索引
  return messages
    .filter((_, i) => i % 2 === 0)
    .map((m) => m.content.trim());
}

export async function copyText(text) {
  const value = (text || '').trim();
  if (!value) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
