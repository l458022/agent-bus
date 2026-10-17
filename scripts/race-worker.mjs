// 并发抢锁的子进程 worker。
// 单独跑它没有任何意义 —— core.test.mjs 会同时起 N 个，看有几个能拿到同一条消息。
//
// 放在 scripts/ 而不是 test/ 是因为 node --test 会把 test/ 下的每个文件都当测试跑。

import { collect } from '../src/index.mjs';

const [root, peer] = process.argv.slice(2);
if (!root || !peer) {
  console.error('用法：node race-worker.mjs <root> <peer>');
  process.exit(2);
}

const got = collect(root, peer);
process.stdout.write(`${JSON.stringify({
  peer,
  direct: got.direct.map((m) => m.id),
  broadcast: got.broadcast.map((m) => m.id),
})}\n`);
