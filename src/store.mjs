// 文件系统层：root 发现、原子写、抢锁、游标。
// 协议第 8 节说的每一件事都在这里落地。别的模块只调这些，不自己碰 fs。

import { createHash } from 'node:crypto';
import {
  existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const ROOT_MARKER = 'bus.json';
/**
 * 总线自己的目录名。**不能是 `.bus`** —— 那样一个小改动就得给每个已有用户
 * 的手工目录改名；而且它和工作区里可能存在的旧 `.bus` 撞名。
 */
export const BUS_DIR = '.agent-bus';
export const LAYOUT = {
  participants: 'participants',
  groups: 'groups',
  inbox: 'inbox',
  archive: 'archive',
  broadcast: 'broadcast',
  state: 'state.json',
  cursors: 'cursors.json',
  members: 'members.json',
  board: 'board.md',
  log: 'log',
};

// ---------------------------------------------------------------- 安全读

/** 去掉 BOM 再解析。PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，见过就加这一行。 */
export function parseJson(text) {
  return JSON.parse(String(text).replace(/^\uFEFF/, ''));
}

/** 读 JSON，任何失败都返回 fallback —— 协议 9.6：所有读取容忍缺失。 */
export function readJsonSafe(path, fallback = null) {
  try {
    return parseJson(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export function readTextSafe(path, fallback = '') {
  try {
    return readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------- 原子写

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

const TMP_SUFFIX = '.tmp';

/**
 * 写一个**新**文件：先写 .tmp 再 rename（协议 8.2）。
 * 目标已存在时不覆盖 —— inbox 里的消息 id 撞车说明出了大事，宁可报错。
 */
export function writeNew(path, data) {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}${TMP_SUFFIX}`;
  writeFileSync(tmp, data, 'utf8');
  try {
    // 用硬链接落位，不用 rename：rename 在目标已存在时会**覆盖**
    // （libuv 在 Windows 上用 MOVEFILE_REPLACE_EXISTING，POSIX 上本来就是这个语义），
    // 而 link 在目标存在时原子地报 EEXIST —— 这才是「绝不覆盖」的正确实现。
    linkSync(tmp, path);
    return path;
  } catch (e) {
    if (e.code === 'EEXIST') throw new Error(`目标已存在，拒绝覆盖：${path}`);
    throw e;
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

/**
 * 覆盖写（state、bus.json、cursors）。仍走 .tmp + rename；
 * Windows 上 rename 到已存在文件偶尔 EPERM，退化成 unlink + rename ——
 * 这几类文件本来就是「最后写赢」，丢原子性不丢正确性。
 */
export function writeOver(path, data) {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}${TMP_SUFFIX}`;
  writeFileSync(tmp, data, 'utf8');
  try {
    renameSync(tmp, path);
  } catch {
    try { rmSync(path, { force: true }); } catch {}
    renameSync(tmp, path);
  }
  return path;
}

export function writeJson(path, value) {
  return writeOver(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeJsonNew(path, value) {
  return writeNew(path, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------- 抢锁

/**
 * 消费一条消息 = 把它挪到 archive（协议 8.3）。
 *
 * 返回 true 表示「这条归我了」，false 表示「别人先拿走了」。
 * 后者**不是错误** —— 两个 agent 同时 recv 是完全正常的用法。
 *
 * 实现上必须是 link + unlink，不能是 rename：
 * rename 在目标已存在时会**覆盖并成功**（libuv 在 Windows 上是
 * MOVEFILE_REPLACE_EXISTING），于是两个进程同时抢同一条消息会**都返回 true**，
 * 同一条消息被消费两次。真机上表现为「同一条指令被执行了两遍」。
 * link 在目标存在时原子地报 EEXIST，只有一个赢家。
 */
export function claim(fromPath, toPath) {
  ensureDir(dirname(toPath));
  try {
    linkSync(fromPath, toPath);
  } catch (e) {
    if (e.code === 'EEXIST') return false;   // 别人先抢到了
    if (e.code === 'ENOENT') return false;   // 已经被拿走了
    if (e.code === 'EPERM' || e.code === 'EACCES') return false;
    if (e.code === 'EXDEV' || e.code === 'ENOSYS' || e.code === 'ENOTSUP') {
      // 文件系统不支持硬链接（部分网络盘 / FAT）。退化成 rename，
      // 失去原子性 —— 这是 detectRiskyVolume 要警告的场景之一。
      try {
        renameSync(fromPath, toPath);
        return true;
      } catch (e2) {
        if (e2.code === 'ENOENT' || e2.code === 'EPERM' || e2.code === 'EACCES' || e2.code === 'EEXIST') return false;
        throw e2;
      }
    }
    throw e;
  }
  try { unlinkSync(fromPath); } catch { /* 源删不掉不影响「已归我」这个事实 */ }
  return true;
}

/** 把消息原样搬到 archive（不改内容）。 */
export function archiveMessage(root, participant, file) {
  const from = busPath(root, LAYOUT.participants, participant, LAYOUT.inbox, file);
  const to = busPath(root, LAYOUT.participants, participant, LAYOUT.archive, file);
  return claim(from, to);
}

// ---------------------------------------------------------------- root

/** 从 startDir 向上找 bus.json。找不到返回 null。 */
export function findRoot(startDir = process.cwd()) {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ROOT_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function requireRoot(startDir = process.cwd()) {
  const root = findRoot(startDir);
  if (!root) {
    throw new Error(
      `这里（${resolve(startDir)}）往上没有找到 ${ROOT_MARKER}。先跑 \`agent-bus init\` 建一个，或者 cd 到已有的 root 里。`,
    );
  }
  return root;
}

/**
 * 总线内部路径。所有数据都在 `<root>/.agent-bus/` 下，**只有 bus.json 留在 root** ——
 * 它是根标记，往上找目录时应该先撞见它，不该埋在子目录里。
 */
export function busPath(root, ...parts) {
  if (parts.length === 1 && parts[0] === ROOT_MARKER) return join(root, ROOT_MARKER);
  return join(root, BUS_DIR, ...parts);
}

/**
 * 追加一行审计日志到 `.agent-bus/log/<yyyymmdd>.jsonl`（协议讲它的那一节）。
 *
 * 为什么非要有：消息被消费后会从 inbox 挪进 archive，盘上已经看不出
 * 「谁、什么时候读的」；state 是覆盖写，也看不出「它什么时候从 working 变成 blocked」。
 * 这两件事只能靠日志。`agent-bus log` 命令读的就是这里。
 *
 * 写失败一律吞掉 —— 审计是辅助，不能因为日志写不进去就让发消息失败。
 */
export function appendLog(root, entry) {
  try {
    const dir = busPath(root, LAYOUT.log);
    ensureDir(dir);
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    const at = `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    writeFileSync(join(dir, `${day}.jsonl`), `${JSON.stringify({ at, ...entry })}\n`, { flag: 'a' });
  } catch { /* 见上 */ }
}

// ---------------------------------------------------------------- 网络盘检测

const SYNC_HINTS = ['onedrive', 'dropbox', 'icloud', 'google drive', 'googledrive', 'box sync', 'pcloud', 'nutstore', '坚果云'];

/**
 * 粗检 root 是否落在同步盘 / 网络盘上（协议 8.4）。
 *
 * 判不准也值得报 —— rename 的原子性是整个协议唯一的正确性假设，
 * 而这类环境最典型的症状就是「偶发丢消息」，事后根本查不出来。
 */
export function detectRiskyVolume(path) {
  const p = resolve(path);
  const lower = p.toLowerCase();
  for (const hint of SYNC_HINTS) {
    if (lower.includes(hint)) return `路径里含 "${hint}"，多半是同步盘 —— rename 不保证原子，可能偶发丢消息`;
  }
  if (p.startsWith(`\\\\`)) return 'UNC 网络路径 —— rename 的原子性取决于服务端实现，可能偶发丢消息';
  if (process.platform !== 'win32') {
    // 非 Windows 上唯一可移植的近似：看挂载点有没有明显是网络的
    if (/^\/(net|mnt)\//i.test(p)) return '路径看起来在 /net 或 /mnt 下，可能是网络挂载 —— rename 不保证原子';
  }
  return null;
}

// ---------------------------------------------------------------- 目录扫描

/** 列出目录下的 .json 文件名，按名字（= 时间序）升序。 */
export function listJsonFiles(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

export function fileMtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- 游标

/**
 * 组广播游标（协议 7.2）：记「这个成员读到哪儿了」。
 * 丢了只会重复读，不会漏读 —— 协议要求失败模式偏安全。
 *
 * 形状是 `{ id, mtime }` 而不是单个 id，因为 id 的字典序**不完全等于**写入顺序：
 * 同一秒内写两条广播，随机后缀可能让后写的 id 更小，只存 id 就会把它当旧的跳过。
 * mtime 先比、id 再比，才真正按写入顺序推进。
 */
export function readCursors(root, participant) {
  return readJsonSafe(busPath(root, LAYOUT.participants, participant, LAYOUT.cursors), {});
}

export function readCursorEntry(root, participant, groupName) {
  const c = readCursors(root, participant)[groupName];
  if (!c) return { id: '', mtime: 0 };
  if (typeof c === 'string') return { id: c, mtime: 0 };  // v0.0 的旧格式
  return { id: c.id || '', mtime: Number(c.mtime) || 0 };
}

export function writeCursor(root, participant, groupName, entry) {
  const cursors = readCursors(root, participant);
  cursors[groupName] = { id: entry.id || '', mtime: Number(entry.mtime) || 0 };
  writeJson(busPath(root, LAYOUT.participants, participant, LAYOUT.cursors), cursors);
  return cursors;
}

/** 这条消息是否在该游标之后（先比 mtime，同 mtime 再比 id）。 */
export function isAfterCursor(mtime, id, cursor) {
  if (mtime > cursor.mtime) return true;
  if (mtime < cursor.mtime) return false;
  return id > cursor.id;
}

// ---------------------------------------------------------------- 杂项

export function sha256File(path) {
  const abs = isAbsolute(path) ? path : resolve(path);
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
}

export function fileSize(path) {
  return statSync(path).size;
}

/** 把任意路径转成相对 root 的展示形式（跨盘时原样返回）。 */
export function relativize(root, path) {
  const abs = resolve(path);
  return abs.startsWith(root + sep) ? abs.slice(root.length + 1).replaceAll(sep, '/') : abs;
}
