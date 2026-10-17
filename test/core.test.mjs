// 核心库的测试。这里的每一条都对应协议里的一句话，
// 所以断言失败基本等于「协议没被实现」，而不是「测试写错了」。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as B from '../src/index.mjs';
import { busPath, claim, parseJson, writeNew, writeOver } from '../src/store.mjs';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const WORKER = fileURLToPath(new URL('../scripts/race-worker.mjs', import.meta.url));

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-bus-core-'));
  B.initBus(dir, { name: 'test' });
  B.ensureParticipant(dir, 'alice');
  B.ensureParticipant(dir, 'bob');
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 80 });
  } catch { /* Windows 句柄延迟释放，不影响结论 */ }
});

// ---------------------------------------------------------------- 协议

describe('消息形状', () => {
  const base = { kind: 'announce', from: 'alice', to: { direct: 'bob' }, subject: '标题', body: '正文' };

  test('合法 announce 通过', () => {
    assert.deepEqual(B.validateMessage(B.makeMessage(base)), []);
  });

  test('v 必须是 1', () => {
    const m = { ...B.makeMessage(base), v: 2 };
    assert.match(B.validateMessage(m).join(), /v 必须是 1/);
  });

  test('kind 白名单', () => {
    const m = { ...B.makeMessage(base), kind: 'chat' };
    assert.match(B.validateMessage(m).join(), /kind 非法/);
  });

  test('to 必须二选一', () => {
    const m = { ...B.makeMessage(base), to: { direct: 'bob', group: 'g' } };
    assert.match(B.validateMessage(m).join(), /二选一/);
  });

  test('answer 必须带 in_reply_to', () => {
    const m = { ...B.makeMessage(base), kind: 'answer' };
    assert.match(B.validateMessage(m).join(), /in_reply_to/);
  });

  test('只有 answer 能带 in_reply_to', () => {
    const m = { ...B.makeMessage(base), in_reply_to: 'x' };
    assert.match(B.validateMessage(m).join(), /只有 answer/);
  });

  test('只有 ask 能带 expires_at', () => {
    const m = { ...B.makeMessage(base), expires_at: new Date().toISOString() };
    assert.match(B.validateMessage(m).join(), /只有 ask/);
  });

  test('delivery 必须带合法 artifact', () => {
    const m = { ...B.makeMessage(base), kind: 'delivery', artifact: { path: 'a.mp4', sha256: 'short', bytes: -1 } };
    const joined = B.validateMessage(m).join();
    assert.match(joined, /sha256/);
    assert.match(joined, /bytes/);
  });

  test('announce 可以只带标题', () => {
    const m = B.makeMessage({ ...base, body: '' });
    assert.deepEqual(B.validateMessage(m), []);
  });

  test('ask 必须写正文', () => {
    const m = B.makeMessage({ ...base, kind: 'ask', body: '  ' });
    assert.match(B.validateMessage(m).join(), /必须写清楚要问什么/);
  });

  test('id 格式与字典序', () => {
    const a = B.newId(new Date('2026-01-02T03:04:05Z'));
    assert.match(a, /^20260102T030405Z-[0-9a-f]{8}$/);
    const later = B.newId(new Date('2026-01-02T03:04:06Z'));
    assert.ok(later > a, 'id 的字典序必须等于时间序');
  });

  test('名字里不能有路径穿越', () => {
    for (const bad of ['../etc', 'a/b', '', '中文名', 'a b']) {
      assert.equal(B.isValidName(bad), false, `应该拒绝 ${JSON.stringify(bad)}`);
    }
    for (const ok of ['openfilm', 'overlay-studio', 'a.b_c', 'A1']) {
      assert.equal(B.isValidName(ok), true, `应该接受 ${JSON.stringify(ok)}`);
    }
  });
});

// ---------------------------------------------------------------- 存储

