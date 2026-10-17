#!/usr/bin/env node
// agent-bus CLI。
//
// 设计约束：零依赖、单文件、所有输出都是人可读的一屏以内。
// 输出格式不追求机器友好 —— 需要机器友好的直接挂 MCP（bin/mcp.mjs），
// 或者 `import { ... } from 'agent-bus'`。

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  PHASES, PROTOCOL_VERSION, addMember, appendBoard, collect, createGroup, detectRiskyVolume,
  ensureParticipant, initBus, listGroups, listParticipants, patchState, peek, pendingCount,
  readBoard, readBus, readGroup, readState, removeMember, requireRoot, sendAnnounce, sendAnswer,
  sendAsk, sendDelivery,
} from '../src/index.mjs';
import { LAYOUT, busPath, listJsonFiles, readJsonSafe } from '../src/store.mjs';

/** 包版本（给人看的）和协议版本（写进 bus.json 的 v，给程序看的）是两件事，别混用。 */
const PKG_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// ---------------------------------------------------------------- 输出

const NO_COLOR = process.env.NO_COLOR != null || process.argv.includes('--no-color');
const paint = (code) => (s) => (NO_COLOR ? String(s) : `\u001b[${code}m${s}\u001b[0m`);
const dim = paint('2');
const bold = paint('1');
const green = paint('32');
const yellow = paint('33');
const red = paint('31');
const cyan = paint('36');

const out = (s = '') => process.stdout.write(`${s}\n`);
const fail = (s) => {
  process.stderr.write(`${red('✗')} ${s}\n`);
  process.exitCode = 1;
};

// ---------------------------------------------------------------- 参数

const SHORT = { s: 'subject', b: 'body', m: 'message', f: 'file', p: 'peer', t: 'to' };

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-color') continue;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
      continue;
    }
    if (a.startsWith('-') && a.length === 2 && SHORT[a[1]]) {
      flags[SHORT[a[1]]] = argv[++i];
      continue;
    }
    positional.push(a);
  }
  return { flags, positional };
}

/** 当前是谁在说话：--peer > AGENT_BUS_PEER > .bus-peer 文件。 */
function resolvePeer(root, flags, { required = true } = {}) {
  const peer = flags.peer || process.env.AGENT_BUS_PEER || readFileSafe(join(root, '.bus-peer'));
  if (!peer) {
    if (!required) return null;
    throw new Error('不知道你是哪个参与者。用 --peer <名字>，或者设 AGENT_BUS_PEER，或者在 root 下写一个 .bus-peer。');
  }
  return String(peer).trim();
}

function readFileSafe(p) {
  try {
    return readFileSync(p, 'utf8').trim();
  } catch {
    return '';
  }
}

function fmtPhase(phase) {
  if (!PHASES.has(phase)) return yellow(phase || '?');
  if (phase === 'blocked') return red(phase);
  if (phase === 'working') return cyan(phase);
  if (phase === 'delivering') return green(phase);
  return dim(phase);
}

