// 发送与接收。协议 §5–§8 的执行层。
//
// 这一层只有两件难事，都跟「多个 agent 同时动」有关：
//   1. 消息只能被一个消费者拿到 —— 靠 rename 抢锁，不靠读后删。
//   2. 广播只存一份 —— 靠每个成员自己的游标，不靠给每人复制一份。

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  KIND, assertName, isExpired, makeMessage, scopeOf, validateMessage,
} from './protocol.mjs';
import {
  LAYOUT, claim, fileSize, listJsonFiles, readCursorEntry, isAfterCursor, appendLog,
  readJsonSafe, sha256File, writeCursor, writeJsonNew, busPath,
} from './store.mjs';
import {
  listGroups, listParticipants, participantExists, readGroup, requireGroup,
} from './participant.mjs';

// ---------------------------------------------------------------- 发送

/**
 * 落一条消息。返回写入的绝对路径。
 *
 * 校验在写之前 —— 一条不合规的消息宁可发不出去，也不要躺在别人 inbox 里
 * 让收件方替发件方收拾残局。
 */
export function send(root, msg) {
  const errors = validateMessage(msg);
  if (errors.length) throw new Error(`消息不合规：\n  - ${errors.join('\n  - ')}`);

  const target = scopeOf(msg.to);
  const file = write(root, target, msg);
  appendLog(root, {
    op: 'send', id: msg.id, kind: msg.kind, from: msg.from, subject: msg.subject,
    to: typeof msg.to === 'string' ? msg.to : msg.to.direct || msg.to.group,
  });
  return file;
}

function write(root, target, msg) {
  if (target.kind === 'direct') {
    if (!participantExists(root, target.name)) {
      throw new Error(`收件方 ${target.name} 不存在。先跑 \`agent-bus join ${target.name}\`。`);
    }
    const dir = busPath(root, LAYOUT.participants, target.name, LAYOUT.inbox);
    if (existsSync(join(dir, `${msg.id}.json`))) throw new Error(`消息 id 撞车：${msg.id}`);
    return writeJsonNew(join(dir, `${msg.id}.json`), msg);
  }

  const g = requireGroup(root, target.name);
  if (!g.members.includes(msg.from)) {
    throw new Error(`${msg.from} 不在组 ${target.name} 里，不能往这个组广播。成员：${g.members.join(', ') || '(空)'}`);
  }
  const dir = busPath(root, LAYOUT.groups, target.name, LAYOUT.broadcast);
  return writeJsonNew(join(dir, `${msg.id}.json`), msg);
}

export function sendAnnounce(root, { from, to, subject, body, artifact }) {
  return send(root, makeMessage({ kind: KIND.ANNOUNCE, from, to, subject, body, artifact }));
}

export function sendAsk(root, { from, to, subject, body, ttlMs }) {
  const scope = scopeOf(to);
  if (scope.kind !== 'direct') {
    throw new Error('ask 只能问一个具体的人。问一个组等于问没人 —— 想要意见就改成 announce，让别人自己决定要不要回。');
  }
  return send(root, makeMessage({ kind: KIND.ASK, from, to, subject, body, ttlMs }));
}

