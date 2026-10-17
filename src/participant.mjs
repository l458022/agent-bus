// participant / group / state / board。
// 这一层管「谁在这、谁跟谁一伙、各自在干什么」，不管消息怎么发（那是 send.mjs）。

import { appendFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PHASE, PROTOCOL_VERSION, assertName, localIso } from './protocol.mjs';
import {
  LAYOUT, busPath, ensureDir, readJsonSafe, readTextSafe, writeJson, writeJsonNew, appendLog,
} from './store.mjs';

// ---------------------------------------------------------------- bus 元信息

export function readBus(root) {
  return readJsonSafe(busPath(root, 'bus.json'), null);
}

export function initBus(root, { name } = {}) {
  const existing = readBus(root);
  if (existing) return { created: false, bus: existing };

  const bus = {
    v: PROTOCOL_VERSION,
    name: name || 'bus',
    created_at: localIso(),
    note: '这个文件的存在就是 root 标记。往上找目录时，谁先看见它谁是 root。',
  };
  writeJsonNew(busPath(root, 'bus.json'), bus);
  ensureDir(busPath(root, LAYOUT.participants));
  ensureDir(busPath(root, LAYOUT.groups));
  ensureDir(busPath(root, LAYOUT.log));
  return { created: true, bus };
}

// ---------------------------------------------------------------- 参与者

export function participantDir(root, name) {
  return busPath(root, LAYOUT.participants, assertName(name, '参与者名'));
}

export function participantExists(root, name) {
  return existsSync(join(participantDir(root, name), LAYOUT.state));
}

export function listParticipants(root) {
  try {
    return readdirSync(busPath(root, LAYOUT.participants))
      .filter((n) => statSync(busPath(root, LAYOUT.participants, n)).isDirectory())
      .sort();
  } catch {
    return [];
  }
}

export function emptyState(name, { role = '' } = {}) {
  return {
    v: PROTOCOL_VERSION,
    name,
    role,
    phase: PHASE.IDLE,
    now: '',
    produces: [],
    consumes: [],
    holds: [],
    blockers: [],
    wants: [],
    updated_at: localIso(),
  };
}

/**
 * 建一个参与者。已存在就返回旧的 —— `join` 要能重复跑不炸。
 */
export function ensureParticipant(root, name, { role = '' } = {}) {
  const dir = participantDir(root, name);
  ensureDir(join(dir, LAYOUT.inbox));
  ensureDir(join(dir, LAYOUT.archive));
  const stateFile = join(dir, LAYOUT.state);
  if (!existsSync(stateFile)) {
    writeJson(stateFile, emptyState(name, { role }));
    return { created: true, state: readState(root, name) };
  }
  return { created: false, state: readState(root, name) };
}

export function readState(root, name) {
  return readJsonSafe(join(participantDir(root, name), LAYOUT.state), null);
}

export function requireState(root, name) {
  const s = readState(root, name);
  if (!s) throw new Error(`没有这个参与者：${name}。先跑 \`agent-bus join ${name}\`。`);
  return s;
}

/**
 * 浅合并更新 state。数组整体替换，不做元素级合并 ——
 * 元素级合并的语义（并集？按 id 合？）会让两个 agent 各写各的变成一团乱账。
 */
export function patchState(root, name, patch) {
  const current = requireState(root, name);
  const next = { ...current, ...patch, updated_at: localIso() };
  if (patch.phase !== undefined && !PHASE[String(patch.phase).toUpperCase()] && !Object.values(PHASE).includes(patch.phase)) {
    throw new Error(`phase 只能是 ${Object.values(PHASE).join(' / ')}，收到 ${JSON.stringify(patch.phase)}`);
  }
  next.v = PROTOCOL_VERSION;
  next.name = name;
  writeJson(join(participantDir(root, name), LAYOUT.state), next);
  // state 是覆盖写，历史上「它什么时候从 working 变成 blocked」只能靠日志还原。
  if (current.phase !== next.phase) {
    appendLog(root, { op: 'state', name, from: current.phase, to: next.phase });
  }
  return next;
}

export function setPhase(root, name, phase, now = '') {
  return patchState(root, name, { phase, ...(now ? { now } : {}) });
}

// ---------------------------------------------------------------- 组

export function groupDir(root, name) {
  return busPath(root, LAYOUT.groups, assertName(name, '组名'));
}

export function listGroups(root) {
  try {
    return readdirSync(busPath(root, LAYOUT.groups))
      .filter((n) => statSync(busPath(root, LAYOUT.groups, n)).isDirectory())
      .sort();
  } catch {
    return [];
  }
}

export function readGroup(root, name) {
  return readJsonSafe(join(groupDir(root, name), 'group.json'), null);
}

export function requireGroup(root, name) {
  const g = readGroup(root, name);
  if (!g) throw new Error(`没有这个组：${name}。先跑 \`agent-bus group create ${name}\`。`);
  return g;
}

/**
 * 建组。一个组只有 membership 和 purpose —— 没有优先级、没有角色层级。
 * 组是作用域，不是组织架构图。
 */
export function createGroup(root, name, { purpose = '' } = {}) {
  const existing = readGroup(root, name);
  if (existing) return { created: false, group: existing };
  const g = { v: PROTOCOL_VERSION, name, purpose, members: [], created_at: localIso() };
  const dir = groupDir(root, name);
  writeJsonNew(join(dir, 'group.json'), g);
  ensureDir(join(dir, LAYOUT.broadcast));
  return { created: true, group: g };
}

export function addMember(root, groupName, member) {
  const g = requireGroup(root, groupName);
  assertName(member, '成员名');
  if (!participantExists(root, member)) {
    throw new Error(`${member} 还不是这个 bus 的参与者。先跑 \`agent-bus join ${member}\`。`);
  }
  if (g.members.includes(member)) return g;
  g.members = [...g.members, member].sort();
  writeJson(join(groupDir(root, groupName), 'group.json'), g);
  return g;
}

export function removeMember(root, groupName, member) {
  const g = requireGroup(root, groupName);
  g.members = g.members.filter((m) => m !== member);
  writeJson(join(groupDir(root, groupName), 'group.json'), g);
  return g;
}

/** 这个参与者所在的全部组。 */
export function groupsOf(root, participant) {
  return listGroups(root).filter((name) => (readGroup(root, name)?.members || []).includes(participant));
}

// ---------------------------------------------------------------- 公告板

export function boardPath(root, groupName) {
  return join(groupDir(root, groupName), LAYOUT.board);
}

export function readBoard(root, groupName) {
  requireGroup(root, groupName);
  return readTextSafe(boardPath(root, groupName), '');
}

/**
 * 往公告板追加一行。刻意做成 append-only：
 * 它是给人读的推理记录，不是数据库 —— 改历史比留脏记录更危险。
 */
export function appendBoard(root, groupName, { from, text, kind = 'note' } = {}) {
  requireGroup(root, groupName);
  assertName(from, '作者名');
  const line = `- ${localIso()} · **${from}** · ${kind} — ${String(text).replace(/\s*\n\s*/g, ' ')}\n`;
  const file = boardPath(root, groupName);
  if (!existsSync(file)) appendFileSync(file, `# ${groupName}\n\n`, 'utf8');
  appendFileSync(file, line, 'utf8');
  return line;
}

// ---------------------------------------------------------------- 删除（仅测试用）

export function removeParticipant(root, name) {
  rmSync(participantDir(root, name), { recursive: true, force: true });
}

export function removeGroup(root, name) {
  rmSync(groupDir(root, name), { recursive: true, force: true });
}
