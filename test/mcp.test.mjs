// MCP server 的协议级测试：真的起一个子进程，用真的 JSON-RPC 行协议说话。
// 不 mock —— 这个 server 最容易坏的地方就是 stdout 被污染，mock 测不出来。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/mcp.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));

let dir;
let proc;
let buf = '';
const pending = new Map();
let nextId = 1;
const stderrLog = [];

function rpc(method, params) {
  const id = nextId++;
  const line = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
  proc.stdin.write(line);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC 超时：${method}`)), 10000);
    pending.set(id, { resolve, reject, timer });
  });
}

function notify(method) {
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      cwd: dir,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agent-bus-mcp-'));
  await runCli(['init', '--name', 'mcp-test']);
  await runCli(['join', 'alice']);
  await runCli(['join', 'bob']);

  proc = spawn(process.execPath, [BIN, '--root', dir, '--peer', 'bob'], {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        throw new Error(`server 往 stdout 写了非 JSON：${line}`);
      }
      assert.equal(msg.jsonrpc, '2.0', 'exported 的每个消息都必须是 JSON-RPC 2.0');
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg.result);
      }
    }
  });

  proc.stderr.on('data', (d) => stderrLog.push(d.toString()));

  const info = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(info.serverInfo.name, 'agent-bus');
  assert.ok(info.instructions.includes('bob'), 'instructions 里要说清自己是谁');
  notify('notifications/initialized');
});

after(async () => {
  if (proc) {
    proc.stdin.end();
    proc.kill();
    await new Promise((r) => {
      const t = setTimeout(r, 3000);
      proc.once('close', () => { clearTimeout(t); r(); });
    });
  }
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      // Windows 上子进程句柄可能还没完全释放，临时目录留着不影响测试结论
    }
  }
});

describe('MCP 协议形状', () => {
  test('tools/list 返回全部工具，每个都有 description', async () => {
    const { tools } = await rpc('tools/list');
    assert.ok(tools.length >= 6, `工具太少：${tools.length}`);
    for (const t of tools) {
      assert.ok(t.name, '工具必须有名字');
      assert.ok(t.description && t.description.length > 20, `${t.name} 的描述太短 —— 模型只读这个`);
      assert.equal(t.inputSchema.type, 'object');
    }
    const names = tools.map((t) => t.name);
    for (const required of ['recv', 'ask', 'wait', 'announce', 'read_state', 'set_state', 'read_board']) {
      assert.ok(names.includes(required), `缺工具 ${required}`);
    }
  });

  test('ping 有回应', async () => {
    const r = await rpc('ping');
    assert.deepEqual(r, {});
  });

  test('未知方法返回 -32601', async () => {
    await assert.rejects(() => rpc('nope/nope'), /-32601/);
  });

  test('notification 不产生响应', async () => {
    const before = pending.size;
    notify('notifications/initialized');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(pending.size, before, 'notification 收到了响应 —— 客户端会报未请求的消息');
  });
});

describe('MCP 工具行为', () => {
  test('read_state 读到自己', async () => {
    const r = await rpc('tools/call', { name: 'read_state', arguments: {} });
    assert.equal(r.isError, false);
    assert.match(r.content[0].text, /bob/);
    assert.match(r.content[0].text, /idle/);
  });

  test('set_state 改 phase', async () => {
    const r = await rpc('tools/call', { name: 'set_state', arguments: { phase: 'working', now: '在写测试' } });
    assert.equal(r.isError, false);
    const s = await rpc('tools/call', { name: 'read_state', arguments: { name: 'bob' } });
    assert.match(s.content[0].text, /working/);
    assert.match(s.content[0].text, /在写测试/);
  });

  test('set_state blocked 不带 blockers 会被挡回来', async () => {
    const r = await rpc('tools/call', { name: 'set_state', arguments: { phase: 'blocked' } });
    assert.match(r.content[0].text, /blockers/);
  });

  test('非法 phase 报错', async () => {
    const r = await rpc('tools/call', { name: 'set_state', arguments: { phase: 'vibing' } });
    assert.equal(r.isError, true);
  });

  test('announce 到自己，recv 能收到', async () => {
    const a = await rpc('tools/call', { name: 'announce', arguments: { to: 'bob', subject: '自测', body: '一轮' } });
    assert.equal(a.isError, false);
    const r = await rpc('tools/call', { name: 'recv', arguments: {} });
    assert.match(r.content[0].text, /自测/);
  });

  test('recv 第二次不会重复', async () => {
    const r = await rpc('tools/call', { name: 'recv', arguments: {} });
    assert.match(r.content[0].text, /没有待处理消息/);
  });

  test('ask 超时不撤回，返回 request_id', async () => {
    const r = await rpc('tools/call', {
      name: 'ask',
      arguments: { to: 'alice', subject: '没人回答', body: '等不到', timeout_s: 1 },
    });
    assert.equal(r.isError, false);
    assert.match(r.content[0].text, /request_id/);
    assert.match(r.content[0].text, /没有撤回/);
  });

  test('ask 之后 alice 用 CLI 回答，wait 能拿到', async () => {
    const asked = await rpc('tools/call', {
      name: 'ask',
      arguments: { to: 'alice', subject: '这版能接吗', body: '28s 那批', timeout_s: 1 },
    });
    const id = /request_id: (\S+)/.exec(asked.content[0].text)[1];

    const ans = await runCli(['answer', id, '-s', '能接', '-b', '已经验过'], { AGENT_BUS_PEER: 'alice' });
    assert.equal(ans.code, 0, ans.stderr);

    const waited = await rpc('tools/call', { name: 'wait', arguments: { request_id: id, timeout_s: 5 } });
    assert.match(waited.content[0].text, /能接/);
    assert.match(waited.content[0].text, /已经验过/);
  });

  test('ask 一个不存在的组会失败', async () => {
    const r = await rpc('tools/call', {
      name: 'ask',
      arguments: { to: '#nope', subject: 'x', body: 'y' },
    });
    assert.equal(r.isError, true);
  });

  test('read_board 空组', async () => {
    await runCli(['group', 'create', 'g1', '--purpose', '测试组'], { AGENT_BUS_PEER: 'alice' });
    const r = await rpc('tools/call', { name: 'read_board', arguments: { group: 'g1' } });
    assert.equal(r.isError, false);
    assert.match(r.content[0].text, /空/);
  });

  test('write_board 之后 read_board 能读到', async () => {
    await rpc('tools/call', { name: 'write_board', arguments: { group: 'g1', text: '定了：用 v1 契约', kind: 'decision' } });
    const r = await rpc('tools/call', { name: 'read_board', arguments: { group: 'g1' } });
    assert.match(r.content[0].text, /定了：用 v1 契约/);
    assert.match(r.content[0].text, /bob/, '公告板要记是谁写的');
  });

  test('不存在的工具报错', async () => {
    await assert.rejects(() => rpc('tools/call', { name: 'not-a-tool', arguments: {} }), /没有这个工具/);
  });
});
