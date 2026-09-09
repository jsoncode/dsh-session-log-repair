---
name: dsh-session-log-repair
description: Use when a DeepSeek Harness (DSH) session cannot load its history — Web GUI shows "历史加载失败", or the error mentions "failed to observe session", "corrupt session log" with a seq gap in the committed region, duplicate or rewound seq values, a corrupt session.jsonl.zstd, or a session log written by two writers after a crash or an LLM-retry backoff. Also use to inspect a DSH session log's frames, events, seq density, and turn boundaries.
---

# DSH 会话日志修复（重复 seq / 回退行）

DSH 的会话日志是「多帧 zstd 拼接的 JSONL」。读取时 `SessionLogScanner` 要求每个事件的
`seq` 严格等于已累计事件数；一旦发现不一致就拒载**整个**日志。GUI 里表现为
「历史加载失败：failed to observe session "…": corrupt session log: seq gap in committed
region at line N (expected X, got Y)（gateway/internal）」。

本 skill 只处理**重复/回退行**（`got < expected`）。真正的缺行（`got > expected`）和截断尾帧
由其它机制处理，工具会明确拒绝。

## 1. 症状分型（先看 `expected` 与 `got`）

| 现象 | 含义 | 本工具 |
|---|---|---|
| `got < expected`（如 expected 29548, got 29546） | 某行 seq 回退/重复：有陈旧写入者把旧计数器的新事件盖在已提交区上 | ✅ 可修 |
| `got > expected` | 真的缺行 | ❌ 拒绝（需要别的恢复手段） |
| 尾帧不完整 | torn tail | ❌ 拒绝：先让 DSH 正常加载/恢复一次，再运行 |

报错信息里的 `line N` 是**事件行号**（不含 header 行），且它是**问题首次出现**的位置；
真正抛错发生在之后第一条含 `turn/end` 的行。行号相差 1 是正常的（文件行 = 事件行 + 1）。

## 2. 容器与校验规则（读日志前必须知道的契约）

- 路径：`<DSH_HOME>/sessions/<cwd 派生的项目目录>/<session-id>/session.jsonl.zstd`
  （本项目是 `~/.dsh/sessions/--D-workspace-custom--/session-<id>/session.jsonl.zstd`）。
- 容器：**第 1 帧必须恰好是 header 单行**（`assertZstdHeaderFrame`），其后每帧是**一次 append
  批次**的若干行；帧边界对读取不敏感，但第 1 帧不可合并。
- 行：普通事件一行一个；连续 delta chunk 会打包成 `text-chunks` / `reasoning-chunks` /
  `tool-call-chunks`（`seq0` 锚点 + N 个成员），展开后才是事件。
- 校验：展开后逐事件要求 `event.seq === 已累计事件数`；不满足即记录 issue，遇到含
  `turn/end` 的行立刻抛出。
- `scanLog(buffer)` 接受的是**解压后的明文**；对整文件字节调用必然报
  `header line is not valid JSON`。多帧文件也不能用 `zstdDecompressSync` 一次解完
  （它只解第一帧）——要按帧边界解。

## 3. 典型成因与指纹

**成因 A：两个写入者 + 崩溃修复（最常见）**

1. 进程 1（存活写入者）卡住：LLM 重试退避（`llm-retry`：`append llm/retry` → 延迟 →
   `append llm/retry-started`）、工具挂起、进程被暂停。
2. 卡住期间日志看起来「静止」，进程 2 resume/inspect 同一会话，读到开放 turn，合成修复事件并
   `commitRepair` 落盘（`interruptedTurnClosers` + 可能还有一个「中断的 tool result」+ resume 构造
   函数自己的 `session/end-seed`）。
3. 进程 1 醒来，用它内存里**过时的 seq 计数器**继续 append → 同一批 seq 上出现两份不同事件。
4. 因为只多写了少量事件，计数器可能「偶然重新对齐」，会话在线继续跑完；冷加载时才暴露。

修复合成的三类事件（识别指纹）：

| 类型 | 指纹 |
|---|---|
| `turn/end` | `data.reason.kind === 'interrupted'`，且 `time` 与前一个真实事件**同一毫秒** |
| `step/end` | 紧邻上面那条 `turn/end`、`time` 相同 |
| `tool/result` | `data.message.id` 以 `interrupted-tool-result-` 开头（文本为 “The tool call was interrupted…”） |
| `session/end-seed` | resume 构造函数在 seed 之后追加的边界标记（`data: {}`） |

