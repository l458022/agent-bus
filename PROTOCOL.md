# Agent Bus Protocol v0.1

> 让同一台机器上的多个 coding agent 组队干活。
>
> 本文只规定**语义**。具体用什么语言、什么存储、什么传输，是实现的事。
> 实现必须满足第 9 节「一致性要求」；不满足的，是另一个协议，不是这个。

关键词 `MUST` / `MUST NOT` / `SHOULD` / MAY 按 RFC 2119 理解。

---

## 1. 这个协议解决什么

一个 agent 的工作被打断，通常不是因为不会做，而是因为**它不知道旁边那个 agent 已经做了什么**。

于是人成了中继：A 窗口跑完，人复制结果，粘到 B 窗口，B 再跑。这个环节每小时消耗人几分钟，而且会丢细节、会记错、会在两个 agent 之间传走样的话。

有三个办法：

1. 做成一个大 agent——上下文放不下，也没法并行。
2. 做成云服务——要多一套账号、网络、权限，而且离线就废。
3. **给它们一个本地信箱，让它们自己说。**

本协议是第三条。它规定这些信箱长什么样、什么话该说什么话不该说、说了算不算数。

### 不是什么

- **不是消息队列。** 没有 broker、没有 ack 重传、没有优先级、没有扇出保证。
- **不是 RPC。** 只有一种阻塞调用（`ask`），而且它随时可能超时，超时不是错误。
- **不是 agent 框架。** 它不认识模型、不认识 prompt、不认识工具调用。它只认识「谁」「说了什么」「谁该看到」。
- **不是远程协议。** v0.1 只支持同一台机器。跨机是 v0.2 的事，本文不预留字段。

---

## 2. 核心主张

> **凡是能从 `state` 读到的，不许发消息。**

这条不是风格建议，是协议的立场，也是它区别于「又一个 agent 通信方案」的地方。

绝大多数 agent 间的「沟通」，本质是一次**状态查询**：

| 看起来像沟通 | 实际是什么 | 该用什么 |
|---|---|---|
| 「你那边的字段改了吗？」 | 查对方当前产出 | 读 `state` |
| 「你做到哪了？」 | 查进度 | 读 `state` |
| 「我要开始了，你别动 X」 | 声明占用 | 写 `state` 的 `holds` |
| 「做完了，产物在 out/x.json」 | 广播产出 | 写 `state`，必要时 `announce` |
| 「这个 schema 到底哪个字段必填？」 | 查共识 | 读 `board` |
| 「你那个报错怎么解的？」 | **要一句回答** | `ask` |

右列只有一行需要协议介入。协议的价值不在于把那 5 行也变成消息，而在于**把它们挡在消息之外**。

实现 SHOULD 把这条做成硬性引导：MCP 工具的描述里写明「先读 state 再决定要不要问」。

---

## 3. 术语

| 词 | 含义 |
|---|---|
| **root** | 协议数据所在的根目录。一个 root 是一个协作域。 |
| **participant** | 一个 agent 在总线上的身份，用名字标识。名字在一个 root 内唯一。 |
| **scope** | 消息的投递范围：`direct:<name>` 或 `group:<name>`。 |
| **group** | 一组 participant 的集合。组有共享的 `board`。 |
| **board** | 一个 group 的共享真相文件（决策记录）。组内所有 participant 读同一份。 |
| **message** | 一条投递。四种 kind 之一。 |
| **state** | 一个 participant 的当前快照。覆盖写，不是日志。 |
| **delivery** | 一次产物交接：只传指针 + 摘要，不传内容。 |

**participant ≠ 进程，也不 ≠ 项目。** 它是「一个会说话的身份」。同一个项目在不同会话里跑，可以是同一个 participant（共享 state），也可以是两个（各报各的进度）。由 `init` 时的选择决定，协议不干涉。

---

## 4. 三个原语

协议只有三个动作。第四个需要新原语的场景，说明本协议没设计对，应当提 v0.2，而不是在实现里加。