function fmtMsg(msg) {
  const tag = {
    ask: yellow('[问]'),
    answer: green('[答]'),
    announce: cyan('[告]'),
    delivery: green('[件]'),
  }[msg.kind] || dim(`[${msg.kind}]`);

  const to = msg.to.direct ? `→${msg.to.direct}` : `→#${msg.to.group}`;
  const head = `${tag} ${dim(msg.id)}  ${bold(msg.from)} ${to}`;
  const lines = [head, `    ${msg.subject}`];
  if (msg.body) for (const line of String(msg.body).split('\n')) lines.push(`    ${dim(line)}`);
  if (msg.artifact) lines.push(`    ${dim('文件')} ${msg.artifact.path} ${dim(`${msg.artifact.bytes} B  ${msg.artifact.sha256.slice(0, 12)}…`)}`);
  if (msg.in_reply_to) lines.push(`    ${dim(`回复 ${msg.in_reply_to}`)}`);
  if (msg.expires_at) lines.push(`    ${dim(`有效至 ${msg.expires_at}`)}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- 命令

function cmdInit(root, _pos, flags) {
  const { created, bus } = initBus(root, { name: flags.name });
  if (!created) {
    out(`${dim('已存在')} ${busPath(root, 'bus.json')} ${dim(`(name: ${bus.name})`)}`);
    return;
  }
  out(`${green('✓')} 建好了 ${bold(busPath(root, 'bus.json'))}`);
  out(dim('  下一步：agent-bus join <你的名字>'));

  const risky = detectRiskyVolume(root);
  if (risky) out(`  ${yellow('⚠')} ${risky}`);
}

function cmdJoin(root, positional, flags) {
  const name = positional[0];
  if (!name) throw new Error('用法：agent-bus join <名字> [--role 说明]');
  const { created } = ensureParticipant(root, name, { role: flags.role || '' });

  const peerFile = join(root, '.bus-peer');
  if (!existsSync(peerFile) || flags.default) {
    writeFileSync(peerFile, `${name}\n`, 'utf8');
    out(`${green('✓')} ${created ? '加入' : '已存在'} ${bold(name)}，并设为默认参与者（.bus-peer）`);
  } else {
    out(`${green('✓')} ${created ? '加入' : '已存在'} ${bold(name)}`);
    out(dim(`  当前默认参与者是 ${readFileSafe(peerFile)}，没改。想改加 --default`));
  }
  out(dim(`  别把 .bus-peer 提交到 git —— 它是「这台机器上我是谁」，不是项目配置。`));
}

function cmdList(root, _pos, _flags) {
  const people = listParticipants(root);
  if (!people.length) {
    out(dim('还没有参与者。agent-bus join <名字>'));
    return;
  }
  const width = Math.max(...people.map((p) => p.length));
  for (const p of people) {
    const s = readState(root, p) || {};
    const pending = pendingCount(root, p);
    const tag = pending ? yellow(` ${pending} 条未读`) : '';
    out(`  ${bold(p.padEnd(width))}  ${fmtPhase(s.phase)}${s.now ? `  ${s.now}` : ''}${tag}`);
  }
  const groups = listGroups(root);
  if (groups.length) {
    out();
    for (const g of groups) {
      const grp = readGroup(root, g);
      out(`  ${cyan(`#${g}`)}  ${dim((grp.members || []).join(', ') || '(空)')}${grp.purpose ? `  ${dim(grp.purpose)}` : ''}`);
    }
  }
}

function cmdSend(root, positional, flags, kind) {
  const to = flags.to || positional[0];
  if (!to) throw new Error('用法：agent-bus send <收件方|#组> -s 主题 [-b 正文]');
  const from = resolvePeer(root, flags);
  const subject = flags.subject;
  if (!subject) throw new Error('缺 --subject（-s）');

  const target = to.startsWith('#') ? { group: to.slice(1) } : { direct: to };
  const file = sendAnnounce(root, { from, to: target, subject, body: flags.body || '' });
  out(`${green('✓')} 发出 ${dim(file.replace(root + '\\', '').replace(root + '/', ''))}`);
}

function cmdAsk(root, positional, flags) {
  const to = flags.to || positional[0];
  if (!to) throw new Error('用法：agent-bus ask <收件方> -s 主题 [-b 正文] [--ttl 24h]');
  if (to.startsWith('#')) throw new Error('ask 只能问一个具体的人。问一个组等于问没人 —— 要征求意见用 send 到组。');
  const from = resolvePeer(root, flags);
  const subject = flags.subject;
  if (!subject) throw new Error('缺 --subject（-s）');
  const ttlMs = flags.ttl ? parseDuration(flags.ttl) : undefined;
  const file = sendAsk(root, { from, to: { direct: to }, subject, body: flags.body || '', ttlMs });
  // 打裸 id，不打文件名 —— 这一行是给人复制去 `answer` 用的，`.json` 只会被一起复制进去。
  out(`${green('✓')} 问了 ${bold(to)}  ${dim(messageId(file))}`);
  out(dim(`  对方回：agent-bus answer ${messageId(file)} -s "..."`));
}

/** 从写好的消息文件名里取裸 id（去掉目录和 .json）。 */
function messageId(file) {
  return String(file).split(/[\\/]/).pop().replace(/\.json$/, '');
}

function parseDuration(text) {
  const m = /^(\d+)\s*([smhd]?)$/.exec(String(text).trim());
  if (!m) throw new Error(`看不懂这个时长：${text}。用 30m / 12h / 7d 这种。`);
  const n = Number(m[1]);
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2] || 'h'];
  return n * unit;
}

function cmdAnswer(root, positional, flags) {
  const inReplyTo = positional[0];
  if (!inReplyTo) throw new Error('用法：agent-bus answer <原消息 id> -s 主题 [-b 正文]');
  const from = resolvePeer(root, flags);
  const subject = flags.subject;
  if (!subject) throw new Error('缺 --subject（-s）');
  const file = sendAnswer(root, { from, inReplyTo, subject, body: flags.body || '' });
  out(`${green('✓')} 答了 ${dim(inReplyTo)}`);
}

function cmdDeliver(root, positional, flags) {
  const to = flags.to || positional[0];
  const artifactPath = flags.file || positional[1];
  if (!to || !artifactPath) throw new Error('用法：agent-bus deliver <收件方> --file <产物路径> [-s 主题] [-b 说明]');
  const from = resolvePeer(root, flags);
  const file = sendDelivery(root, {
    from, to: { direct: to }, subject: flags.subject || `交付 ${artifactPath}`, body: flags.body || '', artifactPath,
  });
  out(`${green('✓')} 交付 ${dim(artifactPath)}`);
}

function cmdRecv(root, _pos, flags) {
  const peer = resolvePeer(root, flags);
  if (flags.keep) {
    const items = peek(root, peer);
    if (!items.length) return out(dim('没有待处理消息。'));
    for (const { msg } of items) out(fmtMsg(msg));
    return out(dim(`\n${items.length} 条（--keep 只看不拿走）`));
  }

  const got = collect(root, peer);
  const all = [...got.direct, ...got.broadcast];
  if (!all.length) {
    if (!got.expired.length) return out(dim('没有待处理消息。'));
  }
  if (flags.json) {
    out(JSON.stringify({ ...got, peer }, null, 2));
    return;
  }
  for (const msg of got.direct) out(fmtMsg(msg));
  for (const msg of got.broadcast) out(`${fmtMsg(msg)}`);
  if (got.expired.length) out(yellow(`\n${got.expired.length} 条已过期，没算进来（在 archive 里）`));
  if (got.skipped.length) out(dim(`\n${got.skipped.length} 条被别的进程同时取走，跳过`));
  if (all.length) out(dim(`\n共 ${all.length} 条`));
}

function cmdState(root, positional, flags) {
  const name = positional[0] || resolvePeer(root, flags, { required: false });
  if (!name) throw new Error('用法：agent-bus state [名字] [--phase working] [--now 说明]');
  const current = readState(root, name);
  if (!current) throw new Error(`没有这个参与者：${name}`);

  const patch = {};
  // 用 `in flags` 而不是 `if (flags.x)` —— `--now ""` 在 shell 里会被解析成
  // `flags.now = true`（flag 后面没值），那是「显式清空」，不是「设成布尔 true」。
  if (flags.phase) patch.phase = String(flags.phase);
  if ('now' in flags) patch.now = typeof flags.now === 'string' ? flags.now : '';
  if ('role' in flags) patch.role = typeof flags.role === 'string' ? flags.role : '';
  for (const key of ['produces', 'consumes', 'holds', 'blockers', 'wants']) {
    if (!(key in flags)) continue;
    const v = flags[key];
    if (v === true || v === '') { patch[key] = []; continue; }   // 显式清空
    patch[key] = Array.isArray(v) ? v : String(v).split(',').map((s) => s.trim()).filter(Boolean);
  }

  if (!Object.keys(patch).length) {
    // 不指定就渲成一屏能读完的样子。要原始 JSON 加 --json。
    if (flags.json) { out(JSON.stringify(current, null, 2)); return; }
    out(`${bold(name)}  ${fmtPhase(current.phase)}${current.now ? `  ${current.now}` : ''}`);
    if (current.role) out(dim(`  ${current.role}`));
    for (const [label, key] of [['产出', 'produces'], ['消费', 'consumes'], ['持有', 'holds'], ['在等', 'wants']]) {
      const list = current[key] || [];
      if (list.length) out(dim(`  ${label}：`) + list.map((x) => (typeof x === 'string' ? x : x.what || JSON.stringify(x))).join('、'));
    }
    if ((current.blockers || []).length) out(`${yellow('  卡在：')}${current.blockers.join(' / ')}`);
    out(dim(`  更新于 ${current.updated_at}`));
    return;
  }
  const next = patchState(root, name, patch);
  out(`${green('✓')} ${bold(name)} ${fmtPhase(next.phase)}${next.now ? `  ${next.now}` : ''}`);
  if (flags.json) out(JSON.stringify(next, null, 2));
}
function cmdGroup(root, positional, flags) {
  const [action, ...rest] = positional;
  if (!action || action === 'ls' || action === 'list') {
    const groups = listGroups(root);
    if (!groups.length) return out(dim('还没有组。agent-bus group create <名字> — 然后 group add <组> <成员>'));
    for (const g of groups) {
      const grp = readGroup(root, g);
      out(`  ${cyan(`#${g}`)}  ${dim((grp.members || []).join(', ') || '(空)')}`);
      if (grp.purpose) out(`    ${dim(grp.purpose)}`);
    }
    return;
  }

  if (action === 'create') {
    const name = rest[0];
    if (!name) throw new Error('用法：agent-bus group create <名字> [--purpose 说明]');
    const { created } = createGroup(root, name, { purpose: flags.purpose || '' });
    out(`${green('✓')} ${created ? '建了' : '已有'} ${cyan(`#${name}`)}`);
    out(dim(`  下一步：agent-bus group add ${name} <成员>`));
    return;
  }

  if (action === 'add' || action === 'rm' || action === 'remove') {
    const [g, member] = rest;
    if (!g || !member) throw new Error(`用法：agent-bus group ${action} <组> <成员>`);
    if (action === 'add') {
      addMember(root, g, member);
      out(`${green('✓')} ${member} 加入 ${cyan(`#${g}`)}`);
    } else {
      removeMember(root, g, member);
      out(`${green('✓')} ${member} 移出 ${cyan(`#${g}`)}`);
    }
    return;
  }

  if (action === 'show') {
    const name = rest[0];
    if (!name) throw new Error('用法：agent-bus group show <组>');
    const g = readGroup(root, name);
    if (!g) return fail(`没有这个组：${name}`);
    out(`${cyan(`#${g.name}`)}  ${dim(g.created_at)}`);
    if (g.purpose) out(`  ${g.purpose}`);
    out(`  成员  ${(g.members || []).join(', ') || dim('(空)')}`);
    const b = readBoard(root, name);
    if (b.trim()) {
      out(`\n${bold('公告板')}`);
      out(b.trim());
    }
    return;
  }

  throw new Error(`不认识的 group 子命令：${action}。有 ls / create / add / rm / show`);
}

function cmdBoard(root, positional, flags) {
  const name = positional[0];
  if (!name) throw new Error('用法：agent-bus board <组> [-m 要说的话] [--from 名字]');
  if (flags.message) {
    const from = flags.from || resolvePeer(root, flags);
    appendBoard(root, name, { from, text: flags.message, kind: flags.kind || 'note' });
    return out(`${green('✓')} 记到 ${cyan(`#${name}`)} 的公告板`);
  }
  const text = readBoard(root, name);
  out(text.trim() || dim('（公告板还是空的）'));
}

function fmtEvent(ev) {
  if (ev.op === 'send') {
    const kind = { announce: '告', ask: '问', answer: '答', deliver: '件' }[ev.kind] || ev.kind;
    return `${green(`[${kind}]`)} ${bold(ev.from)} → ${ev.to}  ${ev.subject || ''}  ${dim(ev.id)}`;
  }
  if (ev.op === 'recv') return `${dim('[读]')} ${bold(ev.by)} 取走 ${dim(ev.id)}`;
  if (ev.op === 'state') return `${dim('[态]')} ${bold(ev.name)}  ${ev.from || '?'} → ${fmtPhase(ev.to)}`;
  return `${dim('[?]')} ${JSON.stringify(ev)}`;
}

/**
 * 回放。
 *
 * 首选审计日志 `.agent-bus/log/<yyyymmdd>.jsonl` —— 它是唯一带**时间线**的来源，
 * 能回答「谁在什么时候读了」「它什么时候变成 blocked 的」。
 * 扫消息文件做不到这两件事：消息一被消费就搬进 archive，state 是覆盖写。
 *
 * 没有日志文件时（老 bus、手工塞进来的消息）回退到扫目录。
 */
function cmdLog(root, _pos, flags) {
  const limit = Number(flags.limit) || 0;

  const logDir = busPath(root, LAYOUT.log);
  const files = existsSync(logDir)
    ? readdirSync(logDir).filter((n) => n.endsWith('.jsonl')).sort()
    : [];
  const events = [];
  for (const f of files) {
    for (const line of readFileSync(join(logDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* 写到一半被 kill 的行，跳过 */ }
    }
  }
  if (events.length) {
    const shown = limit > 0 ? events.slice(-limit) : events;
    for (const ev of shown) out(fmtEvent(ev));
    out(dim(`\n共 ${events.length} 条事件${limit && limit < events.length ? `，显示最近 ${shown.length} 条` : ''}`));
    return;
  }

  const rows = [];
  for (const p of listParticipants(root)) {
    for (const where of [LAYOUT.inbox, LAYOUT.archive]) {
      const dir = busPath(root, LAYOUT.participants, p, where);
      for (const file of listJsonFiles(dir)) {
        const msg = readJsonSafe(join(dir, file), null);
        if (msg) rows.push({ msg, where: `${p}/${where}` });
      }
    }
  }
  for (const g of listGroups(root)) {
    const dir = busPath(root, LAYOUT.groups, g, LAYOUT.broadcast);
    for (const file of listJsonFiles(dir)) {
      const msg = readJsonSafe(join(dir, file), null);
      if (msg) rows.push({ msg, where: `#${g}/broadcast` });
    }
  }
  rows.sort((a, b) => a.msg.id.localeCompare(b.msg.id));
  if (!rows.length) return out(dim('还没有任何消息。'));

  const shown = limit > 0 ? rows.slice(-limit) : rows;
  for (const { msg, where } of shown) out(`${fmtMsg(msg)}\n    ${dim(where)}`);
  out(dim(`\n共 ${rows.length} 条${limit && limit < rows.length ? `，显示最近 ${shown.length} 条` : ''}`));
}

