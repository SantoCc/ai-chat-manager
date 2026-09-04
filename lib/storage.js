/**
 * 存储层封装 - chrome.storage.local
 */

import { classifyConversation } from './classify.js';
import { repairMessageRoles } from './role-heuristics.js';
import { dedupeMessages, mergeMessages as mergeMessageLists } from './message-utils.js';

const STORAGE_KEYS = {
  CONVERSATIONS: 'acm_conversations',
  FOLDERS: 'acm_folders',
  SETTINGS: 'acm_settings'
};

const DEFAULT_SETTINGS = {
  autoSave: true,
  autoClassify: false,
  theme: 'dark',
  defaultView: 'list',
  storageMode: 'unlimited' // 'limited' = A方案 10MB | 'unlimited' = B方案无上限
};

/** A 方案软上限（10 MB） */
export const STORAGE_QUOTA_BYTES = 10 * 1024 * 1024;

async function getFromStorage(key, defaultValue) {
  const result = await chrome.storage.local.get(key);
  return result[key] !== undefined ? result[key] : defaultValue;
}

async function setInStorage(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export async function getSettings() {
  const stored = await getFromStorage(STORAGE_KEYS.SETTINGS, null);
  if (!stored || typeof stored !== 'object') {
    return { ...DEFAULT_SETTINGS };
  }
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(settings) {
  const current = await getSettings();
  await setInStorage(STORAGE_KEYS.SETTINGS, { ...current, ...settings });
}

export async function getFolders() {
  return getFromStorage(STORAGE_KEYS.FOLDERS, []);
}

export async function saveFolders(folders) {
  await setInStorage(STORAGE_KEYS.FOLDERS, folders);
}

export async function getConversations() {
  return getFromStorage(STORAGE_KEYS.CONVERSATIONS, []);
}

export async function saveConversations(conversations) {
  await setInStorage(STORAGE_KEYS.CONVERSATIONS, conversations);
}

export async function getConversationById(id) {
  const conversations = await getConversations();
  return conversations.find((c) => c.id === id) || null;
}

export async function addConversation(data) {
  const conversations = await getConversations();
  const now = new Date().toISOString();

  let messages = (data.messages || []).map((msg) => ({
    role: msg.role,
    content: truncateMessage(msg.content),
    timestamp: msg.timestamp || null
  }));

  if (data.platform === 'deepseek' && data.source !== 'api') {
    messages = repairMessageRoles(messages, 'deepseek');
  }
  messages = dedupeMessages(messages);

  let folderId = data.folderId || null;
  if (!folderId) {
    const settings = await getSettings();
    if (settings.autoClassify) {
      const folders = await getFolders();
      folderId = classifyConversation(
        { title: data.title || '未命名对话', messages },
        folders
      );
    }
  }

  const conversation = {
    id: generateId(),
    title: data.title || '未命名对话',
    platform: data.platform,
    url: data.url || '',
    sessionId: data.sessionId || null,
    messages,
    source: data.source || 'dom',
    folderId,
    tags: data.tags || [],
    favorite: false,
    createdAt: now,
    updatedAt: now
  };

  conversations.unshift(conversation);
  await assertCanSave(conversations);
  await saveConversations(conversations);
  return conversation;
}

function truncateMessage(content) {
  // 原样保存，不做字数截断（与「完全一致同步」一致；容量由 storageMode / assertCanSave 约束）
  return content == null ? '' : String(content);
}

/** 合并消息：去重 + 保留更长内容 + 不丢失尾部消息 */
export function mergeMessages(existing = [], incoming = [], platform = '') {
  let result = mergeMessageLists(existing, incoming);
  if (platform === 'deepseek') {
    result = repairMessageRoles(result, 'deepseek');
  }
  return dedupeMessages(result);
}

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

export async function updateConversation(id, updates) {
  const conversations = await getConversations();
  const index = conversations.findIndex((c) => c.id === id);
  if (index === -1) return null;

  const nextUpdates = { ...updates };
  if (Array.isArray(nextUpdates.messages)) {
    nextUpdates.messages = nextUpdates.messages.map((msg) => ({
      role: msg.role,
      content: truncateMessage(msg.content),
      timestamp: msg.timestamp || null
    }));
    const platform = conversations[index].platform;
    if (platform === 'deepseek') {
      nextUpdates.messages = dedupeMessages(nextUpdates.messages);
      const source = updates.source || conversations[index].source;
      if (source !== 'api') {
        nextUpdates.messages = repairMessageRoles(nextUpdates.messages, 'deepseek');
      }
    }
  }

  conversations[index] = {
    ...conversations[index],
    ...nextUpdates,
    updatedAt: new Date().toISOString()
  };

  // 自动分类：仅对尚未归类的对话，在更新内容时尝试匹配
  if (!conversations[index].folderId) {
    const settings = await getSettings();
    if (settings.autoClassify) {
      const folders = await getFolders();
      const matched = classifyConversation(conversations[index], folders);
      if (matched) conversations[index].folderId = matched;
    }
  }

  await assertCanSave(conversations);
  await saveConversations(conversations);
  return conversations[index];
}

export async function deleteConversation(id) {
  const conversations = await getConversations();
  const filtered = conversations.filter((c) => c.id !== id);
  await saveConversations(filtered);
  return filtered.length !== conversations.length;
}

export async function searchConversations({ query = '', platform = '', folderId = '', tag = '' } = {}) {
  let conversations = await getConversations();

  if (platform) {
    conversations = conversations.filter((c) => c.platform === platform);
  }
  if (folderId) {
    conversations = conversations.filter((c) => c.folderId === folderId);
  }
  if (tag) {
    conversations = conversations.filter((c) => (c.tags || []).includes(tag));
  }
  if (query) {
    const q = query.toLowerCase();
    conversations = conversations.filter((c) => {
      if (c.title.toLowerCase().includes(q)) return true;
      return (c.messages || []).some((m) => m.content.toLowerCase().includes(q));
    });
  }

  // 收藏置顶
  conversations.sort((a, b) => {
    if (a.favorite !== b.favorite) return b.favorite ? 1 : -1;
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });

  return conversations;
}

export async function getStorageUsage() {
  const settings = await getSettings();
  const bytes = await chrome.storage.local.getBytesInUse(null);
  const storageMode = settings.storageMode || 'unlimited';

  if (storageMode === 'unlimited') {
    return {
      bytes,
      formatted: formatBytes(bytes),
      storageMode,
      level: 'ok'
    };
  }

  const quotaBytes = STORAGE_QUOTA_BYTES;
  const percent = Math.min(100, Math.round((bytes / quotaBytes) * 100));
  return {
    bytes,
    quotaBytes,
    percent,
    formatted: formatBytes(bytes),
    quotaFormatted: formatBytes(quotaBytes),
    storageMode,
    level: getStorageLevel(bytes, quotaBytes)
  };
}

/** A 方案：保存前检查是否超出 10 MB 软上限 */
export async function assertCanSave(conversations) {
  const settings = await getSettings();
  if (settings.storageMode !== 'limited') return;

  const estimated = new Blob([JSON.stringify(conversations)]).size;
  if (estimated > STORAGE_QUOTA_BYTES) {
    throw new Error('STORAGE_LIMIT_EXCEEDED');
  }
}

export async function checkCanSave() {
  const settings = await getSettings();
  if (settings.storageMode !== 'limited') {
    return { allowed: true, storageMode: 'unlimited' };
  }

  const bytes = await chrome.storage.local.getBytesInUse(null);
  const quotaBytes = STORAGE_QUOTA_BYTES;
  const allowed = bytes < quotaBytes;
  return {
    allowed,
    storageMode: 'limited',
    bytes,
    quotaBytes,
    percent: Math.min(100, Math.round((bytes / quotaBytes) * 100)),
    level: getStorageLevel(bytes, quotaBytes)
  };
}

function getStorageLevel(bytes, quotaBytes) {
  const ratio = bytes / quotaBytes;
  if (ratio >= 0.9) return 'critical';
  if (ratio >= 0.7) return 'warn';
  return 'ok';
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export async function exportAllData() {
  const [conversations, folders, settings] = await Promise.all([
    getConversations(),
    getFolders(),
    getSettings()
  ]);
  return { conversations, folders, settings, exportedAt: new Date().toISOString() };
}

/**
 * 从 JSON 备份恢复数据
 * @param {'merge'|'replace'} mode - merge 合并；replace 覆盖全部
 */
export async function importAllData(raw, mode = 'merge') {
  const data = validateImportData(raw);

  if (mode === 'replace') {
    await assertCanSave(data.conversations);
    await saveConversations(data.conversations);
    await saveFolders(data.folders);
    if (data.settings) {
      await setInStorage(STORAGE_KEYS.SETTINGS, { ...DEFAULT_SETTINGS, ...data.settings });
    }
    return {
      mode: 'replace',
      conversations: data.conversations.length,
      folders: data.folders.length
    };
  }

  // merge：按 id 合并，同 id 保留 updatedAt 较新的
  const existing = await getConversations();
  const byId = new Map(existing.map((c) => [c.id, c]));
  let added = 0;
  let updated = 0;

  for (const conv of data.conversations) {
    const current = byId.get(conv.id);
    if (!current) {
      byId.set(conv.id, conv);
      added++;
    } else if (conv.updatedAt && (!current.updatedAt || conv.updatedAt > current.updatedAt)) {
      byId.set(conv.id, conv);
      updated++;
    }
  }

  const merged = Array.from(byId.values());
  merged.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
  await assertCanSave(merged);
  await saveConversations(merged);

  const existingFolders = await getFolders();
  const folderIds = new Set(existingFolders.map((f) => f.id));
  const mergedFolders = [...existingFolders];
  for (const folder of data.folders) {
    if (!folderIds.has(folder.id)) {
      mergedFolders.push(folder);
      folderIds.add(folder.id);
    }
  }
  await saveFolders(mergedFolders);

  return {
    mode: 'merge',
    added,
    updated,
    total: merged.length,
    foldersAdded: mergedFolders.length - existingFolders.length
  };
}

function validateImportData(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('无效的 JSON 格式');
  }

  if (!Array.isArray(raw.conversations)) {
    throw new Error('缺少 conversations 字段，请使用本扩展导出的备份文件');
  }

  const conversations = raw.conversations.map(normalizeConversation);
  const folders = Array.isArray(raw.folders) ? raw.folders.map(normalizeFolder) : [];
  const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : null;

  return { conversations, folders, settings };
}

function normalizeConversation(c) {
  if (!c || typeof c !== 'object') {
    throw new Error('对话数据格式不正确');
  }
  if (!c.id || !c.title || !Array.isArray(c.messages)) {
    throw new Error(`对话「${c.title || '未知'}」缺少必要字段（id/title/messages）`);
  }
  return {
    id: String(c.id),
    title: String(c.title),
    platform: c.platform || 'unknown',
    url: c.url || '',
    messages: c.messages.map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: truncateMessage(String(m.content || '')),
      timestamp: m.timestamp || null
    })),
    folderId: c.folderId || null,
    tags: Array.isArray(c.tags) ? c.tags : [],
    favorite: Boolean(c.favorite),
    createdAt: c.createdAt || new Date().toISOString(),
    updatedAt: c.updatedAt || c.createdAt || new Date().toISOString()
  };
}

function normalizeFolder(f) {
  if (!f || !f.id || !f.name) {
    throw new Error('文件夹数据格式不正确');
  }
  return {
    id: String(f.id),
    name: String(f.name),
    keywords: Array.isArray(f.keywords) && f.keywords.length ? f.keywords.map(String) : [String(f.name)],
    createdAt: f.createdAt || new Date().toISOString(),
    order: typeof f.order === 'number' ? f.order : 0
  };
}