/** 在所有 participant 的 inbox/archive 与 group 的 broadcast 里找一条消息。 */
export function locateMessage(root, id) {
  const clean = String(id).replace(/^.*\//, '').replace(/\.json$/, '');
  assertName(clean, 'id');
  for (const p of listParticipants(root)) {
    for (const where of [LAYOUT.inbox, LAYOUT.archive]) {
      const path = busPath(root, LAYOUT.participants, p, where, `${clean}.json`);
      const msg = readJsonSafe(path, null);
      if (msg) return { msg, where: `${p}/${where}` };
    }
  }
  for (const g of listGroups(root)) {
    const path = busPath(root, LAYOUT.groups, g, LAYOUT.broadcast, `${clean}.json`);
    const msg = readJsonSafe(path, null);
    if (msg) return { msg, where: `group ${g}/broadcast` };
  }
  return null;
}

export function sendAnswer(root, { from, inReplyTo, subject, body }) {
  const found = locateMessage(root, inReplyTo);
  if (!found) throw new Error(`找不到被回复的消息：${inReplyTo}`);
  if (found.msg.kind !== KIND.ASK) {
    throw new Error(`${inReplyTo} 是一条 ${found.msg.kind}，不是 ask —— answer 只能回答 ask。`);
  }
  return send(root, makeMessage({
    kind: KIND.ANSWER, from, to: { direct: found.msg.from }, inReplyTo, subject, body,
  }));
}

export function sendDelivery(root, { from, to, subject, body, artifactPath }) {
  if (!artifactPath) throw new Error('delivery 必须给 artifactPath');
  const artifact = { path: artifactPath, sha256: sha256File(artifactPath), bytes: fileSize(artifactPath) };
  return send(root, makeMessage({ kind: KIND.DELIVERY, from, to, subject, body, artifact }));
}

// ---------------------------------------------------------------- 接收（direct）

export function inboxDir(root, participant) {
  return busPath(root, LAYOUT.participants, assertName(participant, '参与者名'), LAYOUT.inbox);
}

/** 只看不拿。返回 [{file, msg}]，不改变任何状态。 */
export function peek(root, participant) {
  const dir = inboxDir(root, participant);
  const out = [];
  for (const file of listJsonFiles(dir)) {
    const msg = readJsonSafe(join(dir, file), null);
    if (msg) out.push({ file, msg });
  }
  return out;
}

export function pendingCount(root, participant) {
  return listJsonFiles(inboxDir(root, participant)).length;
}

/**
 * 取走 inbox 里的消息。
 *
 * claim 成功才读 —— 顺序必须是「先抢再读」，反过来就是经典的
 * 两个消费者都读到同一条消息。抢不到说明别人拿走了，静默跳过即可。
 */
export function recv(root, participant, { limit = Infinity } = {}) {
  const dir = inboxDir(root, participant);
  const claimed = [];
  const skipped = [];

  for (const file of listJsonFiles(dir)) {
    if (claimed.length >= limit) break;
    const to = join(busPath(root, LAYOUT.participants, participant, LAYOUT.archive), file);
    if (!claim(join(dir, file), to)) {
      skipped.push(file);
      continue;
    }
    const msg = readJsonSafe(to, null);
    if (!msg) {
      skipped.push(`${file}（内容坏了，已移到 archive 不再重试）`);
      continue;
    }
    claimed.push({ file, msg, expired: isExpired(msg) });
    appendLog(root, { op: 'recv', id: msg.id, kind: msg.kind, from: msg.from, by: participant });
  }

  return {
    messages: claimed.filter((c) => !c.expired).map((c) => c.msg),
    expired: claimed.filter((c) => c.expired).map((c) => c.msg),
    skipped,
  };
}

// ---------------------------------------------------------------- 接收（group 广播）

/**
 * 按游标读组的广播。
 *
 * 广播文件不搬走 —— 一个组五个人，搬走就只剩第一个能看到。
 * 代价是要维护游标；游标丢失的后果是重复读，不是漏读，这个方向的失败是安全的。
 */
export function pollGroup(root, participant, groupName, { includeSelf = false } = {}) {
  const g = requireGroup(root, groupName);
  if (!g.members.includes(participant)) {
    throw new Error(`${participant} 不在组 ${groupName} 里。成员：${g.members.join(', ') || '(空)'}`);
  }

  const dir = busPath(root, LAYOUT.groups, groupName, LAYOUT.broadcast);
  const cursor = readCursorEntry(root, participant, groupName);
  const fresh = [];
  let newest = cursor;

  for (const file of listJsonFiles(dir)) {
    const id = file.replace(/\.json$/, '');
    let mtime = 0;
    try { mtime = statSync(join(dir, file)).mtimeMs; } catch { continue; }
    if (!isAfterCursor(mtime, id, cursor)) continue;        // 已读
    if (isAfterCursor(mtime, id, newest)) newest = { id, mtime };
    const msg = readJsonSafe(join(dir, file), null);
    if (!msg) continue;
    if (msg.from === participant && !includeSelf) continue;
    if (isExpired(msg)) continue;
    fresh.push(msg);
  }

  if (newest.id !== cursor.id || newest.mtime !== cursor.mtime) {
    writeCursor(root, participant, groupName, newest);
  }
  return fresh;
}

/** 组里所有成员（含自己），给 CLI 显示用。 */
export function groupMembers(root, groupName) {
  return requireGroup(root, groupName).members;
}

// ---------------------------------------------------------------- 汇总

/**
 * 一次拿全：direct 的 inbox + 所有所在组的广播。
 * Agent 每轮开头调这一个就够，不用记得自己加了哪些组。
 */
export function collect(root, participant, { limit = Infinity } = {}) {
  const directBox = recv(root, participant, { limit });
  const groups = {};
  const broadcast = [];
  for (const name of listGroups(root)) {
    const g = readGroup(root, name);
    if (!g?.members?.includes(participant)) continue;
    const msgs = pollGroup(root, participant, name);
    if (msgs.length) {
      groups[name] = msgs.length;
      broadcast.push(...msgs);
    }
  }
  return { direct: directBox.messages, expired: directBox.expired, skipped: directBox.skipped, broadcast, groups };
}
