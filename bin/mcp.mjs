#!/usr/bin/env node
// agent-bus 的 MCP server（stdio，零依赖，逐行 JSON-RPC）。
//
// 两个硬约束，改代码前先记住：
//   1. stdout 是协议通道 —— 任何调试输出都必须走 stderr。混一行进去客户端就废了。
//   2. notification 没有 id，不能回任何东西。回了就是未请求的响应，客户端会报错。
//
// 工具描述里刻意写满了协议立场（「别发消息，先读 state」这类）。
// 模型只会读工具描述，不会读你的 README。

import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  PHASES, appendBoard, collect, patchState, peek, readBoard, readState,
  requireRoot, requireState, sendAnnounce, sendAsk,
} from '../src/index.mjs';
import { LAYOUT, busPath, claim } from '../src/store.mjs';

/** 包版本。和协议版本（bus.json 的 v）不是一回事。 */
const PKG_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// ---------------------------------------------------------------- 身份

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : null;
};

const ROOT = (() => {
  const r = flag('root');
  return r ? resolve(r) : requireRoot(process.cwd());
})();

const PEER = (() => {
  const p = flag('peer') || process.env.AGENT_BUS_PEER;
  if (p) return p;
  try {
    return readFileSync(join(ROOT, '.bus-peer'), 'utf8').trim();
  } catch {
    return null;
  }
})();

function log(msg) {
  process.stderr.write(`[agent-bus-mcp] ${msg}\n`);
}

