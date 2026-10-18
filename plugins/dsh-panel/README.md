# agent-bus 的 DSH 面板

把 agent-bus 的群组搬进 [DeepSeek Harness](https://github.com/deepseek-ai) 的左侧栏：
看谁在哪个组、各自在干什么，并且直接把工作区里的项目拉进群。

只对 DSH 有效 —— 它用的是 DSH 的插槽系统（`ctx.slots` / `ctx.webServer`），
别的宿主没有这套东西。

## 它长什么样

左侧栏多一个「群组」图标，点开中间栏是面板：

```
群组                                   12 个项目 · 2 个群组 · 3 秒刷新

[ 新群组名字，比如 frontend          ] [ 新建群组 ]

#overlay-pipeline            3 个成员          改名  删群
  ● openfilm        在干   正在渲染第 3 段
  ● overlay-studio  空闲   —
  ● dsh             卡住   等 openfilm 回契约问题
  拉进来： + agent-bus  + bridge  + contracts

还没进任何群
  ○ writing-kit     空闲   —
  ○ worldview-tools 空闲   —
```

## 装

插件在 `plugins/dsh-panel`。它是 profile 的依赖，不是全局安装的东西。

**1. 让 profile 能解析到它**

在 profile 的 `package.json` 里加两条依赖（路径换成你自己的 checkout）：

```json
{
  "dependencies": {
    "agent-bus": "file:C:/path/to/agent-bus",
    "dsh-plugin-agent-bus": "file:C:/path/to/agent-bus/plugins/dsh-panel"
  }
}
```

然后在 profile 目录跑一次 `pnpm install`。

**2. 在 `cordis.patch.yml` 里插一条**

必须包在 `- insert:` 里 —— 顶层那种 `- id: xxx` 是「覆盖已存在的行」，
指向不存在的 id 只会得到 `patch: entry "xxx" not found` 的告警然后什么也不做。

```yaml
- insert:
    - id: agent-bus-ui
      name: dsh-plugin-agent-bus
      config:
        root: 'C:\path\to\your\workspace'   # agent-bus 的 bus root，也就是有 bus.json 的那层
        peer: dsh                            # 面板代表哪个参与者说话
```

**3. 重启 dsh**

host 半边（路由）是启动时注册的，改完要重启。client 半边（面板）改完刷新页面就够了。

## 两个半边

| 文件 | 跑在哪 | 干什么 |
|---|---|---|
| `lib/index.js` | host（cordis） | 注册 `/api/agent-bus/*` 五条 exact 路由，扫工作区找项目，读写 `.agent-bus/` |
| `lib/client.js` | 渲染进程 | 侧栏图标 + 面板，每 3 秒轮询一次快照 |

`lib/index.js` 的 `dsh.bundle.patch` 只是把配置带进 profile；
`lib/client.js` 由 `dsh-client-modules` 扫 `dsh.client` 字段自动注入，
`require('react')` 由宿主提供，不用自己打包。

## 项目是怎么来的

不是手填的。host 扫 `root` 下有两层以内的目录，凡是带 `.git` 或 `package.json`
的就当成一个项目，跳过 `node_modules` 和点开头的目录。项目名就是目录名
（做过字符清洗），和 agent-bus 里的 participant 名是同一个。

所以你在面板里看到的「项目」，就是 CLI 里 `agent-bus list` 看到的那些人。

## 数据存在哪

面板**不存任何东西**。它读写的还是 `.agent-bus/` 那一套文件，和 CLI、MCP 是同一份：

```bash
agent-bus group ls          # 面板里建的群，这里立刻能看到
agent-bus group add g peer  # 这里加的成员，面板 3 秒后也会显示
```

没有第二套真相，也就没有「面板和命令行对不上」这种问题。

## 已知限制

- **只能看，不能改别人的状态**。面板显示 phase 和 `now`，但改它们还是得靠 agent 自己
  `set_state` 或者 `agent-bus state`。手动改别人的状态会让人分不清「谁真的在干」。
- **轮询不是推送**。3 秒一次，关掉面板就不读了。真需要实时的话得改成事件订阅。
- **项目发现是启发式的**。一个既没有 `.git` 也没有 `package.json` 的目录不会出现在列表里。
  真有这种项目，在它下面放个空的 `package.json` 就行。
- **只在 DSH 里能用**。别家 agent 宿主没有 `ctx.slots` 和 `ctx.webServer`，装不上。

## 出问题时

host 半边会把每条路由的注册结果写进 `<root>/.agent-bus/plugin.log`：

```
2026-10-18T04:51:07.221Z apply 开始 root=C:\deepseek harness peer=dsh
2026-10-18T04:51:07.223Z 注册成功 exact /api/agent-bus/snapshot
```

面板空着的时候先看这个文件：没有这几行 = 插件没被加载；
有「注册失败」= 路由撞车；都有但面板还是空 = 前端 fetch 的问题，看浏览器控制台。
