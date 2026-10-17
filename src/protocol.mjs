// 协议的数据层：常量、id、消息构造与校验。
// 这一层不认识文件系统，也不认识 MCP —— 只有形状和规则。

export const PROTOCOL_VERSION = 1;

export const KIND = {
  ANNOUNCE: 'announce',
  ASK: 'ask',
  ANSWER: 'answer',
  DELIVERY: 'delivery',
};

export const KINDS = new Set(Object.values(KIND));

export const PHASE = {
  IDLE: 'idle',
  WORKING: 'working',
  BLOCKED: 'blocked',
  DELIVERING: 'delivering',
};

export const PHASES = new Set(Object.values(PHASE));

/** participant 与 group 的名字：文件系统安全 + 无空白，避免一切路径歧义。 */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/i;

export function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && !name.includes('..');
}

export function assertName(name, what) {
  if (!isValidName(name)) {
    throw new Error(
      `${what}不合规：${JSON.stringify(name)}。只允许字母、数字、点、下划线、连字符，首字符必须是字母或数字，长度 1-63。`,
    );
  }
  return name;
}

/**
 * 消息 id：UTC 时间戳 + 8 位随机十六进制。
 * 字典序 = 时间序（同秒内靠随机串，不保证顺序，协议第 8.5 条已声明）。
 */
export function newId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
  let rand = '';
  for (let i = 0; i < 4; i++) rand += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return `${stamp}-${rand}`;
}

/** 本地时间带偏移，能被 Date 解析成绝对时刻。 */
export function localIso(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const p = (n) => String(Math.abs(n)).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${off >= 0 ? '+' : '-'}${p(Math.trunc(off / 60))}:${p(off % 60)}`
  );
}

export function scopeOf(target) {
  if (!target || typeof target !== 'object') throw new Error('to 必须是 {direct} 或 {group}');
  const hasDirect = typeof target.direct === 'string';
  const hasGroup = typeof target.group === 'string';
  if (hasDirect === hasGroup) throw new Error('to 必须在 direct 和 group 中二选一');
  if (hasDirect) return { kind: 'direct', name: assertName(target.direct, '收件方') };
  return { kind: 'group', name: assertName(target.group, '组名') };
}

/** direct 便捷写法 */
export const direct = (name) => ({ direct: name });
/** group 便捷写法 */
export const group = (name) => ({ group: name });

const DEFAULT_ASK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 造一条消息。只做形状，不做落盘。
 * 校验放在 validateMessage —— 造和查分开，调用方才知道自己错在哪。
 */
export function makeMessage({
  kind,
  from,
  to,
  subject,
  body = '',
  inReplyTo = null,
  artifact = null,
  expiresAt = undefined,
  ttlMs = DEFAULT_ASK_TTL_MS,
  now = new Date(),
} = {}) {
  if (!KINDS.has(kind)) throw new Error(`kind 非法：${kind}。只能是 ${[...KINDS].join('/')}`);
  assertName(from, '发件方');
  const scope = scopeOf(to);
  if (!subject || !String(subject).trim()) throw new Error('subject 不能为空');

  const expires =
    kind === KIND.ASK
      ? expiresAt ?? new Date(now.getTime() + ttlMs).toISOString()
      : null;

  return {
    v: PROTOCOL_VERSION,
    id: newId(now),
    kind,
    from,
    to: scope.kind === 'direct' ? { direct: scope.name } : { group: scope.name },
    subject: String(subject).trim(),
    body: body == null ? '' : String(body),
    in_reply_to: kind === KIND.ANSWER ? inReplyTo : null,
    artifact: kind === KIND.DELIVERY ? artifact : null,
    created_at: localIso(now),
    expires_at: expires,
  };
}

/**
 * 校验一条消息。返回错误数组，空数组表示合规。
 * 规则来自 PROTOCOL.md 第 5.2 节。
 */
export function validateMessage(msg) {
  const errors = [];
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return ['消息不是一个对象'];

  if (msg.v !== PROTOCOL_VERSION) errors.push(`v 必须是 ${PROTOCOL_VERSION}，实际是 ${JSON.stringify(msg.v)}`);
  if (typeof msg.id !== 'string' || !/^\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(msg.id)) {
    errors.push(`id 格式不对：${JSON.stringify(msg.id)}（应为 yyyyMMddTHHmmssZ-xxxxxxxx）`);
  }
  if (!KINDS.has(msg.kind)) errors.push(`kind 非法：${JSON.stringify(msg.kind)}`);
  if (!isValidName(msg.from)) errors.push(`from 非法：${JSON.stringify(msg.from)}`);

  try {
    scopeOf(msg.to);
  } catch (e) {
    errors.push(`to 非法：${e.message}`);
  }

  if (typeof msg.subject !== 'string' || !msg.subject.trim()) errors.push('subject 必须是非空字符串');

  if (msg.kind === KIND.ANSWER) {
    if (typeof msg.in_reply_to !== 'string' || !msg.in_reply_to) errors.push('answer 必须带 in_reply_to');
  } else if (msg.in_reply_to != null) {
    errors.push('只有 answer 可以带 in_reply_to');
  }

  if (msg.kind === KIND.DELIVERY) {
    const a = msg.artifact;
    if (!a || typeof a !== 'object') errors.push('delivery 必须带 artifact');
    else {
      if (typeof a.path !== 'string' || !a.path) errors.push('artifact.path 必须是非空字符串');
      if (typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256)) errors.push('artifact.sha256 必须是 64 位十六进制');
      if (!Number.isInteger(a.bytes) || a.bytes < 0) errors.push('artifact.bytes 必须是非负整数');
    }
  } else if (msg.artifact != null) {
    errors.push('只有 delivery 可以带 artifact');
  }

  if (msg.kind === KIND.ASK) {
    if (typeof msg.expires_at !== 'string' || !msg.expires_at) errors.push('ask 必须带 expires_at');
  } else if (msg.expires_at != null) {
    errors.push('只有 ask 可以带 expires_at');
  }

  for (const key of ['created_at', 'expires_at']) {
    const v = msg[key];
    if (v == null) continue;
    if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) errors.push(`${key} 无法解析为时刻：${JSON.stringify(v)}`);
  }

  // announce 可以只带标题 —— 「环境重建了，注意一下」这种通知，正文是多余的。
  // ask 不行：没写清楚问什么，对方只能猜，最后变成来回扯皮。
  if (msg.kind === KIND.ASK && !String(msg.body || '').trim()) {
    errors.push('ask 必须写清楚要问什么（body 不能为空）');
  }

  return errors;
}

/** 是否已过期（只有 ask 有 expires_at）。 */
export function isExpired(msg, now = new Date()) {
  if (!msg?.expires_at) return false;
  const t = Date.parse(msg.expires_at);
  return Number.isFinite(t) && t < now.getTime();
}
