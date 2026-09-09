# dsh-session-repair

<p align="center">
  <img src="assets/logo.svg" alt="dsh-session-repair logo" width="120" />
</p>

**dsh-session-repair** 是 DeepSeek Harness (DSH) 插件，用于修复**提交区 seq 冲突**与
**末尾半条记录**的会话日志 —— 也就是 Web GUI 里 `历史加载失败` / `failed to observe
session … corrupt session log: seq gap in committed region …` 或 `corrupt Zstandard
session log: complete frame contains a torn JSONL record` 的成因。

- **一键修复** —— 侧边栏底部按钮打开弹框，扫描全部会话并修复，支持单个与全部
- **安全优先** —— 拒绝本进程内活动会话、写前复检 size+mtime、自动备份、原子发布、
  发布后再用宿主后端复检
- **四条入口** —— Web GUI 弹框、3 个模型工具、`/dsh-session-repair` 命令、带围栏的 HTTP 路由
- **自带 skill** —— 装上插件即注册 `dsh-session-log-repair` skill（诊断知识 + 离线脚本
  工具链，DSH 起不来时也能用）
- **双语 UI** —— 跟随宿主界面语言（中文 / English）
- **无构建链** —— 宿主半边是纯 ESM，浏览器半边是手写的 `__ModuleLoader__` bundle

[English](README.md)

## 它修什么

DSH 会话日志是拼接多帧 zstd 的 JSONL，加载器要求每一行的 `seq` 紧接上一行。
当同一会话被两个写入者持有 —— 典型场景是一个进程卡在 LLM 重试退避里，另一个
进程 resume 同一会话并写入崩溃修复事件，卡住的进程醒来后用旧计数器追加 ——
两行不同的事件会占用同一批 `seq`，加载器随即拒绝整个日志，会话打不开。

两种加载器报错都能修：

| 加载器报错 | 含义 |
|---|---|
| `corrupt session log: seq gap in committed region at line N (expected X, got Y)` | 撞车行，且其后有 `turn/end` 触发精确报错 |
| `corrupt Zstandard session log: complete frame contains a torn JSONL record` | 撞车行之后没有 `turn/end`（扫描器只记 issue 不升级），**或**一条记录的换行符没落盘，留在完整帧里 |

修复保留**存活链**、丢弃重叠的旧版本：

1. 先丢掉末尾缺换行的半条记录 —— 它从未成为事件，不会丢事件；
2. 从文件末尾反向走，找出抵达末尾的最大稠密连续段（写出日志其余部分的那个写入者）；
3. 向前延伸：结束位置恰好接上链起点的行并入，范围探入链内的行判为重复版本丢弃；
4. 遇到真实缺口就停止，剩余部分必须是稠密前缀，否则**拒绝修复**而不是猜；
5. 插件识别的合成事件指纹（`turn/end` 的 `reason.kind: 'interrupted'`、紧随的
   `step/end`、`interrupted-tool-result-*`、`session/end-seed` resume 标记）只会
   因为「与存活链重叠」被丢弃，绝不因为标签被丢弃。

判定不依赖「谁是修复版本」，因此两个版本都是真实写入时同样成立。`seq` 不重编号，
修复后保留存活写入者的编号。

两类情况明确拒绝：**真缺行**（`got > expected`）与**结构上不完整的尾帧**
（加载器自己会恢复其中的完整记录）。

## 功能

- **侧边栏底部入口**（`sidebar.footer.action`）：「会话修复 / Session repair」按钮
  打开修复弹框（`shell.overlay`），列出全部会话的
  `ok` / `corrupt` / `unreadable` / `torn` / `live`，支持单个**修复**与**一键修复全部**。
- **模型工具**：`dsh_session_repair_scan`、`dsh_session_repair_apply`
  （`session` / `all` / `dryRun` / `force`）、`dsh_session_repair_verify`。
- **命令**：`/dsh-session-repair {"op":"scan|repair|verify|status", …}`。
- **HTTP 路由**：`POST /dsh-session-repair/api`，围栏限定 loopback/受信主机 + 同源标记，
  返回 `{"ok":true,"value":…}`。