### 4.1 `announce` — 单向告知

我做完了一件事，你可能需要知道。不等回复。

```
announce(to: scope, subject, body?, artifact?)
```

使用条件（全部满足才发）：
- 接收方**确实需要采取行动**，或者
- 这是一次**产物交接**（此时应当用 `kind: delivery`）

不满足就别发，去写 `state`。

### 4.2 `ask` — 阻塞提问

我需要一句回答才能继续。

```
ask(to: scope, question, expires_at, wait_timeout) -> answer | timeout
```

- 必有 `expires_at`（绝对时刻）。过了这个时刻，问题作废。
- 调用方的 `wait_timeout` 是**本地等待时长**，与 `expires_at` 无关。超时后问题**不撤回**——它还在对方信箱里，对方上线仍能看到。
- 超时**不是错误**。返回 `{ status: "timeout", id }`，调用方可以选择继续等（`wait`）、换路子、或者放弃。

**同一条 `ask` 只能被回答一次。** 第二个 `answer` 回复同一个 id 的，接收方 MUST 丢弃并记日志。

### 4.3 `state` — 状态快照

覆盖写的当前状态。没有历史，只有现在。

```
state(of: participant) -> state
state(set: participant, patch) -> state
```

字段（见第 6 节）。读的一方 MUST 容忍任何字段缺失。

**`state` 是唯一的「我没发消息但你也知道我」的机制。** 没有它，前面那条核心主张就是空话。

---

## 5. 消息

### 5.1 结构

```jsonc
{
  "v": 1,
  "id": "20261018T033729Z-7f3a91c2",
  "kind": "ask",
  "from": "overlay-studio",
  "to": { "group": "video-pipeline" },     // 或 { "direct": "openfilm" }
  "subject": "字幕时间轴用哪个字段",
  "body": "…",
  "in_reply_to": null,                      // answer 必填
  "artifact": null,                         // delivery 必填
  "created_at": "2026-10-18T03:37:29+08:00",
  "expires_at": "2026-10-19T03:37:29+08:00" // ask 必填，其余为 null
}
```

### 5.2 字段规则

| 字段 | 规则 |
|---|---|
| `v` | 协议版本。整数。当前恒为 `1` |
| `id` | 全局唯一，字典序随时间递增。格式 `<UTC时间戳>-<8位十六进制>` |
| `kind` | `announce` / `ask` / `answer` / `delivery` |
| `from` | 发件 participant 名 |
| `to` | `{"direct": "<name>"}` 或 `{"group": "<name>"}`，**二选一** |
| `subject` | 一行标题。MUST 非空，SHOULD ≤ 80 字符 |
| `body` | 正文。MAY 为空字符串，但 `announce` 与 `ask` 的 `body` 与 `artifact` 不能同时为空 |
| `in_reply_to` | `kind: answer` 时 MUST 为被回答的 `ask` 的 `id` |
| `artifact` | `kind: delivery` 时 MUST 为 `{path, sha256, bytes}` |
| `created_at` | 本地时间带偏移，MUST 能解析为绝对时刻 |
| `expires_at` | `kind: ask` 时 MUST 非空；其余 MUST 为 `null` |

**时间用绝对值，不用相对值。** `ttl_h: 24` 需要接收方拿当前时间去减，跨时区、跨休眠、跨机器时钟漂移都会错。`expires_at` 一个字段说清所有事。

### 5.3 `artifact` 只放指针

```jsonc
"artifact": { "path": "bridge/out/stack/stack.mp4", "sha256": "a95a73fe…", "bytes": 18991479 }
```

`path` 相对 root 的上级（由实现约定），或绝对路径。**内容永远不进消息。** 消息是索引，不是容器。

理由：消息要能被随便读、随便扫、随便归档。一份 20 MB 的产物塞进去，`ls` 都会变慢，而且从此没人敢 `recv`。

### 5.4 不可变

消息一旦落盘，**MUST NOT 被修改**。要补充，发新的；要撤销，发 `announce` 说明作废。归档区里的文件是历史，不删。

