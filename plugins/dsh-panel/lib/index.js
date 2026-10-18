/**
 * dsh-plugin-agent-bus · host 半边
 *
 * 职责：把「工作区里的项目」和 `.agent-bus` 的群组状态翻译成几条 HTTP 路由，
 * 供侧栏面板读取与操作。不新建任何存储 —— 读写的还是 agent-bus 那一份文件。
 *
 * 核心概念：
 *   项目 = 工作区里的一个目录（有 .git 或 package.json），比如 incoming/openfilm。
 *   群组 = 一组项目。可以随便建多少个。
 *   项目名就是 agent-bus 里的 participant 名（目录名，做过字符清洗）。
 *
 * 路由（都是 exact）：
 *   GET  /api/agent-bus/snapshot        → 项目 / 群组 / 成员 / 最近事件
 *   POST /api/agent-bus/group/create    → {name}
 *   POST /api/agent-bus/group/delete    → {name}
 *   POST /api/agent-bus/group/rename    → {name, to}
 *   POST /api/agent-bus/group/member    → {group, peer, action:'add'|'remove'}
 *   POST /api/agent-bus/send            → {to, kind, subject, body}
 */
import { readFileSync, existsSync, readdirSync, appendFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import zlib from 'node:zlib';
import * as bus from 'agent-bus';

export const name = 'agent-bus-ui';
export const inject = ['webServer'];

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`请求体不是合法 JSON：${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

/** participant / 群组名只能是文件系统安全的字符。 */
function cleanName(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 扫工作区里的项目：有 .git 或 package.json 的目录，最多往下三层。
 * 名字取目录名；重名时带上路径，避免两个同名目录打架。
 */
function discoverProjects(root) {
  const found = new Map();
  const visit = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).replace(/\\/g, '/');
      const isGit = existsSync(join(abs, '.git'));
      const isProject = isGit || existsSync(join(abs, 'package.json'));
      if (isProject) {
        let id = cleanName(entry.name);
        if (found.has(id)) id = cleanName(rel.replace(/\//g, '-'));
        found.set(id, { id, path: rel, markers: isGit ? 'git' : 'package' });
      }
      visit(abs, depth + 1);
    }
  };
  visit(root, 1);
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/* ── 会话 ──────────────────────────────────────────────────────────────
 * 群成员除了「工作区里的项目」，还可以是「DSH 的历史会话」。
 * 会话存在 $DSH_HOME/sessions/<workspace-key>/<session-id>/session.v4.jsonl.zstd，
 * 一个文件里是多帧 zstd 拼接的 JSONL（Node 的 zstd 只解第一帧，得自己扫 magic）。
 * 只读、只用来拿标题和活跃时间，从不改会话文件。
 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const titleCache = new Map();

function zstdFrames(raw, maxFrames) {
  const starts = [];
  for (let i = 0; i + 4 <= raw.length && starts.length < maxFrames; i++) {
    if (raw.compare(ZSTD_MAGIC, 0, 4, i, i + 4) === 0) starts.push(i);
  }
  const out = [];
  for (let k = 0; k < starts.length; k++) {
    const to = k + 1 < starts.length ? starts[k + 1] : raw.length;
    try {
      out.push(zlib.zstdDecompressSync(raw.subarray(starts[k], to)).toString('utf8'));
    } catch {
      /* 帧边界猜错，跳过 */
    }
  }
  return out;
}

function textOfMessage(d) {
  if (!d) return '';
  if (typeof d.text === 'string') return d.text;
  if (typeof d.content === 'string') return d.content;
  if (Array.isArray(d.content)) {
    return d.content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join(' ');
  }
  return '';
}

function firstUserText(file) {
  let raw;
  try {
    raw = readFileSync(file);
  } catch {
    return '';
  }
  for (const chunk of zstdFrames(raw, 40)) {
    for (const line of chunk.split('\n')) {
      if (!line) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      const role = j.role || (j.data && j.data.role);
      if (role !== 'user') continue;
      const t = textOfMessage(j.data || j).trim();
      if (t && !t.startsWith('<')) return t.replace(/\s+/g, ' ').slice(0, 42);
    }
  }
  return '';
}

/** C:\deepseek harness → --C-deepseek~0020harness-- */
function sessionDirKey(root) {
  const body = String(root)
    .replace(/\\/g, '-')
    .replace(/:/g, '')
    .replace(/ /g, '~0020');
  return '--' + body + '--';
}

function shortId(id) {
  const m = /([0-9a-f]{8})/.exec(String(id));
  return m ? m[1] : String(id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
}

/** .dsh/storages/workspace.json 记着哪些会话被归档 / 置顶 —— 侧栏就是按它过滤的。 */
function readWorkspaceIndex() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  try {
    return JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 侧栏显示的那个标题（"10086"、"配IP赚钱项目"）存在 projcache 里，不是首句原文。 */
function cachedTitle(id) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const file = join(home, 'storages', 'session_projcache', 'sessions', id + '.json');
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return j?.record?.rows?.title?.val || '';
  } catch {
    return '';
  }
}

function discoverSessions(root, limit = 80) {
  if (typeof zlib.zstdDecompressSync !== 'function') return [];
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const dir = join(home, 'sessions', sessionDirKey(root));
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  // 侧栏不显示归档会话，这里跟着它走，否则面板里全是早就收起来的旧会话。
  const index = readWorkspaceIndex();
  const archived = new Set((index?.global?.archivedSessionIds ?? []).map(String));
  const pinned = new Set((index?.global?.pinnedSessionIds ?? []).map(String));
  let scope = null;
  const tables = index?.tables?.workspaces ?? {};
  for (const wsKey of Object.keys(tables)) {
    const w = tables[wsKey];
    if (w && typeof w.path === 'string' && w.path.toLowerCase() === String(root).toLowerCase()) {
      scope = new Set((w.sessionIds ?? []).map(String));
      break;
    }
  }

  const items = [];
  for (const name of names) {
    const id = name.startsWith('session-') ? name : 'session-' + name;
    if (archived.has(id)) continue;
    if (scope && !scope.has(id)) continue;
    const file = join(dir, name, 'session.v4.jsonl.zstd');
    let mtime = 0;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    let head = {};
    try {
      const raw = readFileSync(file);
      head = JSON.parse((zstdFrames(raw, 1)[0] || '').split('\n')[0]);
    } catch {
      /* 头部读不到就当普通会话 */
    }
    if (head.origin === 'subagent') continue;
    const key = file + ':' + mtime;
    let title = titleCache.get(key);
    if (title === undefined) {
      title = cachedTitle(id) || firstUserText(file);
      titleCache.set(key, title);
    }
    items.push({
      kind: 'session',
      id: 'sess-' + shortId(id),
      session: id,
      title: title || id.slice(0, 22),
      cwd: head.cwd || '',
      created: head.createdAt || 0,
      active: mtime,
      pinned: pinned.has(id),
    });
  }
  items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.active - a.active);
  return items.slice(0, limit);
}

/** 今天的审计日志，最后 limit 条。读不到就当没有。 */
function recentLog(root, limit = 40) {
  try {
    const logDir = join(root, '.agent-bus', 'log');
    if (!existsSync(logDir)) return [];
    const files = readdirSync(logDir).filter((f) => f.endsWith('.jsonl')).sort();
    if (files.length === 0) return [];
    const latest = join(logDir, files[files.length - 1]);
    const lines = readFileSync(latest, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { op: 'bad-line', raw: line.slice(0, 120) };
      }
    });
  } catch {
    return [];
  }
}

function stateOf(root, peer) {
  try {
    return bus.readState(root, peer);
  } catch {
    return null;
  }
}

/** 读某个群的广播历史，按时间升序 —— 这就是「群聊记录」。 */
function readThread(root, group) {
  const dir = join(root, '.agent-bus', 'groups', group, 'broadcast');
  if (!existsSync(dir)) return [];
  const rows = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const m = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      rows.push({
        id: String(m.id ?? file.replace(/\.json$/, '')),
        kind: m.kind ?? 'announce',
        from: m.from ?? '',
        subject: m.subject ?? '',
        body: m.body ?? '',
        at: m.created_at ?? '',
        reply_to: m.in_reply_to ?? null,
      });
    } catch {
      /* 单条坏消息不影响整条时间线 */
    }
  }
  return rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** headless 子进程要自己带 key —— 它读不到面板进程的内存。 */
function readApiKey() {
  try {
    const raw = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
    const hit = raw.match(/DEEPSEEK_API_KEY:\s*([A-Za-z0-9_\-.]+)/);
    return hit ? hit[1] : '';
  } catch {
    return '';
  }
}

/**
 * 让某个成员在后台「醒来」回一句。
 *
 * 用的是 headless profile：`dsh --profile headless -`，prompt 走 stdin（避开 Windows
 * 命令行引号地狱），每次都是独立会话 —— 上下文不靠会话记忆，靠盘上的 recv。
 * 这里不等它：它回完自己写进 .agent-bus，面板下一次轮询就能看到。
 */
function spawnReply({ root, group, member, text, key, dbg }) {
  const cli = join(root, 'agent-bus', 'bin', 'cli.mjs');
  const prompt = [
    `你在 agent-bus 里代表「${member}」。群 #${group} 刚有人说：`,
    '',
    String(text).slice(0, 3000),
    '',
    '先看未读消息，再回一句：',
    `1. node "${cli}" --peer ${member} recv --json`,
    `2. node "${cli}" --peer ${member} send "#${group}" -s "简短主题" -b "你的回复"`,
    '',
    '要求：',
    '- 只看只读，不修改任何文件，不做 git 操作',
    '- 基于你项目里的真实情况回答，200 字以内',
    '- 只发一条，不要客套，不要发第二条',
  ].join('\n');

  const child = spawn('cmd.exe', ['/d', '/s', '/c', 'dsh --profile headless -'], {
    cwd: root,
    // headless 默认 workspace-write + approval:ask，而 headless 里没人能点「允许」，
    // 工具调用会被静默拒掉，模型只看到空结果（就是「pwsh 不执行、exit 0」那个假象）。
    // dsh-base 的 approval.policy 只有在 danger-full-access 下才是 never，所以子进程
    // 必须带着这个模式跑。只作用于这一次 spawn，不动 headless profile 本身。
    env: { ...process.env, DEEPSEEK_API_KEY: key, DSH_PERMISSION_MODE: 'danger-full-access' },
    windowsHide: true,
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.on('error', (err) => dbg(`唤醒 ${member} 失败：${err.message}`));
  child.stdin.write(prompt, 'utf8');
  child.stdin.end();
  child.unref();
  dbg(`唤醒 ${member}（pid ${child.pid}）`);
  return child.pid;
}

function snapshot(root) {
  const projects = discoverProjects(root);
  const known = new Set();
  try {
    for (const p of bus.listParticipants(root)) known.add(p);
  } catch {
    /* 没 init 过就当没有参与者 */
  }

  // 已经在 bus 里、但目录已经不在了的名字也列出来，否则老成员会从面板里消失。
  const rows = projects.map((p) => ({ ...p, tracked: known.has(p.id) }));
  for (const name of known) {
    if (!rows.some((r) => r.id === name)) {
      rows.push({ id: name, path: name, markers: 'participant', tracked: true });
    }
  }

  const decorated = rows.map((p) => {
    const st = stateOf(root, p.id);
    return {
      ...p,
      phase: st?.phase ?? 'unknown',
      role: st?.role ?? '',
      title: st?.title ?? '',
      session: st?.session_id ?? '',
      now: st?.now ?? '',
      blockers: st?.blockers ?? [],
      updated_at: st?.updated_at ?? '',
    };
  });

  let groupNames = [];
  try {
    groupNames = bus.listGroups(root);
  } catch {
    groupNames = [];
  }
  const groups = groupNames.map((groupName) => ({
    name: groupName,
    members: bus.groupMembers(root, groupName),
  }));

  return { root, projects: decorated, groups, log: recentLog(root), at: new Date().toISOString() };
}

export function apply(ctx, config) {
  const root = config?.root;
  if (!root) {
    ctx.logger?.warn?.('agent-bus-ui: 没配 root，面板不会工作');
    return;
  }
  /** 面板代表哪个参与者说话。默认是主会话那个 peer。 */
  const peer = config?.peer ?? 'dsh';

  // 面板能不能用，全看下面几条路由有没有注册上。cordis 的 logger 在 Electron
  // 里看不见，所以顺手落一份到 .agent-bus/plugin.log —— 出问题时有据可查。
  const dbg = (msg) => {
    try {
      appendFileSync(
        String(root).replace(/\\/g, '/') + '/.agent-bus/plugin.log',
        new Date().toISOString() + ' ' + msg + '\n',
      );
    } catch {
      /* 日志失败不能拖垮插件 */
    }
  };
  dbg('apply 开始 root=' + root + ' peer=' + peer);

  const disposers = [];
  const own = (route) => {
    try {
      disposers.push(ctx.webServer.register(route));
      dbg('注册成功 ' + route.kind + ' ' + route.path);
    } catch (err) {
      dbg('注册失败 ' + route.path + ' : ' + (err?.message ?? err));
      ctx.logger?.warn?.(`agent-bus-ui: 注册 ${route.path} 失败：${err.message}`);
    }
  };

  const route = (path, method, fn) => {
    own({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (req.method !== method) return sendJson(res, 405, { error: `只接受 ${method}` });
        try {
          await fn(req, res);
        } catch (err) {
          sendJson(res, 400, { error: String(err?.message ?? err) });
        }
      },
    });
  };

  route('/api/agent-bus/snapshot', 'GET', async (req, res) => {
    sendJson(res, 200, snapshot(root));
  });

  route('/api/agent-bus/sessions', 'GET', async (req, res) => {
    try {
      sendJson(res, 200, { sessions: discoverSessions(root) });
    } catch (err) {
      sendJson(res, 500, { error: String((err && err.message) || err) });
    }
  });

  route('/api/agent-bus/group/create', 'POST', async (req, res) => {
    const { name } = await readBody(req);
    const clean = cleanName(name);
    if (!clean) return sendJson(res, 400, { error: '群组名不能为空' });
    bus.createGroup(root, clean);
    sendJson(res, 200, { ok: true, name: clean, groups: bus.listGroups(root) });
  });

  route('/api/agent-bus/group/delete', 'POST', async (req, res) => {
    const { name } = await readBody(req);
    if (!name) return sendJson(res, 400, { error: '缺 name' });
    bus.removeGroup(root, String(name));
    sendJson(res, 200, { ok: true, groups: bus.listGroups(root) });
  });

  route('/api/agent-bus/group/rename', 'POST', async (req, res) => {
    const { name, to } = await readBody(req);
    const clean = cleanName(to);
    if (!name || !clean) return sendJson(res, 400, { error: '缺 name 或 to' });
    if (String(name) === clean) return sendJson(res, 200, { ok: true, name: clean });
    // agent-bus 没有改名原语：建新群、搬成员、删旧群。
    const members = bus.groupMembers(root, String(name));
    bus.createGroup(root, clean);
    for (const member of members) {
      try {
        bus.addMember(root, clean, member);
      } catch {
        /* 单个成员搬不过去不影响其余 */
      }
    }
    bus.removeGroup(root, String(name));
    sendJson(res, 200, { ok: true, name: clean, groups: bus.listGroups(root) });
  });

  route('/api/agent-bus/group/member', 'POST', async (req, res) => {
    const { group, peer: member, action, session, title } = await readBody(req);
    if (!group || !member) return sendJson(res, 400, { error: '缺 group 或 peer' });
    if (action === 'remove') {
      bus.removeMember(root, String(group), String(member));
    } else {
      const id = String(member);
      if (session) {
        // 会话成员：participant id 是 sess-xxxxxxxx，真身和标题记在 state 里，
        // 面板和 CLI 都能看出这个成员对应哪个历史会话。
        bus.ensureParticipant(root, id, { role: 'session' });
        bus.patchState(root, id, { session_id: String(session), title: String(title || '') });
      } else {
        bus.ensureParticipant(root, id, { role: 'project' });
      }
      bus.addMember(root, String(group), id);
    }
    sendJson(res, 200, { ok: true, group, members: bus.groupMembers(root, group) });
  });

  route('/api/agent-bus/send', 'POST', async (req, res) => {
    const { to, kind, subject, body } = await readBody(req);
    if (!to || !subject) return sendJson(res, 400, { error: '缺 to 或 subject' });
    // `to` 用 CLI 的写法：'#组名' 是广播，其余当作某个参与者。
    const target = String(to).startsWith('#') ? bus.group(String(to).slice(1)) : bus.direct(String(to));
    const payload = { from: peer, to: target, subject, body: body ?? '' };
    const file = kind === 'ask' ? bus.sendAsk(root, payload) : bus.sendAnnounce(root, payload);
    sendJson(res, 200, {
      ok: true,
      id: String(file).split(/[\\/]/).pop().replace(/\.json$/, ''),
    });
  });

  /** 群聊记录。 */
  route('/api/agent-bus/thread', 'GET', async (req, res) => {
    const group = new URL(req.url, 'http://127.0.0.1').searchParams.get('group');
    if (!group) return sendJson(res, 400, { error: '缺 group' });
    sendJson(res, 200, {
      group,
      members: bus.groupMembers(root, group),
      messages: readThread(root, group),
    });
  });

  /**
   * 在群里说一句，并让成员各自醒来回。
   * 只写自己那一条广播 —— 成员的回话由它们自己的进程写，面板不代劳。
   */
  route('/api/agent-bus/say', 'POST', async (req, res) => {
    const { group, text, wake } = await readBody(req);
    const body = String(text ?? '').trim();
    if (!group || !body) return sendJson(res, 400, { error: '缺 group 或 text' });
    const members = bus.groupMembers(root, String(group));
    if (members.length === 0) return sendJson(res, 400, { error: '这个群还没有成员' });

    bus.sendAnnounce(root, {
      from: peer,
      to: bus.group(String(group)),
      subject: body.slice(0, 60),
      body,
    });

    const targets = wake === false ? [] : members.filter((m) => m !== peer);
    const key = readApiKey();
    if (targets.length > 0 && !key) {
      dbg('没读到 DEEPSEEK_API_KEY，成员不会被唤醒（消息已写入）');
      return sendJson(res, 200, {
        ok: true,
        woke: [],
        note: '消息已发出，但没读到 API key，成员没被唤醒',
      });
    }
    const woke = [];
    for (const member of targets) {
      try {
        woke.push({
          member,
          pid: spawnReply({ root, group: String(group), member, text: body, key, dbg }),
        });
      } catch (err) {
        dbg(`唤醒 ${member} 抛错：${err?.message ?? err}`);
      }
    }
    sendJson(res, 200, { ok: true, woke });
  });

  ctx.effect(
    () => () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          /* 释放失败不影响卸载 */
        }
      }
    },
    'agent-bus-ui: routes',
  );
}