- **自带 skill**：`dsh-session-log-repair`，启动时注册进 `ctx.skills`
  （`source: bundled`），详见 [随包 skill](#随包-skill)。
- **配置**：可选的 `backupRoot` / `sessionsRoot`，写在本包自己的 patch 行上。

## 目录结构

```
├── lib/index.js          # 宿主半边（纯 ESM）：编解码、规划、操作、工具、路由、skill
├── lib/client.js         # 浏览器半边：__ModuleLoader__ 工厂（底部按钮 + 弹框）
├── skill/SKILL.md        # 随包 skill 正文：症状分型、容器契约、算法
├── skill/scripts/        # 离线工具链（无需宿主运行）：scan / repair / verify
├── scripts/host-smoke.mjs    # 宿主半边集成测试（真实后端 + 合成损坏日志）
├── scripts/client-smoke.mjs  # 浏览器半边渲染测试（模块加载器 face + 两个插槽）
├── scripts/install-smoke.mjs # 安装脚本回归测试（重复 entry id、幂等）
├── scripts/install.mjs       # 安装 / 卸载到 DSH profile
├── scripts/host-resolve.mjs  # 测试共用的宿主包解析
├── cordis.patch.yml      # bundle patch：插入本包的加载行
├── package.json          # dsh.bundle + dsh.client(web) 清单 + peer/dev 依赖
├── .github/workflows/    # ci.yml（测试）+ release.yml（打 tag 发 Release）
├── README.md             # English
└── README.zh.md          # 本文件
```

## 安装

```sh
# 本地检出（本仓库的用法）
dsh plugin --profile web add ./dsh-session-repair

# 重启宿主让 bundle 层挂载
dsh --profile web --dump-config   # 验证：只有一行 dsh-session-repair
dsh --profile web                 # 启动
```

本仓库的安装脚本做同样的三处改动，并用宿主自己的 loader 组合 profile 来验证结果：

```sh
node scripts/install.mjs --profile web            # 安装 + 验证
node scripts/install.mjs --profile web --uninstall
```

**一个插件只能有一条启用路径。** 不要再往 profile 的 `cordis.patch.yml` 里加同样的
insert 行：bundle 层已经插入了同一个 entry id，两行同 id 会让启动直接失败并报
`duplicate loader entry id: dsh-session-repair`。安装脚本会删掉发现的这类行
（并保证用户 patch 层仍是合法的 YAML 数组），再用宿主 loader 组合一遍确认只剩 1 行。

bundle 层的行在**树加载早期**就 apply，此时 webserver 服务还没注册，所以插件通过
`ctx.inject([…])` 等待 `webServer` / `commands` / `skills`，而不是一次性 `ctx.get`——否则
每次启动都会静默跳过路由注册。

重启宿主让 bundle 层挂载，并刷新浏览器页面加载客户端 bundle。

## 用法

**Web GUI** —— 点侧边栏底部的「会话修复」。弹框会扫描全部会话，列出无法加载的项，
支持单个「修复」和「一键修复全部」。

**模型工具**

| 工具 | 作用 |
| --- | --- |
| `dsh_session_repair_scan` | 扫描全部日志，输出 `ok` / `corrupt` / `unreadable` / `torn` / `live` |
| `dsh_session_repair_apply` | 修一个会话（`session`）、修全部（`all: true`）、或只预览（`dryRun: true`） |
| `dsh_session_repair_verify` | 用宿主真实加载路径复检 |

**命令** —— `/dsh-session-repair {"op":"scan"}`，`repair` / `verify` / `status` 用同样的 JSON 字段。

**HTTP** —— `POST /dsh-session-repair/api`，body `{"op":"…"}`，返回 `{"ok":true,"value":…}`；
围栏限定 loopback/受信主机 + 同源标记。

## 安全边界

- 读取走运行中的后端（`sessionPersistence.readRaw`），字节来自宿主自己的帧解码器；
  行展开用宿主的 `decodeStorageRecord`。
- 本进程内**活动会话**直接拒绝（scan 跳过）；`force: true` 可显式覆盖。
- 规划后、发布前复检文件（size + mtime），并发写入会让本次修复中止。
- 写盘前把原文件复制到
  `$DSH_HOME/session-repair-backups/<id>-<时间戳>/<id>.jsonl.zstd.orig`。
- 修复结果写到同目录临时文件 → fsync → rename 覆盖（原子发布）。
- 发布后再用后端自身重新加载；不一致会报错而不是默认成功。
- 幂等：干净的日志永远不会被重写。

## 随包 skill

装上插件就同时激活 **`dsh-session-log-repair` skill**：宿主半边把它注册进 `ctx.skills`
（`source: bundled`，`resourceBase` 指向 `skill/`），因此它会出现在模型技能目录里、可用
`skill` 工具加载——**不需要**再单独装到 `~/.agents/skills`。

- `skill/SKILL.md`：诊断与成因知识（症状分型、日志容器契约、成因指纹、存活链规则、宿主侧
  加固建议、源码索引）。
- `skill/scripts/`：离线工具链，**不需要 DSH 运行**——DSH 起不来时走这条路：

```sh
cd <deepseek-harness 检出目录>
node --import tsx/esm <插件目录>/skill/scripts/repair-all-sessions.mjs --dry-run
```

| 脚本 | 作用 |
| --- | --- |
| `skill/scripts/scan-sessions.mjs` | 只读扫描 `~/.dsh/sessions` |
| `skill/scripts/repair-all-sessions.mjs` | 扫全库并修复所有未被占用的会话（`--dry-run`、`--backup-dir`） |
| `skill/scripts/repair-session-log.mjs` | 单会话诊断；`--apply` 才写盘 |
| `skill/scripts/verify-repaired-session.mjs` | 用真实 loader + 投影复检 |
| `skill/scripts/host-resolver.mjs` | pnpm 布局下的裸依赖解析兜底 |

## 配置

可选插件配置，写进**本包自己的** `cordis.patch.yml`（bundle 层），不要写进 profile 的用户 patch：

```yaml
- insert:
    - id: dsh-session-repair
      name: dsh-session-repair
      config:
        backupRoot: D:/backups/session-repair   # 默认 $DSH_HOME/session-repair-backups/<id>-<时间戳>
        sessionsRoot: D:/other/sessions         # 默认取后端配置的 root
```

## 开发

要求：**Node ≥ 22.15 + pnpm 10**（`packageManager` 字段固定 pnpm 版本）。测试脚本需要
宿主包，解析顺序是「DSH profile → 本包 devDependencies」，因此干净检出也能直接跑：

```sh
pnpm install       # devDependencies：@deepseek-ai/* 宿主包、react、react-dom
npm test           # 语法检查 + 三个冒烟测试
npm run test:host      # 真实后端 + 临时目录：工具、路由、围栏、skill 注册、fiber 回收
npm run test:client    # 模块加载器 face、插槽注册、渲染
npm run test:install   # 安装脚本：重复 entry id 迁移 + 幂等 + 卸载
npm run check          # 对每个源文件跑 node --check
```

`node scripts/host-smoke.mjs <真实损坏日志.jsonl.zstd>` 可以改用真实损坏日志（默认用内置
合成日志）。插件自己的 `scripts/` 与 skill 的 `skill/scripts/` 是**两个目录**：前者驱动本包，
后者是 skill 正文引用的离线工具链。

## 自动化发布

| 工作流 | 触发 | 内容 |
| --- | --- | --- |
| [`ci.yml`](.github/workflows/ci.yml) | push 到 `master`、PR、手动 | Node 26 → `pnpm install --frozen-lockfile` → `npm test` |
| [`release.yml`](.github/workflows/release.yml) | 打 `v*` tag | 同样的检查 → `npm pack` → 创建正式 GitHub Release 并附 tarball |

```sh
npm version patch -m "release: v%s" && git push --follow-tags
```

**刻意不发布 npm**：`dsh-session-repair` 这个名字已被另一个无关项目占用，因此本包保持
`private`，release 工作流只发 GitHub Release。

## 实现说明

- 宿主半边是纯 ESM（`lib/index.js`），由宿主用原生 Node ESM 加载——无打包器、无构建产物。
- 浏览器半边（`lib/client.js`）是单个 `window.__ModuleLoader__.load` 工厂，导出
  `{ name, inject, apply }`；`react` / `react-dom` 保持外部依赖，运行时从宿主模块表解析。
- peer 依赖（`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-tools`）是可选的：缺失也能工作，
  后端不是 JSONL 时状态会报 `unsupported`。
- **不修改**官方 `deepseek-harness`：全部使用既有服务（`tools`、`commands`、`skills`、
  `webServer`）与插槽（`sidebar.footer.action`、`shell.overlay`）。

## 许可证

MIT © jsoncode