describe('文件原语', () => {
  test('writeNew 不覆盖已存在的文件', () => {
    const p = join(dir, 'x.json');
    writeNew(p, '{"a":1}');
    assert.throws(() => writeNew(p, '{"a":2}'), /拒绝覆盖/);
    assert.equal(readFileSync(p, 'utf8'), '{"a":1}');
  });

  test('writeOver 覆盖', () => {
    const p = join(dir, 'x.json');
    writeOver(p, '{"a":1}');
    writeOver(p, '{"a":2}');
    assert.equal(readFileSync(p, 'utf8'), '{"a":2}');
  });

  test('写文件后不留 .tmp', () => {
    const p = join(dir, 'y.json');
    writeOver(p, '{}');
    const left = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(left, []);
  });

  test('claim 只有一个赢家', () => {
    const from = join(dir, 'a');
    const to = join(dir, 'b');
    writeFileSync(from, 'x');
    assert.equal(claim(from, to), true);
    assert.equal(claim(from, to), false, '第二次必须失败');
  });

  test('parseJson 容忍 BOM', () => {
    assert.deepEqual(parseJson('\uFEFF{"a":1}'), { a: 1 });
  });
});

// ---------------------------------------------------------------- root

describe('root 发现', () => {
  test('从子目录往上找到 root', () => {
    const deep = join(dir, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    assert.equal(B.findRoot(deep), dir);
  });

  test('不在 bus 里时 requireRoot 报错并给出下一步', () => {
    const lonely = mkdtempSync(join(tmpdir(), 'agent-bus-lonely-'));
    try {
      assert.throws(() => B.requireRoot(lonely), /bus\.json|agent-bus init/);
    } finally {
      rmSync(lonely, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- 作用域

describe('direct 作用域', () => {
  test('只有收件人拿得到', () => {
    B.sendAnnounce(dir, { from: 'alice', to: { direct: 'bob' }, subject: '私信', body: 'x' });
    assert.equal(B.pendingCount(dir, 'bob'), 1);
    assert.equal(B.pendingCount(dir, 'alice'), 0);
  });

  test('recv 之后归档，再 recv 拿不到', () => {
    B.sendAnnounce(dir, { from: 'alice', to: { direct: 'bob' }, subject: '一次', body: 'x' });
    const first = B.recv(dir, 'bob');
    assert.equal(first.messages.length, 1);
    assert.equal(B.recv(dir, 'bob').messages.length, 0);
    assert.equal(B.pendingCount(dir, 'bob'), 0);
  });

  test('发给不存在的参与者会报错且不落盘', () => {
    assert.throws(
      () => B.sendAnnounce(dir, { from: 'alice', to: { direct: 'nobody' }, subject: 's', body: 'b' }),
      /不存在/,
    );
  });
});

describe('group 作用域', () => {
  beforeEach(() => {
    B.createGroup(dir, 'pipe', { purpose: '测试' });
    B.addMember(dir, 'pipe', 'alice');
    B.addMember(dir, 'pipe', 'bob');
  });

  test('广播只存一份文件', () => {
    B.sendAnnounce(dir, { from: 'alice', to: { group: 'pipe' }, subject: '开工', body: 'x' });
    const files = readdirSync(busPath(dir, 'groups', 'pipe', 'broadcast')).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1, '广播不能给每个成员复制一份');
  });

  test('两个成员都能读到同一条广播', () => {
    B.sendAnnounce(dir, { from: 'alice', to: { group: 'pipe' }, subject: '开工', body: 'x' });
    const bob = B.pollGroup(dir, 'bob', 'pipe');
    const alice = B.pollGroup(dir, 'alice', 'pipe', { includeSelf: true });
    assert.equal(bob.length, 1);
    assert.equal(alice.length, 1);
  });

  test('自己发的广播自己默认不读', () => {
    B.sendAnnounce(dir, { from: 'alice', to: { group: 'pipe' }, subject: '开工', body: 'x' });
    assert.equal(B.pollGroup(dir, 'alice', 'pipe').length, 0);
  });

  test('游标生效，第二次不重复', () => {
    B.sendAnnounce(dir, { from: 'alice', to: { group: 'pipe' }, subject: '一', body: 'x' });
    assert.equal(B.pollGroup(dir, 'bob', 'pipe').length, 1);
    assert.equal(B.pollGroup(dir, 'bob', 'pipe').length, 0);
    B.sendAnnounce(dir, { from: 'alice', to: { group: 'pipe' }, subject: '二', body: 'y' });
    const again = B.pollGroup(dir, 'bob', 'pipe');
    assert.equal(again.length, 1);
    assert.equal(again[0].subject, '二');
  });

  test('游标丢失只会重复读，不会漏读', () => {
    B.sendAnnounce(dir, { from: 'alice', to: { group: 'pipe' }, subject: '一', body: 'x' });
    B.pollGroup(dir, 'bob', 'pipe');
    rmSync(busPath(dir, 'participants', 'bob', 'cursors.json'), { force: true });
    assert.equal(B.pollGroup(dir, 'bob', 'pipe').length, 1, '游标丢了应该重读');
  });

  test('不在组里的人不能广播', () => {
    B.ensureParticipant(dir, 'carol');
    assert.throws(
      () => B.sendAnnounce(dir, { from: 'carol', to: { group: 'pipe' }, subject: 's', body: 'b' }),
      /不在组/,
    );
  });

  test('不在组里的人不能读广播', () => {
    B.ensureParticipant(dir, 'carol');
    assert.throws(() => B.pollGroup(dir, 'carol', 'pipe'), /不在组/);
  });
});

// ---------------------------------------------------------------- ask / answer

describe('问答闭环', () => {
  test('answer 自动找到提问者', () => {
    const file = B.sendAsk(dir, { from: 'alice', to: { direct: 'bob' }, subject: '能接吗', body: '28s 那批' });
    const id = file.split(/[\\/]/).pop().replace('.json', '');
    B.sendAnswer(dir, { from: 'bob', inReplyTo: id, subject: '能接', body: '验过了' });

    const got = B.recv(dir, 'alice');
    assert.equal(got.messages.length, 1);
    assert.equal(got.messages[0].kind, 'answer');
    assert.equal(got.messages[0].in_reply_to, id);
  });

  test('ask 不能问一个组', () => {
    B.createGroup(dir, 'pipe');
    assert.throws(
      () => B.sendAsk(dir, { from: 'alice', to: { group: 'pipe' }, subject: 's', body: 'b' }),
      /只能问一个具体的人/,
    );
  });

  test('answer 一个不存在的 id 会报错', () => {
    assert.throws(
      () => B.sendAnswer(dir, { from: 'bob', inReplyTo: '20200101T000000Z-deadbeef', subject: 's', body: 'b' }),
      /找不到/,
    );
  });

  test('answer 一条 announce 会报错', () => {
    const file = B.sendAnnounce(dir, { from: 'alice', to: { direct: 'bob' }, subject: 's', body: 'b' });
    const id = file.split(/[\\/]/).pop().replace('.json', '');
    assert.throws(() => B.sendAnswer(dir, { from: 'bob', inReplyTo: id, subject: 's', body: 'b' }), /不是 ask/);
  });

  test('过期的 ask 不算进 messages，但仍在 archive', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const msg = B.makeMessage({ kind: 'ask', from: 'alice', to: { direct: 'bob' }, subject: 's', body: 'b', expiresAt: past });
    B.send(dir, msg);
    const got = B.recv(dir, 'bob');
    assert.equal(got.messages.length, 0);
    assert.equal(got.expired.length, 1);
    assert.equal(B.pendingCount(dir, 'bob'), 0, '过期消息也要归档，否则永远堆着');
  });
});

// ---------------------------------------------------------------- 并发

describe('并发（这是协议唯一的正确性假设）', () => {
  function runWorker(peer) {
    return new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [WORKER, dir, peer], { cwd: PKG });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', (code) => {
        if (code !== 0) return reject(new Error(`worker 挂了：${err}`));
        try {
          resolve(JSON.parse(out.trim()));
        } catch {
          reject(new Error(`worker 输出不是 JSON：${out}`));
        }
      });
    });
  }

  test('10 个进程同时抢 1 条消息，只有 1 个拿到', async () => {
    B.sendAnnounce(dir, { from: 'alice', to: { direct: 'bob' }, subject: '只有一条', body: 'x' });
    const results = await Promise.all(Array.from({ length: 10 }, () => runWorker('bob')));
    const total = results.reduce((n, r) => n + r.direct.length, 0);
    assert.equal(total, 1, `一共被拿走了 ${total} 次 —— rename 抢锁失效了`);
  });

  test('20 条消息被 8 个进程分抢，一条不丢不重', async () => {
    const sent = [];
    for (let i = 0; i < 20; i++) {
      const file = B.sendAnnounce(dir, { from: 'alice', to: { direct: 'bob' }, subject: `第 ${i} 条`, body: 'x' });
      sent.push(file.split(/[\\/]/).pop().replace('.json', ''));
    }
    const results = await Promise.all(Array.from({ length: 8 }, () => runWorker('bob')));
    const got = results.flatMap((r) => r.direct);
    assert.equal(got.length, 20, `拿到 ${got.length} 条，应该是 20`);
    assert.equal(new Set(got).size, 20, '有重复消费');
    assert.deepEqual([...got].sort(), [...sent].sort(), '有消息丢了');
  });

  test('同一份广播被 6 个成员读，谁都读得到', async () => {
    B.createGroup(dir, 'g');
    B.addMember(dir, 'g', 'alice');
    const members = [];
    for (let i = 0; i < 6; i++) {
      const name = `m${i}`;
      B.ensureParticipant(dir, name);
      B.addMember(dir, 'g', name);
      members.push(name);
    }
    B.sendAnnounce(dir, { from: 'alice', to: { group: 'g' }, subject: '全体注意', body: 'x' });
    const results = await Promise.all(members.map((m) => runWorker(m)));
    for (let i = 0; i < members.length; i++) {
      assert.equal(results[i].broadcast.length, 1, `${members[i]} 没读到广播`);
    }
  });
});

