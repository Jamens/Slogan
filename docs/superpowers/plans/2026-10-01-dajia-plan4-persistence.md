# 搭家 S1 · 计划 4：持久化（M1.3）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **状态：编写完成，待执行（2026-10-01）。** 本计划实现 spec 的里程碑 **M1.3 持久化**，退出条件一句：**kill 进程重开无静默丢失**。文中所有条数（测试数、判据数、行数）都是**编写期预估**：每次派发前控制位必须按盘上实测重数一遍并把真数写进派发包（计划 3 的教训 —— 席位被告知计划数会去追一个幻影差异，甚至想改判据凑数）。带 `<待实测>` 的格子是**故意留空**的：那些数依赖真 MySQL、真窗口或 `pnpm add` 的解析结果，编写期拿不到，执行时必须实测并回填成字面量。

**Goal:** 让「画出来的房子」活得过进程 —— 迁移、repository、首启连接向导、工程锁与心跳、自动保存与崩溃恢复，全部落在主进程，renderer 一行 SQL 都不许碰。

**Architecture:** 四段切分，每段都可单独证伪。① **真源仍只在 renderer 的 `TransactionLog` 里**（D2b 不动摇）：主进程不持文档对象，只持连接池与投影；② **写路径 = 追加式流水**：每次成功的 `dispatch`/`undo`/`redo` 产出一发 `Patch`，作为 `command_log` 的一行（带幂等 `turn`）写进 MySQL，撤销也是一发新记录；③ **读路径 = 最近 snapshot + 重放其后的 `command_log`**（spec §8.2 原话），重放完先过一遍 `assertTruthSourceInvariants` 再交给屏幕；④ **`element`/`storey` 表是投影，不是加载源**：为 S5 的 SQL 聚合保留（生成列索引），靠对账测试防它和真源漂开。于是"库里存了什么"与"屏幕上是什么"由同一批补丁决定，而"另一个实例能不能写"由库里那一行锁决定。

**Tech Stack:** TypeScript 7.0.2 strict（`verbatimModuleSyntax` / `noUncheckedIndexedAccess` / `noUnusedLocals`）、Electron 44 + electron-vite 5、React 19 + zustand 5、`mysql2` 3.x（**新增运行时依赖**）、`zod` 4.x（**新增**，只进 `@dajia/protocol`）、vitest 5（node 环境，无 jsdom）、真 MySQL 8.0.45 集成测试（不 mock）。

**Spec:** `docs/superpowers/specs/2026-09-25-dajia-s1-design.md` —— 本计划实现 §8「持久化」全节、§9「错误处理与数据安全」、§4.3「进程模型」、里程碑 **M1.3**，并对 §11 验收 3)/4)/6) 负责。§8.1 的表清单、§8.2 的「2000 条 / 60 秒」「一次保存包在一个事务内」「工程锁与心跳」「迁移用极简顺序 `.sql` runner，不引入 ORM」「连接配置经 `safeStorage` 加密后存本地，不明文落盘」是本文每条决定的出发点。

---

## 授权与红线（先读这一段）

- **每一个连库的测试文件自己把库名钉成字面量 `dajia_test`**（`createDbPool({ ...readMysqlEnv(), database: 'dajia_test' })`），并在用例第一条就断言 `SELECT DATABASE()` 等于它。理由不是洁癖：`env.database` 允许是 `dajia`（那是应用运行时的合法取值），而测试若照抄它，配错一个环境变量就把 `migrate`/`insert` 打进用户的真工程库，且**一句错都不报**。这条守卫的变异样本见 T4-M13（反向那一本计划禁止真跑，理由写在表里）。
- **MySQL 授权在本计划首次生效，且只在这一计划生效。** 用户 2026-09-25 的原话：**「允许在 MySQL 建 `dajia` 和 `dajia_test` 库」**。执行前盘上事实：`dajia` 与 `dajia_test` **从未建过**，本仓库至今零 DB 写入（spec §12「未验证」那条到今天还成立）。授权覆盖 Task 2 起的建库建表写入；**不覆盖**任何其他库。
- **这台 MySQL 实例里有用户的别的库**（spec §12 实测 18 个，其中 14 个用户库，含 `smartscrm`、`smartscrm_react`、`flowmart`、`ledger_db`）。因此本计划第一个任务交付的不是业务代码，是**护栏**：`assertDatabaseName()` 只放行 `dajia` / `dajia_test`，其余一律抛，且**在建连接之前**抛。这条护栏有真牙（Task 1 的用例：拿 `smartscrm` 去调它必须红）。此后每一个会写库的文件都必须先过它。
- **口令不落任何进仓文件。** spec §12 里那对本地凭据只用于本机跑 `pnpm test:db` 与新闸门时的环境变量；测试代码与计划文本里**不许抄口令**，执行回填里也不许。缺环境变量时 `pnpm test:db` 必须以点名缺哪个变量的方式**响亮失败**（exit ≠ 0），**不许 `skip`** —— 静默跳过的集成测试等于没有测试，本仓反复罚的就是这一型。
- **push 由用户本人执行**（spec §13）。破坏性 git（`reset --hard`、force-push、改已提交、`--no-verify`、`branch -D`）需明确指示。任何席位**不许 `git checkout`/`switch`/`restore`/`stash`/`reset`/`clean`**（本仓是单 checkout，切分支会把在跑的席位的工作悄悄挪到另一条分支上，已发生过）。
- **renderer 永不接触数据库**（spec §4.3）。写路径只有：renderer → preload 窄接口 → main `mysql2` 池 → repository。
- **五个已有闸门（`--shot` / `--pick-shot` / `--edit-shot` / `--draw-shot` / `--prop-shot`）的事件序列与判据字面量一字不动。** 本计划新增的通道一律另开 mode。任何动到共享输入原语（`pressPx` / `clickCanvasPx` 那族）或首帧时序的改动 ⇒ 五道闸门全体重测，不是"顺手改一条 helper"。
- **闸门归控制位独跑。** 席位不跑闸门（真窗口会漂），控制位复跑；且改判据之前必须先同码复跑一遍，只有第二发一致的 Red 才允许动数。

## Global Constraints

- **依赖方向不许破**（`scripts/check-package-deps.mjs` 的 `ALLOWED_DEPS`）：`core` 谁都不许 import；`protocol` 只允许新增 **npm 依赖**（`zod`），仍不许 import 任何 `@dajia/*`；`desktop` 全可 import。**不新增第六个包**（裁决 P-1）：持久化代码进 `apps/desktop/src/main/**`，它的 node 测试进 `apps/desktop/test/**`。
- **`src/main/db/**` 与 `src/main/persist/**` 不许 import `electron`**（裁决 P-2）。理由不是洁癖：这两块要能在纯 node 下被 vitest 跑到（`import { app } from 'electron'` 在 vitest 里拿到的是路径字符串）。唯一例外 `src/main/persist/config-store.ts` —— `safeStorage` 只能来自 electron，它由新闸门在真窗口里证（见 P-2 的代价）。
- **时间一律交给服务端**：锁的过期判定用 `NOW(3)` 与 `DATE_ADD(NOW(3), INTERVAL ? MICROSECOND)`，客户端**只报 TTL、绝不报自己的时钟**；`created_at` / `updated_at` 用 `CURRENT_TIMESTAMP(3)`（裁决 P-4，spec §8.2 的跨机器场景下两台机器的时钟不可比）。
- **整数毫米纪律不破**：任何进 `Document` 的数字必须过 `assertMm`（core 已拦），zod 边界再加一道 `.int().safe()` 与「不接受 `-0`」（计划 2 转下游 #5 在此收口：`{x, y, pointId: undefined}` 那种形状只有反序列化进得来，所以修在 zod 边界，用 `.strict()`）。
- **不许拿 `byKind(...).at(-1)` 当"刚创建的那个"**（`uuidv7` 同毫秒不单调）。取新建实体只认 `log.affected` + `kind` 判别式 —— 本仓已有三处这个形状的助手（`demo.ts` 的 `lastCreatedWall`、`handles.test.ts` 的 `createdWallOf`），读盘侧要新的照此命名。
- **断言必须能区分"做了"和"没做"**：每条新判据提交前先证明它能红（改坏一个界看它叫）。这一条在"对账型"测试上尤其当真 —— `element` 表与文档对账、`storey` 表与 `element` 对账、zod shape 与 core 接口对账，三条都必须有"只改一边"的变异样本能打到红。
- **闸门一律重定向取 exit**：`pnpm verify > tmp/xxx.log 2>&1; echo exit=$?`。绝不 `| tail`（管道吃 CJK 行）。一次性脚本与日志一律写进 `.superpowers/sdd/2026-10-01-dajia-plan4-persistence/`（该目录被自身 `.gitignore` 的 `*` 忽略；`tmp/` 只放 `*.log`，别的后缀会脏工作树）。
- **`pnpm verify` 的含义本计划扩一次**：`test` 的 include 加 `apps/desktop/test/unit/**/*.test.ts`（不连库的那些进 CI）；连库的进 `pnpm test:db`，**不进 `verify`**（CI 的 ubuntu runner 没有 MySQL，也没有口令）。这条切分写死在两个 vitest config 里，判据见 Task 1。
- 每个 Task 结束跑一次 `pnpm verify` 全量 + 已存在的 `pnpm test:db`；迭代途中只跑聚焦文件。

## 文件结构（本计划落地后新增/改动）

| 文件 | 职责 | 首次出现 |
|---|---|---|
| `package.json`（根） | 加 `"test:db"`、`"db:sql"`（把内联迁移还原成 .sql 打到 stdout，给运维手敲用）；`shot`/`pick-shot`/… 五条一字不动，**T10 加 `lock-shot`、T11 加 `persist-shot`** | T1 |
| `vitest.config.ts` | include 加 `apps/desktop/test/unit/**/*.test.ts` | T1 |
| `vitest.db.config.ts` | 只 include `apps/desktop/test/db/**/*.test.ts`，且 `fileParallelism: false`（多文件共享 `dajia_test` 会互踩） | T1 |
| `packages/protocol/package.json` | `dependencies: { zod }` | T1 |
| `apps/desktop/package.json` | `dependencies: { mysql2 }`；`typecheck` 串上 `tsconfig.test.json` | T1 |
| `apps/desktop/tsconfig.test.json` | 让 `apps/desktop/test/**` 进 typecheck（CI 不跑库测试，但必须**类型检查**它们，否则红要等本地） | T1 |
| `apps/desktop/src/main/db/db-safety.ts` | `assertDatabaseName()` —— 库名白名单，`DROP`/`CREATE` 前必过 | T1 |
| `apps/desktop/src/main/db/env.ts` | 从环境变量读连接参数；缺哪个点哪个名抛 | T1 |
| `apps/desktop/test/unit/db-safety.test.ts` | 白名单的正反两向（`smartscrm` 必须抛） | T1 |
| `apps/desktop/test/db/env.test.ts` | **只读普查**：`VERSION()` / `@@character_set_server` / `@@collation_server` / `@@lower_case_table_names` / `@@max_connections`，把 spec §12 记的环境事实变成会红的断言 | T1 |
| `apps/desktop/src/main/db/pool.ts` | `createPool(cfg)`：`utf8mb4`、`connectionLimit`、`multipleStatements` 只在迁移连接上开 | T2 |
| `apps/desktop/src/main/db/migrations.ts` | 顺序迁移的内联 SQL 常量 + `sha256` 校验和（裁决 P-11：为什么不是运行时读 `.sql` 文件） | T2 |
| `apps/desktop/src/main/db/migrate.ts` | `_migration` 表、顺序应用、幂等、改过已应用的版本即抛、坏迁移停在半途的形状 | T2 |
| `apps/desktop/test/db/migrate.test.ts` | 自建自清 `dajia_test` + 上面四件事的用例 + 六张表存在性 + 生成列取值 | T2 |
| `packages/protocol/src/entity-schema.ts` | 六类实体的 zod schema（`.strict()`）+ `PatchSchema` + `JournalTurnSchema` | T3 |
| `packages/protocol/src/command-type.ts` | `COMMAND_TYPES`（与 core 的 `CommandType` 并排的另一半） | T3 |
| `packages/protocol/test/entity-schema.test.ts` | **字段对账**：zod shape 的键集合 == `packages/core/src/model/entity.ts` 里各 interface 的字段名（正则抠源码，命中次数不等就抛）—— 新增字段忘了登记 schema 在这一格红 | T3 |
| `packages/core/src/model/invariants.ts` | `assertTruthSourceInvariants(doc)` + 共享版 `assertNoVerticalOverlap`（从 `commands/storey.ts` 提上来，不留第二份规则） | T3 |
| `packages/core/test/invariants.test.ts` | 计划 2 交下来的读盘清单逐条有牙（`handBuild(...)` 手搓坏文档；命令层造不出这些坏数据正是它的落点） | T3 |
| `apps/desktop/src/main/db/codec.ts` | 磁盘 JSON ↔ core `Entity`/`Document`/`Patch`；每一行过 zod，抛错带表名与行 id | T4 |
| `apps/desktop/src/main/db/pool.ts`（**T4 回改**） | 补 `supportBigNumbers`/`bigNumberStrings` 与 `lockWaitTimeoutMs` 透传（裁决 P-17：读路径第一次真读 BIGINT 才需要） | T4 |
| `apps/desktop/src/main/db/repository.ts` | `createProject` / `appendJournal` / `writeSnapshot` / `loadProject` / `closeProject` —— 唯一会写库的地方 | T4–T5 |
| `apps/desktop/src/main/db/reconcile.ts` | 收尾三方对账的**纯函数**（`diffDocAgainstElement` / `diffStoreyProjection` / `diffStoreyIdColumn` / `reconcileProjection` / `formatMismatches`）+ `storeyIdOf`（写列与审列共用那一份规则，从 `repository.ts` 的模块私有版搬进来）+ `MISMATCH_REPORT_CAP`。不 import DB / electron / zod ⇒ 住在这里才有 CI 那一档 | T5 |
| `apps/desktop/test/unit/codec.test.ts` | 纯内存往返：六类实体逐字回来、`canonical()` 逐字节相同、多余字段/浮点/`-0` 三型在读取侧拒、抛错文案带表名与行 id（**不连库 ⇒ CI 有牙**） | T4 |
| `apps/desktop/test/unit/entity-shape.test.ts` | **编译期双向可赋值** `EntityShape ↔ Entity`（`tsc -p tsconfig.test.json` 才看得见的那一型漂移） | T4 |
| `apps/desktop/test/db/repository.test.ts` | 三张表 + `storey` 投影逐行对账、`updated_seq` = 该发 `command_log.seq`、`turn` 幂等、跳号回滚、**外部行锁掐断半途 ⇒ 全无账 ⇒ 释放后重发成功**（P-15）、归属 guard、remove 撞空行、重复快照撞唯一键、盘上 `-0`/超安全整数的读数（实测钉死） | T4 |
| `apps/desktop/test/unit/reconcile.test.ts` | 三对各自的空/少行/多行/字段漂、`-0` 与键序两条口径、报告上限"只列 12 条但把总数说全"、输出顺序确定（**不连库 ⇒ CI 有牙**，第 ⑤ 段把纯函数单拆一个文件的全部理由） | T5 |
| `apps/desktop/test/db/journal.test.ts` | 加载 = 最近快照 + 重放其后（快照压在第 3 / 第 5 发的 off-by-one 各一型）、`seq` 可带洞而 `turn` 不可（缺号拒开：中缺与尾缺两位证人）、`schema_version` 三处不符 + `payload.project_id` 别工程 ⇒ 拒开、BIGINT 越界的 `typeof` 读数、`clean_shutdown` 的四种告别方式、`closeProject` 三方对账（不平 ⇒ 抛且不许落 1） | T5 |
| `apps/desktop/src/main/persist/autosave.ts` | 保存引擎（electron-free、fs-free，P-2）：按 turn 串行的队列、两条快照阈值（2000 行 / 连续 60 秒）、同 turn 只抢救一次、心跳报 `lost` 或抛错 ⇒ 停写（`pause`）；三个注入点 `sink` / `timer` / `onEmergency` | T7 |
| `apps/desktop/test/unit/autosave.test.ts` | **24 格**，不连库：假钟 + 假 sink 把触发判定、重试、停写、flush 的形状钉下来（禁令落在 repository 层，引擎的注入点是它自己的接口） | T7 |
| `apps/desktop/src/main/db/locks.ts` | `newLockTicket` / `ttlToMicroseconds` / `acquireLock` / `heartbeat` / `releaseLock` / `lockState`，判定全在服务端时钟（`NOW(3)`，文件里不许出现客户机时钟）+ `LOCK_TTL_MS` / `LOCK_HEARTBEAT_INTERVAL_MS` —— **T7 的心跳定时器与 T8 的 IPC 默认值都从这里取，不许各写一份** | T6 |
| `apps/desktop/test/unit/locks-ticket.test.ts` | 不连库的那一档（**CI 有牙**）：票过 `isEntityId` 且两张不同、owner 的 200 字符尺含恰好放行那一型、`ttlToMicroseconds` 的 0 合法与越界四型、TTL≥3×心跳间隔，外加两条**源码扫描**：`locks.ts` 里禁 `Date.now(` / `new Date(` / `performance.now(` 且 `NOW(3)` 不少于 3 处（P-4 唯一的常驻证人），以及每一发 ``UPDATE `project` `` 都必须跟 `` `id` = ? `` | T6 |
| `apps/desktop/test/db/locks.test.ts` | 两个池当两台机器（各 `connectionLimit: 2`）：单语句 CAS 六型（幂等重发算 `acquired`、`no-project` 不算 `busy`、锁按工程分）、过期与接管六型（`ttlMs = 0` 写完就不算活、`SELECT SLEEP(0.002)` 跨刻度、两型手搓列各证一支 WHERE、真等接管全链）、心跳六型（过期未接管能复活、只推余额不动票与 owner、删行 ⇒ `lost` 不抛、余额读数按毫秒两型）、解锁五型（三列一起归 NULL、二次 `not-mine`、不动别人）、并发两型（`Promise.all` 恰好一个赢家 + `@@transaction_isolation` 读数）、与写路径互不知情两型（拿锁不动账 / 没拿锁也能 `appendJournal`） | T6 |
| `packages/core/src/model/transaction.ts` | 加 `get lastPatch(): Patch \| null`（只在成功后更新；抛错时留着上一发，与计划 2 转下游 #11 同一条形状） | T7 |
| `packages/core/test/transaction.test.ts` | 上面那条 **+7 格**：dispatch 正向 / undo 记逆补丁 / redo 正向 / 空栈不刷 / build 抛错停在上一发 / remove 名单 / 连撤 30 发逐发打得回（既有 8 格一字不动） | T7 |
| `apps/desktop/src/main/persist/describe-error.ts` | `describeError(err)`：`autosave.ts` 与 `emergency.ts` 共同的文案出口，驱动 `err.code` 进文案（不 import electron / `node:fs`） | T7 |
| `apps/desktop/src/main/persist/emergency.ts` | 存盘失败时向 `userData/emergency/` 写 JSON 快照（spec §9 的同步动作）：唯一碰 `node:fs` 的持久化文件，`userDataDir` 走**参数**不走 `app.getPath`；出口只有 `EmergencyWrite` 一型，失败不抛；裁剪按工程分桶、按文件名里的 turn 排序 | T7 |
| `apps/desktop/test/unit/emergency.test.ts` | **6 格**（真 `fs`，目录在 `os.tmpdir()`）：文件名两条尺、envelope 七键逐字节、同 turn 覆盖、三型失败一律 `ok:false`、`keep=2` 分桶裁剪、`keep` 的 `>=1` 尺 | T7 |
| `apps/desktop/test/unit/persist-boundary.test.ts` | **2 格** 源码扫描：`autosave.ts` 里既无 `electron` 也无 `node:fs` 且 `LOCK_HEARTBEAT_INTERVAL_MS` 这个标识符还在；`emergency.ts` 许碰 `fs` 不许碰 `electron`，`describe-error.ts` 两样都不许 —— P-2 与"数值唯一产地"的常驻证人 | T7 |
| `apps/desktop/test/db/autosave-journal.test.ts` | **7 格**（真库 + 真 `ProjectRepository` 当 sink）：八发连着落 + `loadProject` 还原、undo/redo 各产一发新账、`(turn, doc)` 同源、`already-applied` 不推进计数器、真故障重试且一个 turn 一份抢救件、pause 期间库里一行不许多、flush 补收尾快照与 `stop` | T7 |
| `apps/desktop/src/main/persist/config-store.ts` | `safeStorage` 加密连接配置（唯一 import electron 的持久化文件） | T9 |
| `packages/protocol/src/ipc.ts` | 通道从 1 条扩到 `<待实测>` 条 + 每条请求/回包的 zod schema | T8 |
| `packages/protocol/src/persist-schema.ts` | IPC 契约：连接配置、打开结果、只读决定、保存状态事件 | T8 |
| `apps/desktop/src/preload/index.ts` | `DajiaApi` 从只有 `ping` 扩成窄接口（逐个方法显式写，不透传 `ipcRenderer`） | T8 |
| `apps/desktop/src/renderer/src/stores/projectStore.ts` | 连接态、`projectId`、`readOnly`、保存状态、恢复横幅 | T8 |
| `apps/desktop/src/renderer/src/stores/editorStore.ts` | 加 `loadProject(...)` 与只读闸门；**默认态仍是 `demoHouse()`，一字不动**（五道闸门吃它） | T8 |
| `apps/desktop/src/renderer/src/App.tsx` | 无配置 → 向导；有配置 → 打开工程；横幅（只读 / 存盘失败 / 已恢复） | T8/T9 |
| `apps/desktop/src/renderer/src/panels.tsx` | 向导那两栏（输入 + 测试连接 + 分型诊断 + 一键复制）；`STOREY_TAB_HEIGHT_PX = 32` 不许动（闸门原点判据吃它） | T9 |
| `apps/desktop/src/main/db/diagnostics.ts` | `classifyDbError(err)`：ECONNREFUSED / ER_ACCESS_DENIED_ERROR / ER_BAD_DB_ERROR / PROTOCOL_CONNECTION_LOST / ETIMEDOUT / 未知码 ⇒ 各配文案与下一步 | T9 |
| `apps/desktop/test/unit/diagnostics.test.ts` | 六个分型 + 「未知码不许说成服务未启动」 | T9 |
| `apps/desktop/src/main/index.ts` | 加 `--lock-shot` / `--persist-shot` 两分支（现 2579 行；新分支只加不改既有五分支） | T10/T11 |
| `scripts/desktop-shot.mjs` | mode 链 +2（`lock` / `persist`）、`expectedChecksByMode` +2 格、多进程编排（`spawn` + `SIGKILL`） | T10/T11 |
| `scripts/test/shot-baseline.test.mjs` | 「闸门模式 token ↔ package.json script 配对」表 +2 行；条数账的 `for (const mode of [...])` 名单 +2 | T10/T11 |
| `docs/install-mysql.md` | spec §13.4 那「一页图文安装说明」：没装 MySQL 的机器下一步做什么（验收 6 的一半） | T9 |

---

## 现状事实（2026-10-01 逐条实测，写给执行者省得再翻）

**盘上基线**（`pnpm test > tmp/plan4-baseline-test.log`，**exit=0 / 35 文件 / 509 条**，2.26s，今日实测）：

| 包 | 测试文件 | 用例 |
|---|---|---|
| `packages/core` | 25 | 316 |
| `packages/scene-2d` | 7 | 172 |
| `scripts/test` | 2 | 18 |
| `packages/protocol` | 1 | 3 |
| 合计 | **35** | **509** |

`packages/drawing` 与 `packages/scene-3d` 各自只有 `package.json` + `src/index.ts` 两文件（stub，无测试），且**不在根 `typecheck` 脚本里**（那条串的是 core / protocol / scene-2d / desktop 四段）。

**工作树与工具链**：分支 `main`，`git status --porcelain` 空，本地领先 `origin/main`（**push 归用户**）；Node v24.14.1、pnpm 11.18.0、vitest 5.0.1（`npm view vitest version` = 5.0.3，未升）；`npm view zod version` = **4.6.5**、`npm view mysql2 version` = **3.24.5**（两者今天都还没装：`grep -rn "mysql\|zod"` 在仓库里**零命中**）。

**MySQL**（今日只读探测）：`node` 的 `net.connect(3306, '127.0.0.1')` 回 **OPEN**；本机 `which mysql` 无 —— **mysql CLI 不在 PATH**，所以任何"用命令行客户端手敲 SQL"的写法在这台机器上跑不通，运维通路只能是 `pnpm db:sql` 导出。`dajia` / `dajia_test` 是否已存在**未核**（要连库，Task 1 第一步就核并把结果落盘）。spec §12 那五条服务端参数（utf8mb4 / utf8mb4_0900_ai_ci / `lower_case_table_names=1` / `max_connections=151` / 8.0.45）由 Task 1 的 `env.test.ts` 变成会红的断言。

**代码形状**（本计划要接的每一个口子）：

- `packages/core/src/model/document.ts`：`Document.create(projectId, schemaVersion = SCHEMA_VERSION)`、`Document.replaceEntities(doc, map)`（**这是唯一的手工入口**，它 validate：id 必须 UUIDv7、每种 kind 的整数毫米字段名单写死在 `INTEGER_FIELDS`）、`byKind` 按 id 升序、`canonical()` = `stableStringify({projectId, schemaVersion, entities 按 id 升序})`。`SCHEMA_VERSION = 1`，`CORE_SCHEMA_VERSION = 1`（两处，index.ts 与 document.ts）。
- `packages/core/src/model/transaction.ts`：`dispatch(cmd)` / `undo()` / `redo()` / `document` / `affected` / `depth` / `canUndo` / `canRedo`。**没有 begin/commit/rollback，也没有暴露补丁** —— 补丁在 `Entry` 里是私有的，这就是 T7 要加 `lastPatch` 的原因。
- `packages/core/src/model/patch.ts`：`Patch = { upsert: readonly Entity[]; remove: readonly EntityId[] }`（**纯数据，天生可 JSON** —— 本计划的落库单位就是它），`applyPatch` 三条抛错：`upsert` 内 id 重复、同一 id 既 upsert 又 remove、`remove` 的实体不存在。**第三条正是重放不能重复投喂的证明**（T5 的变异样本）。
- `packages/core/src/model/command.ts`：`CommandType` 16 个成员 + `Command { type, build(doc): Patch }`。命令是闭包，**不可序列化** ⇒ 落库存 `type` + `Patch`（裁决 P-5）。
- `packages/core/src/model/stable-stringify.ts`：键递归排序、数组保序、`undefined` 键丢弃、非有限数抛、Map 抛。所以 MySQL JSON 列重排键序不影响 `canonical()` 相等。
- `packages/core/src/model/read.ts`：`mustExist` / `requireWall` / `requirePoint` / `requireStorey`（`requireOpening` / `requireColumn` / `requireSlab` 在各自命令文件里私有 —— T3 的读盘检查器不许复制这六份，要共用）。
- `packages/core/src/commands/storey.ts:21`：`assertNoVerticalOverlap` 是**模块私有**（计划 2 明确留言：计划 4 需要共享版，别复制第二份规则）⇒ T3 提它进 `model/invariants.ts`。
- `apps/desktop/src/main/index.ts`（2579 行）：`argPath(flag)` 让开关与路径成对并 fail-fast（`exit(2)`）；`whenLoaded` / `waitForDebug` / `waitUntil(label, probe, done)`（等不到就抛「10 秒内没等到：${label}\n最后一眼：${JSON.stringify(last)}」）；五个 `run*Shot`；`ipcMain.removeHandler(IPC.ping)` + `handle` 在 `createWindow` 里；`whenReady` 那段「从具体到通用」的五段分支 + `Menu.setApplicationMenu(null)` 只在 `--shot` 下摘。
- `apps/desktop/src/renderer/src/stores/editorStore.ts`（198 行）：模块作用域 `const demo = demoHouse()`，初始 `log: demo.log`、`storeyId: demo.lowerStoreyId`、`revision` 只在成功后 +1、`dispatchBatch` **不是一个事务**（那句注释明写"批语义是计划 4 真源侧的决定"）。
- `scripts/desktop-shot.mjs`（356 行）：`expectedChecksByMode = { shot: 6, pick: 11, edit: 22, draw: 28, prop: 30 }` 是判据条数硬闸；`runElectron` 现在只 `spawnSync` **一发**；`mode` 由 argv 链现推。
- `scripts/test/shot-baseline.test.mjs`（118 行）：三组账 —— 闸门字面量 ↔ 结构账、条数账（基座 6 + 各 `if (wantX) {}` 块内 `^ {6}\[` 行数）、**token ↔ package.json script 配对**（`byScript` 现 5 行，`tokens` 现 4 个）。新闸门必须同时动这三处，只动 `desktop-shot.mjs` 就是"写了没人认"。
- `apps/desktop/electron.vite.config.ts`：`externalizeDeps: { exclude: ['@dajia/core', '@dajia/protocol'] }` + alias 到 `.ts` 源码。**`mysql2` 必须留在外部化那一侧**（它是真 npm 依赖，打进 bundle 会碰 `node:` 原生与可选依赖），`zod` 走 `@dajia/protocol` 那条 exclude 一起打进产物 —— T1 要实测这两条主张，见下面 P-12。
- `pnpm-workspace.yaml` 的 `allowBuilds` 现在只放行 `esbuild`、显式关掉 `electron-winstaller`。`mysql2` 与 `zod` 都没有 install 脚本，理论上不用动这张表 —— **T1 实测确认**（若 pnpm 11 因新的 build 脚本拦下 `mysql2` 的可选依赖，就按 esbuild 那条的形状加一行并写明理由）。

**五个闸门的既有字面量**（本计划一行都不许改，动了就要按 memory 里那条判别法先同码复跑）：指令表 `ops === 31`、`structure === 20`、`opening === 10`、`annotation === 1`、画布原点 `(0, 32)`（= `STOREY_TAB_HEIGHT_PX`）、`--prop` 的靶子 `click=(113,416)` / 画布 `1167×833` / P7 墨迹 `30742` / P20 级联 `10→7` / P3 `(0,32)`。

---

## 裁决（P-1 … P-17；执行中若与落地的代码冲突，按代码订正并写执行回填）

| # | 决定 | 理由 | 已接受的代价 |
|---|---|---|---|
| **P-1** | **不新增 `@dajia/persistence` 包**；持久化代码进 `apps/desktop/src/main/{db,persist}/**`，测试进 `apps/desktop/test/{unit,db}/**` | spec §4.1 的包清单是五包 + desktop，§4.3 明写持久化路径落在 main 进程；而"repository 必须能在纯 Node 下测"（§10）由 vitest include 扩一条就能满足，不必为一个包级依赖边新登记 `PACKAGE_DIRS` | `apps/desktop` 从"没有 node 测试"变成有；`vitest.config.ts` / `tsconfig.test.json` / typecheck 三处要跟着动，且**跨包 import 测试助手的口子被打开** ⇒ 立一条纪律：`apps/desktop/test/**` 只许 import `@dajia/core`、`@dajia/protocol` 与自己包内源码，不许 import 别的包的 `test/**`（那是第二份真源的另一种发生方式） |
| **P-2** | `src/main/db/**` 与 `src/main/persist/**` 禁止 import `electron`，唯一例外 `config-store.ts` | 能进 node 测试的东西才有人测；`app.getPath` / `safeStorage` 用参数注入（`userDataDir`、`crypto` 由调用方递） | `config-store.ts` 在 node 侧零凭据，"配置不明文落盘"这一条只能由真闸门证（T9/T11 各给一格）；`safeStorage` 在无头 CI 上的行为本计划一概不主张 |
| **P-3** | **`command_log` 存 `{ type, patch }`，不存语义命令** | 命令是不可序列化闭包（`build(doc): Patch` 里全是局部捕获的入参），而 `Patch` 是纯数据且 `applyPatch` 就是它的解释器；`type` 留着给人和 S6 读 | 撤销/重做在库里不是"意图的历史"而是"状态变更的流水"（见 P-5）；S6 要做冲突合并时 `patch` 不够用，得再加一层意图 —— 那是 §14 里明写"届时不重做"的范围外工作 |
| **P-4** | 所有时间判定交给**服务端时钟**（`NOW(3)` / `CURRENT_TIMESTAMP(3)`），客户端只报 TTL | spec §8.2 的锁是为"两台机器打开同一库"设计的，两台机器的本地时钟不可比；把过期判定写成客户机时间与 `DATETIME` 比较，还得多背一层时区与 DST 的坑 | 单测里"过期"只能靠把 TTL 注入成 300ms 真等，不能用假钟拨表（`autosave` 的 60 秒 idle 不在此列 —— 它比较的是同进程内两个 `now()`，所以可注入假钟） |
| **P-5** | **追加式流水**：`undo()` 与 `redo()` 各产出一发新的 `command_log` 行 | 加载 = snapshot + 正向重放（§8.2 原话）只需要正向补丁；把撤销也记一行，"重启后得到的文档"与"关进程前的文档"才是同一句话能算出来的 | 库里的行数 ≠ 用户意图数（连按 Ctrl+Z 会写 N 行）；`journal_turn` 因此只保证单调不保证语义紧凑 |
| **P-6** | `seq` 用 `AUTO_INCREMENT`，**接受有洞** | 幂等靠 `UNIQUE (project_id, turn)` + `INSERT ... ON DUPLICATE KEY UPDATE`（撞键时 MySQL 会吃掉自增值 ⇒ 洞），重放只按 `seq > snapshotSeq` 排序读，从不要求连续 | "第 2000 条命令"这句话在实现里是**行数计数器**（`journalRowsSinceSnapshot`），不是 `seq` 值；判据文案里两处不许混着写 |
| **P-7** | `storey` 表照 spec 建，但它是 `element` 表里 storey 行的**投影**，同一事务内由 repository 写 | §8.1 点名了这张表（标高/层高/序号），删它等于改 spec；同事务写就不怕漂 | 双写。对账测试（T4）必须能红在"只改一边"，否则这一层冗余就是没人看的第二份真源 —— 届时用一版迁移 drop 它，比现在偷偷不建要好查 |
| **P-8** | spec §8.1 的「生成列抽出 … **长度**」本计划**不建** | 墙的长度不在 payload 里（真源是两端点 id），生成列算不出坐标；要它得 join 点表或往 payload 里塞派生值，后者违反 D2b 的"不存第二份" | S5 工程量真要 `WHERE lengthMm > n` 时再加一列，加了就由 repository 写时从 `wallAxisOf` 现算、读时对账（不一致抛，不许静默）。**这是对 spec 的一处收窄，T11 要在 spec §8.1 补一句订正** |
| **P-9** | 文档对象图留在 **renderer 的 `TransactionLog`**；main 只持池与投影 | 3D/2D 与撤销栈都在 renderer（spec §4.3 的进程模型 + §5.5 的 selection 例外同一条思路）；把文档搬到 main 会让每次拖拽跨进程 | `undo` 栈活不过进程：重开得到的是终态，撤销栈从零（journal 已记全，所以"重做刚才的撤销"要靠重新 dispatch，不是 Ctrl+Z）。T11 的验收对照里这条要明确写给用户看 |
| **P-10** | emergency 快照由 renderer 把文档过 IPC 交给 main 写盘 | renderer 不碰 fs 也不碰库（`nodeIntegration: false`）；失败时才发这一发，量级无所谓 | emergency JSON 是**明文**落 `userData`（spec §9 要的就是可读可抢救）；与 P-13 的连接配置（必须加密）不是一回事，两处注释要互相指认，别让人以为是同一个口径 |
| **P-11** | 迁移 SQL 内联为 `migrations.ts` 的常量 + sha256 校验和；**不在运行时读 `.sql` 文件** | electron-builder 的默认打包面是 `out/`，运行时按 `import.meta.dirname` 找散 `.sql` 要额外配 `files`/`extraResources`，而"dev 能跑、打包后找不到迁移"这种错在 M1.3 的验收里（干净 VM 安装体验）恰好最难查。常量形态下校验和对"改过已应用的迁移"同样有牙，dev 与打包同一条通路 | 偏离 spec §8.2「顺序 `.sql` runner」的字面形状。缓解：`pnpm db:sql` 把常量原样打到 stdout，运维要手敲时用它；T2 收口时在 spec §8.2 补一句订正（版本序列与 `_migration` 表照旧） |
| **P-12** | `mysql2` 外部化、`zod` 随 `@dajia/protocol` 打进 bundle —— **两条都要 T1 实测**，不许照抄主张 | 现配置里 `externalizeDeps: { exclude: [...] }` 的 exclude 名单是"源码直连的 workspace 包"，`mysql2` 若被卷进 bundle 会连带 `node:` 与可选依赖；`zod` 若留在外部，`@dajia/protocol` 又被 exclude ⇒ 裸说明符进产物，等于复刻当年 `@dajia/core` 那三个坑 | 实测不通过时改配置，并把结论按执行回填写进本节与 `electron.vite.config.ts` 的注释 |
| **P-13** | 连接配置走 `safeStorage` 加密存 `userData/connection.bin`（0600），**闸门在真窗口里读该文件的字节，断言口令不在里面** | §8.2「不明文落盘」这句话今天没有任何凭据；能写判据的写法只有"读文件、查明文子串"这一种 | 闸门专属的这条读文件通路要在主进程加一个只在 shot 模式生效的诊断出口（与既有"只在 shot 模式转发 renderer console"同一族的先例）；`safeStorage` 在 Linux 上可能不可用 —— S1 只出 Windows（NSIS），不兜 |
| **P-14** | 新闸门两枚：`--lock-shot`（双实例只读）与 `--persist-shot`（保存 → SIGKILL → 重开 → 恢复告知） | 验收 3) 与 4) 的凭据只能在真窗口拿：前者要"进程真死"，后者要"第二个实例看得见横幅"。node 侧的等价物（事务中途被外部锁掐断、两池抢锁）证的是机制，不是屏幕 | 两枚闸门都要真 MySQL + 环境变量 ⇒ 只有控制位能跑；`--persist-shot` 一次编排 3 个 electron 进程（一发正常跑、一发 SIGKILL、一发重开），慢且吵。判据一律**自洽比对**（A 与 B 的 canonical 相等）而不是写死跨进程会漂的字面量 |
| **P-15** | "单事务半途失败"用**外部连接持行锁 + 会话级 `innodb_lock_wait_timeout`** 制造，**不在 `appendJournal` 里留任何测试钩子** | 要证明的是"要么全写要么全无"，而任何 `failAfter?: step` 之类的注入点都是产品代码里为测试存在分支 —— 它能被绕过（以后没人再传那个参数），也就守不住任何东西。外部锁是真实可达的失败：事务在 `element` 那一发上超时，前面的 `command_log` 插入尚未提交，回滚必须把它一起抹掉。顺带把 `catch` 里的 `rollback` 与 `finally` 里的 `release` 各自钉死一格（缺一发就在"释放锁后重发同一 turn"上红） | 这一格依赖 `dajia_test` 里真 MySQL 的行锁行为（S2 只出 Windows，服务端 8.0.45，见 spec §12）；CI 上 `test:db` 不跑，所以这条凭据只在本地有 —— 与 P-2 同一族代价，登记在"人工验证"那一节 |
| **P-16** | upsert 一律用 MySQL 8.0.19+ 的 `INSERT ... AS new ON DUPLICATE KEY UPDATE x = new.x` 别名形态；`writeSnapshot` 用**裸 INSERT**，不写 ODKU | `VALUES()` 函数从 8.0.20 起废弃（仍可用但打 warning），别名形态是长期写法；快照那一格"一个 `journal_turn` 最多一行"是有语义的断言（同一发重复落盘说明 autosave 的触发判定漂了），让 `uk_project_turn` 当场抛比 ODKU 静默覆盖更容易查 | 换到 MariaDB 时别名形态要回退（S1 不换，spec §12 钉的是 MySQL 8.0.45）；重复快照在实现里成了"必炸"路径 ⇒ T7 的 autosave 必须自己记住"这个 turn 已经落过盘"，不许靠 ODKU 兜 |
| **P-17** | `createDbPool` 在 **T4** 补两条配置：`supportBigNumbers: true` + `bigNumberStrings: false`，以及 `lockWaitTimeoutMs?: number`（透传 `sessionVariables`） | `journal_turn` / `turn` / `seq` / `updated_seq` 四列都是 BIGINT。mysql2 默认把 BIGINT 直接转 JS number，超出 2^53 静默失精；开 `supportBigNumbers` 后"安全范围内回 number、范围外回 string"，而 `MmSchema`/`JournalTurnSchema` 对 string 一律拒 ⇒ 越界变成一次抛，不是一次悄悄写歪的账。`lockWaitTimeoutMs` 唯一读者是 P-15 那一格（默认 50 秒会让测试看起来像挂死） | Task 2 已把 `pool.ts` 写完，T4 要回头改它 ⇒ 该文件的注释里"业务连接永远不开 multipleStatements"那句不许顺手删。越界那条主张本计划只到"会抛"为止，不主张"抛得好看"（真出现 2^53 号楼层需要 P-8 同款的 spec 订正） |

---

## Task 1: 依赖接入、测试双通道、库名护栏与只读普查

**Files:**
- Create: `vitest.db.config.ts`
- Modify: `vitest.config.ts`（include 一条变两条）
- Modify: `package.json`（根：`test:db`、`db:sql` 占位、`typecheck` 不动）
- Modify: `packages/protocol/package.json`（`dependencies: { "zod": "^4.6.5" }`）
- Modify: `apps/desktop/package.json`（`dependencies: { "mysql2": "^3.24.5" }`；`typecheck` 串 `tsconfig.test.json`）
- Create: `apps/desktop/tsconfig.test.json`
- Create: `apps/desktop/src/main/db/db-safety.ts`
- Create: `apps/desktop/src/main/db/env.ts`
- Create: `apps/desktop/test/unit/db-safety.test.ts`
- Create: `apps/desktop/test/db/env.test.ts`

**Interfaces:**
- Consumes: 无（本任务是地基）
- Produces:
  - `assertDatabaseName(value: unknown): 'dajia' | 'dajia_test'` —— 之后每一个连库/建库/删库的函数第一行都是它
  - `readMysqlEnv(env: NodeJS.ProcessEnv = process.env): MysqlEnv`，`interface MysqlEnv { host: string; port: number; user: string; password: string; database: 'dajia' | 'dajia_test' }`
  - `pnpm test:db`（连库，本地专属）、`pnpm test`（新增 `apps/desktop/test/unit/**`，CI 也跑）

- [ ] **Step 1: 装依赖并确认 pnpm 的 build 脚本闸不拦事**

```bash
pnpm --filter @dajia/protocol add zod@^4.6.5
pnpm --filter @dajia/desktop add mysql2@^3.24.5
pnpm install --frozen-lockfile=false
```

Expected: 两条都写进各自的 `package.json`；`pnpm-workspace.yaml` 的 `allowBuilds` **不需要**动（`mysql2` 与 `zod` 无 install 脚本）。若 pnpm 报了被拦的构建脚本，就把包名与原因按 `esbuild` 那行的注释形状加进 `allowBuilds`，并在本任务的执行回填里写明"是谁、为什么要放行"。

- [ ] **Step 2: 先把两条 import 形状实测掉（P-12 的账从这里开始还）**

一次性探针（写进 SDD 工作区，绝不落进仓库目录）：`.superpowers/sdd/2026-10-01-dajia-plan4-persistence/probe-import.mjs`

```js
import { createPool } from 'mysql2/promise';
import { z } from 'zod';
console.log('createPool:', typeof createPool);
console.log('z.strictObject:', typeof z.strictObject, 'z.int:', typeof z.int);
```

```bash
node .superpowers/sdd/2026-10-01-dajia-plan4-persistence/probe-import.mjs
```

Expected: `function` / `function function`。三条都要读到实测值，因为它们决定后面所有代码的写法：
- `z.int` 在 zod 4 里存在与否**只记录，不作为后续代码的前提**：本计划的整数毫米判据落在 `MmSchema = z.number().refine(Number.isSafeInteger)` + `refine(!Object.is(v, -0))`（一句同时管住"整数"与"安全范围"，且避开 `z.int()` / `z.number().int()` 在两版之间的形态出入，见 Task 3）。若这里读到 `undefined` 也不会有任何一处代码跟着红。
- 命名 import 若 TS 侧报 `TS1259`/`TS2307`，说明要 `esModuleInterop` 或改 `import type` + 工厂注入 —— **先按实测改，别先改配置**。
把三条读数原样抄进执行回填。

- [ ] **Step 3: 写库名护栏的失败测试（先红）**

`apps/desktop/test/unit/db-safety.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { ALLOWED_DATABASES, assertDatabaseName } from '../../src/main/db/db-safety';

describe('库名白名单（授权红线）', () => {
  it('放行的两个名字逐字命中', () => {
    expect([...ALLOWED_DATABASES].sort()).toEqual(['dajia', 'dajia_test']);
    expect(assertDatabaseName('dajia')).toBe('dajia');
    expect(assertDatabaseName('dajia_test')).toBe('dajia_test');
  });

  it('别人的库一律抛，且文案点名它不是我们的库', () => {
    for (const name of ['smartscrm', 'smartscrm_react', 'flowmart', 'ledger_db', 'mysql', 'information_schema']) {
      expect(() => assertDatabaseName(name)).toThrow(/不是搭家的库/);
    }
  });

  it('大小写、空白、后缀注入都不放过（lower_case_table_names=1 不代表能少查一遍）', () => {
    for (const bad of ['DAJIA', ' dajia', 'dajia ', 'dajia;DROP', 'dajia_test2', '', 'null', 'undefined']) {
      expect(() => assertDatabaseName(bad)).toThrow(/不是搭家的库/);
    }
  });

  it('非字符串也抛（env 里读出来的一切都是 string 或 undefined）', () => {
    for (const bad of [undefined, null, 42, {}, ['dajia']]) {
      expect(() => assertDatabaseName(bad)).toThrow(/不是搭家的库/);
    }
  });
});
```

Run: `npx vitest run apps/desktop/test/unit/db-safety.test.ts`
Expected: FAIL —— 找不到模块 `../../src/main/db/db-safety`（TS2307）。这条红同时证明 include 新目录已经生效：**若它报"没有匹配的测试文件"，是 `vitest.config.ts` 没改对，先修它。**

- [ ] **Step 4: 实现 `db-safety.ts`（把红线写成代码）**

`apps/desktop/src/main/db/db-safety.ts`

```ts
/**
 * 用户给的授权原话：「允许在 MySQL 建 `dajia` 和 `dajia_test` 库」。
 * 那台实例里另有 14 个用户的库（spec §12 实测：含 smartscrm、smartscrm_react、flowmart、ledger_db…），
 * 而 `CREATE DATABASE` / `DROP DATABASE` 这类语句连不上"参数化"——一旦名字进错，删掉的是别人一天的工作。
 * 所以所有会建/删/连库的函数第一行都调这里，且**在建连接之前**抛。
 *
 * 白名单而不是正则：`^dajia.*` 会放过 `dajia_smartscrm_backup` 这种真存在过的命名风格，
 * 正则挡注入的代价是把判断交给字符串形状，这里没有任何一种形状需要被放过。
 */
export const ALLOWED_DATABASES = ['dajia', 'dajia_test'] as const;
export type AllowedDatabase = (typeof ALLOWED_DATABASES)[number];

export function assertDatabaseName(value: unknown): AllowedDatabase {
  if (typeof value === 'string' && (ALLOWED_DATABASES as readonly string[]).includes(value)) {
    return value as AllowedDatabase;
  }
  throw new RangeError(
    `库名 ${JSON.stringify(value)} 不是搭家的库：只允许 ${ALLOWED_DATABASES.join(' / ')}（授权只覆盖这两个）`,
  );
}
```

Run: `npx vitest run apps/desktop/test/unit/db-safety.test.ts` → Expected: PASS（4 条）。

- [ ] **Step 5: 两个 vitest config + typecheck 覆盖测试目录**

`vitest.db.config.ts`

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const alias = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * 连库的测试只活在这里：`pnpm test`（以及 CI）一条都不碰 MySQL。
 * 三条主张各自有理由：
 * - include 只有 `test/db`：`test/unit` 是纯逻辑，归 `pnpm test`（CI 有牙的那一半）；
 * - fileParallelism false：多个文件共用一个 `dajia_test`，并行会互踩（迁移与清理撞车）。
 *   代价是慢，但把每个文件换成独立库名等于让"自建自清"变成 N 倍面积的清理；
 * - 缺环境变量时 `readMysqlEnv()` 抛，不 skip —— 静默跳过的集成测试等于没有测试。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@dajia/core': alias('./packages/core/src/index.ts'),
      '@dajia/protocol': alias('./packages/protocol/src/index.ts'),
      '@dajia/scene-2d': alias('./packages/scene-2d/src/index.ts'),
    },
  },
  test: {
    include: ['apps/desktop/test/db/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
```

`vitest.config.ts` 只动 include 那一行：

```ts
    include: ['packages/*/test/**/*.test.ts', 'scripts/test/**/*.test.mjs', 'apps/desktop/test/unit/**/*.test.ts'],
```

`apps/desktop/tsconfig.test.json`

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["node"]
  },
  "include": ["test", "src/main", "src/preload"]
}
```

`apps/desktop/package.json` 的 `typecheck` 改成：

```jsonc
"typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.test.json"
```

根 `package.json` 的 `scripts` 加：

```jsonc
"test:db": "vitest run --config vitest.db.config.ts",
"db:sql": "node scripts/db-sql.mjs"
```

`scripts/db-sql.mjs` 本任务先建**最小版**（打印迁移目录不存在的提示并 exit 2），T2 才补成正真把内联 SQL 打到 stdout 的版本 —— 现在写空壳是为了让 `pnpm db:sql` 这个 token 一进 `package.json` 就有归属，不留"脚本在、文件不在"的两天窗口期：

```js
// T1 占位：迁移 SQL 在 Task 2 落地（见计划 4 的 P-11）。
// 现在就把 `db:sql` 挂进 package.json 是为了让它有人认领，别让 CI 之外的第二条通路裸奔。
process.stderr.write('db:sql 还没有迁移文件可导出（计划 4 Task 2 落地它）\n');
process.exit(2);
```

- [ ] **Step 6: 写连接参数读取 + 只读普查（这一步第一次连库）**

`apps/desktop/src/main/db/env.ts`

```ts
import { assertDatabaseName, type AllowedDatabase } from './db-safety';

export interface MysqlEnv {
  host: string;
  port: number;
  user: string;
  password: string;
  database: AllowedDatabase;
}

const NAMES = ['DAJIA_MYSQL_HOST', 'DAJIA_MYSQL_PORT', 'DAJIA_MYSQL_USER', 'DAJIA_MYSQL_PASSWORD', 'DAJIA_MYSQL_DATABASE'] as const;

/**
 * 连接参数只从环境变量读，**不落任何进仓文件**（含测试代码与本计划文本）。
 * 缺就点名抛 —— 这一条不是风格：`test:db` 若允许"没配就跳过"，那 CI 与任何干净机器上
 * 全部 repository 用例都是绿的假象，而这批用例存在的理由正是"真 MySQL，不 mock"（spec §10）。
 */
export function readMysqlEnv(env: NodeJS.ProcessEnv = process.env): MysqlEnv {
  const missing = NAMES.filter((n) => env[n] === undefined || env[n] === '');
  if (missing.length > 0) {
    throw new RangeError(
      `缺 MySQL 环境变量：${missing.join(', ')}。` +
        `连库测试不许静默跳过 —— 配齐了再跑 pnpm test:db（口令取自本机 MySQL 配置，别写进仓库）`,
    );
  }
  const port = Number(env.DAJIA_MYSQL_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new RangeError(`DAJIA_MYSQL_PORT 必须是 1–65535 的整数，收到 ${JSON.stringify(env.DAJIA_MYSQL_PORT)}`);
  }
  return {
    host: env.DAJIA_MYSQL_HOST as string,
    port,
    user: env.DAJIA_MYSQL_USER as string,
    password: env.DAJIA_MYSQL_PASSWORD as string,
    database: assertDatabaseName(env.DAJIA_MYSQL_DATABASE),
  };
}
```

`apps/desktop/test/db/env.test.ts`

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from 'mysql2/promise';
import { readMysqlEnv } from '../../src/main/db/env';
import { assertDatabaseName } from '../../src/main/db/db-safety';

/**
 * 只读普查：把 spec §12 的环境事实从"2026-09-25 那次手敲的备忘"变成会红的断言。
 * 本任务**不建库、不建表、不写一行**——建库排在 Task 2（授权的第一次落地），
 * 所以这里连的是实例本身（`database` 只用来核对白名单，不进 SQL）。
 */
let close: () => Promise<void> = async () => {};

beforeAll(async () => {
  const env = readMysqlEnv();
  const pool = createPool({ ...env, connectionLimit: 1 });
  close = () => pool.end();
  (globalThis as { __pool?: typeof pool }).__pool = pool;
});

afterAll(async () => {
  await close();
});

describe('MySQL 环境事实（spec §12 的凭据化）', () => {
  it('服务端参数与 spec §12 记的逐字一致（改了就红，别把设计建在飘的地上）', async () => {
    const pool = (globalThis as { __pool?: never }).__pool;
    if (!pool) throw new TypeError('普查用的池没建起来');
    const [rows] = await pool.query(
      "SELECT VERSION() AS v, @@character_set_server AS cs, @@collation_server AS col, " +
        '@@lower_case_table_names AS lctn, @@max_connections AS maxc',
    );
    const got = (rows as Record<string, string>[])[0];
    if (!got) throw new TypeError('SELECT 没回行');
    expect(got.cs).toBe('utf8mb4');
    expect(got.col).toBe('utf8mb4_0900_ai_ci');
    // 生成列与 id 列的 collation 都要跟着这个口径走（混着 JOIN 会报 Illegal mix of collations）
    expect(got.lctn).toBe('1');
    expect(Number(got.maxc)).toBeGreaterThanOrEqual(151);
    expect(got.v.split('.')[0]).toBe('8');
    process.stdout.write(`[census] version=${got.v} max_connections=${got.maxc}\n`);
  });

  it('库名白名单先过，连接参数里的 database 也在名单里', () => {
    const env = readMysqlEnv();
    expect(assertDatabaseName(env.database)).toBe(env.database);
  });

  it('缺任何一个变量就抛，且文案点名叫哪个（不许变成 skip）', () => {
    const base = {
      DAJIA_MYSQL_HOST: '127.0.0.1',
      DAJIA_MYSQL_PORT: '3306',
      DAJIA_MYSQL_USER: 'u',
      DAJIA_MYSQL_PASSWORD: 'p',
      DAJIA_MYSQL_DATABASE: 'dajia_test',
    };
    for (const name of Object.keys(base)) {
      const env = { ...base } as Record<string, string>;
      delete env[name];
      expect(() => readMysqlEnv(env)).toThrow(new RegExp(name));
    }
    expect(() => readMysqlEnv({ ...base, DAJIA_MYSQL_PORT: '0' })).toThrow(/DAJIA_MYSQL_PORT/);
    expect(() => readMysqlEnv({ ...base, DAJIA_MYSQL_DATABASE: 'smartscrm' })).toThrow(/不是搭家的库/);
  });
});
```

- [ ] **Step 7: 跑两条通道，确认切分成立**

```bash
pnpm test > tmp/plan4-t1-test.log 2>&1; echo "test exit=$?"
pnpm test:db > tmp/plan4-t1-testdb.log 2>&1; echo "test:db exit=$?"
```

Expected（两个都是判据，不许只看第一个）：
1. `pnpm test` **exit=0**，且 `db-safety.test.ts` 那 4 条在内 —— 它 import 的是 `../../src/main/db/**`，说明 electron-free 这条路（P-2）能走。
2. `pnpm test:db` 在没配环境变量时 **exit≠0**，日志里有「缺 MySQL 环境变量：DAJIA_MYSQL_HOST, …」那一句。**这就是本任务想要的红**。
3. 配上环境变量再跑一次 `pnpm test:db` ⇒ exit=0 / 3 条，并把日志里 `[census] version=… max_connections=…` 那行原样抄进执行回填（**这就是本仓库第一次连 MySQL，注意它只读**）。

- [ ] **Step 8: 全量 verify + 依赖守卫**

```bash
pnpm verify > tmp/plan4-t1-verify.log 2>&1; echo "verify exit=$?"
node scripts/check-package-deps.mjs
```

Expected: `verify exit=0`；`Test Files` 从 **35** 涨到 **37**（`+apps/desktop/test/unit/db-safety.test.ts` 与 `packages/protocol` 那 1 文件不变 —— 若这里只涨 1，说明 include 那行没吃到新目录）；`Tests` 从 **509** 涨到 **513**。`lint:deps` 必须照旧静默（`zod`/`mysql2` 是 npm 依赖，不是 `@dajia/*` 边）。

- [ ] **Step 9: 提交（代码棒只提交 src 与 test 与配置，`docs/` 归控制位）**

```bash
git status --porcelain
git diff --stat
git add package.json pnpm-lock.yaml pnpm-workspace.yaml vitest.config.ts vitest.db.config.ts \
  packages/protocol/package.json apps/desktop/package.json apps/desktop/tsconfig.test.json \
  apps/desktop/src/main/db apps/desktop/test scripts/db-sql.mjs
git commit -m "$(cat <<'EOF'
feat(plan4): 依赖接入与测试双通道 + 库名护栏

- zod / mysql2 落位（protocol 与 desktop 各一处），两个 vitest config 切开
  连库与不连库（P-1/P-2）：test 进 CI，test:db 只归本地控制位
- assertDatabaseName 白名单把「只许建 dajia 与 dajia_test」那句授权写成代码，
  建连接之前先抛；smartscrm 那一类必须红
- readMysqlEnv 缺变量点名抛，不 skip —— 静默跳过等于没有集成测试
- spec §12 的环境事实第一次变成会红的断言（只读普查，零写入）
EOF
)"
```

**Task 1 的改坏验证**（变异棒另开，规则同前：cp 备份 + md5 还原，全程无 git）：

| # | 改坏 | 预期 |
|---|---|---|
| T1-M1 | `ALLOWED_DATABASES` 里删掉 `'dajia'` | `db-safety.test.ts` 第一条红（`toEqual` 名单不等）+ env.test.ts 里 `dajia` 那一发红 —— 两处同源，一次改坏两格 |
| T1-M2 | `assertDatabaseName` 开头加 `if (typeof value === 'string') return value as AllowedDatabase;`（把白名单退化成"是字符串就放行"） | 「别人的库一律抛」与「大小写/后缀注入」两条同时红 |
| T1-M3 | `readMysqlEnv` 里把 `throw` 换成 `return` 一份默认参数（模拟"没配也能跑"） | 第三条红（`toThrow(new RegExp(name))` 全灭），且 `pnpm test:db` 会变成"连一个谁也没授权的库"—— 这正是 M3 要被抓住的理由 |

---

## Task 2: 迁移 runner（`_migration` 表 + 六张表 + 自建自清）

**Files:**
- Create: `apps/desktop/src/main/db/pool.ts`
- Create: `apps/desktop/src/main/db/migrations.ts`
- Create: `apps/desktop/src/main/db/migrate.ts`
- Create: `apps/desktop/test/db/migrate.test.ts`
- Create: `apps/desktop/test/unit/migrations.test.ts`
- Modify: `scripts/db-sql.mjs`（占位 → 真导出）
- Modify: `apps/desktop/src/main/index.ts`（**只加注释一处**，指向新目录；不动五段分支）

**Interfaces:**
- Consumes: `assertDatabaseName`（T1）、`readMysqlEnv`（T1）
- Produces:
  - `createDbPool(env: MysqlEnv, opts?: { multipleStatements?: boolean; connectionLimit?: number }): Pool`（`interface PoolOptions` 一并导出；命名带 `Db` 是为了不和 `mysql2/promise` 自己的 `createPool` 撞名 —— 同一个模块里两个都要 import）
  - `MIGRATIONS: readonly Migration[]`，`interface Migration { version: number; name: string; sql: string; checksum: string }`
  - `migrate(pool: Pool, database: string, migrations?: readonly Migration[]): Promise<{ applied: number[]; alreadyApplied: number[] }>`
  - `ensureDatabase(env: MysqlEnv, database: string): Promise<void>`（建库，先过白名单）
  - `dropTestDatabase(env: MysqlEnv, database: string): Promise<void>`（自建自清的另一半；**名字不等于 `dajia_test` 就抛**，`dajia` 也挡）
  - `SCHEMA_TABLE = '_migration'`

- [ ] **Step 1: 先写"迁移文件本身"的静态测试（不连库，CI 有牙）**

`apps/desktop/test/unit/migrations.test.ts`

```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/main/db/migrations';

/**
 * 这一档不连库，专挑"进 SQL 文件里最容易漂、又只有跑起来才发现"的三件事：
 * 版本序连续、校验和与文本自洽、每张表都带 utf8mb4 与 IF NOT EXISTS（P-11 的可重放前提）。
 */
describe('迁移清单的结构', () => {
  it('版本从 1 开始连续、名字唯一', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    const names = MIGRATIONS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('checksum 是正文的 sha256（改过已应用的迁移必须在 runner 之前就被发现）', () => {
    for (const m of MIGRATIONS) {
      const computed = createHash('sha256').update(m.sql, 'utf8').digest('hex');
      expect(m.checksum, `迁移 ${m.version} ${m.name} 的校验和与正文不符`).toBe(computed);
    }
  });

  it('001 建齐 spec §8.1 点名的六张表，且每张都 IF NOT EXISTS + utf8mb4', () => {
    const first = MIGRATIONS[0];
    if (!first) throw new TypeError('没有 001 迁移');
    for (const table of ['project', 'storey', 'element', 'command_log', 'snapshot', 'asset']) {
      const re = new RegExp(`CREATE TABLE IF NOT EXISTS \`${table}\`[\\s\\S]*?DEFAULT CHARSET=utf8mb4`, 'm');
      expect(first.sql, `表 ${table} 没建成 IF NOT EXISTS + utf8mb4 的形状`).toMatch(re);
    }
    // 生成列（spec §8.1 的 kind / loadBearing）必须写在 payload 上而不是复制列 —— P-8 的落点
    expect(first.sql).toMatch(/kind VARCHAR\(\d+\) GENERATED ALWAYS AS[\s\S]*STORED/);
    expect(first.sql).toMatch(/load_bearing .*GENERATED ALWAYS AS[\s\S]*STORED/);
  });

  it('全仓不许出现第二个库名以外的 CREATE/DROP DATABASE（护栏唯一产地）', () => {
    for (const m of MIGRATIONS) {
      expect(m.sql).not.toMatch(/CREATE DATABASE|DROP DATABASE/i);
    }
  });
});
```

Run: `npx vitest run apps/desktop/test/unit/migrations.test.ts`
Expected: FAIL —— 找不到 `../../src/main/db/migrations`。

- [ ] **Step 2: 写 `001_init.sql` 的正文（内联为常量，理由见 P-11）**

`apps/desktop/src/main/db/migrations.ts`

```ts
import { createHash } from 'node:crypto';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

function at(version: number, name: string, sql: string): Migration {
  return { version, name, sql, checksum: createHash('sha256').update(sql, 'utf8').digest('hex') };
}

/**
 * id 列一律 ascii/ascii_bin：服务端默认是 utf8mb4_0900_ai_ci（spec §12 实测），
 * 而 uuid 串是 ascii —— 两种 collation 混着 JOIN 会报 Illegal mix of collations，
 * 且 utf8mb4 的 CHAR(36) 索引宽度是 ascii 的四倍。生成列跟着同一个口径。
 */
const ID = 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin';

const V001 = `
CREATE TABLE IF NOT EXISTS \`_migration\` (
  \`version\` INT NOT NULL PRIMARY KEY,
  \`name\` VARCHAR(100) NOT NULL,
  \`checksum\` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`applied_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS \`project\` (
  \`id\` ${ID} NOT NULL PRIMARY KEY,
  \`schema_version\` INT NOT NULL,
  \`name\` VARCHAR(200) NOT NULL,
  \`unit\` VARCHAR(16) NOT NULL DEFAULT 'mm',
  -- P-5/P-6：turn 是幂等键的坐标系，seq 只保证单调。
  \`journal_turn\` BIGINT NOT NULL DEFAULT 0,
  -- P-4：过期判定全交给服务端 NOW(3)，客户端只报 TTL。
  \`lock_token\` ${ID} NULL,
  \`lock_owner\` VARCHAR(200) NULL,
  \`lock_expires_at\` DATETIME(3) NULL,
  -- spec §9「启动时若发现未合并片段走恢复流程」的信号位：开工程置 0，干净收尾置 1。
  \`clean_shutdown\` TINYINT(1) NOT NULL DEFAULT 1,
  \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS \`element\` (
  \`id\` ${ID} NOT NULL PRIMARY KEY,
  \`project_id\` ${ID} NOT NULL,
  -- storey 实体没有 storeyId（它自己就是层），所以这里可空。
  \`storey_id\` ${ID} NULL,
  \`kind\` VARCHAR(16) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(\`payload\`, '$.kind'))) STORED
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- MySQL 对 JSON 布尔取出来的是 'true'/'false' 串，CAST 成数字会得到 0 —— 必须显式 CASE。
  \`load_bearing\` INT GENERATED ALWAYS AS (
    CASE JSON_EXTRACT(\`payload\`, '$.loadBearing')
      WHEN CAST('true' AS JSON) THEN 1
      WHEN CAST('false' AS JSON) THEN 0
      ELSE NULL
    END) STORED,
  \`payload\` JSON NOT NULL,
  \`updated_seq\` BIGINT NOT NULL DEFAULT 0,
  KEY \`idx_project\` (\`project_id\`),
  KEY \`idx_storey_kind\` (\`storey_id\`, \`kind\`),
  KEY \`idx_project_loadbearing\` (\`project_id\`, \`load_bearing\`),
  CONSTRAINT \`fk_element_project\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- spec §8.1 点名的表，但它是 element 里 storey 行的投影（P-7）：同一事务内由 repository 写。
CREATE TABLE IF NOT EXISTS \`storey\` (
  \`id\` ${ID} NOT NULL PRIMARY KEY,
  \`project_id\` ${ID} NOT NULL,
  \`index_no\` INT NOT NULL,
  \`elevation_mm\` BIGINT NOT NULL,
  \`height_mm\` BIGINT NOT NULL,
  KEY \`idx_project_index\` (\`project_id\`, \`index_no\`),
  CONSTRAINT \`fk_storey_project\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS \`command_log\` (
  \`seq\` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  \`project_id\` ${ID} NOT NULL,
  \`turn\` BIGINT NOT NULL,
  \`actor\` VARCHAR(64) NOT NULL,
  \`payload\` JSON NOT NULL,
  \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY \`uk_project_turn\` (\`project_id\`, \`turn\`),
  KEY \`idx_project_seq\` (\`project_id\`, \`seq\`),
  CONSTRAINT \`fk_log_project\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS \`snapshot\` (
  \`seq\` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  \`project_id\` ${ID} NOT NULL,
  \`journal_turn\` BIGINT NOT NULL,
  \`schema_version\` INT NOT NULL,
  \`payload\` JSON NOT NULL,
  \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY \`uk_project_turn\` (\`project_id\`, \`journal_turn\`),
  KEY \`idx_project_seq\` (\`project_id\`, \`seq\`),
  CONSTRAINT \`fk_snapshot_project\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- spec §8.1 的描图底图（M1.8 那一档才读写）。本计划只建表，读写路径登记在交接表里（代价见 P-8 同段）。
CREATE TABLE IF NOT EXISTS \`asset\` (
  \`id\` ${ID} NOT NULL PRIMARY KEY,
  \`project_id\` ${ID} NOT NULL,
  \`kind\` VARCHAR(32) NOT NULL,
  \`path\` VARCHAR(500) NULL,
  \`blob\` LONGBLOB NULL,
  \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY \`idx_project_kind\` (\`project_id\`, \`kind\`),
  CONSTRAINT \`fk_asset_project\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

export const MIGRATIONS: readonly Migration[] = [at(1, 'init', V001)];
```

> **执行时若 `CREATE TABLE IF NOT EXISTS \`_migration\`` 的引号/转义形态与实测不符，以实测为准**（上面这块的反引号是在模板字符串里写的，`node -e` 打印出来核一遍再落文件）。SQL 正文一旦提交进 git 就**永远不许改**：改它等于改历史，校验和会在 runner 之前先炸（这是 Step 1 那条 checksum 测试的全部意义）。要改结构就加 002。

- [ ] **Step 3: `pool.ts` 与 `migrate.ts`**

`apps/desktop/src/main/db/pool.ts`

```ts
import { createPool } from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';
import type { MysqlEnv } from './env';

export interface PoolOptions {
  /**
   * 只在迁移连接上开：一个 `.sql` 版本里是多条 DDL，逐条发要把分词器交给 JS 再写一遍。
   * **业务连接永远不开** —— 打开它等于给任何一处字符串拼接留出多语句的通道，
   * 而本计划唯一的"库名进 SQL"的地方（ensureDatabase / dropTestDatabase）靠白名单挡，不靠这个。
   */
  readonly multipleStatements?: boolean;
  readonly connectionLimit?: number;
}

export function createDbPool(env: MysqlEnv, opts: PoolOptions = {}): Pool {
  return createPool({
    host: env.host,
    port: env.port,
    user: env.user,
    password: env.password,
    database: env.database,
    waitForConnections: true,
    connectionLimit: opts.connectionLimit ?? 4,
    charset: 'utf8mb4',
    multipleStatements: opts.multipleStatements ?? false,
    // 日期一律按 DATETIME(3) 原样读回；时区口径交给服务端（P-4），客户端不参与换算。
    dateStrings: true,
    namedPlaceholders: false,
  });
}
```

`apps/desktop/src/main/db/migrate.ts`

```ts
import type { Pool } from 'mysql2/promise';
import { assertDatabaseName } from './db-safety';
import { MIGRATIONS, type Migration } from './migrations';

export const SCHEMA_TABLE = '_migration';

interface AppliedRow {
  version: number;
  checksum: string;
}

async function readApplied(pool: Pool): Promise<Map<number, AppliedRow>> {
  const [rows] = await pool.query(
    `SELECT \`version\`, \`checksum\` FROM \`${SCHEMA_TABLE}\` ORDER BY \`version\``,
  );
  const out = new Map<number, AppliedRow>();
  for (const r of rows as AppliedRow[]) out.set(r.version, r);
  return out;
}

/**
 * 顺序应用，一次一条版本。三条形状要说清：
 * ① **MySQL 的 DDL 隐式提交** ⇒ 一个版本内多条语句失败时不可回滚，前几条的表已经留下。
 *    可重放性因此全靠 DDL 写成 `IF NOT EXISTS`（Step 1 有一条测试专门钉它），
 *    以及"版本没记进 `_migration` 就重来一遍"这个形状。这不是缺陷，是 MySQL 的语义，
 *    照它设计比假装它能回滚要诚实。
 * ② 已应用的版本若校验和对不上 ⇒ 抛，**不修**。有人改了历史 SQL，必须人来决定。
 * ③ 库名先过白名单再动任何东西。
 */
export async function migrate(
  pool: Pool,
  database: string,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<{ applied: number[]; alreadyApplied: number[] }> {
  assertDatabaseName(database);
  const applied: number[] = [];
  const alreadyApplied: number[] = [];
  const seen = await readApplied(pool);
  for (const m of migrations) {
    const row = seen.get(m.version);
    if (row) {
      if (row.checksum !== m.checksum) {
        throw new RangeError(
          `迁移 ${m.version}（${m.name}）的正文被改过：库里记的校验和是 ${row.checksum}，` +
            `现在这份是 ${m.checksum}。历史迁移不许改，请新开一个版本。`,
        );
      }
      alreadyApplied.push(m.version);
      continue;
    }
    await pool.query(m.sql);
    await pool.query(
      `INSERT INTO \`${SCHEMA_TABLE}\` (\`version\`, \`name\`, \`checksum\`) VALUES (?, ?, ?)`,
      [m.version, m.name, m.checksum],
    );
    applied.push(m.version);
  }
  return { applied, alreadyApplied };
}
```

> **`pool.query` 里带 `?` 的那条必须用 `execute` 还是 `query`？** mysql2 的 `query` 会在客户端把参数插进串里（`dateStrings`、缓冲行为都与此有关），`execute` 走服务端预处理 —— **本 Step 落地时实测一次并写明选型与理由**（两种都能挡住这里的内容，选一个别换第二遍；`migrations` 的 SQL 正文永远不许进参数位）。

- [ ] **Step 4: 建库与删库（本计划第一次真正行使授权）**

`apps/desktop/src/main/db/database.ts`（与 `migrate.ts` 同批落地，Step 5 的夹具要用）

```ts
import { createPool } from 'mysql2/promise';
import type { MysqlEnv } from './env';
import { assertDatabaseName } from './db-safety';

/** 连"实例"而不是"库"：建库时目标库还不存在，不能把它写进连接参数。 */
async function withServer(env: MysqlEnv, fn: (pool: ReturnType<typeof createPool>) => Promise<void>): Promise<void> {
  const pool = createPool({ host: env.host, port: env.port, user: env.user, password: env.password });
  try {
    await fn(pool);
  } finally {
    await pool.end();
  }
}

/**
 * `CREATE DATABASE` / `DROP DATABASE` 不能参数化，名字是唯一的通路 ⇒
 * 白名单必须在这里，且**只在这里**：调用方再谨慎也不如被调方不许接受别的名字。
 * 排序规则照 spec §12 实测的服务端默认，别在这儿发明第二套。
 */
export async function ensureDatabase(env: MysqlEnv, database: string): Promise<void> {
  const name = assertDatabaseName(database);
  await withServer(env, async (pool) => {
    await pool.query(
      `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
  });
}

/** 自建自清的另一半（spec §10 对 `dajia_test` 的要求）。`dajia` 走这里会被白名单挡在 SQL 之前。 */
export async function dropTestDatabase(env: MysqlEnv, database: string): Promise<void> {
  const name = assertDatabaseName(database);
  if (name !== 'dajia_test') {
    throw new RangeError(`dropTestDatabase 只许删 dajia_test，收到 ${JSON.stringify(name)}`);
  }
  await withServer(env, async (pool) => {
    await pool.query(`DROP DATABASE IF EXISTS \`${name}\``);
  });
}
```

> **`assertDatabaseName` 在 `ensureDatabase` 里调用两次（这里与 `migrate` 各一次）是有意的**：`migrate` 的调用方不一定经过 `ensureDatabase`。这条重复不许"顺手合并成一处"—— 护栏的强度来自每个入口都过一遍。

- [ ] **Step 5: 连库的迁移测试（自建自清，真 MySQL，无 mock）**

`apps/desktop/test/db/migrate.test.ts`

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { createDbPool } from '../../src/main/db/pool';
import { readMysqlEnv } from '../../src/main/db/env';
import { dropTestDatabase, ensureDatabase } from '../../src/main/db/database';
import { SCHEMA_TABLE, migrate } from '../../src/main/db/migrate';
import { MIGRATIONS, type Migration } from '../../src/main/db/migrations';

const env = readMysqlEnv();
const database = 'dajia_test';
let pool: Pool;

beforeAll(async () => {
  await dropTestDatabase(env, database);
  await ensureDatabase(env, database);
  pool = createDbPool({ ...env, database }, { multipleStatements: true });
});

afterEach(async () => {
  // 每个用例之间清一次表，顺序照外键方向（element 与 storey 引用 project）。
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of ['_migration', 'asset', 'snapshot', 'command_log', 'element', 'storey', 'project']) {
    await pool.query(`DROP TABLE IF EXISTS \`${t}\``);
  }
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');
});

afterAll(async () => {
  await pool.end();
  await dropTestDatabase(env, database);
});

describe('迁移 runner', () => {
  it('空库上跑一次建齐六张表，再跑一次是整批 no-op（幂等）', async () => {
    const first = await migrate(pool, database);
    expect(first.applied).toEqual([1]);
    expect(first.alreadyApplied).toEqual([]);
    const second = await migrate(pool, database);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual([1]);

    const [rows] = await pool.query('SHOW TABLES');
    const tables = (rows as Record<string, string>[]).map((r) => Object.values(r)[0]).sort();
    expect(tables).toEqual(['_migration', 'asset', 'command_log', 'element', 'project', 'snapshot', 'storey'].sort());
  });

  it('_migration 记下版本、名字与校验和', async () => {
    await migrate(pool, database);
    const [rows] = await pool.query(`SELECT \`version\`, \`name\`, \`checksum\` FROM \`${SCHEMA_TABLE}\``);
    const got = (rows as { version: number; name: string; checksum: string }[])[0];
    expect(got?.version).toBe(1);
    expect(got?.name).toBe('init');
    expect(got?.checksum).toBe(MIGRATIONS[0]?.checksum);
  });

  it('改过已应用的迁移 ⇒ 抛，且不碰库里已有的表', async () => {
    await migrate(pool, database);
    const tampered: Migration[] = [{ ...MIGRATIONS[0]!, checksum: 'f'.repeat(64) }];
    await expect(migrate(pool, database, tampered)).rejects.toThrow(/被改过/);
  });

  it('坏迁移停在半途：前一版本留下、坏版本不记账，重放能修好（DDL 隐式提交照 P-11 的形状兜住）', async () => {
    const broken: Migration[] = [
      MIGRATIONS[0]!,
      { version: 2, name: 'broken', sql: 'SELECT 1; CREATE TABLE `needs_missing_ref` (`id` CHAR(1) NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB; ALTER TABLE `needs_missing_ref` ADD CONSTRAINT `fk_x` FOREIGN KEY (`id`) REFERENCES `no_such_table` (`id`);', checksum: '0'.repeat(64) },
    ];
    await migrate(pool, database, [MIGRATIONS[0]!]);
    await expect(migrate(pool, database, broken)).rejects.toThrow();
    const [rows] = await pool.query('SHOW TABLES');
    const tables = (rows as Record<string, string>[]).map((r) => Object.values(r)[0]);
    expect(tables).not.toContain('needs_missing_ref');
    // 版本 2 没被记账 ⇒ 换成正确的一份可以正常补上
    const [log] = await pool.query(`SELECT version FROM \`${SCHEMA_TABLE}\` ORDER BY version`);
    expect((log as { version: number }[]).map((r) => r.version)).toEqual([1]);
    const fixed: Migration[] = [MIGRATIONS[0]!, { version: 2, name: 'ok', sql: 'CREATE TABLE IF NOT EXISTS `late_add` (`id` CHAR(1) NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;', checksum: '1'.repeat(64) }];
    const out = await migrate(pool, database, fixed);
    expect(out.applied).toEqual([2]);
  });

  it('库名不在白名单 ⇒ 在任何 SQL 之前抛（这条红得比连不上库还早）', async () => {
    await expect(migrate(pool, 'smartscrm')).rejects.toThrow(/不是搭家的库/);
    await expect(dropTestDatabase(env, 'smartscrm')).rejects.toThrow(/不是搭家的库/);
    await expect(ensureDatabase(env, 'ledger_db')).rejects.toThrow(/不是搭家的库/);
  });

  it('生成列真在算：kind 抽出、loadBearing 对 JSON 布尔给 1/0、非墙给 NULL', async () => {
    await migrate(pool, database);
    await pool.query(`INSERT INTO \`project\` (\`id\`, \`schema_version\`, \`name\`) VALUES ('01991c00-0000-7000-8000-000000000000', 1, '生成列探针')`);
    const insert = (id: string, payload: string) =>
      pool.query(
        `INSERT INTO \`element\` (\`id\`, \`project_id\`, \`storey_id\`, \`payload\`) VALUES (?, ?, ?, ?)`,
        [id, '01991c00-0000-7000-8000-000000000000', '01991c00-0000-7000-8000-000000000001', payload],
      );
    await insert('01991c00-0000-7000-8000-0000000000a1', JSON.stringify({ kind: 'wall', loadBearing: true }));
    await insert('01991c00-0000-7000-8000-0000000000a2', JSON.stringify({ kind: 'wall', loadBearing: false }));
    await insert('01991c00-0000-7000-8000-0000000000a3', JSON.stringify({ kind: 'point' }));
    const [rows] = await pool.query(
      'SELECT id, kind, load_bearing FROM `element` WHERE project_id = ? ORDER BY id',
      ['01991c00-0000-7000-8000-000000000000'],
    );
    const got = rows as { id: string; kind: string; load_bearing: number | null }[];
    expect(got.map((r) => [r.kind, r.load_bearing])).toEqual([
      ['wall', 1],
      ['wall', 0],
      ['point', null],
    ]);
    // 生成列存在的唯一理由（spec §8.1：S5 要 SQL 聚合）—— 这一发必须走索引，不许退化成全表 JSON 解析
    const [explain] = await pool.query(
      'EXPLAIN SELECT id FROM `element` WHERE project_id = ? AND load_bearing = 1',
      ['01991c00-0000-7000-8000-000000000000'],
    );
    const plan = (explain as Record<string, string>[])[0];
    expect(plan?.key).toBe('idx_project_loadbearing');
  });
});
```

> 上面那个探针用的 `id` 是**手写的合法 UUIDv7 形状**（时间戳段固定、版本位 `7`、变体位 `8`）。`isEntityId` 只认形状，所以它能进库；但这类 id 只出现在这一格探针里，业务读写一律 `uuidv7()` 现造。

Run: `npx vitest run --config vitest.db.config.ts apps/desktop/test/db/migrate.test.ts` → Expected: PASS（6 条）。
再跑 `npx vitest run apps/desktop/test/unit/migrations.test.ts` → Expected: PASS（4 条）。

- [ ] **Step 6: `pnpm db:sql` 把内联 SQL 还原成 .sql（P-11 的缓解措施）**

`scripts/db-sql.mjs`

```js
// 把内联的迁移正文按版本打到 stdout，给"没装 mysql CLI、但要手敲 SQL"的运维通路（P-11 的代价缓解）。
// 用法：pnpm db:sql            全打
//       pnpm db:sql 2         只打第 2 版
// 它**只读** MIGRATIONS 常量，不碰数据库 —— 别把它当成"执行迁移"的另一个入口。
import { MIGRATIONS } from '../apps/desktop/src/main/db/migrations.ts';
```

> 这行 import 在裸 node 下能不能跑，**本 Step 实测**（本仓已知：core 的无扩展名相对导入裸 `node --experimental-strip-types` 解析不到）。两条出路选一条并在执行回填写清：① `pnpm db:sql` 走 `vitest` 之外的 bundler（esbuild 在 pnpm store 里，路径见 memory 那条一次性脚本的坑）；② 把 `migrations.ts` 的正文另存一份 `.sql` 到 `apps/desktop/src/main/db/migrations/` 目录，`db:sql` 只读那份并**用测试钉住两份逐字节相同**（这条更硬，因为它把重复变成了判据）。**默认按 ② 写**，因为 P-11 的完整说法是"内联为真、散文件为镜像、由测试保证一致"。

- [ ] **Step 7: 全量 verify + test:db + 提交**

```bash
pnpm verify > tmp/plan4-t2-verify.log 2>&1; echo "verify exit=$?"
pnpm test:db > tmp/plan4-t2-testdb.log 2>&1; echo "test:db exit=$?"
```

Expected: `verify exit=0`，`Test Files` **37 → `<待实测>`**、`Tests` **513 → `<待实测>`**（本任务净增：`migrations.test.ts` 4 条 + `migrations/` 镜像一致性那条；`test/db` 不进这里）；`pnpm test:db` exit=0，条数 = `<待实测>`（`env.test.ts` 3 + `migrate.test.ts` 6 起步）。**跑完必须确认 `dajia_test` 已被 afterAll 删掉**：

```bash
node -e "const{createPool}=require('mysql2/promise');(async()=>{const p=createPool({host:process.env.DAJIA_MYSQL_HOST,port:+process.env.DAJIA_MYSQL_PORT,user:process.env.DAJIA_MYSQL_USER,password:process.env.DAJIA_MYSQL_PASSWORD});const[r]=await p.query('SHOW DATABASES');console.log(r.map(x=>Object.values(x)[0]).join(' '));await p.end();})()"
```

Expected: 输出的库名列表里**没有** `dajia_test`（也没有 `dajia` —— 它归 T11 的闸门在 `DAJIA_MYSQL_DATABASE=dajia` 时才建），且其余 14 个用户库一个不少。这一发是"自建自清"唯一的凭据，不许省。

```bash
git status --porcelain && git diff --cached --stat
git add apps/desktop/src/main/db apps/desktop/test scripts/db-sql.mjs package.json
git commit -m "$(cat <<'EOF'
feat(plan4): 迁移 runner 与六张表（授权的第一次落地）

- _migration 记版本+校验和，改过已应用的迁移在 runner 之前先炸
- DDL 隐式提交不可回滚 ⇒ IF NOT EXISTS + 未记账即重放 的形状由测试钉住
- 建库/删库只有白名单这一条通路，smartscrm 那一类在 SQL 之前就抛
- 生成列 kind / load_bearing 实测走 idx_project_loadbearing（spec §8.1 建它的理由）
- 长度列按 P-8 不建，理由写在裁决里
EOF
)"
```

**Task 2 的改坏验证**（变异棒，cp 备份 + md5 还原）：

| # | 改坏 | 预期 |
|---|---|---|
| T2-M1 | `migrate` 里删掉校验和比对那段 | 「改过已应用的迁移 ⇒ 抛」红（`rejects.toThrow` 拿不到抛） |
| T2-M2 | `load_bearing` 生成列改成 `CAST(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.loadBearing')) AS UNSIGNED)` | 生成列那一格红：`['wall', 1]` 变 `['wall', 0]`（MySQL 把 'true' CAST 成 0）。**这就是注释里那条主张的凭据，也是它为什么值一发变异** |
| T2-M3 | `ensureDatabase` 里把 `assertDatabaseName` 删掉（名字直接进串） | 「库名不在白名单」那条红；同时 `_migration` 探针之后 `migrate(pool, 'smartscrm')` 仍会抛 —— 两条抛点各自独立，这一发改的就是"入口重复是有意的"那条纪律 |
| T2-M4 | 001 里 `storey` 表的 `IF NOT EXISTS` 去掉 | 结构测试（`migrations.test.ts` 第三条）当场红，且不连库就能红 —— 这一发证明静态那一档真在守着可重放性 |

---
## Task 3: zod 边界与读盘不变式（`assertTruthSourceInvariants`）

**Files:**
- Create: `packages/protocol/src/entity-schema.ts`
- Create: `packages/protocol/src/command-type.ts`
- Modify: `packages/protocol/src/index.ts`（两行 `export *`）
- Create: `packages/protocol/test/entity-schema.test.ts`
- Create: `packages/protocol/test/command-type.test.ts`
- Create: `packages/core/src/model/invariants.ts`
- Modify: `packages/core/src/model/document.ts`（`INTEGER_FIELDS` 由私有改导出；`validate` 本体一字不动）
- Modify: `packages/core/src/index.ts`（导出 `INTEGER_FIELDS` 与 `invariants` 的两个符号）
- Modify: `packages/core/src/commands/storey.ts`（删模块私有 `assertNoVerticalOverlap`，改 import 共享版；**报错文案逐字不动**，现有用例吃它）
- Create: `packages/core/test/invariants.test.ts`

**Interfaces:**
- Consumes: T1 的 zod 依赖已进 `@dajia/protocol`；`Document.entities`（`ReadonlyMap<EntityId, Entity>`，公开字段）、`read.ts` 的 `mustExist/requireWall/requirePoint/requireStorey`、`geom/axis.ts` 的 `wallAxis`、`geom/ring.ts` 的 `assertSimpleRing(label, points)`、`geom/outline.ts` 的 `deriveStoreyGeometry(doc, storeyId)`、`geom/vec.ts` 的 `vec(x, y)`
- Produces:
  - `EntityIdSchema`、`MmSchema`、`PointSchema` / `WallSchema` / `OpeningSchema` / `StoreySchema` / `ColumnSchema` / `SlabSchema`、`EntitySchema`（`discriminatedUnion('kind', …)`）、`PatchSchema`、`JournalTurnSchema`，以及 `type EntityShape = z.output<typeof EntitySchema>`
  - `COMMAND_TYPES: readonly string[]`（16 条）与 `CommandTypeSchema`
  - `assertTruthSourceInvariants(doc: Document): void` —— **T5 的 `loadProject`（快照解出来那一份 + 重放完的最终态）唯一的放行证**；写路径不跑它，理由见 T4 第 ③ 段
  - `assertNoVerticalOverlap(doc: Document, candidate: StoreyEntity): void`（从 `commands/storey.ts` 提上来，共享版）

**为什么这一层分两头，且中间隔着一道依赖墙**：`protocol` 不许 import `core`（`ALLOWED_DEPS.protocol = []`，`scripts/check-package-deps.mjs` 在 CI 里执行），所以 zod 的 shape 与 core 的 interface 一定是**两份文本**。这个计划不接受"两份靠人记得同步"：本任务的第七条与第五条用例把这两份文本按正则钉在一起，改一边就红。钉不住的那一半（行为）用注入非法值的行为用例兜 —— 于是"新增字段忘了登记 schema"、"schema 登记了但 core 没有"、"字段有但没走整数校验"三型各有各自的牙。

**读盘检查器为什么放在 `core` 而不是 desktop**：它检查的是真源不变式，规则与命令层同源；放 desktop 就是第三条依赖边上再造一套判据。代价：`core` 的 `model/` 第一次 import `geom/`（`model/invariants.ts` → `geom/outline.ts`）。核过没有回环：`geom/**` 只 import `model/{document,patch,read}`，没有一个 import `model/invariants` 或 `commands/**`，且 `invariants` 只在函数体里用派生（模块初始化期不碰），ESM 循环在初始化期才致命。

- [ ] **Step 1: 先写 protocol 的失败用例**

`packages/protocol/test/entity-schema.test.ts`

```ts
// 这一格是"两份文本"的裁判，不是普通单测：protocol 不许 import core（D2b），
// 所以 zod shape 与 core 的 interface 一定是两份，同步只能靠读源码文本对账。
// 读源码不算 import：check-package-deps 只认 `@dajia/...` 说明符，这里是 node:fs + 相对路径。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ColumnSchema,
  EntitySchema,
  INTEGER_FIELDS_SHAPE,
  OpeningSchema,
  PatchSchema,
  PointSchema,
  SlabSchema,
  StoreySchema,
  UUID_RE_TEXT,
  WallSchema,
} from '../src/entity-schema';

const entitySrc = readFileSync(
  new URL('../../core/src/model/entity.ts', import.meta.url),
  'utf8',
);
const idsSrc = readFileSync(new URL('../../core/src/ids.ts', import.meta.url), 'utf8');
const documentSrc = readFileSync(
  new URL('../../core/src/model/document.ts', import.meta.url),
  'utf8',
);
const wallSrc = readFileSync(
  new URL('../../core/src/commands/wall.ts', import.meta.url),
  'utf8',
);

/** 抠 `export interface PointEntity { … }` 花括号里的字段名（注释行以 `/**` 或 ` *` 起头，不匹配）。 */
function coreFields(name: string): string[] {
  const block = entitySrc.match(
    new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`),
  );
  if (block === null) throw new Error(`core 的 interface ${name} 没抠到 —— entity.ts 结构变了`);
  return [...block[1].matchAll(/^ {2}(?:readonly )?(\w+)\??:/gm)].map((m) => m[1]).sort();
}

/** 抠 `const INTEGER_FIELDS: Record<EntityKind, readonly string[]> = { … }` 里的表，返回 `{ point: ['x','y'], … }`。 */
function parseFieldTable(body: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of body.matchAll(/(\w+): \[([^\]]*)\]/g)) {
    out[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map((f) => f[1]);
  }
  if (Object.keys(out).length !== 6) throw new Error(`INTEGER_FIELDS 抠到 ${String(Object.keys(out).length)} 类，应有 6 类`);
  return out;
}

// 六枚固定 id：测试里不许现调 uuidv7()（同毫秒不单调，失败样本就不可复现）。
const A = '0193aa00-0000-7000-8000-000000000001';
const B = '0193bb00-0000-7000-8000-000000000002';
const C = '0193cc00-0000-7000-8000-000000000003';
const D = '0193dd00-0000-7000-8000-000000000004';
const E = '0193ee00-0000-7000-8000-000000000005';

const POINT_OK = { kind: 'point', id: A, storeyId: B, x: 0, y: 0 };
const WALL_OK = { kind: 'wall', id: A, storeyId: B, startId: C, endId: D, thicknessMm: 240, heightMm: 3000, elevationOffsetMm: 0, loadBearing: true, material: 'brick' };
const OPENING_OK = { kind: 'opening', id: A, storeyId: B, hostWallId: C, distanceMm: 1000, widthMm: 900, heightMm: 2100, sillMm: 0, category: 'door' };
const STOREY_OK = { kind: 'storey', id: A, projectId: B, index: 0, elevationMm: 0, heightMm: 3000 };
const COLUMN_OK = { kind: 'column', id: A, storeyId: B, pointId: C, widthMm: 400, depthMm: 400, heightMm: 3000, loadBearing: true, material: 'concrete' };
const SLAB_OK = { kind: 'slab', id: A, storeyId: B, boundaryPointIds: [C, D, E], thicknessMm: 120, elevationOffsetMm: 0 };
/** `kind → 合法样例`，整数毫米循环那一格按 `INTEGER_FIELDS_SHAPE` 的键取它。 */
const VALID_BY_KIND: Record<string, Readonly<Record<string, unknown>>> = {
  point: POINT_OK, wall: WALL_OK, opening: OPENING_OK, storey: STOREY_OK, column: COLUMN_OK, slab: SLAB_OK,
};

describe('实体 schema ↔ core 真源对账', () => {
  // `.shape` 六个调用点全部写开：`pairs` 那种数组形状会让 TS 拿到一个 ZodObject 联合类型，
  // 联合的 `safeParse` 与 `shape` 在 strict 下不可同时调用（"每个成员都有签名，但互不兼容"）。
  it('六类实体的键集合逐字等于 core 的 interface 字段，且合法样例过 zod', () => {
    expect(Object.keys(PointSchema.shape).sort()).toEqual(coreFields('PointEntity'));
    expect(Object.keys(WallSchema.shape).sort()).toEqual(coreFields('WallEntity'));
    expect(Object.keys(OpeningSchema.shape).sort()).toEqual(coreFields('OpeningEntity'));
    expect(Object.keys(StoreySchema.shape).sort()).toEqual(coreFields('StoreyEntity'));
    expect(Object.keys(ColumnSchema.shape).sort()).toEqual(coreFields('ColumnEntity'));
    expect(Object.keys(SlabSchema.shape).sort()).toEqual(coreFields('SlabEntity'));
    for (const ok of [POINT_OK, WALL_OK, OPENING_OK, STOREY_OK, COLUMN_OK, SLAB_OK]) {
      expect(EntitySchema.safeParse(ok).success).toBe(true);
    }
  });

  it('.strict() 拒多余字段：计划 2 转下游 #5 那一型（{x, y, pointId: undefined}）进不来', () => {
    const r = PointSchema.safeParse({ ...POINT_OK, pointId: undefined });
    expect(r.success).toBe(false);
    // 只有"多余键被拒"才算过：把 strictObject 换成 object 时这里是 true（S5 的 foot-gun 复活）。
    // 第二发钉的是"派生值不许混进真源"：lengthMm 是派生量，压根不是实体字段。
    const w = WallSchema.safeParse({ ...WALL_OK, lengthMm: 4000 });
    expect(w.success).toBe(false);
  });

  it('整数毫米：INTEGER_FIELDS 里每个字段填 1.5 与 -0 都被拒，原值都通过', () => {
    // 表本身也钉住：core 的 INTEGER_FIELDS 源码文本 ↔ protocol 侧那份（改一边就红，见 T3-M4）
    const coreTable = documentSrc.match(/const INTEGER_FIELDS[^=]*=\s*\{([\s\S]*?)\n\};/);
    if (coreTable === null) throw new Error('core 的 INTEGER_FIELDS 没抠到');
    expect(INTEGER_FIELDS_SHAPE).toEqual(parseFieldTable(coreTable[1]));
    for (const kind of Object.keys(INTEGER_FIELDS_SHAPE)) {
      const base = VALID_BY_KIND[kind];
      if (base === undefined) throw new Error(`VALID_BY_KIND 缺 ${kind}：表加了类，样例没跟上`);
      for (const field of INTEGER_FIELDS_SHAPE[kind] ?? []) {
        expect(EntitySchema.safeParse({ ...base, [field]: 1.5 }).success).toBe(false);
        expect(EntitySchema.safeParse({ ...base, [field]: -0 }).success).toBe(false);
        expect(EntitySchema.safeParse(base).success).toBe(true);
      }
    }
  });

  it('UUIDv7 正则与 core 的 V7_RE 逐字符相同（两份文本必须一起改）', () => {
    const core = idsSrc.match(/const V7_RE = \/(.*)\/;/);
    if (core === null) throw new Error('core 的 V7_RE 没抠到');
    expect(UUID_RE_TEXT).toBe(core[1]);
  });

  it('material 的 32 字上界与空串/首尾空白规则同 core 的 assertMaterial 一处产地', () => {
    const max = wallSrc.match(/不能超过 (\d+) 字符/);
    if (max === null) throw new Error('core 的 assertMaterial 字数上界没抠到');
    expect(WallSchema.safeParse({ ...WALL_OK, material: 'x'.repeat(Number(max[1]) + 1) }).success).toBe(false);
    expect(WallSchema.safeParse({ ...WALL_OK, material: '' }).success).toBe(false);
    expect(WallSchema.safeParse({ ...WALL_OK, material: ' brick' }).success).toBe(false);
  });

  it('category 只认 door / window，kind 未知即拒', () => {
    expect(OpeningSchema.safeParse({ ...OPENING_OK, category: 'window ' }).success).toBe(false);
    expect(EntitySchema.safeParse({ kind: 'furniture', id: A }).success).toBe(false);
  });

  it('PatchSchema 收得下纯数据补丁，收不下坏实体（这是 command_log 的落库单位）', () => {
    expect(PatchSchema.safeParse({ upsert: [POINT_OK], remove: [] }).success).toBe(true);
    expect(PatchSchema.safeParse({ upsert: [{ kind: 'wall' }], remove: [] }).success).toBe(false);
    expect(PatchSchema.safeParse({ upsert: [POINT_OK], remove: ['not-a-uuid'] }).success).toBe(false);
    // 数组里的 kind 判别也认：discriminatedUnion 对"合法形状但未知 kind"必须拒，不是放行
    expect(PatchSchema.safeParse({ upsert: [{ ...POINT_OK, kind: 'beam' }], remove: [] }).success).toBe(false);
  });
});
```

> 三处口径写给实现者：① 六枚 id 必须是**固定字面量**（上面给的 A…E 已核过是合法 UUIDv7 形状：第 13 位是 `7`、第 17 位在 `89ab` 内），测试里不许现调 `uuidv7()` —— 同毫秒不单调，失败样本就不可复现（这条纪律在 `scene-2d` 的 `handles.test.ts` 里已经立过一次）。② 两个抠源码的 helper（`coreFields` / `parseFieldTable`）抠不到一律**抛**，不许返回空数组让 `toEqual` 悄悄过 —— 空对空也是一次绿，而它证明的是"正则没命中"。③ `INTEGER_FIELDS_SHAPE` 的键序与 core 那张表一致（`point/wall/opening/storey/column/slab`），`toEqual` 比的是对象内容不是键序，所以真正咬住的是"六类各有哪些字段"。

- [ ] **Step 2: 写 `entity-schema.ts` 与 `command-type.ts` 让它过**

`packages/protocol/src/entity-schema.ts`

```ts
import { z } from 'zod';

/**
 * 边界层唯一的整数毫米判据。用 `z.number().refine` 而不是 `z.int()`：
 * `Number.isSafeInteger` 一句同时管住"整数"与"范围"，而 zod 4 小版本里 `z.int()` 与
 * `z.number().int()` 的形态有出入 —— 少一处 API 面就少一处打包后才发现的实测风险。
 * 三条判据一条都不许省：`-0` 那条是计划 2 转下游 #5 的收口点，`Document.validate` 放行它
 * （`Number.isInteger(-0)` 为 true），只有这里拒。
 */
export const MmSchema = z
  .number()
  .refine((v) => Number.isSafeInteger(v), '必须是安全整数毫米')
  .refine((v) => !Object.is(v, -0), '不接受 -0：真源里的零不许带符号');

/**
 * 与 core `ids.ts` 的 `V7_RE` 逐字符相同的一份。为什么有两份：D2b 不许 core import protocol，
 * 边界校验又必须在 protocol 里 —— 于是这条规则只能复制，靠测试钉死（改一边就红）。
 */
const UUID_V7_TEXT = '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

export const EntityIdSchema = z.string().regex(new RegExp(UUID_V7_TEXT), 'id 必须是 UUIDv7');

/** 给对账测试用：源码文本口径，别拿它做运行时判断。 */
export const UUID_RE_TEXT = UUID_V7_TEXT;

/** 材料名：空串、首尾空白、超长三条与 core 的 `assertMaterial` 同一条口径（那边是产地，这里是边界复刻，第 5 格钉字数上界）。 */
const MaterialSchema = z
  .string()
  .min(1, '材料不能为空')
  .refine((v) => v === v.trim(), '材料不能带首尾空白')
  .max(32, '材料不能超过 32 个字符');

const Kind = <K extends string>(k: K) => z.literal(k);

export const PointSchema = z.strictObject({
  kind: Kind('point'),
  id: EntityIdSchema,
  storeyId: EntityIdSchema,
  x: MmSchema,
  y: MmSchema,
});

export const WallSchema = z.strictObject({
  kind: Kind('wall'),
  id: EntityIdSchema,
  storeyId: EntityIdSchema,
  startId: EntityIdSchema,
  endId: EntityIdSchema,
  thicknessMm: MmSchema,
  heightMm: MmSchema,
  elevationOffsetMm: MmSchema,
  loadBearing: z.boolean(),
  material: MaterialSchema,
});

export const OpeningSchema = z.strictObject({
  kind: Kind('opening'),
  id: EntityIdSchema,
  storeyId: EntityIdSchema,
  hostWallId: EntityIdSchema,
  distanceMm: MmSchema,
  widthMm: MmSchema,
  heightMm: MmSchema,
  sillMm: MmSchema,
  category: z.enum(['door', 'window']),
});

export const StoreySchema = z.strictObject({
  kind: Kind('storey'),
  id: EntityIdSchema,
  projectId: EntityIdSchema,
  index: z.number().refine((v) => Number.isSafeInteger(v) && v >= 0, '楼层序号必须为非负整数'),
  elevationMm: MmSchema,
  heightMm: MmSchema,
});

export const ColumnSchema = z.strictObject({
  kind: Kind('column'),
  id: EntityIdSchema,
  storeyId: EntityIdSchema,
  pointId: EntityIdSchema,
  widthMm: MmSchema,
  depthMm: MmSchema,
  heightMm: MmSchema,
  loadBearing: z.boolean(),
  material: MaterialSchema,
});

export const SlabSchema = z.strictObject({
  kind: Kind('slab'),
  id: EntityIdSchema,
  storeyId: EntityIdSchema,
  // 下界 3 只是**形状**下界（数组长度）。几何退化（共线、自交）由 core 的 assertSimpleRing 判 ——
  // 三道 4 点共线的边界数据在这里过、在 loadProject 那一步抛，这是分工不是漏判。
  boundaryPointIds: z.array(EntityIdSchema).min(3, '楼板边界至少 3 个顶点'),
  thicknessMm: MmSchema,
  elevationOffsetMm: MmSchema,
});

export const EntitySchema = z.discriminatedUnion('kind', [
  PointSchema,
  WallSchema,
  OpeningSchema,
  StoreySchema,
  ColumnSchema,
  SlabSchema,
]);

export type EntityShape = z.output<typeof EntitySchema>;

/** 落库的写路径单位。core 的 `Patch` 是纯数据，所以这一格没有转换层。 */
export const PatchSchema = z.strictObject({
  upsert: z.array(EntitySchema),
  remove: z.array(EntityIdSchema),
});

/** 幂等键：客户端分配的单调计数（P-6）。非负安全整数，别的都不收。 */
export const JournalTurnSchema = z
  .number()
  .refine((v) => Number.isSafeInteger(v) && v >= 0, 'journal turn 必须为非负安全整数');

/**
 * 与 core `document.ts` 的 `INTEGER_FIELDS` 同一张表的一份副本（同 UUID 正则的理由：依赖方向不许反）。
 * 它同时是本包测试的循环表，不是给运行时用的装饰 —— 导出的唯一理由是测试。
 */
export const INTEGER_FIELDS_SHAPE: Record<string, readonly string[]> = {
  point: ['x', 'y'],
  wall: ['thicknessMm', 'heightMm', 'elevationOffsetMm'],
  opening: ['distanceMm', 'widthMm', 'heightMm', 'sillMm'],
  storey: ['elevationMm', 'heightMm'],
  column: ['widthMm', 'depthMm', 'heightMm'],
  slab: ['thicknessMm', 'elevationOffsetMm'],
};
```

`packages/protocol/src/command-type.ts`

```ts
import { z } from 'zod';

/**
 * 与 core `model/command.ts` 的 `CommandType` 并排的另一半（同一族"两份文本 + 测试钉死"，
 * 理由见 entity-schema.ts 顶部）。落库的 `command_log.type` 只认这 16 条。
 */
export const COMMAND_TYPES = [
  'storey.create',
  'storey.setElevation',
  'storey.delete',
  'wall.create',
  'wall.moveEndpoint',
  'wall.setThickness',
  'wall.setMaterial',
  'wall.setLoadBearing',
  'wall.delete',
  'opening.create',
  'opening.move',
  'opening.delete',
  'column.create',
  'column.delete',
  'slab.create',
  'slab.delete',
] as const;

export const CommandTypeSchema = z.enum(COMMAND_TYPES);
```

`packages/protocol/src/index.ts` 末尾追加：

```ts
export * from './entity-schema';
export * from './command-type';
```

> 追加前先看这个 index 现在长什么样（今天只有 `PROTOCOL_PACKAGE` 与 `./ipc` 两行）：`export *` 遇同名会**编译期**炸，所以 `UUID_RE_TEXT`、`INTEGER_FIELDS_SHAPE` 这类新符号必须先 grep 确认没撞名。撞了就改新符号名，不许改旧符号（旧符号有闸门与既有测试吃）。

`packages/protocol/test/command-type.test.ts`

```ts
// CommandType 在 core，这半边在 protocol，同一族"两份文本 + 测试钉死"。
// 落库那一侧（T4 的 codec）拿 CommandTypeSchema 校验 command_log.type：这里漏一条，
// 库里就多一种没人认识的 type；core 加了新命令而这里没登记，加载时 zod 直接把整个工程拒了 ——
// 后者是更坏的失败方式，所以这一格的红必须发生在提交前，而不是发生在用户按下"打开工程"时。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMAND_TYPES, CommandTypeSchema } from '../src/command-type';

const commandSrc = readFileSync(
  new URL('../../core/src/model/command.ts', import.meta.url),
  'utf8',
);

describe('COMMAND_TYPES ↔ core CommandType', () => {
  it('16 条命令类型逐字相同（顺序不比对，集合比对）', () => {
    const block = commandSrc.match(/export type CommandType =([\s\S]*?);/);
    if (block === null) throw new Error('core 的 CommandType 没抠到 —— command.ts 结构变了');
    const coreTypes = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect([...COMMAND_TYPES].sort()).toEqual(coreTypes);
    expect(coreTypes.length).toBe(16);
  });

  it('CommandTypeSchema 收 16 条、拒未知（含大小写与首尾空白各一发）', () => {
    for (const t of COMMAND_TYPES) expect(CommandTypeSchema.safeParse(t).success).toBe(true);
    expect(CommandTypeSchema.safeParse('wall.Create').success).toBe(false);
    expect(CommandTypeSchema.safeParse(' wall.create').success).toBe(false);
    expect(CommandTypeSchema.safeParse(undefined).success).toBe(false);
  });
});
```

- [ ] **Step 3: 跑 protocol 的两格对账**

```bash
npx vitest run packages/protocol > tmp/plan4-t3-protocol.log 2>&1; echo "exit=$?"
# 数条数时先剥 ANSI（计划 3 的 T8 教训：命令替换里不剥，`grep -E "^ +Tests "` 一条都匹配不上）：
sed 's/\x1b\[[0-9;]*m//g' tmp/plan4-t3-protocol.log | grep -E "^ *(Test Files|Tests) "
```

Expected: 先红（第 1 步写完时 `../src/entity-schema` 不存在 → 整个文件解析失败）后绿；`packages/protocol` 从 **1 文件 3 条** 变成 **3 文件 `<待实测>` 条**（新增 2 文件，本任务给 7 + 2 条）。

- [ ] **Step 4: 写 core 的失败用例**

`packages/core/test/invariants.test.ts`

```ts
// 这一族用例全部走 `handBuild(...)`：命令层造不出这些坏文档（守卫就在命令里），
// 而读盘检查器的职责正是"库里/手搓出来的坏文档不许上屏"。造它只有一条合法通路 ——
// Document.replaceEntities（它 validate id 形状与整数毫米，但对引用完整性与 -0 全盲）。
// 第 6 格专门证这句"全盲"：-0 能进文档，所以必须在这里拦。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  assertTruthSourceInvariants,
  Document,
  storeyCreate,
  TransactionLog,
  wallCreate,
  type Entity,
  type EntityId,
  type PointEntity,
  type SlabEntity,
  type StoreyEntity,
  type WallEntity,
} from '../src/index';
```

夹具（全部写在测试文件里，id 用固定字面量、不现调 `uuidv7()`，否则失败样本不可复现）：

```ts
const ID = {
  project: '0193aa00-0000-7000-8000-000000000001',
  lower: '0193aa00-0000-7000-8000-000000000002',
  upper: '0193aa00-0000-7000-8000-000000000003',
  otherProject: '0193aa00-0000-7000-8000-000000000004',
  pa: '0193aa00-0000-7000-8000-000000000005',
  pb: '0193aa00-0000-7000-8000-000000000006',
  pc: '0193aa00-0000-7000-8000-000000000007',
  pd: '0193aa00-0000-7000-8000-00000000000c',
  wall: '0193aa00-0000-7000-8000-000000000008',
  opening: '0193aa00-0000-7000-8000-000000000009',
  column: '0193aa00-0000-7000-8000-00000000000a',
  slab: '0193aa00-0000-7000-8000-00000000000b',
} satisfies Record<string, EntityId>;

const storeyAt = (id: EntityId, elevationMm: number, heightMm: number, index = 0, projectId: EntityId = ID.project): StoreyEntity =>
  ({ kind: 'storey', id, projectId, index, elevationMm, heightMm });
const pointAt = (id: EntityId, storeyId: EntityId, x: number, y: number): PointEntity =>
  ({ kind: 'point', id, storeyId, x, y });
const wallAt = (storeyId: EntityId, startId: EntityId, endId: EntityId, thicknessMm: number): WallEntity =>
  ({ kind: 'wall', id: ID.wall, storeyId, startId, endId, thicknessMm, heightMm: 3000, elevationOffsetMm: 0, loadBearing: true, material: 'brick' });
const slabOf = (ids: readonly EntityId[], storeyId: EntityId = ID.lower): SlabEntity =>
  ({ kind: 'slab', id: ID.slab, storeyId, boundaryPointIds: [...ids], thicknessMm: 120, elevationOffsetMm: 0 });

/** 最小正例宿主：一层 + 不共线三点（板退化那一格在它上面换顶点坐标）。 */
const HOSTS: Entity[] = [
  storeyAt(ID.lower, 0, 3000),
  pointAt(ID.pa, ID.lower, 0, 0),
  pointAt(ID.pb, ID.lower, 4000, 0),
  pointAt(ID.pc, ID.lower, 0, 4000),
];
const HOSTS_WITH_WALL: Entity[] = [...HOSTS, wallAt(ID.lower, ID.pa, ID.pb, 240)];

/** 下界表：`[带坏字段的实体, 期望消息里出现的字段名]`。逐条循环断言，别写成一串 if。
 *  每条都叠在 `HOSTS_WITH_WALL` 上（同 id 覆盖同号），于是"坏的那一格"永远是唯一变量。 */
const BELOW_ONE: readonly [Entity, string][] = [
  [wallAt(ID.lower, ID.pa, ID.pb, 0), 'thicknessMm'],
  [{ ...wallAt(ID.lower, ID.pa, ID.pb, 240), heightMm: 0 }, 'heightMm'],
  [{ kind: 'opening', id: ID.opening, storeyId: ID.lower, hostWallId: ID.wall, distanceMm: 1000, widthMm: 0, heightMm: 2100, sillMm: 0, category: 'door' }, 'widthMm'],
  [{ kind: 'opening', id: ID.opening, storeyId: ID.lower, hostWallId: ID.wall, distanceMm: 1000, widthMm: 900, heightMm: 0, sillMm: 0, category: 'window' }, 'heightMm'],
  [{ kind: 'column', id: ID.column, storeyId: ID.lower, pointId: ID.pc, widthMm: 0, depthMm: 400, heightMm: 3000, loadBearing: true, material: 'concrete' }, 'widthMm'],
  [{ kind: 'column', id: ID.column, storeyId: ID.lower, pointId: ID.pc, widthMm: 400, depthMm: 400, heightMm: 0, loadBearing: true, material: 'concrete' }, 'heightMm'],
  [{ ...slabOf([ID.pa, ID.pb, ID.pc]), thicknessMm: 0 }, 'thicknessMm'],
  [storeyAt(ID.lower, 0, 0), 'heightMm'],
];

function handBuild(entities: readonly Entity[]): Document {
  const map = new Map<EntityId, Entity>();
  for (const e of entities) map.set(e.id, e);
  return Document.replaceEntities(Document.create(ID.project), map);
}

describe('assertTruthSourceInvariants：读盘放行证', () => {
  it('命令层造出的好文档一条都不抛（正例，防检查器过严把真项目全拒了）', () => {
    const log = new TransactionLog(Document.create(ID.project));
    log.dispatch(storeyCreate({ projectId: ID.project, index: 0, elevationMm: 0, heightMm: 3000 }));
    const storeyId = [...log.affected][0]!;
    log.dispatch(wallCreate({ storeyId, start: { x: 0, y: 0 }, end: { x: 4000, y: 0 }, thicknessMm: 240, heightMm: 3000 }));
    expect(() => assertTruthSourceInvariants(log.document)).not.toThrow();
  });

  it('零层文档合法：刚建工程还没画层时要能加载（命令层"最后一层不许删"是另一条规则，读盘侧不复制）', () => {
    expect(() => assertTruthSourceInvariants(Document.create(ID.project))).not.toThrow();
  });

  it('悬空引用：墙指着一枚不存在的点 ⇒ 抛，且消息里带着那枚 id', () => {
    const doc = handBuild([
      { kind: 'storey', id: ID.lower, projectId: ID.project, index: 0, elevationMm: 0, heightMm: 3000 },
      { kind: 'wall', id: ID.wall, storeyId: ID.lower, startId: ID.pa, endId: ID.pb, thicknessMm: 240, heightMm: 3000, elevationOffsetMm: 0, loadBearing: true, material: 'brick' },
    ]);
    expect(() => assertTruthSourceInvariants(doc)).toThrow(/不存在/);
    expect(() => assertTruthSourceInvariants(doc)).toThrow(new RegExp(ID.pa));
  });

  it('跨层引用：墙在一层、端点在另一层 ⇒ 抛（两层墙网凭空焊死那一型）', () => {
    const doc = handBuild([
      { kind: 'storey', id: ID.lower, projectId: ID.project, index: 0, elevationMm: 0, heightMm: 3000 },
      { kind: 'storey', id: ID.upper, projectId: ID.project, index: 1, elevationMm: 3000, heightMm: 3000 },
      { kind: 'point', id: ID.pa, storeyId: ID.upper, x: 0, y: 0 },
      { kind: 'point', id: ID.pb, storeyId: ID.upper, x: 4000, y: 0 },
      { kind: 'wall', id: ID.wall, storeyId: ID.lower, startId: ID.pa, endId: ID.pb, thicknessMm: 240, heightMm: 3000, elevationOffsetMm: 0, loadBearing: true, material: 'brick' },
    ]);
    expect(() => assertTruthSourceInvariants(doc)).toThrow(/不属于本层|同层/);
  });

  it('洞口与宿主不同层 ⇒ 抛；同层 ⇒ 不抛（区分"做了/没做"，两型各一发）', () => {
    const base = [
      { kind: 'storey', id: ID.lower, projectId: ID.project, index: 0, elevationMm: 0, heightMm: 3000 },
      { kind: 'storey', id: ID.upper, projectId: ID.project, index: 1, elevationMm: 3000, heightMm: 3000 },
      { kind: 'point', id: ID.pa, storeyId: ID.lower, x: 0, y: 0 },
      { kind: 'point', id: ID.pb, storeyId: ID.lower, x: 4000, y: 0 },
      { kind: 'wall', id: ID.wall, storeyId: ID.lower, startId: ID.pa, endId: ID.pb, thicknessMm: 240, heightMm: 3000, elevationOffsetMm: 0, loadBearing: true, material: 'brick' },
      { kind: 'opening', id: ID.opening, storeyId: ID.upper, hostWallId: ID.wall, distanceMm: 1000, widthMm: 900, heightMm: 2100, sillMm: 0, category: 'door' as const },
    ] satisfies Entity[];
    expect(() => assertTruthSourceInvariants(handBuild(base))).toThrow(/同层/);
    expect(() => assertTruthSourceInvariants(handBuild(base.map((e) => (e.kind === 'opening' ? { ...e, storeyId: ID.lower } : e))))).not.toThrow();
  });

  it('门必须 sillMm = 0，窗可以带台；负 sill 一律拒（下界与门规各一发）', () => {
    const openingAt = (sillMm: number, category: 'door' | 'window'): Entity =>
      ({ kind: 'opening', id: ID.opening, storeyId: ID.lower, hostWallId: ID.wall, distanceMm: 1000, widthMm: 900, heightMm: 2100, sillMm, category });
    expect(() => assertTruthSourceInvariants(handBuild([...HOSTS_WITH_WALL, openingAt(0, 'door')]))).not.toThrow();
    expect(() => assertTruthSourceInvariants(handBuild([...HOSTS_WITH_WALL, openingAt(100, 'door')]))).toThrow(/门/);
    expect(() => assertTruthSourceInvariants(handBuild([...HOSTS_WITH_WALL, openingAt(100, 'window')]))).not.toThrow();
    expect(() => assertTruthSourceInvariants(handBuild([...HOSTS_WITH_WALL, openingAt(-1, 'window')]))).toThrow(/sillMm/);
  });

  it('-0 进得了文档、进不了屏幕：`Document.validate` 放行它（Number.isInteger(-0) 为 true），本检查器拒 —— 这一格同时是"为什么必须有这里"的证据', () => {
    const doc = handBuild([...HOSTS, { ...wallAt(ID.lower, ID.pa, ID.pb, 240), thicknessMm: -0 }]);
    expect(doc.get(ID.wall)).toBeDefined(); // 文档本身造得出来：拦它不是 Document 的活
    expect(() => assertTruthSourceInvariants(doc)).toThrow(/-0/);
  });

  it('尺寸下界：墙厚 / 墙高 / 洞口宽高 / 柱三维 / 板厚 / 层高 < 1 全拒（一表循环，别写成一串 if）', () => {
    for (const [entity, field] of BELOW_ONE) {
      expect(() => assertTruthSourceInvariants(handBuild([...HOSTS_WITH_WALL, entity]))).toThrow(new RegExp(field));
    }
  });

  it('楼层竖向重叠 ⇒ 抛；正好贴邻与留空隙都不抛（半开区间那三条口径在读盘侧同样成立）', () => {
    expect(() => assertTruthSourceInvariants(handBuild([storeyAt(ID.lower, 0, 3000), storeyAt(ID.upper, 3000, 3000)]))).not.toThrow();
    expect(() => assertTruthSourceInvariants(handBuild([storeyAt(ID.lower, 0, 3000), storeyAt(ID.upper, 2000, 3000)]))).toThrow(/重叠/);
    // 空隙（错层）合法：这条不许被"必须贴邻"式的过严实现蒙过去
    expect(() => assertTruthSourceInvariants(handBuild([storeyAt(ID.lower, 0, 2000), storeyAt(ID.upper, 3000, 3000)]))).not.toThrow();
  });

  it('楼层 index 重复 / 负 index / 归属别的工程 ⇒ 三发各抛一处', () => {
    expect(() => assertTruthSourceInvariants(handBuild([storeyAt(ID.lower, 0, 3000, 0), storeyAt(ID.upper, 3000, 3000, 0)]))).toThrow(/index 重复/);
    expect(() => assertTruthSourceInvariants(handBuild([storeyAt(ID.lower, 0, 3000, -1)]))).toThrow(/index/);
    expect(() => assertTruthSourceInvariants(handBuild([storeyAt(ID.lower, 0, 3000, 0, ID.otherProject)]))).toThrow(/projectId|归属/);
  });

  it('板边界退化：三点不共线放行，三点共线与两点各抛一处（顶点数与共线一律走 assertSimpleRing，不在这里重算）', () => {
    expect(() => assertTruthSourceInvariants(handBuild([...HOSTS, slabOf([ID.pa, ID.pb, ID.pc])]))).not.toThrow();
    const collinear: Entity[] = [...HOSTS, pointAt(ID.pd, ID.lower, 2000, 0), slabOf([ID.pa, ID.pd, ID.pb])];
    expect(() => assertTruthSourceInvariants(handBuild(collinear))).toThrow(/顶点共线/);
    expect(() => assertTruthSourceInvariants(handBuild([...HOSTS, slabOf([ID.pa, ID.pb])]))).toThrow(/至少 3 个顶点/);
  });

  it('过了下界、引用也齐全，但派生炸的一型：洞口宽 5000 装在 4000 长的宿主墙上 ⇒ 只有末尾那遍逐层 deriveStoreyGeometry 拦得住', () => {
    // 这一格是"派生那一遍不是顺手多算一次几何"的唯一凭据：摘掉它（变异 T3-M7），
    // 四条显式检查一条都不会响，坏文档就放行到屏幕上了。
    const doc = handBuild([...HOSTS_WITH_WALL, { kind: 'opening', id: ID.opening, storeyId: ID.lower, hostWallId: ID.wall, distanceMm: 1000, widthMm: 5000, heightMm: 2100, sillMm: 100, category: 'window' as const }]);
    expect(() => assertTruthSourceInvariants(doc)).toThrow(/超出宿主墙/);
  });

  it('storey.ts 不许留第二份重叠规则：它必须 import 共享版，且本文件不含区间判定那几行', () => {
    const src = readFileSync(new URL('../src/commands/storey.ts', import.meta.url), 'utf8');
    expect(src).toContain("from '../model/invariants'");
    expect((src.match(/elevationMm \+ .*heightMm/g) ?? []).length).toBe(0);
  });
});
```

> 三处口径写给实现者：① 夹具全在上面写开了，`ID.*` 的十枚串都是合法 UUIDv7 形状（`Document.replaceEntities` 会 validate id，形状不对在造文档那一步就抛，用例红得没有信息量）。② `readFileSync` 那一格需要 `node:fs` 的 import，别漏 —— 少了它 typecheck 当场红（`apps/desktop` 的 `types: ["node"]` 从 base 继承，protocol 的 tsconfig 同样继承，`node:fs` 可直接用）。③ 断言里**不许**出现"面积"那个词：`geom/ring.ts` 顶部明写"故意不看面积"（180° 折回面积照样为正，挡不住），所以退化判据是顶点数 / 顶点互异 / 相邻三点共线 / 非相邻边相交四条，文案各归各的（`至少 3 个顶点`、`顶点共线`、`自交`、`有重复顶点`）。

- [ ] **Step 5: `document.ts` 交出 `INTEGER_FIELDS`，写 `invariants.ts`**

`packages/core/src/model/document.ts` 第 11 行：`const INTEGER_FIELDS` → `export const INTEGER_FIELDS`（其余一字不动：`validate` 仍然只查整数与 id 形状，**不许**把不变式塞进去 —— 那会让每一次 `dispatch` 都跑一遍几何派生，D4 的拖拽性能与"派生只在命令层复核"两条口径一起破）。

`packages/core/src/model/invariants.ts`

```ts
import type { EntityId } from '../ids';
import { assertSimpleRing } from '../geom/ring';
import { vec, type Vec2 } from '../geom/vec';
import { INTEGER_FIELDS, type Document } from './document';
import type { Entity, StoreyEntity } from './entity';
import { requirePoint, requireStorey, requireWall } from './read';

/**
 * 楼层竖向重叠：**这份是唯一的产地**。`commands/storey.ts` 的 create / setElevation 与
 * 读盘检查器共用它 —— 计划 2 交下来的原话是"两份规则一定会漂"。
 * 报错文案逐字保留（`commands/storey.ts` 的现有用例吃它），搬动时一个字符都不许改。
 */
export function assertNoVerticalOverlap(doc: Document, candidate: StoreyEntity): void {
  const top = candidate.elevationMm + candidate.heightMm;
  for (const other of doc.byKind('storey')) {
    if (other.id === candidate.id || other.projectId !== candidate.projectId) continue;
    const otherTop = other.elevationMm + other.heightMm;
    const from = Math.max(candidate.elevationMm, other.elevationMm);
    const to = Math.min(top, otherTop);
    if (from < to) {
      throw new RangeError(
        `楼层标高重叠：${candidate.id} 占 ${candidate.elevationMm}–${top}，` +
          `与楼层 ${other.id} 的 ${other.elevationMm}–${otherTop} 相交（区间按半开算，贴邻合法）`,
      );
    }
  }
}

function tag(entity: Entity): string {
  return `${entity.kind} ${entity.id}`;
}

/** 取整数毫米字段：`INTEGER_FIELDS` 是唯一表产地（document.ts），这里只读不另立名单。 */
function mm(entity: Entity, field: string): number {
  return (entity as unknown as Record<string, unknown>)[field] as number;
}

function assertNoNegativeZero(entity: Entity): void {
  for (const field of INTEGER_FIELDS[entity.kind]) {
    if (Object.is(mm(entity, field), -0)) {
      throw new TypeError(`${tag(entity)}.${field} 不接受 -0：真源里的零不许带符号`);
    }
  }
}

function assertAtLeastOne(entity: Entity, fields: readonly string[]): void {
  for (const field of fields) {
    const v = mm(entity, field);
    if (v < 1) throw new RangeError(`${tag(entity)}.${field} 必须 ≥ 1mm，收到 ${String(v)}`);
  }
}

/**
 * 引用完整性 + 同层 + 下界 + 门规 + 竖向不重叠 + `-0`：读盘侧的放行证。
 * **零层文档合法**（刚 createProject 还没画层），所以本函数不许要求"至少一层"——
 * 命令层那条"最后一层不许删"是 `storeyDelete` 的规则，不是数据规则，别在这里复制。
 * 几何退化（零长墙、墙厚不小于墙长、洞口超宿主、接头不闭合）不在这里重算：
 * 最后那一遍逐层 `deriveStoreyGeometry` 就是复用派生层那份唯一产地。
 */
export function assertTruthSourceInvariants(doc: Document): void {
  const seenIndex = new Set<string>();
  for (const storey of doc.byKind('storey')) {
    if (storey.projectId !== doc.projectId) {
      throw new TypeError(`楼层 ${storey.id} 的 projectId ${storey.projectId} 与文档 ${doc.projectId} 不一致：归属别的项目的数据不许混进来`);
    }
    if (!Number.isSafeInteger(storey.index) || storey.index < 0) {
      throw new RangeError(`楼层 ${storey.id} 的 index 必须为非负整数，收到 ${String(storey.index)}`);
    }
    const key = `${storey.projectId}:${storey.index}`;
    if (seenIndex.has(key)) throw new RangeError(`楼层 index 重复：${key}`);
    seenIndex.add(key);
    assertNoNegativeZero(storey);
    assertAtLeastOne(storey, ['heightMm']);
    assertNoVerticalOverlap(doc, storey);
  }

  for (const point of doc.byKind('point')) {
    assertNoNegativeZero(point);
    requireStorey(doc, point.storeyId); // 不存在即抛，消息带 id
  }

  for (const wall of doc.byKind('wall')) {
    assertNoNegativeZero(wall);
    assertAtLeastOne(wall, ['thicknessMm', 'heightMm']);
    const owner = requireStorey(doc, wall.storeyId);
    const start = requirePoint(doc, wall.startId, '墙起点');
    const end = requirePoint(doc, wall.endId, '墙终点');
    for (const p of [start, end]) {
      if (p.storeyId !== wall.storeyId) {
        throw new TypeError(
          `墙 ${wall.id} 属于楼层 ${owner.id}，端点 ${p.id} 属于楼层 ${p.storeyId}：跨层的端点会让两层墙网凭空焊死，同层判据不许放宽`,
        );
      }
    }
    if (start.x === end.x && start.y === end.y) {
      throw new RangeError(`零长墙：${wall.id} 两端点同为 (${start.x}, ${start.y})`);
    }
  }

  for (const opening of doc.byKind('opening')) {
    assertNoNegativeZero(opening);
    assertAtLeastOne(opening, ['widthMm', 'heightMm']);
    requireStorey(doc, opening.storeyId);
    const host = requireWall(doc, opening.hostWallId);
    if (host.storeyId !== opening.storeyId) {
      throw new TypeError(`洞口 ${opening.id} 在楼层 ${opening.storeyId}，宿主墙 ${host.id} 在楼层 ${host.storeyId}：洞口与宿主必须同层`);
    }
    if (mm(opening, 'distanceMm') < 0) throw new RangeError(`洞口 ${opening.id} 的 distanceMm 不能为负`);
    if (mm(opening, 'sillMm') < 0) throw new RangeError(`洞口 ${opening.id} 的 sillMm 不能为负`);
    if (opening.category === 'door' && mm(opening, 'sillMm') !== 0) {
      throw new RangeError(`门 ${opening.id} 的 sillMm 必须为 0，收到 ${String(mm(opening, 'sillMm'))}`);
    }
  }

  for (const column of doc.byKind('column')) {
    assertNoNegativeZero(column);
    assertAtLeastOne(column, ['widthMm', 'depthMm', 'heightMm']);
    requireStorey(doc, column.storeyId);
    const at = requirePoint(doc, column.pointId, '柱落点');
    if (at.storeyId !== column.storeyId) {
      throw new TypeError(`柱 ${column.id} 在楼层 ${column.storeyId}，落点 ${at.id} 在楼层 ${at.storeyId}：必须同层`);
    }
  }

  for (const slab of doc.byKind('slab')) {
    assertNoNegativeZero(slab);
    assertAtLeastOne(slab, ['thicknessMm']);
    requireStorey(doc, slab.storeyId);
    const ring: Vec2[] = slab.boundaryPointIds.map((id: EntityId) => {
      const p = requirePoint(doc, id, '楼板顶点');
      if (p.storeyId !== slab.storeyId) {
        throw new TypeError(`楼板 ${slab.id} 的顶点 ${id} 属于楼层 ${p.storeyId}：必须同层`);
      }
      return vec(p.x, p.y);
    });
    assertSimpleRing(`楼板 ${slab.id}`, ring); // 共线 / 自交 / 顶点数退化的唯一产地
  }

  // 最后一道：把派生层跑一遍。这一遍不是"顺手也算一次几何"，是**复用**已有的那套退化判据
  // （墙厚不小于墙长、洞口超出宿主、接头闭合），invariants 里一条都不重算。
  for (const storey of doc.byKind('storey')) {
    deriveStoreyGeometry(doc, storey.id);
  }
}
```

> 上面缺一行值导入：`import { deriveStoreyGeometry } from '../geom/outline';`。**必须值导入**（`verbatimModuleSyntax` 下 `import type` 会被擦掉，运行期 `ReferenceError` —— core 的 `patch.ts` 顶部注释写的正是这个坑）。

`packages/core/src/commands/storey.ts`：删掉第 16–36 行那份私有 `assertNoVerticalOverlap`（连注释一起搬进 `invariants.ts`，那段"贴邻合法、空隙合法、只有重叠不可能"的口径不许丢），改成 `import { assertNoVerticalOverlap } from '../model/invariants';`。

`packages/core/src/index.ts` 追加：

```ts
export { INTEGER_FIELDS } from './model/document';
export * from './model/invariants';
```

- [ ] **Step 6: 跑 core + protocol 全绿，再全量 verify**

```bash
npx vitest run packages/core packages/protocol > tmp/plan4-t3-focus.log 2>&1; echo "focus exit=$?"
pnpm verify > tmp/plan4-t3-verify.log 2>&1; echo "verify exit=$?"
```

Expected: `verify exit=0`；`Test Files` **37 → 40**（+2 protocol / +1 core），`Tests` **513 → `<待实测>`**（本任务 **+22** 条：protocol 7 + 2、core 13）。既有 `commands/storey.test.ts` 与 `storey` 相关用例**一条都不许改** —— 它们跟着搬迁走。

- [ ] **Step 7: 提交**

```bash
git status --porcelain && git diff --stat
git add packages/protocol packages/core
git commit -m "$(cat <<'EOF'
feat(plan4): zod 边界与读盘不变式（assertTruthSourceInvariants）

- protocol 与 core 两份文本（实体键集合 / V7 正则 / INTEGER_FIELDS / 命令类型表 / 材料上界）由正则对账钉死：依赖方向不许反，同步只能靠测试
- assertNoVerticalOverlap 从 commands/storey.ts 提到 model/invariants.ts，命令与读盘共用一份（计划 2 交下来的那条）
- 几何退化不在 invariants 里重算：最后一遍逐层跑 deriveStoreyGeometry，复用派生层唯一产地
- 零层文档合法：读盘侧不复制命令层"最后一层不许删"那条规则
EOF
)"
```

**Task 3 的改坏验证**（变异棒，cp 备份 + md5 还原）：

| # | 改坏 | 预期 |
|---|---|---|
| T3-M1 | `PointSchema` 的 `z.strictObject` → `z.object` | 「多余字段被拒」那一格当场红（第 2 格两条 `toBe(false)` 变 true） |
| T3-M2 | `UUID_V7_TEXT` 里 `7[0-9a-f]{3}` → `[0-9a-f]{4}` | 「V7 正则逐字符相同」红。这一格是"两份文本"这条纪律唯一的凭据 |
| T3-M3 | `PointSchema` 的 `x: MmSchema` → `x: z.number()` | 「填 1.5 与 -0 都被拒」那一格红（行为循环，不是文本对账 —— 两型各管一头） |
| T3-M4 | `INTEGER_FIELDS` 的 `point: ['x', 'y']` → `point: ['y']` | 「core 表 ↔ 本表」对账红（`toEqual` 逐字） |
| T3-M5 | `invariants.ts` 的 `assertAtLeastOne` 下界 `v < 1` → `v < 0` | 「尺寸下界」那一格红 —— 这一发证明那条循环表真在逐字段判 |
| T3-M6 | 把 `commands/storey.ts` 里那份私有规则原样抄回去（留着 import） | 「不许留第二份规则」那格红（`elevationMm + .*heightMm` 命中数 > 0）。**这一型只有静态账能抓**：两份实现行为相同，任何行为用例都过 |
| T3-M7 | 删掉 `invariants.ts` 末尾那句逐层 `deriveStoreyGeometry` | 「墙厚不小于墙长」那一型在读盘侧变成盲区 —— 需要一条"文档里手搓一面厚 5000 的 4000 长墙"的用例先补上，Step 4 的 `BELOW_ONE` 表里带一发这种"过了下界但派生炸"的样本，摘掉派生那一遍它就红 |


## Task 4: 编解码与写路径（`codec.ts` + `repository.ts`）

**Files:**
- Modify: `packages/protocol/src/entity-schema.ts`（加 `DocumentPayloadSchema` 与三个 `parse*` 出口；zod 只住在有它的那个包里，理由见下面第 ① 段）
- Create: `apps/desktop/test/unit/codec.test.ts`
- Create: `apps/desktop/test/unit/entity-shape.test.ts`
- Create: `apps/desktop/src/main/db/codec.ts`
- Modify: `apps/desktop/src/main/db/pool.ts`（P-17 的两条配置）
- Create: `apps/desktop/src/main/db/repository.ts`
- Create: `apps/desktop/test/db/repository.test.ts`

**Interfaces:**
- Consumes: T2 的 `createDbPool(env, opts)` / `migrate(pool, database)` / `ensureDatabase` / `dropTestDatabase`；T2 的 001 DDL（列名逐字：`journal_turn`、`clean_shutdown`、`updated_seq`、`uk_project_turn`、`storey.index_no`/`elevation_mm`/`height_mm`、`element.storey_id`/`kind`/`load_bearing`/`payload`）；T3 的 `EntitySchema` / `PatchSchema` / `JournalTurnSchema` / `EntityIdSchema` / `EntityShape`；core 的 `storeyCreate` / `storeyDelete` / `storeySetElevation` / `wallCreate` / `wallDelete` / `wallSetLoadBearing`（夹具全走真命令，不手搓实体）
- Produces:
  - protocol：`DocumentPayloadSchema`、`type DocumentPayloadShape`、`type PatchShape`、`parseEntityShape(where, value)`、`parsePatchShape(where, value)`、`parseDocumentPayload(where, value)`（三者都抛普通 `TypeError`，文案 = `${where} 解不出{实体|补丁|文档快照}：<issues>`）
  - codec：`type RowTable = 'element' | 'command_log' | 'snapshot'`、`interface RowRef { table: RowTable; id: string }`、`asJsonValue(raw)`、`encodeEntity` / `decodeEntity`、`encodePatch` / `decodePatch`、`encodeDocument` / `decodeDocument`
  - repository：`class ProjectRepository`，`constructor(pool: Pool, projectId: EntityId, actor: string)`，`createProject({ name, schemaVersion })`、`appendJournal(entry: JournalEntry): Promise<JournalOutcome>`、`writeSnapshot(turn, doc)`；`type JournalOutcome = 'applied' | 'already-applied'`；`interface JournalEntry { turn; patch; doc }`
  - P-17 落到 `PoolOptions`：`readonly lockWaitTimeoutSeconds?: number`（**唯一读者是 T4 的第 12 格**），外加 `supportBigNumbers: true` / `bigNumberStrings: false` 两条常开配置

**① 为什么 zod 的出口在 protocol 而不是 `codec.ts` 里**：`apps/desktop/package.json` 只有 `mysql2` 这一条新增 npm 依赖，**没有 `zod`**；pnpm 的严格 `node_modules` 把 `zod` 只放在 `packages/protocol/node_modules` 里，`codec.ts` 里 `import { z } from 'zod'` 会在 typecheck 当场解析不到。这不是障碍，是**正好的分工**：所有 zod 形状与"把 `ZodError` 收成一行文本"的逻辑留在 protocol（T3 已经在那里立了 schema 的唯一产地），`codec.ts` 只见普通数据与 `TypeError`。代价：protocol 多三个函数出口 —— 它们同时是 T8 那条 IPC 边界的校验入口（一份判据两个读者，比两个边界各写一份强）。

**② 为什么 `element` 与 `storey` 两张表都在这一发事务里写**：P-7 的 `storey` 是投影，双写的唯一防线是"同一事务 + 有读者的对账"。本任务给的读者是 `appendJournal` 里 remove 分支的 `affectedRows !== 1`（日志说要删的表上没有 ⇒ 抛）。**"storey 那一发被挪出事务"这一型本任务抓不到**（挪到 `commit()` 之后，失败路径根本走不到那一发；见变异表 M3 行末的登记），它的处置是 T5 的 `closeProject()` 做一次 `element`↔`storey` 逐行对账 —— 收尾时有读者，不是为测试存在的检查。

**③ 为什么写侧不跑 `assertTruthSourceInvariants`**：真源的守门在命令 `build` 与 `applyPatch` 那一步已经做完（core 的 `Document.replaceEntities` 管整数毫米与 id 形状，命令管引用与几何），写盘只负责**如实落**。读盘那一步必须自己验，因为字节可能来自别的版本、别的机器、别的写入者 —— 放行证在 T5 的 `loadProject` 上。多写一份"写时也验"就是第二个产地，且让每次保存多一遍逐层派生（O(实体数) × autosave 频率）。

- [ ] **Step 1: 先把盘上 JSON 的四件事实测掉（不许写完代码再猜）**

一次性探针，写进 SDD 工作区，**绝不落进仓库目录**：`.superpowers/sdd/2026-10-01-dajia-plan4-persistence/probe-json.mjs`

```js
// 盘上 JSON 与 BIGINT 的四件事，一次量完：
// A. mysql2 把 JSON 列回读成 object 还是 string（决定 codec.asJsonValue 哪条是主路）
// B. MySQL 的 JSON 存储是否把 -0 归一成 0（决定 codec 里那条 -0 用例经不经数据库）
// C. MySQL 是否重排键序（决定"往返逐字节相同"这句话的可执行形式）
// D. LONGLONG 在 supportBigNumbers 开/关两种配置下的读数（P-17 的全部依据）
// 只读探针：一条 INSERT 都没有，"第一次写库"仍然从 Task 2 起算。
import { createRequire } from 'node:module';

// pnpm 把 mysql2 只放在 apps/desktop/node_modules 里。用 import.meta.url 相对锚点解析，
// 不靠 cwd —— cwd 随"从哪个目录敲命令"变，那是凭记忆写命令的那一族坑。
const require = createRequire(new URL('../../../apps/desktop/package.json', import.meta.url));
const { createPool } = require('mysql2/promise');

const env = {
  host: process.env.DAJIA_MYSQL_HOST,
  port: Number(process.env.DAJIA_MYSQL_PORT),
  user: process.env.DAJIA_MYSQL_USER,
  password: process.env.DAJIA_MYSQL_PASSWORD,
};

async function probe(opts, label) {
  const pool = createPool({ ...env, ...opts });
  const [rows] = await pool.query(
    `SELECT CAST('{"b":1,"a":-0,"bb":2,"kind":"point"}' AS JSON) AS j,
            9007199254740993 AS big, 7 AS small`,
  );
  const r = rows[0];
  console.log(`[${label}] typeof(j) = ${typeof r.j}`);
  console.log(`[${label}] j = ${typeof r.j === 'string' ? r.j : JSON.stringify(r.j)}`);
  if (typeof r.j === 'object' && r.j !== null) {
    console.log(`[${label}] keys = ${Object.keys(r.j).join(',')}`);
    console.log(`[${label}] a is -0 = ${Object.is(r.j.a, -0)}, a === 0 = ${r.j.a === 0}`);
  }
  console.log(`[${label}] big typeof = ${typeof r.big}, value = ${r.big}, safe = ${Number.isSafeInteger(Number(r.big))}`);
  console.log(`[${label}] small typeof = ${typeof r.small}`);
  await pool.end();
}

await probe({}, '默认（supportBigNumbers 关）');
await probe({ supportBigNumbers: true, bigNumberStrings: false }, 'supportBigNumbers 开');
```

Run（从仓库根）: `node .superpowers/sdd/2026-10-01-dajia-plan4-persistence/probe-json.mjs > tmp/t4-probe.log 2>&1; echo "exit=$?"`

Expected: 两档各 4–6 行读数。把**读数原样抄进执行回填**，然后按读数钉死三处，规则是**钉成一条断言，不许写 `A || B` 这种两头都绿的断言**：

- `asJsonValue` 的两支：主路按 A 档读数写进注释，另一支留作"驱动升级 / `typeCast` 变更"的兜底，**两支都不许删**（删掉非主路那一支之后没有任何用例变红 ⇒ 这一型在 M7 行末登记为已知限度）；
- `-0`：若 B 档显示 MySQL 已把 `-0` 归一成 `0`，那"盘上读到 -0"这一型只能由 `codec.test.ts` 的**纯文本**用例覆盖（不经数据库），第 19 格改钉"归一"这件事本身；
- BIGINT：D 档若显示"关着时 `9007199254740993` 直接成 JS number 且已失精"，P-17 那两条配置**必须**开，且第 2 格（越界回 string）的期望值是 `string`。若实测相反（关着也回 string，或开着仍回 number），**以实测为准改这一格的期望值并把两档读数写进回填**，配置那两行照开不误（它们的作用范围只在越界处）。

> 这一发若报 `Cannot find module 'mysql2/promise'`：先确认 T1 Step 1 那条 `pnpm --filter @dajia/desktop add mysql2@^3.24.5` 真跑过。T1 那个 `probe-import.mjs` 若是靠 cwd 解析成功的，本任务的探针仍用 `createRequire` 锚点 —— 两条通路别混着写进回填。

- [ ] **Step 2: 先写不连库的那半 —— `codec.test.ts`（CI 有牙的一档）**

`apps/desktop/test/unit/codec.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  Document,
  SCHEMA_VERSION,
  applyPatch,
  type Entity,
  type OpeningEntity,
  type PointEntity,
  type SlabEntity,
  type StoreyEntity,
  type WallEntity,
} from '@dajia/core';
import { DocumentPayloadSchema } from '@dajia/protocol';
import {
  asJsonValue,
  decodeDocument,
  decodeEntity,
  decodePatch,
  encodeDocument,
  encodeEntity,
  encodePatch,
  type RowRef,
} from '../../src/main/db/codec';

/**
 * 夹具是**手写**的一堆实体，不走任何命令：codec 判的是字节形状，
 * "这份文档在几何上成不成立"归 T3 的读盘不变式与 T5 的 loadProject。
 * 于是这里能给出一面厚 5000 装在 4000 长墙上的墙而不会抛 —— 那不是漏判，是分工（见正文 ②③）。
 */
const PID = '0193aa00-0000-7000-8000-00000000000a';
const S1 = '0193aa00-0000-7000-8000-000000000001';
const P1 = '0193aa00-0000-7000-8000-000000000002';
const P2 = '0193aa00-0000-7000-8000-000000000003';
const P3 = '0193aa00-0000-7000-8000-00000000000b';
const W1 = '0193aa00-0000-7000-8000-000000000004';
const O1 = '0193aa00-0000-7000-8000-000000000005';
const C1 = '0193aa00-0000-7000-8000-000000000006';
const B1 = '0193aa00-0000-7000-8000-000000000007';

const point: PointEntity = { kind: 'point', id: P1, storeyId: S1, x: 0, y: 0 };
const point2: PointEntity = { kind: 'point', id: P2, storeyId: S1, x: 4000, y: 0 };
const point3: PointEntity = { kind: 'point', id: P3, storeyId: S1, x: 0, y: 4000 };
const wall: WallEntity = {
  kind: 'wall',
  id: W1,
  storeyId: S1,
  startId: P1,
  endId: P2,
  thicknessMm: 5000, // 故意大于墙长：codec 不管几何，这一格要的是"字节进得来"
  heightMm: 2800,
  elevationOffsetMm: 0,
  loadBearing: true,
  material: '混凝土',
};
const opening: OpeningEntity = {
  kind: 'opening',
  id: O1,
  storeyId: S1,
  hostWallId: W1,
  distanceMm: 1000,
  widthMm: 900,
  heightMm: 2100,
  sillMm: 0,
  category: 'door',
};
const storey: StoreyEntity = {
  kind: 'storey',
  id: S1,
  projectId: PID,
  index: 0,
  elevationMm: 0,
  heightMm: 3000,
};
const column: Entity = {
  kind: 'column',
  id: C1,
  storeyId: S1,
  pointId: P1,
  widthMm: 400,
  depthMm: 400,
  heightMm: 3000,
  loadBearing: true,
  material: '混凝土',
};
const slab: SlabEntity = {
  kind: 'slab',
  id: B1,
  storeyId: S1,
  boundaryPointIds: [P1, P2, P3],
  thicknessMm: 120,
  elevationOffsetMm: 0,
};
const ALL: readonly Entity[] = [point, point2, point3, wall, opening, storey, column, slab];

const ELEMENT: RowRef = { table: 'element', id: P1 };
const LOG: RowRef = { table: 'command_log', id: '7' };
const SNAP: RowRef = { table: 'snapshot', id: '3' };

function docOf(entities: readonly Entity[]): Document {
  const base = Document.create(PID);
  return Document.replaceEntities(base, new Map(entities.map((e) => [e.id, e])));
}

describe('codec：盘上字节 ↔ core 数据', () => {
  it('八条实体 encode→decode 逐字段回来（六类各有样本）', () => {
    for (const entity of ALL) {
      const back = decodeEntity({ table: 'element', id: entity.id }, encodeEntity(entity));
      expect(back).toEqual(entity);
    }
    // 六类都得在场：少一类就是"这一类从没穿过 codec"，新增字段时会静默漂
    const kinds = new Set(ALL.map((e) => e.kind));
    expect([...kinds].sort()).toEqual(['column', 'opening', 'point', 'slab', 'storey', 'wall']);
  });

  it('文档 encode→decode 之后 canonical() 逐字节相同', () => {
    const doc = docOf(ALL);
    const back = decodeDocument(SNAP, encodeDocument(doc));
    expect(back.canonical()).toBe(doc.canonical());
    expect(back.projectId).toBe(PID);
    expect(back.schemaVersion).toBe(doc.schemaVersion);
  });

  it('键序被打乱的快照文本照样回到同一个 canonical()（MySQL 重排 JSON 键也不影响）', () => {
    const doc = docOf(ALL);
    const shuffled = JSON.stringify({
      entities: [...ALL].map((e) => {
        // 逐条把键序倒过来写：canonical() 自己排序，所以字节层乱序不该改变任何判据
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(e).reverse()) out[k] = (e as unknown as Record<string, unknown>)[k];
        return out;
      }),
      schemaVersion: doc.schemaVersion,
      projectId: doc.projectId,
    });
    expect(decodeDocument(SNAP, shuffled).canonical()).toBe(doc.canonical());
  });

  it('多余字段在读取侧被拒（`.strict()` 的那一半：core 不看的东西这里必须看）', () => {
    const bad = { ...point, lengthMm: 4000 };
    expect(() => decodeEntity(ELEMENT, JSON.stringify(bad))).toThrow(/解不出实体/);
  });

  it('浮点毫米与越界整数在读取侧被拒', () => {
    expect(() => decodeEntity(ELEMENT, JSON.stringify({ ...point, x: 1.5 }))).toThrow(/解不出实体/);
    expect(() =>
      decodeEntity(ELEMENT, JSON.stringify({ ...point, x: 9007199254740993 })),
    ).toThrow(/解不出实体/);
  });

  it('-0 只有从**手写文本**进来才拦得住（JSON.stringify(-0) 是 "0"）', () => {
    expect(() =>
      decodeEntity(ELEMENT, `{"kind":"point","id":"${P1}","storeyId":"${S1}","x":-0,"y":0}`),
    ).toThrow(/解不出实体/);
    // 这一格的存在理由是这个不对称：-0 的判据（T3 的 MmSchema）真正的用武之地是
    // 读别人的字节（盘上的、IPC 进来的、迁移脚本塞进去的），不是拦自己人。
    expect(() => decodeEntity(ELEMENT, JSON.stringify({ ...point, x: -0 }))).not.toThrow();
  });

  it('抛错文案带表名与行 id：三张表各一发（排查时只有这两个字段能落到一行上）', () => {
    const junk = JSON.stringify({ kind: 'point' });
    expect(() => decodeEntity(ELEMENT, junk)).toThrow(/^element 行 0193aa00-\S+ 解不出实体：/);
    expect(() => decodePatch(LOG, junk)).toThrow(/^command_log 行 7 解不出补丁：/);
    expect(() => decodeDocument(SNAP, junk)).toThrow(/^snapshot 行 3 解不出文档快照：/);
  });

  it('decodePatch 只管形状：upsert 里重复 id 交回 core 抛（两个边界各守各的，不许混）', () => {
    const decoded = decodePatch(LOG, JSON.stringify({ upsert: [point, point], remove: [] }));
    expect(decoded.upsert.length).toBe(2);
    expect(() => applyPatch(docOf(ALL), decoded)).toThrow(/Patch\.upsert 内 id 重复/);
  });

  it('encodeDocument 的形状就是三键，且 entities 按 id 升序（与 canonical() 同一个口径）', () => {
    expect(Object.keys(DocumentPayloadSchema.shape).sort()).toEqual([
      'entities',
      'projectId',
      'schemaVersion',
    ]);
    const parsed = JSON.parse(encodeDocument(docOf(ALL))) as {
      projectId: string;
      schemaVersion: number;
      entities: { id: string }[];
    };
    expect(parsed.projectId).toBe(PID);
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
    const ids = parsed.entities.map((e) => e.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('encode 不是校验器：它把 -0 写成 "0"，且照样不抛', () => {
    const text = encodeEntity({ ...point, x: -0 });
    expect(text).toContain('"x":0');
    expect(() => decodeEntity(ELEMENT, text)).not.toThrow();
  });

  it('快照里同一 id 出现两次 ⇒ 抛（静默取后者等于盘上同时存着两个真值）', () => {
    const text = JSON.stringify({
      projectId: PID,
      schemaVersion: SCHEMA_VERSION,
      entities: [point, { ...point, x: 123 }, point2],
    });
    expect(() => decodeDocument(SNAP, text)).toThrow(/entities 里实体 \S+ 出现两次/);
  });

  it('asJsonValue：字符串走 JSON.parse，对象原样过，坏文本抛，null 原样过', () => {
    expect(asJsonValue('{"a":1}')).toEqual({ a: 1 });
    expect(asJsonValue({ a: 1 })).toEqual({ a: 1 });
    expect(asJsonValue(null)).toBe(null);
    expect(() => asJsonValue('{不是 JSON')).toThrow(/不是合法 JSON 文本/);
  });
});
```

Run: `npx vitest run apps/desktop/test/unit/codec.test.ts > tmp/t4-codec.log 2>&1; echo "exit=$?"`
Expected: `exit=1`，`Failed to load ... ../../src/main/db/codec`（文件还没写；`DocumentPayloadSchema` 那一发也还没写）。

- [ ] **Step 3: 写 protocol 的三个出口与 `codec.ts`**

`packages/protocol/src/entity-schema.ts` 末尾追加（T3 写的那些一个字不动）：

```ts
/**
 * 快照 payload 的**盘上契约**。住在这里而不是 `codec.ts`：`apps/desktop` 没有 zod 依赖，
 * pnpm 的严格 node_modules 也让它解析不到 protocol 的那一份 —— zod 只能住在有它的那个包里。
 * 三个 `parse*` 出口把 `ZodError` 在这里就收成一个普通 `TypeError`，边界另一侧只见文本。
 */
export const DocumentPayloadSchema = z.strictObject({
  projectId: EntityIdSchema,
  schemaVersion: z
    .number()
    .refine((v) => Number.isSafeInteger(v) && v >= 1, 'schemaVersion 必须是正整数'),
  entities: z.array(EntitySchema),
});

export type DocumentPayloadShape = z.output<typeof DocumentPayloadSchema>;
export type PatchShape = z.output<typeof PatchSchema>;

function issueText(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`).join('; ');
}

/** `where` 由调用方给（表名 + 行 id，或 T8 的 IPC 通道名）；文案形状是 codec.test.ts 的正则吃的样子。 */
export function parseEntityShape(where: string, value: unknown): EntityShape {
  const r = EntitySchema.safeParse(value);
  if (!r.success) throw new TypeError(`${where} 解不出实体：${issueText(r.error)}`);
  return r.data;
}

export function parsePatchShape(where: string, value: unknown): PatchShape {
  const r = PatchSchema.safeParse(value);
  if (!r.success) throw new TypeError(`${where} 解不出补丁：${issueText(r.error)}`);
  return r.data;
}

export function parseDocumentPayload(where: string, value: unknown): DocumentPayloadShape {
  const r = DocumentPayloadSchema.safeParse(value);
  if (!r.success) throw new TypeError(`${where} 解不出文档快照：${issueText(r.error)}`);
  return r.data;
}
```

`apps/desktop/src/main/db/codec.ts`

```ts
import { Document, type Entity, type EntityId, type Patch } from '@dajia/core';
import { parseDocumentPayload, parseEntityShape, parsePatchShape } from '@dajia/protocol';

export type RowTable = 'element' | 'command_log' | 'snapshot';

/** 抛错文案里的坐标：哪张表、哪一行。排查时只有这两个字段能把一条 zod 报错落到一行上。 */
export interface RowRef {
  readonly table: RowTable;
  readonly id: string;
}

function where(ref: RowRef): string {
  return `${ref.table} 行 ${ref.id}`;
}

/**
 * JSON 列的回读形态由驱动决定（对象还是串），Step 1 的 A 档给主路（写进下面的注释）。
 * **两条分支都不许删**：`typeCast` 或驱动版本一变，删掉的那一条就是"今天绿、明天红"的那种红。
 * 这一条也不是"`A || B` 都算过" —— 两支喂进同一个 zod，解不出照样抛，判据在 zod 那边。
 * 实测主路（Step 1 回填）：`typeof` = `<待实测>`。
 */
export function asJsonValue(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as unknown;
    } catch (err) {
      throw new TypeError(`${String(raw).slice(0, 40)}… 不是合法 JSON 文本：${String(err)}`);
    }
  }
  return raw;
}

/**
 * 编码 = 序列化，**不是校验**。两件事必须分开写清楚，否则会有人以为这里能挡 -0：
 * `JSON.stringify(-0)` 是 `"0"`，盘上永远不会出现 -0（`codec.test.ts` 第 10 格钉的就是这件事）。
 */
export function encodeEntity(entity: Entity): string {
  return JSON.stringify(entity);
}

/**
 * 返回类型写成 `Entity` 而**不写 `as`**：`EntityShape → Entity` 的赋值就是编译期那道牙。
 * schema 与 core 接口漂开时，红的第一个位置是这个文件（`tsc -p apps/desktop/tsconfig.test.json`），
 * `entity-shape.test.ts` 是同一件事的第二证人 —— 两个都留着，因为证人红了要能指出漂在哪一侧。
 */
export function decodeEntity(ref: RowRef, raw: unknown): Entity {
  return parseEntityShape(where(ref), asJsonValue(raw));
}

export function encodePatch(patch: Patch): string {
  return JSON.stringify(patch);
}

export function decodePatch(ref: RowRef, raw: unknown): Patch {
  return parsePatchShape(where(ref), asJsonValue(raw));
}

function byId(a: Entity, b: Entity): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 落盘形状与 `canonical()` 同一口径：实体按 id 升序。`document.ts` 里那个 `byId` 是模块私有的，
 * 为一次排序给它加导出 = 让 core 多一条只服务于磁盘的 API；这里复制两行比较符，
 * 而"两边排序一致"这条主张由 `codec.test.ts` 第 9 格守（它同时读 `encodeDocument` 的产物与形状表）。
 */
export function encodeDocument(doc: Document): string {
  return JSON.stringify({
    projectId: doc.projectId,
    schemaVersion: doc.schemaVersion,
    entities: [...doc.entities.values()].sort(byId),
  });
}

/** 只解码、不验不变式：引用与几何的放行证在 T5 的 `loadProject`（那里才知道一共读了几层）。 */
export function decodeDocument(ref: RowRef, raw: unknown): Document {
  const payload = parseDocumentPayload(where(ref), asJsonValue(raw));
  const next = new Map<EntityId, Entity>();
  for (const entity of payload.entities) {
    if (next.has(entity.id)) {
      // zod 与 Map.set 都不管数组里的重复：同一份快照存着同一 id 的两个真值，
      // 静默取后者会让 canonical() 说谎 —— 这一型必须在读盘当场炸。
      throw new TypeError(
        `${where(ref)} 的 entities 里实体 ${entity.id} 出现两次：一份快照不许有重复 id`,
      );
    }
    next.set(entity.id, entity);
  }
  return Document.replaceEntities(Document.create(payload.projectId, payload.schemaVersion), next);
}
```

Run: `npx vitest run apps/desktop/test/unit/codec.test.ts > tmp/t4-codec.log 2>&1; echo "exit=$?"`
Expected: `exit=0`，12 条全绿。若第 7 格的正则对不上，**改代码里的文案对齐测试**，不许反过来放宽正则。

- [ ] **Step 4: 编译期那一档 —— `entity-shape.test.ts`**

`apps/desktop/test/unit/entity-shape.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  Document,
  type Entity,
  type EntityId,
  type OpeningEntity,
  type PointEntity,
  type SlabEntity,
  type StoreyEntity,
  type WallEntity,
} from '@dajia/core';
import { type EntityShape, parseEntityShape } from '@dajia/protocol';

/**
 * 这一档**天生是绿的**，它的价值由变异证明（T4-M6）：把 `OpeningSchema.category` 从
 * `z.enum(['door','window'])` 改成 `z.string()`，Task 3 的行为用例与键集合对账**全绿**，
 * 只有这里红 —— 而且是 `tsc` 红（`apps/desktop/tsconfig.test.json` 由 T1 建、T1 把它串进
 * `pnpm typecheck`）。所以这一档的判据是"能红"，不是"跑过"。
 *
 * 为什么单独一档：`scripts/check-package-deps.mjs` 只查 `@dajia/*` 的说明符方向，查不到形状漂移；
 * 类型检查又不在 vitest 里发生（它只转译）。`codec.ts` 里那两处不写 `as` 的返回值是同一个判据的
 * 第二证人（漂在 protocol 时它也红），两处都留着才能指出漂在哪一侧。
 */
const PID = '0193aa00-0000-7000-8000-00000000000a';
const S1 = '0193aa00-0000-7000-8000-000000000001';
const P1 = '0193aa00-0000-7000-8000-000000000002';
const P2 = '0193aa00-0000-7000-8000-000000000003';
const P3 = '0193aa00-0000-7000-8000-00000000000b';
const W1 = '0193aa00-0000-7000-8000-000000000004';
const O1 = '0193aa00-0000-7000-8000-000000000005';
const C1 = '0193aa00-0000-7000-8000-000000000006';
const B1 = '0193aa00-0000-7000-8000-000000000007';

const point: PointEntity = { kind: 'point', id: P1, storeyId: S1, x: 0, y: 0 };
const point2: PointEntity = { kind: 'point', id: P2, storeyId: S1, x: 4000, y: 0 };
const point3: PointEntity = { kind: 'point', id: P3, storeyId: S1, x: 0, y: 4000 };
const wall: WallEntity = {
  kind: 'wall',
  id: W1,
  storeyId: S1,
  startId: P1,
  endId: P2,
  thicknessMm: 200,
  heightMm: 2800,
  elevationOffsetMm: 0,
  loadBearing: true,
  material: '混凝土',
};
const opening: OpeningEntity = {
  kind: 'opening',
  id: O1,
  storeyId: S1,
  hostWallId: W1,
  distanceMm: 1000,
  widthMm: 900,
  heightMm: 2100,
  sillMm: 0,
  category: 'door',
};
const storey: StoreyEntity = {
  kind: 'storey',
  id: S1,
  projectId: PID,
  index: 0,
  elevationMm: 0,
  heightMm: 3000,
};
const column: Entity = {
  kind: 'column',
  id: C1,
  storeyId: S1,
  pointId: P1,
  widthMm: 400,
  depthMm: 400,
  heightMm: 3000,
  loadBearing: true,
  material: '混凝土',
};
const slab: SlabEntity = {
  kind: 'slab',
  id: B1,
  storeyId: S1,
  boundaryPointIds: [P1, P2, P3],
  thicknessMm: 120,
  elevationOffsetMm: 0,
};
const FIXTURES: readonly Entity[] = [point, point2, point3, wall, opening, storey, column, slab];

describe('边界与真源之间不许有第二套形状', () => {
  it('两个方向都过：Entity 能当 EntityShape 递出去，解回来还能当 Entity 收进来', () => {
    for (const entity of FIXTURES) {
      const shape: EntityShape = entity; // 方向一：core → protocol（写盘那一侧）
      const back: Entity = parseEntityShape(
        `element 行 ${entity.id}`,
        JSON.parse(JSON.stringify(shape)),
      ); // 方向二：protocol → core（读盘那一侧）
      expect(back).toEqual(entity);
    }
  });

  it('手写一份 EntityShape 能直接进 `Document`（T5 的 loadProject 走的就是这条路）', () => {
    const shape: EntityShape = {
      id: W1,
      storeyId: S1,
      kind: 'wall',
      startId: P1,
      endId: P2,
      thicknessMm: 200,
      heightMm: 2800,
      elevationOffsetMm: 0,
      loadBearing: false,
      material: '砖',
    };
    // 这一行是编译期判据：键序、可选性、字面量收窄全都在这一个赋值上判
    const entity: Entity = shape;
    const doc = Document.replaceEntities(
      Document.create(PID),
      new Map<EntityId, Entity>([[entity.id, entity]]),
    );
    expect(doc.get(W1)).toBe(entity);
    expect(doc.byKind('wall')).toEqual([entity]);
  });
});
```

Run: `npx vitest run apps/desktop/test/unit/entity-shape.test.ts > tmp/t4-shape.log 2>&1; echo "exit=$?"` —— Expected `exit=0`。

再把编译期那一半单独量一次（vitest 只转译不查类型，这一发才是判据）：

```bash
npx tsc --noEmit -p apps/desktop/tsconfig.test.json > tmp/t4-tsc.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`。**然后当场证一次它能红**（M6，做完立刻 `cp` 还原 + md5 核对）：把 `packages/protocol/src/entity-schema.ts` 里 `OpeningSchema` 的 `category: z.enum(['door', 'window'])` 改成 `category: z.string()`，重跑上面这条 `tsc` ⇒ 必须 `exit=1` 且报在 `entity-shape.test.ts` 与 `codec.ts`；同时 `npx vitest run packages/protocol/test/entity-schema.test.ts` 必须**照旧全绿**（证明这一型只有编译期看得见）。两组读数写进执行回填。

- [ ] **Step 5: `pool.ts` 补 P-17 的两条配置**

`apps/desktop/src/main/db/pool.ts` —— 把 `PoolOptions` 与 `createDbPool` 改成下面这样（T2 那段关于 `multipleStatements` 的注释**一字不动**，它是"业务连接不开多语句"这条纪律的产地）：

```ts
export interface PoolOptions {
  /**
   * 只在迁移连接上开：一个 `.sql` 版本里是多条 DDL，逐条发要把分词器交给 JS 再写一遍。
   * **业务连接永远不开** —— 打开它等于给任何一处字符串拼接留出多语句的通道，
   * 而本计划唯一的"库名进 SQL"的地方（ensureDatabase / dropTestDatabase）靠白名单挡，不靠这个。
   */
  readonly multipleStatements?: boolean;
  readonly connectionLimit?: number;
  /**
   * 行锁等待秒数。**唯一读者是 `repository.test.ts` 的第 12 格**（裁决 P-15：外部连接持行锁
   * 把事务掐断）。默认 50 秒会让那一格看起来像挂死，而测试要的是一次**快速、可断言**的失败。
   * 生产连接不设它 —— "一次保存卡 50 秒"是产品问题，不该由存储层替产品决定。
   */
  readonly lockWaitTimeoutSeconds?: number;
}

export function createDbPool(env: MysqlEnv, opts: PoolOptions = {}): Pool {
  return createPool({
    host: env.host,
    port: env.port,
    user: env.user,
    password: env.password,
    database: env.database,
    waitForConnections: true,
    connectionLimit: opts.connectionLimit ?? 4,
    charset: 'utf8mb4',
    multipleStatements: opts.multipleStatements ?? false,
    // 日期一律按 DATETIME(3) 原样读回；时区口径交给服务端（P-4），客户端不参与换算。
    dateStrings: true,
    namedPlaceholders: false,
    // P-17：BIGINT 四列（journal_turn / turn / seq / updated_seq）默认被 mysql2 直接转 JS number，
    // 超出 2^53 静默失精。supportBigNumbers 开 + bigNumberStrings 关 ⇒ "范围内回 number、范围外回 string"，
    // 而 string 过不了 MmSchema / JournalTurnSchema ⇒ 越界变成一次抛，不是一次悄悄写歪的账。
    // Step 1 的 D 档读数就是这两行的凭据；第 2 格把它钉成断言。
    supportBigNumbers: true,
    bigNumberStrings: false,
    ...(opts.lockWaitTimeoutSeconds === undefined
      ? {}
      : { sessionVariables: { innodb_lock_wait_timeout: opts.lockWaitTimeoutSeconds } }),
  });
}
```

Run: `npx tsc --noEmit -p apps/desktop/tsconfig.test.json > tmp/t4-tsc2.log 2>&1; echo "exit=$?"`
Expected: `exit=0`。若 mysql2 的类型里没有 `sessionVariables`（以 Step 1 的驱动读数为准），**不要改成 `any` 糊过去**：改用 `pool.on('connection', ...)` 里发 `SET SESSION innodb_lock_wait_timeout`，并把选型与实测写进执行回填。

- [ ] **Step 6: 写连库的写路径测试（第一次真往 `dajia_test` 写业务表）**

`apps/desktop/test/db/repository.test.ts`

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'mysql2/promise';
import {
  Document,
  applyPatch,
  storeyCreate,
  storeyDelete,
  storeySetElevation,
  wallCreate,
  wallDelete,
  wallSetLoadBearing,
  type Command,
  type Entity,
  type EntityId,
  type Patch,
} from '@dajia/core';
import { createDbPool } from '../../src/main/db/pool';
import { readMysqlEnv } from '../../src/main/db/env';
import { dropTestDatabase, ensureDatabase } from '../../src/main/db/database';
import { migrate } from '../../src/main/db/migrate';
import { ProjectRepository } from '../../src/main/db/repository';
import { decodeDocument, decodeEntity } from '../../src/main/db/codec';

const env = readMysqlEnv();
// 红线（见"授权与红线"那一节）：库名由本文件写死，**不抄 env**。`env.database` 允许是 `dajia`
// —— 那是应用运行时的合法取值，测试照抄它就把用户的真工程库当试验田，且一句错都不报。
const DATABASE = 'dajia_test';
const PROJECT_ID = '0193aa00-0000-7000-8000-00000000000a' as EntityId;
const OTHER_PROJECT = '0193aa00-0000-7000-8000-00000000000f' as EntityId;

let pool: Pool;
let repoPool: Pool;
let repo: ProjectRepository;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [res] = await pool.query(sql, params);
  return res as T[];
}

async function count(table: string, where = '', params: unknown[] = []): Promise<number> {
  const [res] = await pool.query(`SELECT COUNT(*) AS n FROM \`${table}\`${where}`, params);
  return Number((res as { n: number | string }[])[0]?.n);
}

/**
 * 清场只删 `project` 行：FK 都带 ON DELETE CASCADE，级联把 element / storey / command_log /
 * snapshot / asset 的子行一起带走。不用 `TRUNCATE` —— 有外键的表上 MySQL 会拒
 * （或要 `SET FOREIGN_KEY_CHECKS = 0`，那是把约束关掉再祈祷）。
 * 代价照 P-6 说：`AUTO_INCREMENT` 不重置 ⇒ `seq` 起点每发都在漂，
 * 所以本文件**没有任何一条判据读绝对 seq 值**，只读相对关系（子查询、DISTINCT、行内比对）。
 */
async function clearAll(): Promise<void> {
  await pool.query('DELETE FROM `project`');
}

/**
 * 用真命令造一发 turn 的补丁。测试自己**不**走 `TransactionLog`：`log.lastPatch` 要到 T7 才存在，
 * 而写路径吃的就是 `(patch, doc)` 这一对。T7 落地时把这里的 `step()` 换成 dispatch + `log.lastPatch`，
 * 用例形状不用改 —— 这是故意留下的接口，不是临时脚手架。
 */
function step(doc: Document, cmd: Command): { patch: Patch; doc: Document } {
  const patch = cmd.build(doc);
  return { patch, doc: applyPatch(doc, patch).doc };
}

interface Turn {
  readonly turn: number;
  readonly patch: Patch;
  readonly doc: Document;
}

/** 一层 + 一面承重墙：两个 turn，足够喂满四张表的写路径。 */
function houseTurns(): { entries: Turn[]; storeyId: EntityId; wallId: EntityId } {
  const t1 = step(
    Document.create(PROJECT_ID),
    storeyCreate({ projectId: PROJECT_ID, index: 0, elevationMm: 0, heightMm: 3000 }),
  );
  const storeyId = (t1.patch.upsert[0] as Entity).id as EntityId;
  const t2 = step(
    t1.doc,
    wallCreate({
      storeyId,
      start: { x: 0, y: 0 },
      end: { x: 4000, y: 0 },
      thicknessMm: 200,
      heightMm: 2800,
      loadBearing: true,
    }),
  );
  const wall = t2.patch.upsert.find((e) => e.kind === 'wall');
  if (!wall) throw new TypeError('wallCreate 的补丁里没有墙，夹具塌了');
  return { entries: [{ turn: 1, ...t1 }, { turn: 2, ...t2 }], storeyId, wallId: wall.id };
}

beforeAll(async () => {
  await dropTestDatabase(env, DATABASE);
  await ensureDatabase(env, DATABASE);
  pool = createDbPool({ ...env, database: DATABASE });
  await migrate(pool, DATABASE);
  // 仓库用的池：一条连接 + 1 秒行锁等待。connectionLimit 是 1 且有意的 ——
  // 少了 `conn.release()` 时重发会拿不到连接（M5 的凭据），而不是悄悄多用一条连接把漏检盖住。
  repoPool = createDbPool(
    { ...env, database: DATABASE },
    { connectionLimit: 1, lockWaitTimeoutSeconds: 1 },
  );
  repo = new ProjectRepository(repoPool, PROJECT_ID, 'tester');
});

afterAll(async () => {
  await repoPool.end();
  await pool.end();
  await dropTestDatabase(env, DATABASE);
});

describe('连库守卫', () => {
  it('连接真的落在 dajia_test（哪怕环境变量指着的不是它）', async () => {
    const got = await rows<{ db: string }>('SELECT DATABASE() AS db');
    expect(got[0]?.db).toBe(DATABASE);
  });

  it('越界的 LONGLONG 回 string 而不是失精的 number（P-17 的 D 档钉成断言）', async () => {
    const got = await rows<{ big: unknown }>('SELECT 9007199254740993 AS big');
    expect(typeof got[0]?.big).toBe('string');
    expect(got[0]?.big).toBe('9007199254740993');
  });
});

describe('createProject', () => {
  beforeEach(clearAll);

  it('project 行落账：journal_turn 从 0 起、clean_shutdown 为 1、schema_version 照文档记', async () => {
    await repo.createProject({ name: '样例房', schemaVersion: 1 });
    const got = await rows<Record<string, string | number>>(
      'SELECT `schema_version`, `name`, `journal_turn`, `clean_shutdown` FROM `project` WHERE `id` = ?',
      [PROJECT_ID],
    );
    expect(got[0]).toMatchObject({
      schema_version: 1,
      name: '样例房',
      journal_turn: 0,
      clean_shutdown: 1,
    });
  });

  it('同一个 id 建两次 ⇒ 抛，且 `project` 表还是一行', async () => {
    await repo.createProject({ name: '样例房', schemaVersion: 1 });
    await expect(repo.createProject({ name: '另一份', schemaVersion: 1 })).rejects.toThrow(
      /Duplicate entry|已存在/i,
    );
    expect(await count('project')).toBe(1);
  });

  it('工程名空串、带首尾空白、超长 ⇒ 抛，且一个字段都不写（存储层不替调用方修手滑）', async () => {
    await expect(repo.createProject({ name: '', schemaVersion: 1 })).rejects.toThrow(/工程名/);
    await expect(repo.createProject({ name: '  ', schemaVersion: 1 })).rejects.toThrow(/工程名/);
    await expect(repo.createProject({ name: ' 样例房', schemaVersion: 1 })).rejects.toThrow(/工程名/);
    await expect(repo.createProject({ name: 'a'.repeat(201), schemaVersion: 1 })).rejects.toThrow(
      /200 个字符/,
    );
    await expect(repo.createProject({ name: '样例房', schemaVersion: 0 })).rejects.toThrow(
      /schemaVersion/,
    );
    expect(await count('project')).toBe(0);
  });

  it('actor 空串或超 64 字符 ⇒ 构造当场抛（VARCHAR(64) 截断是静默的那种错）', () => {
    expect(() => new ProjectRepository(repoPool, PROJECT_ID, '')).toThrow(/actor 长度/);
    expect(() => new ProjectRepository(repoPool, PROJECT_ID, 'a'.repeat(65))).toThrow(/actor 长度/);
  });
});

describe('appendJournal：一发 turn 的四张表', () => {
  beforeEach(async () => {
    await clearAll();
    await repo.createProject({ name: '样例房', schemaVersion: 1 });
  });

  it('两个 turn 跑完：command_log / element / storey / project 四处同时有账，且 updated_seq 跟着最后一发', async () => {
    const { entries } = houseTurns();
    expect(await repo.appendJournal(entries[0]!)).toBe('applied');
    expect(await repo.appendJournal(entries[1]!)).toBe('applied');

    expect(await count('command_log')).toBe(2);
    expect(await count('storey')).toBe(1);
    expect(await count('project', ' WHERE `journal_turn` = ?', [2])).toBe(1);

    const log = await rows<{ turn: number; actor: string }>(
      'SELECT `turn`, `actor` FROM `command_log` ORDER BY `seq`',
    );
    expect(log.map((r) => [r.turn, r.actor])).toEqual([
      [1, 'tester'],
      [2, 'tester'],
    ]);

    // element 的 id 集合逐字等于文档的实体 id 集合 —— P-7 的双写只在这一发上有牙
    const final = entries[1]!.doc;
    const onDisk = (await rows<{ id: EntityId }>('SELECT `id` FROM `element` ORDER BY `id`')).map(
      (r) => r.id,
    );
    expect(onDisk).toEqual([...final.entities.keys()].sort());

    // 整个投影只被最后一发碰过一遍：DISTINCT updated_seq = 1，且那一发就是 turn 2 的 seq
    expect(Number((await rows<{ n: number }>('SELECT COUNT(DISTINCT `updated_seq`) AS n FROM `element`'))[0]?.n)).toBe(1);
    const seq2 = (await rows<{ seq: string | number }>('SELECT `seq` FROM `command_log` WHERE `turn` = 2'))[0]?.seq;
    expect(await count('element', ' WHERE `updated_seq` = ?', [Number(seq2)])).toBe(
      final.entities.size,
    );
  });

  it('payload 读回来的实体与文档逐字段相同，且生成列认这套 payload 写法', async () => {
    const { entries, wallId } = houseTurns();
    await repo.appendJournal(entries[0]!);
    await repo.appendJournal(entries[1]!);
    const raw = await rows<{ payload: unknown }>(
      'SELECT `payload` FROM `element` WHERE `id` = ?',
      [wallId],
    );
    expect(decodeEntity({ table: 'element', id: wallId }, raw[0]?.payload)).toEqual(
      entries[1]!.doc.get(wallId),
    );
    const gen = await rows<{ kind: string; load_bearing: number | null }>(
      'SELECT `kind`, `load_bearing` FROM `element` WHERE `id` = ?',
      [wallId],
    );
    expect([gen[0]?.kind, gen[0]?.load_bearing]).toEqual(['wall', 1]);

    // 改承重 ⇒ 生成列跟着走（T2-M2 那一发的活体版本：repository 写的 payload 必须让生成列算得出）
    const t3 = step(entries[1]!.doc, wallSetLoadBearing({ wallId, loadBearing: false }));
    expect(await repo.appendJournal({ turn: 3, ...t3 })).toBe('applied');
    const after = await rows<{ load_bearing: number | null }>(
      'SELECT `load_bearing` FROM `element` WHERE `id` = ?',
      [wallId],
    );
    expect(after[0]?.load_bearing).toBe(0);
  });

  it('楼层那一行的 `storey_id` 是 NULL，别的三类都带着自己的层', async () => {
    const { entries, storeyId } = houseTurns();
    await repo.appendJournal(entries[0]!);
    await repo.appendJournal(entries[1]!);
    const s = await rows<{ storey_id: EntityId | null }>(
      'SELECT `storey_id` FROM `element` WHERE `id` = ?',
      [storeyId],
    );
    expect(s[0]?.storey_id).toBe(null);
    expect(await count('element', ' WHERE `storey_id` IS NOT NULL')).toBe(3);
  });

  it('同一 turn 重发 ⇒ `already-applied`，log 不涨、投影一个字不动（P-6 的落点）', async () => {
    const { entries } = houseTurns();
    await repo.appendJournal(entries[0]!);
    const before = await rows<{ id: EntityId; updated_seq: string | number }>(
      'SELECT `id`, `updated_seq` FROM `element` ORDER BY `id`',
    );
    expect(await repo.appendJournal(entries[0]!)).toBe('already-applied');
    expect(await repo.appendJournal(entries[0]!)).toBe('already-applied');
    expect(await count('command_log')).toBe(1);
    const after = await rows<{ id: EntityId; updated_seq: string | number }>(
      'SELECT `id`, `updated_seq` FROM `element` ORDER BY `id`',
    );
    expect(after).toEqual(before);
    expect(await count('project', ' WHERE `journal_turn` = ?', [1])).toBe(1);
  });

  it('跳号（盘上 0、这发 2）⇒ 抛，且四张表全无账', async () => {
    const { entries } = houseTurns();
    await expect(repo.appendJournal(entries[1]!)).rejects.toThrow(/journal turn 跳号/);
    expect(await count('command_log')).toBe(0);
    expect(await count('element')).toBe(0);
    expect(await count('storey')).toBe(0);
    expect(await count('project', ' WHERE `journal_turn` = ?', [0])).toBe(1);
  });

  it('半途被外部行锁掐断 ⇒ 全无账；释放后同 turn 重发成功（P-15：rollback 与 release 的唯一凭据）', async () => {
    const { entries, wallId } = houseTurns();
    await repo.appendJournal(entries[0]!);
    await repo.appendJournal(entries[1]!);

    // 另一条连接把墙那一行锁住不提交：仓库这一发会先写成 command_log，再在 element 那一发上等锁超时
    // —— 失败点落在事务**中间**，正是"要么全写要么全无"要看的位置。
    const blockerPool = createDbPool({ ...env, database: DATABASE }, { connectionLimit: 2 });
    const blocker = await blockerPool.getConnection();
    try {
      await blocker.beginTransaction();
      await blocker.query('SELECT `id` FROM `element` WHERE `id` = ? FOR UPDATE', [wallId]);

      const t3 = step(entries[1]!.doc, wallSetLoadBearing({ wallId, loadBearing: false }));
      await expect(repo.appendJournal({ turn: 3, ...t3 })).rejects.toThrow(/Lock wait timeout/);

      expect(await count('command_log', ' WHERE `turn` = ?', [3])).toBe(0);
      expect(await count('project', ' WHERE `journal_turn` = ?', [3])).toBe(0);
      expect(await count('storey')).toBe(1);
      const still = await rows<{ payload: unknown }>(
        'SELECT `payload` FROM `element` WHERE `id` = ?',
        [wallId],
      );
      expect(decodeEntity({ table: 'element', id: wallId }, still[0]?.payload)).toEqual(
        entries[1]!.doc.get(wallId),
      );

      await blocker.rollback();
      // 没有 `conn.rollback()` ⇒ 这里撞 uk_project_turn（那条未回滚的 log 行被下一次 BEGIN 隐式提交）；
      // 没有 `conn.release()` ⇒ 这里卡在 getConnection（connectionLimit 是 1）。
      expect(await repo.appendJournal({ turn: 3, ...t3 })).toBe('applied');
      expect(await count('command_log', ' WHERE `turn` = ?', [3])).toBe(1);
    } finally {
      await blocker.release();
      await blockerPool.end();
    }
  });

  it('文档属于别的工程 ⇒ 抛在任何一个字之前', async () => {
    const other = Document.create(OTHER_PROJECT);
    const t1 = step(
      other,
      storeyCreate({ projectId: OTHER_PROJECT, index: 0, elevationMm: 0, heightMm: 3000 }),
    );
    await expect(repo.appendJournal({ turn: 1, ...t1 })).rejects.toThrow(
      /属于工程 0193aa00-\S+，这个仓库绑的是/,
    );
    expect(await count('command_log')).toBe(0);
    expect(await count('element')).toBe(0);
    expect(await count('storey')).toBe(0);
  });

  it('楼层实体属于别的工程 ⇒ 抛（文档归属对了不等于每个实体都对了），且 element 一行都不写', async () => {
    const intruder: Entity = {
      kind: 'storey',
      id: '0193aa00-0000-7000-8000-0000000000e1' as EntityId,
      projectId: OTHER_PROJECT,
      index: 0,
      elevationMm: 0,
      heightMm: 3000,
    };
    const doc = Document.replaceEntities(
      Document.create(PROJECT_ID),
      new Map<EntityId, Entity>([[intruder.id, intruder]]),
    );
    await expect(
      repo.appendJournal({ turn: 1, patch: { upsert: [intruder], remove: [] }, doc }),
    ).rejects.toThrow(/楼层 \S+ 属于工程/);
    expect(await count('element')).toBe(0);
    expect(await count('storey')).toBe(0);
    expect(await count('command_log')).toBe(0);
  });

  it('remove 的 id 在盘上不存在 ⇒ 抛（日志说要删的东西表上没有 = 两本账已经不对齐）', async () => {
    const { entries, wallId } = houseTurns();
    await repo.appendJournal(entries[0]!);
    await repo.appendJournal(entries[1]!);
    // 手工把墙那一行抹掉：core 不知道，补丁照旧带着它
    await pool.query('DELETE FROM `element` WHERE `id` = ?', [wallId]);
    const t3 = step(entries[1]!.doc, wallDelete({ wallId }));
    await expect(repo.appendJournal({ turn: 3, ...t3 })).rejects.toThrow(/盘上没有可删的 element/);
    expect(await count('command_log', ' WHERE `turn` = ?', [3])).toBe(0);
    expect(await count('project', ' WHERE `journal_turn` = ?', [2])).toBe(1);
  });

  it('删一整层 ⇒ element 与 storey 两张表跟着一起掉（P-7 的投影不漂）', async () => {
    const t1 = step(
      Document.create(PROJECT_ID),
      storeyCreate({ projectId: PROJECT_ID, index: 0, elevationMm: 0, heightMm: 3000 }),
    );
    const storeyA = (t1.patch.upsert[0] as Entity).id as EntityId;
    const t2 = step(
      t1.doc,
      wallCreate({
        storeyId: storeyA,
        start: { x: 0, y: 0 },
        end: { x: 4000, y: 0 },
        thicknessMm: 200,
        heightMm: 2800,
      }),
    );
    const t3 = step(
      t2.doc,
      storeyCreate({ projectId: PROJECT_ID, index: 1, elevationMm: 3000, heightMm: 3000 }),
    );
    const storeyB = (t3.patch.upsert[0] as Entity).id as EntityId;
    const entries: Turn[] = [
      { turn: 1, ...t1 },
      { turn: 2, ...t2 },
      { turn: 3, ...t3 },
    ];
    for (const e of entries) expect(await repo.appendJournal(e)).toBe('applied');
    expect(await count('storey')).toBe(2);

    const t4 = step(t3.doc, storeyDelete({ storeyId: storeyA }));
    expect(await repo.appendJournal({ turn: 4, ...t4 })).toBe('applied');
    expect(await count('storey')).toBe(1);
    expect(await count('storey', ' WHERE `id` = ?', [storeyB])).toBe(1);
    const left = (await rows<{ id: EntityId }>('SELECT `id` FROM `element` ORDER BY `id`')).map(
      (r) => r.id,
    );
    expect(left).toEqual([...t4.doc.entities.keys()].sort());
  });

  it('改标高只动楼层：`storey` 投影那一行跟着走，墙与点一个字不动', async () => {
    const { entries, storeyId } = houseTurns();
    await repo.appendJournal(entries[0]!);
    await repo.appendJournal(entries[1]!);
    const t3 = step(entries[1]!.doc, storeySetElevation({ storeyId, elevationMm: 3000 }));
    expect(await repo.appendJournal({ turn: 3, ...t3 })).toBe('applied');
    const s = await rows<{ index_no: number; elevation_mm: string | number; height_mm: string | number }>(
      'SELECT `index_no`, `elevation_mm`, `height_mm` FROM `storey` WHERE `id` = ?',
      [storeyId],
    );
    expect([s[0]?.index_no, Number(s[0]?.elevation_mm), Number(s[0]?.height_mm)]).toEqual([0, 3000, 3000]);
    // 这一发只碰了一行 element（楼层那行），且碰的是 turn 3 的那个 seq
    expect(
      await count(
        'element',
        ' WHERE `updated_seq` = (SELECT `seq` FROM `command_log` WHERE `turn` = 3)',
      ),
    ).toBe(1);
  });
});

describe('writeSnapshot', () => {
  beforeEach(async () => {
    await clearAll();
    await repo.createProject({ name: '样例房', schemaVersion: 1 });
  });

  it('快照落盘后 canonical() 逐字节回来（含经过 MySQL 的 JSON 规范化再回来）', async () => {
    const { entries } = houseTurns();
    await repo.appendJournal(entries[0]!);
    await repo.appendJournal(entries[1]!);
    const final = entries[1]!.doc;
    await repo.writeSnapshot(2, final);
    expect(await count('snapshot')).toBe(1);
    const got = await rows<{ payload: unknown }>(
      'SELECT `payload` FROM `snapshot` WHERE `journal_turn` = 2',
    );
    // Step 1 的 A 档读数顺带在这里落盘（判据不依赖它 —— asJsonValue 两支都能吃，这正是它存在的理由）
    process.stdout.write(`[t4] snapshot payload typeof = ${typeof got[0]?.payload}\n`);
    expect(
      decodeDocument({ table: 'snapshot', id: '2' }, got[0]?.payload).canonical(),
    ).toBe(final.canonical());
  });

  it('同一个 turn 落两份快照 ⇒ 抛（`uk_project_turn` 有活干，P-16 选裸 INSERT 的依据）', async () => {
    const { entries } = houseTurns();
    await repo.appendJournal(entries[0]!);
    await repo.writeSnapshot(1, entries[0]!.doc);
    await expect(repo.writeSnapshot(1, entries[0]!.doc)).rejects.toThrow(/Duplicate entry/);
    expect(await count('snapshot')).toBe(1);
  });

  it('文档属于别的工程 ⇒ 抛，`snapshot` 一行都不写', async () => {
    await expect(repo.writeSnapshot(1, Document.create(OTHER_PROJECT))).rejects.toThrow(
      /这个仓库绑的是/,
    );
    expect(await count('snapshot')).toBe(0);
  });
});
```

用例数：`连库守卫` 2 + `createProject` 4 + `appendJournal` 11 + `writeSnapshot` 3 = **20**。

- [ ] **Step 7: 写 `repository.ts`**

`apps/desktop/src/main/db/repository.ts`

```ts
import type { Pool } from 'mysql2/promise';
import type { Document, Entity, EntityId, Patch } from '@dajia/core';
import { JournalTurnSchema } from '@dajia/protocol';
import { encodeDocument, encodeEntity, encodePatch } from './codec';

export type JournalOutcome = 'applied' | 'already-applied';

export interface JournalEntry {
  /** 客户端分配的单调计数：幂等键（P-6）。 */
  readonly turn: number;
  /** 这一发状态变更的补丁，原样落进 `command_log.payload`（P-3）。 */
  readonly patch: Patch;
  /** 应用补丁之后的文档。只用它核对归属与 `schemaVersion`；投影一律走 `patch`。 */
  readonly doc: Document;
}

interface Header {
  readonly affectedRows?: number | string;
  readonly insertId?: number | string;
}

function hdr(res: unknown): { affectedRows: number; insertId: number } {
  const h = res as Header;
  return { affectedRows: Number(h.affectedRows ?? 0), insertId: Number(h.insertId ?? 0) };
}

/** 楼层实体自己就是层，`element.storey_id` 对它为空；别的四类都带着 storeyId。 */
function storeyIdOf(entity: Entity): EntityId | null {
  return entity.kind === 'storey' ? null : entity.storeyId;
}

function notThisProject(what: string, got: EntityId, want: EntityId): RangeError {
  return new RangeError(
    `${what}属于工程 ${got}，这个仓库绑的是 ${want}：一份文档不能写进两个工程的账`,
  );
}

/**
 * 唯一的写库出口。**只有写**：读路径（`loadProject` = 快照 + 重放）与 `closeProject` 在 T5。
 * 拆成两个任务是故意的 —— 写路径每一发都要能独立证"要么全写要么全无"，
 * 读路径要证的是"盘上的账能自洽地还原成一份文档"，两批用例混在一个文件里只会互相遮蔽。
 */
export class ProjectRepository {
  constructor(
    private readonly pool: Pool,
    private readonly projectId: EntityId,
    private readonly actor: string,
  ) {
    if (actor.length < 1 || actor.length > 64) {
      throw new RangeError(
        `actor 长度必须在 1..64（command_log.actor 是 VARCHAR(64)），收到 ${JSON.stringify(actor)}`,
      );
    }
  }

  async createProject(input: {
    readonly name: string;
    readonly schemaVersion: number;
  }): Promise<void> {
    if (input.name === '' || input.name !== input.name.trim()) {
      throw new RangeError('工程名不能为空或带首尾空白：存储层不替调用方修手滑');
    }
    if (input.name.length > 200) {
      throw new RangeError(
        `工程名不能超过 200 个字符（project.name 是 VARCHAR(200)），收到 ${input.name.length}`,
      );
    }
    if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) {
      throw new RangeError(`schemaVersion 必须是正整数，收到 ${input.schemaVersion}`);
    }
    await this.pool.query(
      'INSERT INTO `project` (`id`, `schema_version`, `name`, `journal_turn`, `clean_shutdown`) VALUES (?, ?, ?, 0, 1)',
      [this.projectId, input.schemaVersion, input.name],
    );
  }

  /**
   * 一发 turn = 一个事务：归属预检（**在任何写之前**）→ 锁 project 行 → 写日志 →
   * 改 element 投影 → 改 storey 投影 → 记 turn。
   * 中间任何一处失败 ⇒ 全没有（`repository.test.ts` 那一格用外部行锁把失败点砸在正中间）。
   */
  async appendJournal(entry: JournalEntry): Promise<JournalOutcome> {
    const turn = JournalTurnSchema.parse(entry.turn);
    const { patch, doc } = entry;
    if (doc.projectId !== this.projectId) {
      throw notThisProject('文档', doc.projectId, this.projectId);
    }
    // 楼层的归属预检必须在这里，不能在投影那一趟 —— 挪到后面就等于"先写一半再抛"，
    // 那时靠回滚兜住（第 8 格判的就是这个位置：element 一行都不许有）。
    for (const entity of patch.upsert) {
      if (entity.kind === 'storey' && entity.projectId !== this.projectId) {
        throw notThisProject(`楼层 ${entity.id}`, entity.projectId, this.projectId);
      }
    }

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      // 所有写都在这一发行锁之后串行：两台机器打开同一工程时第二个必须排队，
      // 于是"跳号"与"重复 turn"都能在同一个读数上判出来，而不是靠两边的时钟。
      const [locked] = await conn.query(
        'SELECT `journal_turn` FROM `project` WHERE `id` = ? FOR UPDATE',
        [this.projectId],
      );
      const row = (locked as { journal_turn: number | string }[])[0];
      if (!row) throw new RangeError(`工程 ${this.projectId} 在盘上没有 project 行：先 createProject`);
      const journalTurn = Number(row.journal_turn);

      if (turn <= journalTurn) {
        // 幂等出口（P-6）：同一发重放不是错误，是"已经落过盘"。
        await conn.commit();
        return 'already-applied';
      }
      if (turn !== journalTurn + 1) {
        throw new RangeError(
          `journal turn 跳号：盘上记到 ${journalTurn}，这发要写 ${turn} —— ` +
            `中间那一发去哪了没查清之前，不许往账上写`,
        );
      }

      const [logRes] = await conn.query(
        'INSERT INTO `command_log` (`project_id`, `turn`, `actor`, `payload`) VALUES (?, ?, ?, ?)',
        [this.projectId, turn, this.actor, encodePatch(patch)],
      );
      const seq = hdr(logRes).insertId;

      for (const id of patch.remove) {
        const [del] = await conn.query(
          'DELETE FROM `element` WHERE `id` = ? AND `project_id` = ?',
          [id, this.projectId],
        );
        if (hdr(del).affectedRows !== 1) {
          throw new RangeError(
            `盘上没有可删的 element ${id}（工程 ${this.projectId}）：` +
              `日志说要删的东西表上没有，两本账已经不对齐`,
          );
        }
        // 楼层行跟着没（P-7 的投影）。对非楼层 id 这一发删 0 行，无所谓：
        // 改成"先查 kind 再决定删不删"要多一次往返，还多一条"查到的 kind 与删的时候不一致"的窗口。
        await conn.query(
          'DELETE FROM `storey` WHERE `id` = ? AND `project_id` = ?',
          [id, this.projectId],
        );
      }

      for (const entity of patch.upsert) {
        await conn.query(
          'INSERT INTO `element` (`id`, `project_id`, `storey_id`, `payload`, `updated_seq`) VALUES (?, ?, ?, ?, ?) ' +
            'AS new ON DUPLICATE KEY UPDATE `storey_id` = new.`storey_id`, ' +
            '`payload` = new.`payload`, `updated_seq` = new.`updated_seq`',
          [entity.id, this.projectId, storeyIdOf(entity), encodeEntity(entity), seq],
        );
      }

      for (const entity of patch.upsert) {
        if (entity.kind !== 'storey') continue;
        await conn.query(
          'INSERT INTO `storey` (`id`, `project_id`, `index_no`, `elevation_mm`, `height_mm`) VALUES (?, ?, ?, ?, ?) ' +
            'AS new ON DUPLICATE KEY UPDATE `index_no` = new.`index_no`, ' +
            '`elevation_mm` = new.`elevation_mm`, `height_mm` = new.`height_mm`',
          [entity.id, this.projectId, entity.index, entity.elevationMm, entity.heightMm],
        );
      }

      // updated_at 本来就有 ON UPDATE CURRENT_TIMESTAMP(3)，这里再写一次 NOW(3) 是把它钉在
      // "服务端时钟"上（P-4）：以后谁改了默认值口径，这一发还是同一个读数来源。
      await conn.query(
        'UPDATE `project` SET `journal_turn` = ?, `updated_at` = NOW(3) WHERE `id` = ?',
        [turn, this.projectId],
      );
      await conn.commit();
      return 'applied';
    } catch (err) {
      try {
        await conn.rollback();
      } catch {
        // 连接已经死了（KILL / 断网）：回滚由服务端做。这里吞掉第二个错误，
        // 否则调用方读到的是"回滚失败"，真因（那一条 SQL 为什么失败）反而看不见。
      }
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * 裸 INSERT（P-16）：同一个 turn 落两份快照说明 autosave 的触发判定漂了，
   * 让 `uk_project_turn` 当场抛比 `ON DUPLICATE KEY UPDATE` 静默覆盖更容易查。
   * 与 `appendJournal` **故意不在同一事务**：快照是可选加速件，写失败时"少一份快照"
   * 必须能用重放补回来，而不是把已经成立的那一发日志一起回滚掉。
   */
  async writeSnapshot(turn: number, doc: Document): Promise<void> {
    const t = JournalTurnSchema.parse(turn);
    if (doc.projectId !== this.projectId) {
      throw notThisProject('文档', doc.projectId, this.projectId);
    }
    await this.pool.query(
      'INSERT INTO `snapshot` (`project_id`, `journal_turn`, `schema_version`, `payload`) VALUES (?, ?, ?, ?)',
      [this.projectId, t, doc.schemaVersion, encodeDocument(doc)],
    );
  }
}
```

Run（先确认环境变量，再跑连库那一档）：

```bash
node -e "console.log(process.env.DAJIA_MYSQL_DATABASE)"
npx vitest run --config vitest.db.config.ts apps/desktop/test/db/repository.test.ts > tmp/t4-repo.log 2>&1; echo "exit=$?"
```

Expected: 在 Step 6 写完、Step 7 没写时跑一发，必须红在 `Cannot find module .../repository`（不是红在环境变量或建库权限）。Step 7 写完 ⇒ `exit=0`、20 条全绿。**`DAJIA_MYSQL_DATABASE` 那一发只打印库名，口令一律不回显。**

- [ ] **Step 8: 全量复跑与计数**

```bash
pnpm verify > tmp/t4-verify.log 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' tmp/t4-verify.log | grep -E "^ *(Test Files|Tests) "
pnpm test:db > tmp/t4-db.log 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' tmp/t4-db.log | grep -E "^ *(Test Files|Tests) |FAIL"
```

Expected（`pnpm verify`）：`exit=0`；`Test Files` **40 → 42**（`codec.test.ts` 12 条 + `entity-shape.test.ts` 2 条；`test/db/**` 不进这里），`Tests` = **Task 3 的实测回填值 + 14**。若 Task 3 回填不是 535，以回填为准加 14。
Expected（`pnpm test:db`）：`exit=0`；条数 = `env.test.ts` 3 + `migrate.test.ts` 的 T2 回填值 + `repository.test.ts` 20。`lint:deps` 照旧静默（本任务没新增 `@dajia/*` 边：desktop → core/protocol 是既有许可）。

跑完必须确认库里干净（`dajia_test` 已被 `afterAll` 删掉，且**其余用户库一个不少**）：

```bash
node -e "const{createPool}=require('mysql2/promise');(async()=>{const p=createPool({host:process.env.DAJIA_MYSQL_HOST,port:+process.env.DAJIA_MYSQL_PORT,user:process.env.DAJIA_MYSQL_USER,password:process.env.DAJIA_MYSQL_PASSWORD});const[r]=await p.query('SHOW DATABASES');console.log(r.map(x=>Object.values(x)[0]).join(' '));await p.end();})()"
```

（这一发**从 `apps/desktop` 目录跑**：`node -e` 按 cwd 解析裸说明符，pnpm 把 `mysql2` 只放在 `apps/desktop/node_modules` 里。T2 Step 6 那条同形的命令同理。）Expected: 输出里**没有** `dajia_test`，也没有 `dajia`（它归 T11 的闸门在 `DAJIA_MYSQL_DATABASE=dajia` 时才碰）。

- [ ] **Step 9: 提交**

```bash
git status --porcelain
git diff
git add packages/protocol/src/entity-schema.ts apps/desktop/src/main/db/codec.ts \
  apps/desktop/src/main/db/pool.ts apps/desktop/src/main/db/repository.ts \
  apps/desktop/test/unit/codec.test.ts apps/desktop/test/unit/entity-shape.test.ts \
  apps/desktop/test/db/repository.test.ts
git commit -m "$(cat <<'EOF'
feat(persist): 盘上编解码与写路径 —— 一发 turn 一个事务、turn 幂等、半途掐断全无账

codec 只做字节（encode 不是校验器：JSON.stringify(-0) 是 "0"），zod 出口留在 protocol
因为 apps/desktop 不装 zod；repository.appendJournal 在任何写之前做归属预检，
之后锁 project 行、串五条语句，幂等靠 (project_id, turn)，跳号与 remove 撞空行都抛且整体回滚。
半途失败那一格用外部连接持行锁 + 会话级 innodb_lock_wait_timeout 制造（P-15），
产品代码里一个测试钩子都没留。
EOF
)"
```

---

**Task 4 的改坏验证**（变异棒，`cp` 备份 + md5 还原；**座位不许 `git checkout`/`restore`/`stash`/`reset`/`clean`**）：

| # | 改坏 | 预期 |
|---|---|---|
| T4-M1 | 删掉 `if (turn !== journalTurn + 1) throw` 那一段 | 「跳号 ⇒ 抛」红：`rejects.toThrow` 拿不到抛，且四张表都有账 |
| T4-M2 | 幂等出口 `turn <= journalTurn` 改成 `turn < journalTurn` | 「同一 turn 重发」红：第二发改成撞 `uk_project_turn` 抛（不是 `already-applied`） |
| T4-M3 | 删掉 `storey` 投影那一段 | 「四处同时有账」红在 `count('storey')`。**登记一条限度**：把那一段**挪到 `commit()` 之后**这一型本任务抓不到（失败路径走不到那一发）；处置是 T5 的 `closeProject()` 逐行对账 |
| T4-M4 | `catch` 里去掉 `await conn.rollback()` | 「半途掐断」那一格的重发红：未回滚的事务被下一次 `BEGIN` 隐式提交 ⇒ `INSERT` 撞 `uk_project_turn` ⇒ 拿不到 `'applied'` |
| T4-M5 | `finally` 里去掉 `conn.release()` | 同一格红在**超时**（`connectionLimit: 1`，重发拿不到连接）。读数时先在 `tmp/t4-repo.log` 里确认它卡在 `getConnection`，别把它当"MySQL 慢"放过 |
| T4-M6 | `OpeningSchema.category` 的 `z.enum(['door','window'])` → `z.string()` | Task 3 的行为与对账用例**全绿**；只有 `npx tsc --noEmit -p apps/desktop/tsconfig.test.json` 红（报在 `entity-shape.test.ts` 与 `codec.ts` 两处）。**这一型只有编译期看得见** —— Step 4 那一档存在的全部理由 |
| T4-M7 | `asJsonValue` 删掉 `typeof raw === 'string'` 那一支 | 若 Step 1 的 A 档 = `string`：「canonical() 逐字节相同」当场红（把整串当对象喂 zod）。若 A 档 = `object`：这一发**没有任何用例变红** ⇒ 登记为已知限度（那一支的存在理由写在注释里，不靠变异证，也不许反过来把它删了"保持精简"） |
| T4-M8 | `encodeDocument` 去掉 `.sort(byId)` | 「entities 按 id 升序」那一格红。注意 `canonical()` 自己排序，所以"往返逐字节相同"**不会**红 —— 这就是第 9 格要单独钉形状的原因 |
| T4-M9 | `decodeDocument` 的重复 id 检查删掉 | 「同一 id 出现两次 ⇒ 抛」红：`Map.set` 静默取后者，`decode` 不抛且 `entities.size` 变小 |
| T4-M10 | `writeSnapshot` 的裸 `INSERT` 换成 `... AS new ON DUPLICATE KEY UPDATE payload = new.payload` | 「同一 turn 两份快照 ⇒ 抛」红（拿不到抛）。这一发就是 P-16 选型的凭据 |
| T4-M11 | `remove` 分支的 `affectedRows !== 1` guard 删掉 | 「remove 撞空行」那一格红：手工抹掉的那一行删 0 行也不抛，turn 3 顺利落账 |
| T4-M12 | 把楼层归属预检从 `getConnection` 之前挪到投影那一趟（回到"先写 element 再抛"） | 「楼层实体属于别的工程」红在 `count('element')` —— 这一格判的就是**位置**，不是"抛没抛" |
| T4-M13 | `repository.test.ts` 里把 `SELECT DATABASE()` 的期望值从 `'dajia_test'` 改成 `'dajia'` | 当场红 —— 证明这一格真在读连接指向的库。**反向那一发（把 `createDbPool({ ...env, database: DATABASE })` 改回 `createDbPool(env)`）本计划禁止真跑**：`migrate` 的 `CREATE TABLE` 不带库限定，跟着连接的默认库走 ⇒ 会把表建进 `dajia`（那正是这条守卫存在的理由） |
| T4-M14 | `clearAll()` 改成只 `DELETE FROM \`element\``（不清 project） | 「project 行落账」或「同一个 id 建两次」红：跨用例的状态泄漏就是"上一发用例替下一发铺好数据"那种查不清的红。这一发证明 `beforeEach` 真在守事 |


## Task 5: 读路径与收尾对账（`loadProject` + `closeProject` + `reconcile.ts`）

**Files:**
- Create: `apps/desktop/src/main/db/reconcile.ts`
- Create: `apps/desktop/test/unit/reconcile.test.ts`
- Modify: `apps/desktop/src/main/db/repository.ts`（加 `loadProject` / `closeProject`；把 T4 那份模块私有 `storeyIdOf` 移进 `reconcile.ts` 改成 import；`Document` 从 type import 升成值 import）
- Modify: `apps/desktop/src/main/db/pool.ts`（只加注释：`supportBigNumbers` 的读者从一格变成两格）
- Create: `apps/desktop/test/db/journal.test.ts`

**Interfaces:**
- Consumes: T2 的 `createDbPool` / `migrate` / `ensureDatabase` / `dropTestDatabase`；T3 的 `assertTruthSourceInvariants` 与 `SCHEMA_VERSION`；T4 的 `ProjectRepository`（`createProject` / `appendJournal` / `writeSnapshot`）、`decodeEntity` / `decodePatch` / `decodeDocument` / `encodeDocument` / `encodePatch`、`PoolOptions.lockWaitTimeoutSeconds`；core 的 `Document` / `applyPatch` / `storeyCreate` / `wallCreate` / `wallDelete` / `wallSetLoadBearing`
- Produces:
  - reconcile：`type Pair = 'document↔element' | 'element.storey_id↔payload' | 'element↔storey'`、`type Problem = 'left-only' | 'right-only' | 'differs'`、`interface Mismatch { pair; id; problem; fields }`、`interface ElementRowView { id; storeyId; entity }`、`interface StoreyRowView { id; indexNo; elevationMm; heightMm }`、`storeyIdOf(entity: Entity): EntityId | null`、`diffStoreyProjection(storeyEntities, storeyRows)`、`diffStoreyIdColumn(elementRows)`、`diffDocAgainstElement(doc, elementRows)`、`reconcileProjection(doc, elementRows, storeyRows)`、`formatMismatches(projectId, mismatches)`、`MISMATCH_REPORT_CAP = 12`
  - repository：`type OpenIntent = 'edit' | 'read'`、`interface ProjectHeader { projectId; name; schemaVersion; journalTurn; wasCleanShutdown }`、`interface LoadOutcome { doc; header; snapshot: { seq; turn } | null; replayed: { rows; fromSeq: number | null; toSeq: number | null } }`、`interface CloseReport { elementRows; storeyRows }`、`loadProject(intent: OpenIntent): Promise<LoadOutcome>`、`closeProject(doc: Document): Promise<CloseReport>`
  - 交给 T8 的口子：`header.wasCleanShutdown`（恢复横幅的唯一来源）、`replayed.rows`（「有 N 发未落快照的变更已取回」那句的数）、`header.name`（标题栏）

**① 为什么加载以日志为准、投影不参与加载**：Architecture ④ 写死了「`element`/`storey` 是投影，不是加载源」。加载只读三样：`project` 头、`snapshot` 最新一行、其后的 `command_log`。把 `element` 升格成加载源，会让"库里存了什么"有两个答案（日志说做过、投影说没做），而这两个答案漂开时恰好是本计划最难查的一型。投影的读者全在对账点上：每个 turn 写完由 T4 的四方对账当场审，收尾时由 `closeProject` 再审一遍 —— 两层都有人看，读路径保持单一来源。

**② 为什么 `loadProject` 顺手把 `clean_shutdown` 抹成 0，以及为什么它带一个 `intent` 参数**：spec §9 的「启动时若发现未合并片段走恢复流程」需要"上一会话有没有告别"这一格，唯一诚实的落点就是"读它的那一刻"。但旁观者不能参与：T6 拿不到锁的那个实例只读，它要是也去抹这一格，写者的告别信号就被一个没在编辑的人写脏了。于是 `'read'` 支**既不锁行也不写**，`'edit'` 支才 `FOR UPDATE` 并落 0。两支各有一格用例（`read 意图只读不写` / `连开两次`）。
另有一条实现纪律要写进代码注释：那两条 `UPDATE clean_shutdown` **都不许加 `affectedRows === 1` 断言** —— MySQL 的 `affectedRows` 数的是真发生变化的行，重复打开时 `0 → 0` 返回 0，加了断言就把"重复打开"这条正当路径变成红。`连开两次` 那一格正是这条纪律的证人（变异样本 T5-M15 去给它加断言，它必须红）。

**③ 为什么 `storeyIdOf` 从 repository 挪进 reconcile**：`element.storey_id` 这一列由写路径填、由对账路径审。规则是"楼层实体自己就是层 ⇒ 列为 null；别的四类带 storeyId"，一份规则两个读者。留在 `repository.ts` 里再让 `reconcile.ts` 复制一份，就是 T3 的 `assertNoVerticalOverlap` 同族。挪动只改归属，不改语义；T4 那条用例（楼层行 `storey_id IS NULL` 且 `count(... NOT NULL) === 3`）一字不动地继续成立，它就是这次挪动的回归证人。

**④ 为什么 `closeProject` 吃 `doc` 参数，明明主进程不持文档**：P-9 说的是 main **不拥有**文档对象图，不是它一辈子不许看见文档。收尾那一步 renderer 本来就要把终态递过来（emergency 快照走的是同一条路，P-10），于是对账能做三方：文档 ↔ `element` ↔ `storey`。三方抓的正是"渲染器内存里画了但那一发没落盘"（`文档多一发`）与"落盘了但投影漂了"（`storey 表少一行`）这两型，而这两型在别处都没有读者。对账不平 ⇒ 抛且不落 `clean_shutdown = 1` ⇒ 下次打开出恢复告知；真源仍以 `command_log` 为准，投影由下一次写入重建。

**⑤ 为什么对账分三对而不是一场 JOIN**：`document↔element` 与 `element↔storey` 的左右两侧来自**不同的读**（文档来自 renderer，两张表来自 SQL），一场 JOIN 无法把文档放进去。更重要的是纯函数才有 CI 那一档：三对判据住 `reconcile.ts`，`apps/desktop/test/unit/reconcile.test.ts` 在没库的 CI 上就能红；连库那一档只证"SQL 真把行喂进来了"。这正是 P-2 那条禁令想要的形状（`db/**` 不 import electron，纯 node 可测）。

- [ ] **Step 1: 先写不连库的那一档 —— `reconcile.test.ts`（CI 有牙）**

`apps/desktop/test/unit/reconcile.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  Document,
  type Entity,
  type EntityId,
  type StoreyEntity,
  type WallEntity,
} from '@dajia/core';
import {
  MISMATCH_REPORT_CAP,
  diffDocAgainstElement,
  diffStoreyIdColumn,
  diffStoreyProjection,
  formatMismatches,
  reconcileProjection,
  storeyIdOf,
  type ElementRowView,
  type StoreyRowView,
} from '../../src/main/db/reconcile';

const PID = '0193aa00-0000-7000-8000-00000000000a';
const S1 = '0193aa00-0000-7000-8000-000000000001';
const P1 = '0193aa00-0000-7000-8000-000000000002';
const P2 = '0193aa00-0000-7000-8000-000000000003';
const W1 = '0193aa00-0000-7000-8000-000000000004';
const W2 = '0193aa00-0000-7000-8000-00000000000c';
const GHOST = '0193bb00-0000-7000-8000-000000000001';

const storey: StoreyEntity = {
  kind: 'storey',
  id: S1,
  projectId: PID,
  index: 0,
  elevationMm: 0,
  heightMm: 3000,
};
const wall: WallEntity = {
  kind: 'wall',
  id: W1,
  storeyId: S1,
  startId: P1,
  endId: P2,
  thicknessMm: 200,
  heightMm: 2800,
  elevationOffsetMm: 0,
  loadBearing: true,
  material: '混凝土',
};
const doc = Document.replaceEntities(
  Document.create(PID),
  new Map<EntityId, Entity>([
    [S1, storey],
    [W1, wall],
  ]),
);

/**
 * 平账的那份"盘上应该长什么样"由真源现推，不手抄 —— 手抄的基线会跟着夹具一起漂，
 * 那一型本档抓不住（`storeyIdOf` 就是写列与审列共用的那份规则，见 T5-M14）。
 */
function flatElementRows(): ElementRowView[] {
  return [...doc.entities.values()].map((entity) => ({
    id: entity.id,
    storeyId: storeyIdOf(entity),
    entity,
  }));
}
function flatStoreyRows(): StoreyRowView[] {
  return [
    { id: S1, indexNo: storey.index, elevationMm: storey.elevationMm, heightMm: storey.heightMm },
  ];
}
function withoutId(rows: readonly ElementRowView[], id: EntityId): ElementRowView[] {
  return rows.filter((r) => r.id !== id);
}

describe('平账的形状', () => {
  it('盘上照抄真源时，三对都是空', () => {
    expect(reconcileProjection(doc, flatElementRows(), flatStoreyRows())).toEqual([]);
  });

  it('storeyIdOf：楼层自己就是层 ⇒ null；别的四类 ⇒ 带着自己的 storeyId', () => {
    expect(storeyIdOf(storey)).toBeNull();
    expect(storeyIdOf(wall)).toBe(S1);
  });
});

describe('element ↔ storey（P-7 的投影）', () => {
  it('storey 表少一行 ⇒ 只在左侧（element 有楼层行，storey 表没有）', () => {
    expect(diffStoreyProjection([storey], [])).toEqual([
      { pair: 'element↔storey', id: S1, problem: 'left-only', fields: [] },
    ]);
  });

  it('storey 表多一行 ⇒ 只在右侧（投影漂的另一半）', () => {
    const ghost: StoreyRowView = { id: GHOST, indexNo: 0, elevationMm: 0, heightMm: 3000 };
    expect(diffStoreyProjection([], [ghost])).toEqual([
      { pair: 'element↔storey', id: GHOST, problem: 'right-only', fields: [] },
    ]);
  });

  it('标高差 1 毫米也要点名是哪个字段（整行比会把这条线索抹掉）', () => {
    const row: StoreyRowView = { id: S1, indexNo: 0, elevationMm: 1, heightMm: 3000 };
    expect(diffStoreyProjection([storey], [row])).toEqual([
      { pair: 'element↔storey', id: S1, problem: 'differs', fields: ['elevationMm'] },
    ]);
  });

  it('序号、标高、层高各归各的字段：三处一起漂就报三个名字，且按名序', () => {
    const row: StoreyRowView = { id: S1, indexNo: 7, elevationMm: -300, heightMm: 2900 };
    expect(diffStoreyProjection([storey], [row])).toEqual([
      {
        pair: 'element↔storey',
        id: S1,
        problem: 'differs',
        fields: ['elevationMm', 'heightMm', 'indexNo'],
      },
    ]);
  });

  it('-0 与 0 不算相等（Object.is 口径；与 codec 侧"盘上不存 -0"的实测互补）', () => {
    const negative: StoreyEntity = { ...storey, elevationMm: -0 };
    expect(diffStoreyProjection([negative], flatStoreyRows())).toEqual([
      { pair: 'element↔storey', id: S1, problem: 'differs', fields: ['elevationMm'] },
    ]);
  });
});

describe('element.storey_id 列 ↔ 同一行的 payload', () => {
  it('列指错层 ⇒ 抓到（idx_storey_kind 会静默少查一面墙，那一型没人看得见）', () => {
    const rows: ElementRowView[] = [{ id: W1, storeyId: P1, entity: wall }];
    expect(diffStoreyIdColumn(rows)).toEqual([
      { pair: 'element.storey_id↔payload', id: W1, problem: 'differs', fields: ['storeyId'] },
    ]);
  });

  it('楼层行把 storey_id 写成了自己的 id ⇒ 抓到（该为 null 的那一型）', () => {
    const rows: ElementRowView[] = [{ id: S1, storeyId: S1, entity: storey }];
    expect(diffStoreyIdColumn(rows)).toEqual([
      { pair: 'element.storey_id↔payload', id: S1, problem: 'differs', fields: ['storeyId'] },
    ]);
  });
});

describe('文档 ↔ element', () => {
  it('文档多一发（渲染器画了但那一发没落盘）⇒ 只在左侧', () => {
    const extra: WallEntity = { ...wall, id: W2, loadBearing: false };
    const bigger = Document.replaceEntities(
      doc,
      new Map<EntityId, Entity>([
        [S1, storey],
        [W1, wall],
        [W2, extra],
      ]),
    );
    expect(diffDocAgainstElement(bigger, flatElementRows())).toEqual([
      { pair: 'document↔element', id: W2, problem: 'left-only', fields: [] },
    ]);
  });

  it('盘上残留一行（文档已经删了）⇒ 只在右侧', () => {
    const extra: WallEntity = { ...wall, id: W2, loadBearing: false };
    expect(
      diffDocAgainstElement(doc, [...flatElementRows(), { id: W2, storeyId: S1, entity: extra }]),
    ).toEqual([{ pair: 'document↔element', id: W2, problem: 'right-only', fields: [] }]);
  });

  it('同一 id 的 payload 字段不等 ⇒ 报字段名', () => {
    const rows = flatElementRows().map((r) =>
      r.id === W1 ? { ...r, entity: { ...wall, thicknessMm: 240 } } : r,
    );
    expect(diffDocAgainstElement(doc, rows)).toEqual([
      { pair: 'document↔element', id: W1, problem: 'differs', fields: ['thicknessMm'] },
    ]);
  });

  it('键序不同不算漂（判据取键集合，不是 stringify 出来的串）', () => {
    const shuffled: Entity = {
      thicknessMm: 200,
      material: '混凝土',
      endId: P2,
      startId: P1,
      elevationOffsetMm: 0,
      loadBearing: true,
      heightMm: 2800,
      kind: 'wall',
      storeyId: S1,
      id: W1,
    };
    const rows = [...withoutId(flatElementRows(), W1), { id: W1, storeyId: S1, entity: shuffled }];
    expect(diffDocAgainstElement(doc, rows)).toEqual([]);
  });

  it('文档侧的 -0 也抓到（与投影侧同一口径）', () => {
    const negative: StoreyEntity = { ...storey, elevationMm: -0 };
    const rows = [...withoutId(flatElementRows(), S1), { id: S1, storeyId: null, entity: negative }];
    expect(diffDocAgainstElement(doc, rows)).toEqual([
      { pair: 'document↔element', id: S1, problem: 'differs', fields: ['elevationMm'] },
    ]);
  });
});

describe('合成与报告文案', () => {
  it('超出上限只列前 12 处，但把总数说全（对账结果要进日志，条数不许骗人）', () => {
    const ghosts: StoreyRowView[] = [];
    for (let i = 0; i < 15; i += 1) {
      ghosts.push({
        id: `0193bb00-0000-7000-8000-0000000000${String(i).padStart(2, '0')}`,
        indexNo: 0,
        elevationMm: 0,
        heightMm: 3000,
      });
    }
    const mismatches = diffStoreyProjection([], ghosts);
    expect(mismatches).toHaveLength(15);
    const text = formatMismatches(PID, mismatches);
    expect(text).toContain('15 处');
    expect(text).toContain(`另有 ${String(15 - MISMATCH_REPORT_CAP)} 处未列出`);
    expect(text.split('\n').filter((l) => l.startsWith('  - '))).toHaveLength(MISMATCH_REPORT_CAP);
    expect(text).toContain('command_log');
  });

  it('平账时不产出任何条目行（repository 只在 length > 0 时才调它，这一格证它自己不编话）', () => {
    const lines = formatMismatches(PID, []).split('\n');
    expect(lines.filter((l) => l.startsWith('  - '))).toEqual([]);
    expect(lines[0]).toContain(PID);
  });

  it('输出顺序确定：先按对、再按 id（两份日志要能人肉比对）', () => {
    const extra: WallEntity = { ...wall, id: W2, loadBearing: false };
    const rows = [...flatElementRows(), { id: W2, storeyId: S1, entity: extra }];
    const storeyRows = [...flatStoreyRows(), { id: GHOST, indexNo: 0, elevationMm: 0, heightMm: 3000 }];
    expect(reconcileProjection(doc, rows, storeyRows).map((m) => `${m.pair}|${m.id}`)).toEqual([
      `document↔element|${W2}`,
      `element↔storey|${GHOST}`,
    ]);
  });
});
```

Run: `npx vitest run apps/desktop/test/unit/reconcile.test.ts > tmp/t5-reconcile.log 2>&1; echo "exit=$?"`
Expected: `exit=1` —— 找不到 `../../src/main/db/reconcile`。

- [ ] **Step 2: 写 `reconcile.ts`（纯函数：无 DB、无 electron、无 zod）**

`apps/desktop/src/main/db/reconcile.ts`

```ts
import {
  type Document,
  type Entity,
  type EntityId,
  type StoreyEntity,
} from '@dajia/core';

/**
 * 三方对账的判据，纯函数。住 `db/` 而不进 core：它审的是"存储层的双写"，
 * core 不该知道 `storey` 表存在（P-7 是存储决定，不是真源决定）。
 * 不连库 ⇒ CI 有牙（`apps/desktop/test/unit/reconcile.test.ts`）；连库那一档只证 SQL 真把行喂进来了。
 *
 * 三个 `pair` 的左右两侧由名字里的顺序定（`element↔storey` = 左 element 右 storey），
 * `left-only` / `right-only` 一律按这个名字读，别在文案里再解释一遍方向。
 */
export type Pair = 'document↔element' | 'element.storey_id↔payload' | 'element↔storey';
export type Problem = 'left-only' | 'right-only' | 'differs';

export interface Mismatch {
  readonly pair: Pair;
  readonly id: EntityId;
  readonly problem: Problem;
  /** `differs` 时列出不相等的字段名（按名序）；另两型为空。 */
  readonly fields: readonly string[];
}

export interface ElementRowView {
  readonly id: EntityId;
  /** `element.storey_id` 列的原样读数（楼层行为 null）。 */
  readonly storeyId: EntityId | null;
  /** 同一行 payload 解出来的实体。列与正文自比用得到它，所以这一列不是多余的。 */
  readonly entity: Entity;
}

export interface StoreyRowView {
  readonly id: EntityId;
  readonly indexNo: number;
  readonly elevationMm: number;
  readonly heightMm: number;
}

/** 报告最多列几条。对账不平一次能漂几百行，全列出来没人读，且会把真因挤出日志。 */
export const MISMATCH_REPORT_CAP = 12;

/**
 * `element.storey_id` 该填什么。**写路径（T4 的 appendJournal）与对账路径共用这一份**，
 * T4 里那个模块私有版搬到这里：一份规则两个读者，就不会自己跟自己漂。
 * 代价写在 T5-M14：列由这份规则写、又由同一份规则审，规则自己漂了自比看不见，
 * 所以外部证人（T4 那条读列实测值的库用例）必须留着。
 */
export function storeyIdOf(entity: Entity): EntityId | null {
  return entity.kind === 'storey' ? null : entity.storeyId;
}

function byId(a: { id: EntityId }, b: { id: EntityId }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byPairThenId(a: Mismatch, b: Mismatch): number {
  if (a.pair !== b.pair) return a.pair < b.pair ? -1 : 1;
  return byId(a, b);
}

function indexBy<T extends { id: EntityId }>(items: Iterable<T>): Map<EntityId, T> {
  const map = new Map<EntityId, T>();
  for (const item of items) map.set(item.id, item);
  return map;
}

/**
 * 逐字段比，用 `Object.is`：0 与 -0 在这里不算相等（codec 那侧实测"盘上不存 -0"，这一句是"万一存了要能看出来"）。
 * 取两侧键的并集 ⇒「少一个键」与「键的值不同」都落到字段名上，而不是只报"整串不等"。
 */
function differingFields(a: Entity, b: Entity): string[] {
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort();
  return keys.filter((k) => !Object.is(ra[k], rb[k]));
}

/** 左侧 = `element` 里的楼层行（由 payload 解出），右侧 = `storey` 表。 */
export function diffStoreyProjection(
  storeyEntities: readonly StoreyEntity[],
  rows: readonly StoreyRowView[],
): Mismatch[] {
  const out: Mismatch[] = [];
  const right = indexBy(rows);
  for (const entity of [...storeyEntities].sort(byId)) {
    const row = right.get(entity.id);
    if (!row) {
      out.push({ pair: 'element↔storey', id: entity.id, problem: 'left-only', fields: [] });
      continue;
    }
    right.delete(entity.id);
    const fields: string[] = [];
    if (!Object.is(entity.elevationMm, row.elevationMm)) fields.push('elevationMm');
    if (!Object.is(entity.heightMm, row.heightMm)) fields.push('heightMm');
    if (!Object.is(entity.index, row.indexNo)) fields.push('indexNo');
    if (fields.length > 0) {
      out.push({ pair: 'element↔storey', id: entity.id, problem: 'differs', fields });
    }
  }
  for (const row of [...right.values()].sort(byId)) {
    out.push({ pair: 'element↔storey', id: row.id, problem: 'right-only', fields: [] });
  }
  return out;
}

/**
 * 同一行内部的两列自比：`storey_id` 列 vs 同行 payload 推出来的值。
 * 抓的是"列被手改过"或"写列的规则漂了"。文档不参与 —— 掺进第三方就说不清是谁漂了。
 */
export function diffStoreyIdColumn(rows: readonly ElementRowView[]): Mismatch[] {
  const out: Mismatch[] = [];
  for (const row of [...rows].sort(byId)) {
    if (!Object.is(storeyIdOf(row.entity), row.storeyId)) {
      out.push({
        pair: 'element.storey_id↔payload',
        id: row.id,
        problem: 'differs',
        fields: ['storeyId'],
      });
    }
  }
  return out;
}

/** 左侧 = 真源文档（renderer 递来的终态），右侧 = `element` 投影。 */
export function diffDocAgainstElement(
  doc: Document,
  rows: readonly ElementRowView[],
): Mismatch[] {
  const out: Mismatch[] = [];
  const right = indexBy(rows);
  for (const entity of [...doc.entities.values()].sort(byId)) {
    const row = right.get(entity.id);
    if (!row) {
      out.push({ pair: 'document↔element', id: entity.id, problem: 'left-only', fields: [] });
      continue;
    }
    right.delete(entity.id);
    const fields = differingFields(entity, row.entity);
    if (fields.length > 0) {
      out.push({ pair: 'document↔element', id: entity.id, problem: 'differs', fields });
    }
  }
  for (const row of [...right.values()].sort(byId)) {
    out.push({ pair: 'document↔element', id: row.id, problem: 'right-only', fields: [] });
  }
  return out;
}

/**
 * 收尾对账的唯一入口，三对合成一份、排序后交给 `formatMismatches`。
 * `element↔storey` 的左侧从 **element 行**推（不从文档推）：这一对审的是双写本身，
 * 掺进文档就变成"文档说三遍都对"，那是复制判据不是对账。
 */
export function reconcileProjection(
  doc: Document,
  elementRows: readonly ElementRowView[],
  storeyRows: readonly StoreyRowView[],
): Mismatch[] {
  const storeyEntities: StoreyEntity[] = [];
  for (const row of elementRows) {
    if (row.entity.kind === 'storey') storeyEntities.push(row.entity);
  }
  return [
    ...diffDocAgainstElement(doc, elementRows),
    ...diffStoreyIdColumn(elementRows),
    ...diffStoreyProjection(storeyEntities, storeyRows),
  ].sort(byPairThenId);
}

const PAIR_TEXT: Record<Pair, string> = {
  'document↔element': '文档（真源）↔ element 投影',
  'element.storey_id↔payload': 'element.storey_id 列 ↔ 同一行的 payload',
  'element↔storey': 'element 的楼层行 ↔ storey 表（P-7 的投影）',
};

const PROBLEM_TEXT: Record<Problem, string> = {
  'left-only': '只在左侧有',
  'right-only': '只在右侧有',
  differs: '同 id 的字段不等',
};

export function formatMismatches(projectId: EntityId, mismatches: readonly Mismatch[]): string {
  const head = `工程 ${projectId} 的账对不平（${String(mismatches.length)} 处）：`;
  const shown = mismatches.slice(0, MISMATCH_REPORT_CAP).map((m) => {
    const fields = m.fields.length > 0 ? ` 字段 ${m.fields.join('、')}` : '';
    return `  - ${PAIR_TEXT[m.pair]} / ${PROBLEM_TEXT[m.problem]} / ${m.id}${fields}`;
  });
  const rest =
    mismatches.length > shown.length
      ? [`  - 另有 ${String(mismatches.length - shown.length)} 处未列出`]
      : [];
  return [
    head,
    ...shown,
    ...rest,
    '处置：这一发收尾不落 clean_shutdown=1 —— 真源以 command_log 为准，投影由下一次写入重建；下次打开会出恢复告知。',
  ].join('\n');
}
```

Run: `npx vitest run apps/desktop/test/unit/reconcile.test.ts > tmp/t5-reconcile.log 2>&1; echo "exit=$?"`
Expected: `exit=0`，**16 条**全绿。

再把 `repository.ts` 的 T4 部分按第 ③ 段改口：删掉模块私有 `storeyIdOf` 那三行，`appendJournal` 里的调用不动（名字相同）。

- [ ] **Step 3: 写连库的读路径测试（先红在缺方法，不许红在环境）**

`apps/desktop/test/db/journal.test.ts`

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'mysql2/promise';
import {
  Document,
  SCHEMA_VERSION,
  applyPatch,
  assertTruthSourceInvariants,
  storeyCreate,
  wallCreate,
  wallDelete,
  wallSetLoadBearing,
  type Command,
  type Entity,
  type EntityId,
  type Patch,
} from '@dajia/core';
import { createDbPool } from '../../src/main/db/pool';
import { readMysqlEnv } from '../../src/main/db/env';
import { dropTestDatabase, ensureDatabase } from '../../src/main/db/database';
import { migrate } from '../../src/main/db/migrate';
import { ProjectRepository } from '../../src/main/db/repository';
import { encodeDocument, encodePatch } from '../../src/main/db/codec';

const env = readMysqlEnv();
// 红线同 repository.test.ts：库名由本文件写死，不抄 env（env.database 允许是 dajia）。
const DATABASE = 'dajia_test';
const PROJECT_ID = '0193aa00-0000-7000-8000-00000000000a' as EntityId;
const OTHER_PROJECT = '0193aa00-0000-7000-8000-00000000000f' as EntityId;
const BIG_JOURNAL_TURN = '9007199254740993'; // 2^53 + 1：JS 里存不成整数

let pool: Pool;
let repoPool: Pool;
let repo: ProjectRepository;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [res] = await pool.query(sql, params);
  return res as T[];
}

async function count(table: string, where = '', params: unknown[] = []): Promise<number> {
  const [res] = await pool.query(`SELECT COUNT(*) AS n FROM \`${table}\`${where}`, params);
  return Number((res as { n: number | string }[])[0]?.n);
}

async function cleanShutdown(): Promise<number> {
  const got = await rows<{ clean_shutdown: number | string }>(
    'SELECT `clean_shutdown` FROM `project` WHERE `id` = ?',
    [PROJECT_ID],
  );
  return Number(got[0]?.clean_shutdown);
}

/** 清场同 repository.test.ts：只删 project 行，FK 级联带走其余四张。 */
async function clearAll(): Promise<void> {
  await pool.query('DELETE FROM `project`');
}

/**
 * 夹具与 repository.test.ts 同形，**故意复制而非 import**：import 一个测试文件会把那个文件的
 * 用例一起执行一遍（vitest 按模块跑），那是"一条用例被两个文件各认一次"的另一种发生方式。
 * 复制的是夹具，不是判据 —— 读路径的放行证只有 `loadProject` 里那一份。
 */
function step(doc: Document, cmd: Command): { patch: Patch; doc: Document } {
  const patch = cmd.build(doc);
  return { patch, doc: applyPatch(doc, patch).doc };
}

interface Turn {
  readonly turn: number;
  readonly patch: Patch;
  readonly doc: Document;
}

interface House {
  readonly entries: Turn[];
  readonly storeyId: EntityId;
  readonly wallA: EntityId;
  readonly wallB: EntityId;
}

/**
 * 五发：楼层 → 墙 A → 墙 B（与 A 共端点，于是 A 的起点是它独占的）→ 改 A 的非承重 → 删 A。
 * 第五发带 remove ⇒ 它既是最后一发，也是"重复投喂必炸"的那一发（`快照压在最后一发` 的牙长在这儿）。
 */
function houseTurns(): House {
  const t1 = step(
    Document.create(PROJECT_ID),
    storeyCreate({ projectId: PROJECT_ID, index: 0, elevationMm: 0, heightMm: 3000 }),
  );
  const storeyId = (t1.patch.upsert.find((e) => e.kind === 'storey') as Entity).id as EntityId;
  const t2 = step(
    t1.doc,
    wallCreate({
      storeyId,
      start: { x: 0, y: 0 },
      end: { x: 4000, y: 0 },
      thicknessMm: 200,
      heightMm: 2800,
      loadBearing: true,
    }),
  );
  const wallA = (t2.patch.upsert.find((e) => e.kind === 'wall') as Entity).id as EntityId;
  const t3 = step(
    t2.doc,
    wallCreate({
      storeyId,
      start: { x: 4000, y: 0 },
      end: { x: 4000, y: 3000 },
      thicknessMm: 150,
      heightMm: 2800,
    }),
  );
  const wallB = (t3.patch.upsert.find((e) => e.kind === 'wall') as Entity).id as EntityId;
  const t4 = step(t3.doc, wallSetLoadBearing({ wallId: wallA, loadBearing: false }));
  const t5 = step(t4.doc, wallDelete({ wallId: wallA }));
  return {
    entries: [
      { turn: 1, ...t1 },
      { turn: 2, ...t2 },
      { turn: 3, ...t3 },
      { turn: 4, ...t4 },
      { turn: 5, ...t5 },
    ],
    storeyId,
    wallA,
    wallB,
  };
}

/** 建工程 + 把五发按 turn 顺序写进库。返回的 entries[i].doc 就是"第 i+1 发之后的终态"。 */
async function writeHouse(r: ProjectRepository = repo): Promise<House> {
  const house = houseTurns();
  await r.createProject({ name: '读路径样例', schemaVersion: SCHEMA_VERSION });
  for (const entry of house.entries) {
    expect(await r.appendJournal(entry)).toBe('applied');
  }
  return house;
}

const last = (house: House): Document => {
  const entry = house.entries[house.entries.length - 1];
  if (!entry) throw new TypeError('夹具一发都没写，后面的判据都不用读了');
  return entry.doc;
};
const at = (house: House, turn: number): Document => {
  const entry = house.entries[turn - 1];
  if (!entry) throw new TypeError(`夹具没有 turn ${turn}`);
  return entry.doc;
};

beforeAll(async () => {
  await dropTestDatabase(env, DATABASE);
  await ensureDatabase(env, DATABASE);
  pool = createDbPool({ ...env, database: DATABASE });
  await migrate(pool, DATABASE);
  // 与 repository.test.ts 同一条纪律：一条连接 + 1 秒行锁等待 ⇒ 少一次 release() 会当场变成超时，
  // 而不是悄悄多用一条连接把漏检盖住（`读路径不漏连接` 那一格用它）。
  repoPool = createDbPool(
    { ...env, database: DATABASE },
    { connectionLimit: 1, lockWaitTimeoutSeconds: 1 },
  );
  repo = new ProjectRepository(repoPool, PROJECT_ID, 'reader');
});

afterAll(async () => {
  await repoPool.end();
  await pool.end();
  await dropTestDatabase(env, DATABASE);
});

beforeEach(async () => {
  await clearAll();
});

describe('加载 = 最近快照 + 重放其后的日志', () => {
  it('没有快照时全靠重放：五发之后 load 得到同一份文档', async () => {
    const house = await writeHouse();
    const got = await repo.loadProject('edit');
    expect(got.snapshot).toBeNull();
    expect(got.replayed).toEqual({ rows: 5, fromSeq: expect.any(Number), toSeq: expect.any(Number) });
    expect(got.doc.canonical()).toBe(last(house).canonical());
    expect(got.header.journalTurn).toBe(5);
    expect(got.header.name).toBe('读路径样例');
    expect(got.doc.byKind('wall').map((w) => w.id)).toEqual([house.wallB]);
  });

  it('有快照时只重放其后的发：快照落在第 3 发 ⇒ 重放 2 发', async () => {
    const house = await writeHouse();
    await repo.writeSnapshot(3, at(house, 3));
    const got = await repo.loadProject('edit');
    expect(got.snapshot?.turn).toBe(3);
    expect(got.replayed.rows).toBe(2);
    expect(got.doc.canonical()).toBe(last(house).canonical());
  });

  it('快照正好压在最后一发 ⇒ 重放 0 发（`>` 写成 `>=` 就红在这里：第五发的 remove 会被投喂两次）', async () => {
    const house = await writeHouse();
    await repo.writeSnapshot(5, last(house));
    const got = await repo.loadProject('edit');
    expect(got.replayed).toEqual({ rows: 0, fromSeq: null, toSeq: null });
    expect(got.doc.canonical()).toBe(last(house).canonical());
  });

  it('加载出来的文档自己过得了放行证（不是复制判据，是把"load 成功"与"不变式成立"钉在同一份文档上）', async () => {
    await writeHouse();
    const got = await repo.loadProject('edit');
    expect(() => assertTruthSourceInvariants(got.doc)).not.toThrow();
  });

  it('重发旧 turn 说 already-applied，且加载结果逐字节不变（turn 幂等的读侧另一半）', async () => {
    const house = await writeHouse();
    const before = await repo.loadProject('edit');
    const first = house.entries[0];
    const tail = house.entries[4];
    if (!first || !tail) throw new TypeError('夹具塌了');
    expect(await repo.appendJournal(first)).toBe('already-applied');
    expect(await repo.appendJournal(tail)).toBe('already-applied');
    const after = await repo.loadProject('edit');
    expect(after.replayed.rows).toBe(before.replayed.rows);
    expect(after.doc.canonical()).toBe(before.doc.canonical());
    expect(after.header.journalTurn).toBe(5);
  });

  it('seq 可以带洞而 turn 不行：造一发回滚 ⇒ 洞真在盘上，加载照旧（P-6 的凭据）', async () => {
    const house = await writeHouse();
    const removed = house.entries[4]?.patch.remove[0];
    if (!removed) throw new TypeError('第五发没有 remove，夹具塌了');
    // 手搓一发"日志说要删、表上已经没有"的补丁：appendJournal 在 INSERT command_log 之后才抛，
    // 事务回滚 ⇒ 日志行没留下，但那个 AUTO_INCREMENT 值已被 MySQL 吃掉 ⇒ 洞在 max 之后。
    await expect(
      repo.appendJournal({ turn: 6, patch: { upsert: [], remove: [removed] }, doc: last(house) }),
    ).rejects.toThrow(/没有可删的 element/);
    // 洞之后仍要能正常记账：turn 6 现在可以正经写一次（这一发把 seq 推到洞之后）。
    // 注意方向：wallB 是 wallCreate 默认出来的，默认就是承重（`input.loadBearing ?? true`），
    // 所以这一发必须翻成 false 才是一次真变更 —— 写 `true` 它也会落一行，但断言变成同义反复。
    const t6 = step(last(house), wallSetLoadBearing({ wallId: house.wallB, loadBearing: false }));
    expect(await repo.appendJournal({ turn: 6, patch: t6.patch, doc: t6.doc })).toBe('applied');

    const edges = await rows<{ lo: string; hi: string; n: string }>(
      'SELECT MIN(`seq`) AS lo, MAX(`seq`) AS hi, COUNT(*) AS n FROM `command_log` WHERE `project_id` = ?',
      [PROJECT_ID],
    );
    const edge = edges[0];
    if (!edge) throw new TypeError('command_log 一行都没有');
    // 跨度 > 行数 ⇒ 洞真在盘上。**判据只读相对关系**：P-6 之后任何绝对 seq 值每发都在漂。
    expect(Number(edge.hi) - Number(edge.lo) + 1).toBeGreaterThan(Number(edge.n));
    expect(Number(edge.n)).toBe(6);

    const got = await repo.loadProject('edit');
    expect(got.replayed.rows).toBe(6);
    // 断言写 `false` 才有牙：wallB 由 wallCreate 默认出来就是承重 `true`，
    // 只有第六发真进了重放，读到的才是被翻过去的 `false`。
    // 连"只剩这一面墙"一起断，免得 byKind 多塞一行还读成同一个值。
    expect(got.doc.byKind('wall').map((w) => [w.id, w.loadBearing])).toEqual([[house.wallB, false]]);
  });

  it('读到的 turn 序列严格递增，且 ORDER BY seq 与 ORDER BY turn 给出同一个 seq 顺序（"同向"这件事要量，不许默认成立）', async () => {
    await writeHouse();
    const bySeq = await rows<{ seq: string; turn: string }>(
      'SELECT `seq`, `turn` FROM `command_log` WHERE `project_id` = ? ORDER BY `seq` ASC',
      [PROJECT_ID],
    );
    const byTurn = await rows<{ seq: string; turn: string }>(
      'SELECT `seq`, `turn` FROM `command_log` WHERE `project_id` = ? ORDER BY `turn` ASC',
      [PROJECT_ID],
    );
    expect(bySeq.map((r) => r.seq)).toEqual(byTurn.map((r) => r.seq));
    expect(bySeq.map((r) => Number(r.turn))).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('拒开：盘上账本不该被静默圆回来的那些形状', () => {
  it('工程不在库里 ⇒ 拒开，且文案点名它', async () => {
    await repo.createProject({ name: '只建不开', schemaVersion: SCHEMA_VERSION });
    await pool.query('DELETE FROM `project` WHERE `id` = ?', [PROJECT_ID]);
    await expect(repo.loadProject('edit')).rejects.toThrow(new RegExp(`工程 ${PROJECT_ID} 不在库里`));
  });

  it('project.schema_version 与这份程序不符 ⇒ 拒开（不是"能读多少算多少"）', async () => {
    const future = new ProjectRepository(repoPool, OTHER_PROJECT, 'reader');
    await future.createProject({ name: '来自未来', schemaVersion: SCHEMA_VERSION + 98 });
    await expect(future.loadProject('edit')).rejects.toThrow(/schema_version/);
  });

  it('snapshot 列上的 schema_version 与工程头不符 ⇒ 拒开', async () => {
    await writeHouse();
    // Document 的 schemaVersion 只能由 create 定；writeSnapshot 把它同时写进列与 payload。
    await repo.writeSnapshot(5, Document.create(PROJECT_ID, SCHEMA_VERSION + 7));
    await expect(repo.loadProject('edit')).rejects.toThrow(/schema_version/);
  });

  it('snapshot payload 里的 schemaVersion 与工程头不符 ⇒ 也拒开（列与正文是两条支路，各一条牙）', async () => {
    await writeHouse();
    await pool.query(
      'INSERT INTO `snapshot` (`project_id`, `journal_turn`, `schema_version`, `payload`) VALUES (?, ?, ?, ?)',
      [PROJECT_ID, 5, SCHEMA_VERSION, encodeDocument(Document.create(PROJECT_ID, SCHEMA_VERSION + 7))],
    );
    await expect(repo.loadProject('edit')).rejects.toThrow(/payload/);
  });

  it('snapshot payload 的 projectId 是别的工程 ⇒ 拒开（键与正文各说各话时，正文不算数）', async () => {
    await writeHouse();
    await pool.query(
      'INSERT INTO `snapshot` (`project_id`, `journal_turn`, `schema_version`, `payload`) VALUES (?, ?, ?, ?)',
      [PROJECT_ID, 5, SCHEMA_VERSION, encodeDocument(Document.create(OTHER_PROJECT, SCHEMA_VERSION))],
    );
    await expect(repo.loadProject('edit')).rejects.toThrow(new RegExp(`payload 写的是工程 ${OTHER_PROJECT}`));
  });

  it('中间缺一发日志 ⇒ 拒开并说"缺号"（无静默丢失的反面就是静默补洞）', async () => {
    await writeHouse();
    await pool.query('DELETE FROM `command_log` WHERE `project_id` = ? AND `turn` = 3', [PROJECT_ID]);
    await expect(repo.loadProject('edit')).rejects.toThrow(/缺号/);
  });

  it('尾缺一发日志 ⇒ 拒开（逐发连着仍然成立，只有工程头能看出来）', async () => {
    await writeHouse();
    await pool.query('DELETE FROM `command_log` WHERE `project_id` = ? AND `turn` = 5', [PROJECT_ID]);
    await expect(repo.loadProject('edit')).rejects.toThrow(/journal_turn/);
  });

  it('手插一发跳号的日志 ⇒ 拒开（UPDATE 造出来的洞与 DELETE 造出来的洞落在同一条判据的两端）', async () => {
    await writeHouse();
    await pool.query('UPDATE `command_log` SET `turn` = 9 WHERE `project_id` = ? AND `turn` = 5', [PROJECT_ID]);
    await expect(repo.loadProject('edit')).rejects.toThrow(/缺号/);
  });

  it('重放撞空行 ⇒ 抛的文案带 command_log 的行号与 turn（没有坐标的"重放失败"等于没报）', async () => {
    const house = await writeHouse();
    const removed = house.entries[4]?.patch.remove[0];
    if (!removed) throw new TypeError('第五发没有 remove，夹具塌了');
    // 同一发删除投两次（绕过 appendJournal 手插，所以 turn 连着、坐标落在最后一行上）。
    await pool.query(
      'INSERT INTO `command_log` (`project_id`, `turn`, `actor`, `payload`) VALUES (?, ?, ?, ?)',
      [PROJECT_ID, 6, 'attacker', encodePatch({ upsert: [], remove: [removed] })],
    );
    await expect(repo.loadProject('edit')).rejects.toThrow(/command_log 行 \d+（turn 6）/);
  });

  it('journal_turn 超出 JS 安全整数 ⇒ 抛，不是悄悄失精（这一格同时是 P-17 那条 supportBigNumbers 的牙）', async () => {
    await writeHouse();
    await pool.query('UPDATE `project` SET `journal_turn` = ? WHERE `id` = ?', [
      BIG_JOURNAL_TURN,
      PROJECT_ID,
    ]);
    const read = await rows<{ journal_turn: unknown }>(
      'SELECT `journal_turn` FROM `project` WHERE `id` = ?',
      [PROJECT_ID],
    );
    process.stdout.write(
      `[T5] journal_turn 读数 typeof=${String(typeof read[0]?.journal_turn)} value=${String(read[0]?.journal_turn)}\n`,
    );
    await expect(repo.loadProject('edit')).rejects.toThrow(/安全整数/);
  });
});

describe('clean_shutdown 与恢复告知', () => {
  it('新建工程就是 1：没人动过的账不需要恢复', async () => {
    await repo.createProject({ name: '新工程', schemaVersion: SCHEMA_VERSION });
    expect(await cleanShutdown()).toBe(1);
  });

  it('edit 打开落 0、closeProject 回 1、再开得 true', async () => {
    const house = await writeHouse();
    const open = await repo.loadProject('edit');
    expect(open.header.wasCleanShutdown).toBe(true);
    expect(await cleanShutdown()).toBe(0);
    await repo.closeProject(last(house));
    expect(await cleanShutdown()).toBe(1);
    expect((await repo.loadProject('edit')).header.wasCleanShutdown).toBe(true);
  });

  it('连开两次：第二次报 false（这一格也是"那条 UPDATE 不许加 affectedRows 断言"的证人）', async () => {
    await writeHouse();
    expect((await repo.loadProject('edit')).header.wasCleanShutdown).toBe(true);
    expect((await repo.loadProject('edit')).header.wasCleanShutdown).toBe(false);
    expect((await repo.loadProject('edit')).header.wasCleanShutdown).toBe(false);
  });

  it('read 意图只读不写：旁观者不把别人的告别信号抹脏（T6 拿不到锁走的就是这一支）', async () => {
    await writeHouse();
    const seen = await repo.loadProject('read');
    expect(seen.header.wasCleanShutdown).toBe(true);
    expect(await cleanShutdown()).toBe(1);
    expect((await repo.loadProject('read')).header.wasCleanShutdown).toBe(true);
  });

  it('没告别就"崩"：换仓库实例重开 ⇒ 报告里既有未收尾信号，也有未合并的片段数', async () => {
    const house = await writeHouse();
    await repo.writeSnapshot(2, at(house, 2));
    await repo.loadProject('read'); // 旁观一次，不抹信号
    const crashed = new ProjectRepository(repoPool, PROJECT_ID, 'reopener');
    const got = await crashed.loadProject('edit');
    expect(got.header.wasCleanShutdown).toBe(true); // 上一发是 read，所以还没落 0
    expect(got.snapshot?.turn).toBe(2);
    expect(got.replayed.rows).toBe(3); // 未合并片段 = 快照之后那 3 发，全靠重放取回
    expect(got.doc.canonical()).toBe(last(house).canonical());
    // 现在才是真"没告别"：edit 打开之后不再收尾，换实例重开。
    const reopened = await new ProjectRepository(repoPool, PROJECT_ID, 'third').loadProject('edit');
    expect(reopened.header.wasCleanShutdown).toBe(false);
    expect(reopened.replayed.rows).toBe(3);
  });

  it('收尾不删账：closeProject 之后 command_log 与 element 都还在', async () => {
    const house = await writeHouse();
    await repo.loadProject('edit');
    await repo.closeProject(last(house));
    expect(await count('command_log', ' WHERE `project_id` = ?', [PROJECT_ID])).toBe(5);
    expect(await count('element', ' WHERE `project_id` = ?', [PROJECT_ID])).toBe(
      last(house).entities.size,
    );
  });
});

describe('closeProject 的三方对账', () => {
  it('平账的收尾：报行数，且 clean_shutdown 回到 1', async () => {
    const house = await writeHouse();
    await repo.loadProject('edit');
    const report = await repo.closeProject(last(house));
    expect(report.elementRows).toBe(last(house).entities.size);
    expect(report.storeyRows).toBe(1);
    expect(await cleanShutdown()).toBe(1);
  });

  it('storey 表少一行 ⇒ 抛且点名 element↔storey 与那一行的 id，且不落 1', async () => {
    const house = await writeHouse();
    await repo.loadProject('edit');
    await pool.query('DELETE FROM `storey` WHERE `id` = ?', [house.storeyId]);
    await expect(repo.closeProject(last(house))).rejects.toThrow(/element↔storey/);
    await expect(repo.closeProject(last(house))).rejects.toThrow(new RegExp(house.storeyId));
    expect(await cleanShutdown()).toBe(0);
  });

  it('storey.elevation_mm 差 1 毫米 ⇒ 抛且点名 elevationMm（整行比对只会说"不等"，不会说哪里不等）', async () => {
    const house = await writeHouse();
    await repo.loadProject('edit');
    await pool.query('UPDATE `storey` SET `elevation_mm` = `elevation_mm` + 1 WHERE `id` = ?', [
      house.storeyId,
    ]);
    await expect(repo.closeProject(last(house))).rejects.toThrow(/elevationMm/);
    expect(await cleanShutdown()).toBe(0);
  });

  it('element.storey_id 列被手改 ⇒ 抛且点名 element.storey_id↔payload', async () => {
    const house = await writeHouse();
    await repo.loadProject('edit');
    await pool.query('UPDATE `element` SET `storey_id` = NULL WHERE `id` = ?', [house.wallB]);
    const message = await repo.closeProject(last(house)).then(
      () => '没抛，判据塌了',
      (err: unknown) => String(err),
    );
    expect(message).toMatch(/element\.storey_id↔payload/);
    expect(message).toMatch(new RegExp(house.wallB));
  });

  it('element 少一行 ⇒ 两对同时报（文档与投影、投影的列与正文都失去证人），那个 id 在文案里出现两次以上', async () => {
    const house = await writeHouse();
    await repo.loadProject('edit');
    await pool.query('DELETE FROM `element` WHERE `id` = ?', [house.wallB]);
    const message = await repo.closeProject(last(house)).then(
      () => '没抛，判据塌了',
      (err: unknown) => String(err),
    );
    expect(message).toMatch(/document↔element/);
    expect(message.split(house.wallB).length - 1).toBeGreaterThanOrEqual(2);
    expect(message).toMatch(/command_log/);
    expect(await cleanShutdown()).toBe(0);
  });

  it('文档多一发（渲染器画了但那一发没落盘）⇒ 抛，且重开拿到的是日志那一份：既不静默丢，也不静默多算', async () => {
    const house = await writeHouse();
    await repo.loadProject('edit');
    // 只在内存里加一面墙，不写库 —— 就是"改了没保存"的那一发。
    const unsaved = step(
      last(house),
      wallCreate({
        storeyId: house.storeyId,
        start: { x: 0, y: 0 },
        end: { x: 0, y: 3000 },
        thicknessMm: 200,
        heightMm: 2800,
      }),
    );
    await expect(repo.closeProject(unsaved.doc)).rejects.toThrow(/document↔element/);
    const reopened = await repo.loadProject('edit');
    expect(reopened.doc.canonical()).toBe(last(house).canonical());
    expect(reopened.header.wasCleanShutdown).toBe(false);
    expect(reopened.replayed.rows).toBe(5);
  });

  it('不属于本工程的照片不收：拿别人的文档收尾 ⇒ 抛，且不动 clean_shutdown', async () => {
    await writeHouse();
    await repo.loadProject('edit');
    await expect(repo.closeProject(Document.create(OTHER_PROJECT, SCHEMA_VERSION))).rejects.toThrow(
      /属于工程/,
    );
    expect(await cleanShutdown()).toBe(0);
  });

  it('读路径不漏连接：connectionLimit=1 的池上连开两次再收尾都成功（少一次 release 就变成等 1 秒超时）', async () => {
    const house = await writeHouse();
    const a = await repo.loadProject('edit');
    const b = await repo.loadProject('edit');
    expect(a.doc.canonical()).toBe(b.doc.canonical());
    await repo.closeProject(b.doc);
    expect((await repo.loadProject('edit')).header.wasCleanShutdown).toBe(true);
    expect(await cleanShutdown()).toBe(0);
  });
});
```

Run: `npx vitest run --config vitest.db.config.ts apps/desktop/test/db/journal.test.ts > tmp/t5-journal.log 2>&1; echo "exit=$?"`
Expected: `exit=1` —— 红在 `repo.loadProject is not a function`（或 TS 侧的"类型 ProjectRepository 上不存在属性 loadProject"），**不是**红在建库权限、环境变量、或找不到 `reconcile`。若红在后两者，先回 Step 1/2 修，别往下写实现。

跑之前先确认环境变量指向测试库（只打印库名，口令一律不回显）：

```bash
node -e "console.log(process.env.DAJIA_MYSQL_DATABASE)"
```

- [ ] **Step 4: 写 `repository.ts` 的读路径与收尾**

先把 `repository.ts` 顶部的 import 整块换成下面这一段（不留两条同模块 import；`Document` 从 type import 升成值 import，因为 `loadProject` 要 `Document.create`）：

```ts
import type { Pool } from 'mysql2/promise';
import {
  Document,
  SCHEMA_VERSION,
  applyPatch,
  assertTruthSourceInvariants,
  type Entity,
  type EntityId,
  type Patch,
} from '@dajia/core';
import { JournalTurnSchema } from '@dajia/protocol';
import {
  decodeDocument,
  decodeEntity,
  decodePatch,
  encodeDocument,
  encodeEntity,
  encodePatch,
} from './codec';
import {
  formatMismatches,
  reconcileProjection,
  storeyIdOf,
  type ElementRowView,
  type StoreyRowView,
} from './reconcile';
```

> `Entity` 保持 type import（T4 里只作类型用）；`Patch` 同理。若 `noUnusedLocals` 报某条 import 没用，**删掉那条 import**，不要给它编一个用法。

模块级新增（放在 `ProjectRepository` 之前）：

```ts
export type OpenIntent = 'edit' | 'read';

export interface ProjectHeader {
  readonly projectId: EntityId;
  readonly name: string;
  readonly schemaVersion: number;
  readonly journalTurn: number;
  /** 翻 0 **之前**读到的那一格：false = 上一会话没告别。T8 的恢复横幅只读这一格。 */
  readonly wasCleanShutdown: boolean;
}

export interface LoadOutcome {
  readonly doc: Document;
  readonly header: ProjectHeader;
  readonly snapshot: { readonly seq: number; readonly turn: number } | null;
  /** 重放了几发、首尾 seq。洞在 seq 上（P-6），所以 fromSeq/toSeq 只作报告用，不作判据用。 */
  readonly replayed: {
    readonly rows: number;
    readonly fromSeq: number | null;
    readonly toSeq: number | null;
  };
}

export interface CloseReport {
  readonly elementRows: number;
  readonly storeyRows: number;
}

interface ProjectRow {
  readonly name: string;
  readonly schema_version: number | string;
  readonly journal_turn: number | string;
  readonly clean_shutdown: number | string;
}
interface SnapshotRow {
  readonly seq: number | string;
  readonly journal_turn: number | string;
  readonly schema_version: number | string;
  readonly payload: unknown;
}
interface LogRow {
  readonly seq: number | string;
  readonly turn: number | string;
  readonly payload: unknown;
}
interface ElementDbRow {
  readonly id: string;
  readonly storey_id: string | null;
  readonly payload: unknown;
}
interface StoreyDbRow {
  readonly id: string;
  readonly index_no: number | string;
  readonly elevation_mm: number | string;
  readonly height_mm: number | string;
}

/**
 * BIGINT 列的读数口径（P-17）。`supportBigNumbers: true` + `bigNumberStrings: false` 之下：
 * 安全范围内是 number，范围外是 **string**。所以"string 就是越界"这一支必须先判，
 * 不能先 `Number()` —— 那样 9007199254740993 会静默变成 …92 并通过 `isSafeInteger`，
 * 于是"越界会抛"这句主张悄悄失效（T5-M7 打的就是这一支，T5-M11 之外它是最值钱的一发）。
 *
 * `clean_shutdown` 不走这里：它只有 0/1 两个值，用 `Number(...) === 1` 归一即可，
 * 越界的 0/1 列不成立。查询结果的本地接口一律写成"裸形状"再 `as`，不 `extends RowDataPacket`
 * —— T4 用的是这个形状，别在同一个文件里混两种。
 */
function asSafeInt64(raw: unknown, label: string): number {
  if (typeof raw === 'string') {
    throw new RangeError(`${label} = ${raw} 超出 JS 安全整数范围：这一列存进 JS 必然失精，拒开`);
  }
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
    throw new RangeError(`${label} 的读数 ${String(raw)} 不是安全整数，拒开`);
  }
  return raw;
}
```

类内两个方法：

```ts
  /**
   * 读路径 = 工程头 + 最近一份快照 + 其后所有日志正向重放（Architecture ③），三发读与那一发写
   * **同在一个事务、同一个快照**里。
   * `edit` 支先 `FOR UPDATE` 锁 project 行 —— 与 `appendJournal` 同一个首锁，加锁顺序一致 ⇒ 不会互相咬成死锁。
   * `read` 支不锁行也不写（第 ② 段）：T6 拿不到锁的那个实例走的就是这一支。
   */
  async loadProject(intent: OpenIntent): Promise<LoadOutcome> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const select =
        'SELECT `name`, `schema_version`, `journal_turn`, `clean_shutdown` FROM `project` WHERE `id` = ?';
      const [projectRows] = await conn.query(intent === 'edit' ? `${select} FOR UPDATE` : select, [
        this.projectId,
      ]);
      const project = (projectRows as ProjectRow[])[0];
      if (!project) {
        throw new RangeError(
          `工程 ${this.projectId} 不在库里：要么它从没建过，要么它已经被删；不能凭空开一份文档当它是读来的`,
        );
      }
      const schemaVersion = asSafeInt64(project.schema_version, 'project.schema_version');
      // 两处常量当前同值，读的是 Document 那个（Document.create 的默认参数就是它）；
      // CORE_SCHEMA_VERSION 是 index 的再导出，这里同时用两个就是留两个产地。
      if (schemaVersion !== SCHEMA_VERSION) {
        throw new RangeError(
          `工程 ${this.projectId} 的 schema_version 是 ${String(schemaVersion)}，这份程序只认 ${String(
            SCHEMA_VERSION,
          )}：S1 没有迁移路径，硬读会得到一份没人验过的文档`,
        );
      }
      const journalTurn = asSafeInt64(project.journal_turn, 'project.journal_turn');
      const wasCleanShutdown = Number(project.clean_shutdown) === 1;

      const [snapshotRows] = await conn.query(
        'SELECT `seq`, `journal_turn`, `schema_version`, `payload` FROM `snapshot` WHERE `project_id` = ? ORDER BY `seq` DESC LIMIT 1',
        [this.projectId],
      );
      const snap = (snapshotRows as SnapshotRow[])[0];
      let doc: Document;
      let snapshot: { seq: number; turn: number } | null = null;
      let replayFrom = 0;
      if (snap) {
        const snapSeq = asSafeInt64(snap.seq, 'snapshot.seq');
        const snapTurn = asSafeInt64(snap.journal_turn, `snapshot 行 ${String(snapSeq)} 的 journal_turn`);
        const snapSchema = asSafeInt64(
          snap.schema_version,
          `snapshot 行 ${String(snapSeq)} 的 schema_version`,
        );
        if (snapSchema !== schemaVersion) {
          throw new RangeError(
            `snapshot 行 ${String(snapSeq)} 的 schema_version 是 ${String(snapSchema)}，工程头记的是 ${String(
              schemaVersion,
            )}：同一份快照的列上与工程上说的不是同一个版本，拒开`,
          );
        }
        const decoded = decodeDocument(
          { table: 'snapshot', id: String(snapSeq) },
          snap.payload,
        );
        if (decoded.schemaVersion !== schemaVersion) {
          throw new RangeError(
            `snapshot 行 ${String(snapSeq)} 的 payload 写着 schemaVersion ${String(
              decoded.schemaVersion,
            )}，工程头记的是 ${String(schemaVersion)}：列与正文各说各话时以工程头为准，拒开`,
          );
        }
        if (decoded.projectId !== this.projectId) {
          throw new RangeError(
            `snapshot 行 ${String(snapSeq)} 的 payload 写的是工程 ${decoded.projectId}，` +
              `而这条快照挂在工程 ${this.projectId} 上：两份账指认的不是同一个工程，拒开`,
          );
        }
        doc = decoded;
        snapshot = { seq: snapSeq, turn: snapTurn };
        replayFrom = snapTurn;
      } else {
        doc = Document.create(this.projectId, schemaVersion);
      }

      const [logRows] = await conn.query(
        'SELECT `seq`, `turn`, `payload` FROM `command_log` WHERE `project_id` = ? AND `turn` > ? ORDER BY `seq` ASC',
        [this.projectId, replayFrom],
      );
      let prevTurn = replayFrom;
      let replayedRows = 0;
      let fromSeq: number | null = null;
      let toSeq: number | null = null;
      for (const row of logRows as LogRow[]) {
        const seq = asSafeInt64(row.seq, 'command_log.seq');
        const turn = asSafeInt64(row.turn, `command_log 行 ${String(seq)} 的 turn`);
        // turn 必须逐发连着（appendJournal 就是这么写的：跳号当场抛）。缺号说明日志被删过或插过，
        // 而"少重放几发得到的文档"是一份形状完全正常的坏文档 —— 正是本计划要拦的那一型。
        if (turn !== prevTurn + 1) {
          throw new RangeError(
            `command_log 缺号：行 ${String(seq)} 的 turn 是 ${String(turn)}，上一发读到 ${String(
              prevTurn,
            )}（工程 ${this.projectId}，快照 turn ${String(replayFrom)}）：` +
              `中间那些发去哪了没查清之前，不能当它是完整的`,
          );
        }
        prevTurn = turn;
        const patch = decodePatch({ table: 'command_log', id: String(seq) }, row.payload);
        try {
          doc = applyPatch(doc, patch).doc;
        } catch (err) {
          // 坐标必须落在这一句里：一份盘上有几百发补丁，"重放失败"四个字帮不了任何人。
          throw new RangeError(
            `重放 command_log 行 ${String(seq)}（turn ${String(turn)}）失败：${String(err)} —— ` +
              `快照与日志这两本账已经接不上，拒开`,
          );
        }
        replayedRows += 1;
        if (fromSeq === null) fromSeq = seq;
        toSeq = seq;
      }
      // 读到尾还不够，尾必须落在工程头记的那一格：少就是"头寸比账本大"（尾被删），
      // 多就是"账本比头寸大"（头寸没跟上）。两种都拒。
      if (prevTurn !== journalTurn) {
        throw new RangeError(
          `重放读到 turn ${String(prevTurn)}，project.journal_turn 记的是 ${String(journalTurn)}：` +
            `工程 ${this.projectId} 的这两本账对不上，拒开`,
        );
      }

      // 唯一的放行证（T3）。放在这里而不是 codec：解码只管形状，这里才知道一共读了几层、引用闭不闭。
      assertTruthSourceInvariants(doc);

      if (intent === 'edit') {
        // 不加 affectedRows 断言（第 ② 段）：MySQL 的 affectedRows 数真变化的行，重复打开时 0→0 返回 0。
        await conn.query(
          'UPDATE `project` SET `clean_shutdown` = 0, `updated_at` = NOW(3) WHERE `id` = ?',
          [this.projectId],
        );
      }
      await conn.commit();
      return {
        doc,
        header: { projectId: this.projectId, name: project.name, schemaVersion, journalTurn, wasCleanShutdown },
        snapshot,
        replayed: { rows: replayedRows, fromSeq, toSeq },
      };
    } catch (err) {
      try {
        await conn.rollback();
      } catch {
        // 同 appendJournal：吞掉第二个错误，否则调用方读到的是"回滚失败"，真因反而看不见。
      }
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * 收尾：三方对账（文档 ↔ element ↔ storey）通过才把 `clean_shutdown` 落回 1（第 ④ 段）。
   * 不平 ⇒ 抛且不落 1 ⇒ 下次打开出恢复告知。真源永远是 `command_log`，投影由下一次写入重建。
   */
  async closeProject(doc: Document): Promise<CloseReport> {
    if (doc.projectId !== this.projectId) {
      throw notThisProject('文档', doc.projectId, this.projectId);
    }
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [locked] = await conn.query(
        'SELECT `id` FROM `project` WHERE `id` = ? FOR UPDATE',
        [this.projectId],
      );
      if ((locked as unknown[]).length === 0) {
        throw new RangeError(`工程 ${this.projectId} 不在库里：没有可收尾的账`);
      }
      const [elementRows] = await conn.query(
        'SELECT `id`, `storey_id`, `payload` FROM `element` WHERE `project_id` = ?',
        [this.projectId],
      );
      const [storeyRows] = await conn.query(
        'SELECT `id`, `index_no`, `elevation_mm`, `height_mm` FROM `storey` WHERE `project_id` = ?',
        [this.projectId],
      );
      const elements: ElementRowView[] = (elementRows as ElementDbRow[]).map((r) => ({
        id: r.id as EntityId,
        storeyId: r.storey_id as EntityId | null,
        entity: decodeEntity({ table: 'element', id: r.id }, r.payload),
      }));
      const storeys: StoreyRowView[] = (storeyRows as StoreyDbRow[]).map((r) => ({
        id: r.id as EntityId,
        indexNo: asSafeInt64(r.index_no, `storey 行 ${r.id} 的 index_no`),
        elevationMm: asSafeInt64(r.elevation_mm, `storey 行 ${r.id} 的 elevation_mm`),
        heightMm: asSafeInt64(r.height_mm, `storey 行 ${r.id} 的 height_mm`),
      }));
      const mismatches = reconcileProjection(doc, elements, storeys);
      if (mismatches.length > 0) {
        // 回滚交给下面那个 catch，这里不重复一发 —— 重复会让"谁在回滚"有两个答案。
        throw new RangeError(formatMismatches(this.projectId, mismatches));
      }
      // 同样不许加 affectedRows 断言：收过尾的工程再收一次是 1→1。
      await conn.query(
        'UPDATE `project` SET `clean_shutdown` = 1, `updated_at` = NOW(3) WHERE `id` = ?',
        [this.projectId],
      );
      await conn.commit();
      return { elementRows: elements.length, storeyRows: storeys.length };
    } catch (err) {
      try {
        await conn.rollback();
      } catch {
        /* 同上 */
      }
      throw err;
    } finally {
      conn.release();
    }
  }
```

Run: `npx vitest run --config vitest.db.config.ts apps/desktop/test/db/journal.test.ts > tmp/t5-journal.log 2>&1; echo "exit=$?"`
Expected: `exit=0`，**31 条**全绿。`journal_turn 超出 JS 安全整数` 那一格打印的 `[T5] journal_turn 读数 typeof=… value=…` **实测读数抄进执行回填**（若 `typeof=number` ⇒ `supportBigNumbers` 没生效，先修 `pool.ts` 再往下走）。

- [ ] **Step 5: 给 `pool.ts` 的注释补上新的读者**

`apps/desktop/src/main/db/pool.ts` 里 `supportBigNumbers` 那条注释末尾追加：

```ts
    // 读数口径现在有两格读者：T4 的 BIGINT 字面量探针，与 T5 的 `asSafeInt64`
    // （journal.test.ts 的 `journal_turn 超出 JS 安全整数` 那一格）。
    // 关掉这两行 ⇒ 红的是"越界会抛"，不是别的；T5-M7 与 T5-M11 各打一次。
```

Run: `npx tsc --noEmit -p apps/desktop/tsconfig.test.json > tmp/t5-tsc.log 2>&1; echo "exit=$?"`
Expected: `exit=0`。（这一发不是仪式：`tsconfig.test.json` 覆盖 `test/**`，本任务两个测试文件里的编译期主张只有它能看见 —— T4 的 M6 已经验证过这一点。）

- [ ] **Step 6: 全量复跑与计数**

```bash
pnpm verify > tmp/t5-verify.log 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' tmp/t5-verify.log | grep -E "^ *(Test Files|Tests) "
pnpm test:db > tmp/t5-db.log 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' tmp/t5-db.log | grep -E "^ *(Test Files|Tests) |FAIL"
```

Expected（`pnpm verify`）：`exit=0`；`Test Files` **42 → 43**（只多 `reconcile.test.ts` 一档），`Tests` = **T4 的实测回填值 + 16**。
Expected（`pnpm test:db`）：`exit=0`；`Test Files` **3 → 4**，`Tests` = T4 回填值 + **31**（`journal.test.ts`）。
`lint:deps` 照旧静默：本任务不新增 `@dajia/*` 边（`reconcile.ts` 只 import `@dajia/core`，desktop → core 是既有许可）。

跑完确认库清干净、其余用户库一个不少（命令同 T4 Step 8 那一发，**从 `apps/desktop` 目录跑**，`node -e` 按 cwd 解析裸说明符）。Expected：输出里既没有 `dajia_test` 也没有 `dajia`（`dajia` 归 T11 的闸门在 `DAJIA_MYSQL_DATABASE=dajia` 时才碰）。

- [ ] **Step 7: 提交**

```bash
git status --porcelain
git diff
git add apps/desktop/src/main/db/reconcile.ts apps/desktop/src/main/db/repository.ts \
  apps/desktop/src/main/db/pool.ts apps/desktop/test/unit/reconcile.test.ts \
  apps/desktop/test/db/journal.test.ts
git commit -m "$(cat <<'EOF'
feat(persist): 读路径与收尾对账 —— 快照 + 重放、缺号拒开、三方对账才落 clean_shutdown

loadProject 只读三样（工程头、最近快照、其后日志）：turn 必须逐发连着，且读到尾要落在
project.journal_turn 上；越界 BIGINT 走"string 就是越界"那一支抛，不静默失精（P-17 的牙在这一）。
intent='read' 不锁行也不抹 clean_shutdown —— 旁观者不该把写者的告别信号写脏。
closeProject 做文档↔element↔storey 三方对账，不平就抛且不落 1，下次打开出恢复告知；
storeyIdOf 从 repository 挪进 reconcile，写列与审列共用一份规则。
EOF
)"
```

---

**Task 5 的改坏验证**（变异棒，`cp` 备份 + md5 还原；**座位不许 `git checkout`/`restore`/`stash`/`reset`/`clean`**）：

用例引用一律用 `it` 的名字，不用"第 N 格"—— 文件里加一条用例就会把编号全体挪位，那是 T4 自查时踩过的坑。

| # | 改坏哪里 | 哪一格红、为什么 |
|---|---|---|
| T5-M1 | 重放过滤的 `AND turn > ?` 改成 `>=` | `快照正好压在最后一发` 红（第五发的 remove 被投喂两次 ⇒ `applyPatch` 抛「remove 的实体不存在」）。这一发是 off-by-one 唯一的证人 |
| T5-M2 | 删掉 `turn !== prevTurn + 1` 的缺号判据 | `中间缺一发日志` 与 `手插一发跳号的日志` 两格红 —— 缺号会静默重放出一份形状完全正常的坏文档，正是"静默丢失"那一型 |
| T5-M3 | 删掉 `prevTurn !== journalTurn` 的收尾判据 | `尾缺一发日志` 红（逐发连着仍然成立，只有工程头能看出来） |
| T5-M4 | 删掉工程头的 `schemaVersion !== SCHEMA_VERSION` | `project.schema_version 与这份程序不符` 红。注意 `snapshot 列上…` 与 `…payload 里…` 两格**照旧绿** —— 三处版本判据是三个独立的牙，不是一个 |
| T5-M5 | 删掉 `decoded.projectId !== this.projectId` | `snapshot payload 的 projectId 是别的工程` 红（`uk_project_turn` 挂在列上，正文写着别的工程时列与正文各说各话） |
| T5-M6 | 删掉 `decoded.schemaVersion !== schemaVersion` | `snapshot payload 里的 schemaVersion 与工程头不符` 红（列写 1、正文写 8 那一发） |
| T5-M7 | `asSafeInt64` 里删掉 `typeof raw === 'string'` 那一支（只 `Number()`） | `journal_turn 超出 JS 安全整数` 红 —— **这一发同时证明 P-17 的 `supportBigNumbers` 在做工**：把 `pool.ts` 那两行关掉时同一格也红（读数变成静默失精的 number，抛就不再发生）。两型各打一次，`typeof` 读数抄进执行回填 |
| T5-M8 | 把 `intent === 'edit'` 那个条件删掉（read 也抹 0） | `read 意图只读不写` 红（`SELECT clean_shutdown` 读到 0）：旁观者把写者的告别信号抹脏 |
| T5-M9 | 把 `edit` 支的 `FOR UPDATE` 删掉（其余一字不动） | 本任务用例**全绿** —— 登记的限度：单连接串行看不见这把锁的价值，它的读者是 T10 的 `--lock-shot`（两个真实例抢同一工程时，读与写必须排在同一把行锁上）。这不是"判据没牙所以凑一条用例"，是"牙在别处"：`appendJournal` / `closeProject` 的首锁顺序才是死锁防线，T10 有它 |
| T5-M10 | 删掉 `assertTruthSourceInvariants(doc)` 那一行 | 本任务夹具**全绿** —— 登记的限度：形状过 zod、引用却闭不上的坏数据要绕过缺号判据才能进来，而缺号判据在它前面。这一行的凭据在 T3 的 `invariants.test.ts`（命令层造不出、`handBuild` 才造得出的那些坏文档）。执行时的补法（做与不做都记进回填）：把 `重放撞空行` 那发的 payload 换成 `encodePatch({ upsert: [手搓一面 startId 不存在的墙], remove: [] })` ⇒ zod 过、引用不过 ⇒ 这一发就红 |
| T5-M11 | 删掉 `mismatches.length > 0` 的拦（对账永不拦） | `storey 表少一行` / `elevation_mm 差 1` / `element.storey_id 列被手改` / `element 少一行` / `文档多一发` 五格一起红 —— 三方对账的四个方向（少行、多行、字段漂、列漂）加"改了没保存"全在这一发上 |
| T5-M12 | `diffStoreyProjection` 只比 `elevationMm`，不比 `indexNo` / `heightMm` | `序号、标高、层高各归各的字段` 红（三处一起漂只报一个名字） |
| T5-M13 | `differingFields` 换成整份 `stableStringify` 串比较 | `同一 id 的 payload 字段不等 ⇒ 报字段名` 红（`fields` 变空数组，"哪个字段漂"这条线索被抹掉）；`键序不同不算漂` 照旧绿 —— 两条各管一头 |
| T5-M14 | `storeyIdOf` 改成 `entity.kind === 'storey' ? entity.id : entity.storeyId` | 证人只有两格，且都是**直接读那一列**的：`reconcile.test.ts` 的 `楼层行把 storey_id 写成了自己的 id`（手搓行 ⇒ 期望一条 `differs`，变异后自比相等 ⇒ 得空数组）与 `storeyIdOf：楼层自己就是层 ⇒ null`（`toBeNull` 当场翻脸）。**登记的限度**：本任务的库用例全绿 —— 列由这份规则写、又由同一份规则审，`diffStoreyIdColumn` 是自比，规则本身漂了它看不见（`closeProject 平账` 那一格正是此型）。跨任务的证人是 T4 的 `楼层那一行的 storey_id 是 NULL，别的三类都带着自己的层`（`test/db/repository.test.ts`，它读的是列的实测值，不经过这份规则）：第 ③ 段"合并成一份"把重复消掉了，代价就是这份规则只剩外部证人，所以那一格不许并进来、也不许在本任务里被改写 |
| T5-M15 | 给 `UPDATE project SET clean_shutdown = 0` 加 `affectedRows === 1` 断言 | `连开两次` 红（第二次打开是 0→0，MySQL 只数真变化的行）。这一发是第 ② 段那条实现纪律的证人，不是待修的 bug |
| T5-M16 | 把 `loadProject` 的 `beginTransaction` 去掉，三发读改用 `this.pool.query` | 本任务用例**全绿** —— 登记的限度：能证的是"未提交的行不可见"（每发语句各自也是这个读数），不能证"两次读之间被并发写入切碎"，那要并发写者恰好落在两发读中间。事务保留的理由写在第 ② 段：`wasCleanShutdown` 的读与那一发写必须同快照，否则报的是抹完之后的值（`没告别就崩` 那一格读的就是这个先后）。不许因为"这条测不到"就把它当测试专用分支删掉 —— 它是 InnoDB 的标准读法，真读者在 T10 |


## Task 6: 工程锁（`locks.ts` —— 服务端时钟的三发 CAS）

**Files:**
- Create: `apps/desktop/src/main/db/locks.ts`
- Create: `apps/desktop/test/unit/locks-ticket.test.ts`（不连库：票的形状与那两条尺）
- Create: `apps/desktop/test/db/locks.test.ts`（连库：两个池抢同一行）
- Modify: 无（`repository.ts` 与 `locks.ts` 互不知情，第 ⑥ 段写为什么；`main/index.ts` 与 `--lock-shot` 归 T8/T10）

**Interfaces:**
- Consumes: T2 的 `createDbPool` / `migrate` / `ensureDatabase` / `dropTestDatabase`、T4 的 `PoolOptions.lockWaitTimeoutSeconds`、T4 的 `ProjectRepository.createProject`；core 的 `uuidv7` / `isEntityId` / `EntityId` / `SCHEMA_VERSION`
- Produces:
  - `interface LockTicket { readonly projectId: EntityId; readonly token: EntityId; readonly owner: string }`
  - `newLockTicket(input: { projectId: EntityId; owner: string }): LockTicket`（现调 `uuidv7()` 造票；owner 过两条尺）
  - `ttlToMicroseconds(ttlMs: number): number`（纯校验 + ×1000；0 合法）
  - `acquireLock(pool, ticket, ttlMs?): Promise<'acquired' | 'busy' | 'no-project'>`
  - `heartbeat(pool, ticket, ttlMs?): Promise<'renewed' | 'lost'>`
  - `releaseLock(pool, ticket): Promise<'released' | 'not-mine'>`
  - `lockState(pool, projectId, token?): Promise<LockState>`，`interface LockState { exists; held; mine; owner; ttlMsRemaining }`
  - `LOCK_TTL_MS = 15000`、`LOCK_HEARTBEAT_INTERVAL_MS = 5000`（**T7 的心跳定时器与 T8 的 IPC 默认值从这里取，不许各写一份**）

**① 为什么锁挂在 `project` 行上，不建 `project_lock` 表**：spec §8.2 点名的就是 `project.lock_token`，T2 的 DDL 里三列（`lock_token` / `lock_owner` / `lock_expires_at`）已经建好。第二张表要外键、要多一次 JOIN、还要回答"工程删了锁行归谁"，而挂在本来就要 CAS 的那一行上，这些问题一个都不存在。代价：`SELECT ... FOR UPDATE` 与工程头的读争同一行 —— 但 `appendJournal` 本来就锁这一行（T4），锁与账在同一处串行，比分散在两处更好想。

**② 为什么过期判定一个字都不读客户机时钟（P-4 落地的形状）**：比较用 `NOW(3)`，写入用 `TIMESTAMPADD(MICROSECOND, ?, NOW(3))`，余额用 `TIMESTAMPDIFF(MICROSECOND, NOW(3), lock_expires_at)` —— 三者都在服务端同一条语句里算。两台机器的本地时钟不可比（还多背一层时区），所以 `locks.ts` 里连 `Date.now()` 都不许出现；`uuidv7()` 内部用时钟只造 id，不参与判定。这条口径有一个常驻证人：`locks-ticket.test.ts` 最后一格直接扫 `locks.ts` 的源码文本（与 T3 那条「`storey.ts` 不许留第二份重叠规则」同族判据）。

**③ 为什么"能不能拿"只有一个文本产地**：`HELD_SQL` 是一段导出不必见的模块私有串（``lock_expires_at` IS NOT NULL AND `lock_expires_at` > NOW(3)`），`ACQUIRE_WHERE` 用字符串拼接把它嵌进去。 takeover 条件与活锁读数因此**不可能各漂一半**：把 `>` 改成 `>=` 只有一处可改。为什么取 `>`：`lock_expires_at` 是"余额到这一刻为止"，到点即过期 —— 所以 `ttlMs = 0` 的锁写完就不算活。这一毫秒内的相等边界造不出确定红（要写与读落在同一个 `NOW(3)` 刻度上），所以互补关系靠共享文本保证，不靠用例保证；用例保证的是它两端（`ttlMs = 0` 立刻不算活、活锁不可被抢、`expires_at IS NULL` 那一型算没余额）。

**④ 为什么心跳只认票、不认余额**：`heartbeat` 的 WHERE 是 `id = ? AND lock_token = ?`，不带 `HELD_SQL`。于是"我的锁过期了但还没人接管"时，心跳等于一次少往返的重新 acquire（`'renewed'`，余额复活）；而接管一旦真发生，列上的 token 已经换人，这一发匹配不上 ⇒ `'lost'`。两种形状都由服务端在同一发 UPDATE 里判完，客户机不参与。反过来说：**调用方拿到 `'lost'` 就必须停手**（T7 的 autosave 与 T8 的只读闸门是这句话的读者），因为从这一刻起另一个人正在写同一行账。

**⑤ 为什么判决来自写完之后的服务端读回，而不是 `affectedRows`**：MySQL 的 `affectedRows` 数的是**真发生变化的行**（T5 第 ② 段已经为 `clean_shutdown` 立过同一条纪律）。同一毫秒内用同一张票重发 `acquireLock`，写进去的 `token` / `owner` / `expires_at` 与原来的值逐字节相同 ⇒ `affectedRows` 给 0，而语义上这是 `'acquired'`（幂等），不是 `'busy'`。所以 0 之后补一发读回（`lock_token` 是不是我的票）分家；工程行不存在也从这一发读出来（`'no-project'`，不是 `'busy'`）。`releaseLock` 是唯一不需要读回的：匹配上的行必然要把非 NULL 的三列改成 NULL ⇒ 一定算变化；匹配不上只有"票不是我的"与"根本没上锁"两种，都是 `'not-mine'`。**登记的限度写在 T6-M9**：这条读回的全部可测凭据只有 `no-project` 那一格，"同毫秒重发"撞不出来。

**⑥ 为什么 `appendJournal` 不校验锁**：S1 的威胁模型是「两台机器同时打开同一库」（spec §8.2 原话），不是"对抗自己的代码"。写路径认票会把锁变成 T4 那条事务的第 N 个前置条件，还会让 P-15 那格（外部行锁掐断半途）多一个失败原因混在一起。真正的闸门在调用侧：`'edit'` 意图先 `acquireLock`，拿不到就用 `'read'` 打开（T8），心跳 `'lost'` 之后 autosave 立刻停写并转只读（T7）。所以 `locks.test.ts` 明写两格相反的判据：「没拿锁也能 appendJournal」与「拿锁不动 journal_turn 与四张表」—— 两边都有人证，下一个人就不会以为 `appendJournal` 认票。

- [ ] **Step 1: 先把七件事实测掉（不许写完代码再猜）**

一次性探针写在 SDD 工作区，**绝不落进仓库目录**：`.superpowers/sdd/2026-10-01-dajia-plan4-persistence/probe-lock.mjs`（连库形态照 T4 Step 1：`createRequire(new URL('../../../apps/desktop/package.json', import.meta.url))` 取 `mysql2`，指向 `dajia_test`，跑完 `DROP DATABASE`）。七档各打印一行读数，全部抄进执行回填：

| 档 | 测什么 | 为什么本任务的代码依赖它 |
|---|---|---|
| A | `SELECT TIMESTAMPADD(MICROSECOND, ?, NOW(3)) AS at` 绑定 `300000` | 三处写入都用这一形态（函数形态的参数位放 `?` 最直白）。若它不通就换 `DATE_ADD(NOW(3), INTERVAL ? MICROSECOND)`，**两档实测过哪档用哪档，且全文件只用那一档** |
| B | `TIMESTAMPDIFF(MICROSECOND, NOW(3), <DATETIME(3) 列>)` 的 JS 读数 `typeof` | P-17 开了 `supportBigNumbers`；这里值域只有 ±3.6e9 µs，正常应是 `number`。若实测是 `string`，`lockState` 里的 `Number(...)` 那句就是唯一出口，注释照实写 |
| C | `(col IS NOT NULL AND col = ?)` 的四个读数：票相等 / 不相等 / 列为 NULL / 绑定值为 SQL NULL | 代码取的是 `=== 1`。若少了 `IS NOT NULL`，`NULL = ?` 给的是 SQL `NULL`（mysql2 回 `null`）—— `Number(null)` 是 0，所以两种写法都"能用"，但只有带守卫的那份读数是 0/1 而不是三态。这一档就是那条注释的凭据 |
| D | 同一条 UPDATE 连发两次逐字节相同的值，第二次的 `affectedRows` 与 `changedRows` 读数 | 第 ⑤ 段的全部理由。预期 `affectedRows = 0`。`changedRows` 即便存在也**不许依赖**（它来自 info 串的文本解析）；读数照抄进回填 |
| E | `SELECT SLEEP(0.002)` 的返回值与耗时；期间另一条连接读同一行 | 第 ③ 段那个"跨过 1 毫秒刻度"的用例靠它，不靠 `setTimeout`。SLEEP 是服务端时钟上的真等待，比客户端 sleep 稳 |
| F | `VARCHAR(200)` 塞 201 个汉字：MySQL 报什么码、strict mode 下是截断还是错 | 我们的前置校验应当在这发之前拦住；报错形态（预期 `1406 Data too long`）写进 owner 那条抛错的注释里，说明"为什么不让 MySQL 去报" |
| G | `TIMESTAMPADD(MICROSECOND, -1000, NOW(3))` 写进 `lock_expires_at` 之后的读数 | T6-M11 的实测主张：负 TTL **不报错**，它悄悄发一把"写完就过期"的锁（`acquired` 而 `held` false）。这就是校验必须在前置位置的证据 |

Run: `node .superpowers/sdd/2026-10-01-dajia-plan4-persistence/probe-lock.mjs > tmp/t6-probe.log 2>&1; echo "exit=$?"`
Expected: `exit=0`，七档读数齐全。**任何一档与上面的预期不同 ⇒ 先按实测改代码，再往下走**（与 T4 的 A 档同一条纪律：改的是实现与注释，不许改判据的形状）。

- [ ] **Step 2: 先写不连库的那一档 —— `locks-ticket.test.ts`（CI 有牙）**

`apps/desktop/test/unit/locks-ticket.test.ts`：

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isEntityId, type EntityId } from '@dajia/core';
import {
  LOCK_HEARTBEAT_INTERVAL_MS,
  LOCK_TTL_MS,
  newLockTicket,
  ttlToMicroseconds,
} from '../../src/main/db/locks';

const PROJECT_ID = '0193aa00-0000-7000-8000-00000000000a' as EntityId;

/** 恰好 200 个字符（MySQL 的 VARCHAR(200) 数的是**字符**不是字节，见 Step 1 的 F 档）。 */
const OWNER_MAX = 'a'.repeat(200);

describe('锁票：形状与那两条尺', () => {
  it('token 由 uuidv7 现调：过 isEntityId，两张票不一样', () => {
    const a = newLockTicket({ projectId: PROJECT_ID, owner: '机器A:1001' });
    const b = newLockTicket({ projectId: PROJECT_ID, owner: '机器A:1001' });
    expect(isEntityId(a.token)).toBe(true);
    expect(a.token).not.toBe(b.token);
    // owner 相同也必须是两张票：锁的身份靠 token，不靠"谁报的名"。
    expect(a.owner).toBe(b.owner);
  });

  it('projectId 形状不对 ⇒ 抛，不发给 MySQL', () => {
    expect(() => newLockTicket({ projectId: 'nope' as EntityId, owner: 'A' })).toThrow(/projectId/);
  });

  it('owner 空串 / 纯空白 / 带首尾空白 ⇒ 抛', () => {
    for (const owner of ['', '   ', ' 机器A ', '机器A ']) {
      expect(() => newLockTicket({ projectId: PROJECT_ID, owner })).toThrow(/owner/);
    }
  });

  it('owner 201 个字符 ⇒ 抛，且文案带着那把尺（200）', () => {
    expect(() => newLockTicket({ projectId: PROJECT_ID, owner: 'a'.repeat(201) })).toThrow(/200/);
  });

  it('owner 恰好 200 个字符（含中文）⇒ 放行：尺是 <=200，不是 <200', () => {
    expect(newLockTicket({ projectId: PROJECT_ID, owner: OWNER_MAX }).owner).toBe(OWNER_MAX);
    expect(newLockTicket({ projectId: PROJECT_ID, owner: '搭家-机器-A-'.repeat(14) }).owner.length).toBeLessThanOrEqual(200);
  });

  it('TTL 与心跳间隔那对常量：漏两次心跳才丢锁', () => {
    // 这一格钉的是口径而不是数字本身：TTL 至少容得下三次心跳的抖动。
    // 把 LOCK_TTL_MS 改成 6000（小于 3 × 间隔）⇒ 这里红，比线上一到抖动就丢锁好查。
    expect(LOCK_TTL_MS).toBeGreaterThanOrEqual(3 * LOCK_HEARTBEAT_INTERVAL_MS);
    expect(LOCK_TTL_MS).toBeGreaterThan(0);
    expect(LOCK_HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('ttlToMicroseconds：0 合法、15000 换算对、越界四型抛', () => {
    expect(ttlToMicroseconds(0)).toBe(0);
    expect(ttlToMicroseconds(15000)).toBe(15000000);
    for (const bad of [-1, 1.5, Number.NaN, 3_600_001, Number.POSITIVE_INFINITY]) {
      expect(() => ttlToMicroseconds(bad)).toThrow(/ttlMs/);
    }
  });

  it('locks.ts 里不许出现客户机时钟（P-4 唯一的常驻证人）', () => {
    const src = readFileSync(new URL('../../src/main/db/locks.ts', import.meta.url), 'utf8');
    for (const forbidden of ['Date.now(', 'new Date(', 'performance.now(']) {
      expect(src, forbidden).not.toContain(forbidden);
    }
    // 所有时间判定都挂在服务端 NOW(3) 上；少一处就说明有一处改成了客户机算的。
    expect((src.match(/NOW\(3\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('三发 CAS 都按 id 收口：全文件不许出现不带 `id` 约束的 UPDATE', () => {
    const src = readFileSync(new URL('../../src/main/db/locks.ts', import.meta.url), 'utf8');
    const updates = src.match(/UPDATE `project`/g) ?? [];
    expect(updates.length).toBe(3);
    // 每一条 UPDATE 后面（到下一条语句之前）都必须出现 `id` = ?，否则就是全库一把锁（T6-M14）。
    const withoutId = src
      .split(/(?=UPDATE `project`)/)
      .filter((chunk) => chunk.startsWith('UPDATE `project`'))
      .filter((chunk) => !chunk.includes('`id` = ?'));
    expect(withoutId).toEqual([]);
  });
});
```

Run: `npx vitest run --config vitest.config.ts apps/desktop/test/unit/locks-ticket.test.ts > tmp/t6-ticket.log 2>&1; echo "exit=$?"`
Expected: `exit=1`，红在**模块解析不到**（`../../src/main/db/locks` 还不存在），不是红在断言。9 格全存在。

- [ ] **Step 3: 写 `locks.ts`**

`apps/desktop/src/main/db/locks.ts`：

```ts
import { isEntityId, uuidv7, type EntityId } from '@dajia/core';
import type { Pool } from 'mysql2/promise';

/**
 * 工程锁（spec §8.2 的 S1 必做项）。三列都挂在 `project` 行上，不建第二张表（口径见计划 T6 第 ① 段）。
 *
 * 三条总纪律：
 * 1. **时间全归服务端**（P-4）：比较用 `NOW(3)`，写入用 `TIMESTAMPADD(MICROSECOND, ?, NOW(3))`，
 *    余额用 `TIMESTAMPDIFF(MICROSECOND, NOW(3), ...)`。本文件一次都不读客户机时钟 ——
 *    `locks-ticket.test.ts` 的源码扫描是这条口径唯一的常驻证人。
 * 2. **单语句 CAS**：不开事务，也不 `getConnection()`。InnoDB 在语句级串行化同一行的写，
 *    后到的那条等到行锁之后按**已提交的当前版本**重判 WHERE —— 所以"两个池同时 acquire
 *    恰好一个成功"是驱动与引擎给的，不是我们假设的（`locks.test.ts` 那一格测的就是它）。
 * 3. **`affectedRows` 只当快路**：MySQL 数的是真变化的行（T5 第 ② 段同一条纪律），
 *    判决来自写完之后的服务端读回。理由与限度都写在 `decide()` 上。
 */

/** 默认余额：漏两次心跳（10 秒）才丢锁。T7 的定时器与 T8 的 IPC 默认值都从这里取。 */
export const LOCK_TTL_MS = 15_000;
export const LOCK_HEARTBEAT_INTERVAL_MS = 5_000;

/** TTL 的上界：一小时。超过它的值在形状上就像 bug，不像配置。 */
const TTL_MAX_MS = 3_600_000;
/** `project.lock_owner` 是 VARCHAR(200)，MySQL 数的是字符。前置校验的文案里就写这个数。 */
const OWNER_MAX_CHARS = 200;

export interface LockTicket {
  readonly projectId: EntityId;
  readonly token: EntityId;
  /** 给人看的那一个（横幅要直接显示它）：`机器名:pid` 之类的形状由调用方决定，本模块不猜。 */
  readonly owner: string;
}

export type AcquireOutcome = 'acquired' | 'busy' | 'no-project';
export type HeartbeatOutcome = 'renewed' | 'lost';
export type ReleaseOutcome = 'released' | 'not-mine';

export interface LockState {
  /** `project` 行在不在：不在时其余三项一律是"没有锁"的形状，不猜。 */
  readonly exists: boolean;
  /** 服务端算的：有余额的锁（不看票主是谁）。 */
  readonly held: boolean;
  /** `held && lock_token` 是我这张。过期了就不算 mine —— 与 `held` 同一个口径。 */
  readonly mine: boolean;
  readonly owner: string | null;
  /** 服务端算出的余额（毫秒，向下取整）。没锁、没票主、负余额都是 0，不是负数。 */
  readonly ttlMsRemaining: number;
}

/**
 * 「这把锁现在活着」的唯一文本。接管条件靠字符串拼接嵌进来（`ACQUIRE_WHERE`），
 * 所以两个谓词不可能各漂一半（T6-M3 打的就是另写一份）。取 `>`：`lock_expires_at` 是
 * "余额到这一刻为止"，到点即过期 ⇒ `ttlMs = 0` 的锁写完就不算活。
 * 这一毫秒内的相等边界造不出确定红（要写与读落在同一个 `NOW(3)` 刻度上），
 * 所以互补关系靠共享文本保证，不靠用例保证 —— 用例管的是两端那一对。
 */
const HELD_SQL = '`lock_expires_at` IS NOT NULL AND `lock_expires_at` > NOW(3)';

/**
 * 能不能拿：没人上锁、锁已过期、或那本来就是我的票（幂等重发）—— 三者任一。
 * `lock_token` IS NULL 那一支看着与 `NOT (HELD)` 重复，其实不重复：
 * 列被手搓成"票为空而余额在未来"那一型，只有这一支能拿（`locks.test.ts` 有一格）。
 */
const ACQUIRE_WHERE =
  '(`lock_token` IS NULL OR `lock_token` = ? OR NOT (' + HELD_SQL + '))';

/** 校验 + 换算。0 是合法读数（"我要一把写完就过期的锁"），不是测试后门。 */
export function ttlToMicroseconds(ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0 || ttlMs > TTL_MAX_MS) {
    throw new RangeError(
      `ttlMs 必须是 0 到 ${TTL_MAX_MS} 之间的整数毫秒，收到 ${ttlMs}`,
    );
  }
  // 乘 1000 走 MICROSECOND 而不是把秒直接绑进去：DATETIME(3) 对小数秒会舍入，
  // 整型微秒让 0 与 300 这类值都能按字面意思落进语句。
  return ttlMs * 1000;
}

export function newLockTicket(input: {
  readonly projectId: EntityId;
  readonly owner: string;
}): LockTicket {
  if (!isEntityId(input.projectId)) {
    throw new RangeError(`projectId 不是 uuidv7 形状，收到 ${JSON.stringify(input.projectId)}`);
  }
  const { owner } = input;
  if (owner === '' || owner !== owner.trim()) {
    throw new RangeError('owner 不能为空或带首尾空白（它是横幅上直接显示的那一行）');
  }
  if (owner.length > OWNER_MAX_CHARS) {
    // 不许让 MySQL 去报这一发：1406 的文案里没有"哪把尺、多长"（Step 1 的 F 档读它的实际形态）。
    throw new RangeError(
      `owner 不能超过 ${OWNER_MAX_CHARS} 个字符（project.lock_owner 是 VARCHAR(200)），收到 ${owner.length}`,
    );
  }
  return { projectId: input.projectId, token: uuidv7(), owner };
}

function affected(res: unknown): number {
  return Number((res as { affectedRows?: number }).affectedRows ?? 0);
}

/**
 * 写完之后的服务端读回：那一行现在是不是我的票。
 * 为什么不用 `affectedRows` 当判据 —— 同一毫秒内用同一张票重发，写进去的值逐字节相同
 * ⇒ `affectedRows` 给 0（Step 1 的 D 档实测），而语义上那是 `acquired` 不是 `busy`。
 * 登记的限度（T6-M9）：这一型要两条语句真落在同一个 `NOW(3)` 刻度上，本任务造不出确定红；
 * 能确定打到它的是 `no-project` 那一格。所以这段理由必须留在注释里，不许"简化"成快路。
 * `lock_token` 为 NULL 时 `lock_token = ?` 得 SQL NULL 而不是 0，所以前面挂 `IS NOT NULL`
 * （C 档实测）—— 两个读数都取 `=== 1`，不把"未知"读成"是"。
 */
async function decide(
  pool: Pool,
  projectId: EntityId,
  token: EntityId,
): Promise<'mine' | 'other' | 'no-project'> {
  const [res] = await pool.query(
    'SELECT (`lock_token` IS NOT NULL AND `lock_token` = ?) AS matched FROM `project` WHERE `id` = ?',
    [token, projectId],
  );
  const row = (res as { matched: number | null }[])[0];
  if (!row) return 'no-project';
  return Number(row.matched) === 1 ? 'mine' : 'other';
}

/**
 * 拿锁。返回 `'acquired'` 之后，`ticket.token` 就是那一行上的票；
 * 返回 `'busy'` 时**什么都不必清理** —— 一发没匹配的 UPDATE 不改任何东西。
 */
export async function acquireLock(
  pool: Pool,
  ticket: LockTicket,
  ttlMs: number = LOCK_TTL_MS,
): Promise<AcquireOutcome> {
  const micros = ttlToMicroseconds(ttlMs);
  const [res] = await pool.query(
    'UPDATE `project` SET `lock_token` = ?, `lock_owner` = ?, ' +
      '`lock_expires_at` = TIMESTAMPADD(MICROSECOND, ?, NOW(3)) ' +
      'WHERE `id` = ? AND ' +
      ACQUIRE_WHERE,
    [ticket.token, ticket.owner, micros, ticket.projectId, ticket.token],
  );
  if (affected(res) === 1) return 'acquired';
  const who = await decide(pool, ticket.projectId, ticket.token);
  return who === 'mine' ? 'acquired' : who === 'other' ? 'busy' : 'no-project';
}

/**
 * 续锁。WHERE 只认票不认余额（口径见计划 T6 第 ④ 段）：过期但还没人接管的锁，
 * 心跳等于一次少往返的重新 acquire；一旦有人接管，票已经换人 ⇒ `'lost'`。
 * 工程行没了也返回 `'lost'`（而不是抛）：调用方对"我没锁了"与"工程没了"的动作是同一个 —— 停手。
 */
export async function heartbeat(
  pool: Pool,
  ticket: LockTicket,
  ttlMs: number = LOCK_TTL_MS,
): Promise<HeartbeatOutcome> {
  const micros = ttlToMicroseconds(ttlMs);
  const [res] = await pool.query(
    'UPDATE `project` SET `lock_expires_at` = TIMESTAMPADD(MICROSECOND, ?, NOW(3)) ' +
      'WHERE `id` = ? AND `lock_token` = ?',
    [micros, ticket.projectId, ticket.token],
  );
  if (affected(res) === 1) return 'renewed';
  return (await decide(pool, ticket.projectId, ticket.token)) === 'mine' ? 'renewed' : 'lost';
}

/**
 * 解锁。只清自己的票：WHERE 带 `lock_token = ?`，接管之后这一发匹配不上 ⇒ `'not-mine'`，
 * 别人的余额一个字不动（`locks.test.ts` 里那条判据的形状）。
 * 这一发不需要读回：匹配上的行必然要把三列从非 NULL 改成 NULL ⇒ 一定算"变化"。
 */
export async function releaseLock(pool: Pool, ticket: LockTicket): Promise<ReleaseOutcome> {
  const [res] = await pool.query(
    'UPDATE `project` SET `lock_token` = NULL, `lock_owner` = NULL, `lock_expires_at` = NULL ' +
      'WHERE `id` = ? AND `lock_token` = ?',
    [ticket.projectId, ticket.token],
  );
  return affected(res) === 1 ? 'released' : 'not-mine';
}

/**
 * 读锁状态（只读，不加锁、不写）。`token` 传 null 就是"我只想知道有没有人拿着，不参与判定"。
 * 余额在这一发里只做一次 µs→ms 的换算；`locks.test.ts` 另有一格在同一语句里读 `DIV 1000`
 * —— 两处换算各有各的证人（T6-M10 一次打两个）。
 */
export async function lockState(
  pool: Pool,
  projectId: EntityId,
  token: EntityId | null = null,
): Promise<LockState> {
  const [res] = await pool.query(
    'SELECT `lock_owner` AS owner, ' +
      '(`lock_token` IS NOT NULL AND `lock_token` = ?) AS matched, ' +
      `(${HELD_SQL}) AS held, ` +
      'IFNULL(TIMESTAMPDIFF(MICROSECOND, NOW(3), `lock_expires_at`), 0) AS ttl_us ' +
      'FROM `project` WHERE `id` = ?',
    [token, projectId],
  );
  const row = (
    res as { owner: string | null; matched: number | null; held: number | null; ttl_us: number | string | null }[]
  )[0];
  if (!row) {
    return { exists: false, held: false, mine: false, owner: null, ttlMsRemaining: 0 };
  }
  const held = Number(row.held) === 1;
  const micros = Number(row.ttl_us);
  return {
    exists: true,
    held,
    mine: held && Number(row.matched) === 1,
    owner: row.owner,
    // 向下取整：宁可报"比真值少一毫秒"，也不报一把已经不活的锁还有余额。
    ttlMsRemaining: held && Number.isFinite(micros) && micros > 0 ? Math.trunc(micros / 1000) : 0,
  };
}
```

Run: `npx vitest run --config vitest.config.ts apps/desktop/test/unit/locks-ticket.test.ts > tmp/t6-ticket2.log 2>&1; echo "exit=$?"`
Expected: `exit=0`，**9 格**全绿。`pnpm typecheck` 里 desktop 那一档同步过一次（`locks.ts` 无测试期编译期主张，形状主张在下一档）。

- [ ] **Step 4: 写连库的那一档 —— `locks.test.ts`**

`apps/desktop/test/db/locks.test.ts`：

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'mysql2/promise';
import {
  Document,
  SCHEMA_VERSION,
  applyPatch,
  storeyCreate,
  uuidv7,
  type Command,
  type Entity,
  type EntityId,
  type Patch,
} from '@dajia/core';
import { createDbPool } from '../../src/main/db/pool';
import { readMysqlEnv } from '../../src/main/db/env';
import { dropTestDatabase, ensureDatabase } from '../../src/main/db/database';
import { migrate } from '../../src/main/db/migrate';
import { ProjectRepository } from '../../src/main/db/repository';
import {
  LOCK_TTL_MS,
  acquireLock,
  heartbeat,
  lockState,
  newLockTicket,
  releaseLock,
  type LockTicket,
} from '../../src/main/db/locks';

const env = readMysqlEnv();
// 红线同前两档：库名由本文件写死，不抄 env（env.database 允许是 dajia）。
const DATABASE = 'dajia_test';
const PROJECT_ID = '0193aa00-0000-7000-8000-00000000000a' as EntityId;
const OTHER_PROJECT = '0193aa00-0000-7000-8000-00000000000f' as EntityId;

/** 一格里的两个"机器"。名字只在 owner 文案里出现，不参与判定。 */
const OWNER_A = '机器A:1001';
const OWNER_B = '机器B:2002';

let pool: Pool;
let holderPool: Pool;
let rivalPool: Pool;
let repo: ProjectRepository;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [res] = await pool.query(sql, params);
  return res as T[];
}

async function count(table: string, where = '', params: unknown[] = []): Promise<number> {
  const [res] = await pool.query(`SELECT COUNT(*) AS n FROM \`${table}\`${where}`, params);
  return Number((res as { n: number | string }[])[0]?.n);
}

/** 手搓坏列用的那一发（返回值是 affectedRows，判据要求它真改到行才算夹具立住了）。 */
async function exec(sql: string, params: unknown[] = []): Promise<number> {
  const [res] = await pool.query(sql, params);
  return Number((res as { affectedRows?: number }).affectedRows ?? 0);
}

async function clearAll(): Promise<void> {
  await pool.query('DELETE FROM `project`');
}

function ticket(owner: string, projectId: EntityId = PROJECT_ID): LockTicket {
  return newLockTicket({ projectId, owner });
}

/**
 * 条件轮询而不是固定 sleep：等的是"服务端说这把锁没余额了"那个**状态**，
 * 不是 300 毫秒（P-4 的代价：TTL 只能真等，不能拨表）。
 * 这一处 `performance.now()` 在测试里 —— 第 ② 段那条"产品代码不读客户机时钟"的扫描管的是 `locks.ts`，
 * 测试要计时总得有表。
 */
async function waitUntilNotHeld(projectId: EntityId, token: EntityId, deadlineMs = 5_000): Promise<void> {
  const started = performance.now();
  for (;;) {
    const state = await lockState(pool, projectId, token);
    if (!state.held) return;
    if (performance.now() - started > deadlineMs) {
      throw new TypeError(`等 ${deadlineMs}ms 锁还没过期：${JSON.stringify(state)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function step(doc: Document, cmd: Command): { patch: Patch; doc: Document } {
  const patch = cmd.build(doc);
  return { patch, doc: applyPatch(doc, patch).doc };
}

beforeAll(async () => {
  await dropTestDatabase(env, DATABASE);
  await ensureDatabase(env, DATABASE);
  pool = createDbPool({ ...env, database: DATABASE });
  await migrate(pool, DATABASE);
  // 两个池 = 两台机器。connectionLimit 用 2 而不是 1：并发那一格要两条连接真并发。
  // lockWaitTimeoutSeconds 2（不是默认 50 秒）：万一将来有人把 CAS 改成"先 SELECT FOR UPDATE 再 UPDATE"，
  // 这里 2 秒就炸，而不是让测试看起来像挂死（P-17 那条口径在锁这一档的形状）。
  holderPool = createDbPool(
    { ...env, database: DATABASE },
    { connectionLimit: 2, lockWaitTimeoutSeconds: 2 },
  );
  rivalPool = createDbPool(
    { ...env, database: DATABASE },
    { connectionLimit: 2, lockWaitTimeoutSeconds: 2 },
  );
  repo = new ProjectRepository(pool, PROJECT_ID, 'watcher');
});

afterAll(async () => {
  await rivalPool.end();
  await holderPool.end();
  await pool.end();
  await dropTestDatabase(env, DATABASE);
});

beforeEach(async () => {
  await clearAll();
  await repo.createProject({ name: '锁样例工程', schemaVersion: SCHEMA_VERSION });
});

describe('拿锁（单语句 CAS）', () => {
  it('没人上锁 ⇒ acquired，三列都有账', async () => {
    const a = ticket(OWNER_A);
    expect(await acquireLock(holderPool, a, 60_000)).toBe('acquired');
    const state = await lockState(pool, PROJECT_ID, a.token);
    expect(state.exists).toBe(true);
    expect(state.held).toBe(true);
    expect(state.mine).toBe(true);
    expect(state.owner).toBe(OWNER_A);
    expect(state.ttlMsRemaining).toBeGreaterThan(0);
    expect(state.ttlMsRemaining).toBeLessThanOrEqual(60_000);
  });

  it('同一张票再拿一次 ⇒ acquired（幂等，不是 busy）', async () => {
    const a = ticket(OWNER_A);
    expect(await acquireLock(holderPool, a, 60_000)).toBe('acquired');
    expect(await acquireLock(holderPool, a, 60_000)).toBe('acquired');
    expect((await lockState(pool, PROJECT_ID, a.token)).owner).toBe(OWNER_A);
  });

  it('别人持着活锁 ⇒ busy，且读得到是谁', async () => {
    const a = ticket(OWNER_A);
    const b = ticket(OWNER_B);
    expect(await acquireLock(holderPool, a, 60_000)).toBe('acquired');
    expect(await acquireLock(rivalPool, b, 60_000)).toBe('busy');
    // busy 那一发不许改到任何东西：票、owner、余额都还是 A 的。
    const state = await lockState(pool, PROJECT_ID, b.token);
    expect(state.held).toBe(true);
    expect(state.mine).toBe(false);
    expect(state.owner).toBe(OWNER_A);
    expect((await lockState(pool, PROJECT_ID, a.token)).mine).toBe(true);
  });

  it('工程行不存在 ⇒ no-project，不是 busy', async () => {
    const ghost = ticket(OWNER_A, uuidv7() as EntityId);
    expect(await acquireLock(holderPool, ghost, 60_000)).toBe('no-project');
    expect((await lockState(pool, ghost.projectId, ghost.token)).exists).toBe(false);
  });

  it('锁按工程分：A 持 P1 不妨碍 B 拿 P2', async () => {
    const other = new ProjectRepository(pool, OTHER_PROJECT, 'watcher');
    await other.createProject({ name: '第二个工程', schemaVersion: SCHEMA_VERSION });
    const a = ticket(OWNER_A, PROJECT_ID);
    const b = ticket(OWNER_B, OTHER_PROJECT);
    expect(await acquireLock(holderPool, a, 60_000)).toBe('acquired');
    expect(await acquireLock(rivalPool, b, 60_000)).toBe('acquired');
    expect((await lockState(pool, PROJECT_ID, a.token)).owner).toBe(OWNER_A);
    expect((await lockState(pool, OTHER_PROJECT, b.token)).owner).toBe(OWNER_B);
  });

  it('解 P1 的锁不动 P2 的锁', async () => {
    const other = new ProjectRepository(pool, OTHER_PROJECT, 'watcher');
    await other.createProject({ name: '第二个工程', schemaVersion: SCHEMA_VERSION });
    const a = ticket(OWNER_A, PROJECT_ID);
    const b = ticket(OWNER_B, OTHER_PROJECT);
    await acquireLock(holderPool, a, 60_000);
    await acquireLock(rivalPool, b, 60_000);
    expect(await releaseLock(holderPool, a)).toBe('released');
    expect((await lockState(pool, OTHER_PROJECT, b.token)).held).toBe(true);
    expect((await lockState(pool, PROJECT_ID, a.token)).held).toBe(false);
  });
});

describe('过期与接管（判定全在服务端时钟）', () => {
  it('ttlMs = 0 的锁写完就不算活（SLEEP 跨过 1 毫秒刻度，不是靠 sleep 撞）', async () => {
    const a = ticket(OWNER_A);
    expect(await acquireLock(holderPool, a, 0)).toBe('acquired');
    await rows<{ s: number }>('SELECT SLEEP(0.002) AS s');
    const state = await lockState(pool, PROJECT_ID, a.token);
    expect(state.held).toBe(false);
    expect(state.mine).toBe(false);
    expect(state.ttlMsRemaining).toBe(0);
    // 票还在列上：过期不等于释放。这是第 ④ 段"心跳能复活"的前提。
    expect((await rows<{ owner: string | null }>('SELECT `lock_owner` AS owner FROM `project` WHERE `id` = ?', [PROJECT_ID]))[0]?.owner).toBe(OWNER_A);
  });

  it('过期的锁可以被第二个池接管，接管者三列全换成自己的', async () => {
    const a = ticket(OWNER_A);
    const b = ticket(OWNER_B);
    expect(await acquireLock(holderPool, a, 0)).toBe('acquired');
    await rows<{ s: number }>('SELECT SLEEP(0.002) AS s');
    expect(await acquireLock(rivalPool, b, 60_000)).toBe('acquired');
    expect((await lockState(pool, PROJECT_ID, b.token)).mine).toBe(true);
    expect((await lockState(pool, PROJECT_ID, a.token)).mine).toBe(false);
    expect((await lockState(pool, PROJECT_ID, null)).owner).toBe(OWNER_B);
  });

  it('列被手搓成"票为空而余额在未来"⇒ 照样能拿（ACQUIRE_WHERE 那一支的证人）', async () => {
    const a = ticket(OWNER_A);
    expect(await acquireLock(holderPool, a, 60_000)).toBe('acquired');
    expect(
      await exec('UPDATE `project` SET `lock_token` = NULL, `lock_owner` = NULL WHERE `id` = ?', [
        PROJECT_ID,
      ]),
    ).toBe(1);
    const b = ticket(OWNER_B);
    expect(await acquireLock(rivalPool, b, 60_000)).toBe('acquired');
  });

  it('列被手搓成"票有值而余额为空"⇒ 别人能拿（HELD 的 NULL 分支）', async () => {
    const a = ticket(OWNER_A);
    expect(await acquireLock(holderPool, a, 60_000)).toBe('acquired');
    expect(await exec('UPDATE `project` SET `lock_expires_at` = NULL WHERE `id` = ?', [PROJECT_ID])).toBe(1);
    const b = ticket(OWNER_B);
    expect(await acquireLock(rivalPool, b, 60_000)).toBe('acquired');
    expect((await lockState(pool, PROJECT_ID, b.token)).mine).toBe(true);
  });

  it('真等接管全链：A 的锁过期 ⇒ B 拿走 ⇒ A 下一次心跳 lost', async () => {
    const a = ticket(OWNER_A);
    const b = ticket(OWNER_B);
    expect(await acquireLock(holderPool, a, 300)).toBe('acquired');
    expect(await heartbeat(holderPool, a, 300)).toBe('renewed');
    await waitUntilNotHeld(PROJECT_ID, a.token);
    expect(await acquireLock(rivalPool, b, 60_000)).toBe('acquired');
    expect(await heartbeat(holderPool, a, 60_000)).toBe('lost');
    // A 的 beat 不许动 B 的账（WHERE 带 token 的那一半凭据）。
    expect((await lockState(pool, PROJECT_ID, b.token)).mine).toBe(true);
    expect((await lockState(pool, PROJECT_ID, null)).owner).toBe(OWNER_B);
  });

  it('接管之后原持有者解锁 ⇒ not-mine，且接管者的余额原样还在', async () => {
    const a = ticket(OWNER_A);
    const b = ticket(OWNER_B);
    expect(await acquireLock(holderPool, a, 0)).toBe('acquired');
    await rows<{ s: number }>('SELECT SLEEP(0.002) AS s');
    expect(await acquireLock(rivalPool, b, 60_000)).toBe('acquired');
    expect(await releaseLock(holderPool, a)).toBe('not-mine');
    const after = await lockState(pool, PROJECT_ID, b.token);
    expect(after.held).toBe(true);
    expect(after.mine).toBe(true);
    expect(after.owner).toBe(OWNER_B);
    expect(after.ttlMsRemaining).toBeGreaterThan(0);
  });
});

describe('心跳', () => {
  it('活锁 beat ⇒ renewed', async () => {
    const a = ticket(OWNER_A);
    await acquireLock(holderPool, a, 60_000);
    expect(await heartbeat(holderPool, a, 60_000)).toBe('renewed');
    expect((await lockState(pool, PROJECT_ID, a.token)).held).toBe(true);
  });

  it('过期但仍是我的票 ⇒ beat 把它复活（第 ④ 段那条口径的证人）', async () => {
    const a = ticket(OWNER_A);
    expect(await acquireLock(holderPool, a, 0)).toBe('acquired');
    await rows<{ s: number }>('SELECT SLEEP(0.002) AS s');
    expect((await lockState(pool, PROJECT_ID, a.token)).held).toBe(false);
    expect(await heartbeat(holderPool, a, 60_000)).toBe('renewed');
    const after = await lockState(pool, PROJECT_ID, a.token);
    expect(after.held).toBe(true);
    expect(after.mine).toBe(true);
    expect(after.ttlMsRemaining).toBeGreaterThan(0);
  });

  it('心跳只推余额：票与 owner 一个字不动', async () => {
    const a = ticket(OWNER_A);
    await acquireLock(holderPool, a, 0);
    const before = await rows<{ token: string | null; owner: string | null }>(
      'SELECT `lock_token` AS token, `lock_owner` AS owner FROM `project` WHERE `id` = ?',
      [PROJECT_ID],
    );
    expect(await heartbeat(holderPool, a, 60_000)).toBe('renewed');
    const after = await rows<{ token: string | null; owner: string | null }>(
      'SELECT `lock_token` AS token, `lock_owner` AS owner FROM `project` WHERE `id` = ?',
      [PROJECT_ID],
    );
    expect(after[0]).toEqual(before[0]);
  });

  it('工程行被删 ⇒ lost（不抛）：调用方对两种情况的动作是同一个', async () => {
    const a = ticket(OWNER_A);
    await acquireLock(holderPool, a, 60_000);
    await clearAll();
    expect(await heartbeat(holderPool, a, 60_000)).toBe('lost');
  });

  it('余额读数按毫秒：60_000 的锁读回来在 (50_000, 60_000]', async () => {
    const a = ticket(OWNER_A);
    await acquireLock(holderPool, a, 60_000);
    const state = await lockState(pool, PROJECT_ID, a.token);
    expect(state.ttlMsRemaining).toBeGreaterThan(50_000);
    expect(state.ttlMsRemaining).toBeLessThanOrEqual(60_000);
  });

  it('同一语句里算的差值也按毫秒：DIV 1000 的读数落在 (55_000, 60_000]', async () => {
    const a = ticket(OWNER_A);
    await acquireLock(holderPool, a, 60_000);
    const read = await rows<{ ms: number | string }>(
      'SELECT TIMESTAMPDIFF(MICROSECOND, NOW(3), `lock_expires_at`) DIV 1000 AS ms ' +
        'FROM `project` WHERE `id` = ?',
      [PROJECT_ID],
    );
    const ms = Number(read[0]?.ms);
    expect(ms).toBeGreaterThan(55_000);
    expect(ms).toBeLessThanOrEqual(60_000);
    // 顺手把"余额是被 TTL 决定的"钉住：改成写死一天，上面两格一起红（T6-M10 的另一半）。
    expect(ms).toBeLessThanOrEqual(LOCK_TTL_MS * 4);
  });
});

describe('解锁', () => {
  it('release ⇒ released，三列一起归 NULL', async () => {
    const a = ticket(OWNER_A);
    await acquireLock(holderPool, a, 60_000);
    expect(await releaseLock(holderPool, a)).toBe('released');
    const raw = await rows<{ token: string | null; owner: string | null; expires: string | null }>(
      'SELECT `lock_token` AS token, `lock_owner` AS owner, `lock_expires_at` AS expires FROM `project` WHERE `id` = ?',
      [PROJECT_ID],
    );
    expect(raw[0]).toEqual({ token: null, owner: null, expires: null });
    const state = await lockState(pool, PROJECT_ID, a.token);
    expect(state.held).toBe(false);
    expect(state.owner).toBe(null);
    expect(state.ttlMsRemaining).toBe(0);
  });

  it('没上锁时 release ⇒ not-mine（快路不需要读回的那一型）', async () => {
    expect(await releaseLock(holderPool, ticket(OWNER_A))).toBe('not-mine');
  });

  it('release 两次 ⇒ 第二次 not-mine（幂等不许说成 released）', async () => {
    const a = ticket(OWNER_A);
    await acquireLock(holderPool, a, 60_000);
    expect(await releaseLock(holderPool, a)).toBe('released');
    expect(await releaseLock(holderPool, a)).toBe('not-mine');
  });

  it('release 之后 beat ⇒ lost', async () => {
    const a = ticket(OWNER_A);
    await acquireLock(holderPool, a, 60_000);
    await releaseLock(holderPool, a);
    expect(await heartbeat(holderPool, a, 60_000)).toBe('lost');
  });

  it('release 只解一张票，不动别人的锁', async () => {
    const a = ticket(OWNER_A);
    const b = ticket(OWNER_B);
    await acquireLock(rivalPool, b, 60_000);
    expect(await releaseLock(holderPool, a)).toBe('not-mine');
    expect((await lockState(pool, PROJECT_ID, b.token)).mine).toBe(true);
  });
});

describe('两个池同时抢（不等时钟）', () => {
  it('并发 acquire ⇒ 恰好一个 acquired、一个 busy', async () => {
    const a = ticket(OWNER_A);
    const b = ticket(OWNER_B);
    const [ra, rb] = await Promise.all([
      acquireLock(holderPool, a, 60_000),
      acquireLock(rivalPool, b, 60_000),
    ]);
    expect([ra, rb].sort()).toEqual(['acquired', 'busy']);
    const winner = ra === 'acquired' ? a : b;
    const state = await lockState(pool, PROJECT_ID, winner.token);
    expect(state.mine).toBe(true);
    expect(state.owner === OWNER_A && state.owner === OWNER_B).toBe(false);
    // 隔离级别只是这条判据的背景说明，不是判据本身：真并发下的形状由这一格测。
    const iso = await rows<{ level: string }>('SELECT @@transaction_isolation AS level');
    process.stdout.write(`[T6] transaction_isolation=${iso[0]?.level ?? '读不到'}\n`);
  });

  it('赢家释放后输家能拿到（锁没被"赢完就僵住"）', async () => {
    const a = ticket(OWNER_A);
    const b = ticket(OWNER_B);
    const [ra] = await Promise.all([
      acquireLock(holderPool, a, 60_000),
      acquireLock(rivalPool, b, 60_000),
    ]);
    const winner = ra === 'acquired' ? a : b;
    const loser = winner === a ? b : a;
    expect(await releaseLock(holderPool, winner)).toBe('released');
    expect(await acquireLock(rivalPool, loser, 60_000)).toBe('acquired');
  });
});

describe('锁与写路径互不知情（第 ⑥ 段那对相反的判据）', () => {
  it('拿锁不动账：journal_turn 与四张表一个字不变', async () => {
    const before = await rows<{ turn: number | string }>(
      'SELECT `journal_turn` AS turn FROM `project` WHERE `id` = ?',
      [PROJECT_ID],
    );
    const a = ticket(OWNER_A);
    await acquireLock(holderPool, a, 60_000);
    await heartbeat(holderPool, a, 60_000);
    await releaseLock(holderPool, a);
    const after = await rows<{ turn: number | string }>(
      'SELECT `journal_turn` AS turn FROM `project` WHERE `id` = ?',
      [PROJECT_ID],
    );
    expect(after[0]?.turn).toBe(before[0]?.turn);
    expect(await count('command_log')).toBe(0);
    expect(await count('element')).toBe(0);
    expect(await count('storey')).toBe(0);
    expect(await count('snapshot')).toBe(0);
  });

  it('没拿锁也能 appendJournal ⇒ applied（S1 不建模"对抗自己的代码"）', async () => {
    const t1 = step(
      Document.create(PROJECT_ID),
      storeyCreate({ projectId: PROJECT_ID, index: 0, elevationMm: 0, heightMm: 3000 }),
    );
    // 这一格钉的是**现状**：写路径认不认票是一个会被下一个人误改的口径。
    // 若将来要给 appendJournal 加锁校验，改的是这条判据与计划文本，不许两边都留着。
    expect(await repo.appendJournal({ turn: 1, patch: t1.patch, doc: t1.doc })).toBe('applied');
    const state = await lockState(pool, PROJECT_ID, null);
    expect(state.held).toBe(false);
    expect((t1.patch.upsert[0] as Entity).kind).toBe('storey');
  });
});
```

Run: `npx vitest run --config vitest.db.config.ts apps/desktop/test/db/locks.test.ts > tmp/t6-locks.log 2>&1; echo "exit=$?"`
Expected: `exit=0`，**27 格**全绿（六档 describe 各 6/6/6/5/2/2，落盘前按 `^\s*it\(` 在本文本上数过）。两处 `[T6]` 读数（隔离级别）抄进执行回填。若 `并发 acquire` 那一格拿到 `['acquired','acquired']` ⇒ **先停下别改判据**：那说明驱动把两条语句排成了队（`connectionLimit` 或 `pool.query` 的取连接行为），读数抄进回填并把它登记成 T10 的额外凭据要求，node 侧只承认"恰好一个持有者"这一半不变式。

- [ ] **Step 5: 全量复跑与计数**

```bash
pnpm verify > tmp/t6-verify.log 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' tmp/t6-verify.log | grep -E "^ *(Test Files|Tests) "
pnpm test:db > tmp/t6-db.log 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' tmp/t6-db.log | grep -E "^ *(Test Files|Tests) |FAIL"
npx tsc --noEmit -p apps/desktop/tsconfig.test.json > tmp/t6-tsc.log 2>&1; echo "exit=$?"
```

Expected：`pnpm verify` `exit=0`，`Test Files` 比 T5 的回填值 **+1**（只多 `locks-ticket.test.ts`），`Tests` **+9**；`pnpm test:db` `exit=0`，`Test Files` **+1**、`Tests` **+27**；`tsc` `exit=0`。
`lint:deps` 照旧静默：`locks.ts` 只 import `@dajia/core` 与 `mysql2/promise`（后者只在类型位上出现，`Pool` 是 type import）。

跑完确认库清干净（命令同 T5 Step 6，**从 `apps/desktop` 目录跑**）。Expected：既没有 `dajia_test` 也没有 `dajia`。

- [ ] **Step 6: 提交（代码棒只提交 src 与 test，`docs/` 归控制位）**

```bash
git status --porcelain
git diff
git add apps/desktop/src/main/db/locks.ts apps/desktop/test/unit/locks-ticket.test.ts \
  apps/desktop/test/db/locks.test.ts
git commit -m "$(cat <<'EOF'
feat(persist): 工程锁 —— 服务端时钟的三发 CAS，判决来自写完后的读回

locks.ts：acquireLock / heartbeat / releaseLock / lockState 全部单语句 CAS，
过期判定与写入都用 NOW(3) / TIMESTAMPADD / TIMESTAMPDIFF，客户机时钟一次都不读（P-4）。
affectedRows 只当快路（MySQL 数真变化的行），同毫秒重发与"工程行不存在"都靠读回分家；
心跳只认票不认余额，接管后原持有者 beat 得 lost、release 得 not-mine。
两个池抢同一行有格（并发恰好一个赢家），"拿锁不动账"与"没拿锁也能写"两格把
第 ⑥ 段那条口径钉住 —— appendJournal 不认票，闸门在调用侧（T7/T8）。
EOF
)"
```

---

**Task 6 的改坏验证**（变异棒，`cp` 备份 + md5 还原；**座位不许 `git checkout`/`restore`/`stash`/`reset`/`clean`**）：

用例引用一律用 `it` 的名字，不用"第 N 格"。

| # | 改坏哪里 | 哪一格红、为什么 |
|---|---|---|
| T6-M1 | `ACQUIRE_WHERE` 删掉 ``lock_token` IS NULL` 那一支 | 「列被手搓成"票为空而余额在未来"」红（拿到 'busy'，锁僵死）—— 那一支看着与 `NOT (HELD)` 重复，这一发就是它存在的凭据 |
| T6-M2 | `HELD_SQL` 的 `>` 改成 `>=` | 「ttlMs = 0 的锁写完就不算活」红（SLEEP 2 毫秒之后 `held` 仍 true）。第 ③ 段那对"两端"判据之一 |
| T6-M3 | 接管条件另写一份 ``lock_expires_at` < NOW(3)`（不再用 `NOT (HELD_SQL)`） | 「列被手搓成"票有值而余额为空"」红：`NOT (NULL < NOW(3))` 是 SQL `NULL` ⇒ WHERE 永假 ⇒ 没人拿得到。**这一发抓的正是"两个产地各漂一半"** |
| T6-M4 | `ACQUIRE_WHERE` 删掉 ``lock_token` = ?` 那一支 | 「同一张票再拿一次」红（活锁下第二发变 'busy'，幂等出口没了） |
| T6-M5 | `heartbeat` 的 WHERE 删掉 ``lock_token` = ?`（只按 id） | 「真等接管全链」红（A 被抢走后仍能 'renewed'，还把 B 的余额改成 A 的口径）；「接管之后原持有者解锁」同型 —— 两把 WHERE 少一处就少一层皮 |
| T6-M6 | `heartbeat` 的 SET 改成 ``lock_expires_at` = `lock_expires_at`` | 「过期但仍是我的票 ⇒ beat 把它复活」红（'renewed' 拿得到而 `held` 回不来）。**注意这一发不会红在"活锁 beat"**：那格只读 `held`，值本来就已经在未来 —— 两条判据各管一头 |
| T6-M7 | `releaseLock` 只清 `lock_token`，不清 `lock_owner` / `lock_expires_at` | 「release ⇒ released，三列一起归 NULL」红（`raw[0]` 的 toEqual 与 `owner` 读数都还在） |
| T6-M8 | `releaseLock` 的 WHERE 去掉 token（无条件清三列） | 「release 只解一张票，不动别人的锁」红（拿到 'released' 且 B 的锁没了）—— 这一发是"替别人解锁"那型唯一的证人 |
| T6-M9 | 删掉 `decide()`，`acquireLock` / `heartbeat` 以 `affectedRows` 为唯一判据 | 「工程行不存在 ⇒ no-project」红（变 'busy'）。**登记的限度**：第 ⑤ 段的"同毫秒重发逐字节相同"造不出确定红（要两条语句落在同一个 `NOW(3)` 刻度上，Step 1 的 D 档只证那台机器上真会给 0）。所以 `decide()` 上面那段理由注释是这条改动的全部防线，不许因为"测不到"就把它当冗余删掉 |
| T6-M10 | 余额换算漂单位：`lockState` 直接把 µs 当 ms 返回（或 `TIMESTAMPDIFF` 改用 `SECOND`） | 「余额读数按毫秒」红（60_000_000 或 60 都越界）；「同一语句里算的差值」红在另一处（`DIV 1000` 与 JS 的 `/1000` 各有一格，T6-M10 一次打两个） |
| T6-M11 | `ttlToMicroseconds` 的越界校验删掉 | 「0 合法、15000 换算对、越界四型抛」红。实测主张抄 Step 1 的 G 档：负 TTL **不报错**，它把 `lock_expires_at` 写到过去 ⇒ acquire 返回 'acquired' 而 `held` false（一把发出去就过期的锁），静默歪账 |
| T6-M12 | `newLockTicket` 的 owner 长度校验删掉 | 「owner 201 个字符 ⇒ 抛，且文案带着那把尺（200）」红：MySQL strict mode 会抛 1406，但文案里没有我们的那把尺（F 档读它的实际形态） |
| T6-M13 | token 从 `uuidv7()` 换成 `Math.random().toString(36)` 手搓 | 「token 由 uuidv7 现调：过 isEntityId」红。**MySQL 一声不响** —— `CHAR(36) ascii_bin` 塞得下任意 36 字符，只有形状断言看得见这一型 |
| T6-M14 | 三发 CAS 的 WHERE 去掉 ``id` = ?`（全库一把锁） | 「锁按工程分」与「解 P1 的锁不动 P2 的锁」两格红；`locks-ticket.test.ts` 的源码扫描那一格同时红（它数的是 `UPDATE \`project\`` 后面必须跟 `` `id` = ? ``） |
| T6-M15 | 把 `HELD` 判定搬到 JS 里（读回 `lock_expires_at` 与 `Date.now()` 比） | `locks-ticket.test.ts` 的「locks.ts 里不许出现客户机时钟」红。这一格是 P-4 那条口径唯一的常驻证人；代价是它扫的是源码文本 —— 与 T3 那条「`storey.ts` 不许留第二份重叠规则」同族，评审按同一标准看 |
| T6-M16 | 把 `holderPool` 与 `rivalPool` 合成一个池 | 本任务用例**全绿** —— 登记的限度：排队也恰好得到一个赢家一个输家，所以「并发 acquire」证的是"只有一个持有者"这一半不变式，**不是**"真并发下 CAS 安全"那一半。后者的凭据在 T10 的 `--lock-shot`（两个真 electron 进程，P-14 那一笔账），别把这一格当它用完了 |


## Task 7: 保存引擎（`autosave.ts` + `emergency.ts` + core 的 `lastPatch`）

**Files:**
- Modify: `packages/core/src/model/transaction.ts`（加 `lastPatch`，三个赋值点：dispatch / undo / redo）
- Modify: `packages/core/test/transaction.test.ts`（**+7 格**，既有的 8 格一条不许改，import 那三行照 Step 1 换）
- Create: `apps/desktop/src/main/persist/autosave.ts`（electron-free、fs-free：队列 + 阈值 + 重试 + 心跳停写）
- Create: `apps/desktop/src/main/persist/describe-error.ts`（`describeError`：`autosave.ts` 与 `emergency.ts` 共同的文案出口，两个读者 ⇒ 一份规则；不 import electron、不 import fs）
- Create: `apps/desktop/src/main/persist/emergency.ts`（唯一碰 `node:fs` 的持久化文件；不 import electron）
- Create: `apps/desktop/test/unit/autosave.test.ts`（**24 格**，不连库：假钟 + 假 sink）
- Create: `apps/desktop/test/unit/emergency.test.ts`（**6 格**，真 fs，但目录在 `os.tmpdir()`，不落进仓库）
- Create: `apps/desktop/test/unit/persist-boundary.test.ts`（**2 格**，扫 `persist/**` 的 import 边界：P-2 那条口径的常驻证人）
- Create: `apps/desktop/test/db/autosave-journal.test.ts`（**7 格**，真库 + 真 `ProjectRepository` 当 sink）

**Interfaces:**
- Consumes:
  - T4 的 `import type { JournalEntry, JournalOutcome } from '../db/repository'`（**type-only**：运行时不 load repository，也不把 `mysql2` 的类型链拖进 unit 档）
  - T4 的 `ProjectRepository.appendJournal(entry)` / `writeSnapshot(turn, doc)` —— 本任务把它们当作 `JournalSink` 的实现体（形状由本任务的 `interface JournalSink` 描述，repository 恰好满足它，两边都不 import 对方）
  - T6 的 `LOCK_HEARTBEAT_INTERVAL_MS`（心跳间隔唯一的产地；`autosave.ts` 是它的第一个读者）
  - core 的 `Document` / `Patch` / `EntityId` / `applyPatch` / `affectedIds` / `isEntityId`
- Produces（T8 接线时**只能**用这些名字，不许另起一套）:
  - `class Autosave`：`constructor(options: AutosaveOptions)`、`submit(entry: JournalEntry): 'queued' | 'ignored-duplicate'`、`flush(): Promise<SaveStatus>`、`pause(reason: string): void`、`resume(): void`、`stop(): SaveStatus`、`settled(): Promise<void>`、`status(): SaveStatus`
  - `type AutosavePhase = 'idle' | 'saving' | 'failed' | 'paused' | 'stopped'`
  - `interface SaveStatus { phase; queuedTurns; lastTurn; snapshotTurn; rowsSinceSnapshot; lastError; pauseReason }`（renderer 的顶部横幅只读这一个形状，别给 UI 再造一套字段）
  - `interface AutosaveOptions { sink; timer?; snapshotEveryRows?; idleSnapshotMs?; retryDelayMs?; beat?; onStatus?; onEmergency?; fromJournal? }`（**没有心跳间隔旋钮**：那个数只有 T6 的一个产地，能被旋钮覆盖成别的值就等于"数值唯一产地"那句话是假的）
  - `const SNAPSHOT_EVERY_ROWS = 2000`、`const IDLE_SNAPSHOT_MS = 60_000`、`const RETRY_DELAY_MS = 2_000`
  - `interface JournalSink`、`interface SaveTimer`、`interface TimerHandle`、`const realTimer: SaveTimer`
  - `interface EmergencyPayload { projectId; turn; error; doc; patch }`
  - `writeEmergencySnapshot(userDataDir: string, input: EmergencyInput): EmergencyWrite`（`EmergencyWrite = { ok: true; path: string } | { ok: false; error: string; path: string | null }` —— 失败分支的 `path` 是**尽力算出的**落点：守卫那两刀（词干非 UUIDv7、turn 非法）发生在算路径之前，那两种情形它确实是 `null`，其余失败（底下不是目录、盘写满）都有路径可报，T9 的诊断要把"写到了哪"给用户看。`pruneEmergency(userDataDir, keep): string[]`、`emergencyFileName(projectId, turn)`、`const EMERGENCY_DIR_NAME = 'emergency'`、`const EMERGENCY_KEEP = 20`
  - core：`TransactionLog` 的 `get lastPatch(): Patch | null`

**① 为什么 `lastPatch` 长在 core，而不是 renderer 每次重算 `cmd.build(doc)`**：`build` 是闭包，它读的是**当时**那份文档；要拿到"刚才那一发到底改了什么"就得把命令对象留着不放（撤销栈顶上那份是 `undoStack` 的，不是"最后一次应用的那一发"，`undo` 之后两者不同）。更要紧的是计划 4 的账本形状：裁决 P-5 说 undo 与 redo **各产出一发新的 `command_log`**，所以持久化侧要的那一发在 `undo()` 里是 `invertPatch(entry.patch, entry.previous)` 的返回值 —— 它只在 `TransactionLog` 内部出现过，外面没人能重算。重算一份是第二份真源（D2b 的同一把尺），留一个 getter 不是。

**② 为什么 `autosave.ts` 既不 import `electron` 也不 import `node:fs`**：裁决 P-2 的口径 —— 能进 node 测试的东西才有人测。三个注入点把外部世界隔开：`sink`（写库）、`timer`（时钟与定时器）、`onEmergency`（落盘）。`emergency.ts` 是本任务唯一碰 `fs` 的文件，它接的是**参数**（`userDataDir: string`），`app.getPath('userData')` 由 T8 的接线递进来。这样 24 格 unit 能测到"60 秒到了没到""重试了几次""停写之后还写不写"，而真窗口那一半归 T8/T11。

**③ 为什么每一发都带整份 `doc`（而不是只在快照时带）**：T4 的 `JournalEntry` 就要求 `{ turn, patch, doc }` —— `doc` 用来核对归属与 `schemaVersion`（那一发是"一份文档不能写进两个工程的账"的守卫）。既然每发都要带，快照那一发就不必单独再问一次。代价登记在这里：IPC 每发传一份整文档，M1.3 尺度（一栋两层房）在几百 KB 级，而引擎**只留最后一发的引用**（`lastDoc`），队列里的按 turn 排队、写完就 `shift()` 掉 —— 主进程不是文档的仓库，内存真源仍在 renderer（P-9）。

**④ 为什么 `already-applied` 不推进 `rowsSinceSnapshot`**：裁决 P-6 把"每 2000 条命令"落成了**行数计数器**，而计数器的语义是"库里比上一份快照多了几行"。`appendJournal` 返回 `already-applied` 意味着这一发**没有新增行**（撞键走 ODKU 那条幂等支路，T4 实测过它的读数），把它算进去会让阈值提前触发 —— 提前不危险，但会让"第 2000 发"这个说法在实现里彻底失去对应物。`db` 档里那一格（「already-applied 由真库的 journal_turn 判出 ⇒ 行数计数器不推进」：第 2 发先由旁路写进库，引擎随后自己投同一发拿到 `already-applied` ⇒ 库里两行而计数器仍是 1 ⇒ 阈值（2）没到 ⇒ 一份快照都不许落）是这个口径的真库凭据，`unit` 档里那一格（「already-applied 不推进 rowsSinceSnapshot」）是它的快版本。

**⑤ 为什么"同一 turn 只写一份快照"由引擎记住，而不是让库兜**：`writeSnapshot` 是**裸 INSERT**（P-16），重复落盘会撞 `uk_project_turn` 当场抛。引擎这边记住 `snapshotTurn`，`trySnapshot` 遇到 `turn <= snapshotTurn` 直接跳过（返回"不需要写"，不是"写失败"）；库那边留着那把牙 —— 而那把牙的实测证人在 **T4** 的 `repository.test.ts`（「同一个 turn 落两份快照 ⇒ 抛」已经钉过 `Duplicate entry` 的原文），T7 的 `db` 档**不重复它**（重复一遍只会让两档各自漂），它证的是引擎这一侧：「引擎递给 `writeSnapshot` 的那一对 (turn, doc) 同源」—— 假 sink 只数调用次数，看不见内容，`(turn, doc)` 差一发型错配只有真编码-真解码往返才抓得到。

**⑥ 为什么心跳**抛错**也按 `'lost'` 处理**：`beat()` 正常返回时 `'renewed'`/`'lost'` 是服务端给的确切答案；抛错意味着**这个问题没有答案**（连接断了、语句超时、锁那一行正在被别的连接改）。两种可能里有一线是"别人已经接管并正在写"，而后果不对称：多弹一次只读横幅只是难看，双线写同一工程是静默覆盖。所以保守停写，并把"按丢锁处理"写进 `lastError` 让用户看得见（横幅文案归 T8）。这条口径的代价登记在下面的"登记的限度"：真库上的锁漂走不是 T7 证的，是 T6 + T10。

**⑦ 为什么每个 turn 只抢救一次**：spec §9 要的是"存盘失败时同步向 `userData` 写 emergency JSON"，不是"每次重试都写一份"。重试是同一份内存状态的反复尝试，写 5 份逐字节相同的 JSON 只会在盘满的那台机器上把失败放大。所以引擎用 `rescuedTurns: Set<number>` 记账：一个 turn 第一次失败就抢救，之后无论重试几次都不再动盘。因为队列是**按 turn 有序、队首失败就停**（`autosave.ts` 类注释的第 2 条纪律，落在 `drain` 的那个 `break` 上），一直失败的队首只会留下**一份**抢救件（`unit` 档「队首一直失败：抢救一次都不许多，队列一条都不许丢」那一格数的是这个：连投 3 发、`failAllAppends` 恒真、把重试钟拨满 10 轮 ⇒ 抢救序列 `[1]`、`appended` 是空、`queuedTurns` 仍是 3）；队首补写成功后换下一发失败，才多一份抢救 —— 那一份对应的是一份**新的**内存状态，正是 spec 要保的东西（同一档「重试成功 ⇒ 队列补齐、phase 回 idle、同一 turn 的抢救不重复」那一格盯的是这条路）。

**⑧ 为什么 `pruneEmergency` 按文件名里的 turn 排序，不按 mtime**：同一次会话里连续两发失败可能落在同一个毫秒刻度上，`writeFileSync` 之后两份文件的 mtime 相同（Windows 的 NTFS 时间戳是 100ns 刻度，Node 拿到的仍是整数纳秒，但 `readdirSync` 的 `stats` 不保证单调）。turn 是这份账本里唯一能保证"新压旧"的键，而它已经在文件名上了。留这一格的凭据是 Step 5 的 `emergency.test.ts` 里「keep=2 时每个工程各留两份最新的，别人的文件一个都不许少」那一格：工程 A 写 5 份、工程 B 写 3 份，`keep=2` ⇒ 删掉 `A-turn-1/2/3` 与 `B-turn-1`，留下 `A-turn-4`/`A-turn-5` 与 `B-turn-2`/`B-turn-3`；目录里混着的 `notes.txt` 与 `bogus-turn-9999.json` 一个都不许少 —— 不认识形状的文件不是我们的财产。

- [ ] **Step 1: 先给 core 补 7 格（红在"没有这个 getter"）**

`packages/core/test/transaction.test.ts` 的 import 那一段整块换成：

```ts
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  affectedIds,
  applyPatch,
  uuidv7,
  type Command,
  type EntityId,
  type Patch,
  type PointEntity,
  type WallEntity,
} from '@dajia/core';
```

（`Patch` 是新加的：下面两格要把 `log.lastPatch` 当 `Patch` 用，strict 下 `Patch | null` 不拆开就用不了。）

在 `describe('TransactionLog', ...)` 里、`命令 build 抛错时不留半条事务记录` 那一格**之后**追加七格。既有八格一个字不许动 —— 它们跟着搬迁走，`lastPatch` 是纯增量：

```ts
  it('lastPatch：新 log 是 null，dispatch 之后是这一发的正向补丁', () => {
    const log = seed();
    expect(log.lastPatch).toBeNull();
    log.dispatch(movePoint(PID(1), 100, 200));
    expect(log.lastPatch).toEqual({ upsert: [point(PID(1), 100, 200)], remove: [] });
  });

  it('lastPatch：undo 记的是**逆补丁**，不是 undoStack 顶上那份原件', () => {
    const log = seed();
    log.dispatch(movePoint(PID(1), 100, 200));
    const beforeUndo = log.document;
    expect(log.undo()).toBe(true);
    const patch = log.lastPatch;
    if (!patch) throw new TypeError('撤销之后 lastPatch 不该是 null');
    // 形状：撤销那一发把 x 从 100 抬回 0。
    expect(patch).toEqual({ upsert: [point(PID(1), 0, 0)], remove: [] });
    // 功能：把它应用到"撤销前"的文档，得到的就是"撤销后"的文档 —— 记的确实是打过的那一发。
    expect(applyPatch(beforeUndo, patch).doc.canonical()).toBe(log.document.canonical());
  });

  it('lastPatch：redo 之后又是正向补丁，且与 dispatch 那发逐字相同', () => {
    const log = seed();
    log.dispatch(movePoint(PID(1), 100, 200));
    const forward = log.lastPatch;
    log.undo();
    expect(log.redo()).toBe(true);
    expect(log.lastPatch).toEqual(forward);
  });

  it('lastPatch：空栈 undo/redo 返回 false 时不刷（没有"成功落地"就没得报）', () => {
    const log = seed();
    log.dispatch(movePoint(PID(1), 100, 200));
    const patch = log.lastPatch;
    expect(log.undo()).toBe(true);
    expect(log.undo()).toBe(false);
    expect(log.lastPatch).toEqual(patch);
    expect(log.redo()).toBe(true);
    expect(log.redo()).toBe(false);
    expect(log.lastPatch).toEqual({ upsert: [point(PID(1), 100, 200)], remove: [] });
    expect(log.undo()).toBe(false);
    expect(log.lastPatch).toEqual({ upsert: [point(PID(1), 100, 200)], remove: [] });
  });

  it('lastPatch：build 抛错之后停在上一发，失败的补丁绝不进账', () => {
    const log = seed();
    log.dispatch(movePoint(PID(1), 100, 200));
    const good = log.lastPatch;
    const boom: Command = {
      type: 'wall.delete',
      build() {
        throw new TypeError('故意失败');
      },
    };
    expect(() => log.dispatch(boom)).toThrow(/故意失败/);
    // 上一格的兄弟：那一格管"文档与 depth 没动"，这一格管"持久化侧看不见失败的补丁"。
    // 若这里改成失败的补丁，autosave 会把一次没发生过的状态变更写进 command_log。
    expect(log.lastPatch).toEqual(good);
    expect(log.lastPatch).not.toEqual(null);
  });

  it('lastPatch：remove 型补丁带着 remove 名单（账本里删墙那一发靠它）', () => {
    const log = seed();
    const removeWall: Command = {
      type: 'wall.delete',
      build() {
        return { upsert: [], remove: [PID(3)] };
      },
    };
    log.dispatch(removeWall);
    const patch = log.lastPatch as Patch;
    expect(patch.remove).toEqual([PID(3)]);
    expect(patch.upsert).toEqual([]);
    expect(affectedIds(patch)).toEqual(new Set([PID(3)]));
  });

  it('lastPatch：连撤 30 步，每一发的逆补丁都打得回去（S1 验收 2 的持久化侧前置）', () => {
    const log = seed();
    for (let i = 0; i < 30; i++) {
      log.dispatch(movePoint(PID(1), i * 10, i * 20));
    }
    for (let i = 0; i < 30; i++) {
      const before = log.document;
      expect(log.undo()).toBe(true);
      const patch = log.lastPatch;
      if (!patch) throw new TypeError(`撤到第 ${i + 1} 发时 lastPatch 是 null`);
      expect(affectedIds(patch)).toEqual(new Set([PID(1)]));
      // 逐发验证"记的就是打过的那一发"：30 发里任何一发记错（比如记成原件而不是逆件）都会在这里红。
      expect(applyPatch(before, patch).doc.canonical()).toBe(log.document.canonical());
    }
  });
```

Run: `npx vitest run packages/core/test/transaction.test.ts > tmp/t7-core-red.log 2>&1; echo "exit=$?"`
Expected: `exit=1`，**7 红 8 绿**。红的形态是 `log.lastPatch is not a function`（或属性不存在的编译错），不是红的断言文案 —— 若既有 8 格里有红，说明 import 那块换错了。

- [ ] **Step 2: 实现 `lastPatch`（三处赋值点，绿）**

`packages/core/src/model/transaction.ts` 里，`private lastAffected: Set<EntityId> = new Set();` 之后加字段：

```ts
  /**
   * 最近一次**真的打过**的补丁：`dispatch` 记正向、`undo` 记逆向、`redo` 记正向。
   * 计划 4 的 `command_log` 存的就是这一发（裁决 P-3 的 `{ type, patch }`），
   * 而 undo/redo 各产出一发新的账（裁决 P-5），所以这一发在外面无法重算：
   * `invertPatch(entry.patch, entry.previous)` 的两个输入都住在本类内部。
   * 抛错时它停在上一发 —— `dispatch` 里赋值点在 `applyPatch` 之后，`cmd.build` 抛则一个字都没改，
   * 把失败的补丁报出去等于让保存引擎把一次没发生过的状态变更写进库。
   */
  private lastPatchApplied: Patch | null = null;
```

`get affected()` 那一档之后加 getter：

```ts
  /** 最近一次成功落地的补丁；`undo()`/`redo()` 返回 false 时它不动（没打过就没得报）。 */
  get lastPatch(): Patch | null {
    return this.lastPatchApplied;
  }
```

三个方法体各加一行（其余一字不改）。`dispatch` 末行 `this.lastAffected = affectedIds(patch);` 之后：

```ts
    this.lastPatchApplied = patch;
```

`undo` 现在是一行 `this.doc = applyPatch(this.doc, invertPatch(entry.patch, entry.previous)).doc;`，换成先把逆补丁命名下来（**逆补丁必须命名**，否则记进 `lastPatchApplied` 的那份与打出去的那份是两次 `invertPatch` 调用的两个对象 —— 值相同、来源不同，读账的人无从判断哪个是"打过的那一发"）：

```ts
    const inverse = invertPatch(entry.patch, entry.previous);
    this.doc = applyPatch(this.doc, inverse).doc;
    this.redoStack.push(entry);
    this.lastAffected = affectedIds(entry.patch);
    this.lastPatchApplied = inverse;
```

`redo` 末行 `this.lastAffected = affectedIds(entry.patch);` 之后：

```ts
    this.lastPatchApplied = entry.patch;
```

Run: `npx vitest run packages/core/test/transaction.test.ts > tmp/t7-core.log 2>&1; echo "exit=$?"`
Expected: `exit=0`，**15 格**全绿（8 旧 + 7 新）。
Run: `npx tsc --noEmit -p packages/core/tsconfig.json > tmp/t7-core-tsc.log 2>&1; echo "exit=$?"`
Expected: `exit=0`。

- [ ] **Step 3: `apps/desktop/test/unit/autosave.test.ts`（24 格，先把引擎的形状钉下来）**

```ts
import { describe, expect, it } from 'vitest';
import { Document, type EntityId } from '@dajia/core';
import { LOCK_HEARTBEAT_INTERVAL_MS } from '../../src/main/db/locks';
import type { JournalEntry, JournalOutcome } from '../../src/main/db/repository';
import {
  Autosave,
  IDLE_SNAPSHOT_MS,
  RETRY_DELAY_MS,
  SNAPSHOT_EVERY_ROWS,
  type AutosaveOptions,
  type EmergencyPayload,
  type JournalSink,
  type SaveStatus,
  type SaveTimer,
  type TimerHandle,
} from '../../src/main/persist/autosave';

const PROJECT_ID = '0193aa00-0000-7000-8000-0000000000f1' as EntityId;
const STOREY_ID = '0193aa00-0000-7000-8000-0000000000f2' as EntityId;
const POINT_ID = '0193aa00-0000-7000-8000-0000000000f3' as EntityId;

/**
 * 引擎不看文档内容，只看 `doc.projectId`（抢救件要它）与"这一发带的是哪份文档"。
 * 所以 unit 档全程共用一份 `Document.create(PROJECT_ID)`：省掉造样房的噪音，
 * 也让 `rescued[i].doc === DOC` 这种引用相等断言写得动。真房子里的账在 db 档。
 */
const DOC = Document.create(PROJECT_ID);

function entry(turn: number): JournalEntry {
  return {
    turn,
    patch: {
      upsert: [{ kind: 'point', id: POINT_ID, storeyId: STOREY_ID, x: turn * 100, y: 0 }],
      remove: [],
    },
    doc: DOC,
  };
}

/** 定时器回调是同步触发的，但它kick出来的活是 async 的：跑 20 发微任务足够把链推到挂起点。 */
async function tick(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

/**
 * 假钟：只做两件事 —— 报当前时间、按到点顺序跑回调。
 * `advance` 里回调新排的定时器若落在同一个窗口内也会被跑到，但 `armIdle()` 排的是
 * `clock + 60_000`，永远在窗口外 ⇒ 一次 advance 不会把"每 60 秒重试"滚成死循环。
 */
class FakeTimer implements SaveTimer {
  private readonly timers: { id: number; at: number; cb: () => void }[] = [];
  private nextId = 1;
  clock = 0;

  now(): number {
    return this.clock;
  }

  schedule(cb: () => void, ms: number): TimerHandle {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new TypeError(`假钟收到非法延时 ${ms}：定时器不许是负数或 NaN`);
    }
    const id = this.nextId++;
    this.timers.push({ id, at: this.clock + ms, cb });
    return {
      cancel: () => {
        const i = this.timers.findIndex((t) => t.id === id);
        if (i >= 0) this.timers.splice(i, 1);
      },
    };
  }

  advance(ms: number): void {
    const target = this.clock + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.clock = due.at;
      const i = this.timers.indexOf(due);
      if (i >= 0) this.timers.splice(i, 1);
      due.cb();
    }
    this.clock = target;
  }

  pending(): number {
    return this.timers.length;
  }
}

/** 记账型假 sink：谁被调过、按什么顺序、并发度多高、哪些发该抛，全在这里看得见。 */
class FakeSink implements JournalSink {
  readonly appended: number[] = [];
  readonly snapshots: number[] = [];
  maxInFlight = 0;
  failAppends = new Set<number>();
  failAllAppends = false;
  failSnapshots = new Set<number>();
  alreadyApplied = new Set<number>();
  private inFlight = 0;
  private waiter: (() => void) | null = null;
  private waiting: Promise<void> | null = null;

  /** 下一次 append 挂起，直到 `release()`。「队列串行」那一格用它测"队列是不是真串行"。 */
  hold(): void {
    this.waiting = new Promise<void>((resolve) => {
      this.waiter = resolve;
    });
  }

  release(): void {
    const resolve = this.waiter;
    this.waiter = null;
    this.waiting = null;
    resolve?.();
  }

  async appendJournal(entry: JournalEntry): Promise<JournalOutcome> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.waiting) await this.waiting;
      if (this.failAllAppends || this.failAppends.has(entry.turn)) {
        throw Object.assign(new Error(`模拟库故障 turn ${entry.turn}`), { code: 'ECONNREFUSED' });
      }
      this.appended.push(entry.turn);
      return this.alreadyApplied.has(entry.turn) ? 'already-applied' : 'applied';
    } finally {
      this.inFlight -= 1;
    }
  }

  async writeSnapshot(turn: number): Promise<void> {
    if (this.failSnapshots.has(turn)) {
      throw Object.assign(new Error(`模拟快照失败 turn ${turn}`), { code: 'ER_LOCK_WAIT_TIMEOUT' });
    }
    this.snapshots.push(turn);
  }
}

function beatSpy(outcome: () => 'renewed' | 'lost' | 'throw') {
  let count = 0;
  return {
    count: (): number => count,
    beat: async (): Promise<'renewed' | 'lost'> => {
      count += 1;
      const answer = outcome();
      if (answer === 'throw') throw new Error('心跳发不出去');
      return answer;
    },
  };
}

/** 引擎的异步活全部挂在同一条 `chain` 上（定时器回调也接进这条链），所以 `settled()` 是唯一可靠的等待点。 */
function harness(options: Partial<AutosaveOptions> = {}) {
  const sink = new FakeSink();
  const timer = new FakeTimer();
  const statuses: SaveStatus[] = [];
  const rescued: EmergencyPayload[] = [];
  const engine = new Autosave({
    sink,
    timer,
    onStatus: (status) => statuses.push(status),
    onEmergency: (payload) => rescued.push(payload),
    ...options,
  });
  return { sink, timer, statuses, rescued, engine };
}

describe('默认值与入参守卫', () => {
  it('两个阈值是 spec §8.2 的原话；默认值真生效（1 发不到 2000，60 秒到点补一份）', async () => {
    expect(SNAPSHOT_EVERY_ROWS).toBe(2000);
    expect(IDLE_SNAPSHOT_MS).toBe(60_000);
    const { engine, sink, timer } = harness();
    expect(timer.pending()).toBe(0); // 没给 beat ⇒ 构造时一个定时器都不排
    engine.submit(entry(1));
    await engine.settled();
    expect(sink.appended).toEqual([1]);
    expect(sink.snapshots).toEqual([]);
    timer.advance(IDLE_SNAPSHOT_MS);
    await engine.settled();
    expect(sink.snapshots).toEqual([1]);
    expect(engine.status().phase).toBe('idle');
  });

  it('三个延时都是正整数尺：0、负数、小数一律构造期抛', () => {
    // 0 与负数会让阈值判定每发都写或永不写；让它们在构造期响，不等运行期悄悄歪。
    expect(() => harness({ snapshotEveryRows: 0 })).toThrow(/snapshotEveryRows/);
    expect(() => harness({ snapshotEveryRows: -3 })).toThrow(/snapshotEveryRows/);
    expect(() => harness({ snapshotEveryRows: 2.5 })).toThrow(/snapshotEveryRows/);
    expect(() => harness({ idleSnapshotMs: 0 })).toThrow(/idleSnapshotMs/);
    expect(() => harness({ retryDelayMs: -1 })).toThrow(/retryDelayMs/);
  });

  it('submit 的 turn 守卫在投递口：非法 turn 抛，且 sink 一次都没被调', () => {
    const { engine, sink } = harness();
    expect(() => engine.submit(entry(0))).toThrow(/turn/);
    expect(() => engine.submit(entry(1.5))).toThrow(/turn/);
    expect(() => engine.submit(entry(Number.MAX_SAFE_INTEGER + 1))).toThrow(/turn/);
    expect(sink.appended).toEqual([]);
  });

  it('fromJournal 起点按库里的账算：阈值接得上，起点之后的重投不许进队', async () => {
    const { engine, sink } = harness({
      snapshotEveryRows: 3,
      fromJournal: { lastTurn: 11, snapshotTurn: 10, rowsSinceSnapshot: 2 },
    });
    expect(engine.status().lastTurn).toBe(11);
    expect(engine.status().snapshotTurn).toBe(10);
    expect(engine.status().rowsSinceSnapshot).toBe(2);
    // 库里已经欠 2 行 ⇒ 下一发就到 3 ⇒ 快照落在 12，不是 13。
    expect(engine.submit(entry(11))).toBe('ignored-duplicate');
    engine.submit(entry(12));
    await engine.settled();
    expect(sink.snapshots).toEqual([12]);
    expect(engine.status().rowsSinceSnapshot).toBe(0);
    expect(() =>
      new Autosave({
        sink,
        timer: new FakeTimer(),
        fromJournal: { lastTurn: 1, snapshotTurn: null, rowsSinceSnapshot: -1 },
      }),
    ).toThrow(/rowsSinceSnapshot/);
  });
});

describe('追加：顺序、串行、重复投递', () => {
  it('三发按投递顺序进 sink，阈值不到就不写快照', async () => {
    const { engine, sink } = harness({ snapshotEveryRows: 10 });
    engine.submit(entry(1));
    engine.submit(entry(2));
    engine.submit(entry(3));
    await engine.settled();
    expect(sink.appended).toEqual([1, 2, 3]);
    expect(sink.snapshots).toEqual([]);
    expect(engine.status()).toMatchObject({ phase: 'idle', lastTurn: 3, rowsSinceSnapshot: 3 });
  });

  it('already-applied 不推进 rowsSinceSnapshot（P-6 那把尺的定义在这里）', async () => {
    const { engine, sink } = harness({ snapshotEveryRows: 3 });
    sink.alreadyApplied.add(2);
    for (const turn of [1, 2, 3]) engine.submit(entry(turn));
    await engine.settled();
    // 1 加一行、2 不加、3 加一行 ⇒ 2 行，离阈值 3 还差一发
    expect(sink.appended).toEqual([1, 2, 3]);
    expect(sink.snapshots).toEqual([]);
    expect(engine.status().rowsSinceSnapshot).toBe(2);
    engine.submit(entry(4));
    await engine.settled();
    expect(sink.snapshots).toEqual([4]);
    expect(engine.status().snapshotTurn).toBe(4);
  });

  it('队列串行：第一发挂在库里时，第二发不许挤进去', async () => {
    const { engine, sink } = harness({ snapshotEveryRows: 10 });
    sink.hold();
    engine.submit(entry(1));
    engine.submit(entry(2));
    await tick();
    // 挂起期间第二发一次都没试过：并发度 2 的形态是"后发先至"，账上的 turn 序就乱了。
    expect(sink.appended).toEqual([]);
    expect(sink.maxInFlight).toBe(1);
    // `phase` 的五个取值里只有这一格能拍到 `'saving'`：队首真的压在库里、一份都还没落地的那一刻。
    // 别的格要么已经 `settled()`（`idle`），要么先出错（`failed`），要么先停写（`paused`）。
    expect(engine.status().phase).toBe('saving');
    sink.release();
    await engine.settled();
    expect(sink.appended).toEqual([1, 2]);
    expect(sink.maxInFlight).toBe(1);
  });

  it('重复或回退的 turn ⇒ ignored-duplicate，sink 一次都不许多调', async () => {
    const { engine, sink } = harness({ snapshotEveryRows: 10, retryDelayMs: 60_000 });
    engine.submit(entry(1));
    engine.submit(entry(2));
    await engine.settled();
    expect(engine.submit(entry(2))).toBe('ignored-duplicate');
    expect(engine.submit(entry(1))).toBe('ignored-duplicate');
    expect(sink.appended).toEqual([1, 2]);
    // 失败还压在队首的那一发同样"见过"：重投不许在队里堆出两份同 turn。
    sink.failAppends.add(3);
    expect(engine.submit(entry(3))).toBe('queued');
    await engine.settled();
    expect(engine.submit(entry(3))).toBe('ignored-duplicate');
    expect(engine.status().queuedTurns).toBe(1);
  });
});

describe('快照触发', () => {
  it('阈值触发：第 N 发落地即快照，计数归零', async () => {
    const { engine, sink } = harness({ snapshotEveryRows: 3 });
    engine.submit(entry(1));
    engine.submit(entry(2));
    await engine.settled();
    expect(sink.snapshots).toEqual([]);
    engine.submit(entry(3));
    await engine.settled();
    expect(sink.snapshots).toEqual([3]);
    expect(engine.status()).toMatchObject({ snapshotTurn: 3, rowsSinceSnapshot: 0 });
  });

  it('连续 60 秒无编辑 ⇒ 在最后一发上补一份快照', async () => {
    const { engine, sink, timer } = harness({ snapshotEveryRows: 5 });
    engine.submit(entry(1));
    engine.submit(entry(2));
    await engine.settled();
    expect(sink.snapshots).toEqual([]);
    timer.advance(IDLE_SNAPSHOT_MS);
    await engine.settled();
    expect(sink.snapshots).toEqual([2]);
    expect(engine.status().snapshotTurn).toBe(2);
  });

  it('空闲计时随新编辑重置：60 秒是给"没有新动作"计的，不是给第一发计的', async () => {
    const { engine, sink, timer } = harness({ snapshotEveryRows: 5 });
    engine.submit(entry(1));
    await engine.settled();
    timer.advance(IDLE_SNAPSHOT_MS - 1);
    expect(sink.snapshots).toEqual([]);
    engine.submit(entry(2));
    await engine.settled();
    timer.advance(IDLE_SNAPSHOT_MS);
    await engine.settled();
    // 重置漂了的话这里会是 [1, 2]：第一发上落一份没意义的快照。
    expect(sink.snapshots).toEqual([2]);
  });

  it('没有新行就不许空转：拨满三次 60 秒，writeSnapshot 调用次数仍是 0，定时器也不留着', async () => {
    const { engine, sink, timer } = harness({ snapshotEveryRows: 3 });
    for (const turn of [1, 2, 3]) engine.submit(entry(turn));
    await engine.settled();
    expect(sink.snapshots).toEqual([3]);
    for (let i = 0; i < 3; i++) {
      timer.advance(IDLE_SNAPSHOT_MS);
      await engine.settled();
    }
    expect(sink.snapshots).toEqual([3]);
    expect(timer.pending()).toBe(0); // 快照已平 ⇒ 空闲定时器该被撤掉，不是留着每 60 秒空敲一次
  });

  it('同一 turn 只落一份：阈值路径与空闲路径盯上同一发时，后到的那个跳过', async () => {
    const { engine, sink, timer } = harness({ snapshotEveryRows: 2 });
    for (const turn of [1, 2, 3]) engine.submit(entry(turn));
    await engine.settled();
    expect(sink.snapshots).toEqual([2]); // 阈值只在 2 上落了一份
    expect(engine.status().rowsSinceSnapshot).toBe(1); // turn 3 欠着
    timer.advance(IDLE_SNAPSHOT_MS);
    await engine.settled();
    expect(sink.snapshots).toEqual([2, 3]); // 空闲把 3 补上
    timer.advance(IDLE_SNAPSHOT_MS);
    await engine.settled();
    expect(sink.snapshots).toEqual([2, 3]); // 再拨一次不许重写 3（库侧那把牙是 T4「同一个 turn 落两份快照 ⇒ 抛」那一格实测过的）
  });
});

describe('失败、重试与抢救', () => {
  it('append 抛 ⇒ failed、欠款留在队首、每 turn 抢救一次、文案带驱动 code', async () => {
    const E2 = entry(2);
    const { engine, sink, rescued } = harness({ snapshotEveryRows: 10, retryDelayMs: 30_000 });
    sink.failAppends.add(2);
    engine.submit(entry(1));
    engine.submit(E2);
    engine.submit(entry(3));
    await engine.settled();
    expect(sink.appended).toEqual([1]);
    const status = engine.status();
    expect(status.phase).toBe('failed');
    // 失败那发连着它后面那发都还在队里：turn 有序，后发先至会在账上留洞。
    expect(status.queuedTurns).toBe(2);
    expect(status.lastTurn).toBe(1);
    expect(status.lastError).toContain('ECONNREFUSED');
    expect(status.lastError).toContain('模拟库故障 turn 2');
    expect(rescued).toHaveLength(1);
    expect(rescued[0]?.turn).toBe(2);
    expect(rescued[0]?.doc).toBe(DOC);
    expect(rescued[0]?.patch).toBe(E2.patch);
  });

  it('重试成功 ⇒ 队列补齐、phase 回 idle、同一 turn 的抢救不重复', async () => {
    const { engine, sink, timer, rescued } = harness({ snapshotEveryRows: 10 });
    sink.failAppends.add(2);
    for (const turn of [1, 2, 3]) engine.submit(entry(turn));
    await engine.settled();
    expect(rescued).toHaveLength(1);
    sink.failAppends.delete(2);
    timer.advance(RETRY_DELAY_MS);
    await engine.settled();
    expect(sink.appended).toEqual([1, 2, 3]);
    expect(engine.status()).toMatchObject({ phase: 'idle', queuedTurns: 0, lastTurn: 3 });
    expect(rescued).toHaveLength(1); // 重试不是重新写盘（T7 ⑦ 段）
  });

  it('队首一直失败：抢救一次都不许多，队列一条都不许丢', async () => {
    const { engine, sink, timer, rescued } = harness({ retryDelayMs: 1_000 });
    sink.failAllAppends = true;
    for (const turn of [1, 2, 3]) engine.submit(entry(turn));
    await engine.settled();
    for (let i = 0; i < 10; i++) {
      timer.advance(1_000);
      await engine.settled();
    }
    expect(sink.appended).toEqual([]);
    expect(engine.status().queuedTurns).toBe(3);
    // 队首 turn 1 反复失败 ⇒ 只抢救一次。spec §9 的"持续重试"是重试，不是持续写盘。
    expect(rescued.map((p) => p.turn)).toEqual([1]);
  });

  it('快照失败不吞日志：那一发已成立，计数不清零，空闲路径负责再试', async () => {
    const { engine, sink, timer } = harness({ snapshotEveryRows: 3 });
    sink.failSnapshots.add(3);
    for (const turn of [1, 2, 3]) engine.submit(entry(turn));
    await engine.settled();
    expect(sink.appended).toEqual([1, 2, 3]);
    expect(sink.snapshots).toEqual([]);
    const failed = engine.status();
    expect(failed.phase).toBe('failed');
    expect(failed.lastError).toContain('快照 turn 3 失败');
    expect(failed.rowsSinceSnapshot).toBe(3); // 没写成就不清零：清零等于宣布库里有一行快照
    sink.failSnapshots.delete(3);
    timer.advance(IDLE_SNAPSHOT_MS);
    await engine.settled();
    expect(sink.snapshots).toEqual([3]);
    expect(engine.status()).toMatchObject({ phase: 'idle', rowsSinceSnapshot: 0 });
  });

  it('flush 在库不可达时如实报 failed，queuedTurns 不清零（不许假装写完）', async () => {
    const { engine, sink } = harness();
    sink.failAllAppends = true;
    engine.submit(entry(1));
    await engine.settled();
    const after = await engine.flush();
    expect(after.phase).toBe('failed');
    expect(after.queuedTurns).toBe(1);
  });

  it('flush 把欠的收尾快照补上，之后的空闲定时器再敲也不重复落', async () => {
    const { engine, sink, timer } = harness({ snapshotEveryRows: 3 });
    for (const turn of [1, 2, 3, 4]) engine.submit(entry(turn));
    await engine.settled();
    expect(sink.snapshots).toEqual([3]);
    const after = await engine.flush();
    expect(sink.snapshots).toEqual([3, 4]);
    expect(after).toMatchObject({ phase: 'idle', snapshotTurn: 4, rowsSinceSnapshot: 0 });
    timer.advance(IDLE_SNAPSHOT_MS);
    await engine.settled();
    expect(sink.snapshots).toEqual([3, 4]);
  });
});

describe('心跳与停写', () => {
  it('beat 的间隔默认就是 T6 的那一个数：每 LOCK_HEARTBEAT_INTERVAL_MS 一发', async () => {
    const spy = beatSpy(() => 'renewed');
    const { engine, timer } = harness({ beat: spy.beat });
    timer.advance(LOCK_HEARTBEAT_INTERVAL_MS);
    await engine.settled();
    expect(spy.count()).toBe(1);
    timer.advance(LOCK_HEARTBEAT_INTERVAL_MS);
    await engine.settled();
    expect(spy.count()).toBe(2);
    expect(engine.status().phase).toBe('idle');
  });

  it('beat 报 lost ⇒ paused：后续投递不进 sink、队列留着、重试定时器一起撤', async () => {
    let answer: 'renewed' | 'lost' = 'renewed';
    const spy = beatSpy(() => answer);
    const { engine, sink, timer, statuses } = harness({
      beat: spy.beat,
      snapshotEveryRows: 10,
      retryDelayMs: 500,
    });
    sink.failAppends.add(9);
    engine.submit(entry(9));
    await engine.settled(); // 失败 ⇒ 重试定时器已排上
    expect(engine.status().queuedTurns).toBe(1);
    answer = 'lost';
    timer.advance(LOCK_HEARTBEAT_INTERVAL_MS);
    await engine.settled();
    const paused = engine.status();
    expect(paused.phase).toBe('paused');
    expect(paused.pauseReason).toContain('lock');
    expect(statuses.some((s) => s.phase === 'paused')).toBe(true);
    engine.submit(entry(10));
    await engine.settled();
    expect(sink.appended).toEqual([]); // 停手：T6 第 ④ 段那句"拿到 lost 就必须停手"的落地
    timer.advance(5_000);
    await engine.settled();
    expect(sink.appended).toEqual([]); // 重试定时器也必须被撤掉，不许在停写状态下偷偷写
    expect(engine.status().queuedTurns).toBe(2);
    expect(spy.count()).toBe(1); // paused 之后心跳链也停了：停写状态下再问一次锁没有读者
  });

  it('beat 抛错同样按 lost 停写（问不出去 = 不知道锁还在不在，后果不对称 ⇒ 保守）', async () => {
    const spy = beatSpy(() => 'throw');
    const { engine, timer } = harness({ beat: spy.beat });
    timer.advance(LOCK_HEARTBEAT_INTERVAL_MS);
    await engine.settled();
    expect(spy.count()).toBe(1);
    const status = engine.status();
    expect(status.phase).toBe('paused');
    expect(status.lastError).toContain('按丢锁处理');
    expect(status.lastError).toContain('心跳发不出去');
  });

  it('resume 之后把停写期间憋着的那一发补上', async () => {
    let answer: 'renewed' | 'lost' = 'renewed';
    const spy = beatSpy(() => answer);
    const { engine, sink, timer } = harness({ beat: spy.beat, snapshotEveryRows: 10 });
    answer = 'lost';
    timer.advance(LOCK_HEARTBEAT_INTERVAL_MS);
    await engine.settled();
    engine.submit(entry(1));
    engine.submit(entry(2));
    await engine.settled();
    expect(sink.appended).toEqual([]);
    engine.resume();
    await engine.settled();
    expect(sink.appended).toEqual([1, 2]);
    expect(engine.status()).toMatchObject({ phase: 'idle', queuedTurns: 0, pauseReason: null });
  });

  it('stop 拆掉所有定时器、报 stopped，欠款非空时说清还剩几发', async () => {
    const spy = beatSpy(() => 'renewed');
    const { engine, sink, timer } = harness({ beat: spy.beat, retryDelayMs: 1_000 });
    sink.failAppends.add(1);
    engine.submit(entry(1));
    await engine.settled();
    const stopped = engine.stop();
    expect(stopped.phase).toBe('stopped');
    expect(stopped.lastError).toContain('仍有 1 发未落盘');
    const beats = spy.count();
    timer.advance(IDLE_SNAPSHOT_MS * 2);
    await engine.settled();
    expect(spy.count()).toBe(beats); // 定时器没拆干净的话这里会涨
    expect(sink.appended).toEqual([]);
    expect(() => engine.submit(entry(2))).toThrow(/已 stop/);
  });
});
```

Run: `npx vitest run apps/desktop/test/unit/autosave.test.ts > tmp/t7-autosave-red.log 2>&1; echo "exit=$?"`
Expected: `exit=1`，红在**模块解析不到**（`../../src/main/persist/autosave` 与它的 `Autosave` / 三个常量还不存在），不是红在断言。24 格全存在（4 + 4 + 5 + 6 + 5）。

- [ ] **Step 4: 写 `apps/desktop/src/main/persist/describe-error.ts` 与 `apps/desktop/src/main/persist/autosave.ts`（绿）**

`describe-error.ts` 先落盘：`autosave.ts` 是它的第一个读者，Step 5 的 `emergency.ts` 是第二个。为什么单独一个文件而不是留在 `autosave.ts` 里再由 `emergency.ts` import 过去：那会让"落盘的那一个"依赖"排队的那一个"，方向是反的（引擎通过钩子认识 fs 侧，fs 侧不该反过来认识引擎）。为什么这一件要共享而**各条 `>=1` 的尺不共享**：`lastError` 与抢救件的 `error` 两个字符串会被 T9 的诊断并排比对，格式必须逐字节同源；而校验文案每条都带着自己那一格的理由（`turn` 那句说的是幂等键，`keep` 那句说的是关掉抢救），把它们合成一个 `requirePositiveInt(label)` 只会把理由稀释成参数。这个取舍写在下一段的注释里。

```ts
/**
 * 把"外部世界"的抛错压成一行不带换行的文本。驱动的错误在 `err.code` 上
 * （ECONNREFUSED / ER_* / ENOTDIR），那一格丢了就查不到根因，所以它必须出现在文案里。
 * 分型文案（"下一步该做什么"）归 T9 的 `classifyDbError`：这里只保证不丢，不保证好听。
 * 共享的理由见上一段：`SaveStatus.lastError` 与抢救件的 `error` 是同一条口径的两个读者。
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string'
      ? `${err.name}(${code}): ${err.message}`
      : `${err.name}: ${err.message}`;
  }
  return `非 Error 抛出：${String(err)}`;
}
```

`apps/desktop/src/main/persist/autosave.ts`

```ts
import type { Document, EntityId, Patch } from '@dajia/core';
import { LOCK_HEARTBEAT_INTERVAL_MS } from '../db/locks';
import type { JournalEntry, JournalOutcome } from '../db/repository';
import { describeError } from './describe-error';

/** spec §8.2 原话之「每 2000 条命令」。计数器是 `rowsSinceSnapshot`，不是 `seq`（裁决 P-6）。 */
export const SNAPSHOT_EVERY_ROWS = 2000;
/** spec §8.2 原话之「连续 60 秒无编辑」。两者先到即合并出新 snapshot。 */
export const IDLE_SNAPSHOT_MS = 60_000;
/** spec §9 的"持续重试"落成的重试间隔。它是引擎自己的口径，spec 没给数字，改这里要说得出理由。 */
export const RETRY_DELAY_MS = 2_000;

/**
 * 时钟与定时器的唯一注入点（裁决 P-2 的口径：能进 node 测试的东西才有人测）。
 * 把手只许原样交回，不许拆开看 —— 假钟与真钟各自决定内部形状。
 */
export interface TimerHandle {
  readonly cancel: () => void;
}

export interface SaveTimer {
  now(): number;
  schedule(onDue: () => void, ms: number): TimerHandle;
}

export const realTimer: SaveTimer = {
  now: () => Date.now(),
  schedule: (onDue, ms) => {
    const handle = setTimeout(onDue, ms);
    return { cancel: () => clearTimeout(handle) };
  },
};

export interface JournalSink {
  appendJournal(entry: JournalEntry): Promise<JournalOutcome>;
  writeSnapshot(turn: number, doc: Document): Promise<void>;
}

export interface EmergencyPayload {
  readonly projectId: EntityId;
  readonly turn: number;
  readonly error: string;
  readonly doc: Document;
  readonly patch: Patch;
}

export type AutosavePhase = 'idle' | 'saving' | 'failed' | 'paused' | 'stopped';

/**
 * UI 能看见的全部事实（T8 的横幅只读这一个形状）。
 * `lastError` 是**最后一次**失败的原话，成功一发就清空 —— 它同时是红条的显示条件，
 * 所以"红条一直挂着"这种烦人形态由清空这一句负责消。
 */
export interface SaveStatus {
  readonly phase: AutosavePhase;
  readonly queuedTurns: number;
  readonly lastTurn: number | null;
  readonly snapshotTurn: number | null;
  readonly rowsSinceSnapshot: number;
  readonly lastError: string | null;
  readonly pauseReason: string | null;
}

export interface AutosaveOptions {
  readonly sink: JournalSink;
  readonly timer?: SaveTimer;
  readonly snapshotEveryRows?: number;
  readonly idleSnapshotMs?: number;
  readonly retryDelayMs?: number;
  /** 与工程锁对话的那一发（T6 的 `heartbeat(pool, ticket)`）；不给就不起心跳循环。 */
  readonly beat?: () => Promise<'renewed' | 'lost'>;
  readonly onStatus?: (status: SaveStatus) => void;
  /** 落盘出口（T8 把它接到 `emergency.ts`）；引擎自己不许碰 fs（裁决 P-2/P-10）。 */
  readonly onEmergency?: (payload: EmergencyPayload) => void;
  /**
   * 从库里读回来的起点（T8 用 `loadProject` 的读数填）：`lastTurn` = `header.journalTurn`、
   * `snapshotTurn` = `snapshot?.turn ?? null`、`rowsSinceSnapshot` = `journalTurn - (snapshot?.turn ?? 0)`。
   * 不传 = 新工程从零数。不读这一份起点，"每 2000 条"这句话在重启之后就失守了 —— 阈值会从 0 重数。
   */
  readonly fromJournal?: {
    readonly lastTurn: number;
    readonly snapshotTurn: number | null;
    readonly rowsSinceSnapshot: number;
  };
}

function requirePositiveInt(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} 必须是 >=1 的安全整数，收到 ${String(value)}：0 或负数会让判定每发都触发或永不触发`);
  }
  return value;
}

function requireNonNegInt(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} 必须是 >=0 的安全整数，收到 ${String(value)}`);
  }
  return value;
}

/**
 * 保存引擎（electron-free、fs-free）：renderer 每发成功后经 IPC 投过来，这里负责
 * 串行落库、按 spec §8.2 的两条阈值合并快照、失败重试与抢救、以及"锁没了就停手"。
 *
 * 三条不可见的纪律，改代码前先读：
 * 1. **所有异步活都接在同一条 `chain` 上**（含定时器回调）。于是 `settled()` 是唯一的可靠等待点，
 *    而 `flush()` 与 24 格单测都靠它。`chain` 必须永不 reject —— 它没有 catch 支路，
 *    一次漏出的 rejection 就是进程级 unhandled rejection。
 * 2. **队首失败就停**（`drain` 里的 `break`）：turn 有序，后发先至会在账上留洞，
 *    而缺号在 T5 是"拒开"级别的损坏（尾缺/中缺两位证人）。
 * 3. **引擎不猜库里的账**：`rowsSinceSnapshot` 的起点由 `fromJournal` 给，之后只按 sink 的
 *    返回值推进（`already-applied` 不加，T7 ④ 段）。
 */
export class Autosave {
  private readonly sink: JournalSink;
  private readonly timer: SaveTimer;
  private readonly snapshotEveryRows: number;
  private readonly idleSnapshotMs: number;
  private readonly retryDelayMs: number;
  private readonly beat: (() => Promise<'renewed' | 'lost'>) | undefined;
  private readonly onStatus: ((status: SaveStatus) => void) | undefined;
  private readonly onEmergency: ((payload: EmergencyPayload) => void) | undefined;

  /** 待落库的投递，按 turn 递增。队首失败时它不移动（纪律 2）。 */
  private readonly pending: JournalEntry[] = [];
  /** 已经抢救过的 turn（T7 ⑦ 段）：重试不重新写盘。 */
  private readonly rescuedTurns = new Set<number>();
  private chain: Promise<void> = Promise.resolve();
  private pumping = false;
  /** 停写的原因；null = 允许写。T6 的 `'lost'` 与 T8 的人工只读都落在这里。 */
  private paused: string | null = null;
  private stopped = false;
  /** 投递过的最大 turn（不管落没落库）：重复投递的守卫用它，不是 `landedTurn`。 */
  private maxSeenTurn: number;
  /** 已落库的最大 turn。 */
  private landedTurn: number | null;
  /** 最后一发落地后的文档：收尾快照与抢救都用它（T7 ③ 段的成本就在这里）。 */
  private lastDoc: Document | null = null;
  private snapshotTurn: number | null;
  private rowsSinceSnapshot: number;
  private lastError: string | null = null;
  private idleHandle: TimerHandle | null = null;
  private retryHandle: TimerHandle | null = null;
  private beatHandle: TimerHandle | null = null;

  constructor(options: AutosaveOptions) {
    this.sink = options.sink;
    this.timer = options.timer ?? realTimer;
    this.snapshotEveryRows = requirePositiveInt(
      options.snapshotEveryRows ?? SNAPSHOT_EVERY_ROWS,
      'snapshotEveryRows',
    );
    this.idleSnapshotMs = requirePositiveInt(options.idleSnapshotMs ?? IDLE_SNAPSHOT_MS, 'idleSnapshotMs');
    this.retryDelayMs = requirePositiveInt(options.retryDelayMs ?? RETRY_DELAY_MS, 'retryDelayMs');
    this.beat = options.beat;
    this.onStatus = options.onStatus;
    this.onEmergency = options.onEmergency;
    const start = options.fromJournal;
    if (start) {
      this.landedTurn = requirePositiveInt(start.lastTurn, 'fromJournal.lastTurn');
      this.maxSeenTurn = start.lastTurn;
      this.snapshotTurn = start.snapshotTurn;
      this.rowsSinceSnapshot = requireNonNegInt(start.rowsSinceSnapshot, 'fromJournal.rowsSinceSnapshot');
      if (start.snapshotTurn !== null) requirePositiveInt(start.snapshotTurn, 'fromJournal.snapshotTurn');
    } else {
      this.landedTurn = null;
      this.maxSeenTurn = 0;
      this.snapshotTurn = null;
      this.rowsSinceSnapshot = 0;
    }
    if (this.rowsSinceSnapshot > 0 && this.snapshotTurn !== null && this.landedTurn !== null && this.snapshotTurn > this.landedTurn) {
      throw new TypeError(
        `fromJournal 自相矛盾：快照在 turn ${String(this.snapshotTurn)}，却只写到 turn ${String(this.landedTurn)}`,
      );
    }
    if (this.beat) this.scheduleBeat();
  }

  /** 投递一发（IPC handler 里唯一该调的入口）。返回 `ignored-duplicate` 而不是抛：重放不该打死主进程。 */
  submit(entry: JournalEntry): 'queued' | 'ignored-duplicate' {
    if (this.stopped) {
      throw new Error('Autosave 已 stop()：关掉窗口之后不许再排新的一发（这是接线错误，不是库故障）');
    }
    if (!Number.isSafeInteger(entry.turn) || entry.turn < 1) {
      throw new TypeError(
        `turn 必须是 >=1 的安全整数，收到 ${String(entry.turn)}：账目的幂等键没有"第 0 发"，也没有小数发`,
      );
    }
    if (entry.turn <= this.maxSeenTurn) {
      this.lastError = `忽略 turn ${entry.turn}：已经投递到 ${this.maxSeenTurn}，turn 必须严格递增`;
      this.report();
      return 'ignored-duplicate';
    }
    this.maxSeenTurn = entry.turn;
    this.pending.push(entry);
    // 有新活就撤空闲定时器：60 秒的钟是给"没有新编辑"计时的（「空闲计时随新编辑重置」那一格钉的就是它）。
    this.cancelIdle();
    this.kick();
    this.report();
    return 'queued';
  }

  /**
   * 把当前排上的活跑完，再尽力补一份收尾快照。**不等定时器**（T8 自己给它套超时），
   * 也**不保证写完**：库真不可达时它写不完，那就如实报 `failed` + `queuedTurns`（「flush 在库不可达时如实报 failed」那一格）。
   */
  async flush(): Promise<SaveStatus> {
    await this.settled();
    for (;;) {
      if (this.stopped || this.paused !== null) break;
      const turn = this.landedTurn;
      const doc = this.lastDoc;
      if (turn === null || doc === null || !this.needsSnapshot()) break;
      const before = this.snapshotTurn;
      await this.trySnapshot(turn, doc);
      await this.settled();
      // 没写成（失败或被跳过）就停：原地打转会把 flush 变成又一个重试循环。
      if (this.snapshotTurn === before) break;
    }
    return this.status();
  }

  pause(reason: string): void {
    if (this.paused !== null) return;
    this.paused = reason;
    this.cancelIdle();
    this.cancelRetry();
    this.report();
  }

  /** T8 重新拿到锁之后调：把停写期间憋着的队列补上，心跳链也接回来。 */
  resume(): void {
    if (this.paused === null) return;
    this.paused = null;
    this.kick();
    this.scheduleBeat();
    this.armIdle();
    this.report();
  }

  /**
   * 拆掉所有定时器。欠款非空时**不抛**（抛了会把关窗流程打断），只在 `lastError` 里说清还剩几发 ——
   * 那一句是给 T11 的闸门读的：`--persist-shot` 要能看见"关窗前没 flush 干净"这个形状。
   */
  stop(): SaveStatus {
    if (!this.stopped) {
      this.stopped = true;
      this.cancelIdle();
      this.cancelRetry();
      if (this.beatHandle !== null) {
        this.beatHandle.cancel();
        this.beatHandle = null;
      }
      if (this.pending.length > 0) {
        const head = this.pending[0];
        this.lastError = `stop() 时仍有 ${this.pending.length} 发未落盘（队首 turn ${head ? String(head.turn) : '?'}）：关窗前的 flush 没走完`;
      }
      this.report();
    }
    return this.status();
  }

  status(): SaveStatus {
    const phase: AutosavePhase = this.stopped
      ? 'stopped'
      : this.paused !== null
        ? 'paused'
        : this.lastError !== null
          ? 'failed'
          : this.pending.length > 0
            ? 'saving'
            : 'idle';
    return {
      phase,
      queuedTurns: this.pending.length,
      lastTurn: this.landedTurn,
      snapshotTurn: this.snapshotTurn,
      rowsSinceSnapshot: this.rowsSinceSnapshot,
      lastError: this.lastError,
      pauseReason: this.paused,
    };
  }

  /** 等 `chain` 上的活排空：定时器要先把钟拨到点才会接进链，所以它不等"未来"，只不等"已排上的活"。 */
  async settled(): Promise<void> {
    for (;;) {
      const tail = this.chain;
      await tail;
      if (this.chain === tail) return;
    }
  }

  private kick(): void {
    if (this.pumping || this.stopped || this.paused !== null || this.pending.length === 0) return;
    this.pumping = true;
    this.chain = this.chain.then(() => this.drain());
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending.length > 0 && this.paused === null && !this.stopped) {
        const head = this.pending[0];
        if (!head) break;
        try {
          const outcome = await this.sink.appendJournal(head);
          this.pending.shift();
          this.landedTurn = head.turn;
          this.lastDoc = head.doc;
          if (outcome === 'applied') this.rowsSinceSnapshot += 1;
          this.lastError = null;
          this.report();
          if (this.rowsSinceSnapshot >= this.snapshotEveryRows) {
            await this.trySnapshot(head.turn, head.doc);
          }
        } catch (err) {
          this.lastError = describeError(err);
          this.rescue(head);
          this.report();
          this.scheduleRetry();
          break;
        }
      }
    } finally {
      // `report()` 里的回调若抛错也不能把 `pumping` 卡在 true（那会永久停住队列）。
      this.pumping = false;
      if (!this.stopped && this.paused === null) this.armIdle();
      this.report();
    }
  }

  /**
   * 快照那一发。`turn <= snapshotTurn` 是**跳过**，不是失败（T7 ⑤ 段：引擎的记性防自伤，
   * 库的 `UNIQUE` 防"将来有人把记性删了"，两边各管一头）。
   */
  private async trySnapshot(turn: number, doc: Document): Promise<boolean> {
    if (this.snapshotTurn !== null && turn <= this.snapshotTurn) return true;
    try {
      await this.sink.writeSnapshot(turn, doc);
      this.snapshotTurn = turn;
      this.rowsSinceSnapshot = 0;
      this.lastError = null;
      this.report();
      return true;
    } catch (err) {
      this.lastError = `快照 turn ${String(turn)} 失败：${describeError(err)}`;
      this.report();
      return false;
    }
  }

  /** 库里还欠着行数（或上一份快照没写成）才需要排空闲定时器 —— 否则 60 秒就是空转（「没有新行就不许空转」那一格）。 */
  private needsSnapshot(): boolean {
    if (this.lastDoc === null || this.landedTurn === null) return false;
    if (this.rowsSinceSnapshot === 0) return false;
    return this.snapshotTurn === null || this.landedTurn > this.snapshotTurn;
  }

  private armIdle(): void {
    if (this.idleHandle !== null || this.stopped || this.paused !== null) return;
    if (!this.needsSnapshot()) return;
    this.idleHandle = this.timer.schedule(() => {
      this.idleHandle = null;
      this.chain = this.chain.then(() => this.idleFire());
    }, this.idleSnapshotMs);
  }

  private async idleFire(): Promise<void> {
    const turn = this.landedTurn;
    const doc = this.lastDoc;
    if (turn !== null && doc !== null) await this.trySnapshot(turn, doc);
    // 上一发失败留的队列也顺手推一把：60 秒这一发不只是快照的重试点，也是重试的备用触发。
    this.kick();
    // 失败就下个 60 秒再试：spec §9 的"持续重试"落在快照上就是这个形状（「快照失败不吞日志」那一格）。
    this.armIdle();
    this.report();
  }

  private scheduleRetry(): void {
    if (this.retryHandle !== null || this.stopped || this.paused !== null) return;
    this.retryHandle = this.timer.schedule(() => {
      this.retryHandle = null;
      this.kick();
    }, this.retryDelayMs);
  }

  private cancelRetry(): void {
    if (this.retryHandle === null) return;
    this.retryHandle.cancel();
    this.retryHandle = null;
  }

  private cancelIdle(): void {
    if (this.idleHandle === null) return;
    this.idleHandle.cancel();
    this.idleHandle = null;
  }

  /**
   * 一发自续的心跳：跑完一次再排下一次，而不是 `setInterval` —— 停写与停机时"下一次"要能干脆没有。
   * 间隔的数值产地是 T6 那个常量，这里不抄第二份（P-4/P-14 的账）。`persist-boundary.test.ts` 盯着
   * `LOCK_HEARTBEAT_INTERVAL_MS` 这个标识符还在不在：漂成字面量 5000 是本文件唯一没人运行时会红的漂法。
   */
  private scheduleBeat(): void {
    if (!this.beat || this.stopped || this.paused !== null) return;
    this.beatHandle = this.timer.schedule(() => {
      this.beatHandle = null;
      this.chain = this.chain.then(() => this.beatOnce());
    }, LOCK_HEARTBEAT_INTERVAL_MS);
  }

  private async beatOnce(): Promise<void> {
    const beat = this.beat;
    if (!beat || this.stopped || this.paused !== null) return;
    try {
      const answer = await beat();
      if (answer === 'lost') {
        this.lastError = '心跳报 lost：锁已被别人拿走或已过期';
        this.pause('lock-lost');
        return;
      }
    } catch (err) {
      // T7 ⑥ 段：问不出去 = 没有答案。两种可能里有一线是"别人正在写"，后果不对称 ⇒ 保守停写。
      this.lastError = `心跳调用抛错，按丢锁处理：${describeError(err)}`;
      this.pause('lock-lost: 心跳调用抛错');
      return;
    }
    this.scheduleBeat();
  }

  /** 每个 turn 只抢救一次（T7 ⑦ 段）；抢救钩子再炸也不许打断重试循环（spec §9 的同一条）。 */
  private rescue(entry: JournalEntry): void {
    if (this.rescuedTurns.has(entry.turn)) return;
    this.rescuedTurns.add(entry.turn);
    const hook = this.onEmergency;
    if (!hook) return;
    try {
      hook({
        projectId: entry.doc.projectId,
        turn: entry.turn,
        error: this.lastError ?? '未知故障',
        doc: entry.doc,
        patch: entry.patch,
      });
    } catch {
      // 吞掉：这里唯一的正确动作是继续重试，把盘写成功与否由返回值告诉调用方（emergency.ts 就是这么设计的）。
    }
  }

  private report(): void {
    const hook = this.onStatus;
    if (!hook) return;
    try {
      hook(this.status());
    } catch {
      // 上报是单向广播，它抛错不能把保存路径带走。
    }
  }
}
```

Run: `npx vitest run apps/desktop/test/unit/autosave.test.ts > tmp/t7-autosave.log 2>&1; echo "exit=$?"`
Expected: `exit=0`，**24 格**全绿。
Run: `npx tsc --noEmit -p apps/desktop/tsconfig.test.json > tmp/t7-tsc.log 2>&1; echo "exit=$?"`
Expected: `exit=0`。（这一发不是仪式：`harness` 的 `Partial<AutosaveOptions>` 与 `FakeSink implements JournalSink` 两处形状主张只有它能看见。）

若 `队列串行` 那一格红在 `maxInFlight=2`：先确认 `drain` 里那个 `break` 与 `kick` 的 `pumping` 守卫都在，别去改判据 —— 判据要的是"同一时刻库里只有一条在飞"。
**⑨ 为什么 `writeEmergencySnapshot` 返回结果而不抛，且裁剪失败不改写 `ok`**：spec §9 那条"存盘失败绝不清空内存真源"管的不只是 MySQL —— 抢救这条路上任何一次抛错都会把调用方（T8 的 IPC handler、`flush()` 的收尾、甚至 `before-quit`）打断，而打断的后果正是"屏幕上的东西没了"。所以本文件的公开出口只有一个形状：`EmergencyWrite`，成功带 `path`，失败带 `error` 与**尽力算出的** `path`（守卫就失败时它是 `null`）。同理，`pruneEmergency` 在写完之后跑，它炸了（目录被并发删了、某个文件正被占用）**不能**把这一发谎报成"没抢救成功"：文件已经在盘上，谎报会让调用方以为还得再抢救一次，而 ⑦ 段刚说过同一 turn 只留一份现场。于是裁剪那段单独包一层 `try`，吞掉，只在注释里说明。代价登记在下面：**"裁剪失败时目录会一直涨"这一格没有用例**（要造一个"能写不能删"的目录得动 ACL，Windows 上不可靠），归"登记的限度"。

**⑩ 为什么 `pruneEmergency` 按工程分桶，且认形状用的是"文件名 + `isEntityId`"两条**：`emergency/` 目录是全机共用的（`userData` 属于这个应用，不属于某个工程）。若按全局 turn 排序裁剪，一台开了三个工程的机器会因为工程 B 的 turn 大，把工程 A 唯一的抢救件删掉 —— 而那些恰恰是 A 在这一发上**仅存**的证据。分桶的键就是文件名词干里那枚 projectId，而它能不能当键用由 `isEntityId` 判：认不出的名字（`notes.txt`、用户自己扔进去的 `bogus-turn-9999.json`、词干不是 UUIDv7 的任何形状）一个都不许动 —— 不认识形状的文件不是我们的财产。写侧的 `guardName` 与裁剪侧的识别用的是**同一个** `isEntityId`，所以"能写进去的名字"与"能被认出来的名字"是同一集合，不存在"自己写的文件自己认不出"这种漂法。

**⑪ 为什么 `db` 档还要把 `unit` 证过的形状再走一遍**：因为 `unit` 用的是假 sink，而这一档有四条**只有真库能给**的判据：① `already-applied` 由库里的 `journal_turn` 读数判出，不是我们 return 出来的字符串；② 引擎递给 `writeSnapshot` 的那一对 `(turn, doc)` 在真编码-真解码往返之后仍然同源（假 sink 只数调用次数，看不见内容）；③ 连投八发之后 `command_log.turn` 在真自增与真事务下逐发连着 —— 这条是 T5 那一格「中间缺一发日志 ⇒ 拒开并说"缺号"」的正面凭据；④ 注入的连接故障走的是引擎的重试路径，而抢救钩子接的是**真 `fs`**（`onEmergency → writeEmergencySnapshot` 这条线在 unit 档是数组 push）。另外三格（重放还原、pause 不动库、flush 补收尾）断的都是**引擎与真 repository 之间那条接缝**，接缝红了没人能怪到 `autosave.ts` 或 `repository.ts` 单侧头上。**这一档不重复的两件事**：`uk_project_turn` 会炸（T4 `repository.test.ts` 的「同一个 turn 落两份快照 ⇒ 抛」已经实测过，重复一遍只会让两档各自漂）与"没有快照也能从零重放"（T5 `journal.test.ts` 的「没有快照时全靠重放：五发之后 load 得到同一份文档」）。

- [ ] **Step 5: 写 `apps/desktop/src/main/persist/emergency.ts` + `apps/desktop/test/unit/emergency.test.ts`（6 格）+ `apps/desktop/test/unit/persist-boundary.test.ts`（2 格）**

`apps/desktop/test/unit/emergency.test.ts`

```ts
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Document, uuidv7, type EntityId } from '@dajia/core';
import {
  EMERGENCY_DIR_NAME,
  EMERGENCY_KEEP,
  emergencyFileName,
  pruneEmergency,
  writeEmergencySnapshot,
} from '../../src/main/persist/emergency';

const PID_A = uuidv7() as EntityId;
const PID_B = uuidv7() as EntityId;

// 三个 describe 共用两个临时目录（`dir` 反复写、`dirB` 只给覆盖那一格），
// 目录由本文件 mkdtempSync 造 ⇒ afterAll 敢整棵删；绝不用仓库里的路径。
let dir = '';
let dirB = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dajia-emergency-'));
  dirB = mkdtempSync(join(tmpdir(), 'dajia-emergency-b-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

describe('文件名的两条尺', () => {
  it('正形状是 `${projectId}-turn-${turn}.json`；两个守卫各挡一刀', () => {
    expect(emergencyFileName(PID_A, 7)).toBe(`${PID_A}-turn-7.json`);
    // 词干直接进路径：放 `../` 过去等于让调用方指定写到哪一层。
    expect(() => emergencyFileName('../evil' as EntityId, 1)).toThrow(/UUIDv7/);
    expect(() => emergencyFileName(PID_A, 0)).toThrow(/安全整数/);
    expect(() => emergencyFileName(PID_A, 1.5)).toThrow(/安全整数/);
    expect(() => emergencyFileName(PID_A, Number.MAX_SAFE_INTEGER + 1)).toThrow(/安全整数/);
  });
});

describe('写一份抢救件', () => {
  it('ok:true 且 envelope 七个键逐个对得上，canonical 是字符串且与 doc.canonical() 逐字节相同', () => {
    const doc = Document.create(PID_A);
    const write = writeEmergencySnapshot(dir, { projectId: PID_A, turn: 3, error: '连接被掐断', doc });
    expect(write.ok).toBe(true);
    if (!write.ok) throw new TypeError('夹具塌了：上一句已经保证 ok');
    expect(write.path).toBe(join(dir, EMERGENCY_DIR_NAME, `${PID_A}-turn-3.json`));
    const env = JSON.parse(readFileSync(write.path, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(env).sort()).toEqual(
      ['canonical', 'error', 'kind', 'projectId', 'schemaVersion', 'turn', 'writtenAtMs'].sort(),
    );
    expect(env.kind).toBe('dajia.emergency.v1');
    expect(env.projectId).toBe(PID_A);
    expect(env.turn).toBe(3);
    // schemaVersion 的产地是文档本身，不是本文件里的常量：写侧不许自己发明版本号。
    expect(env.schemaVersion).toBe(doc.schemaVersion);
    expect(env.error).toBe('连接被掐断');
    // 存字符串而不是存对象：展开成对象就得在 fs 侧再写一份解码，而 core 已经有一份
    // canonical 规则 —— 一份规则两个读者才是不漂的写法（T3/T5 同一条口径）。
    expect(typeof env.canonical).toBe('string');
    expect(env.canonical).toBe(doc.canonical());
    expect(typeof env.writtenAtMs).toBe('number');
    expect(env.writtenAtMs).toBeGreaterThan(0);
  });

  it('同一 turn 再写一份是覆盖，不是第二份（目录里始终一个文件）', () => {
    const first = writeEmergencySnapshot(dirB, {
      projectId: PID_A,
      turn: 9,
      error: '第一次的错',
      doc: Document.create(PID_A),
    });
    const second = writeEmergencySnapshot(dirB, {
      projectId: PID_A,
      turn: 9,
      error: '第二次的错',
      doc: Document.create(PID_A),
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new TypeError('夹具塌了');
    expect(readdirSync(join(dirB, EMERGENCY_DIR_NAME))).toEqual([`${PID_A}-turn-9.json`]);
    const env = JSON.parse(readFileSync(second.path, 'utf8')) as { error: string };
    expect(env.error).toBe('第二次的错');
  });

  it('文档与工程对不上、id 非法、userDataDir 底下不是目录 ⇒ 一律 ok:false，一个都不抛', () => {
    // ① 文档签在别的工程上
    const mismatch = writeEmergencySnapshot(dir, {
      projectId: PID_A,
      turn: 4,
      error: 'x',
      doc: Document.create(PID_B),
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error).toMatch(/工程/);
    // ② 非法 id：守卫在算路径之前，所以这里连 path 都给不出
    const bad = writeEmergencySnapshot(dir, {
      projectId: '../../etc/passwd' as EntityId,
      turn: 4,
      error: 'x',
      doc: Document.create(PID_A),
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.path).toBeNull();
      expect(bad.error).toMatch(/UUIDv7/);
    }
    // ③ userDataDir 指向一个普通文件 ⇒ 底下建不出目录
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, '我不是目录\n', 'utf8');
    const blocked = writeEmergencySnapshot(blocker, {
      projectId: PID_A,
      turn: 5,
      error: 'x',
      doc: Document.create(PID_A),
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.length).toBeGreaterThan(0);
      // path 已经算出来了（守卫已过、失败在 mkdir），这一格把它留着给 T9 的诊断用。
      expect(blocked.path).toBe(join(blocker, EMERGENCY_DIR_NAME, `${PID_A}-turn-5.json`));
    }
    // 三条落点各不同（RangeError / guardName / mkdirSync），分开写是因为它们红法不同：
    // 前两条红在"抛出了 ok:false 之外的东西"，第三条红在"路径算错了一位"。
  });
  // 实测回填待办：第 ③ 条在本机 `err.code` 的具体值（ENOTDIR / EPERM / EACCES 之一）跑完抄进执行回填。
  // 判据**不加** `/ENOTDIR/` —— 三条或的判据等于没有判据，而这一格盯的是"返回而不抛"。
});

describe('裁剪（按工程分桶，认不出的不动）', () => {
  it('keep=2 时每个工程各留两份最新的，别人的文件一个都不许少', () => {
    const mixed = mkdtempSync(join(tmpdir(), 'dajia-emergency-mixed-'));
    const target = join(mixed, EMERGENCY_DIR_NAME);
    mkdirSync(target, { recursive: true });
    for (const turn of [1, 2, 3, 4, 5]) {
      const w = writeEmergencySnapshot(mixed, {
        projectId: PID_A,
        turn,
        error: `A 的第 ${turn} 发`,
        doc: Document.create(PID_A),
      });
      expect(w.ok).toBe(true);
    }
    for (const turn of [1, 2, 3]) {
      const w = writeEmergencySnapshot(mixed, {
        projectId: PID_B,
        turn,
        error: `B 的第 ${turn} 发`,
        doc: Document.create(PID_B),
      });
      expect(w.ok).toBe(true);
    }
    // 两样野文件：一个连形状都不像，一个像但词干不是 UUIDv7。
    writeFileSync(join(target, 'notes.txt'), '谁扔的\n', 'utf8');
    writeFileSync(join(target, 'bogus-turn-9999.json'), '{}\n', 'utf8');

    const removed = pruneEmergency(mixed, 2);
    expect(removed.sort()).toEqual(
      [
        `${PID_A}-turn-1.json`,
        `${PID_A}-turn-2.json`,
        `${PID_A}-turn-3.json`,
        `${PID_B}-turn-1.json`,
      ].sort(),
    );
    expect(readdirSync(target).sort()).toEqual(
      [
        'notes.txt',
        'bogus-turn-9999.json',
        `${PID_A}-turn-4.json`,
        `${PID_A}-turn-5.json`,
        `${PID_B}-turn-2.json`,
        `${PID_B}-turn-3.json`,
      ].sort(),
    );
    // T7 ⑩ 段的分桶主张：A 有 5 份、B 有 3 份，keep=2 ⇒ B 只少 1 份，
    // 而那一份不是被 A 的大 turn 挤下来的（全局排序会删掉 B 的两份并留下 A 的两份 + B 的一份）。
    rmSync(mixed, { recursive: true, force: true });
  });

  it('keep 必须是 >=1 的安全整数：0 就是关掉抢救，该由调用方不装钩子来表述', () => {
    expect(() => pruneEmergency(dir, 0)).toThrow(/keep/);
    expect(() => pruneEmergency(dir, -1)).toThrow(/keep/);
    expect(() => pruneEmergency(dir, 1.5)).toThrow(/keep/);
    expect(() => pruneEmergency(dir, Number.NaN)).toThrow(/keep/);
    // 默认值本身要过得了这一尺：EMERGENCY_KEEP 写成 0 就是"抢救完再删光"，比不抢救更坏。
    expect(EMERGENCY_KEEP).toBeGreaterThanOrEqual(1);
    expect(Number.isSafeInteger(EMERGENCY_KEEP)).toBe(true);
  });
});
```

Run: `npx vitest run apps/desktop/test/unit/emergency.test.ts > tmp/t7-emergency-red.log 2>&1; echo "exit=$?"`
Expected: `exit=1`，红在**模块解析不到**（`Cannot find module '../../src/main/persist/emergency'`）。**6 格**全在（`文件名的两条尺` 1、`写一份抢救件` 3、`裁剪` 2）。

`describe-error.ts` 不在这里建 —— Step 4 已经落盘它（那时它是 `autosave.ts` 的私有读者），本 Step 只是它的**第二个读者**：抢救件的 `error` 与 `SaveStatus.lastError` 会被 T9 的诊断并排比对，格式必须同源。为什么要共享而**各条 `>=1` 的尺不共享**，Step 4 上一段已经答过，别再"顺手合并"一次。

`apps/desktop/src/main/persist/emergency.ts`

```ts
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isEntityId, type Document, type EntityId } from '@dajia/core';
import { describeError } from './describe-error';

/** 目录名的唯一产地：`userData/emergency`。恢复侧（T8/T9）读同一个名字，不许各拼一份。 */
export const EMERGENCY_DIR_NAME = 'emergency';

/**
 * 每个工程各留这么多份（T7 ⑩ 段）。20 是"一晚上的崩溃不至于把盘写满，而真要查问题时
 * 手里还有二十发现场"这两头的折中；改这个数要说得出理由。
 */
export const EMERGENCY_KEEP = 20;

/** envelope 的格式标记：将来换格式的人得能认出旧件，而不是拿新解析器读旧账。 */
const ENVELOPE_KIND = 'dajia.emergency.v1';

/**
 * 输入故意比 `EmergencyPayload` 少一个 `patch`：抢救件保的是**整份状态**。
 * 补丁是增量，靠它恢复得先有一份可信基线 —— 崩溃现场恰恰不保证有基线。
 * T8 接线时把 payload 整个递过来即可（多余字段不影响结构赋值）。
 */
export interface EmergencyInput {
  readonly projectId: EntityId;
  readonly turn: number;
  readonly error: string;
  readonly doc: Document;
}

/** T7 ⑨ 段：本文件唯一的出口形状。成功带 path，失败带 error 与尽力算出的 path。 */
export type EmergencyWrite =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string; readonly path: string | null };

interface Envelope {
  readonly kind: typeof ENVELOPE_KIND;
  readonly projectId: string;
  readonly turn: number;
  readonly schemaVersion: number;
  readonly writtenAtMs: number;
  readonly error: string;
  /** `doc.canonical()` 原样一份字符串。恢复侧 `JSON.parse` 它，再 `Document.replaceEntities`。 */
  readonly canonical: string;
}

/** 认形状：文件名 + 词干必须是 UUIDv7。写侧守卫与这里用的是同一个 `isEntityId`（T7 ⑩ 段）。 */
const FILE_RE = /^(.+)-turn-(\d+)\.json$/;

/**
 * 两条尺都在**算路径之前**。projectId 要直接进文件名词干，`../` 这种串放过去就是
 * "调用方指定写到哪一层"，而调用方那一侧是 IPC 传来的字符串（T8），不是我们自己人。
 */
function guardName(projectId: unknown, turn: unknown): { projectId: EntityId; turn: number } {
  if (!isEntityId(projectId)) {
    throw new TypeError(
      `projectId 必须是 UUIDv7，收到 ${JSON.stringify(projectId)}：这一串直接进文件名词干，认不出就别拼路径`,
    );
  }
  if (!Number.isSafeInteger(turn) || turn < 1) {
    throw new TypeError(
      `turn 必须是 >=1 的安全整数，收到 ${String(turn)}：它既是文件名也是裁剪的排序键`,
    );
  }
  return { projectId, turn };
}

export function emergencyFileName(projectId: EntityId, turn: number): string {
  const guarded = guardName(projectId, turn);
  return `${guarded.projectId}-turn-${guarded.turn}.json`;
}

function emergencyDir(userDataDir: string): string {
  if (userDataDir === '') {
    throw new TypeError(
      'userDataDir 不能是空串：拼出来是相对路径 "emergency"，会写进进程的当前工作目录，' +
        '打包后的应用里那里可能是安装目录',
    );
  }
  return join(userDataDir, EMERGENCY_DIR_NAME);
}

/**
 * 落一份抢救件。**同步**是故意的：调用它的时机是"刚刚失败"，异步版会把这一发交给
 * 一个可能正在被拆掉的进程（`before-quit` 那一头）。它**不抛**，理由见 T7 ⑨ 段。
 */
export function writeEmergencySnapshot(userDataDir: string, input: EmergencyInput): EmergencyWrite {
  let path: string | null = null;
  try {
    const { projectId, turn } = guardName(input.projectId, input.turn);
    if (input.doc.projectId !== projectId) {
      throw new RangeError(
        `抢救件说这是工程 ${projectId}，文档却签在 ${input.doc.projectId}：` +
          `一份状态不能同时是两个工程的现场`,
      );
    }
    const dir = emergencyDir(userDataDir);
    path = join(dir, emergencyFileName(projectId, turn));
    const envelope: Envelope = {
      kind: ENVELOPE_KIND,
      projectId,
      turn,
      schemaVersion: input.doc.schemaVersion,
      writtenAtMs: Date.now(),
      error: input.error,
      canonical: input.doc.canonical(),
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  } catch (err) {
    return { ok: false, error: describeError(err), path };
  }
  // 裁剪单独包一层：文件已经在盘上了，把裁剪失败谎报成"没抢救成功"是双重错 ——
  // 调用方会再写一份，而 T7 ⑦ 段刚立的规矩是同一 turn 只留一份现场。
  try {
    pruneEmergency(userDataDir, EMERGENCY_KEEP);
  } catch {
    // 忽略：宁可目录临时多几份，也不谎报写入结果。
  }
  return { ok: true, path };
}

/**
 * 按工程分桶裁剪，返回**删掉的文件名**（调用方要在日志里说清删了什么，返回值不是装饰）。
 * 排序键是文件名里的 turn，不是 mtime —— T7 ⑧ 段：同一次会话连发两败可能撞在同一毫秒刻度上。
 */
export function pruneEmergency(userDataDir: string, keep: number): string[] {
  if (!Number.isSafeInteger(keep) || keep < 1) {
    throw new RangeError(
      `keep 必须是 >=1 的安全整数，收到 ${String(keep)}：0 等于一份都不留，` +
        '那是"关掉抢救"，该由调用方不装这个钩子来表述，不该让裁剪悄悄删光',
    );
  }
  const dir = emergencyDir(userDataDir);
  const byProject = new Map<EntityId, { name: string; turn: number }[]>();
  for (const name of readdirSync(dir)) {
    const m = FILE_RE.exec(name);
    const candidateId = m?.[1];
    const rawTurn = m?.[2];
    if (!candidateId || !rawTurn || !isEntityId(candidateId)) continue;
    const turn = Number(rawTurn);
    // 长得像但数值不合法（手搓的 turn-99999999999999999999.json）⇒ 不认识，不动。
    if (!Number.isSafeInteger(turn) || turn < 1) continue;
    const bucket = byProject.get(candidateId) ?? [];
    bucket.push({ name, turn });
    byProject.set(candidateId, bucket);
  }
  const removed: string[] = [];
  for (const bucket of byProject.values()) {
    if (bucket.length <= keep) continue;
    // 新的在前；同 turn 的双份（手搓出来的）按名字定序，保证这一发是确定的。
    bucket.sort((a, b) => b.turn - a.turn || (a.name < b.name ? -1 : 1));
    for (const item of bucket.slice(keep)) {
      // 名字来自 readdirSync，不含分隔符 ⇒ join 之后仍在 dir 里，这一发没有路径拼接风险。
      rmSync(join(dir, item.name), { force: true });
      removed.push(item.name);
    }
  }
  return removed;
}
```

（`import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'` —— 上面代码块用了 `rmSync`，import 行按这四件写，别少抄一件：`noUnusedLocals` 反着也管，多了不用的 import 一样红。）

`apps/desktop/test/unit/persist-boundary.test.ts`

为什么单开一个文件、只有 2 格：这一档盯的不是任何一个函数的行为，而是 **T7 ② 段那条边界本身**（`persist/**` 里谁能认识外部世界）。为什么不靠"import 错了运行时会红"兜：`electron` 在纯 node 下 `require` 出来是一串路径（顶层不炸，只有调 `app.getPath` 才炸，而那一步在 T8 之后），`node:fs` 更是无声通过 —— 于是这条边界若漂开，24 格 unit 会悄悄变成"只有接了 electron 才测得到"的代码，正是 P-2 要避免的形状。`lint:deps` 也管不到它：那个脚本数的是**包与包**之间的边，而 `apps/desktop` 内部谁 import 谁不在它的口径里。同一个理由在 T6 有一个先例（`locks-ticket.test.ts` 里那条「locks.ts 里不许出现客户机时钟」）。**代价照同一标准登记**：扫的是源码文本，注释里出现 `from 'electron'` 会误红 —— 与 T3「不许留第二份重叠规则」那一格同族，评审按同一把尺看。

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 只扫 `from '…'` 的模块说明符，不扫正文：注释里写"落盘 / fs / electron"是本计划注释的正常写法，
 * 不该成为红。三条判据各挡一型漂移，别顺手删成一条。
 */
function srcOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

const AUTOSAVE = '../../src/main/persist/autosave.ts';
const EMERGENCY = '../../src/main/persist/emergency.ts';
const DESCRIBE_ERROR = '../../src/main/persist/describe-error.ts';

describe('persist 档的 import 边界（P-2）', () => {
  it('autosave.ts 既不 import electron 也不 import node:fs：外部世界只从三条注入通道进来', () => {
    const src = srcOf(AUTOSAVE);
    expect(src.includes("from 'electron'")).toBe(false);
    expect(src.includes("from 'node:fs'")).toBe(false);
    // 反向判据：三条通道都在。少了任何一条，"注入"就退化成"连库/连盘才能测"，
    // 而这一格是唯一会注意到那一型退化的地方（退化的文件依然能跑，只是没人测得到）。
    expect(src.includes('JournalSink')).toBe(true);
    expect(src.includes('SaveTimer')).toBe(true);
    expect(src.includes('onEmergency')).toBe(true);
    // 心跳间隔必须是 T6 那个常量的引用，不是本文件里的第二个数（P-4/P-14 的账）：
    // 漂成字面量 `5000` 时值一样、行为一样，只有这一句看得见。
    expect(src.includes('LOCK_HEARTBEAT_INTERVAL_MS')).toBe(true);
  });

  it('emergency.ts 允许碰 fs 但不许认识 electron；describe-error.ts 两样都不许', () => {
    const emergency = srcOf(EMERGENCY);
    // 不对称是有意的：本文件正是 T7 唯一被授权碰盘的那一个（裁决 P-10），
    // 但它同样不许 import electron —— `app.getPath('userData')` 由 T8 当参数递进来。
    expect(emergency.includes("from 'node:fs'")).toBe(true);
    expect(emergency.includes("from 'electron'")).toBe(false);
    const describeError = srcOf(DESCRIBE_ERROR);
    expect(describeError.includes("from 'electron'")).toBe(false);
    expect(describeError.includes("from 'node:fs'")).toBe(false);
    // 文案出口连 core 都不许要：它必须能在任何一侧独立编译（T9 的诊断档也会 import 它）。
    expect(describeError.includes("from '@dajia/core'")).toBe(false);
  });
});
```

Run: `npx vitest run apps/desktop/test/unit/persist-boundary.test.ts > tmp/t7-boundary.log 2>&1; echo "exit=$?"`
Expected: `exit=0`，**2 格**全绿（它没有红-绿两步：Step 4/5 落完盘它就已经成立；先跑它是为了在 `emergency.ts` 还没写时看到 `no such file`，那一步与 `autosave.ts` 一起发生在 Step 4/5 的间隙里，不作为独立步骤要求）。

- [ ] **Step 6: 连库那一档 —— `apps/desktop/test/db/autosave-journal.test.ts`（7 格）**

夹具照 T6 的 `locks.test.ts`：库名由本文件写死、`beforeAll` 自建自清、`beforeEach` 清 `project`（FK 全带 `ON DELETE CASCADE`，级联把四张表一起带走）。与 T6 不同的一层：这一档要的是**真 repository 当 sink**，所以只有一个池 —— 引擎的串行性由引擎保证（unit 档「队列串行」那一格已经证过"同一时刻只有一发在飞"），这里不需要两个池抢同一行。

```ts
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'mysql2/promise';
import {
  Document,
  SCHEMA_VERSION,
  TransactionLog,
  applyPatch,
  storeyCreate,
  wallCreate,
  wallSetLoadBearing,
  type Command,
  type EntityId,
  type Patch,
} from '@dajia/core';
import { createDbPool } from '../../src/main/db/pool';
import { readMysqlEnv } from '../../src/main/db/env';
import { dropTestDatabase, ensureDatabase } from '../../src/main/db/database';
import { migrate } from '../../src/main/db/migrate';
import { decodeDocument } from '../../src/main/db/codec';
import { ProjectRepository, type JournalEntry } from '../../src/main/db/repository';
import { Autosave, type JournalSink } from '../../src/main/persist/autosave';
import { EMERGENCY_DIR_NAME, writeEmergencySnapshot } from '../../src/main/persist/emergency';

const env = readMysqlEnv();
// 红线同前两档：库名由本文件写死，不抄 env（env.database 允许是 dajia）。
const DATABASE = 'dajia_test';
const PROJECT_ID = '0193aa00-0000-7000-8000-00000000000c' as EntityId;

let pool: Pool;
let repo: ProjectRepository;
let emergencyDir = '';

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [res] = await pool.query(sql, params);
  return res as T[];
}

async function count(table: string, where = '', params: unknown[] = []): Promise<number> {
  const [res] = await pool.query(`SELECT COUNT(*) AS n FROM \`${table}\`${where}`, params);
  return Number((res as { n: number | string }[])[0]?.n);
}

async function clearAll(): Promise<void> {
  await pool.query('DELETE FROM `project`');
}

/**
 * 条件轮询而不是固定 sleep：这一档等的是**库里的状态**（日志行数、快照份数），
 * 不是"引擎大概跑完了吧"。真钟 + 真连接下的耗时不可预测（P-4 那一层在测试里的对应物）。
 * 唯一反着来的一格是 pause 那一格：它要证的是"不发生"，那必须给一个观察窗口（见那里的注释）。
 */
async function waitUntil(
  label: string,
  probe: () => Promise<boolean>,
  deadlineMs = 8_000,
): Promise<void> {
  const started = performance.now();
  for (;;) {
    if (await probe()) return;
    if (performance.now() - started > deadlineMs) {
      throw new TypeError(`等 ${deadlineMs}ms 仍不成立：${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function step(doc: Document, cmd: Command): { patch: Patch; doc: Document } {
  const patch = cmd.build(doc);
  return { patch, doc: applyPatch(doc, patch).doc };
}

/** 取补丁里那枚新建实体的 id。写死在这里而不是 `?? 常量`：夹具拿不到实体就是夹具塌了。 */
function firstUpsertId(patch: Patch, kind: string): EntityId {
  const entity = patch.upsert.find((e) => e.kind === kind);
  if (!entity) throw new TypeError(`补丁里没有 ${kind}，夹具塌了：${JSON.stringify(patch.upsert.map((e) => e.kind))}`);
  return entity.id;
}

/**
 * 八发连着写的账：一层、四片墙封一个口、改一发承重、二层、二层一片墙。
 * 为什么手搓而不是随机：这一档的判据是"快照落在 3 与 6"，它要求 turn 序列与补丁序列都确定；
 * 随机产量归 core 的属性测试。厚度四片一律 200 —— 同端点异厚度会撞进计划 3 尾判那条 tie-break 限度。
 */
function buildEntries(): JournalEntry[] {
  const base = Document.create(PROJECT_ID);
  const t1 = step(base, storeyCreate({ projectId: PROJECT_ID, index: 0, elevationMm: 0, heightMm: 3000 }));
  const lower = firstUpsertId(t1.patch, 'storey');
  const t2 = step(
    t1.doc,
    wallCreate({ storeyId: lower, start: { x: 0, y: 0 }, end: { x: 4000, y: 0 }, thicknessMm: 200, heightMm: 2800 }),
  );
  const wallA = firstUpsertId(t2.patch, 'wall');
  const t3 = step(
    t2.doc,
    wallCreate({ storeyId: lower, start: { x: 4000, y: 0 }, end: { x: 4000, y: 3000 }, thicknessMm: 200, heightMm: 2800 }),
  );
  const t4 = step(
    t3.doc,
    wallCreate({ storeyId: lower, start: { x: 4000, y: 3000 }, end: { x: 0, y: 3000 }, thicknessMm: 200, heightMm: 2800 }),
  );
  const t5 = step(
    t4.doc,
    wallCreate({ storeyId: lower, start: { x: 0, y: 3000 }, end: { x: 0, y: 0 }, thicknessMm: 200, heightMm: 2800 }),
  );
  const t6 = step(t5.doc, wallSetLoadBearing({ wallId: wallA, loadBearing: false }));
  const t7 = step(t6.doc, storeyCreate({ projectId: PROJECT_ID, index: 1, elevationMm: 3000, heightMm: 3000 }));
  const upper = firstUpsertId(t7.patch, 'storey');
  const t8 = step(
    t7.doc,
    wallCreate({ storeyId: upper, start: { x: 0, y: 0 }, end: { x: 5000, y: 0 }, thicknessMm: 200, heightMm: 2800 }),
  );
  return [t1, t2, t3, t4, t5, t6, t7, t8].map((s, i) => ({ turn: i + 1, patch: s.patch, doc: s.doc }));
}

/** 取夹具里的第 turn 发。不用 `as`：拿不到那一发就是夹具塌了，抛出来比静默 undefined 好查。 */
function atTurn(entries: JournalEntry[], turn: number): JournalEntry {
  const found = entries[turn - 1];
  if (!found) throw new TypeError(`夹具没有第 ${turn} 发`);
  return found;
}

function mkEntries(): JournalEntry[] {
  const entries = buildEntries();
  const first = atTurn(entries, 1);
  const last = atTurn(entries, 8);
  // 每一发的 doc 必须是**累积到那一发**的状态：appendJournal 拿它核对归属，
  // writeSnapshot 把它整个编码落盘。写成"八发共用最后一份文档"是最容易被误改的一处。
  if (last.doc.entities.size <= first.doc.entities.size) {
    throw new TypeError('夹具塌了：每一发的 doc 应当逐发累积，不是八发共用同一份');
  }
  return entries;
}

/** 只让第 failTurn 发失败 failTimes 次，其余原样交给真 repository。 */
class FlakySink implements JournalSink {
  private failed = 0;

  constructor(
    private readonly inner: JournalSink,
    private readonly failTurn: number,
    private readonly failTimes: number,
  ) {}

  async appendJournal(entry: JournalEntry) {
    if (entry.turn === this.failTurn && this.failed < this.failTimes) {
      this.failed += 1;
      throw Object.assign(new Error('注入的库故障：连接被掐断'), { code: 'ECONNREFUSED' });
    }
    return this.inner.appendJournal(entry);
  }

  writeSnapshot(turn: number, doc: Document): Promise<void> {
    return this.inner.writeSnapshot(turn, doc);
  }
}

beforeAll(async () => {
  await dropTestDatabase(env, DATABASE);
  await ensureDatabase(env, DATABASE);
  pool = createDbPool({ ...env, database: DATABASE });
  await migrate(pool, DATABASE);
  repo = new ProjectRepository(pool, PROJECT_ID, 'autosave-db');
  emergencyDir = mkdtempSync(join(tmpdir(), 'dajia-emergency-db-'));
});

afterAll(async () => {
  rmSync(emergencyDir, { recursive: true, force: true });
  await pool.end();
  await dropTestDatabase(env, DATABASE);
});

beforeEach(async () => {
  await clearAll();
  await repo.createProject({ name: '保存引擎样例工程', schemaVersion: SCHEMA_VERSION });
});

// 每一格末尾都有 `engine.stop()`：不拆定时器的引擎会把下一格的 `waitUntil`
// 推着走（这类"过不了的绿"比红更难查）。没有 try/finally 是故意的 —— 格子里断言失败
// 时 vitest 本来就报红，而停不掉的定时器会在**下一格**报出更难归因的红。

async function snapshotTurns(): Promise<number[]> {
  const rs = await rows<{ journal_turn: number | string }>(
    'SELECT `journal_turn` FROM `snapshot` ORDER BY `journal_turn` ASC',
  );
  return rs.map((r) => Number(r.journal_turn));
}

async function logTurns(): Promise<number[]> {
  const rs = await rows<{ turn: number | string }>('SELECT `turn` FROM `command_log` ORDER BY `turn` ASC');
  return rs.map((r) => Number(r.turn));
}

async function projectTurn(): Promise<number> {
  const rs = await rows<{ t: number | string }>('SELECT `journal_turn` AS t FROM `project` WHERE `id` = ?', [
    PROJECT_ID,
  ]);
  return Number(rs[0]?.t ?? -1);
}

describe('引擎接真 repository', () => {
  it('八发连着落：日志 1..8、阈值快照在 3 与 6、空闲那一份补在 8，loadProject 还原成同一份文档', async () => {
    const entries = mkEntries();
    const engine = new Autosave({ sink: repo, snapshotEveryRows: 3, idleSnapshotMs: 40 });
    for (const entry of entries) engine.submit(entry);
    await engine.settled();
    await waitUntil('command_log 八行', async () => (await count('command_log')) === 8);
    expect(await logTurns()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // 不在这里断 `[3, 6]`：40ms 的窗口里空闲那一份可能已经落了，那是一条会自己漂的判据。
    await waitUntil('空闲补的那一份', async () => (await snapshotTurns()).includes(8));
    expect(await snapshotTurns()).toEqual([3, 6, 8]);
    expect(await projectTurn()).toBe(8);

    const loaded = await repo.loadProject('read');
    expect(loaded.header.journalTurn).toBe(8);
    expect(loaded.snapshot?.turn).toBe(8);
    expect(loaded.replayed.rows).toBe(0);
    expect(loaded.doc.canonical()).toBe(atTurn(entries, 8).doc.canonical());
    engine.stop();
  });

  it('undo 与 redo 各产出一发新账（P-5 在真库上的形状），重放仍然停在做过的最后一发', async () => {
    const entries = mkEntries();
    const engine = new Autosave({ sink: repo, snapshotEveryRows: 3, idleSnapshotMs: 60_000 });
    for (const entry of entries.slice(0, 6)) engine.submit(entry);
    await engine.settled();
    await waitUntil('前六发', async () => (await count('command_log')) === 6);

    // 事务日志接手：一发新命令、撤销、重做 —— 三发都要成为**新的账**。
    const wall = atTurn(entries, 2).doc.byKind('wall')[0];
    if (!wall) throw new TypeError('夹具里没有墙');
    const log = new TransactionLog(atTurn(entries, 6).doc);
    log.dispatch(wallSetLoadBearing({ wallId: wall.id, loadBearing: true }));
    const patchAfter = (turn: number): JournalEntry => {
      const patch = log.lastPatch;
      if (!patch) throw new TypeError(`turn ${turn} 拿不到 lastPatch：T7 Step 2 那三处赋值漏了一处`);
      return { turn, patch, doc: log.document };
    };
    engine.submit(patchAfter(7));
    expect(log.undo()).toBe(true);
    engine.submit(patchAfter(8));
    expect(log.redo()).toBe(true);
    engine.submit(patchAfter(9));
    await engine.settled();
    await waitUntil('九发齐', async () => (await count('command_log')) === 9);

    expect(await logTurns()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const loaded = await repo.loadProject('read');
    // 撤销那一发的**逆补丁**也在账上，重放完仍然停在做过的最后一发 —— 这才是"撤销也是一发新记录"。
    expect(loaded.doc.canonical()).toBe(log.document.canonical());
    engine.stop();
  });

  it('引擎递给 writeSnapshot 的那一对 (turn, doc) 同源：turn 2 的行里编码的就是第 2 发之后的文档', async () => {
    const entries = mkEntries();
    const engine = new Autosave({ sink: repo, snapshotEveryRows: 2, idleSnapshotMs: 60_000 });
    for (const entry of entries.slice(0, 4)) engine.submit(entry);
    await engine.settled();
    await waitUntil('两份阈值快照', async () => (await count('snapshot')) === 2);
    expect(await snapshotTurns()).toEqual([2, 4]);

    const rs = await rows<{ seq: number | string; journal_turn: number | string; payload: unknown }>(
      'SELECT `seq`, `journal_turn`, `payload` FROM `snapshot` ORDER BY `journal_turn` ASC',
    );
    for (const r of rs) {
      const turn = Number(r.journal_turn);
      const decoded = decodeDocument({ table: 'snapshot', id: String(Number(r.seq)) }, r.payload);
      const expected = entries[turn - 1];
      if (!expected) throw new TypeError(`快照行指认 turn ${turn}，夹具没有那一发`);
      // 这一句盯的是 `trySnapshot(head.turn, head.doc)` 那一对实参。假 sink 只数调用次数，
      // 看不见内容 —— (turn, doc) 错配（差一发型）只有在这里才红。
      expect(decoded.canonical()).toBe(expected.doc.canonical());
      expect(decoded.schemaVersion).toBe(SCHEMA_VERSION);
    }
    engine.stop();
  });

  it('already-applied 由真库的 journal_turn 判出 ⇒ 行数计数器不推进（P-6 那把尺的真库凭据）', async () => {
    const entries = mkEntries();
    const engine = new Autosave({ sink: repo, snapshotEveryRows: 2, idleSnapshotMs: 60_000 });
    engine.submit(atTurn(entries, 1));
    await engine.settled();
    await waitUntil('第一发落地', async () => (await count('command_log')) === 1);

    // 另一条路径先把第 2 发写进库（T5 的「重发旧 turn」在写侧的对应物：这里模拟"引擎之外有人补了账"）。
    const second = atTurn(entries, 2);
    expect(await repo.appendJournal(second)).toBe('applied');
    // 引擎随后自己投同一发：库给的是 already-applied，不是新增行。
    engine.submit(second);
    await engine.settled();
    await waitUntil('两行都在库里', async () => (await count('command_log')) === 2);

    const status = engine.status();
    expect(status.lastTurn).toBe(2);
    // 关键判据：库里两行，但**新增**只有一行 ⇒ 计数器是 1，不是 2 ⇒ 阈值（2）还没到 ⇒ 不许有快照。
    expect(status.rowsSinceSnapshot).toBe(1);
    expect(status.lastError).toBeNull();
    expect(await count('snapshot')).toBe(0);

    engine.submit(atTurn(entries, 3));
    await engine.settled();
    await waitUntil('第三发之后到阈值', async () => (await count('snapshot')) === 1);
    expect(await snapshotTurns()).toEqual([3]);
    expect(await logTurns()).toEqual([1, 2, 3]);
    engine.stop();
  });

  it('真故障重试：turn 序列仍然连着，且一个 turn 只落一份抢救件（onEmergency 接的是真 fs）', async () => {
    const entries = mkEntries();
    const sink = new FlakySink(repo, 4, 2);
    const rescued: string[] = [];
    const engine = new Autosave({
      sink,
      snapshotEveryRows: 3,
      idleSnapshotMs: 60_000,
      retryDelayMs: 25,
      onEmergency: (payload) => {
        const w = writeEmergencySnapshot(emergencyDir, {
          projectId: payload.projectId,
          turn: payload.turn,
          error: payload.error,
          doc: payload.doc,
        });
        // 只记路径：ok:false 时上一格那种"逐个断言"会红在 undefined，而这一格盯的是份数与内容。
        rescued.push(w.ok ? w.path : `FAILED:${w.error}`);
      },
    });
    for (const entry of entries) engine.submit(entry);
    await waitUntil('注入两次失败之后第八发落地', async () => (await count('command_log')) === 8, 15_000);
    await engine.settled();

    // 连续、无洞、无重复 —— 这一条是 T5「中间缺一发日志 ⇒ 拒开并说"缺号"」那一格的正面凭据。
    expect(await logTurns()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rescued).toEqual([join(emergencyDir, EMERGENCY_DIR_NAME, `${PROJECT_ID}-turn-4.json`)]);
    const files = readdirSync(join(emergencyDir, EMERGENCY_DIR_NAME));
    expect(files).toEqual([`${PROJECT_ID}-turn-4.json`]);
    const only = files[0];
    if (!only) throw new TypeError('抢救件不在目录里');
    const envelope = JSON.parse(readFileSync(join(emergencyDir, EMERGENCY_DIR_NAME, only), 'utf8')) as {
      error: string;
      canonical: string;
      turn: number;
    };
    expect(envelope.turn).toBe(4);
    // 驱动那一格的 code 必须在文案里（`describeError` 存在的全部理由）。
    expect(envelope.error).toContain('ECONNREFUSED');
    // 抢救件保的那份状态，就是库里第 4 发之后应有的那份状态。
    expect(envelope.canonical).toBe(atTurn(entries, 4).doc.canonical());
    expect(engine.status().lastError).toBeNull();
    engine.stop();
  });

  it('pause 期间库里一行都不许多，resume 之后把憋着的补上且 turn 仍然连着', async () => {
    const entries = mkEntries();
    const engine = new Autosave({ sink: repo, snapshotEveryRows: 3, idleSnapshotMs: 60_000 });
    engine.submit(atTurn(entries, 1));
    await engine.settled();
    await waitUntil('第一发落地', async () => (await count('command_log')) === 1);
    const before = await count('command_log');
    const beforeTurn = await projectTurn();

    engine.pause('lock-lost：T6 说这把锁没余额了');
    for (const entry of entries.slice(1, 4)) engine.submit(entry);
    await engine.settled();
    // 证"不发生"必须给一个观察窗口 —— waitUntil 在这里不适用（要等的状态永不出现）。
    // 120ms 是宽裕上界：pause 已经撤掉重试与空闲两个定时器（`cancelIdle`/`cancelRetry`），
    // 没有任何东西会在窗口里敲第二下。
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await count('command_log')).toBe(before);
    expect(await projectTurn()).toBe(beforeTurn);
    expect(await count('snapshot')).toBe(0);
    const paused = engine.status();
    expect(paused.phase).toBe('paused');
    expect(paused.queuedTurns).toBe(3);
    expect(paused.pauseReason).toBe('lock-lost：T6 说这把锁没余额了');

    engine.resume();
    await waitUntil('补写到第四发', async () => (await count('command_log')) === 4);
    await engine.settled();
    // 补写不是重写：turn 仍然逐发连着，pause 期间那一发都没进过库。
    expect(await logTurns()).toEqual([1, 2, 3, 4]);
    expect(await projectTurn()).toBe(4);
    engine.stop();
  });

  it('flush 把收尾快照补上、报零欠款；stop 之后 phase 是 stopped（T8 的关窗路径）', async () => {
    const entries = mkEntries();
    const engine = new Autosave({ sink: repo, snapshotEveryRows: 3, idleSnapshotMs: 60_000 });
    for (const entry of entries.slice(0, 5)) engine.submit(entry);
    await engine.settled();
    await waitUntil('阈值那一份', async () => (await count('snapshot')) === 1);
    expect(engine.status().rowsSinceSnapshot).toBe(2);
    expect(await snapshotTurns()).toEqual([3]);

    const flushed = await engine.flush();
    expect(flushed.queuedTurns).toBe(0);
    expect(flushed.snapshotTurn).toBe(5);
    expect(flushed.rowsSinceSnapshot).toBe(0);
    expect(flushed.lastError).toBeNull();
    expect(await snapshotTurns()).toEqual([3, 5]);
    // 60ms 的观察窗口：`idleSnapshotMs` 是 60 秒，这里等的是"没有第三个定时器来敲"这一件事
    // —— flush 补完那一份之后 `needsSnapshot()` 已经为假（T7 ⑤ 段那条记性）。
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await count('snapshot')).toBe(2);

    const stopped = engine.stop();
    expect(stopped.phase).toBe('stopped');
    expect(stopped.lastError).toBeNull();
    const loaded = await repo.loadProject('read');
    expect(loaded.replayed.rows).toBe(0);
    expect(loaded.doc.canonical()).toBe(atTurn(entries, 5).doc.canonical());
  });
});
```

Run: `npx vitest run --config vitest.db.config.ts apps/desktop/test/db/autosave-journal.test.ts > tmp/t7-db.log 2>&1; echo "exit=$?"`
Expected: 先红在 `Cannot find module '../../src/main/persist/autosave'`（Step 4 没落盘时）；Step 4/5 都写完 ⇒ `exit=0`，**7 格**全绿。

三条"红了先查夹具再查判据"的提示，写给下一个动这一档的人：

- 「八发连着落：日志 1..8…」那一格若最终只有 `[3, 6]` 而 `waitUntil` 超时：先确认 `needsSnapshot()` 在第八发之后仍成立 —— 6 那一发把 `rowsSinceSnapshot` 清零，7、8 两发加回 2，成立。若不成立，红的是计数器而不是定时器。
- 「undo 与 redo 各产出一发新账…」那一格若 `loaded.doc.canonical()` 不等：按 `logTurns` 的读数分家。九发齐而文档不等 ⇒ 逆补丁的形状问题（`TransactionLog.lastPatch` 在本任务 Step 1 的「lastPatch：undo 记的是**逆补丁**…」那一格钉过，回来查 `undo` 的赋值）；九发不齐 ⇒ 去 `tmp/t7-db.log` 里找那句 `journal turn 跳号：盘上记到 X，这发要写 Y`（T4 `repository.ts` 抛的原文）。
- 「真故障重试：turn 序列仍然连着…」那一格若 `rescued` 长度是 2：`FlakySink` 的 `failed` 计数被写成"按 turn 失败"而不是"按次数失败"了。它要的是第 4 发失败两次、第三次放行。若 `files` 是两份而 `rescued` 一份，那是 `pruneEmergency` 之外的另一条路（同一 turn 覆盖写）被改成了带时间戳的文件名 —— 别那么改，T7 ⑦ 段的份数主张就靠覆盖写成立。

Run: `pnpm test:db > tmp/t7-db-all.log 2>&1; echo "exit=$?"`
Expected: `exit=0`。这一发是**全套连库档一起跑**（`env` 3 + `migrate` + `database` + `repository` 20 + `journal` + `locks` 27 + `autosave-journal` 7），它盯的是"新加的这一档没把别人的夹具带脏" —— 各档共用同一个 `dajia_test`，且各自 `beforeAll` 建 / `afterAll` 删，两个 `dropTestDatabase` 并发会互相踩。T2 建 `vitest.db.config.ts` 时钉的 `fileParallelism: false` 是这一格能成立的前提，本档是它的第二个证人。

- [ ] **Step 7: 全量复跑与计数**

```bash
pnpm verify > tmp/t7-verify.log 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' tmp/t7-verify.log | grep -E "^ *(Test Files|Tests) "
pnpm test:db > tmp/t7-db.log 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' tmp/t7-db.log | grep -E "^ *(Test Files|Tests) |FAIL"
npx tsc --noEmit -p apps/desktop/tsconfig.test.json > tmp/t7-tsc.log 2>&1; echo "exit=$?"
git status --porcelain
```

Expected：

1. `pnpm verify` `exit=0`。`Test Files` 比 T6 的回填值 **+3**（`autosave.test.ts`、`emergency.test.ts`、`persist-boundary.test.ts`；`packages/core/test/transaction.test.ts` 是改不是增），`Tests` **+39** —— 拆开是 core `lastPatch` 7 + autosave 24 + emergency 6 + 边界 2。**若只涨 37**：多半是 `persist-boundary.test.ts` 没被 include 收进来（它落在 `apps/desktop/test/unit/`，T1 改的那条 include 覆盖它）；**若涨 39 而 `Test Files` 只 +2**：说明边界那两格被并进了 `emergency.test.ts`，不要那样留 —— 它盯的是三个文件而不是一个模块的行为。
2. `pnpm test:db` `exit=0`，`Test Files` **+1**、`Tests` **+7**（T6 的回填值是 `locks` 27 那一档）。这一发必须**全套连库档一起跑**：`autosave-journal.test.ts` 与 `repository/journal/locks` 四档共用同一个 `dajia_test`，各自 `beforeAll` 建 / `afterAll` 删。`vitest.db.config.ts` 里 T1 钉的 `fileParallelism: false` 是这一发能成立的前提（本档是它的第二个证人：第一个证人是 `locks.test.ts`，那时只有一档碰库）。
3. `npx tsc --noEmit -p apps/desktop/tsconfig.test.json` `exit=0`。这一发不是仪式：`harness` 的 `Partial<AutosaveOptions>`、`FakeSink implements JournalSink`、db 档 `FlakySink implements JournalSink` 三处形状主张只有它能看见 —— **`FlakySink` 少实现 `writeSnapshot` 时只有这里是红的**，vitest 会把它当"少一个方法也没关系"的鸭子类型跑绿。
4. `lint:deps` 照旧静默，且**它本来也看不见本任务的边界**：那个脚本数的是包与包之间的边，而 `apps/desktop` 内部 `persist/**` 谁 import 谁不在它的口径里。于是 P-2 有两条互补的防线：包外的（`persist` 不许 import `@dajia/scene-2d` 之类）归 `lint:deps`，包内的（不许 import `electron` / `node:fs`）归 `persist-boundary.test.ts`。
5. `git status --porcelain` 里**不许出现** `emergency/` 目录或任何 `*-turn-<n>.json`：Step 5 的抢救件全写在 `os.tmpdir()` 下并由 `afterAll` 整棵删掉。真出现了就是 `userDataDir` 被写成了仓库路径 —— 那是测试自己的缺陷，先修测试再谈落盘。
6. 跑完确认库清干净（命令同 T6 Step 5 那一发，**从 `apps/desktop` 目录跑**，`node -e` 按 cwd 解析裸说明符）。Expected：输出里既没有 `dajia_test` 也没有 `dajia`。

---

- [ ] **Step 8: 提交（代码棒只提交 src 与 test，`docs/` 归控制位）**

```bash
git status --porcelain
git diff
git add packages/core/src/model/transaction.ts packages/core/test/transaction.test.ts \
  apps/desktop/src/main/persist/autosave.ts apps/desktop/src/main/persist/describe-error.ts \
  apps/desktop/src/main/persist/emergency.ts \
  apps/desktop/test/unit/autosave.test.ts apps/desktop/test/unit/emergency.test.ts \
  apps/desktop/test/unit/persist-boundary.test.ts \
  apps/desktop/test/db/autosave-journal.test.ts
git commit -m "$(cat <<'EOF'
feat(persist): 保存引擎 —— 两条阈值、同 turn 一次抢救、锁没了就停手

autosave.ts：electron-free、fs-free（P-2）。队列串行由 pumping + drain 的 break 保证；
rowsSinceSnapshot 只数 applied 那一型（P-6），already-applied 不推进它；同一 turn 的快照
由引擎记 snapshotTurn 跳过（P-16 裸 INSERT，重复落盘会撞 uk_project_turn 自伤）。
60 秒与 2000 行都是同进程两 now() 之差，假钟可注入；心跳间隔只引用 T6 的常量。

emergency.ts：唯一碰 node:fs 的持久化文件，接参数不接 app（P-10）；唯一出口是
EmergencyWrite，任何一型失败都不抛 —— 抢救这条路上抛错的后果正是 spec §9 禁止的那一件。
裁剪按工程分桶、按文件名里的 turn 排序、只认 isEntityId 认得出的词干。

core：TransactionLog.lastPatch 让 undo/redo 那一发在持久化侧可见（P-5）；
persist-boundary.test.ts 是 P-2 与"数值唯一产地"两条主张的常驻证人。
EOF
)"
```

---

**Task 7 的改坏验证**（变异棒，`cp` 备份 + md5 还原；**座位不许 `git checkout`/`restore`/`stash`/`reset`/`clean`**）：

用例引用一律用 `it` 的名字，不用"第 N 格"。跑法同前：改坏一处 → 只跑受影响的档（unit 档 `npx vitest run apps/desktop/test/unit/autosave.test.ts`，db 档加 `--config vitest.db.config.ts`）→ `cp` 还原 → 同码复跑一次确认回到绿。

| # | 改坏哪里 | 哪一格红、为什么 |
|---|---|---|
| T7-M1 | `drain` 里 `if (outcome === 'applied') this.rowsSinceSnapshot += 1` 去掉条件（每次投递都算一行） | 「already-applied 不推进 rowsSinceSnapshot（P-6 那把尺的定义在这里）」红（第 2 发就触发快照）；db 档「already-applied 由真库的 journal_turn 判出 ⇒ 行数计数器不推进」同型红。**两档各一个证人是有意的**：unit 证语义，db 证那个读数真的来自库 |
| T7-M2 | `trySnapshot` 成功分支里 `this.rowsSinceSnapshot = 0` 删掉（写完不清账） | 「阈值触发：第 N 发落地即快照，计数归零」红（下一发立刻又落一份）；「没有新行就不许空转：拨满三次 60 秒…」同型红 —— 计数器不归零就永远"还欠着" |
| T7-M3 | `trySnapshot` 开头 `turn <= this.snapshotTurn` 那一句去掉（"让库的 UNIQUE 兜"） | 「同一 turn 只落一份：阈值路径与空闲路径盯上同一发时，后到的那个跳过」红（假 sink 数到两次 `writeSnapshot`）。**db 档不红**：`uk_project_turn` 会炸那一型 T4 已实测过，这一发改的是引擎的记性而不是库的牙 —— 正是 T7 ⑤ 段那对分工 |
| T7-M4 | `rescue` 里 `if (this.rescuedTurns.has(entry.turn)) return;` 删掉 | 「队首一直失败：抢救一次都不许多，队列一条都不许丢」红（连投 3 发全失败 ⇒ 抢救序列变 `[1,1,1]`）；db 档「真故障重试…」的 `rescued` 从 1 份变 2 份 |
| T7-M5 | `drain` 的 catch 里那个 `break` 删掉（失败后继续跑下一发） | 「append 抛 ⇒ failed、欠款留在队首、每 turn 抢救一次、文案带驱动 code」红 —— 第 2 发越过没落的第 1 发进了库，真库里是 `appendJournal` 抛「journal turn 跳号」。这一发是"队首不移动"那条纪律唯一的牙 |
| T7-M6 | `kick` 的 `pumping` 守卫去掉（同一时刻允许两条链在飞） | 「队列串行：第一发挂在库里时，第二发不许挤进去」红（`maxInFlight` 变 2）。**db 档不红** —— 登记在下面 |
| T7-M7 | `submit` 里 `entry.turn <= this.maxSeenTurn` 的守卫去掉 | 「重复或回退的 turn ⇒ ignored-duplicate，sink 一次都不许多调」红（同一发进队两次，`queuedTurns` 变 2）；「fromJournal 起点按库里的账算…」同型红（起点之后的重投进了队） |
| T7-M8 | 空闲那一发（`idleFire`）不看 `needsSnapshot()` 直接 `trySnapshot` | 「没有新行就不许空转：拨满三次 60 秒，writeSnapshot 调用次数仍是 0，定时器也不留着」红 —— 这一格就是为这一发留的 |
| T7-M9 | `submit` 里那句 `this.cancelIdle()` 删掉（新编辑不重置空闲钟） | 「空闲计时随新编辑重置：60 秒是给"没有新动作"计的，不是给第一发计的」红（最后一发之后 60 秒不落，而是第一发之后就落）|
| T7-M10 | `pause` 只置 `paused`，不撤重试/空闲/心跳三个定时器 | 「beat 报 lost ⇒ paused：后续投递不进 sink、队列留着、重试定时器一起撤」红（`spy.count()` 继续涨）；db 档「pause 期间库里一行都不许多…」那 120ms 观察窗口同型红 |
| T7-M11 | `beatOnce` 的 catch 从"按 lost 停写"改成"记一条 `lastError` 然后继续 `scheduleBeat()`" | 「beat 抛错同样按 lost 停写（问不出去 = 不知道锁还在不在，后果不对称 ⇒ 保守）」红（下一发照样进 sink）—— T7 ⑥ 段那条不对称判断只有这一格守着 |
| T7-M12 | `flush` 只排干队列就返回，不补收尾快照 | 「flush 把欠的收尾快照补上，之后的空闲定时器再敲也不重复落」红；db 档「flush 把收尾快照补上、报零欠款…」的 `snapshotTurns()` 停在 `[3]` |
| T7-M13 | `stop()` 只置 `stopped`，不撤心跳定时器 | 「stop 拆掉所有定时器、报 stopped，欠款非空时说清还剩几发」红（`timer.advance(IDLE_SNAPSHOT_MS * 2)` 之后 `spy.count()` 仍涨）|
| T7-M14 | `describeError` 丢掉 `err.code`（只回 `${err.name}: ${err.message}`） | 「append 抛 ⇒ failed、…、文案带驱动 code」红；db 档「真故障重试…」的 `envelope.error` 不再含 `ECONNREFUSED` —— **两档同时红正是它共享的理由**（T9 的诊断要把这两个字符串并排比） |
| T7-M15 | `writeEmergencySnapshot` 改成失败即抛（去掉 `EmergencyWrite` 那层包装） | 「文档与工程对不上、id 非法、userDataDir 底下不是目录 ⇒ 一律 ok:false，一个都不抛」红；db 档「真故障重试…」也红，但红在别处：`onEmergency` 里那一抛被引擎吞掉 ⇒ 抢救件**消失**而不是变多 |
| T7-M16 | `pruneEmergency` 改成全局按 turn 排序（不分工程桶） | 「keep=2 时每个工程各留两份最新的，别人的文件一个都不许少」红（B 少两份）—— T7 ⑩ 段那条分桶主张唯一的证人 |
| T7-M17 | 裁剪侧认形状从「`FILE_RE` + `isEntityId`」放宽成只看 `FILE_RE` | 「keep=2 时…」红（`bogus-turn-9999.json` 被删）；「正形状是 `${projectId}-turn-${turn}.json`；两个守卫各挡一刀」不红 —— 写侧与认侧同集合这一主张靠两格夹住，少一格就少一半 |
| T7-M18 | `pruneEmergency` 的排序键从文件名里的 turn 换成 `mtimeMs` | **本任务用例全绿** —— 登记的限度：同一毫秒刻度造不出来（要两份 mtime 相同而 turn 不同）。「keep=2 时…」证的是"新压旧按 turn"，**不证**"mtime 撞刻度会漂"。T7 ⑧ 段那段理由是这一发的全部防线 |
| T7-M19 | `EMERGENCY_KEEP` 从 20 改成 0 | 「keep 必须是 >=1 的安全整数：0 就是关掉抢救，该由调用方不装钩子来表述」红 —— 那一格里 `expect(EMERGENCY_KEEP).toBeGreaterThanOrEqual(1)` 是唯一注意到"抢救完再删光"比不抢救更坏的地方 |
| T7-M20 | `guardName` 里 `isEntityId` 那一句删掉（只按 `FILE_RE` 取词干） | 「正形状是…」红（`'../evil'` 不再抛，`path` 里出现 `..`）；「文档与工程对不上…」红在非法 id 那一型；「keep=2 时…」连带红（野名字进了桶）—— 一发打三格，因为写侧守卫与认侧识别本来就是同一个尺 |
| T7-M21 | `autosave.ts` 顶部加一行 `import { app } from 'electron';`（或把 `LOCK_HEARTBEAT_INTERVAL_MS` 换成字面量 `5000`） | 「autosave.ts 既不 import electron 也不 import node:fs…」红，而**运行不会红**：`electron` 在纯 node 下解析成一串路径，常量值又一模一样。这一发是 P-2 与"数值唯一产地"两条主张唯一的常驻证人；代价是它扫源码文本，注释里写出 `from 'electron'` 会误红 |
| T7-M22 | core `undo()` 里 `this.lastPatchApplied = inverse` 换成 `entry.patch` | 「lastPatch：undo 记的是**逆补丁**，不是 undoStack 顶上那份原件」红；db 档「undo 与 redo 各产出一发新账…」红在 `loaded.doc.canonical()` —— 撤销那一发写进库的是正向补丁，重放回到撤销**之前** |
| T7-M23 | `dispatch` 在 `cmd.build(doc)` **之前**就刷 `lastPatchApplied` | 「lastPatch：build 抛错之后停在上一发，失败的补丁绝不进账」红 —— 失败的补丁进账，`command_log` 与抢救件就会记一份根本没发生过的改动 |
| T7-M24 | `EmergencyPayload` 去掉 `patch` 字段 | `npx tsc --noEmit -p apps/desktop/tsconfig.test.json` 红（「append 抛 ⇒ failed…」里 `rescued[0]?.patch` 那一句取不到），且 T8 接 `writeEmergencySnapshot` 时 `EmergencyInput` 少一件的形状会变 —— 抢救件保整份状态、补丁需要基线，这条分工写在 Step 5 的注释里 |

**Task 7 登记的限度**（写在计划里，是给下一个动这一档的人看的，不是待办）：

1. **真并发不在这里证**。`T7-M6` 那一型只有 unit 档看得见（假 sink 数 `maxInFlight`）；db 档全用单池、单进程，看不见两个进程同时写同一工程。那半边的凭据在 T10 的 `--lock-shot`（两个真 electron 进程抢一把锁）与 T11 的 `--persist-shot`（三进程 + SIGKILL），别把本任务的「队列串行」当它用完了。
2. **60 秒是假钟**。`IDLE_SNAPSHOT_MS = 60_000` 在 unit 档靠 `FakeTimer.advance` 推进，证的是"到点就落、有新编辑就重置"这条**判定**；真墙钟上 60 秒是否真等得到、进程被杀时那份是否真没落，只有 T11 的真进程证据说了算。
3. **mtime 那一型造不出红**（`T7-M18`）。所以 `pruneEmergency` 用 turn 排序的理由只存在于注释里。
4. **裁剪失败会让目录一直涨**，且没有用例：要造一个"写得进去、删不掉"的目录得动 ACL，Windows 上不可靠。Step 5 里那一层单独的 `try`（吞掉裁剪的错）是这一型的唯一防线 —— 它换来的性质是"绝不把已写成的抢救件谎报成没写成"（T7 ⑨ 段）。
5. **`userDataDir` 底下不是目录时 `err.code` 的具体值未实测**（`ENOTDIR` / `EPERM` / `EACCES` 之一）。判据**故意不加** `/ENOTDIR/`：三条或在一起的判据等于没有判据，而那一格盯的是"返回而不抛"。跑完把实际值抄进执行回填，只作记录。
6. **db 档「八发连着落：日志 1..8…」那一格那对 `[3, 6, 8]` 依赖一个形状**：八发在同一个同步 `for` 里投完，于是 `submit` 撤了八次空闲钟、`armIdle` 只在队列排空后重新排 —— 40ms 的窗口最早也从第八发落地之后才开始计。若 T8 的接线改成"每发之间 await 一次 IPC"，这一格会漂；那时候要改的是判据（只断 `includes(8)`），**不是**把 `idleSnapshotMs` 调大。
7. **`pause` 那一格用的是 120ms 观察窗口**（证"不发生"没法用 `waitUntil`）。慢机上这个窗口只会更宽裕（pause 已经把三个定时器都撤了，窗口里没有任何东西会敲第二下），但它是本任务唯一一处"以固定时间当判据"的地方 —— 记在这里，红了先查是不是有人往 `pause` 里漏回了定时器，再怀疑窗口值。
