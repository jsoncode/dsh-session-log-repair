# dsh-session-repair

DSH 会话日志**提交区 seq 冲突**的一键修复插件 —— 也就是 Web GUI 里
`历史加载失败` / `failed to observe session … corrupt session log: seq gap in
committed region at line N (expected X, got Y)` 的成因。

插件提供：侧边栏底部「会话修复」按钮 + 修复弹框、3 个模型工具、
`/dsh-session-repair` 命令，以及一条带围栏的 HTTP 路由。无构建链：宿主半边是
纯 ESM，浏览器半边是手写的模块加载器 bundle。

## 它修什么

DSH 会话日志是拼接多帧 zstd 的 JSONL，加载器要求每一行的 `seq` 紧接上一行。
当同一会话被两个写入者持有 —— 典型场景是一个进程卡在 LLM 重试退避里，另一个
进程 resume 同一会话并写入崩溃修复事件，卡住的进程醒来后用旧计数器追加 ——
两行不同的事件会占用同一批 `seq`，加载器随即拒绝整个日志，会话打不开。

修复保留**存活链**、丢弃重叠的旧版本：

1. 从文件末尾反向走，找出抵达末尾的最大稠密连续段（写出日志其余部分的那个写入者）；
2. 向前延伸：结束位置恰好接上链起点的行并入，范围探入链内的行判为重复版本丢弃；
3. 遇到真实缺口就停止，剩余部分必须是稠密前缀，否则**拒绝修复**而不是猜；
4. 插件识别的合成事件指纹（`turn/end` 的 `reason.kind: 'interrupted'`、紧随的
   `step/end`、`interrupted-tool-result-*`、`session/end-seed` resume 标记）只会
   因为「与存活链重叠」被丢弃，绝不因为标签被丢弃。

判定不依赖「谁是修复版本」，因此两个版本都是真实写入时同样成立。`seq` 不重编号，
修复后保留存活写入者的编号。

## 安装

```sh
node D:/workspace/custom/dsh-session-repair/scripts/install.mjs --profile web
```

安装脚本与 `dsh plugin --profile web install <dir>`（以及桌面端插件页）做的事完全一致：

1. 把本包 link 到 `<profile>/node_modules`；
2. 在 profile 的 `package.json` 里加 `link:` 依赖；
3. 把包名追加到 `dsh.profile.bundles`。

启动时由**本包自己的** `cordis.patch.yml` 插入加载行：

```yaml
- insert:
    - id: dsh-session-repair
      name: dsh-session-repair
```

**一个插件只能有一条启用路径。** 不要再往 profile 的 `cordis.patch.yml` 里加同样的
insert 行：bundle 层已经插入了同一个 entry id，两行同 id 会让启动直接失败——
`duplicate loader entry id: dsh-session-repair`。安装脚本会主动删掉残留的这类行
（并保证用户 patch 层仍是合法的 YAML 数组），再用宿主自己的 loader 组合一遍，
确认最终只有 1 行。

重启宿主让 bundle 层挂载，并刷新浏览器页面加载客户端 bundle。
卸载：`… install.mjs --profile web --uninstall`。

bundle 层的行在**树加载早期**就 apply，此时 webserver 服务还没注册，所以插件通过
`ctx.inject([…])` 等待 `webServer` / `commands` / `skills`，而不是一次性 `ctx.get`——否则
每次启动都会静默跳过路由/技能注册。

## 随包分发的 skill

装上插件就同时激活 **`dsh-session-log-repair` skill**：宿主半边把它注册进 `ctx.skills`
（`source: bundled`，`resourceBase` 指向 `skill/`），因此它会出现在模型技能目录里、可用
`skill` 工具加载——**不需要**再单独装到 `~/.agents/skills`。

- `skill/SKILL.md`：诊断与成因知识（症状分型、日志容器契约、成因指纹、存活链规则、宿主侧
  加固建议、源码索引）。
- `skill/scripts/`：离线工具链，**不需要 DSH 运行**——DSH 起不来时走这条路：

```sh
cd <deepseek-harness 检出目录>
node --import tsx/esm D:/workspace/custom/dsh-session-repair/skill/scripts/repair-all-sessions.mjs --dry-run
```

| 脚本 | 作用 |
| --- | --- |
| `skill/scripts/scan-sessions.mjs` | 只读扫描 `~/.dsh/sessions` |
| `skill/scripts/repair-all-sessions.mjs` | 扫全库并修复所有未被占用的会话（`--dry-run`、`--backup-dir`） |
| `skill/scripts/repair-session-log.mjs` | 单会话诊断；`--apply` 才写盘 |
| `skill/scripts/verify-repaired-session.mjs` | 用真实 loader + 投影复检 |
| `skill/scripts/host-resolver.mjs` | pnpm 布局下的裸依赖解析兜底 |

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

**HTTP** —— `POST /dsh-session-repair/api`，body 为 `{"op":"…"}`，返回
`{"ok":true,"value":…}`。路由仅接受 loopback/受信主机且同源的请求。

## 安全边界

- 读取走运行中的后端（`sessionPersistence.readRaw`），字节来自宿主自己的帧解码器；
  行展开用宿主的 `decodeStorageRecord`。
- 在本进程内**处于活动状态**的会话会被拒绝（扫描时跳过）；`force: true` 可强行覆盖。
- 规划后、发布前会复检文件（size + mtime），发现并发写入就中止。
- 写入前先把原文件复制到
  `$DSH_HOME/session-repair-backups/<id>-<时间戳>/<id>.jsonl.zstd.orig`。
- 修复结果先写同目录临时文件、fsync，再 rename 覆盖（原子发布）。
- 发布后用后端自身重新加载验收，不一致会报错而不是假设成功。
- 幂等：已干净的日志不会被重写。

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

## 开发与自测

```sh
node scripts/host-smoke.mjs     # 真实后端 + 临时目录：工具、路由、围栏、skill 注册、fiber 回收
node scripts/client-smoke.mjs   # 模块加载器 face、插槽注册、渲染
node scripts/install-smoke.mjs  # 安装脚本：重复 entry id 迁移 + 幂等 + 卸载
cd <deepseek-harness> && node --import tsx/esm scripts/selftest.mts <corrupt.jsonl.zstd>
```

`scripts/make-corrupt-session.mts` 用于在会话目录下造损坏副本（仅开发用）。
插件自己的 `scripts/` 与 skill 的 `skill/scripts/` 是**两个目录**：前者驱动本包，后者是
skill 正文引用的离线工具链。