已实测的三种窗口形状：

1. 只有修复 closers（`step/end` + `turn/end{interrupted}`）与存活写入者的重试行撞车；
2. 修复的 `tool/result` + closers + `session/end-seed` 共 4 行撞车；
3. 三种版本交错：修复 closers、存活写入者的真实行、resume 的 `session/end-seed`（后者重复了尾部
   第一个 seq）。

**成因 B**：手工/脚本写日志、复制粘贴行、进程被强杀后由外部工具补写。

## 4. 修复流程

本 skill 随插件 `dsh-session-repair` 一起分发：装好插件后，插件在宿主启动时把这个
skill 注册进 `ctx.skills`（`source: bundled`，`resourceBase` 就是本目录），因此**模型目录里
自动出现**，无需另外安装到 `~/.agents/skills`。本文档正文（§1–§3、§6–§9）是离线诊断与
成因知识；§4.0 是插件一键通道，§4.1 是本目录内脚本的离线通道。

### 4.0 首选：`dsh-session-repair` 插件（一键，无需关 DSH）

插件 `D:/workspace/custom/dsh-session-repair` 已装进 web profile：**只走 bundle 层**
（`dsh.profile.bundles` 里一行 + 本包自己的 `cordis.patch.yml` 插入 entry）。三条等价入口：

```powershell
# GUI：侧边栏底部「会话修复」→ 扫描 → 单个「修复」/「一键修复全部」

# HTTP（围栏：仅 loopback/受信主机 + 同源）
Invoke-WebRequest -Uri 'http://127.0.0.1:3080/dsh-session-repair/api' -Method POST `
  -ContentType 'application/json' -Body '{"op":"scan"}' -UseBasicParsing
# body 的 op 可为 scan / repair / verify / status；repair 可带 session / all / dryRun / force

# 模型工具：dsh_session_repair_scan / dsh_session_repair_apply / dsh_session_repair_verify
```

插件用运行中的后端读取（`readRaw` + 宿主 `decodeStorageRecord`），规划后复检 size+mtime，
先备份到 `$DSH_HOME/session-repair-backups/<id>-<ts>/`，临时文件 + fsync + rename 原子发布，
最后用 `loadStored` 复检。**本进程内活动中的会话会被拒绝**（扫描标 `live` 跳过），
所以不用先关 DSH —— 但也不能用它去改正在被本进程写入的会话（`force` 才覆盖，危险）。

重装/卸载：`node D:/workspace/custom/dsh-session-repair/scripts/install.mjs --profile web [--uninstall]`。

**启用路径只能有一条**：bundle 层（`dsh.profile.bundles` + 本包 patch）与用户 patch 层
（profile 的 `cordis.patch.yml` insert）**同时**存在时，两行同 id 会让启动直接失败：
`Error: dsh: plugin tree failed to load: ... duplicate loader entry id: dsh-session-repair`
（桌面端插件页 / `dsh plugin install` 会写 bundle 行，所以不要再手写用户 patch 行）。
安装脚本会删掉残留的用户 patch 行、把该文件还原成合法 YAML 数组（注释-only 文件解析为
null 也会让启动失败），再用宿主 `loadProfile` + `composeEntries` 组合一遍确认只剩 1 行。

另一个已修的启动期坑：bundle 行在**树加载早期** apply，此时 `webServer` 服务尚未注册，
一次性 `ctx.get('webServer')` 会拿到 undefined 并静默跳过路由（表现为 POST 到
`/dsh-session-repair/api` 返回 405/404）。插件现在用 `ctx.inject(['webServer'], …)` /
`ctx.inject(['commands'], …)` 等待服务就绪，`<插件>/scripts/host-smoke.mjs` 有专门的启动顺序用例。

### 4.1 后备：脚本流程（插件不可用时）

```powershell
# 0) 若坚持用脚本：关闭 DSH（GUI/CLI）。确认没有写者：能独占打开就安全
$f = "$env:USERPROFILE\.dsh\sessions\--D-workspace-custom--\session-<id>\session.jsonl.zstd"
try { $h=[IO.File]::Open($f,'Open','ReadWrite','None'); 'no writer'; $h.Close() } catch { 'still held: ' + $_.Exception.Message }

