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
import { readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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
    const { group, peer: member, action } = await readBody(req);
    if (!group || !member) return sendJson(res, 400, { error: '缺 group 或 peer' });
    if (action === 'remove') bus.removeMember(root, String(group), String(member));
    else bus.addMember(root, String(group), String(member));
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