---

## 6. 状态快照

```jsonc
{
  "v": 1,
  "participant": "openfilm",
  "updated_at": "2026-10-18T03:30:29+08:00",
  "phase": "idle",                  // idle | working | blocked | delivering
  "now": "一句话：现在在干什么",
  "produces": [
    { "what": "MP4 成片", "where": "out/", "contract": "…", "state": "ready" }
  ],
  "consumes": [
    { "what": "OverlayDoc JSON", "contract": "contracts/overlay-card.schema.json", "state": "ready" }
  ],
  "holds": ["bridge/fixtures"],     // 我占着这些，别动
  "blockers": [],                   // 卡在哪
  "wants": []                       // 我在等什么
}
```

规则：
- `phase` 取值固定四种，别自创。
- `state` 字段的值固定五种：`ready` / `wip` / `blocked` / `deprecated` / `missing`。
- `holds` 是**咨询性占用**，不是锁。协议不保证互斥；它只是让人和别人 agent 知道「这里有人在改」。
- 读方 MUST 容忍字段缺失、类型不对、文件不存在。全部情况都应当降级为「不知道」，而不是崩。

---

## 7. 作用域：direct 与 group

### 7.1 direct

直接点名。消息落在 `<root>/participants/<name>/inbox/`。

### 7.2 group

组广播。**关键设计**：广播消息只存一份，不复制到每个成员信箱。

```
<root>/groups/<g>/broadcast/<id>.json     一条消息，一份
<root>/participants/<p>/cursors.json      {"video-pipeline": "<最后消费的 id>"}
```

成员各自维护游标，从游标之后开始读。

为什么不是「每个成员 inbox 各写一份」：

| | 每人一份 | 广播 + 游标 |
|---|---|---|
| 5 人组发一次 | 5 个文件 | 1 个文件 |
| 新成员加入 | 要么看不到历史，要么被塞一堆旧消息 | 游标从加入时刻开始，干净 |
| 成员离开 | 要清理它的副本 | 不用管 |
| 离线两周回来 | 信箱里堆满，分不清哪些是广播 | 从游标继续，一条不漏 |

游标更新 MUST 在消费确认之后，且 MUST 原子写（见 8.2）。游标丢失的后果是重复读，不是漏读——**协议的失败模式一律偏安全**。

### 7.3 谁能发到组

只有 `members` 里的人能发到组，也只有成员能读组的 broadcast 和 board。非成员发往组，实现 MUST 拒绝并明确报错。

### 7.4 成员变更

`members.json` 变更 MUST NOT 重写历史消息。新成员加入后，游标初始化为「加入时刻的广播末尾」——**不看历史**。要看历史就去看 `board` 和 `log`，那是为回顾准备的。

---

## 8. 存储与并发

### 8.1 布局

```
<root>/
  bus.json                          {v, created_at, participants: [...], groups: [...]}
  .agent-bus/
    participants/<p>/
      inbox/                        待处理
      archive/                      已处理（不删）
      cursors.json                  组广播游标
      state.json                    状态快照
    groups/<g>/
      members.json                  ["a", "b"]
      board.md                      组内共享真相
      broadcast/                    组广播消息
    log/<yyyymmdd>.jsonl            追加式审计
```

`bus.json` 是**根标记**，故意留在 `<root>` 顶层：从任意子目录往上找总线时，第一眼就该撞见它，而不是埋在 `.agent-bus/` 里多翻一层。其余全部收进 `.agent-bus/`，工作区根上只多一个隐藏目录。

### 8.2 写新文件：`link` 才是原子创建

```
write(<path>.tmp, bytes)
link(<path>.tmp, <path>)      // 目标已存在 → EEXIST，绝不覆盖
unlink(<path>.tmp)
```

**MUST NOT** 直接写目标路径。读到半个 JSON 的消费者会以为总线坏了。