function cmdDoctor(root, _pos, _flags) {
  const problems = [];
  const notes = [];

  const bus = readBus(root);
  if (!bus) problems.push(`没有 bus.json —— 这里不是 root。`);
  else if (bus.v !== PROTOCOL_VERSION) problems.push(`bus.json 的 v=${bus.v}，本版本认识 v=${PROTOCOL_VERSION}`);

  const risky = detectRiskyVolume(root);
  if (risky) problems.push(risky);

  const people = listParticipants(root);
  if (!people.length) notes.push('还没有参与者。');

  for (const p of people) {
    const s = readState(root, p);
    if (!s) {
      problems.push(`${p}: 缺 state.json`);
      continue;
    }
    if (!PHASES.has(s.phase)) problems.push(`${p}: phase "${s.phase}" 不认识`);
    if (s.name !== p) problems.push(`${p}: state.json 里的 name 是 "${s.name}"，和目录名不符`);
    const dir = busPath(root, LAYOUT.participants, p);
    if (!existsSync(join(dir, LAYOUT.archive))) problems.push(`${p}: 缺 archive 目录 —— 收到第一条消息时会失败`);
  }

  for (const g of listGroups(root)) {
    const grp = readGroup(root, g);
    if (!grp) {
      problems.push(`#${g}: 缺 group.json`);
      continue;
    }
    for (const m of grp.members || []) {
      if (!people.includes(m)) problems.push(`#${g}: 成员 ${m} 不存在`);
    }
    if (!(grp.members || []).length) notes.push(`#${g}: 空组`);
  }

  // 孤儿 tmp：写了一半就崩的残留
  let orphans = 0;
  const walk = (dir) => {
    for (const name of listJsonFiles(dir)) if (name.includes('.tmp')) orphans++;
    for (const p of people) {
      const d = busPath(root, LAYOUT.participants, p, LAYOUT.inbox);
      for (const name of listJsonFiles(d)) if (name.includes('.tmp')) orphans++;
    }
  };
  try { walk(busPath(root, LAYOUT.groups)); } catch {}
  if (orphans) notes.push(`有 ${orphans} 个 .tmp 残留（崩溃留下的，可以手工删）`);

  if (!problems.length) {
    out(`${green('✓')} 体检通过`);
  } else {
    out(`${red('✗')} ${problems.length} 个问题`);
    for (const p of problems) out(`  - ${p}`);
  }
  for (const n of notes) out(`  ${dim('·')} ${dim(n)}`);
  if (problems.length) process.exitCode = 1;
}

