# agent-bus

[![CI](https://github.com/l458022/agent-bus/actions/workflows/ci.yml/badge.svg)](https://github.com/l458022/agent-bus/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

一台机器上的几个 AI agent，各自在自己的目录里干活，互相看不见。
**agent-bus 就是它们之间的那根线。**

没有服务器，没有守护进程，没有端口，没有账号。一个目录，一堆 JSON 文件。
你在资源管理器里就能看见它们说了什么，备份是 `cp -r`，调试是 `cat`，回放是 `ls`。

## 装

这个包**没有发到 npm registry**，从 GitHub 直接装：

```bash
npm i -g github:l458022/agent-bus     # 装到全局，之后文中示例都写 agent-bus
# 或者完全不装，一次性跑：
npx github:l458022/agent-bus --help
```

```bash
agent-bus init
agent-bus join alice --role "写前端"
```

---

## 它解决的是什么问题

你手上同时开几个 agent：一个改前端，一个跑后端，一个做数据。
它们各自都挺能干，但**彼此是瞎的**：

- 前端改了接口字段，后端不知道，等到联调才发现。
- 后端在跑一个 20 分钟的迁移，前端以为它挂了，重复问。
- 你已经口头转达了三次「那个字段改成 `createdAt` 了」。

人肉转达的问题是：**信息只在你的脑子里和聊天窗口之间流动，落不下来**。
agent-bus 让它们把话落在盘上，下一个人（或下一个 session）能自己读到。

**文件系统就是总线**，这不是省事，是刻意的取舍：

| 你的处境 | 该用什么 |
|---|---|
| 一台机器，几个 agent，同一份代码库 | **agent-bus** |
| 跨机器、需要持久队列、要重试策略 | Kafka / NATS / Redis Streams |
| 同一个进程内的线程协作 | 用不着总线 |
| 两个 agent 在同一个 session 里吵 | 直接用宿主的 subagent / teammate 机制 |

agent-bus 只赌一件事：**你的几个 agent 共享一块磁盘**。赌赢了，成本是零。

---

## 五分钟

### 1. 建一条总线

```bash
cd ~/projects/my-thing
agent-bus init --name my-thing
```

这会生成：

```
my-thing/
  bus.json                 ← 总线根标记
  .agent-bus/
    participants/          ← 谁在
    groups/                ← 按组
    log/                   ← 按天的一行一条
```

`bus.json` 是根标记。**从任何子目录跑命令都能找到它**（往上找），所以
`cd web && agent-bus send api ...` 和 `cd ~/projects/my-thing && ...` 是同一件事。

### 2. 登记两边

```bash
# 终端 A（前端项目）
agent-bus join web --role "Vite + React，负责 overlay 编辑器"

# 终端 B（后端项目）
agent-bus join api --role "Node 服务，负责渲染队列"
```

`join` 会写一个 `.bus-peer` 文件记住「我是谁」，之后不带 `--peer` 也知道自己是谁。

### 3. 说一句话

```bash
# 终端 A
agent-bus send api -s "接口字段改了" -b "overlay 的 createdAt 从秒改成毫秒了，别按秒解析。"

# 终端 B
agent-bus recv
```

```
来自 web  [告知]  接口字段改了
  overlay 的 createdAt 从秒改成毫秒了，别按秒解析。
  id: 20261018T034512Z-a1b2c3d4 · 2026-10-18 03:45:12
```

### 4. 要一个回答（而不是丢一句话）

`send` 是单向的 —— 发完就完事，不等。
真要对方回一句，用 `ask`：

```bash
# A 问
agent-bus ask api -s "迁移跑完了吗" -b "我这边要发版。"

# B 答（用 ask 打出来的那个 id）
agent-bus answer 20261018T034512Z-a1b2c3d4 -s "还得 10 分钟" -b "先别发。"
```

`ask` 有 TTL（默认 24 小时）。过期了不会自动撤回，只是 `recv` 时会被跳过 ——
**超时是给人看的信号，不是丢消息**。

### 5. 让它自己看

这是整套东西唯一真正的难点：**agent 不会自己醒来**。
消息躺在盘上，没人读就等于没发。三种解法，从轻到重：

| 办法 | 怎么做 | 代价 |
|---|---|---|
| 每轮扫一遍 | 在 `AGENTS.md` / `CLAUDE.md` 里写「开始干活前先跑 `agent-bus recv`」 | 零，但依赖 agent 守规矩 |
| 挂 MCP | 见下面「MCP」节，agent 有 `recv` 工具，自然会调 | 要配一次 |
| 常驻 watcher | `while true; do agent-bus recv; sleep 5; done` | 要一个进程 |

**MCP 那条最可靠**，因为工具描述会进模型上下文，它不用「记得」。

---

## 三种消息

整个协议只有三种意图。多一种都是在制造歧义。

| 谓词 | 含义 | 对方要不要回 |
|---|---|---|
| `announce` | 告知一件事 | 不用 |
| `ask` | 我需要一个回答 | **要**（带 TTL） |
| `deliver` | 交一个文件 | 不用（自动算 sha256） |

加一个 `answer`（回 `ask`）和广播 / 公告板，就是全部。

### 为什么没有 `request` / `response` 那套 RPC

因为**大部分「对话」根本不是对话**。真正常见的三种情况：

1. 「我把 A 做完了」→ `announce`，不需要回答
2. 「这个字段叫什么」→ 答案应该固化进一份**契约文件**，问一次就够了，不该每次问
3. 「你那边什么进度」→ 应该有一个 `state` 文件，**读它，不要问**

只有第 4 种情况才真需要 `ask`：**卡住了，必须等一句才能继续**。

所以 agent-bus 的建议是：**让 90% 的消息根本不需要发。**
先把契约和状态文件定死，剩下的才用消息。

---

## 状态：读，不要问

每个参与者有一个 `state`。这是**单一事实源**，覆盖写，永远只有最新。

```bash
agent-bus state --phase working --now "在跑 500 张卡片的渲染"
agent-bus state api          # 看别人
agent-bus list               # 一次看全
```

```
api       working     在跑 500 张卡片的渲染            2 分钟前
web       idle        —                               刚刚
```

`phase` 只有四个值：`idle` / `working` / `blocked` / `delivering`。
`blocked` 必须写 `blockers`，否则被挡回来 —— 「卡住了」不带原因等于没说话。

---

## 组：让广播有作用域

```bash
agent-bus group create overlay-pipeline
agent-bus group add overlay-pipeline web api render
agent-bus send '#overlay-pipeline' -s "契约 v2 定了"
```

广播**只存一份**（不是给每个成员复制一份），靠每个成员自己的游标推进。
代价是要维护游标，好处是六个人读同一条消息不会产生六份副本。

公告板是 append-only 的，给「这个组的结论」用：

```bash
agent-bus board overlay-pipeline -m "接点格式定为 OverlayDoc v1，不再改。"
agent-bus board overlay-pipeline      # 读
```

---

## CLI 全表

```
开始
  init [--name 项目名]                    在当前目录建一条总线
  join <名字> [--role 说明]               登记一个参与者，并设为默认

说话
  send <对方|#组> -s 主题 [-b 正文]       单向告知
  ask <对方> -s 主题 [-b 正文] [--ttl 24h]  要一个回答
  answer <原消息 id> -s 主题 [-b 正文]    回答
  deliver <对方> --file <路径> [-s 主题]  交一个文件（自动算 sha256）

听
  recv [--json] [--keep]                 取走 inbox + 所在组的新广播
  log [--limit 20]                       按时间回放事件（发/读/状态变化）

在场
  list                                   谁在，各自什么状态，几个组
  state [名字]                           看状态
  state --phase working --now "..."      改状态

组
  group ls | create <名> | add <组> <人> | rm <组> <人> | show <组>
  board <组> [-m "要说的话"] [--from 名字]  公告板（append-only）

查
  doctor                                 体检：root、state、孤儿文件、网络盘
```

退出码：`0` 正常 / `1` 出错。所有命令在 root 下的任意子目录都能跑。

`doctor` 会告诉你哪里不对：

```
✓ root  C:\projects\my-thing
✓ 3 个参与者，state 都合法
✓ 2 个组，成员都在
✗ 1 条消息躺在 .tmp 里超过一小时：20261018T031200Z-x.tmp
  可能是写完没改名就崩了。删掉它，或者手工改名为 .json。
```

---

## MCP

CLI 是给人用的。**agent 用 MCP**，因为工具描述会进模型上下文。

`.mcp.json` / 宿主的 MCP 配置。**指向装了包的那个 bin 文件**，别写 `agent-bus-mcp`
（Windows 上是 `.cmd` shim，有些客户端不走 shell 会找不到）：

```json
{
  "mcpServers": {
    "agent-bus": {
      "command": "node",
      "args": [
        "/绝对路径/agent-bus/bin/mcp.mjs",
        "--root", "/绝对路径/你的项目",
        "--peer", "me"
      ]
    }
  }
}
```

`npm root -g` 能告诉你全局装到哪了；也可以用 `npx github:l458022/agent-bus` 那种方式
clone 一份下来直接指过去。

`--peer` 决定「这个 server 代表谁说话」；不给就按 `.bus-peer` 或工作目录名推。
`--root` 不给就按进程 cwd 往上找 `bus.json`。
一个 agent 一个 server 实例，各自带自己的 `--peer`。

八个工具：

| 工具 | 做什么 |
|---|---|
| `recv` | 取走待处理消息（默认不重复取） |
| `ask` | 向某人提问并**阻塞等待**回答 |
| `wait` | 续等一个已经发出的 ask（不重发） |
| `announce` | 单向告知 |
| `read_state` | 读某人 / 所有人的状态 |
| `set_state` | 改自己的状态（`blocked` 必须带 blockers） |
| `read_board` | 读组的公告板 |
| `write_board` | 往公告板追加 |

**两个硬约束**（写 MCP server 的人一定会踩）：

1. **stdout 是协议通道**。任何调试输出走 stderr，否则第一行就把握手打乱。
2. **notification 没有 id，不能回**。收到 `notifications/initialized` 就闭嘴，别回一个
   `{"id":null,...}` —— 那会让客户端直接断连。

---

## 它到底在盘上存了什么

```
my-thing/
  bus.json                              {"v":1,"name":"my-thing","created_at":"..."}
  .bus-peer                             我是谁（join 写的）
  .agent-bus/
    participants/
      web/
        profile.json                     {"name":"web","role":"...","joined_at":"..."}
        state.json                       {"phase":"working","now":"...","updated_at":"..."}
        inbox/
          archive/                       取走的消息挪到这里，不删
        cursors.json                     {"overlay-pipeline":{"id":"...","mtime":...}}
    groups/
      overlay-pipeline/
        group.json                       {"name":"...","members":["web","api"],"purpose":"..."}
        broadcast/                       广播只存一份
        board.md                         公告板
    log/
      2026-10-18.md                      按天 append 的一行一条
```

**所有写入都是「先写 `.tmp` 再改名」**，所以任何时刻被 kill 都不会留下半截 JSON。

---

## 设计取舍

每一条都是「选了 A，因为 B 在这个场景里代价更大」。

### 1. 文件系统，不是消息队列

**选 A**：一个目录 + JSON 文件。
**不选 B**：Redis / NATS / RabbitMQ。

因为你为了协调两个 agent，要先装一个 broker、开一个端口、配一个连接串、
再处理它挂了我怎么办。而 `cp -r` 就能备份、`cat` 就能看、`git` 就能进版本库 ——
这些是文件系统的免费能力。

代价：**延迟是轮询级别的**（你 `recv` 的频率决定多快看到），不是毫秒推送。
对「两个 agent 干活」这种节奏，够了。

### 2. 消费 = link + unlink，不是 rename

看着像吹毛求疵，其实是**唯一的正确性假设**。

`rename(from, to)` 在目标已存在时会**覆盖并成功**（libuv 在 Windows 上是
`MOVEFILE_REPLACE_EXISTING`）。于是两个进程同时抢同一条消息，会**都返回成功**，
同一条指令被执行两遍。

`link(from, to)` 在目标存在时原子地报 `EEXIST` —— 只有一个赢家。

这个 bug 是被测试抓出来的：8 个进程抢 20 条消息，实测拿到了 25 条。
现在的测试里就锁着这一条：

```
20 条消息被 8 个进程分抢，一条不丢不重   ✓
10 个进程抢同一条，只有 1 个赢           ✓
```

不支持硬链接的文件系统（部分网络盘 / FAT）会退化成 `rename` 并在 `doctor` 里警告。

### 3. 广播只存一份，靠游标

**选 A**：一条广播一个文件，每个成员维护自己的游标。
**不选 B**：给每个成员复制一份到各自的 inbox。

6 个成员的组，B 要写 6 次，而且成员一多就是 N² 的写放大。
A 的代价是游标会坏 —— 所以游标设计成「丢了只会重复读，不会漏读」，
失败方向是安全的。

游标存的是 `{id, mtime}` 而不是单个 id：id 的字典序**不完全等于**写入顺序，
同一秒内两条广播，随机后缀可能让后写的 id 更小，只存 id 就会把它当旧的跳过。

### 4. 覆盖写 state，不追加

**选 A**：`state.json` 每次整个覆盖。
**不选 B**：事件流 + 重放。

因为「现在在干嘛」这件事，你只关心最新值。想要历史就去看 `log/<yyyymmdd>.jsonl` ——
发消息、读消息、phase 变化都会追加一行在那里，`agent-bus log` 就是把它读出来。
事件流会让「读当前状态」变成一个需要 fold 的操作，而这是最高频的操作。

### 5. CLI 是人看的，MCP 是机器看的

CLI 输出全部是给人读的一屏以内，不做 `--json` 的完整机器格式（除了 `recv --json`）。
机器要结构化数据，直接挂 MCP 或 `import { ... } from 'agent-bus'`。

**不做一个万能接口**，因为两种消费者的最优形状是冲突的。

---

## 已知限制

诚实写出来，免得你以为是 bug。

- **需要共享磁盘**。跨机器不行（除非你挂 NFS/SMB，并且接受 `link` 可能退化成 `rename`）。
- **不推送**。没有 watcher 的时候，消息要等下一次 `recv` 才被看见。
  agent 不会自己醒来 —— 这是所有文件总线的共同限制，不是这个实现的缺陷。
- **没有认证**。同一台机器上任何能写这个目录的进程都能冒充任何人。
  它假设你的 agent 们是**协作**关系，不是对抗关系。
- **游标在同一毫秒内多条广播时可能漏读一条**。写入串行化（正常用法）不会遇到。
- **`log/` 会一直长**。按天分文件，但没有自动清理。它一行只有一两百字节，个人用一年也就几兆。
- **Windows 上 `link` 需要 NTFS**。FAT32/exFAT 会退化，`doctor` 会警告。

---

## 库用法

不想走 CLI 就直接 import：

```js
import { initBus, ensureParticipant, sendAsk, collect, patchState } from 'agent-bus';

const root = initBus(process.cwd(), { name: 'my-thing' });
ensureParticipant(root, 'web', { role: '前端' });

sendAsk(root, 'web', 'api', {
  subject: '迁移跑完了吗',
  body: '我这边要发版。',
  ttlHours: 2,
});

const { messages } = collect(root, 'api');
patchState(root, 'api', { phase: 'working', now: '在跑渲染' });
```

全部同步 API，没有 Promise，没有事件循环依赖 —— 因为背后就是读写文件。

---

## 测试

```bash
npm test
```

69 项，包括并发（真起 10 个子进程抢同一条消息）和 MCP 协议形状
（真起子进程走真 JSON-RPC）。**并发那部分不是形式主义** ——
上面第 2 条那个「同一条消息被消费两次」的 bug 就是它抓出来的。

---

## 协议

完整协议见 [PROTOCOL.md](./PROTOCOL.md)。13 节，包括错误码、
文件布局、并发保证和版本演进规则。

设计原则一句话：**分布式的复杂度来自「不确定对方收到了没」。
一块共享磁盘把这件事变成了「文件在不在」—— 一个你能用 `ls` 回答的问题。**

---

## DSH 面板

`plugins/dsh-panel` 把群组搬进 DeepSeek Harness 的侧栏：左侧栏多一个「群组」图标，
点开能看见每个群里有谁、各自在干什么（phase 和当前在做的事），
并且直接把工作区里的项目拉进群 —— 项目是自动发现的，不用手填。

它**不存任何东西**：读写的还是 `.agent-bus/` 那一套文件，和 CLI、MCP 是同一份。
面板里建的群，`agent-bus group ls` 立刻能看到，反过来也一样。

只对 DSH 有效 —— 用的是 DSH 的插槽系统，别的宿主没有这套东西。
装法和边界见 [plugins/dsh-panel/README.md](plugins/dsh-panel/README.md)。

---

## 示例

`examples/overlay-to-film.mjs` 是一个真实的跨项目协作案例：
把 Overlay Studio 导出的动效卡 JSON，转成 openfilm 能逐帧渲染的网页，
再出成 MP4。两个项目在这条链上**从没直接对话过** —— 它们只是各自读写
契约文件和总线，人不用在中间转达。

```bash
AGENT_BUS_WORKSPACE=/path/to/workspace \
node examples/overlay-to-film.mjs overlay.json --video talking.mp4 --render
```

注意它是**示例**，不是核心的一部分：它跟那几个项目的目录形状绑死了，
所以工作区路径用环境变量给，而不是猜。

---

## License

MIT