function requirePeer() {
  if (!PEER) {
    throw new Error('这个 MCP server 不知道自己代表谁。启动时加 --peer <名字>，或设 AGENT_BUS_PEER，或在 root 下写 .bus-peer。');
  }
  const s = readState(ROOT, PEER);
  if (!s) throw new Error(`${PEER} 还不是这个 bus 的参与者。先跑 agent-bus join ${PEER}。`);
  return PEER;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 工具实现

function fmtMsg(m) {
  const to = m.to.direct ? `→${m.to.direct}` : `→#${m.to.group}`;
  const lines = [`[${m.kind}] ${m.id}  ${m.from} ${to}`, `  ${m.subject}`];
  if (m.body) for (const l of String(m.body).split('\n')) lines.push(`  ${l}`);
  if (m.artifact) lines.push(`  文件 ${m.artifact.path} (${m.artifact.bytes} B, sha256 ${m.artifact.sha256})`);
  if (m.in_reply_to) lines.push(`  回复 ${m.in_reply_to}`);
  if (m.expires_at) lines.push(`  有效至 ${m.expires_at}`);
  return lines.join('\n');
}

const tools = [
  {
    name: 'recv',
    description:
      '取走发给我的消息：私信 inbox + 我所在所有组的新广播。开始一轮工作前先调这个。\n\n'
      + '消息一旦取走就归档，不会再出现第二次。同一条消息只会有一个消费者拿到。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, description: '最多取几条，默认全取' },
      },
      additionalProperties: false,
    },
    handler({ limit }) {
      const peer = requirePeer();
      const got = collect(ROOT, peer, { limit: limit ?? Infinity });
      const all = [...got.direct, ...got.broadcast];
      if (!all.length) return '没有待处理消息。';
      const parts = all.map(fmtMsg);
      if (got.expired.length) parts.push(`（另有 ${got.expired.length} 条已过期，未计入）`);
      return parts.join('\n\n');
    },
  },
  {
    name: 'ask',
    description:
      '问另一个 agent 一个必须得到回答的问题，并阻塞等它回复。\n\n'
      + '这是**最后手段**，不是默认动作。问之前先想：\n'
      + '· 答案是不是已经写在对方 state 里了？→ 用 read_state，别发消息\n'
      + '· 是不是只需要告知、不需要回答？→ 用 announce\n'
      + '· 是不是自己能定？→ 自己定，然后把决定写进 state/board\n\n'
      + '超时**不会**撤回这个问题，它会留在对方 inbox 里。超时返回 request_id，'
      + '之后可以用 wait 继续等，不要重复问一遍。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '对方参与者名（只能是具体的人，不能是组）' },
        subject: { type: 'string', description: '一句话问题' },
        body: { type: 'string', description: '背景、约束、你已经试过什么 —— 写清楚才不会来回扯皮' },
        timeout_s: { type: 'number', description: '等多少秒，默认 120' },
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false,
    },
    async handler({ to, subject, body, timeout_s }) {
      const peer = requirePeer();
      const file = sendAsk(ROOT, { from: peer, to: { direct: to }, subject, body });
      const id = basename(file, '.json');
      const waited = await waitForAnswer(peer, id, timeout_s ?? 120);
      if (waited) return waited;
      return `已发出，但 ${timeout_s ?? 120} 秒内没等到回答。\n`
        + `request_id: ${id}\n`
        + `问题还在对方 inbox 里，没有撤回。之后用 wait(request_id="${id}") 继续等，不要重发。`;
    },
  },
  {
    name: 'wait',
    description:
      '继续等一个已经问出去的问题的回答。不会重发。\n\n'
      + '这个工具存在的唯一理由：ask 超时之后**不要重发同一个问题**。'
      + '重发会让对方看到两份一模一样的问题，还得猜哪份算数。'
      + '把 ask 返回的 request_id 拿来这里继续等 —— 问题一直在对方 inbox 里，没丢。',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: 'ask 超时时返回的那个 id' },
        timeout_s: { type: 'number', description: '等多少秒，默认 120' },
      },
      required: ['request_id'],
      additionalProperties: false,
    },
    async handler({ request_id, timeout_s }) {
      const peer = requirePeer();
      const got = await waitForAnswer(peer, request_id, timeout_s ?? 120);
      return got || `还没等到。问题仍在对方 inbox 里，没有撤回。`;
    },
  },
  {
    name: 'announce',
    description:
      '单向告知，不等回答。to 可以是人名，也可以是 #组名（组广播）。\n\n'
      + '用它的场合：你的产出变了、契约要改、环境重建了。\n'
      + '不用它的场合：对方能从 state / board / 文件读到的，不要发消息重复一遍。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '人名，或者 "#组名" 表示发到整个组' },
        subject: { type: 'string', description: '一句话标题' },
        body: { type: 'string', description: '细节；可以留空' },
      },
      required: ['to', 'subject'],
      additionalProperties: false,
    },
    handler({ to, subject, body }) {
      const peer = requirePeer();
      const target = to.startsWith('#') ? { group: to.slice(1) } : { direct: to };
      const file = sendAnnounce(ROOT, { from: peer, to: target, subject, body: body || '' });
      return `已发出 ${basename(file, '.json')} → ${to}`;
    },
  },
  {
    name: 'read_state',
    description:
      '读某个 agent 现在在干什么：phase、在做的事、产出、阻塞。\n\n'
      + '**想知道对方进度，第一选择就是这里，不是发消息问。**'
      + '「凡是能从 state 读到的，不许发消息」是这套协议的核心主张。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '参与者名；留空表示看自己' },
      },
      additionalProperties: false,
    },
    handler({ name }) {
      const target = name || requirePeer();
      const s = requireState(ROOT, target);
      const lines = [
        `${s.name}${s.role ? ` · ${s.role}` : ''}`,
        `  phase  ${s.phase}${s.now ? `  ${s.now}` : ''}`,
        `  更新   ${s.updated_at}`,
      ];
      for (const key of ['produces', 'consumes', 'holds', 'blockers', 'wants']) {
        const v = s[key] || [];
        if (!v.length) continue;
        lines.push(`  ${key}`);
        for (const item of v) {
          lines.push(`    - ${typeof item === 'string' ? item : `${item.what || JSON.stringify(item)}${item.where ? ` → ${item.where}` : ''}${item.state ? ` [${item.state}]` : ''}`}`);
        }
      }
      return lines.join('\n');
    },
  },
  {
    name: 'set_state',
    description:
      '更新自己现在在干什么。这是最便宜的「让别人知道进度」的方式 —— 改这里比发消息好。\n\n'
      + 'phase 只能是 idle / working / blocked / delivering。\n'
      + '卡住了就把 phase 设成 blocked 并在 blockers 里写清楚卡在哪，别人扫一眼就能决定要不要帮你。',
    inputSchema: {
      type: 'object',
      properties: {
        phase: { type: 'string', enum: Object.values(PHASES), description: '当前状态' },
        now: { type: 'string', description: '一句话说现在具体在做什么' },
        blockers: { type: 'array', items: { type: 'string' }, description: '卡住的事，phase=blocked 时必填' },
        holds: { type: 'array', items: { type: 'string' }, description: '我手上正占着的东西（文件、端口、锁）' },
      },
      additionalProperties: false,
    },
    handler({ phase, now, blockers, holds }) {
      const peer = requirePeer();
      const patch = {};
      if (phase !== undefined) patch.phase = phase;
      if (now !== undefined) patch.now = now;
      if (blockers !== undefined) patch.blockers = blockers;
      if (holds !== undefined) patch.holds = holds;
      if (!Object.keys(patch).length) return '没有要改的字段。';
      if (patch.phase === 'blocked' && !(patch.blockers ?? readState(ROOT, peer).blockers).length) {
        return 'blocked 但没写 blockers —— 别人看到只会来问你怎么了，反而多一轮沟通。先把 blockers 写清楚。';
      }
      const next = patchState(ROOT, peer, patch);
      return `${next.name} → ${next.phase}${next.now ? `  ${next.now}` : ''}`;
    },
  },
  {
    name: 'read_board',
    description:
      '读某个组的公告板：已经定下来的决定、验证过的事实、踩过的坑、还没解决的问题。\n\n'
      + '这是这个组的长期记忆，比消息可靠 —— 消息会被消费掉，公告板一直在。'
      + '想知道「这件事当初为什么这么定」，先读这里，别去群里问一遍。',
    inputSchema: {
      type: 'object',
      properties: { group: { type: 'string', description: '组名，不带 #' } },
      required: ['group'],
      additionalProperties: false,
    },
    handler({ group }) {
      const text = readBoard(ROOT, group);
      return text.trim() || `#${group} 的公告板还是空的。`;
    },
  },
  {
    name: 'write_board',
    description:
      '往组的公告板追加一条：定下来的决定、验证过的事实、踩过的坑。\n\n'
      + '公告板是 append-only 的推理记录，改历史比留脏记录更危险 —— 想纠正就在后面再追加一条。',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '组名，不带 #' },
        text: { type: 'string', description: '要记的话' },
        kind: { type: 'string', description: 'note / decision / fact / todo，默认 note' },
      },
      required: ['group', 'text'],
      additionalProperties: false,
    },
    handler({ group, text, kind }) {
      const peer = requirePeer();
      appendBoard(ROOT, group, { from: peer, text, kind: kind || 'note' });
      return `已追加到 #${group}`;
    },
  },
];