**MUST NOT 拿 `rename` 当「不覆盖的创建」**：POSIX `rename(2)` 与 Windows `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` 都**会覆盖已存在的目标并返回成功**。指望它检测「目标是否已存在」是错的 —— 它永远报告成功，于是两条同 id 的消息里后一条静静吃掉前一条。

只有 `state.json` / `cursors.json` / `bus.json` 这类「后写者应该赢」的覆盖写才用 `rename` —— 覆盖正是它的本职。

### 8.3 消费：`link` 就是抢锁

```
link(inbox/<id>.json, archive/<id>.json)   // 成功 = 这条归我
unlink(inbox/<id>.json)                    // 拿稳了再删原件
```

`link` 在目标已存在时**原子失败**（`EEXIST`）。两个进程同时 `recv`，只有一个能建出 archive 里的硬链接，另一个看 `EEXIST` 直接跳过。这才是真正的抢占。

失败码：`EEXIST` = 别人拿走了，跳过，**不报错**；`ENOENT` = 消息已经不在了，同样跳过。

**这里尤其 MUST NOT 用 `rename`**。Windows 上 `rename` 覆盖 archive 里的同名目标是成功的，于是 N 个进程抢同一条消息会**全都以为自己抢到了**。这不是理论风险：8 进程抢 20 条消息，实测拿到 25 条 —— 多出来的 5 条全是重复消费。

`link` 在个别文件系统上不可用（`EXDEV` / `ENOSYS` / `ENOTSUP`，例如 FAT32、部分网络盘），此时退化回 `rename`，并在 `init` / `doctor` 时警告：那条路径上并发消费不再安全。

`link` 在 POSIX 与 NTFS 的**同卷内**都是原子的。跨卷不保证 —— 所以 inbox 和 archive MUST 在同一卷上（实现上就是同一个 participant 目录下，天然满足）。

### 8.4 网络盘与同步目录

`link` 与 `rename` 在 NFS / SMB / OneDrive / iCloud / Dropbox 上**都不保证原子**，某些实现甚至会用「复制+删除」冒充。

实现 MUST 在 `init` 时检测 root 是否位于这类路径，检测到就**明确警告**并让用户确认。检测不出来的，README MUST 说明这条限制。

这条不是洁癖：文件总线的全部正确性都建立在这两个系统调用的原子性上。假设不成立时，症状是偶发丢消息 —— 最难查的那种 bug。

### 8.5 id 与排序

`<UTC yyyyMMdd'T'HHmmss'Z'>-<8 hex>`，例如 `20261018T033729Z-7f3a91c2`。

字典序 = 时间序（同秒内靠随机串，不保证顺序，可接受）。MUST 用 UTC，这样跨时区不会乱序。

**游标不能只存 id**。组广播的 id 只在同秒内才有可比性，而消费顺序不保证；只存 id 会让「同一秒里后写但 id 更小」的消息被永久跳过。游标 MUST 是二元组 `{id, mtime}`，比较顺序：先 `mtime`，相同再比 `id`。

### 8.6 审计日志

消息被消费后就离开 inbox 进了 archive，`state` 是覆盖写 —— **盘上没有任何地方留下时间线**。「谁在什么时候读了这条」「它什么时候从 working 变成 blocked 的」，这两件事只存在于日志里。

实现 MUST 追加 `.agent-bus/log/<yyyymmdd>.jsonl`，一行一个事件：

```json
{"at":"20261018 03:56:50","op":"send","id":"20261017T195650Z-b6959595","kind":"announce","from":"a","to":"b","subject":"..."}
{"at":"20261018 03:56:50","op":"recv","id":"20261017T195650Z-b6959595","kind":"announce","from":"a","by":"b"}
{"at":"20261018 03:56:50","op":"state","name":"b","from":"working","to":"blocked"}
```

`op` 至少这三种。日志**只追加、不改写、不参与正确性**：写失败 SHOULD 吞掉 —— 不能因为记不上账就让发消息失败。它是 `agent-bus log` 的唯一数据源。

---

## 9. 一致性要求

一个实现要自称「实现了本协议」，必须满足：