function cmdHelp() {
  out(`${bold('agent-bus')} ${dim(`v${PKG_VERSION} —— 让一台机器上的几个 agent 真的能一起干活`)}

${bold('开始')}
  agent-bus init [--name 项目名]     在当前目录建一个 bus（往上找 bus.json 就是 root）
  agent-bus join <名字> [--role 说明]  登记一个参与者，并设为默认（.bus-peer）

${bold('说话')}
  agent-bus send <对方|#组> -s 主题 [-b 正文]     单向告知
  agent-bus ask <对方> -s 主题 [-b 正文] [--ttl 24h]   要一个回答
  agent-bus answer <原消息 id> -s 主题 [-b 正文]        回答
  agent-bus deliver <对方> --file <路径> [-s 主题]       交一个文件（自动算 sha256）

${bold('听')}
  agent-bus recv [--json] [--keep]    取走 inbox + 所在组的新广播（--keep 只看不拿）
  agent-bus log [--limit 20]          全部消息按时间回放

${bold('在场')}
  agent-bus list                      谁在，各自什么状态，几个组
  agent-bus state [名字]              看状态（不带参数就是看自己）
  agent-bus state --phase working --now "在跑渲染"   改状态

${bold('组')}
  agent-bus group ls | create <名> | add <组> <人> | rm <组> <人> | show <组>
  agent-bus board <组> [-m "要说的话"] [--from 名字]   公告板（append-only）

${bold('查')}
  agent-bus doctor                    体检：root、state、孤儿文件、网络盘

${dim('退出码：0 正常 / 1 出错。所有命令在 root 下的任意子目录都能跑。')}`);
}