# 1) 先扫全部会话，一次找出所有坏的（只读）
cd <deepseek-harness 检出目录>     # 需要 tsx 与工作区依赖
node --import tsx/esm "scripts/scan-sessions.mjs"

# 1b) 或者一条命令：扫全部 + 自动修复所有「文件未被占用」的会话
node --import tsx/esm "scripts/repair-all-sessions.mjs" --dry-run     # 预览
node --import tsx/esm "scripts/repair-all-sessions.mjs" --backup-dir D:\workspace\custom\.session-backups

# 2) 单个会话：试运行（默认不写任何字节），会打印原始报错、存活尾部、要丢弃的行
node --import tsx/esm "scripts/repair-session-log.mjs" --file $f

# 3) 执行修复（自动备份 + 原子替换）
node --import tsx/esm "scripts/repair-session-log.mjs" --file $f --apply

# 4) 验收：用真实 loader + 真实投影重跑一遍
node --import tsx/esm "scripts/verify-repaired-session.mjs" --file $f

# 5) 回到 DSH 重新打开该会话（必要时刷新页面）
```

`--apply` 会把原始文件复制到 `<cwd>/.session-backups/<session>-<ts>/`；建议用
`--backup-dir` 指到 sessions 树**之外**（备份目录若长得像会话目录会干扰列表）。

退出码：`0` 成功；`1` 拒绝（会说明原因：真缺行 / torn tail / 修完仍不能加载）。

### 修复做了什么

- 逐帧解压 → 用宿主 `decodeStorageRecord` 展开每行的 seq 范围；
- **从文件末尾向前确定「存活链」**：先取到达文件末尾的最大稠密连续段（尾部），再向前延伸——某行
  `end === 链起点 - 1` 就并进链；某行 `end >= 链起点` 就是重复版本，丢弃；出现真缺口则停下并要求
  剩余部分是稠密前缀，否则拒绝；
- 换句话说：**保留产出尾部的那条写入者链，丢弃所有与它重叠的旧版本**。这条规则不依赖「谁是修复
  事件」的判定，所以两个版本都是真实写入时同样适用；
- 保持帧布局重建（第 1 帧仍是 header 单帧，被清空的帧整帧丢弃），每帧重新用
  `compressZstdFrame` 压缩；临时文件 + fsync + `rename` 原子替换；
- 修完 `maxSeq` 不变（如 42849 / 53131 / 278692 / 181581），因此所有以绝对 seq 为参照的缓存仍然有效。

### 修复后还要检查

- `~/.dsh/storages/session_projcache/sessions/<session-id>.json`：若存在，删除它，让 DSH
  重新投影（它缓存的是按 seq 定位的投影状态）。
- 会话目录里除 `session.jsonl.zstd` 之外不应有别的残留文件。
- 重新跑一次 `scan-sessions.mjs`，确认 0 个损坏。

## 5. 工具说明

**插件**（`D:/workspace/custom/dsh-session-repair`，推荐）：

| 入口 | 作用 |
|---|---|
| GUI 侧边栏「会话修复」 | 扫描 + 单个/全部一键修复（zh/en 跟随宿主 locale） |
| `POST /dsh-session-repair/api` | `{"op":"scan\|repair\|verify\|status"}` → `{"ok":true,"value":…}` |
| `dsh_session_repair_scan` | 列出 `ok` / `corrupt` / `unreadable` / `torn` / `live` |
| `dsh_session_repair_apply` | `session` / `all` / `dryRun` / `force` |
| `dsh_session_repair_verify` | 用宿主 `loadStored` 复检 |
| `scripts/install.mjs` | 装/卸（junction + `link:` 依赖 + bundle 行）——在**插件包根目录**下执行 |

**独立脚本**（本 skill 自带，只读宿主源码、可离线用；路径相对本 skill 目录
`D:/workspace/custom/dsh-session-repair/skill/`，与插件的 `scripts/` 不是同一目录）：

| 文件 | 作用 |
|---|---|
| `scripts/scan-sessions.mjs` | 只读扫描 `~/.dsh/sessions` 全部会话，列出 OK / COLLISION / BROKEN |
| `scripts/repair-all-sessions.mjs` | 扫全库并自动修复所有未被占用的会话（`--dry-run` 预览、`--backup-dir` 指定备份根） |
| `scripts/repair-session-log.mjs` | 单个会话诊断 + 修复；`--file`、`--apply`、`--backup-dir`、`--host-root`、`--json` |
| `scripts/verify-repaired-session.mjs` | 验收：`scanLog` + 16 个真实投影/纯 fold 全跑一遍 |
| `scripts/host-resolver.mjs` | 解析兜底：宿主 pnpm 布局只把部分依赖链进各包 `node_modules`，用它把 `zod` 等裸依赖回落到 `node_modules/.pnpm/node_modules` |

所有脚本都**只读宿主源码**（`--import tsx/esm` 直接跑 `packages/**/src/*.ts`），只写会话日志，
不修改宿主任何代码。默认 `--host-root D:\workspace\custom\deepseek-harness`，也可用
`DSH_HOST_ROOT` 环境变量。

## 6. 不要做的事

- **不要简单地「丢弃所有 seq 回退的行」**。第一版规则就是这么做的，结果在这类日志里保留了修复
  合成事件、丢掉了存活写入者的真实事件（含 `llm/retry-started`、`step/start`、真实 `tool/result`）。
  必须按「存活链」选版本。
- 不要重排/重编号后面所有行的 seq：改动面大且会让绝对 seq 引用失效。丢重复行才是最小修复。
- 不要用 `zstdDecompressSync` 解整份多帧文件，也不要把 `scanLog` 用在压缩字节上。
- 不要在 DSH 还开着该会话时改写文件。插件会自动拒绝「本进程内活动」的会话（扫描标 `live`），
  但**别的进程**持有它无法探测——所以插件在发布前复检 size+mtime，发现并发写入就中止；
  手动脚本没有这层保护，必须自己确认没有写者。

## 7. 如何避免再次发生（用户侧）

触发条件是**同一个会话被两个进程同时持有**：一个进程在跑（可能只是卡在重试/工具等待），另一个进程
resume/inspect 了它并写入了修复事件。2026-09-08 一天内本机出现 3 次（14:50、18:53、21:02），
另有 9/2、9/3 各一次，横跨 web GUI 与 desktop 端。

- 不要在两个 DSH 实例（web GUI + desktop app、两个浏览器标签、两个终端）里打开同一个会话；
- 需要看历史时优先用「只读」的 inspect/list（不会写修复事件），而不是 resume；
- 若某个会话必须交给另一个实例，先确认原实例已退出（本 skill 的独占打开检查）；
- 长期建议见下一节。

## 8. 根治建议（宿主侧，需要另提 PR）

1. **写入侧围栏**：`appendBatch` 落盘前校验「磁盘稠密事件数 == 本批基序号」，不一致就 fail loud
   （`appendLines` 的注释已经指出「部分写入会产生重复 seq」，但只防了半写，不防双写者）。
2. **llm-retry 与 turn 生命周期挂钩**：退避到期、append `llm/retry-started` 前校验该 turn 仍
   打开（当前只看 request-phase abort 与插件 lifetime，挡不住带外关闭）。
3. **跨进程 owner fence**：resume/`commitRepair` 需要会话级 owner token；围栏失效的旧写者
   追加应被拒绝，而不是写坏日志。
4. **文案**：`got < expected` 报成 “seq rewind/duplicate”，与真正的 gap 区分。

## 9. 源码索引

| 内容 | 位置（`deepseek-harness/`） |
|---|---|
| 校验与报错 | `packages/session/session-persistence-jsonl/src/format.ts`（`SessionLogScanner.consumeEventLine`） |
| 帧结构/压缩 | `packages/session/session-persistence-jsonl/src/zstd.ts`（`scanZstdFrames`、`compressZstdFrame`） |
| 第 1 帧断言 | `packages/session/session-persistence-jsonl/src/index.ts`（`assertZstdHeaderFrame`） |
| 合成闭合事件 | `packages/core/session/src/repair.ts`（`interruptedTurnClosers`） |
| 冷读包装 | `packages/session-query/session-query/src/observation.ts`（`failed to observe session`） |
| 重试退避 | `packages/llm/llm-retry/src/index.ts` |