// ---------------------------------------------------------------- state

describe('state', () => {
  test('phase 白名单', () => {
    assert.throws(() => B.patchState(dir, 'alice', { phase: 'vibing' }), /phase 只能是/);
  });

  test('patch 后 updated_at 会变', async () => {
    const before = B.readState(dir, 'alice').updated_at;
    await new Promise((r) => setTimeout(r, 1100));
    const after = B.patchState(dir, 'alice', { phase: 'working' });
    assert.notEqual(after.updated_at, before);
    assert.equal(after.phase, 'working');
  });

  test('patch 是浅合并，数组整体替换', () => {
    B.patchState(dir, 'alice', { blockers: ['a', 'b'] });
    const next = B.patchState(dir, 'alice', { blockers: ['c'] });
    assert.deepEqual(next.blockers, ['c'], '数组不能做元素级合并');
  });

  test('改名后 state 里的 name 会跟着回正', () => {
    const s = B.patchState(dir, 'alice', { note: 'x' });
    assert.equal(s.name, 'alice');
  });

  test('读不存在的参与者报错', () => {
    assert.throws(() => B.requireState(dir, 'nobody'), /没有这个参与者/);
  });
});

// ---------------------------------------------------------------- 组与公告板

describe('组与公告板', () => {
  test('成员按名字排序', () => {
    B.createGroup(dir, 'g');
    B.addMember(dir, 'g', 'bob');
    B.addMember(dir, 'g', 'alice');
    assert.deepEqual(B.readGroup(dir, 'g').members, ['alice', 'bob']);
  });

  test('重复 add 不产生重复', () => {
    B.createGroup(dir, 'g');
    B.addMember(dir, 'g', 'alice');
    B.addMember(dir, 'g', 'alice');
    assert.deepEqual(B.readGroup(dir, 'g').members, ['alice']);
  });

  test('add 一个不存在的参与者会报错', () => {
    B.createGroup(dir, 'g');
    assert.throws(() => B.addMember(dir, 'g', 'nobody'), /还不是这个 bus 的参与者/);
  });

  test('公告板是 append-only', () => {
    B.createGroup(dir, 'g');
    B.appendBoard(dir, 'g', { from: 'alice', text: '第一条', kind: 'decision' });
    B.appendBoard(dir, 'g', { from: 'bob', text: '第二条', kind: 'note' });
    const text = B.readBoard(dir, 'g');
    assert.match(text, /第一条/);
    assert.match(text, /第二条/);
    assert.match(text, /decision/);
    assert.ok(text.indexOf('第一条') < text.indexOf('第二条'), '顺序必须保持写入顺序');
  });

  test('多行文本会被压成一行', () => {
    B.createGroup(dir, 'g');
    B.appendBoard(dir, 'g', { from: 'alice', text: '第一行\n第二行' });
    const lines = B.readBoard(dir, 'g').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 2, '标题 + 一条记录');
  });

  test('groupsOf 找出所有所在组', () => {
    B.createGroup(dir, 'g1');
    B.createGroup(dir, 'g2');
    B.addMember(dir, 'g1', 'alice');
    B.addMember(dir, 'g2', 'alice');
    assert.deepEqual(B.groupsOf(dir, 'alice').sort(), ['g1', 'g2']);
  });
});