// ---------------------------------------------------------------- 等回答

/** 只在 inbox 里找 in_reply_to 匹配的 answer，找到了才抢锁 —— 不会吞掉别的消息。 */
async function waitForAnswer(peer, requestId, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const hit = peek(ROOT, peer).find(
      (x) => x.msg.kind === 'answer' && x.msg.in_reply_to === requestId,
    );
    if (hit) {
      const from = busPath(ROOT, LAYOUT.participants, peer, LAYOUT.inbox, hit.file);
      const to = busPath(ROOT, LAYOUT.participants, peer, LAYOUT.archive, hit.file);
      if (claim(from, to)) return fmtMsg(hit.msg);
    }
    if (Date.now() >= deadline) return null;
    await sleep(200);
  }
}

// ---------------------------------------------------------------- JSON-RPC

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

async function handle(msg) {
  const { id, method, params } = msg;

  // notification：没有 id，绝不能回
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') log('client initialized');
    return;
  }

  try {
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'agent-bus', version: PKG_VERSION },
        instructions:
          `你在 agent-bus 里代表 "${PEER || '(未指定)'}"，bus root 是 ${ROOT}。\n`
          + '每轮开始先 recv。想知道别人进度先 read_state，不要发消息问。'
          + 'blocked 时要写 blockers。',
      });
    }

    if (method === 'tools/list') {
      return reply(id, {
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    }

    if (method === 'tools/call') {
      const tool = tools.find((t) => t.name === params?.name);
      if (!tool) return replyError(id, -32602, `没有这个工具：${params?.name}`);
      try {
        const text = await tool.handler(params.arguments || {});
        return reply(id, textResult(String(text)));
      } catch (e) {
        return reply(id, textResult(e.message, true));
      }
    }

    if (method === 'ping') return reply(id, {});

    return replyError(id, -32601, `不支持的方法：${method}`);
  } catch (e) {
    log(`处理 ${method} 时出错：${e.stack || e.message}`);
    return replyError(id, -32603, e.message);
  }
}

function main() {
  log(`root=${ROOT} peer=${PEER || '(未指定)'} tools=${tools.length}`);
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      log('收到一行不是 JSON 的东西，丢掉');
      return;
    }
    handle(msg).catch((e) => log(`未捕获：${e.stack || e.message}`));
  });
  rl.on('close', () => process.exit(0));
}

main();
