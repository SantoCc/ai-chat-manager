/**
 * 对话消息角色启发式校正（DeepSeek 等多轮对话）
 */

export function scoreAssistantReply(text) {
  const content = text || '';
  const head = content.slice(0, 400);
  let score = 0;

  if (
    /这段代码|以下是我的|下面是我|review意见|审查意见|改进建议|可以改进|建议如下|问题如下|学习路线|Phase\s*\d|阶段\s*[一二三四五\d]/.test(
      content
    )
  ) {
    score += 5;
  }
  if (/^(这段代码|以下是|下面是我|好的[，,]|根据您|我来帮|让我|###|## )/m.test(head)) score += 3;
  if (/你现在处于哪个阶段|需要我针对|整体清晰|整体简洁|优点|劣势/.test(content)) score += 2;
  if (content.includes('```')) score += 2;
  if (/^[-*•]\s/m.test(content)) score += 1;
  if (content.length > 500) score += 1;
  if (/^请|^帮我|^分析|^写一|^review|^审查这段|^看看这段/m.test(head)) score -= 4;

  return score;
}

export function scoreUserQuestion(text) {
  const content = text || '';
  const head = content.slice(0, 200);
  let score = 0;

  if (/^(请|帮我|分析|写一|review|审查|看看|优化|解释|翻译)/i.test(head)) score += 4;
  if (/^def |^import |^class |^function /m.test(content)) score += 2;
  if (content.includes('```') && content.length < 2500) score += 1;
  if (content.length < 400) score += 1;
  if (/这段代码|以下是我的|审查意见|改进建议|可以改进的地方/.test(content)) score -= 5;

  return score;
}

export function inferRoleFromContent(content) {
  const aScore = scoreAssistantReply(content);
  const uScore = scoreUserQuestion(content);
  if (aScore >= 3 && aScore > uScore) return 'assistant';
  if (uScore >= 2 && uScore > aScore) return 'user';
  return null;
}

export function normalizeMessageRoles(messages) {
  if (!messages?.length) return messages || [];

  const normalized = messages.map((m) => ({
    role: m.role,
    content: m.content || '',
    timestamp: m.timestamp || null
  }));

  for (let i = 0; i < normalized.length; i++) {
    const inferred = inferRoleFromContent(normalized[i].content);
    if (inferred) normalized[i].role = inferred;
    else if (normalized[i].role !== 'user' && normalized[i].role !== 'assistant') {
      normalized[i].role = i % 2 === 0 ? 'user' : 'assistant';
    }
  }

  for (let i = 0; i < normalized.length; i++) {
    const inferred = inferRoleFromContent(normalized[i].content);
    if (inferred) normalized[i].role = inferred;
  }

  if (normalized.length === 1) {
    const inferred = inferRoleFromContent(normalized[0].content);
    if (inferred) normalized[0].role = inferred;
  }

  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i].role === normalized[i - 1].role) {
      const prevA = scoreAssistantReply(normalized[i - 1].content);
      const currA = scoreAssistantReply(normalized[i].content);
      const prevU = scoreUserQuestion(normalized[i - 1].content);
      const currU = scoreUserQuestion(normalized[i].content);
      const prevBias = prevA - prevU;
      const currBias = currA - currU;

      if (currBias >= prevBias) {
        normalized[i].role = normalized[i].role === 'user' ? 'assistant' : 'user';
      } else {
        normalized[i - 1].role = normalized[i - 1].role === 'user' ? 'assistant' : 'user';
      }
    }
  }

  for (let i = 0; i < normalized.length; i++) {
    const inferred = inferRoleFromContent(normalized[i].content);
    if (inferred) normalized[i].role = inferred;
  }

  return normalized;
}

export function repairMessageRoles(messages, platform) {
  if (!messages?.length) return messages || [];
  if (platform && platform !== 'deepseek') return messages;
  return normalizeMessageRoles(messages);
}