1. **一条消息最多被消费一次。** 依靠 8.3 的 rename。
2. **写完的消息不可变。** 归档不删。
3. **广播不复制。** 依靠游标。
4. **`answer` 只认第一条。** 重复回答丢弃。
5. **超时不撤回。** 超时只结束调用方的等待。
6. **所有读取容忍缺失。** 文件不存在、字段缺失、类型不对，一律降级，不崩。
7. **时间可解析。** 任何时刻字段都能转成绝对时刻。
8. **未知 `v` 不崩。** 遇到不认识的协议版本，跳过并记日志。

这八条是**可验证的**。实现 SHOULD 带一个一致性测试套件，且 SHOULD 允许别人用它来测自己的实现。

---

## 10. 反模式

下面每一条都是真实会发生的，写进来是为了能在 review 时直接指。

| 反模式 | 为什么错 | 改成 |
|---|---|---|
| 「在吗」 | 零信息，多一次唤醒 | 直接说事 |
| 用 `announce` 报进度 | 进度是状态，不是事件 | 写 `state` |
| 把 JSON 内容塞进 `body` | 消息变容器，扫不动也存不住 | `delivery` + 指针 |
| 同一 subject 来回超过 3 轮 | 说明在拿消息当会议 | 结论写进 `board` |
| 用 `ask` 轮询对方进度 | 那是 `state` 的活 | 读 `state` |
| 广播给全组「我做完了」 | 全组被叫醒一次 | 写 `state` |
| `answer` 里再反问一句 | 对方在等 `answer`，不是在等 `ask` | 先答，再另发 `ask` |
| 靠 `holds` 做互斥 | 它不是锁，只是告知 | 真要互斥就串行化 |

---

## 11. MCP 映射

协议不绑定传输，但 v0.1 的唯一推荐接入方式是 MCP（stdio）。

| 工具 | 对应原语 | 说明 |
|---|---|---|
| `ask` | 4.2 | 发 `ask` + 本地阻塞等 `answer`，超时返回 `{status:"timeout", id}` |
| `wait` | 4.2 续等 | 对已超时的 `id` 继续等，**不重发** |
| `announce` | 4.1 | 发 `announce` 或 `delivery`，不阻塞 |
| `read_state` | 4.3 | 读一个或全部 participant 的 state |
| `read_board` | 7.1 | 读组 board，或 root 级共享真相 |

工具描述里 SHOULD 包含核心主张（第 2 节），因为**模型只会读工具描述**，不会读 PROTOCOL.md。

这是设计上的一个硬约束：**协议的立场必须写进工具描述，否则等于没写**。

---

## 12. 明确不做

写下来是为了不再讨论。

- **认证**：假定单用户本机。多用户要的是另一个东西。
- **加密**：同上。
- **跨机传输**：v0.2。
- **消息优先级 / 截止时间排序**：不做。`ask` 的 `expires_at` 只用于作废，不用于排队。
- **Exactly-once 投递**：做不到，也不承诺。承诺的是「最多一次消费」。
- **历史查询语言**：`log` 是 JSONL，用 `grep`/`jq`。
- **自动重试**：不重试。超时了该问人还是该换路子，是调用方的事。

---

## 13. 版本

`v: 1` 是本文。

破坏性变更才升 `v`。新增可选字段不升版本——因为第 9.6 条要求所有读取容忍缺失。这条规则的意义是：**协议可以加东西，但只能加「不读也不坏」的东西**。

已知的 v2 候选：跨机、消息优先级、group 嵌套。都不预留字段。

---

## 附：为什么值得单独存在

因为它把两件被混在一起的事拆开了：

**状态**是持续的、可随意读的、无副作用的。
**消息**是离散的、有成本的、会打断别人的。

大多数 agent 协作方案把它们当成一回事，于是所有进度都变成了事件，所有事件都变成了唤醒，最后人和 agent 一起被淹。

这条协议的全部内容，就是坚持把它们分开，然后规定它们各管什么。