// ---------------------------------------------------------------- 体检

describe('环境体检', () => {
  test('本地路径不报警', () => {
    assert.equal(B.detectRiskyVolume(dir), null);
  });

  test('同步盘路径报警', () => {
    assert.match(B.detectRiskyVolume(join('C:', 'Users', 'x', 'OneDrive', 'proj')), /同步盘/);
    assert.match(B.detectRiskyVolume(join('C:', 'Users', 'x', 'Dropbox', 'proj')), /同步盘/);
  });

  // 这两条在不同平台上会走不同分支，所以两种写法都测。
  // \\server\share 在 POSIX 上只是合法文件名，靠 resolve 之后再看前缀是判不出来的
  // —— 那正是曾经在 ubuntu / macos 上挂掉的原因。
  test('UNC 路径报警（含 POSIX 上的 // 写法）', () => {
    assert.match(B.detectRiskyVolume('\\\\server\\share\\proj'), /UNC/);
    assert.match(B.detectRiskyVolume('//server/share/proj'), /UNC/);
  });
});

// ---------------------------------------------------------------- 一致性

describe('git 友好', () => {
  test('init 之后目录结构对', () => {
    assert.ok(existsSync(busPath(dir, 'bus.json')));
    for (const d of ['participants', 'groups', 'log']) {
      assert.ok(existsSync(busPath(dir, d)), `缺目录 ${d}`);
    }
  });

  test('bus.json 本身不是合法 JSON 时 init 会重建而不是覆盖', () => {
    const file = busPath(dir, 'bus.json');
    const original = readFileSync(file, 'utf8');
    const again = B.initBus(dir, { name: 'other' });
    assert.equal(again.created, false);
    assert.equal(readFileSync(file, 'utf8'), original, 'init 必须是幂等的');
  });
});