// ---------------------------------------------------------------- main

const COMMANDS = {
  init: cmdInit,
  join: cmdJoin,
  list: cmdList,
  ls: cmdList,
  send: cmdSend,
  ask: cmdAsk,
  answer: cmdAnswer,
  deliver: cmdDeliver,
  recv: cmdRecv,
  state: cmdState,
  group: cmdGroup,
  board: cmdBoard,
  log: cmdLog,
  doctor: cmdDoctor,
  help: cmdHelp,
};

function main() {
  const argv = process.argv.slice(2);
  const { flags, positional } = parseArgs(argv);
  const cmd = positional.shift() || 'help';

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return cmdHelp();
  if (cmd === 'version' || cmd === '--version') return out(`agent-bus ${PKG_VERSION} (protocol v${PROTOCOL_VERSION})`);

  const fn = COMMANDS[cmd];
  if (!fn) {
    fail(`不认识的命令：${cmd}`);
    return cmdHelp();
  }

  let root;
  if (cmd === 'init') {
    root = resolve(process.cwd());
  } else {
    try {
      root = requireRoot(process.cwd());
    } catch (e) {
      fail(e.message);
      return;
    }
  }

  try {
    fn(root, positional, flags);
  } catch (e) {
    fail(e.message);
  }
}

main();