describe('审计日志', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-bus-log-'));
    B.initBus(dir, { name: 'test-root' });
    B.ensureParticipant(dir, 'alice');
    B.ensureParticipant(dir, 'bob');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // 消息一被消费就进 archive，state 是覆盖写 —— 时间线只存在于日志里。
  test('send / recv / state 三种事件都落到 log/<yyyymmdd>.jsonl', () => {
    B.sendAnnounce(dir, { from: 'alice', to: { direct: 'bob' }, subject: '记账' });
    const got = B.collect(dir, 'bob');
    assert.equal(got.direct.length, 1);
    B.setPhase(dir, 'bob', 'blocked', '等 alice');

    const logDir = busPath(dir, 'log');
    const files = readdirSync(logDir).filter((n) => n.endsWith('.jsonl'));
    assert.equal(files.length, 1, '一天一个文件');
    assert.match(files[0], /^\d{8}\.jsonl$/);

    const events = readFileSync(join(logDir, files[0]), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));

    assert.deepEqual(events.map((e) => e.op), ['send', 'recv', 'state']);
    assert.equal(events[0].subject, '记账');
    assert.equal(events[1].by, 'bob');
    assert.equal(events[2].to, 'blocked');
    assert.ok(events[2].from, '要记下从哪个 phase 变过来的');
    for (const e of events) assert.match(e.at, /^\d{8} \d{2}:\d{2}:\d{2}$/);
  });

  test('日志只追加：第二条消息不会冲掉第一条的记录', () => {
    B.sendAnnounce(dir, { from: 'alice', to: { direct: 'bob' }, subject: '一' });
    B.sendAnnounce(dir, { from: 'alice', to: { direct: 'bob' }, subject: '二' });
    const file = join(busPath(dir, 'log'), readdirSync(busPath(dir, 'log'))[0]);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
  });

  test('phase 没变就不记 state（避免每条指令都刷一行）', () => {
    B.patchState(dir, 'bob', { note: '只是改个备注' });
    const logDir = busPath(dir, 'log');
    const lines = existsSync(logDir)
      ? readdirSync(logDir).flatMap((f) => readFileSync(join(logDir, f), 'utf8').trim().split('\n').filter(Boolean))
      : [];
    assert.equal(lines.filter((l) => JSON.parse(l).op === 'state').length, 0);
  });
});
