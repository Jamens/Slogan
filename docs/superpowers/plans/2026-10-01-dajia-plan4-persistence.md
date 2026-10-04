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
| `packages/core/src/model/invariants.ts` | `assertTruthSourceInvariants(doc)` + 共享版 `assertNoVerticalOverlap`（从 `commands/storey.ts` 提上来，不留第二份规则）。**执行期追加（P-57/P-58/P-59）**：`assertWallShape` 也从 `commands/wall.ts` 提上来（带 `label` 参）、洞顶 ≤ 宿主墙高、幽灵柱两型分账 | T3 |
| `scripts/check-invariants-cycle.mjs` | **执行期追加**（P-57 的常驻证人）：扫 `model/invariants.ts` 的传递 import 闭包，出现 `commands/**` 即 exit 1 —— 搬迁之后「读盘门不许回指命令层」这条主张的形状 | T3 |
| `packages/core/test/invariants.test.ts` | 计划 2 交下来的读盘清单逐条有牙（`handBuild(...)` 手搓坏文档；命令层造不出这些坏数据正是它的落点） | T3 |
| `apps/desktop/src/main/db/codec.ts` | 磁盘 JSON ↔ core `Entity`/`Document`/`Patch`；每一行过 zod，抛错带表名与行 id | T4 |
| `apps/desktop/src/main/db/pool.ts`（**T4 回改**） | 补 `supportBigNumbers`/`bigNumberStrings` 与 `lockWaitTimeoutMs` 透传（裁决 P-17：读路径第一次真读 BIGINT 才需要） | T4 |
| `apps/desktop/src/main/db/repository.ts` | `createProject` / `appendJournal` / `writeSnapshot` / `loadProject` / `closeProject` —— 唯一会写库的地方 | T4–T5 |
| `apps/desktop/src/main/db/reconcile.ts` | 收尾三方对账的**纯函数**（`diffDocAgainstElement` / `diffStoreyProjection` / `diffStoreyIdColumn` / `reconcileProjection` / `formatMismatches`）+ `storeyIdOf`（写列与审列共用那一份规则，从 `repository.ts` 的模块私有版搬进来）+ `MISMATCH_REPORT_CAP`。不 import DB / electron / zod ⇒ 住在这里才有 CI 那一档 | T5 |
| `apps/desktop/test/unit/codec.test.ts` | 纯内存往返：六类实体逐字回来、`canonical()` 逐字节相同、多余字段/浮点/`-0` 三型在读取侧拒、抛错文案带表名与行 id（**不连库 ⇒ CI 有牙**） | T4 |
| `apps/desktop/test/unit/entity-shape.test.ts` | **编译期双向可赋值** `EntityShape ↔ Entity`（只有**编译期**看得见的那一型漂移 —— 而 `verify` 的 typecheck 面里就有 `tsc -p tsconfig.test.json`，口径见 P-63） | T4 |
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

**MySQL**（2026-10-01 只读探测）：`node` 的 `net.connect(3306, '127.0.0.1')` 回 **OPEN**；本机 `which mysql` 无 —— **mysql CLI 不在 PATH**，所以任何"用命令行客户端手敲 SQL"的写法在这台机器上跑不通，运维通路只能是 `pnpm db:sql` 导出。spec §12 那五条服务端参数（utf8mb4 / utf8mb4_0900_ai_ci / `lower_case_table_names=1` / `max_connections=151` / 8.0.45）由 Task 1 的 `env.test.ts` 变成会红的断言。

**2026-10-04 补测（Task 1 落码之后，本计划第一次真连库）**：凭据通路打通（`DAJIA_MYSQL_*` 五个变量由运行时环境提供，值不进仓库、不进日志，见执行回填），`pnpm test:db` **exit=0 / 1 文件 / 3 条**，普查行原样 `[census] version=8.0.45 max_connections=151` ⇒ 上面那五条参数从"备忘"升格为**实测为真**。同一次只读探测对 `dajia` / `dajia_test` 的答案：**两库都不存在**（本机用户库现测 15 个，spec §12 当年记 14 —— 是别的工程涨的，与搭家无关，不订正 spec）。⇒ 本计划「授权与红线」里"从未建过、零 DB 写入"这句话在 2026-10-04 仍然成立，**第一次 `CREATE DATABASE` 排在 Task 2**。

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

## 裁决（P-1 … P-17 + 执行期追加的 P-40 … P-67；执行中若与落地的代码冲突，按代码订正并写执行回填。P-18 … P-21 住在 Task 8 的段落、P-27 与 P-33 住在 Task 9 的段落 —— **P-22…P-26 / P-28…P-32 / P-34…P-39 是空号，别再往里填**；那 6 条随各自任务回写时**就地补表**，不把理由复制一份过来）

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

### 执行期裁决（P-40 起；Task 1 / Task 2 / Task 3 落码时由控制位追加）

> 编号从 **P-40** 起，因为 P-18…P-39 那一段被预留给了 Task 8 / Task 9 的文本。2026-10-04 用脚本按 `P-(1[89]|2[0-9]|3[0-9])\b` 扫过 `## Task 1` 之后的全文，实数只有 **6 个号真被写过**：P-18、P-19、P-20、P-21（Task 8 的 ①②③④ 段）与 P-27、P-33（Task 9 的段落）；**其余 16 个号从未被任何一条裁决占用**。这条账目订正的依据是"编号看起来有人住"本身就是第二份真源 —— 表若声称 22 条，读它的人会去找 22 条主张。那 6 条的正文住在各自任务段落里，回写时**在本表补行、理由就地引用**，不复制。

| # | 决定 | 理由 | 已接受的代价 |
|---|---|---|---|
| **P-40** | Task 1 的只读普查**只连实例**：`createPool` 只取 `host/port/user/password` 四件套，`database` **不进连接入参** | Step 6 的散文（"连的是实例本身，`database` 只用来核对白名单"）与它自己给的代码（`createPool({ ...env })`）互相打脸：`env` 带着 `database` ⇒ mysql2 建连时自己发 `USE dajia_test`。而库在 Task 2 才建，于是"本任务不建库、不建表、不写一行"这句注释成了一条**永远跑不绿的判据**。真凭据下第一次 run 才看得见（`Unknown database 'dajia_test'`） | 修完只是"能跑"，判据本身一字未减；`database` 白名单那一格（格 2）职责不变，`env.database` 仍被 `assertDatabaseName` 过一遍。**这条改判反而加强了主张**：现在"零写入"是"两库都不存在的实例上跑得绿"的事实，不再是一句注释。同族普查已做：`grep -n "\.\.\.env"` 扫过 Task 2/4/5/6/7 的 brief，那些 `{ ...env, database }` 全部合法（它们连的就是自己建的库），只有 Task 1 这一处是"连实例却带库名" |
| **P-41** | 普查那五发参数一律按**驱动真实回值形状**断：整数两发过 `Number()`、字符串那一发过 `String()`；行 cast 从 `Record<string, string>` 改成 `Record<string, string \| number>` | 实测（2026-10-04 第一次真连库）`@@lower_case_table_names` 回 JS **number 1**，而 brief 写 `expect(got.lctn).toBe('1')` —— 同一发 `SELECT` 里的 `max_connections` 却已经 `Number()` 包过了，两行本身就不自洽。根因是那个 cast 假装整行都是字符串，typecheck 于是**站在错的那一边** | `String(got.v)` 放弃了"VERSION() 必须是字符串"这条附带形状断言（登记为限度，不是待办）。`lctn` 的断言从"等于 '1'"改成"恰好等于 1"，**没有变弱**：面对 number 1 的 `toBe('1')` 本来就是一副空牙 |
| **P-42** | `pnpm test` 的基线文件数订正：**35 → 36**（Task 1 之后），不是 Step 8 原写的 37；后续任务的起点跟着改 | 原文把 `packages/protocol` 那 1 文件算成"这一档新增的"，可 35 的基线里本来就含它（25 core + 7 scene-2d + 2 `scripts/test` + 1 protocol = 35，与「现状事实」表逐字一致）⇒ 净增只有 `db-safety.test.ts`。审查席用 `git ls-tree` 在 `e548174` / `df961e6` 各枚举一遍全集独立复核，两边逐名相同 | 计划第 5 行早就点名过这一型（"按盘上实测重数，别为了凑数去动判据"），这次是控制位自己写的数字踩上去的。**判据的牙未动**：`Tests` +4 与 Step 3 那发"文件被发现但模块缺失"的红，两处独立证据仍夹住 include 生效 |
| **P-43** | 「缺环境变量必须响亮失败」这条红线需要一个 **CI 通道里的证人**：把 `env.test.ts` 的第 3 格（假 `env` 入参，不连库）复制一份进 `apps/desktop/test/unit/` | 审查席独立发现：该判据目前**只住在 `test/db`**，而 db 档不进 `verify`（CI 既无 MySQL 也无口令）⇒ 有人把 `readMysqlEnv` 改回"没配就返回默认参数"（变异 M3 那一型）时，`pnpm test` 抓不到，红线在 CI 上是零覆盖。那一格本来就是纯函数测试（喂假 `env` 对象），搬过去不需要任何凭据 | 两处同一判据 ⇒ 一份行为两份用例。这是有意的：被复制的那一格守的是红线，不是实现细节；改判据时两格会一起红，正是想要的连带。**不**把 `readMysqlEnv` 的整个测试面搬到 unit —— 只有这一格不依赖连接 |
| **P-44** | `apps/desktop/test/unit/env.test.ts`（P-43 的证人档）三处收口：格 4 的注释改成它真正证的事、格 2 的整串正则换成逐名 `toContain`、档头补四格分层 | 定点复核席判 **FAIL**（不是断言坏，是**注释谎报**）：格 4 写着"挡住把口令悄悄塞进日志"，可它既不 spy `console` 也不看日志通路，而"`MysqlEnv` 没有 `toString` ⇒ 要打整份得显式点名"这个前提是**反的**（普通对象 `console.log` 连 `password` 一起吐）。格 2 的 `/HOST.*PORT.*USER.*PASSWORD.*DATABASE/` 连五个名字的**排列顺序**一起焊死，而顺序不是判据 | 形状那一格**否掉**了复核席建议的 `toMatchObject`（去锁）：五键闭集就是判据本身，去锁等于把红线换成软要求；`Object.keys(env).sort()` 留着，身份降为诊断质量。代价：这一格绑住"消息里五个名字都在"，将来文案改成不含变量名的一句会红 —— 那是**该红的**（红线要求点名） |
| **P-45** | Task 2 Step 5 原文的 `expect(tables).not.toContain('_migration')`（半途失败的迁移 ⇒ 无残留）改成 `toContain`，并**另补一格**证对偶方向：坏迁移的**第一条语句**就失败 ⇒ 库里一张表不留、版本不记账 | 两个理由叠在一起：① MySQL 的 DDL **隐式提交**，跑到的语句就是跑了的，`migrate()` 的 `rollback` 抹不掉已建的表 —— 而本任务自己落地的 `migrate.ts` 注释①写的正是这句话，原判据与同文件的注释互相打脸；② 真凭据实测（`t2fix-probe.mjs` E 条）：`multipleStatements` 的一批语句在第一条报错处停下，**后面的语句根本不执行** ⇒ "无残留"的正确形状是"根本没开始"，不是"回滚成功" | 原判据想守的那件事（半途失败不许把库带进半套状态）改由**新格**守，形状不同但更强：它同时是 `readApplied` 幂等重放的前提。已提交的那一半靠校验和 + `_migration` 记账在下一次 `migrate` 时炸，这条主张在 T2 有实测凭据（M1 那一发） |
| **P-46** | `migrate(pool, database)` 在读写任何东西之前，先发一发 `SELECT DATABASE()` 核对"声称迁的库"与"连接实际所在的库" | 审查席 I4：连接池带着 `database` 参数，而 `migrate` 只吃一个 `database` 形参 ⇒ 两者**可以不是同一个库**，而 runner 会报成功。这是 I3 那一族"报成功而打错了库"里唯一没有任何判据覆盖的一型，且它是后面五个任务的地板 | `migrate` 每次多一发往返（M10 实测：删掉这一发 ⇒ `001` 整批静默打进 `dajia_test` 并返回成功）。代价按审查 m1 的口径登记：T7 接线时若嫌开工程慢，**带判据地**缓存，不许无判据先砍 |
| **P-47** | 白名单那一道闸必须**有证人**：拿一个已关闭的池喂 `smartscrm` ⇒ 红的必须是"不是搭家的库"，而不是连接类错误 | 落盘文本里"闸在 SQL 之前"只是一句注释。M12 的实测给它上了价：白名单后移到 `readApplied()` 之后，全档**只有这一格**接得住（红在 `Pool is closed.`），其余 12 格全绿 ⇒ 无此格则"先闸后 SQL"在 CI 与本地都是零覆盖 | 独苗。这一发用"已关闭的池"这种形状才观测得到顺序，换一个破坏形状（M11 的两行互换是另一发证人）就靠 P-46 的两格。登记给 T3+：共享夹具里这条顺序只有两格在守 |
| **P-48** | `dropTestDatabase` 的**第二道闸**（名字不等于 `dajia_test` 就抛，`dajia` 也挡）补常驻判据；同时把原文串在一个 `it` 里的三发 `expect` 拆成七格 | 审查席 I1：那段代码在 `168939a` 之前是"代码在、判据零"—— 删掉它没有任何测试会红。拆格是同一批的连带：旧形状下只删一个入口的闸拿不到读数（M3 实测：拆格后只有 `ensureDatabase` 自己那一格红，别的入口照常挡住，"入口重复是有意的"这条纪律第一次有凭据） | 格子数从 6 涨到 14 的主要来源。`ensureDatabase(env,'dajia')` 那一格**没有真建库**（改道走打不通的实例，只观测文案层）—— 丢掉的读数只有"`CREATE DATABASE dajia` 这句语法真能成"，复审席判改道成立：同一行代码每跑都在 `dajia_test` 上绿过 |
| **P-49** | 生成列的字符集口径钉成 `STORED COLLATE ascii_bin`，并在**静态**与**连库**两侧各留一个证人 | 计划文本原先写 `STORED CHARACTER SET ascii` —— 实测（`t2fix-probe.mjs`）这一串在 8.0.45 上是 `ER_PARSE_ERROR`，只有 `COLLATE` 形态能解析。而 `idx_project_loadbearing` 值不值得建（spec §8.1）取决于生成列的**落点字符集**，漂回 `utf8mb4` 只有 `information_schema` 那一格看得见 | 连库那一格不进 CI（P-2 的老代价），所以静态那一半（写死 `STORED\s+COLLATE` 形状）是本仓唯一在 CI 有牙的证人 |
| **P-50** | `migrate.test.ts` 的 `afterEach` 由"固定七张表名"改成 `SHOW TABLES` 驱动（读什么清什么） | 审查席 I5：写死名单 ⇒ 002 加一张表就得记得改夹具，忘了就是下一格"表已存在"的莫名红。同一批改掉了格子之间的顺序耦合 | 清理与证据共用同一张 `SHOW TABLES` 是复审席追问过的点，判无危险：**没有任何格子吃上一格的残留当证据**（P-45 两格与 P-46 不一致格的读数全部发生在本格体内）。验收方式按裁决指定：打乱声明顺序重跑，`2 files / 17 tests` 仍全绿 |
| **P-51** | 三个"必须被闸挡住"的格子改成**只走 `unreachableEnv`**（`{ ...env, host: '127.0.0.1', port: 1 }`），真实例那半发删掉 | 复审席 I1（安全）：`dropTestDatabase` 发的是 `DROP DATABASE IF EXISTS <name>`，而格子原来**先拿真 `env` 跑一遍**。今天闸在所以空转；变异棒会把闸删掉真跑 —— 那一发会在格子变红之前把 `DROP DATABASE smartscrm` / `DROP DATABASE dajia` 发出去。前者是用户别的项目在跑的库，后者 T11 之后躺着真工程数据。`ensureDatabase(env, 'ledger_db')` 同批收 —— 它靠"库里恰好已有同名库"才空转，不值得赌 | 判据一点没弱（M3/M9 实测：闸挪到 SQL 之后拿到的是 `ECONNREFUSED` 而不是白名单文案，照样红在错误种类上），破坏面从"用户的库"变成"一次连不上"。新依赖："127.0.0.1:1 立即拒绝"这一形状债（m4）：进 CI/容器前应换成桩 `Pool`（`query` 一被调用就抛），本档登记为已知形状债 |
| **P-52** | 两条生成列正则的无上界部分收紧：`[\s\S]*` ⇒ `[^;]*`，`load_bearing` 另钉 `END)`（CASE 的收口锚） | 复审席 I2：原判据能抓 VIRTUAL 漂移纯属"`STORED` 字面量在 `migrations.ts` 里只出现两行"的布局巧合，002 一落地就打开假绿门 | **这条收紧被 P-54 证明只关住了跨语句那一半** —— 同一条 `CREATE TABLE` 里两张生成列之间没有分号，`[^;]` 跨得过去。诚实的记法是：P-52 处理了 002 的方向，M13 实测暴露了 001 自己的方向，后者由 P-54 补 |
| **P-53** | `load_bearing` 用 `CASE` 而不用 `CAST` 的理由，按**实测红相**改写 | 变异棒 M2：计划文本预测 `['wall',1]` 变 `['wall',0]`，真跑出来是三条探针 INSERT 的**第一条就被服务端硬拒** —— `ER_TRUNCATED_WRONG_VALUE (1292, 'Truncated incorrect INTEGER value: ''true''')`。strict mode 下既不静默给 0，也不"警告后仍成功" | 红得比预测更响：那句注释的凭据从"会算错"升级为"根本进不了库"。代价：001 从此**冻结**（校验和在运行时按 SQL 正文算，改注释即改校验和 ⇒ 已应用的 001 不许再动，后续只许加 002） |
| **P-54** | 静态档补 `expect(first.sql).not.toMatch(/VIRTUAL/)`，把整型关掉 | 变异棒 M13 的两步对照跑（a=只改 SQL、b=连正则一起还原）给出最扎人的读数：`kind` 漂成 VIRTUAL 时，`:23`「001 建齐六张表」那一格**收紧前后都绿** —— P-52 的 `[^;]` 在同一条语句内跨到了 `load_bearing` 的 `END) STORED`。真正钉住它的是 P-49 的两个证人（静态形状格 + 连库 `EXTRA` 格），而"建齐六张表"这一格的名声比它的覆盖面大 | 用的是整型禁用（`not.toMatch(/VIRTUAL/)`）而不是"数 `STORED` 的个数"：后者在 002 加生成列那天当场假红，判据该跟着长的方向反了。控制位亲自复跑：三格同时红（新格 + P-49 静态证人 + 镜像档），还原后 6/6 绿、md5 与开局逐字节一致 |
| **P-55** | Task 3 Step 4「竖向重叠 / 正好贴邻 / 留空隙」那一格，夹具给上层补显式 `index = 1`；**三条断言与格数一字未动** | 计划文本自己打脸：`storeyAt(id, elevation, height, index = 0, …)` 的默认值让同一格的两层**都是 `index: 0`**，而紧随其后的下一格吃的是**逐字节相同**的文档并断 `toThrow(/index 重复/)` —— 两格不可能同时成立。缺陷在夹具不在实现（席位实测的红灯：`expected [Function] to not throw an error but 'RangeError: 楼层 index 重复：…:0' was thrown`，红在"贴邻不抛"那一发）。审查席独立复算并确认 | 这一格的唯一变量回到标题声称的那件事（竖向区间的重叠 / 贴邻 / 空隙），比原文更纯。代价：`index = 1` 是夹具里的第二个自由度 —— **T4 之后复用 `storeyAt` 造多层夹具时，同一 `projectId` 下 index 必须唯一**（这条已由本格在守） |
| **P-56** | 「storey.ts 不许留第二份重叠规则」那格的 `toContain("from '../model/invariants'")` 换成**行首锚定的值 import `toMatch`**，且**原那一行撤掉**（不许只加不删） | 子串判据证不到"这是一条 import"：复审席实测 —— 删掉 `storey.ts:7` 的 import、只在注释里留下 `from '../model/invariants'` 这句话，**旧形状绿、新形状红**。这是 T2 的 M13 / P-52 / P-54 那一族（源码扫描型判据的形状比标题窄）第二次落地。选锚定形态而不是"数 import 语句"的理由：`[^}]*` 与 `\s*` 吃掉"花括号里有别的名字""换行""行尾分号"三种常见重排，避免一次纯格式改动就假红 | 新形状仍吃不下**跨行写法**的第二份规则（第二条 `/elevationMm \+ .*heightMm/` 的 `.*` 只在同一行内贪心），限度写进格子注释而不是假装证到。同时**作废**席位报告里那句"0 命中已经要求 import 真在"的论证 —— 一条 `not` 匹配不可能要求任何东西存在，该格真正的承重是 typecheck + `commands-column-slab.test.ts` 那两发 |
| **P-57** | `assertWallShape`（零长 + 墙厚不小于墙长）从 `commands/wall.ts` 的模块私有**搬进** `model/invariants.ts` 并导出，签名加 `label` 参（命令层传 `'该墙'`、读盘门传墙 id）；读盘门的墙循环调用它，且**不借道 `wallAxis`** | 审查席探针实测：厚 5000 装 4000 长（[A]）与厚 = 长的边界（[B]）**静默过读盘门** —— 派生层 `geom/outline.ts:112-116` 的四件守卫（星形接头、同向重叠、近平行无接缝点、轮廓翻面）不含它，`assertNoFlip` 只比 trim 和与轴长，够不着自由端墙。而 T3 的 doc block 当时正声称派生层覆盖它 ⇒ 一句谎配一条盲区。搬而非另立：`model/invariants.ts → commands/wall.ts → model/invariants.ts` 会成环，反向（commands import model）是既有方向。不走 `wallAxis`：`geom/axis.ts` 自带一句零长报错，借道等于**第三份判据**、还多一次抛点与一次换算，而坐标上面已经取到 | 命令层两句文案各多了 `该墙`（盘上 8 处命令侧断言全是 `toThrow(/零长/)`、`toThrow(/不小于墙长/)` 的松正则，**没有一处逐字钉整句** —— 搬迁前后都复验过）。连带三笔：`scene-2d` 一处注释指针要跟着改（R2-2）、读盘门新增对 `geom/vec` 的 `length/sub` 依赖（闭包无环由新脚本 `scripts/check-invariants-cycle.mjs` 常驻守着）、`invariants.ts` 原先那条自己写的零长分支删除（它是文案不同的第二份判据，且审查席判它**零证人**） |
| **P-58** | 洞顶 ≤ 宿主墙高进读盘门（`sillMm + heightMm > host.heightMm` ⇒ 抛，文案点名洞口 id / 顶标高 / 宿主墙高 / 两个加数）；同时**明写这条不主张"读盘门是写盘门的超集"** | 探针 [E]（洞高 99999 装 3000 墙）与 [F]（`sill 200 + 高 2900` 超 3000 墙顶）实测**双双放行**。而 `commands/opening.ts` 顶部**白纸黑字**把"洞顶 ≤ 宿主墙高"列为"派生抓不到的三条"之一 —— 即写盘侧知道、派生侧看不见、读盘侧此刻不管，Task 5 装上这道门之后物理上不可能的洞口会静默进画。不对称的真相：写盘侧 `assertFitsAfterInsert` 是**并入同宿主已有洞口之后**再判竖向，比按裸字段判更严 ⇒ 两处判据故意不同强度 | 读盘门与写盘门对同一族错误给**两族文案**（T5 的重放路径要按两族写断言，不能假设一个正则吃两边）；读盘门这一发只挡"字段本身就装不下"那一型，挡不住"两个洞并入后超高"那一型 —— 后者只有写盘门看得见，登记为已知残余 |
| **P-59** | 幽灵柱两型**分账**：`assertNoGhostColumn`（`geom/topology.ts` 那份产地，禁动几何面）拦「同层、同坐标、**不同点 id**」；读盘门另补一发「同一枚 `(storeyId, pointId)` 落点只准挂一根柱」拦「**同一枚点**两柱」，键的形状照 `seenIndex` 那条既有判据 | 第一轮只加了前者，而审查席探针 [C] 点名的正是后者 —— `exceptPointId` 按**点 id** 排除自己，对手挂同一枚点时被当"自己"排掉，那一型**仍然放行**。`commands/wall.ts` 注释明说柱不进派生表、`SpatialIndex` 只装墙与洞口 ⇒ 视图与索引对这一型永远是瞎的，而读盘门是 Task 5 唯一装上去的放行证。夹具可达性实测：`Document.replaceEntities` 的 validate 只查 id 形状与整数毫米、零跨实体检查 ⇒ 这一型手搓得出来，**不是"构造层面不可达"** | 两型各一次 O(columns) 扫描（合起来 O(columns²) 那一发是 loads 时的一次性成本，与派生层同一量级）；报错文案在判决给的 `${storeyId}:${pointId}` 键之外多带了被拒柱的 id —— 复审席裁"不回撤"（消息里"哪根柱被拒"真实存在，且有证人消费它） |
| **P-60** | `assertTruthSourceInvariants` 函数头那段"本门覆盖 / 归派生层"的**清单升为合同**：每次往读盘门加或删判据，都要把清单两向核对一遍（声称覆盖但代码没有 = 谎；代码有但清单没写 = 过谦），并把"两向核对"固定为复审席的一问 | C1 的根因不是缺判据，是**一句注释让下一个任务把它当放行证**：原文"几何退化…invariants 里一条都不重算"同时犯了两向的错 —— 承诺了派生层没有的三条，又没写代码里已有的那条零长分支（`invariants.ts` 自己重算了，注释说没重算）。落码后的清单按事实分成两栏，各条都能指到具体判据与具体格子 | 清单是注释，注释不进测试 ⇒ 唯一牙是复审席那一问与 P-57 的循环检查脚本；`geom/outline.ts:112-116` 那份四件清单是派生层的合同，两处若漂移只有人工两向核对能抓（登记为限度） |
| **P-61** | I2 的补法裁成**行为探针**，不新增源码扫描格：每类每枚 `*Id` / `*Ids` 字段逐一 `safeParse`（非 V7 串必拒 **且** 合法 id 必收），`StoreySchema.index` / `loadBearing` / `material` / `category` 各一发，`EntitySchema` 的 discriminant 另发 | 审查席 §5 item 7 那一族"降成 `z.string()` / `z.number()` 之后**零红**"只有行为探针接得住；名字级 pin（键集合逐字对账）钉的是字段名，不是 validator。"必收"那半发是新加的：只测"坏值被拒"的循环表会把过严实现也测成绿（整格假绿的另一型）。明确**不许**为 I2 写读源码文本的格 —— 源码扫描那族刚在 T2（P-52/P-54）和 P-56 连着栽两次，能用行为证的一律用行为 | `m1`（`discriminatedUnion` vs `z.union`）的牙落在 zod 4.6.5 的具体报错形态（未知判别值 `invalid_union` 且 `path=['kind']`，plain union 的 `path` 为空）⇒ **升级 zod 若改报错形态，这一格会红**；那是设计内的钉子（它逼下一位重新核一遍 path 形状），不是脆弱 |
| **P-62** | 控制位判决里给的**夹具配方本身要实测**，走不通就地订正并登记（本轮两处：`mm()` typeof 守卫的证人、`requireStorey` 的类别点名） | ① 判决写"`replaceEntities` 换一枚缺整数字段的实体"，实测走不通 —— `Document.replaceEntities` 先跑 `validate()`，缺字段**先红在「必须是整数毫米」**，永远到不了 `mm()`。席位改成"建好合法文档再毁掉文档内那枚实体的字段"，比判决更贴威胁模型（手搓对象不受 validate 保护 = 读盘路径的真实形状）。② 判决要求用 `/洞口\|柱\|楼板/` 分辨类别，而 `requireStorey` 的报错里**根本没有类别词** ⇒ 这是一条字面不可满足的要求；落地用每类专属幽灵层 id + `not.toMatch(/同层/)` 分账，摘掉对应那发时红在"必须同层"上，归属仍有牙 | 记账方向：判决也是文本，席位的实测才是盘。代价是**下位席位不能盲抄判决的配方** —— 每条配方落地前先跑一发可达性，做不到就回报而不是削判据（本轮两位席位都做到了这一点） |
| **P-63** | **全局口径订正**：`pnpm verify` **确实**编译 `apps/desktop/test/**`（连 `test/db/**` 一起）。"第三发 `tsc` 才是唯一编译证人"那句话作废，六处文本（文件结构表 T4 行、Task 2 Step 6 的说明块、Task 2 执行回填的闸门行、Task 4 的 Step 8 M6 预检、Task 4 变异表 M6 行、Task 5 Step 5 的括号理由）就地改口；单跑那一发保留，但**理由只能写成"日志聚焦 / 不跑全量也能单独证编译"** | 控制位读脚本实测的链路（不采信任何席位的转述）：`verify = typecheck && lint:deps && test` ⇒ root `typecheck` 串里有 `pnpm --filter @dajia/desktop typecheck` ⇒ desktop 的 `typecheck` 末尾就是 `tsc --noEmit -p tsconfig.test.json` ⇒ 那份 tsconfig 的 `include` 是 `["test","src/main","src/preload"]`（整个 `test` 目录，不限 `unit`）。这条约束自 **Task 1 的 `92240d8`** 起就不成立，而它被复述进了 Task 2/4/5 的派发词与六处计划文本 —— 也就是说**后续每一棒都会照着它多写一条不存在的前提** | 判据只变硬不变软：db 测试文件的类型错现在挡 CI，本地没有 MySQL 也得让 `test/db/**` 编译过。代价是**账要重记**：之前所有"这一型只有 `tsc` 看得见"的表述都得换成"只有**编译期**看得见，而 `verify` 里就有编译期"；T4 的 M6 行因此同时挨了两刀（编译面 + protocol 档会红，见回填第 5 条）。**不**因此删掉任何一发独立 `tsc` —— 它便宜、且失败时日志只有一档 |
| **P-64** | `element.updated_seq` 的判据钉成**逐实体 upsert 的真形状**：`DISTINCT = 2`、`seq1` 只被楼层那一发覆盖（1 行）、`seq2` 覆盖墙 + 两枚柱（3 行）、`1 + 3 = 4` 等于投影总行数。brief Step 6 原文的 `DISTINCT=1` / `count(seq2)=4` **与同一节 Step 7 自己写的逐实体 `patch.upsert` 自相矛盾** | 席位实测 + 审查席独立探针复现（`seq1 storey / seq2 wall+2pts / distinct=2`）。原写法要真成立，得把写路径改成"一发只碰一行"或"整层重述" —— 那是为了凑一条抄错的期望而削实现 | 语义从此被断言钉住：**每行 `updated_seq` = 最后修改这一行的那发 `command_log.seq`**（不是"这发事务的 seq"，也不是"最大 seq"）。T5 的 `closeProject()` 要把 `updated_seq` JOIN 回 `command_log.turn` 做三方对账，靠的正是这条被钉住的语义。代价：这一格绑住"哪些实体在同一发里被 upsert"，T7/T8 若改命令的补丁形状（比如让楼层删除连带重述墙），这一格会红 —— 那是**该红的** |
| **P-65** | `multipleStatements` **只准住在迁移连接**：`createDbPool` 默认 `?? false`，业务池永远单语句。测试夹具里那个池按用途分两个 —— 迁池带 `multipleStatements: true`，业务池不带 | brief Step 6 的夹具照抄 `createDbPool(env)` 没补这条 ⇒ `migrate` 的多语句脚本当场 1064、`repository.test.ts` **整档 20 格 skip**。补的是夹具不是判据，且审查席实测业务池叠 `SELECT 1; SELECT 2` 被服务端 1064 拒 —— 这道墙没被 `pool.on('connection')` 顺手开掉（handler 只发单条 `SET SESSION`） | 多语句是注入面与"半途留下几条语句"的放大器，产品路径一条都不需要它。**代价**：夹具从此有两个池，读代码的人要明白"为什么同一个库连两遍"；`repository.test.ts` 的档头注释写了这条分工。T5/T6/T7 的 db 档沿用同一形态，**不许**图省事把业务池改成多语句 |
| **P-66** | `pool.on('connection')` 那颗地雷按**运行时**写：监听器收到的是 callback 连接，一律单参数 fire-and-forget（`void conn.query(sql)`），**不许**对它 `.then()`/`await`。`sessionVariables` 在 mysql2 全包（lib + typings）零命中 ⇒ 走 brief 预先授权的兜底分支，不是偷懒 | 类型声明把 promise 池的 `'connection'` 事件回调参数标成 PoolConnection（promise 型）⇒ `conn.query(sql).then()` **过 tsc**，运行时却在监听器里抛、打断 `getConnection` ⇒ 整套连库测试表现为挂死。这类"编译过、运行时炸、症状在别处"的形状只能靠注释 + 实测钉死（`pool.ts:20-23,71` 两段注释记的就是这一发） | 生效性**没有常驻读数证人**：审查席那次 `@@innodb_lock_wait_timeout = 1` 是已撤的自证探针。漂了（SQL 拼错 / 事件名改错）的形状不是假绿 —— 是那一发慢到 InnoDB 默认 50 秒、红在 60 秒 `testTimeout` 上，症状从"快失败"变成"像挂死"。登记为限度，T6 的锁档天生要读服务端时钟，把那发变成常驻读数是自然的补位点 |
| **P-67** | **T4-M7 由"已知限度"改判为"有牙变异"**，并订正报告：删 `asJsonValue` 的 `typeof raw === 'string'` 那一支实测 **9 格红**（`codec.test.ts` 的直接格 + 三发从字符串解的 `canonical()` 往返 + 第 13 格往返哨兵，exit=1），**不是**"没有任何用例变红"。代码一字未改（两支都在、两支都被覆盖），改的是账 | brief M7 的"If A 档 = `object` ⇒ 零红"把**连库读路径**（Step 1 实测 A 档 = `object`）与**纯文本 unit 路径**（`codec.test.ts` 全程喂 string）混为一谈 —— 前者确实抓不到，后者正是那一支的常驻证人。哨兵格跟着红，说明它兜的不只是"decode 必须先成功" | 记账方向同 P-62：**判据的效力以实测为准，不以写作时的推演为准**；连"限度"这个分类本身也要实测才能登记。代价是 T4 报告与 §5 那段"不靠变异证，只靠注释"的表述要一起订正，别留着让 T5 席位以为 `asJsonValue` 无覆盖 |

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
- Create: `apps/desktop/test/unit/env.test.ts`（**4 格，Task 1 落码后由裁决 P-43 追加**：`readMysqlEnv` 的"缺变量就点名抛"是红线级判据，而它原先只住在 `test/db/**` —— db 档不进 `verify`，等于这条红线在 CI 上零覆盖。这一格喂假 `env` 对象、不连库，所以搬进 unit 零成本。**`test/db/env.test.ts` 那一份不删**，理由见 P-43 的代价栏）

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
// `type Pool` 与值 import 混在一条里：这一发同时就是 P-12 想要的 TS 侧实测
// （`verbatimModuleSyntax` + 无 `esModuleInterop` 下，`mysql2/promise` 的值与类型都拿得到）。
import { createPool, type Pool } from 'mysql2/promise';
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
  // **`database` 不进连接**（裁决 P-40）：本任务连的是实例本身，建库排在 Task 2。
  // 写成 `{ ...env }` 会让 mysql2 在建连时自己发 `USE dajia_test` ⇒ 库还没建就当场红，
  // 上面那句"不建库、不建表、不写一行"于是成了一条永远跑不绿的判据。
  // 显式列四件套而不是 omit 解构：`noUnusedLocals` 那侧少一个解释成本。
  const pool = createPool({
    host: env.host,
    port: env.port,
    user: env.user,
    password: env.password,
    connectionLimit: 1,
  });
  close = () => pool.end();
  (globalThis as { __pool?: Pool }).__pool = pool;
});

afterAll(async () => {
  await close();
});

describe('MySQL 环境事实（spec §12 的凭据化）', () => {
  it('服务端参数与 spec §12 记的逐字一致（改了就红，别把设计建在飘的地上）', async () => {
    const pool = (globalThis as { __pool?: Pool }).__pool;
    if (!pool) throw new TypeError('普查用的池没建起来');
    const [rows] = await pool.query(
      "SELECT VERSION() AS v, @@character_set_server AS cs, @@collation_server AS col, " +
        '@@lower_case_table_names AS lctn, @@max_connections AS maxc',
    );
    // **回值的形状本身也是这一格学到的东西**（裁决 P-41）：`VERSION()` 是字符串，两个 `@@` 整数
    // 变量在 mysql2 下回 JS number —— 实测 2026-10-04：`lctn` 回的是数字 1，不是 '1'。
    // 所以不许把整行 cast 成 `Record<string, string>` 假装它全是字符串（那正是判据原来写错的原因），
    // 而是整数一律过 `Number()`、字符串那一发过 `String()`。
    const got = (rows as Record<string, string | number>[])[0];
    if (!got) throw new TypeError('SELECT 没回行');
    expect(got.cs).toBe('utf8mb4');
    expect(got.col).toBe('utf8mb4_0900_ai_ci');
    // 生成列与 id 列的 collation 都要跟着这个口径走（混着 JOIN 会报 Illegal mix of collations）。
    // 断"恰好等于 1"而不是"非零"：库名大小写不敏感是 T2 那六张表与生成列设计的前提。
    expect(Number(got.lctn)).toBe(1);
    expect(Number(got.maxc)).toBeGreaterThanOrEqual(151);
    expect(String(got.v).split('.')[0]).toBe('8');
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

Expected: `verify exit=0`；`Test Files` 从 **35** 涨到 **36**（本任务只新增 `apps/desktop/test/unit/db-safety.test.ts` 一个文件 —— `test/db/env.test.ts` 不在 `pnpm test` 的射程里）。`Tests` 从 **509** 涨到 **513**（正是 `db-safety.test.ts` 那 4 条）。

> **这一发的原数字是错的，2026-10-04 由 Task 1 落地时订正**：原文写"涨到 **37**，若只涨 1 说明 include 那行没吃到新目录"。它把 `packages/protocol` 那 1 文件当成"这一档会新增的"，可 35 的基线里**本来就含**它（25 core + 7 scene-2d + 2 `scripts/test` + 1 protocol = 35，与「现状事实」表逐字一致）⇒ 净增只有一个文件。**审查席独立复核过这笔账**（`git ls-tree` 在 `e548174` 与 `df961e6` 各枚举一遍文件全集，两边逐名相同）。判据的牙没动：`Tests` +4 与 Step 3 那发"文件被发现但模块缺失"的红，两处独立证据仍然夹住 include 生效。
>
> 这正是本计划第 5 行警告的那一型（"按盘上实测重数，别为了凑数去动判据"）。**后续任务的 `Test Files` 起点是 37 / `Tests` 起点是 517** —— 但那两个数是**两步**涨出来的，不是本任务的：35 → **36**（Task 1 自己的 `db-safety.test.ts`，+4 条 = 513）→ **37**（裁决 P-43 追加的 `apps/desktop/test/unit/env.test.ts`，+4 条 = 517，它是审查席发现"缺环境变量响亮失败"这条红线在 CI 通道零覆盖之后补的证人，见本节末 Step 6 那一档的 P-40/P-41 订正与执行回填）。
>
> **别把 37 当巧合**：原文那个"37"是幻影（算重了 `packages/protocol` 那一格），实测的 37 是"36 + P-43 的一格"。**同一份账重算两遍得到同一个数，不等于同一件事** —— 后续席位照抄前请认这条路径。T2 那一档写的是 `37 → <待实测>`，那一处的 37 现在**恰好是对的**（起点没变，只是理由换了）。

`lint:deps` 必须照旧静默（`zod`/`mysql2` 是 npm 依赖，不是 `@dajia/*` 边）。

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
- Create: `apps/desktop/src/main/db/database.ts`（**本节原漏这一行**：Step 4 的代码块要新建它，Step 5 的夹具要用它建库/删库。落码时由 `brief-files-check.mjs` 普查出这一族缺陷里唯一的一条真缺陷，席位按正文落盘，见执行回填）
- Create: `apps/desktop/src/main/db/migrations/001_init.sql`（P-11 选② 之后的镜像文件，由 `scripts/db-sql.mjs` 落盘）
- Create: `apps/desktop/test/db/migrate.test.ts`
- Create: `apps/desktop/test/unit/migrations.test.ts`
- Create: `apps/desktop/test/unit/migrations-sql-mirror.test.ts`（钉住内联与镜像**逐字节**相同，双向）
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

Run: `npx vitest run --config vitest.db.config.ts apps/desktop/test/db/migrate.test.ts` → Expected: PASS（**14 条**，原文写 6 条；修棒按 P-45…P-50 补了 8 条常驻判据，见本节末执行回填）。
再跑 `npx vitest run apps/desktop/test/unit/migrations.test.ts` → Expected: PASS（**5 条**，原文写 4 条；P-49 的静态证人自加一格）。镜像档 `migrations-sql-mirror.test.ts` 另有 1 条 ⇒ 静态档合计 **6 格**。

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
npx tsc --noEmit -p apps/desktop/tsconfig.test.json; echo "typecheck exit=$?"
```

Expected（**2026-10-04 落码后按实测回填**）：`verify exit=0`，`Test Files` **37 → 39**（+`migrations.test.ts`、+`migrations-sql-mirror.test.ts`）、`Tests` **517 → 523**（+5 静态 +1 镜像，但 517 是 T1 那两步账的终点，原文写的 513 早已被 P-43 抬高）。`pnpm test:db` exit=0，**2 文件 / 17 条**（`env.test.ts` 3 + `migrate.test.ts` 14）。

> **第三发 `tsc` 保留，但它不是唯一证人**（2026-10-05 按盘上订正，见 P-63）：`pnpm verify` 的 typecheck 面**确实**吃 `apps/desktop/test/**` —— root `typecheck` 串里有 `pnpm --filter @dajia/desktop typecheck`，desktop 那一发的末尾就是 `tsc --noEmit -p tsconfig.test.json`，而那份 tsconfig 的 `include` 是整个 `test` 目录（含 `test/db`，不限 `unit`）。本计划原先那句"测试文件里的类型错只有这一发看得见"自 Task 1 的 `92240d8` 起就不成立。这一发留着只有两个理由：日志聚焦，以及不跑全量时也能单独证编译。本轮它 exit=0，后续任务的 db 档改动仍把它一起跑。

**跑完必须确认 `dajia_test` 已被 afterAll 删掉**：

```bash
node -e "const{createPool}=require('mysql2/promise');(async()=>{const p=createPool({host:process.env.DAJIA_MYSQL_HOST,port:+process.env.DAJIA_MYSQL_PORT,user:process.env.DAJIA_MYSQL_USER,password:process.env.DAJIA_MYSQL_PASSWORD});const[r]=await p.query('SHOW DATABASES');console.log(r.map(x=>Object.values(x)[0]).join(' '));await p.end();})()"
```

Expected: 输出的库名列表里**没有** `dajia_test`（也没有 `dajia` —— 它归 T11 的闸门在 `DAJIA_MYSQL_DATABASE=dajia` 时才建），且其余用户库一个不少。这一发是"自建自清"唯一的凭据，不许省。

> 实测（2026-10-04，T2 席位 + 修棒 + 变异棒共 20+ 次普查）：名单恒为 **19 个名字** = 15 个用户库 + `information_schema mysql performance_schema sys`。原文写"其余 **14** 个用户库"，那是 spec §12 当年的读数，本机现已 15（`ai_k12 babytun flowmart imooc_oa junmo ledger_db mybatis_test sleeve smartscrm smartscrm_react testdb train train_business water-drop zhixue`）—— 与搭家无关，不订正 spec。**这一发的判据是"逐名等于基线"，不是"数一下大概对"**：变异棒的须知里把它写成脚本（`t2-show-dbs.mjs`），因为"用户库少了一个"和"多了一个 `dajia`"在这句散文下都能被读成过。

```bash
git status --porcelain && git diff --cached --stat
git add apps/desktop/src/main/db apps/desktop/src/main/index.ts apps/desktop/test scripts/db-sql.mjs
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

### Task 2 执行回填（2026-10-04，落码后）

**盘上账**（提交链，代码棒与控制位交替；控制位的文档提交一律排在审查之后，免得审查包混进计划文本）：

| 提交 | 谁 | 内容 |
|---|---|---|
| `c86c82f` | T2 席位 | 六个实现/测试文件 + `001_init.sql` 镜像 + `scripts/db-sql.mjs` 真导出 + `index.ts` 注释 |
| `168939a` | T2 修棒 | 六条裁决落成常驻判据（P-45…P-50），`migrate.test.ts` 6 → 14 格、静态档 +1 格 |
| `e1e6275` | 控制位 | 复审席两笔收口（P-51 安全、P-52 假绿） |
| `ce2e94b` | 控制位 | 变异棒两条实测回灌（P-53 红相、P-54 假绿），含 `migrations.ts`/`001_init.sql` 的注释同步 |

闸门读数（控制位独占复跑，每一笔收口后各一次，全部 `exit=0`）：`pnpm verify` **39 文件 / 523 条**；`npx tsc --noEmit -p apps/desktop/tsconfig.test.json` **exit=0**（这一发只是把 typecheck 面里 `test/**` 那一块单独跑一遍、日志聚焦；`verify` 本身也编译 `test/**`，口径订正见 P-63）；`pnpm test:db` **2 文件 / 17 条**，普查行照旧 `[census] version=8.0.45 max_connections=151`。**下一棒的起点是 39 / 523 / db 2 / 17。**

**授权兑现的形态**：这一档是本计划第一次真行使「允许建 `dajia` 和 `dajia_test`」—— 实际建过的只有 `dajia_test`（`beforeAll` 建、`afterAll` 删），`dajia` **一次都没被建、没被删、也没被连过**（P-48 那一格走的是打不通的实例）。20+ 次只读普查逐名等于基线 19 名，15 个用户库一个不少。

**四处文本与盘上的不一致（本节正文已按盘上订正，代码块本身保留原样，以文件为准）**：

1. **Files 列表少三行**（`database.ts` / `migrations/001_init.sql` / `migrations-sql-mirror.test.ts`），`git add` 那一行多一个 `package.json`、少一个 `index.ts` —— 已在 Files 与 Step 8 就地订正。这一族是 `brief-files-check.mjs` 对 T1–T8 全量普查出的**唯一真缺陷**。
2. **Step 3 的 `migrate.ts` 代码块已过期**：盘上多了 `assertTargetDatabase`（P-46）与 `const target = assertDatabaseName(database)`（P-47 的顺序前提），代码块仍是 `assertDatabaseName(database);` 一句。`migrate(pool, database, migrations?)` 签名与返回类型未变 ⇒ 只影响"照着抄"的人。
3. **Step 5 的 `migrate.test.ts` 代码块已过期**：`afterEach` 由固定七名改成 `SHOW TABLES` 驱动（P-50）；原第 5 格（一个 `it` 三发 `expect`）拆成 7 格进新 describe（P-48）；拒绝型格子全部改走 `unreachableEnv`（P-51）。期望条数 6 → 14。
4. **`database.ts` 的注释与实际差一层**（**未改**，红线"不改文案"）：`dajia 走这里会被白名单挡在 SQL 之前` 说的其实是**第二道闸**，白名单本身对 `dajia` 放行 —— 建库放行 / 删库挡住这条不对称正是 P-48 对偶格的内容。建议 T3 之后任一批把文案下修成"会被第二道闸挡在 SQL 之前"。

**变异棒实跑（`task-2-mutation-report.md`；规则：`cp` 备份 + md5 还原，全程零 git 写操作、零提交）**：上表 M1–M4 全部按预期红，另跑 M9–M13（M8 未跑，理由见下）。四靶文件开局与结束 md5 逐字节相同，`git status --porcelain` 结束为空。

| # | 改坏 | 实跑 | 与推演的差 |
|---|---|---|---|
| M1 | 删校验和比对 | db 1 红 | 与推演逐字吻合 |
| M2 | `load_bearing` CASE→CAST | 静态 2 + db 1 红 | **红相升级**（P-53）：不是 `['wall',0]`，是第一条探针 INSERT 被 `ER_TRUNCATED_WRONG_VALUE(1292)` 硬拒 |
| M3 | `ensureDatabase` 删白名单闸 | db 1 红（`ECONNREFUSED`） | 拆格后第一次拿到"只删一个入口 ⇒ 只它自己红"的读数，M3 要证的"入口重复是有意的"落地 |
| M4 | `storey` 去 `IF NOT EXISTS` | 静态 2 红、**db 14 全绿** | 预期内的不对称：`afterEach` 每格清空 ⇒ 运行时永远打不到这一发。这正是静态正则存在的全部理由 |
| M8 | `INSERT` 的 `query`→`execute` | **未跑** | 审查席判"预期零红，而零红无法区分'判据没牙'与'变异没生效'"；预算转给 M9。M9 红了一格且红相精确落在预期的错误种类 ⇒ 顶替成立 |
| M9 | 删 `dropTestDatabase` 第二道闸 | db 1 红 | "代码在、判据零"翻案为有牙；并实测了 P-51 的必要性（若格子仍带可连通实例，这一发会真发 `DROP DATABASE dajia`） |
| M10 | 删 `assertTargetDatabase` 调用 | db 2 红 | **打错库静默成功真的发生了**：`migrate(pool,'dajia')` 不抛、返回成功、001 整批打进 `dajia_test`（落点全在授权库内，`afterEach` 已清） |
| M11 | 两行互换（先核对后白名单） | db 1 红（`Pool is closed.`） | P-47 按设计接住 |
| M12 | 白名单整体挪到 `readApplied()` 之后 | db 2 红，**1 格该红没红** | 见下面「该红没红」第 2 条 |
| M13 | `[\s\S]*` 还原 + `kind` STORED→VIRTUAL（两步对照跑） | 静态 2 + db 1 红，**`:23` 格收紧前后都绿** | 见下面「该红没红」第 1 条 ⇒ P-54 |

**该红没红清单（这两条是本档判据覆盖面的精确边界，T3 复用夹具时必须知情）**：

1. **P-52 的 `[^;]*` 只关得住跨语句**：001 里 `kind` 与 `load_bearing` 两张生成列之间没有 ASCII 分号，`[^;]*` 跨得过去 ⇒ 「001 建齐六张表」那一格对 `kind=VIRTUAL` 从收紧前到收紧后**一直假绿**。已由 P-54 用 `not.toMatch(/VIRTUAL/)` 关掉整型（刻意不用"数 `STORED` 个数"：002 加生成列那天它就假红）。
2. **"白名单先于第一发 SQL"这一段顺序只有 P-47 一个证人**：M12 把白名单后移后，P-46 的「声称迁 `dajia`」格断言全数仍可兑现（`readApplied` 先在正确的空库里读了个空，误称随后仍被核对闸抛下）。不是缺陷，是覆盖面比格子标题给人的印象窄 —— 与 M11 的"独苗"是同一条账。

**登记的限度（不改码，后续席位别重新猜）**：
- `migrate()` 现在每次多两发只读往返（`SELECT DATABASE()` + `SHOW TABLES LIKE`）。**没有任何格子守 `migrate` 的往返次数**（全仓无 query 计数桩）。T7 autosave 开工程时调它 ⇒ +2 RTT 可忽略；真要优化必须**带判据地**缓存，且把代价注释搬进代码。
- `unreachableEnv` 依赖"127.0.0.1:1 立即拒绝"（本机实测 2ms `ECONNREFUSED`）。进 CI/容器前应换成桩 `Pool`（`query` 一被调用就抛）—— 已知形状债。
- `afterEach` 的 `SET FOREIGN_KEY_CHECKS` 是会话级，靠 mysql2 池顺序复用同一连接才生效；若有格子并发发查询会静默失效。T3 抽共享夹具时值得写成注释。
- **001 从此冻结**：校验和在运行时按 SQL 正文现算，改一个注释就是改校验和。今天安全仅因为 `dajia` 还没被建过（`probe-db.mjs` 实测 `hasDajia:false`）；T11 之后只许加 002，且加 002 必须连镜像文件一起（`migrations-sql-mirror.test.ts` 双向比字节，多一个少一个都红）。

**给 T3 及之后每一棒的须知**：`migrate` 现在会核对"声称的库 = 连接所在的库" ⇒ 业务侧调用必须用 `createDbPool({ ...env, database })` 让两者同源；`test/db` 的格子若需要建库，走 `ensureDatabase`/`dropTestDatabase`（`dajia_test`），**不许**手写 `DROP DATABASE`；拒绝型断言一律配不可连通实例（P-51 的形状债在换桩之前继续有效）。

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
- Modify: `packages/core/src/commands/wall.ts`（**执行期追加，P-57**：模块私有 `assertWallShape` 搬进 `model/invariants.ts` 并导出，两处调用点传 `label = '该墙'`；报错文案的两个子串 `零长` / `不小于墙长` 不许丢）
- Create: `scripts/check-invariants-cycle.mjs`（**执行期追加**：扫 `model/invariants.ts` 的传递 import 闭包，出现 `commands/**` 即 exit 1 —— P-57 搬迁之后"读盘门不回指命令层"这条主张的常驻证人）
- Modify: `packages/scene-2d/test/editing.test.ts`（**执行期追加，R2-2**：一处注释指针跟着 `assertWallShape` 的新产地改；断言一字未动）

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

  // 执行期订正（P-55）：这一格的上层必须显式给 `index = 1`。原文用 `storeyAt` 的默认 `index = 0`
  // 造两层 ⇒ 两层同为 index 0 ⇒ 下一格的「index 重复」会抢先抛，这一格永远红；而下一格吃的是
  // 逐字节相同的文档。缺陷在夹具不在实现，三条断言与格数一字未动。
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

  it('storey.ts 走共享判据：import 行按行首锚定钉死，且同一行内没有第二份区间判定', () => {
    const src = readFileSync(new URL('../src/commands/storey.ts', import.meta.url), 'utf8');
    // 执行期换牙（P-56）：原文是 `expect(src).toContain("from '../model/invariants'")`，
    // 那是**子串判据** —— 把 import 删掉、只在注释里留下这句话，照样绿（复审席实测复现）。
    // 锚定形态允许花括号里有别的名字、允许换行、不吃行尾分号，但拒绝裸子串。
    expect(src).toMatch(/^import\s*\{[^}]*\bassertNoVerticalOverlap\b[^}]*\}\s*from '\.\.\/model\/invariants'/m);
    // 限度（登记）：`.*` 是同一行内的贪心匹配 —— 第二份规则若漂成两行写法，这一发拿不到读数。
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
 *
 * 这一道门自己覆盖（**执行期订正，P-60**：原句"几何退化…不在这里重算"是谎，见 C1）：
 * 引用解析与同层、index 唯一 + 非负安全整数、≥1 的字段、`-0`、零长墙与墙厚不小于墙长
 * （`assertWallShape`，与命令层同一产地 = P-57）、洞口负 distance / 负 sill / 门洞 sill≠0 /
 * 洞顶超过宿主墙高（P-58）、同层同坐标幽灵柱与同一枚落点重复的柱（P-59）、楼板环简单。
 * 归最后一遍逐层 `deriveStoreyGeometry`（派生层是那些判据的唯一产地，这里不重算）：
 * 接头不闭合、轮廓翻面、同向重叠、星形接头、洞口沿轴区间重叠（`assertSpansFit`）。
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

  // 最后一道：把派生层跑一遍。这一遍**复用**的是派生层真有、这里刻意不重算的那五件（接头不闭合、
  // 轮廓翻面、同向重叠、星形接头、洞口沿轴区间重叠）。**执行期订正（P-60）**：零长与厚 ≥ 墙长、
  // 洞顶超墙高、幽灵柱**不在这一遍里** —— 派生层看不见它们（`geom/outline.ts` 的清单只有四件；
  // `commands/opening.ts` 顶部自己就把"洞顶 ≤ 宿主墙高"列为派生抓不到的一条），所以由上面几个循环
  // 显式拦。把这一遍摘掉，红的是「洞口宽 5000 装在 4000 长的宿主墙上」那一格，不是别的。
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

Expected: `verify exit=0`；`Test Files` **39 → 42**（+2 protocol / +1 core），`Tests` **523 → 560**（本任务 **+37** 条：席位 22 + 修复轮 14 + R2-1 那一发落点格 1）。
既有 `commands-column-slab.test.ts`（**执行期订正**：原文写的 `commands/storey.test.ts` 这个文件不存在，楼层那几发住在 `commands-column-slab.test.ts`）与 `storey` 相关用例**一条都不许改** —— 它们跟着搬迁走。搬迁后的实测形状：`/标高重叠/` 在盘上是**两发断言 + 一个格标题**（原文"那三发"是超写：标题那一发断的正是"不抛"）。

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
| T3-M1 | `PointSchema` 的 `z.strictObject` → `z.object` | 「多余字段被拒」那一格当场红 —— **执行期订正**：那一格只有**第一条** `toBe(false)` 会变 true（`{…POINT_OK, pointId: undefined}` 在 `strict()` 下被拒、放宽即收）；第二条打的是 `WallSchema` 的 `lengthMm`，与本变异无关。原文"两条变 true"是超写 |
| T3-M2 | `UUID_V7_TEXT` 里 `7[0-9a-f]{3}` → `[0-9a-f]{4}` | 「V7 正则逐字符相同」红。这一格是"两份文本"这条纪律唯一的凭据 |
| T3-M3 | `PointSchema` 的 `x: MmSchema` → `x: z.number()` | 「填 1.5 与 -0 都被拒」那一格红（行为循环，不是文本对账 —— 两型各管一头） |
| T3-M4 | `INTEGER_FIELDS` 的 `point: ['x', 'y']` → `point: ['y']` | 「core 表 ↔ 本表」对账红（`toEqual` 逐字） |
| T3-M5 | `invariants.ts` 的 `assertAtLeastOne` 下界 `v < 1` → `v < 0` | 「尺寸下界」那一格红 —— 这一发证明那条循环表真在逐字段判 |
| T3-M6 | 把 `commands/storey.ts` 里那份私有规则原样抄回去（留着 import） | 「不许留第二份规则」那格红（`elevationMm + .*heightMm` 命中数 > 0）。**这一型只有静态账能抓**：两份实现行为相同，任何行为用例都过。执行期实测：抄回后命中数 **3**（`git show f5a4dde` 那份），搬迁后为 **0**。同一格的存在理由被 P-56 换过一次牙（`toContain` → 行首锚定 `toMatch`），因为原形状连"import 真在"都没证到 |
| T3-M7 | 删掉 `invariants.ts` 末尾那句逐层 `deriveStoreyGeometry` | **执行期整行作废重写**（原预测错了两次）：① 摘掉那一遍，红的是「洞口宽 5000 装在 4000 长的宿主墙上 ⇒ 只有末尾那遍拦得住」那一格（`/超出宿主墙/` 只来自 `assertSpansFit`，洞口循环的五条都不响）；② 原文预测的"墙厚不小于墙长那一型变盲区"**在当时确实成立、但对本行声称的判据没有任何证人** —— `BELOW_ONE` 表里（连 brief 自带代码一起）不存在"过了下界但派生炸"的样本，而审查席探针 [A]/[B] 实测厚 ≥ 长的墙**派生层也看不见**。P-57 把那条判据搬进读盘门之后，这一格的名分回到它真证的事：沿轴区间重叠 |


### Task 3 执行回填（2026-10-05，落码后）

#### 提交链与格子数

| 提交 | 作者 | 内容 | 文件 / 行数 | `verify` 格子数 |
|---|---|---|---|---|
| `f5a4dde` | 控制位 | Task 2 执行回填（**BASE**：T3 的审查包从这一发起算） | docs | 39 / 523 |
| `15c759b` | T3 席位 | `entity-schema.ts` / `command-type.ts` / `invariants.ts` 三件新源码 + 三份测试 + 两处 export | 10 文件 / +662 −22 | 42 / **545**（+22 格：protocol 7+2、core 13） |
| `9ca9c70` | T3 修复席 round 1 | C1 三条守卫进读盘门 + `assertWallShape` 搬迁 + I1 八条零证人 + I2 行为探针 + I4 + P-56 换牙 + m4/m6/m8 | 5 文件 / +345 −28（新增 `scripts/check-invariants-cycle.mjs`） | 42 / **559**（+14 格：core +9、protocol +5） |
| `2bd9f66` | T3 修复席 round 2 | R2-1 同一枚落点只准一根柱 + R2-2 陈旧注释指针 | 3 文件（`invariants.ts` / `invariants.test.ts` / `editing.test.ts` 一行注释） | 42 / **560**（+1 格） |

#### 闸门读数（全部控制位亲测，不采信席位的日志）

```
pnpm verify                                exit=0  Test Files 42 passed / Tests 560 passed
node scripts/check-package-deps.mjs        exit=0  依赖方向检查通过
node scripts/check-invariants-cycle.mjs    exit=0  model/invariants 的 import 闭包不碰 commands/**
pnpm test:db                               exit=0  Test Files 2 passed / Tests 17 passed
                                                    [census] version=8.0.45 max_connections=151
只读普查（收口时）                          19 个库名，逐名等于 Task 2 的基线；dajia / dajia_test 均不存在
```

`it()` 逐档点数：`invariants.test.ts` 22 + `entity-schema.test.ts` 12 + `command-type.test.ts` 2 = **36**，全仓 `it.skip` / `it.todo` / `it.only` 于本任务靶面 **0 命中**。545 → 559 → 560 与格子点数严格吻合（+14 = 9 core + 5 protocol，+1 = R2-1 落点格）。

#### 授权形态

Task 3 的靶面**全在 `packages/{core,protocol}/**` 与 `scripts/`**，**MySQL 零接触** —— 上面那两发连库读数与普查是控制位为"改完读盘门之后地板仍然完整"而跑的，不是本任务的判据。建库授权（M1.3）自 Task 2 起持续有效，本轮没有动用。

#### 审查发现的处置（一轮审查 + 两轮修复 + 一次范围收窄复审）

审查席判 **A spec PASS / B PASS WITH CHANGES**（Critical 1 = C1，Important 5 = I1…I5，Minor 11），复审席终判 **ADDRESSED / Critical 0 / Important 0 / Minor 3**。

- **C1 → P-57 + P-58 + P-59 + P-60**：三条"派生层看不见"的判据全部搬进读盘门，两处过度承诺的 doc block 改成说实话的两栏清单。
- **I1 → 8 条零证人分支全部有牙**（每型都跑过"摘掉对应判据 ⇒ 只有对应那一发红"的双向分账）。
- **I2 → P-61**：行为探针替代源码扫描；"必收"半发是同轮新增的形状，防过严实现把整格测成假绿。
- **I3 → 不在 T3 射程，转为 Task 4 前置条件**（`PatchSchema` ↔ `core.Patch` 是第五份文本、今天零对账格；`PatchSchema` 唯一的消费者就是 T4 的落库单位）。
- **I4 → 已补两半**（收 `0` / `7`，拒 `1.5` / `-1` / `2**53` / `NaN` / `Infinity` / `"7"`），**消费者仍为零** —— 格子只是幂等键的合同钉，真正的读者随 T4 的 journal 编解码出现。
- **I5 → P-56**；**m4 → P-62 之一**；**m6 / m8** 已就地做掉。
- 登记为**限度、不改码**：m1（zod 版本形态，见 P-61 代价栏）、m2、m3、m5（`deriveStoreyGeometry` 每次重跑全局 `deriveJoints` ⇒ O(storeys × all-walls)，归 T5）、m9（`commands/storey.ts` 那句"S1 不许出现零层项目"与 `invariants.ts` 的"零层文档合法"是命令规则 vs 数据规则，文案过写、不改）、m10（`check-package-deps.mjs` 只 grep `@dajia/*`，看不见**相对**跨包 import —— 本任务把"protocol 测试按路径读 core 源码"制度化，这道墙只画在包名那一侧）、m11（brief 自带的计数滑点：「六枚 id」实为五枚、`ID.*` 的"十枚串"实为十二枚、`commands/storey.test.ts` 不存在）。

#### 文本与盘上的订正位（本处就地改，代码为准）

1. 裁决表标题与 `> 编号从 P-40 起` 那段：**P-18…P-39 只有 6 个号真被写过**（P-18/P-19/P-20/P-21 在 Task 8，P-27/P-33 在 Task 9），**16 个是空号** —— 原文"随那两个任务的回写并进本表"是超写，改为"回写时就地补表、理由不复制"。
2. Task 3 Files 列表补三项（`commands/wall.ts` 搬迁、`scripts/check-invariants-cycle.mjs`、`scene-2d/test/editing.test.ts` 注释指针）。
3. Step 4「竖向重叠」那格上方补 P-55 的夹具订正说明（盘上多三行 `index = 1`）。
4. `invariants.ts` 函数头与末尾派生注释两块代码文本按落地的实话重写（P-60）—— 这两块是计划文本里唯一"教席位怎么写注释"的地方，留着谎就会长回盘上。
5. Step 4 的 P-56 那一格整块替换为落地形状（锚定 `toMatch` + 限度注释），并写明**作废**"0 命中已经要求 import 真在"那条论证。
6. Step 6 期望数：`37 → 40 / 513 → <待实测> / +22` 改成 `39 → 42 / 523 → 560 / +37`；`commands/storey.test.ts` 改成 `commands-column-slab.test.ts`；"那三发 `/标高重叠/`"改成"两发断言 + 一个格标题"。
7. 变异表 **T3-M1** 与 **T3-M7** 两行按实测重写（M1 只红第一条 `toBe(false)`；M7 的预测错了两次，"厚 ≥ 长"那一型当时**派生层与读盘门双双看不见**，P-57 之后才成立）。**T3-M6** 补命中数 3 → 0 的实测与换牙记录。

#### 变异实跑（判据有牙的凭据，三席各自跑）

- 修复席 round 1（`cp` 备份 + md5 还原，未用 git）：core 侧**同摘 12 发** ⇒ `9 failed | 13 passed`（红的恰是 9 发新格）；protocol 侧**逐枚削弱 5 发** ⇒ `5 failed | 7 passed`（红的恰是 5 发新格）。
- 修复席 round 2：① 摘新落点判据 ⇒ 只红新格，且红相是 `没抛：这一格要求检查器抛`（**静默放行实锤**）；② 摘 `assertNoGhostColumn` ⇒ 只红旧幽灵柱格（`invariants.test.ts:234`）。两向分账成立。
- 复审席自跑 5 发（不采信上两位的读数）：落点判据、墙循环 `assertWallShape`、`ColumnSchema.pointId → z.string()`、"删 import 只留注释句"那一型（**旧 `toContain` 假绿复现、新锚定独红**）、`assertNoGhostColumn` —— **全有牙，零"该红没红"**。
- 审查席的只读探针（`tmp/review-t3-probe.log`）在 P-57/P-58/P-59 之后逐一复查：[A] 厚 5000/长 4000、[B] 厚 = 长、[C] 同点双柱、[E] 洞高 99999、[F] `200 + 2900` 超墙顶 —— 五型**全部改为当场抛**；[D] 洞口沿轴重叠仍由 `assertSpansFit` 接住（派生那一遍挣到了它的钱，也只需要它挣这一件事）。

#### 登记的限度（改码不划算，改判据不许）

1. 读盘门**不是**写盘门的超集，也不打算做成：P-58 那条不对称是刻意的（写盘侧并入已有洞口之后更严），两侧文案两族。
2. 源码扫描那一族（P-56、`check-package-deps` 的相对 import 盲区 m10）永远可能被**刻意写进注释的文本**骗过；换牙只是把"无意的漂"与"刻意的骗"分开。
3. `geom/outline.ts:112-116` 的四件清单与 `invariants.ts` 的门内清单是**两份合同**，靠人工两向核对同步（复审席已把这一问固定进射程）。
4. R2-1 之后仍有一型未关：同一枚点上两柱**其中一根来自别的 `projectId`** —— 落点键含 `storeyId`，跨工程不可能同层，判据不必为它加长。
5. `check-invariants-cycle.mjs` 证的是 import 闭包无环，**不证**运行时初始化顺序；本轮 `INTEGER_FIELDS` / `deriveStoreyGeometry` 都只在函数体内取用，这一点由 typecheck + 全量 560 格的全绿复跑支撑，不由脚本支撑。

#### 给 T4 及之后每一棒的须知（复审席第五节，控制位照收）

1. **解码必须落 JS number**：`mm()` 的 `typeof` 守卫现在是合同，字符串形态的毫米值会被点名拒掉（`<kind> <id>.<field> 必须是数字毫米，收到 …`）。编解码侧不许把 BIGINT 的字符串回值直接喂进实体。
2. **往返哨兵**：T4 的 codec 往返格要带一发"厚 / 长 / 洞顶"三样的哨兵文档（P-57/P-58 的三份文案各红一次才算真跑到了读盘门）。
3. **I3 前置**：`PatchSchema` ↔ `core.Patch` 的对账格**归 T4 建**（`readFileSync('../../core/src/model/patch.ts')` + 键集合格），别让它继续做第五份无人核对的文本。
4. **`JournalTurnSchema` 的第一个消费者在 T4**：那一格幂等键的合同钉今天零读者，T4 落地 journal 写入之后要让它红得起来（`turn` 传字符串 / 负数 / `2**53` 三型）。
5. **禁止 catch-all 静默跳过闸门**：读盘门的抛是 `RangeError` / `TypeError` 两族，重放路径不许写 `catch { /* 脏数据跳过 */ }`。

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

Expected: `exit=0`。**然后当场证一次它能红**（M6，做完立刻 `cp` 还原 + md5 核对）：把 `packages/protocol/src/entity-schema.ts` 里 `OpeningSchema` 的 `category: z.enum(['door', 'window'])` 改成 `category: z.string()`，重跑上面这条 `tsc` ⇒ 必须 `exit=1` 且报在 `entity-shape.test.ts` 与 `codec.ts`；同时 `npx vitest run apps/desktop/test/unit/codec.test.ts apps/desktop/test/unit/entity-shape.test.ts` 必须**照旧全绿** —— 那才是"枚举漂移在 vitest 层不可见"的证人。**两处订正（2026-10-05 实测，见 P-63 与执行回填第 5 条）**：① 原文还要求 `packages/protocol/test/entity-schema.test.ts` "照旧全绿"，实测**两格红**（`:147` 只认 door/window、`:189` 的行为探针），因为 P-61 给 protocol 补的正是行为探针；② "只有编译期看得见"里的"只有"不再指那发独立 `tsc` —— `verify` 的 typecheck 面里就有它。修正后的主张：**这一型只有编译期 + protocol 行为探针看得见**。实测报点是 `codec.ts(48,56,88)` 与 `entity-shape.test.ts(94)`。两组读数写进执行回填。

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
| T4-M6 | `OpeningSchema.category` 的 `z.enum(['door','window'])` → `z.string()` | **实测三处同红 / 一处绿**（2026-10-05）：`tsc -p tsconfig.test.json` exit=1，报在 `codec.ts(48,56,88)` + `entity-shape.test.ts(94)`；`packages/protocol/test/entity-schema.test.ts` **两格红**（`:147` / `:189`，P-61 的行为探针）；`pnpm verify` 跟着红（它的 typecheck 面里就有那发 tsc，P-63）；只有 desktop 侧 runtime 16 格**全绿** ⇒ "枚举漂移在 vitest 层不可见"这一半成立。**原文两处不准**：① "Task 3 的用例全绿"（protocol 档会红，见回填第 5 条）；② "只有 `tsc` 看得见"（"只有"的是编译期这一**层**，不是那**一发**）。Step 4 那一档仍是全部理由 —— 没有它，这一型在 runtime 确实无人值守 |
| T4-M7 | `asJsonValue` 删掉 `typeof raw === 'string'` 那一支 | **实测 9 格红**（`codec.test.ts`：直接格 `asJsonValue('{"a":1}')` + 三发从字符串解的 `canonical()` 往返 + 第 13 格往返哨兵，exit=1）⇒ **有牙**，不是限度（P-67）。原文"若 A 档 = `object` 则没有任何用例变红"把**连库读路径**（A 档实测 = `object`）与**纯文本 unit 路径**（`codec.test.ts` 全程喂 string）混为一谈。那一支照旧不许为"保持精简"删掉 —— 现在它有一整档用例守着，删了会听见 |
| T4-M8 | `encodeDocument` 去掉 `.sort(byId)` | 「entities 按 id 升序」那一格红。注意 `canonical()` 自己排序，所以"往返逐字节相同"**不会**红 —— 这就是第 9 格要单独钉形状的原因 |
| T4-M9 | `decodeDocument` 的重复 id 检查删掉 | 「同一 id 出现两次 ⇒ 抛」红：`Map.set` 静默取后者，`decode` 不抛且 `entities.size` 变小 |
| T4-M10 | `writeSnapshot` 的裸 `INSERT` 换成 `... AS new ON DUPLICATE KEY UPDATE payload = new.payload` | 「同一 turn 两份快照 ⇒ 抛」红（拿不到抛）。这一发就是 P-16 选型的凭据 |
| T4-M11 | `remove` 分支的 `affectedRows !== 1` guard 删掉 | 「remove 撞空行」那一格红：手工抹掉的那一行删 0 行也不抛，turn 3 顺利落账 |
| T4-M12 | 把楼层归属预检从 `getConnection` 之前挪到投影那一趟（回到"先写 element 再抛"） | 「楼层实体属于别的工程」红在 `count('element')` —— 这一格判的就是**位置**，不是"抛没抛" |
| T4-M13 | `repository.test.ts` 里把 `SELECT DATABASE()` 的期望值从 `'dajia_test'` 改成 `'dajia'` | 当场红 —— 证明这一格真在读连接指向的库。**反向那一发（把 `createDbPool({ ...env, database: DATABASE })` 改回 `createDbPool(env)`）本计划禁止真跑**：`migrate` 的 `CREATE TABLE` 不带库限定，跟着连接的默认库走 ⇒ 会把表建进 `dajia`（那正是这条守卫存在的理由） |
| T4-M14 | `clearAll()` 改成只 `DELETE FROM \`element\``（不清 project） | 「project 行落账」或「同一个 id 建两次」红：跨用例的状态泄漏就是"上一发用例替下一发铺好数据"那种查不清的红。这一发证明 `beforeEach` 真在守事 |


### Task 4 执行回填（2026-10-05，落码后）

#### 提交链与格子数

| 提交 | 作者 | 内容 | 文件 / 行数 | `verify` 格子数 |
|---|---|---|---|---|
| `fd9d2c0` | 控制位 | Task 3 执行回填（**BASE**：T4 的审查包从这一发起算） | docs | 42 / 560 |
| `fe2ecf3` | T4 席位 | `codec.ts` / `repository.ts` / `pool.ts` 两条配置 / `entity-schema.ts` 三出口 + 三份测试 | 7 文件 / +1262 −1 | 44 / **576**（+2 文件：`codec.test.ts` 13 格、`entity-shape.test.ts` 3 格） |

单发提交、信息逐字对 brief Step 9，且 body 里自己记了三处"brief 与盘上冲突以代码为准"（夹具池 `multipleStatements`、`updated_seq` 真形状、楼层归属正则去空格）与 `pool.on('connection')` 那颗地雷的修法。`it()` 逐档点数：`codec.test.ts` 13 + `entity-shape.test.ts` 3 = **16** ⇒ 560 + 16 = 576 严格吻合；`repository.test.ts` 20 格全在 db 档 ⇒ 17 + 20 = **37** 同样吻合。靶面无 `it.skip` / `it.todo` / `it.only`。

#### 闸门读数（全部控制位亲测，不采信席位的日志）

```
pnpm verify                                exit=0  Test Files 44 passed / Tests 576 passed
pnpm test:db                               exit=0  Test Files 3 passed / Tests 37 passed
                                                    env 3 + migrate 14 + repository 20
                                                    [census] version=8.0.45 max_connections=151
                                                    [t4] snapshot payload typeof = object
npx tsc --noEmit -p apps/desktop/tsconfig.test.json
                                           exit=0
node scripts/check-package-deps.mjs        exit=0  依赖方向检查通过
node scripts/check-invariants-cycle.mjs    exit=0  model/invariants 的 import 闭包不碰 commands/**
只读普查（收口时）                          19 个库名，逐名等于 Task 2 的基线；dajia 一次未建、未连、未删
```

**下一棒的起点是 44 / 576 / db 3 / 37。**

审查席自己另跑了一遍同一组闸门（`verify` 44 / 576、db 3 / 37、tsc 0、deps 0、连库前后各一发普查共 5 次读数全等于 19 名），与控制位读数逐条一致；`leak-check.mjs` scanned=325 / unreadable=0，**唯一命中仍是 `docs/.../dajia-s1-design.md`**（即 spec §12 记凭据的那份原文本身），T4 改动的 7 个文件与 `tmp/*.log` **零命中**。全程没有把口令敲进任何命令行、代码、日志或提交。

#### 六处文本与盘上的不一致（本节正文已按盘上订正，代码块保留原样、以文件为准）

1. **Step 6 夹具池缺 `multipleStatements`** ⇒ 迁移那趟多语句脚本 1064、`repository.test.ts` 整档 20 格 skip。补的是夹具的**迁池**，业务池保持单语句（→ **P-65**）。
2. **`updated_seq` 的期望 `DISTINCT=1` / `count(seq2)=4` 与同一节 Step 7 自己写的逐实体 `patch.upsert` 矛盾** ⇒ 钉成真形状 `DISTINCT=2` / `seq1`→1 行 / `seq2`→3 行 / 合计 4（→ **P-64**）。
3. **楼层归属正则多一个空格**：生产文案是 `${what}属于工程`（`repository.ts:34`，"属于"前无空格），Step 6 的 `/楼层 \S+ 属于工程/` 抓不到 ⇒ 落地 `/楼层 \S+属于工程/`（`repository.test.ts:354`），"楼层 + id + 属于工程"三段同现的强度不变。文档级正则那个空格本来就有，未动。
4. **Step 8 的计数预估（42 文件）与盘上差两档**：T3 的基线本身已高于 brief 写作时的假设，加上控制位前置条件追加的两格（`codec.test.ts` 第 13 格往返哨兵、`entity-shape.test.ts` 第 3 格 I3 源文本对账）。以盘上 **44 / 576** 为准，没回头动判据凑数。
5. **brief 的 M6 预检要求 `packages/protocol/test/entity-schema.test.ts` "照旧全绿"—— 不成立**：实测 `category: z.enum` → `z.string` 让那一档**两格红**（`:147` 只认 door/window、`:189` P-61 补的行为探针）。成立的是另一半：desktop 侧 runtime 16 格全绿 ⇒ **枚举漂移在 vitest 层不可见**；编译侧 `tsc -p tsconfig.test.json` exit=1，精准报在 `codec.ts(48,56,88)` 与 `entity-shape.test.ts(94)`。修正后的主张是"只有**编译期 + protocol 行为探针**看得见"。
6. **`M7` 从"已知限度"改判为"有牙"**：删 `asJsonValue` 的 string 支实测 9 格红（→ **P-67**）。同时撤回"M6 只有第三发 `tsc` 看得见"里的"只有"—— `verify` 的 typecheck 面自 Task 1 的 `92240d8` 起就在编译 `test/**`（→ **P-63**，六处文本已就地改口）。

#### Step 1 四件实测事实的落点

- JSON 列读回是 **`object`**（不是 string）⇒ `codec.ts:23` 的 `asJsonValue` 主路按 object 写，`:24` 的 string 支是兜底，兜底那一支现在有 9 格站着（P-67）。
- MySQL 把存进去的 **`-0` 归一成 `0`** ⇒ `-0` 的判据只能住在 `codec.test.ts` 的纯文本格，不经库（库那头测不出来，服务端已经吃掉了符号）。
- **MySQL 重排 JSON 对象键序** ⇒ 全计划的"逐字节相同"一律是 **`canonical()` 相同**；`codec.ts:64` 的注释与 `codec.test.ts` 第 2/3 格、`writeSnapshot` 那一格都按这条口径写，谁把它写成"和盘上字节比"就是假判据。
- `LONGLONG` 越 `2^53`：`supportBigNumbers` 关 ⇒ 静默失精成 `number`（`9007199254740993` → `…992`）；开 ⇒ 回精确 `string`。盘上取 `pool.ts:47-48` 的 `supportBigNumbers: true` + `bigNumberStrings: false`（P-17）。

#### 审查发现的处置（一轮审查，无修复轮）

审查席判 **A spec PASS / B PASS WITH CHANGES**（Critical 0 / Important 1 / Minor 3），四笔席位争议**全部同意**（更贴真相，非削判据）：夹具池补 `multipleStatements`、`updated_seq` 钉真值、正则去空格、"protocol 照旧全绿"据实订正。

- **Important（M7 的账记错）→ P-67**：纯纠偏，源码零改动。
- **Minor（"verify 不编译 `test/**`"过期）→ P-63**：那句话挂在 P-1 的代价栏名下（Task 2 Step 6 原文写"P-1 打开跨包 import 口子时登记的连带"），而 **P-1 本体并没有这条主张** —— 它是从"三处要跟着动"里长出来的推论。已订正到派发词与计划文本两侧。
- **Minor（BIGINT → string → zod 抛只到注释）→ 本节限度第 2 条**，接线归 T5。
- 审查席额外自证的两件事（不算 finding，是判据凭据）：① 一支**自设计的破坏形状探针**走盘上真实 `ProjectRepository` / `createDbPool`，实测外部行锁掐断后 `command_log WHERE turn=3` = 0、**已写下去的 `element` 行被回滚 = 0**、`storey` = 1，释放后同 turn 重发成功 ⇒ brief ② 的"半途掐断全无账"是活体证据而不是纸面断言；② `I3` 源文本对账格逐条静态解剖（`[^}]*` 只截接口体、`^[ \t]*readonly…:` 行首锚定带 `m` 无 `s`、两侧硬编码 `['remove','upsert']` + 交叉相等）⇒ **真对账，非 `toContain`**，P-56 那一族的教训在这一格落到了地上。
- 写侧不跑 `assertTruthSourceInvariants`（`repository.ts` / `codec.ts` grep 零命中）⇒ brief ③ 守住；唯一的 `catch {}` 是 `repository.ts:174-179` 回滚吞二次错（brief ②/④ 明许、M4 背书），真因照旧 rethrow。

#### 登记的限度（改码不划算，改判据不许）

1. **`SET SESSION innodb_lock_wait_timeout` 的生效性没有常驻读数证人** —— 审查席那次 `@@innodb_lock_wait_timeout = 1` 是已撤的自证探针，盘上只留 `pool.ts:20-23,71` 两段注释。漂了的形状不是假绿，是那一发慢到默认 50 秒、红在 60 秒 `testTimeout` 上（症状从"快失败"变成"像挂死"）。T6 补位（P-66 代价栏）。
2. **"BIGINT 越界 → string → 喂进 zod 抛"只有 `pool.ts:43-44` 的注释背书**：T4 不把 BIGINT 列读回 codec，`codec.test.ts` 第 5 格那枚 `9007199254740993` 钉的是安全整数**上界**拒绝（JS 里已失精为 `number`），不是 string 类型拒绝 ⇒ 接线在 T5 的 `loadProject`。
3. **`codec` 的拒绝文案偏粗**：第 4/5/6/11 格只 `/解不出实体/`，不点名漂在哪字段。不是零判据 —— "必收"那半发由第 1 格八实体正向往返 + 第 2/3 格 `canonical()` + 第 13 格哨兵兜住（"过严实现拒一切"当场红），欠的只是诊断粒度。
4. **`'同一 turn 重发'` 格的 `toEqual(before)` 只比 `{id, updated_seq}` 不比 payload**（`repository.test.ts:259-`）⇒ "用相同数据重刷同一 turn"不红，但那行为本身幂等无害；这一格靠**返回值** `already-applied` 有牙（M2 摘掉 `<=` 就红），不靠 payload。
5. **T4-M3 的后半仍未关**："把 `storey` 投影挪到 `commit()` 之后"这一型本任务抓不到（失败路径走不到那一发），处置是 T5 的 `closeProject()` 逐行对账 —— 这是计划里**故意留给下一棒的读者**，不是漏网。

#### 给 T5 及之后每一棒的须知

1. **口径改了**（P-63）：派发词里不再写"`pnpm verify` 不吃 `apps/desktop/test/**`"。单跑 `npx tsc -p apps/desktop/tsconfig.test.json` 仍然保留，理由只剩"日志聚焦 + 不跑全量"。
2. **落盘 turn 集恒等于连续区间 `{1..journal_turn}`，且 `count(command_log) == journal_turn`**（跳号 guard + 全事务原子性；半途失败的 turn 既不涨计数器也不留行 —— 审查席探针实证）。`loadProject` 可以放心把 `journal_turn` 当"文档停在哪"的唯一坐标。
3. **`element.updated_seq` = 最后碰这一行的 `command_log.seq`**（P-64 钉住的语义），BIGINT 列在 `supportBigNumbers` 下 2^53 内回 `number`；`command_log` 带 `(seq, turn, actor, payload=patch)` 且 `uk_project_turn` 保证 turn 唯一；`writeSnapshot` 是**裸 INSERT**（P-16）。三方对账（快照 + 重放 ↔ `element` 投影 ↔ `storey` 投影）有唯一收敛依据。
4. **两件 T4 故意留的读者归 T5**：① `closeProject()` 做 `element`↔`storey` 逐行对账；② 把 `updated_seq` JOIN 回 `command_log.turn`，并对 BIGINT 读数做 `Number()`（越界 → string → zod 抛那一发的接线在这里，不在 T4）。
5. **夹具池 / 业务池的分工照抄 T4**（P-65）：多语句只给迁池。别为了让测试好写把业务池改成 `multipleStatements: true`。
6. **`storeyAt` 类夹具的 `index` 唯一性**（P-55 的连带）：同一 `projectId` 下楼层 `index` 必须唯一，多层夹具记得显式给 `index = 1 / 2`，否则红在"index 重复"而不是你想证的那件事。
7. **测试配方先测可达性**（P-62 的连带）：控制位给的配方落地前先跑一发，走不通就回报并订正，不许削判据、不许按文本盲抄。

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
Expected: `exit=0`。（这一发**不是唯一证人**：`verify` 的 typecheck 面同样编译 `test/**`，口径见 P-63。单跑它的理由是本任务两个测试文件里全是编译期主张，日志聚焦且不跑全量 —— T4 的 M6 实测报在 `codec.ts` 与 `entity-shape.test.ts`，正是这一型。）

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

## Task 8: IPC 契约与会话接线（`persist-schema.ts` + `session.ts` + `ipc-persist.ts` + `projectStore.ts`）

**Files:**
- Modify: `packages/protocol/src/ipc.ts`（`IPC` 从 1 条到 **5 条**：`ping` 一字不动，新增 4 条持久化通道）
- Modify: `packages/protocol/src/entity-schema.ts`（**只把 T4 那个模块私有的 `issueText` 改成导出**，其余一个字不动 —— 理由见第 ③ 段）
- Create: `packages/protocol/src/persist-schema.ts`
- Modify: `packages/protocol/src/index.ts`（把 `persist-schema` 的出口并进去，写法照盘上现物）
- Create: `packages/protocol/test/persist-schema.test.ts`（**10 格**）
- Create: `apps/desktop/src/shared/document-wire.ts`（第 ② 段：为什么是"第三个目录"）
- Modify: `apps/desktop/src/main/db/codec.ts`（`encodeDocument` / `decodeDocument` 改成委托，P-19）
- Modify: `apps/desktop/tsconfig.json`（`include` 加 `"src/shared"`）
- Create: `apps/desktop/test/unit/document-wire.test.ts`（**7 格**）
- Create: `apps/desktop/src/main/persist/session.ts`（编排，electron-free / fs-free）
- Create: `apps/desktop/test/unit/fake-timer.ts`（把 T7 内联在 `autosave.test.ts` 里的 `FakeTimer` 与 `tick()` 搬进来：假钟现在有两个读者，复制第二份的话"到点顺序"这件事会有两个答案）
- Modify: `apps/desktop/test/unit/autosave.test.ts`（删掉那段内联假钟、改成 `import { FakeTimer, tick } from './fake-timer'`；**24 格与判据一字不动**，搬完之后原样复跑）
- Create: `apps/desktop/test/unit/session.test.ts`（**16 格**，全假把式）
- Create: `apps/desktop/src/main/ipc-persist.ts`（**本任务唯一新增的、许 import `electron` 的 main 文件**）
- Modify: `apps/desktop/src/main/index.ts`（`createWindow` 里加两行：import + `registerPersistIpc(win)`；五段分支与判据一字不动。另在 `runPropShot` 的「15) 终态」之后加一发**零节点 DOM 探针**（Step 7 ②），并往 `extras` 补一行收据 `bannerNodesAtPropGate` —— `expectedChecksByMode.prop` 那个 30 一个字不动）
- Modify: `apps/desktop/src/main/persist/emergency.ts`（加 `listEmergency`，第 ⑤ 段：T7 那句"恢复侧（T8/T9）读同一个名字"的读者就在这里）
- Modify: `apps/desktop/test/unit/emergency.test.ts`（**+2 格**：`listEmergency` 的正反两型）
- Modify: `apps/desktop/test/unit/persist-boundary.test.ts`（**+3 格**，见 Step 4）
- Create: `apps/desktop/test/unit/ipc-channels.test.ts`（**3 格**：preload 与 main 的源码扫通道名单）
- Modify: `apps/desktop/src/preload/index.ts`（`DajiaApi` 从 1 个方法扩到 3 方法 + 1 事件订阅）
- Modify: `apps/desktop/src/renderer/src/stores/editorStore.ts`（加 `loadProject` / `setReadOnly` / `readOnly` 一格 + **四处**只读闸门（`dispatch` / `dispatchBatch` / `undo` / `redo`）+ **裁决 P-21** 的 `dispatchBatch` 改判：每应用一条扳一次 `revision`；**初始态与既有 action 的语义一字不动**，见 Step 6 ② 段）
- Create: `apps/desktop/src/renderer/src/stores/projectStore.ts`
- Modify: `apps/desktop/src/renderer/src/PlanCanvas.tsx`（**只有** `fit` 那个 useEffect 的依赖表加 `log` 一项 + 把那段注释补一节：`reopenAsEdit()` 之后视口要跟着换手重算，见 Step 6 ③ 段）
- Modify: `apps/desktop/src/renderer/src/App.tsx`（横幅：**默认 `banner === null` ⇒ 一个 DOM 节点都不多渲染**；那块 `declare global` **不在这里改可选**，而是整块搬进 `projectStore.ts` —— 理由见 Step 6 ④ 段开头）
- Create: `apps/desktop/test/unit/editor-fixtures.ts`（`DEMO` 基准 + `resetEditor()` + `oneStoreyDoc()`：两份测试共用的夹具，写在里面而不是各写一份，见 Step 6 ⑤ 段）
- Create: `apps/desktop/test/unit/editor-store.test.ts`（**9 格**）
- Create: `apps/desktop/test/unit/project-store.test.ts`（**11 格**）

**Interfaces:**
- Consumes（名字逐字，不许另起一套）:
  - T1：`readMysqlEnv(env?)` / `interface MysqlEnv { host; port; user; password; database: 'dajia' | 'dajia_test' }` / `assertDatabaseName(db)`
  - T2：`createDbPool(env, opts?)` / `migrate(pool, database, migrations?)`
  - T3：`EntityIdSchema` / `JournalTurnSchema` / `EntitySchema` / `PatchSchema`（都在 `packages/protocol/src/entity-schema.ts`）；core 的 `assertTruthSourceInvariants(doc)`（T5 在 `loadProject` 里已经调过，T8 一处都不重调，见第 ⑩ 段）
  - T4：`DocumentPayloadSchema` / `type DocumentPayloadShape` / `type PatchShape` / `parseDocumentPayload` / `parsePatchShape`；`class ProjectRepository`（`constructor(pool, projectId, actor)`、`appendJournal(entry): Promise<'applied'|'already-applied'>`、`writeSnapshot(turn, doc)`）；`type JournalEntry { turn; patch; doc }`
  - T5：`type OpenIntent = 'edit' | 'read'` / `interface ProjectHeader { projectId; name; schemaVersion; journalTurn; wasCleanShutdown }` / `interface LoadOutcome { doc; header; snapshot: { seq; turn } | null; replayed: { rows; fromSeq; toSeq } }` / `interface CloseReport { elementRows; storeyRows }` / `loadProject(intent)` / `closeProject(doc)`
  - T6：`newLockTicket({ projectId, owner })` / `acquireLock(pool, ticket, ttlMs?)` / `heartbeat(pool, ticket, ttlMs?)` / `releaseLock(pool, ticket)` / `LOCK_TTL_MS`
  - T7：`class Autosave`（`submit` / `flush` / `pause` / `resume` / `stop` / `settled` / `status`）、`type SaveStatus`、`type AutosavePhase`、`realTimer`、`writeEmergencySnapshot(userDataDir, input)`、`EMERGENCY_DIR_NAME`、`emergencyFileName(projectId, turn)`、`describeError(err)`、core 的 `get lastPatch(): Patch | null`
  - 现成屏幕侧：`useEditor`（`log` / `storeyId` / `viewport` / `viewportStoreyId` / `revision` / `lastError` / `setViewport` / `setStorey` / `setTool` / `dispatch` / `dispatchBatch` / `undo` / `redo` / `reportPaintError`）、`TransactionLog` 的公开 `constructor(doc: Document)`、core 的 `Document.get/byKind/entities/create/replaceEntities`、scene-2d 的 `storeyTabsOf(doc, projectId)` / `fitStorey(doc, storeyId, wPx, hPx, padPx)` / `demoHouse()`（`projectStore.open()` 要知道开在哪一层：`storeyTabsOf` 是"该显示哪层"的唯一产地，Step 6 ④ 段）
- Produces（T9/T10/T11 只能从这里取）:
  - protocol：`IPC` 五条通道（`ping` / `projectOpen` / `projectClose` / `journalSubmit` / `saveStatus`）、`PERSIST_ERROR_CODES`（闭集 **7** 个）/ `type PersistErrorCode` / `FailureReplySchema` / `type PersistFail` / `type IpcResult<T>`；`OpenRequestSchema`+`OpenValueSchema`、`SubmitRequestSchema`+`SubmitValueSchema`、`CloseRequestSchema`+`CloseValueSchema`、`SaveStatusSchema`、`ProjectHeaderWireSchema`、`EmergencyRefSchema`、`OpenDecisionSchema` 与各自的 `type`；`parseOpenRequest` / `parseSubmitRequest` / `parseCloseRequest` / `parseOpenValue` / `parseSubmitValue` / `parseCloseValue` / `parseSaveStatus`；名册 `INVOKE_CHANNELS`（`readonly IpcChannel[]`，三条）/ `SAVE_STATUS_EVENT`（一条 `IpcChannel`）；`issueText`（导出）
  - `apps/desktop/src/shared/document-wire.ts`：`payloadFromDocument(doc): DocumentPayloadShape`、`documentFromPayload(payload, where): Document`
  - session：`class ProjectSession`，`constructor(ports: PersistPorts)`，`open(projectId): Promise<OpenValue>` / `submit(req): SubmitValue`（**同步**，第 ① 段的取号纪律要求它不能有 `await`）/ `close(req): Promise<CloseValue>` / `status(): SaveStatus | null` / `get active(): boolean` / `get decision(): OpenDecision | null`；`const CLOSE_FLUSH_TIMEOUT_MS = 10_000`（唯一读者是 `close` 里那一发 `withTimeout`）；`interface PersistPorts { userDataDir; timer; loadConfig(); openDb(env, projectId); acquire(db, projectId); readEmergency(userDataDir, projectId); writeEmergency(payload); emitStatus(status) }`（八个键，`owner` 不在里面 —— 拼票是 `ipc-persist.ts` 的事，session 不认识 `node:os`）、`interface DbHandle { repo; raw: unknown; end() }`（`raw` 是连接本体的不透明把手，session 一个字段都不读）、`interface LockHandle { beat(); release() }`、`interface SessionRepo extends JournalSink { loadProject; closeProject }`、`class SessionError extends Error { code: PersistErrorCode }`
  - emergency 追加：`interface EmergencyFound { readonly turn: number; readonly path: string }` 与 `listEmergency(userDataDir, projectId): EmergencyFound[]`（读盘、除"空 `userDataDir`"那一刀之外不抛、按 turn 升序；与 protocol 的 `EmergencyRef` 结构同型，`session.ts` 的端口直接吃它）
  - preload：`DajiaApi = { ping; openProject; submitJournal; closeProject; onSaveStatus }`
  - renderer：`useProject`（状态格 `phase` / `opened`（`OpenedProject | null`，里面有 `projectId` / `decision` / `name` / `wasCleanShutdown` / `replayedRows` / `emergencyCount` / `emergencyHint`）/ `failure` / `save` / `closedReport`（`CloseValue | null`，`graceful` 那两格对账读数的唯一读者）/ `banner`；动作 `open(id)` / `reopenAsEdit()` / `closeSession(mode)` / `setSaveStatus(status)`）、`createProjectStore(api, editor?)`（测试用的工厂，返回 `readonly [store, unsubscribe]`）、`readDajia(): DajiaApi | null`、`type ProjectBanner` / `type ProjectBannerTone` / `type ProjectPhase` / `type CloseMode`、`declare global` 那块 `Window { dajia?: DajiaApi }`
  - editorStore 追加：`readOnly: boolean`、`setReadOnly(v: boolean)`、`loadProject(doc: Document, storeyId: string): boolean`

**①（裁决 P-18）`turn` 由主进程分配，renderer 只交 `{ projectId, patch, doc }`。**
`JournalEntry.turn` 是库里的幂等键（`uk_project_turn`），而 T4 的 `appendJournal` 只认"恰好 `journal_turn + 1`"，别的都是 `journal turn 跳号` 一抛。两边都能编号时，"谁的那个号"这件事会漂：renderer 编号要在重开时跟 `header.journalTurn` 对齐、要在 undo/redo 时继续加、还要跟主进程那条已经排进 `Autosave` 队列的号不打架 —— 三个都对，就是三份状态。收进主进程以后只剩一条纪律：**`ProjectSession.submit` 里"取号 + `autosave.submit`"之间一个 `await` 都不许有**（写成 `const turn = this.lastTurn + 1; this.lastTurn = turn; const outcome = this.autosave.submit({ turn, patch, doc })`，`Autosave.submit` 本身是同步的）。于是 `ipcRenderer.invoke` 的消息顺序（同一 port 上严格有序）就是取号顺序，`appendJournal` 看到的 turn 序列必然严格 +1，跳号那一抛的产地只剩"会话状态被外力改坏"一种。
代价照登记：屏幕上的"已经保存到第几发"不能由 renderer 自己算，只能读 `SaveStatus.lastTurn`（T7 已经在 `status()` 里给了，横幅只读那一个形状）；`--persist-shot`（T11）要断"取号不乱序"时读的是库里的 `journal_turn` 序列，不是屏幕上的数。

**②（裁决 P-19）`payload ↔ Document` 的构造只有一个产地：`apps/desktop/src/shared/document-wire.ts`。**
T8 之后有**两边**都要把一份 `DocumentPayloadShape` 变成 core 的 `Document`：main 侧（`submit` 要把 renderer 递来的文档交给 `writeSnapshot(turn, doc)` 与 `closeProject(doc)`；`loadProject` 的产物要编码回线上）与 renderer 侧（打开工程时要把回包变成 `new TransactionLog(doc)` 的起点）。`Document` 的构造口径不是一行：`Document.create` 认 `isEntityId`、`replaceEntities` 逐实体 validate（UUID + 该 kind 的整数毫米名单），而**重复 id 必须当场抛**（"同一份快照存着同一 id 的两个真值"那一型，`Map.set` 会静默取后者 ⇒ `canonical()` 从此说谎）。renderer 自己再写一遍这个循环，就是 D2b 明令禁止的第二份真源，且第一份漂了没人红。
所以：`documentFromPayload(payload, where)` 与 `payloadFromDocument(doc)` 住在一个**谁都能相对 import 的目录**（`src/shared`，第三个目录）。不放 `src/main/**`：renderer 不许认识 main。不放进 `@dajia/core`：core 不许认识"盘上/线上一份 payload"这种外壳形状（`codec.ts` 里那句"为一次排序给 core 加导出 = 多一条只服务于磁盘的 API"是同一个理由，而这里要加的是一条**边界形状**的 API，比那次更该留在 desktop 侧）。
T4 的 `decodeDocument` / `encodeDocument` 改成**委托**它：`decodeDocument(ref, raw)` = `documentFromPayload(parseDocumentPayload(where(ref), asJsonValue(raw)), where(ref))`，抛错文案 `${where} 的 entities 里实体 X 出现两次：一份快照不许有重复 id` **逐字保留**（`where` 由调用方递，前缀照样是 `snapshot 行 3`），T4 `codec.test.ts` 那两格正则一字不动地继续成立。
代价照登记：`apps/desktop/tsconfig.json` 的 `include` 多一条 `"src/shared"`（漏了就等于那个目录不进 typecheck，红要等运行时）；**T4 的变异样本 T4-M9 从此挪靶** —— 删重复 id 检查要删 `src/shared/document-wire.ts` 那一处，`codec.ts` 里已经没有可删的牙了。这一条挪动在 Step 2 落，并同步在计划文件里 T4 变异表那一行末尾追加一句"（T8 之后靶在 `src/shared/document-wire.ts`）"。

**③（裁决 P-20）spec §9 那句「IPC 边界 zod 校验 + 结构化错误码」落成的形状：入站验请求、出站验值、错误码闭集、事件只带 `SaveStatus`。**
方向分清楚就简单。**入站**（renderer → main）：handler 第一行就是 `parseOpenRequest(channel, args)` 这类具名出口，验不过 ⇒ 直接回 `{ ok: false, code: 'bad-request', message }`，main 一个字节都不写库。**出站**（main → renderer）：回包组装完，先拿该通道的 `parseXValue(channel, value)` 过一遍再发 —— 它抓的正是"main 自己把形状拼错"那一型，而这一型在 renderer 抛只是换个栈，在出口抛则连坏包都不会离开进程。
过界校验用 **`Value` schema 而不是 `ok/value` 的 union**，理由是错误文案的可定位性：`z.union` 在嵌套字段坏掉时报的是根上的 `invalid_union`，`issueText` 只能给出 `(根): Invalid input`，谁读了都不知道是哪一格的毫米漂了；直接验 `OpenValueSchema` 则给 `doc.entities.0.thicknessMm: ...` 这种点号路径（Step 1 第 6 格钉的就是这一格）。所以这一族里没有 `OpenResultSchema` 之类的 union 运行时判据，只有 `type IpcResult<T>` 一个 TS 形状给 preload 的方法签名用。
`PersistErrorCode = 'not-configured' | 'no-project' | 'bad-request' | 'session' | 'db' | 'internal' | 'reconcile'` —— 七个都有唯一的产地和一个读者（横幅文案按码分岔）。**T8 只产生其中六个**：`'no-project'` 的产地在 T9（那条"工程行不在库里"的通道 —— 新建/打开一个查无此号的工程），T8 的 `open` 撞上不存在的工程时走的是 `acquireLock` 的 `'no-project'` ⇒ 只读打开 ⇒ `loadProject` 抛 ⇒ `'reconcile'`，不是这个码。它留在闭集里是因为 `FailureReplySchema` 必须一次把话说完，而 T9 改码表等于改 protocol 的公开形状。**没有** `'unknown'`：留了就等于允许哪天"归个类算了"，而 spec §9 要的"分型诊断"（T9）恰恰靠每个码都有下一步动作才有意义。`'internal'` 不是那个"unknown"：它的触发点是**出口那一发 `parseXValue` 抛了**（= 我们的代码错了），下一步动作是"这一发没存上，屏幕上的东西仍在"（spec §9 的第一句），且它同时 `console.error` 一份带点号路径的原文给人查。
`'reconcile'` 单列而**不并进 `'db'`**，因为这两个码的下一步动作相反：`'db'` 说"查服务、查网络"（连接层，数据没动），`'reconcile'` 说**停下来别再写了**（T5 的 `closeProject` 三方对账不平 = 库里已经和屏幕上不是同一份东西）。这种时候提示用户去检查 MySQL 服务是错的（服务健康得很），提示他"这份账先别再动"才对。它是本计划里唯一一个由**我们自己的账目判据**而非 MySQL 错误码触发的持久化错误，混进 `'db'` 等于把 T4/T5 最重那道护栏的报警声改了口径。产地是一条规则而不是一个调用点：`session.ts` 的 `persistErrorCode(err)` —— mysql2 抛的错一律带 `code`（`ER_*` / `PROTOCOL_CONNECTION_LOST` / `ECONNREFUSED`）⇒ `'db'`，不带 `code` 的都是我们自己抛的 `RangeError`/`TypeError`（T5 的 `closeProject` 三方对账不平、T5 的 `loadProject` 拒开：跳号与三处 `schema_version` 不符、T4 的归属守卫）⇒ `'reconcile'`。这两类的下一步动作都是"库里这份账不对，先别再写"，把它们拆成两个码反而会让 T9 给同一种处境配两套文案。代价照登记：我们自己的一处代码 bug（比如某处 `TypeError`）混在没有 `code` 那一支，会被说成"账不对"；防线是**每条 `SessionError` 的 message 永远带 `describeError(err)` 的原话**，码只决定下一步动作、不代替事实。
`issueText` 从 `entity-schema.ts` 的模块私有改成导出：T8 的七个 `parse*` 与 T4 的三个 `parse*` 是同一条"把 `ZodError` 收成一行文本"的规则，复制第二份一定会漂（T3/T5/T6 同族口径）。代价：它是 protocol 的一个新公开出口，将来谁都能调 —— 由第 10 格钉住它的输出形状（点号路径 + `; ` 分隔 + 根那一格写 `(根)`）。

**④ 口令不进 IPC。**
`persist-schema.ts` 里**任何** schema 都不许出现 `password` 这个键名，连提都不提（正反两面各一格钉它：传一个带 `password` 键的请求 ⇒ `strictObject` 拒；文件文本里出现 `password` / `host:` / `port:` / `user` 字样 ⇒ 扫描格红）。这一格在 T8 是免费的：T8 的配置来源是 `readMysqlEnv()`（环境变量），renderer 根本没有口令可交。它同时是一条**给 T9 的门槛**：连接向导必然要把用户敲的口令送进 main（IPC 不经网络，这条本身不破红线），届时**必须**同时改这一族判据 —— 只放行新开的配置通道的**请求方向**，回包方向仍然一个字节都不许带。交接写在这里是因为"改判据"这件事必须由计划的作者先说清楚能放宽到哪一步，不能让 T9 的 implementer 自己决定（同族纪律见红线"闸门判据与写死的字面量永不削弱"）。
真正的防线不是"不过 IPC"，是**不回显**：`issueText` 把 `path` 与 `message` 拼进文案，而文案会进 `lastError`、进横幅、进日志 —— 所以任何含口令的 schema 都必须给该字段写**自定义 message**（`z.string('password 必须是字符串')` 那种形态；zod 的默认 `invalid_type` 文案本身不回显值，但自定义 refine 常手滑把值抄进文案）。T9 落这一族时照这条写。

**⑤ 只读决定在 `open` 那一刻定，锁中途丢了不在原会话里翻回可写。**
T6 第 ⑥ 段留的口子是"`'edit'` 意图先 `acquireLock`，拿不到就用 `'read'` 打开（T8）"。于是 `open()` 只有一条岔路：拿到票 ⇒ `loadProject('edit')` + `new Autosave({ beat })`；拿不到（`'busy'` 或 `'no-project'`）⇒ `loadProject('read')`（T5：`'read'` 支不锁行、不抹 `clean_shutdown`）+ 不起 `Autosave`、`submit` 一律 `code: 'session'` 拒。
那"心跳报了 `'lost'` 之后能不能再拿回来"？不在原会话里。因为丢锁意味着**另一个人正在往同一行账上写**，本会话手里那个 `lastTurn` 已经不再等于库里的 `journal_turn`；原地 `resume()` 会立刻撞跳号（好的一面），或者撞上别人已经占用的 turn（T4 的 ODKU 幂等支路把它吞成 `already-applied` ⇒ 静默丢失，本计划最恨的一型）。所以 T8 给的是**重开**：`closeSession('abandon')`（`stop()`，不 flush、不对账、只解锁关池）+ `open(同一 id)`，两步都在 `projectStore.reopenAsEdit()` 里，可单测。
代价登记两条，Step 8 之后一并写进"登记的限度"：① `stop()` 会把队列里未落盘的那几发**丢掉** —— 防线是 T7 在停写那一刻已经为每一发写过 emergency 现场，而 T8 新增的 `listEmergency()` 把"有 K 发没进库、现场在哪个目录"读进横幅 ⇒ 这是**告知过的放弃**，不是静默丢失（这一发就是 emergency 那一族文件在生产里的唯一读者）；② 重开会换掉 `TransactionLog` ⇒ 撤销栈清空，用户丢掉"撤销回丢锁之前"的能力。两条在 S1 的威胁模型（两台机器同时开一个库）下都比"双线写"便宜。

**改判一条 T7 留下的口子**：`autosave.ts` 的 `resume()` 注释写着「T8 重新拿到锁之后调」。按上面这段，T8 **不调它** —— 那句注释与这条改判由 T8 的执行回填写进 `task-7-report` 那一族记录，不改 T7 已提交的 24 格（`resume` 与 `pause` 是成对原语，删它等于作废那几格，且它是 T7 队列语义的一部分，不是为 T8 而存在的）。`resume()` 在生产里的读者留给 S2 的「重连」按钮，届时得连带解决"本会话的 `issuedTurn` 已不等于库里 `journal_turn`"这件事（P-9 之外新的一条状态），而不是原地按一下就好。

**⑥ `ipc-persist.ts` 是本任务唯一新增的、许 import `electron` 的 main 文件，例外名单由测试钉住。**
P-2 禁的是 `db/**` 与 `persist/**`，`ipc-persist.ts` 住在 `src/main/` 根下、不在禁令范围内 —— 但它需要一个常驻证人，否则下一个人会把真把式（`createDbPool` / `migrate` / `ProjectRepository`）一点点挪进 `session.ts`，那条边界就漂没了。所以 Step 4 给 `persist-boundary.test.ts` 追加三格：(a) `session.ts` 的源码里既无 `from 'electron'` 也无 `from 'node:fs'`，**连 `node:os` 都不许碰**（owner 串 `host:pid` 由 ports 从 `ipc-persist.ts` 递进来）；(b) **`src/main/**` 下 import 了 `electron` 的文件名单逐字等于 `['index.ts', 'ipc-persist.ts']`**（排序后比字面量数组）；(c) `src/renderer/**` 里对 `@dajia/protocol` 的 import **必须全是 type-only**（vite 顺着 workspace link 解析得到 protocol，值 import 不会构建失败，只会把 zod 拖进屏幕侧的 bundle —— 所以这一条是约定，约定的常驻证人只能扫文本）。代价：T9 若要在 `persist/config-store.ts` 里 `import { safeStorage } from 'electron'`（P-2 明写的例外），**必须同时改这一格**并写明它是 spec §8.2 的例外 —— 这条也写进 T9 的交接。

**⑦ `close` 由 renderer 发起，`before-quit` 握手归 T11。**
`closeProject(doc)` 要吃最终文档（T5 第 ④ 段：main 不拥有文档，收尾那一发由 renderer 递进来），而退出时机由 main 决定 —— 两边要的是同一份数据，方向相反。真握手是：main `before-quit` + `event.preventDefault()` → 向 renderer 要最终 doc → renderer 调 `projectClose` → main 收尾后放行退出，外加"renderer 不 reply 怎么办"的超时。那一整块是**生命周期与多进程编排**，和 T11 的 `--persist-shot`（三进程 + `SIGKILL`）同属一件事，放在那里才有证人（放 T8 就只能靠人肉关窗验，等于没验）。
于是 T8 的 `close` 通道在生产里只有一个读者：横幅上那一个「关闭工程」。没有 `before-quit` 会怎样？**不会静默丢**：每发的补丁已经进 `command_log`（T7 的队列按发落地），只丢最后那次快照与 `clean_shutdown = 1` ⇒ 下次打开 `wasCleanShutdown === false`，横幅说"上次没正常结束，已从流水取回 N 发"。这正是 spec §9 那句"启动时若发现未合并片段，走恢复流程并明确告知恢复了什么、是否丢失"要的恢复路径 —— T8 提前给它加一条优雅退出，反而会把那条路径测没。

**⑧ 默认态一字不动：横幅只在 `banner !== null` 时渲染，且 `position: fixed` 不占流。**
五道闸门吃的是 `demoHouse()` 那一屏：画布原点 `(0, 32)`（`STOREY_TAB_HEIGHT_PX`）、`--prop` 的靶子 `click=(113,416)`、画布 `1167×833`、P7 墨迹 `30742`、P20 级联 `10→7`。任何多出来的**常驻** DOM（哪怕一根 24px 的条）都会把 `fitStorey` 量到的画布尺寸挪开 ⇒ 全体判据作废。所以：闸门环境里 `useProject` 的 `phase === 'off'`、`banner === null`，App 渲染 `<>{children}{null}</>` ⇒ 零节点。真打开工程之后横幅出现，用 `fixed` 贴屏幕下缘，不挤占任何 flex 尺寸（会盖住画布下缘，S1 接受，T9 整理界面时搬进面板）。
`loadProject` 换手时把 `viewport` 与 `viewportStoreyId` **同时置 null**（不是保留旧视口）：`PlanCanvas` 的绘制 effect 第一行就是 `if (canvas === null || viewport === null) return`，所以那一帧是干净的空白 + 它自己的占位 tab 栏，随后 `storeyId` 变化触发它自带的重算 effect 递回真视口。反过来（留着上一层的视口配新文档）会画出一帧"新文档 × 旧口径"的错位图 —— 与 `setStorey` 那条 P10 判据同一个理由。

**⑨ 提交触发点在 `projectStore`（订阅 `useEditor`），不在 `editorStore.dispatch` 里。**
两个 store 互相 import 会成环，而 `editorStore` 的 import 图一动，`App.tsx` / `PlanCanvas` 跟着动 —— 那是给五道闸门找事。更要紧的是语义：**`revision` 不是"真源变了"的扳机，是"该重绘了"的扳机**，`setStorey` 也 +1 它（`editorStore` 自己的注释明写"切层不是真源编辑，是视图状态"）。于是"revision 变了就发一记账"会把**切层**变成一发空账（同一份 `lastPatch` 落两次 turn ⇒ 库里同一补丁重放两次 ⇒ 屏幕上多一面墙）。真正的判据是 `log.lastPatch` 的**对象身份**变了：`TransactionLog` 只在 `dispatch`/`undo`/`redo` 成功时换它（T7 第 ① 段），切层不动它。所以订阅体写成 `if (patch !== lastSeen) { lastSeen = patch; submitOne(patch); }`。
这一格是 `project-store.test.ts` 第 7 格的靶子（「点一次楼层 tab ⇒ 一次 IPC 都不发，而 `revision` 确实变了」），它同时是 T7 那条 `lastPatch` getter 在生产里的**第一个读者**。

**⑩ main 不持工程列表；`open` 在已有会话时一律拒；T8 不重跑读盘不变式。**
S1 是"一个窗口一个工程"（spec §4.3 的进程模型），不是工程管理器，所以 `ProjectSession.active === true` 时再来一发 `open` ⇒ `SessionError('session', '上一个工程还没收尾')`，顺序由 renderer 负责（第 ⑤ 段的 `reopenAsEdit()`）。`assertTruthSourceInvariants` 在 T5 的 `loadProject` 末尾已经跑过（那是它的放行证所在地），`submit` 那一发的文档则由 core 的 `Document.replaceEntities` 逐实体 validate（整数毫米与 id 形状）+ T4 的归属守卫（`doc.projectId` 不是本工程的账 ⇒ 抛）拦着；T8 再补跑一遍整层派生就是第三次验同一份数据，而 autosave 每发都要跑一遍它（O(实体数) × 每发）。代价：跨实体的引用/几何不变式在**过界这一发**不查，它的读者仍是 T5 的读盘与 T3 的那一档；登记进"登记的限度"。

**⑪（裁决 P-21）`dispatchBatch` 从「一批只扳一次」改成「每应用一条扳一次」。**
第 ⑨ 段的触发点是 `log.lastPatch` 的**对象身份**，而 `lastPatch` 是**覆盖式**的（T7 第 ① 段：三个赋值点各写一次）。于是"一批一扳"那个现物写法（`dispatchBatch` 循环里只 `set` 一次 `revision`）会让订阅体在整批结束时只看得到**最后一发**的补丁 —— 屏幕上删掉四件、库里只记一件，而且**一句错都不抛**（`autosave` 收到的仍是合法的一发）。改判的形状、代价（一批 N 发 ⇒ N 次重绘，样例房最多 4 次；五道闸门判的是**终态**像素，与中间帧数无关）、以及被否掉的替代方案（在 store 里挂一条 `pendingPatches` 队列）都写在 Step 6 ① 段。凭据：`project-store.test.ts` 第 8 格（三条命令 ⇒ 三发账，且每发配它自己那一刻的整份快照）与 `editor-store.test.ts` 第 8 格（revision +N）。

- [ ] **Step 1: protocol 那一侧 —— `persist-schema.ts` + 通道名册 + 10 格**

`packages/protocol/src/ipc.ts` 整体替换（`ping` 那条与 `IpcChannel` / `isIpcChannel` 三个出口一字不动；`isIpcChannel` 的判据是"值落在 `IPC` 里"，扩表自动成立）：

```ts
export const IPC = {
  ping: 'dajia:ping',
  // 以下四条归计划 4（T8）。命名口径：`dajia:<域>:<动作或事件>`。
  // `saveStatus` 是这条表里唯一的事件通道（main → renderer，没有请求方向），
  // 它不进 `INVOKE_CHANNELS` 那张名册 —— 名册只管需要注册 handler 的那三条。
  projectOpen: 'dajia:project:open',
  projectClose: 'dajia:project:close',
  journalSubmit: 'dajia:journal:submit',
  saveStatus: 'dajia:save:status',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export function isIpcChannel(value: unknown): value is IpcChannel {
  return typeof value === 'string' && Object.values(IPC).includes(value as IpcChannel);
}
```

`packages/protocol/src/entity-schema.ts`：只改一个词 —— `function issueText(` ⇒ `export function issueText(`。T3/T4 写下的其余部分（含那三个 `parse*` 与 `DocumentPayloadSchema`）一个字节不动。

`packages/protocol/src/persist-schema.ts`

```ts
import { z } from 'zod';
import { IPC, type IpcChannel } from './ipc';
import {
  DocumentPayloadSchema,
  EntityIdSchema,
  JournalTurnSchema,
  PatchSchema,
  issueText,
  type DocumentPayloadShape,
  type PatchShape,
} from './entity-schema';

/**
 * IPC 侧的"非负安全整数"尺。为什么**不**复用 `JournalTurnSchema`：那把尺的名字就是它的语义
 * （落库那一发的编号），拿它去量 `snapshot.seq` 与 `replayed.rows` 会让读代码的人以为
 * "这三者是同一个量"，而 seq 是 AUTO_INCREMENT 的游标（**可以带洞**，P-6），turn 不可以。
 * 规则相同、语义不同 ⇒ 两个 schema 各自存在，正是为了让"把它们混成一个"这件事有名字可红。
 */
const SafeCountSchema = z
  .number()
  .refine((v) => Number.isSafeInteger(v) && v >= 0, '必须为非负安全整数');

/** 结构化错误码（spec §9）。闭集，**没有** `'unknown'`：理由见计划第 ③ 段。 */
export const PERSIST_ERROR_CODES = [
  'not-configured',
  'no-project',
  'bad-request',
  'session',
  'db',
  'reconcile',
  'internal',
] as const;
export const PersistErrorCodeSchema = z.enum(PERSIST_ERROR_CODES);
export type PersistErrorCode = z.output<typeof PersistErrorCodeSchema>;

export const FailureReplySchema = z.strictObject({
  ok: z.literal(false),
  code: PersistErrorCodeSchema,
  message: z.string(),
});
export type PersistFail = z.output<typeof FailureReplySchema>;

/**
 * 过界的回包形状。它是**类型**，不是 zod schema：成功那一支的 `value` 由各通道的
 * `XValueSchema` 单独验（用 union 会让嵌套字段的错误文案塌成 `(根)`，第 ③ 段），
 * 失败那一支由 `ipc-persist.ts` 自己拼，只有 `code` 需要闭集保证 —— 那一条走
 * `PersistErrorCodeSchema`，见 `fail()`。
 */
export type IpcResult<T> = { readonly ok: true; readonly value: T } | PersistFail;

// —— 打开工程 ——————————————————————————————————————————————

/** 只有 `projectId`。没有名字、没有口令、没有建库参数（第 ④ 段：T8 的配置源是环境变量）。 */
export const OpenRequestSchema = z.strictObject({ projectId: EntityIdSchema });
export type OpenRequest = z.output<typeof OpenRequestSchema>;

/** `decision` 与 T5 的 `OpenIntent` 不是一张表：那边是"我想怎么开"，这边是"库里那一行让我怎么开"。 */
export const OpenDecisionSchema = z.enum(['edit', 'read-only']);
export type OpenDecision = z.output<typeof OpenDecisionSchema>;

/**
 * 带 `Wire` 后缀的两张表（`ProjectHeaderWire` / `SaveStatusWire`）是因为
 * `session.ts` 同一文件里会同时出现 T5 的 `ProjectHeader` 与 T7 的 `SaveStatus`：
 * 两份类型必须分得开，否则读的人以为校验的是自己那份（这正是"过界再验一次"最容易被
 * 顺手写成 `as` 的地方）。其余 schema 没有对手，不带后缀。
 */
export const ProjectHeaderWireSchema = z.strictObject({
  projectId: EntityIdSchema,
  name: z.string().min(1),
  schemaVersion: SafeCountSchema,
  journalTurn: JournalTurnSchema,
  wasCleanShutdown: z.boolean(),
});
export type ProjectHeaderWire = z.output<typeof ProjectHeaderWireSchema>;

export const EmergencyRefSchema = z.strictObject({
  turn: JournalTurnSchema,
  /** 绝对路径，只给人看：renderer 一行 fs 都不许碰（spec §4.3），所以它只是横幅上的那串字。 */
  path: z.string().min(1),
});
export type EmergencyRef = z.output<typeof EmergencyRefSchema>;

export const OpenValueSchema = z.strictObject({
  decision: OpenDecisionSchema,
  header: ProjectHeaderWireSchema,
  doc: DocumentPayloadSchema,
  snapshot: z.strictObject({ seq: SafeCountSchema, turn: JournalTurnSchema }).nullable(),
  replayed: z.strictObject({
    rows: SafeCountSchema,
    fromSeq: SafeCountSchema.nullable(),
    toSeq: SafeCountSchema.nullable(),
  }),
  emergency: z.array(EmergencyRefSchema),
});
export type OpenValue = z.output<typeof OpenValueSchema>;

// —— 每发提交 ——————————————————————————————————————————————

export const SubmitRequestSchema = z.strictObject({
  projectId: EntityIdSchema,
  patch: PatchSchema,
  doc: DocumentPayloadSchema,
});
export type SubmitRequest = z.output<typeof SubmitRequestSchema>;

export const SubmitValueSchema = z.strictObject({
  /** T7 `Autosave.submit` 的两个返回值，原样搬过界（`'ignored-duplicate'` = 引擎认为这发已经排过了）。 */
  outcome: z.enum(['queued', 'ignored-duplicate']),
  acceptedTurn: JournalTurnSchema,
});
export type SubmitValue = z.output<typeof SubmitValueSchema>;

// —— 收尾（T5 的 flush + closeProject + 解锁），第 ⑤/⑦ 段 ——————

export const CloseRequestSchema = z.strictObject({
  projectId: EntityIdSchema,
  doc: DocumentPayloadSchema,
  /** `abandon` = 停写、解锁、关池，**不** flush、**不**对账（丢锁之后重开前那一发）。 */
  mode: z.enum(['graceful', 'abandon']),
});
export type CloseRequest = z.output<typeof CloseRequestSchema>;

export const CloseValueSchema = z.strictObject({
  /** `abandon` 那一支不跑对账 ⇒ 两格读数都是 `null`。用 `null` 而不是 `0`：0 是"平账"的答案。 */
  elementRows: SafeCountSchema.nullable(),
  storeyRows: SafeCountSchema.nullable(),
});
export type CloseValue = z.output<typeof CloseValueSchema>;

// —— 事件：main → renderer，只带 T7 那一个形状 ————————————————

/**
 * 与 `apps/desktop/src/main/persist/autosave.ts` 的 `SaveStatus` 一字对齐，
 * 由 `persist-schema.test.ts` 第 4 格做源码级对账（同一族判据的先例：T6 的
 * 「`locks.ts` 里不许出现客户机时钟」与 T7 的「心跳标识符还在」）。
 */
export const SaveStatusSchema = z.strictObject({
  phase: z.enum(['idle', 'saving', 'failed', 'paused', 'stopped']),
  queuedTurns: SafeCountSchema,
  lastTurn: JournalTurnSchema.nullable(),
  snapshotTurn: JournalTurnSchema.nullable(),
  rowsSinceSnapshot: SafeCountSchema,
  lastError: z.string().nullable(),
  pauseReason: z.string().nullable(),
});
export type SaveStatusWire = z.output<typeof SaveStatusSchema>;

// —— 解析出口：每通道各一个具名函数，不做泛型 ——————————————————
//
// 为什么不用一个泛型 `parsePersist(where, schema, value)`：zod v4 的 `z.ZodType<T>` 单参数
// 写法在 4.6.5 上未经实测（本计划只主张 T1 装得上 `zod@4.6.5` 这件事），而泛型一旦要写第二份
// 就得先证明它解析得到。十一个具名出口啰嗦 20 行，换来的是每条通道的错误文案里有一句人话
// （"解不开打开工程的请求"），T9 的分型诊断要读它。

function fail(where: string, what: string, err: z.ZodError): never {
  throw new TypeError(`${where} 解不开${what}：${issueText(err)}`);
}

export function parseOpenRequest(where: string, value: unknown): OpenRequest {
  const r = OpenRequestSchema.safeParse(value);
  if (!r.success) fail(where, '打开工程的请求', r.error);
  return r.data;
}

export function parseOpenValue(where: string, value: unknown): OpenValue {
  const r = OpenValueSchema.safeParse(value);
  if (!r.success) fail(where, '打开工程的回包', r.error);
  return r.data;
}

export function parseSubmitRequest(where: string, value: unknown): SubmitRequest {
  const r = SubmitRequestSchema.safeParse(value);
  if (!r.success) fail(where, '每发提交的请求', r.error);
  return r.data;
}

export function parseSubmitValue(where: string, value: unknown): SubmitValue {
  const r = SubmitValueSchema.safeParse(value);
  if (!r.success) fail(where, '每发提交的回包', r.error);
  return r.data;
}

export function parseCloseRequest(where: string, value: unknown): CloseRequest {
  const r = CloseRequestSchema.safeParse(value);
  if (!r.success) fail(where, '收尾的请求', r.error);
  return r.data;
}

export function parseCloseValue(where: string, value: unknown): CloseValue {
  const r = CloseValueSchema.safeParse(value);
  if (!r.success) fail(where, '收尾的回包', r.error);
  return r.data;
}

export function parseSaveStatus(where: string, value: unknown): SaveStatusWire {
  const r = SaveStatusSchema.safeParse(value);
  if (!r.success) fail(where, '保存状态', r.error);
  return r.data;
}

// —— 通道名册：注册与扫描的同一份名单 ————————————————

/**
 * 需要注册 handler 的那三条（请求方向，renderer 发起）。`ipc-persist.ts` 按这张名单
 * **循环注册**（`removeHandler` + `handle` 成对，形状照盘上现物那条 `ping`），
 * `ipc-channels.test.ts` 按同一张名单去扫 `ipc-persist.ts` 的 `dispatch`：名单上有一条没写 `case` ⇒ 当场红。
 *
 * 这里故意**不带** parse 函数（一版草稿写过 `ChannelSpec { channel, parseRequest }`，删了）：
 * 外壳只能把 parse 的结果当 `unknown` 交下去，那条 `as` 会把 zod 已经建起来的类型牙拆掉 ——
 * `submit(req: SubmitRequest)` 会失去编译期检查。解析留在 `dispatch` 的 `case` 里用各通道具名 parse，
 * 于是这张名单唯一的职责就是"哪些通道要注册"，一个字段都不多。
 */
export const INVOKE_CHANNELS: readonly IpcChannel[] = [
  IPC.projectOpen,
  IPC.journalSubmit,
  IPC.projectClose,
];

/** 事件方向只有一条（main → renderer，没有请求方向），所以它不进上面的名册。 */
export const SAVE_STATUS_EVENT: IpcChannel = IPC.saveStatus;
```

> `<待实测>`：`z.strictObject` / `z.enum(内联数组)` / `z.literal(true)` / `.nullable()` / `z.output` 在 T3/T4 已经实测过（`DocumentPayloadSchema` 用的就是 `strictObject`）。**没实测过的是 `z.enum(PERSIST_ERROR_CODES)` 收一个 `as const` 元组**（T3 那几处都传内联数组）。若 4.6.5 拒绝它，改成 `z.enum(['not-configured', 'no-project', 'bad-request', 'session', 'db', 'reconcile', 'internal'])` 内联一份，并让第 7 格同时钉"两份名单一致"（`expect([...PERSIST_ERROR_CODES]).toEqual([...七个字面量])` 已经在了，它就是这个口径的牙）。执行时把实测结果回填到这一格。

`packages/protocol/src/index.ts`：按盘上现物的写法把 `persist-schema` 的出口并进去。今天是 `export * from './ipc'` 一行（T3/T4 若已把它扩成逐名列举，就照逐名那一族继续，**别把 `export *` 塞进一个逐名列举的文件里**）。

`packages/protocol/test/persist-schema.test.ts`

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IPC } from '../src/ipc';
import {
  FailureReplySchema,
  INVOKE_CHANNELS,
  OpenRequestSchema,
  OpenValueSchema,
  PERSIST_ERROR_CODES,
  SAVE_STATUS_EVENT,
  SaveStatusSchema,
  SubmitRequestSchema,
  CloseRequestSchema,
  parseOpenRequest,
  parseOpenValue,
  type SaveStatusWire,
} from '../src/persist-schema';

const ID = '01932f6a-7c1e-7000-8000-000000000001';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCHEMA_SRC = readFileSync(`${HERE}../src/persist-schema.ts`, 'utf8');
const AUTOSAVE_SRC = readFileSync(`${HERE}../../apps/desktop/src/main/persist/autosave.ts`, 'utf8');

/** 一份**完整合法**的 `OpenValue`，多个用例在它身上只改一处。 */
function openValue(): Record<string, unknown> {
  return {
    decision: 'edit',
    header: { projectId: ID, name: '样例房', schemaVersion: 1, journalTurn: 7, wasCleanShutdown: true },
    doc: { projectId: ID, schemaVersion: 1, entities: [] },
    snapshot: { seq: 12, turn: 5 },
    replayed: { rows: 2, fromSeq: 11, toSeq: 12 },
    emergency: [],
  };
}

describe('persist-schema：请求方向一律 strictObject', () => {
  it('打开工程的请求只认 projectId 一个键：缺、多、非 UUIDv7 三型都拒', () => {
    expect(OpenRequestSchema.safeParse({ projectId: ID }).success).toBe(true);
    expect(OpenRequestSchema.safeParse({}).success).toBe(false);
    // 多一个 `name` 就红：这是"谁都能顺手往请求里塞一格"的常驻证人。
    expect(OpenRequestSchema.safeParse({ projectId: ID, name: 'x' }).success).toBe(false);
    expect(OpenRequestSchema.safeParse({ projectId: 1 }).success).toBe(false);
    expect(OpenRequestSchema.safeParse({ projectId: '00000000-0000-4000-8000-000000000000' })
      .success).toBe(false);
  });

  it('带 password 键的请求一律拒（口令不进 IPC 的那道牙，第 ④ 段）', () => {
    const doc = { projectId: ID, schemaVersion: 1, entities: [] };
    const cases = [
      OpenRequestSchema.safeParse({ projectId: ID, password: 'hunter2' }),
      SubmitRequestSchema.safeParse({
        projectId: ID, patch: { upsert: [], remove: [] }, doc, password: 'hunter2',
      }),
      CloseRequestSchema.safeParse({ projectId: ID, doc, mode: 'graceful', password: 'hunter2' }),
    ];
    // 三条都补齐了必填项 ⇒ 拒的只能是多出来的那一格，不是缺必填。
    for (const r of cases) expect(r.success).toBe(false);
  });

  it('收尾请求的 mode 只认两值；缺 mode 与第三种拼法都拒', () => {
    const doc = { projectId: ID, schemaVersion: 1, entities: [] };
    expect(CloseRequestSchema.safeParse({ projectId: ID, doc, mode: 'graceful' }).success).toBe(true);
    expect(CloseRequestSchema.safeParse({ projectId: ID, doc, mode: 'abandon' }).success).toBe(true);
    expect(CloseRequestSchema.safeParse({ projectId: ID, doc, mode: 'force' }).success).toBe(false);
    expect(CloseRequestSchema.safeParse({ projectId: ID, doc }).success).toBe(false);
  });
});

describe('persist-schema：回包值与错误码', () => {
  it('SaveStatus 的键集合与 phase 取值 == autosave.ts 里那一份（源码对账）', () => {
    const KEYS = [
      'phase', 'queuedTurns', 'lastTurn', 'snapshotTurn', 'rowsSinceSnapshot',
      'lastError', 'pauseReason',
    ] as const;
    const block = /interface SaveStatus \{([\s\S]*?)\n\}/.exec(AUTOSAVE_SRC);
    if (!block) throw new Error('没在 autosave.ts 里找到 interface SaveStatus —— 它被改名或搬走了');
    const found = [...block[1]!.matchAll(/readonly (\w+):/g)].map((m) => m[1]!);
    expect(found.sort()).toEqual([...KEYS].sort());

    const phases = /type AutosavePhase = ([^;]+);/.exec(AUTOSAVE_SRC);
    if (!phases) throw new Error('没在 autosave.ts 里找到 type AutosavePhase');
    expect([...phases[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort())
      .toEqual(['failed', 'idle', 'paused', 'saving', 'stopped']);

    const full: SaveStatusWire = {
      phase: 'idle', queuedTurns: 0, lastTurn: null, snapshotTurn: null,
      rowsSinceSnapshot: 0, lastError: null, pauseReason: null,
    };
    expect(SaveStatusSchema.safeParse(full).success).toBe(true);
    // 多一格 ⇒ 拒（否则"autosave 加了字段、UI 永远看不见"静默通过）；
    // 少任意一格 ⇒ 也拒（否则 T7 新加的格子在过界那一刻被悄悄丢掉）。
    expect(SaveStatusSchema.safeParse({ ...full, extra: 1 }).success).toBe(false);
    for (const key of KEYS) {
      const missing = { ...full } as Record<string, unknown>;
      delete missing[key];
      expect(SaveStatusSchema.safeParse(missing).success).toBe(false);
    }
  });

  it('seq / queuedTurns 不接受负数、小数、字符串、超安全整数（BIGINT 回到 string 时在过界那一发就红，P-17 的下游）', () => {
    const base: SaveStatusWire = {
      phase: 'idle', queuedTurns: 0, lastTurn: null, snapshotTurn: null,
      rowsSinceSnapshot: 0, lastError: null, pauseReason: null,
    };
    for (const bad of [-1, 1.5, '12', null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(SaveStatusSchema.safeParse({ ...base, queuedTurns: bad }).success).toBe(false);
      const v = openValue();
      v.snapshot = bad === null ? null : { seq: bad, turn: 5 };
      expect(OpenValueSchema.safeParse(v).success).toBe(bad === null);
    }
  });

  it('doc 载荷里的浮点毫米在过界那一发就红，且文案给到点号路径（整数毫米纪律的第二道）', () => {
    const v = openValue();
    v.doc = {
      projectId: ID,
      schemaVersion: 1,
      entities: [{
        kind: 'wall', id: ID, projectId: ID, storeyId: ID,
        startPointId: ID, endPointId: ID,
        thicknessMm: 240.5, heightMm: 3000, elevationOffsetMm: 0,
        loadBearing: true, material: '砖',
      }],
    };
    expect(OpenValueSchema.safeParse(v).success).toBe(false);
    // 这一格同时钉住第 ③ 段那条口径：**不许拿 union 当回包判据**，否则路径塌成 `(根)`，
    // 谁也不知道是哪一格的毫米漂了。
    expect(() => parseOpenValue(IPC.projectOpen, v)).toThrow(/doc\.entities\.0\.thicknessMm/);
  });

  it('错误码是闭集：七个各过，`unknown` 与大小写不同都整包拒', () => {
    expect([...PERSIST_ERROR_CODES]).toEqual([
      'not-configured', 'no-project', 'bad-request', 'session', 'db', 'reconcile', 'internal',
    ]);
    for (const code of PERSIST_ERROR_CODES) {
      expect(FailureReplySchema.safeParse({ ok: false, code, message: 'x' }).success).toBe(true);
    }
    expect(FailureReplySchema.safeParse({ ok: false, code: 'unknown', message: 'x' }).success).toBe(false);
    expect(FailureReplySchema.safeParse({ ok: false, code: 'DB', message: 'x' }).success).toBe(false);
    expect(FailureReplySchema.safeParse({ ok: false, code: 'db' }).success).toBe(false);
  });
});

describe('persist-schema：名册与出口纪律', () => {
  it('名册三条 + 事件那一条 == IPC 里除 ping 的全部（漏登记即红）', () => {
    expect([...INVOKE_CHANNELS].sort()).toEqual(
      [IPC.journalSubmit, IPC.projectClose, IPC.projectOpen].sort(),
    );
    const covered = [...INVOKE_CHANNELS, SAVE_STATUS_EVENT].sort();
    expect(covered).toEqual(Object.values(IPC).filter((c) => c !== IPC.ping).sort());
    // 事件通道不许混进名册（它没有请求方向，被注册成 handler 是自己调自己）。
    expect(INVOKE_CHANNELS.includes(SAVE_STATUS_EVENT)).toBe(false);
  });

  it('persist-schema.ts 的源码里没有口令，也没有连接参数的影子（第 ④ 段）', () => {
    // 三条 `\b` 前缀的尺为什么打得开却不误红：`import` / `export` 里的 "port" 前面是字母，
    // 没有词边界 ⇒ 不匹配；这个文件里真正的连接参数一个都不许出现。
    for (const re of [/password/i, /\bhost\s*:/, /\bport\s*:/, /(^|[^\w])user[^\w]/]) {
      expect(SCHEMA_SRC).not.toMatch(re);
    }
  });

  it('parse 出口的文案 = `<通道名> 解不开<那一句>：<点号路径>: …`', () => {
    expect(() => parseOpenRequest(IPC.projectOpen, { projectId: 42 })).toThrow(
      /^dajia:project:open 解不开打开工程的请求：projectId: /,
    );
    // 整个 value 不是对象时路径落在根那一格：`(根)` 是 T4 给 issueText 定的口径。
    expect(() => parseOpenValue(IPC.projectOpen, 42)).toThrow(/解不开打开工程的回包：\(根\)/);
  });
});
```

Run: `npx vitest run packages/protocol/test/persist-schema.test.ts > tmp/t8-schema.log 2>&1; echo "exit=$?"`
Expected: 先红（`persist-schema.ts` 还没写）⇒ 写完后 **exit=0 / 10 格全绿**。第 4 格在 `autosave.ts` 不存在时会抛"没在 autosave.ts 里找到 interface SaveStatus" —— 那是**故意的**：Step 1 排在 T7 落盘之后执行，真抛了就说明 T7 的形状漂了，先按盘上现物订正计划文本再往下走。

再跑一次 `pnpm typecheck`（protocol 那一段）：这一档抓的是 `z.output` 与手写 `Record<string, unknown>` 之间的可赋值性，vitest 跑得过不代表类型对。

- [ ] **Step 2: 边界形状只有一个产地 —— `src/shared/document-wire.ts` + `codec.ts` 委托 + 7 格**

这一步先把"一个目录凭什么存在"说清楚，再动代码（裁决 P-19 的落地形状）。

**为什么现在是第三个目录，而不是塞进已有的两个地方**：`payload ↔ Document` 这双向构造从 T8 起有**两侧**读者 —— main（`submit`/`close` 要把屏幕递来的 payload 变成 `Document` 才能交给 `writeSnapshot` / `closeProject`；`loadProject` 的产物要编码回线上）与 renderer（打开工程时要把回包变成 `new TransactionLog(doc)` 的起点）。放 `src/main/**` 不行：renderer 不许认识 main，`vite` 会把 `mysql2` 顺这条边拖进屏幕的 bundle。放 `@dajia/core` 不行：core 不许认识"盘上/线上一份 payload"这种外壳形状（T4 里那句"为一次排序给 core 加导出 = 多一条只服务于磁盘的 API"是同一个理由，而这次要加的是一条**边界** API，比那次更该留在 desktop 侧）。放 `@dajia/protocol` 也不行：protocol 是纯契约包，`Document` 的构造是 core 的领域知识，而 protocol 的依赖方向只允许新增 npm 依赖（`zod`）。

于是 `apps/desktop/src/shared/` 是本计划唯一的第三个目录，它同时被 `src/main/**` 与 `src/renderer/src/**` 相对 import。**它对两侧的区别只在 import 形式**：core 用值 import（两侧都要真的建 `Document`），`@dajia/protocol` 一律 `import type` —— `electron.vite.config.ts` 的 `renderer` 段只 alias 了 `@dajia/core` 与 `@dajia/scene-2d`，没有 `@dajia/protocol`；`verbatimModuleSyntax` 会把 `import type` 擦干净，所以 renderer 的构建配置**一个字节都不许改**（改它 = 动首帧时序以外的构建面 = 五道闸门按红线要全体重测，这里完全不必冒这个险）。

**① `apps/desktop/tsconfig.json` 的 `include`（漏了这一行就等于那个目录不进 typecheck，红要等运行时）**

改前（盘上现物，第 8 行）：

```json
  "include": ["src/main", "src/preload", "src/renderer/src"],
```

改后：

```json
  "include": ["src/main", "src/preload", "src/shared", "src/renderer/src"],
```

`exclude` 那行与 `compilerOptions` 一字不动。为什么不用 `src/*` 那种通配：`src/renderer` 目录里有 `index.html`，那条 `exclude` 的存在就是证据 —— 通配会把下一次新增的怪东西静默吸进编译。

**② `apps/desktop/src/shared/document-wire.ts`**

```ts
import { Document, type Entity, type EntityId } from '@dajia/core';
import type { DocumentPayloadShape } from '@dajia/protocol';

/**
 * 与 `core/model/document.ts`、`main/db/reconcile.ts` 里那两个同名的模块私有比较符各写一份。
 * 三处都要"按 id 升序"，但它们住在三个互不许 import 的域里（core 不认识磁盘，main 不许被 shared
 * 认识 —— renderer 的 bundle 会顺着那条边把 mysql2 拖进屏幕）。给任何一方开导出都是一条新边。
 *
 * 排序**只影响线上与盘上的字节顺序，不影响语义**：`documentFromPayload` 建的是 `Map`，
 * `canonical()` 自己会再排一次。所以这一份的读者是"字节稳定"（抢救件可比、快照可 diff），不是正确性。
 */
function byId(a: { id: EntityId }, b: { id: EntityId }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 唯一的"文档 → 边界形状"出口。编码 = 序列化，**不是校验**：`JSON.stringify(-0)` 是 `"0"`，
 * 挡 `-0`/浮点/多余字段是读取侧 zod 的活（T4 ② 段同一条口径，别在这里加第二道）。
 */
export function payloadFromDocument(doc: Document): DocumentPayloadShape {
  return {
    projectId: doc.projectId,
    schemaVersion: doc.schemaVersion,
    entities: [...doc.entities.values()].sort(byId),
  };
}

/**
 * 唯一的"边界形状 → 文档"出口，main 与 renderer 共用这一份。
 * `where` 由调用方给（`snapshot 行 3` / `IPC dajia:journal:submit`），抛错文案的前缀归调用方的坐标 ——
 * 与 T4 的 `codec.ts` 完全一致，所以 `codec.test.ts` 那两格正则一字不动地继续成立。
 */
export function documentFromPayload(payload: DocumentPayloadShape, where: string): Document {
  const next = new Map<EntityId, Entity>();
  for (const entity of payload.entities) {
    if (next.has(entity.id)) {
      // zod 与 Map.set 都不管数组里的重复：同一份快照存着同一 id 的两个真值，
      // 静默取后者会让 canonical() 说谎 —— 这一型必须在过界/读盘当场炸。
      throw new TypeError(
        `${where} 的 entities 里实体 ${entity.id} 出现两次：一份快照不许有重复 id`,
      );
    }
    next.set(entity.id, entity);
  }
  // 只 validate 形状（id 是 UUIDv7、该 kind 的整数毫米字段），不 validate 引用与几何：
  // 放行证在 `assertTruthSourceInvariants`，而它的调用点是 T5 的 `loadProject`（那里才知道读了几层）。
  return Document.replaceEntities(
    Document.create(payload.projectId, payload.schemaVersion),
    next,
  );
}
```

> `<待实测>`：`[...doc.entities.values()]` 的元素类型是 `Entity`，而 `DocumentPayloadShape.entities` 是 `EntityShape[]`。T4 只实测过**反方向**（`EntityShape → Entity`，`decodeEntity` 的返回值就是那一道编译期牙）。`Entity → EntityShape` 若被 `tsc` 拒，说明这两份形状其实不对称（多半是某个 `.optional()` 与 core 的必填/可选不一致）—— **不许写 `as`，也不许加 `satisfies` 糊**：那正是 T3 字段对账那一格本该红而没红的形状，把 `tsc` 的报错原文（哪个键、哪一侧）抄进执行回填，并按它改 `packages/protocol/src/entity-schema.ts`。回填里同时写这一格实测过的那条命令的 exit。

**③ `apps/desktop/src/main/db/codec.ts` 改成委托（只动三个位置）**

改动 1 —— import 两行换成三行（`Document` 从值 import 降为 type import，`EntityId` 整个不再需要：它唯一的用处是那个搬走的 `Map<EntityId, Entity>`；`Entity` 留着，`encodeEntity` / `decodeEntity` 还在用它）：

```ts
import type { Document, Entity, Patch } from '@dajia/core';
import { parseDocumentPayload, parseEntityShape, parsePatchShape } from '@dajia/protocol';
import { documentFromPayload, payloadFromDocument } from '../../shared/document-wire';
```

改动 2 —— 删掉模块私有的 `byId`（`noUnusedLocals` 会立刻为它报错，所以它**必须**被删，而不是留着"以后也许用得上"）。

改动 3 —— `encodeDocument` / `decodeDocument` 两个函数体替换为：

```ts
/**
 * 落盘形状与线上形状同一个产地（`src/shared/document-wire.ts`，裁决 P-19）：这里只补"变成字符串"这一步。
 * 这条委托有两个证人：`codec.test.ts` 第 9 格（`encodeDocument` 的产物与形状表逐字节比，**原样留着**）
 * 与 `document-wire.test.ts` 第 4 格（`encodeDocument(doc)` 逐字节等于 `JSON.stringify(payloadFromDocument(doc))`）。
 */
export function encodeDocument(doc: Document): string {
  return JSON.stringify(payloadFromDocument(doc));
}

/** 只解码、不验不变式：引用与几何的放行证在 T5 的 `loadProject`（那里才知道一共读了几层）。 */
export function decodeDocument(ref: RowRef, raw: unknown): Document {
  const at = where(ref);
  return documentFromPayload(parseDocumentPayload(at, asJsonValue(raw)), at);
}
```

`RowRef` / `where` / `asJsonValue` / `encodeEntity` / `decodeEntity` / `encodePatch` / `decodePatch` 一字不动。**`decodeDocument` 里那段重复 id 的循环整体搬走**：它现在住在 `documentFromPayload`，文案逐字保留（`${where} 的 entities 里实体 X 出现两次：一份快照不许有重复 id`），所以 `codec.test.ts` 吃这条文案的正则一格都不用改 —— 这是"委托没把牙弄丢"的第一证人。

**④ `apps/desktop/test/unit/document-wire.test.ts`（7 格，不连库）**

```ts
import { describe, expect, it } from 'vitest';
import {
  Document,
  SCHEMA_VERSION,
  type Entity,
  type EntityId,
  type PointEntity,
  type StoreyEntity,
  type WallEntity,
} from '@dajia/core';
import { encodeDocument } from '../../src/main/db/codec';
import { documentFromPayload, payloadFromDocument } from '../../src/shared/document-wire';

/**
 * 夹具手写，不走命令：这一族判的是形状与字节，"几何成不成立"归 T3 的读盘不变式与 T5 的 loadProject。
 * id 的字面量与 `codec.test.ts` 同族（同一批 `0193aa00-…-7000-8000-…`），因为两边的对账文案要能并排读。
 */
const PID = '0193aa00-0000-7000-8000-00000000000a';
const S1 = '0193aa00-0000-7000-8000-000000000001';
const P1 = '0193aa00-0000-7000-8000-000000000002';
const P2 = '0193aa00-0000-7000-8000-000000000003';
const W1 = '0193aa00-0000-7000-8000-000000000004';

const point: PointEntity = { kind: 'point', id: P1, storeyId: S1, x: 0, y: 0 };
const point2: PointEntity = { kind: 'point', id: P2, storeyId: S1, x: 4000, y: 0 };
const wall: WallEntity = {
  kind: 'wall',
  id: W1,
  storeyId: S1,
  startId: P1,
  endId: P2,
  thicknessMm: 200,
  heightMm: 2800,
  elevationOffsetMm: 0,
  loadBearing: false,
  material: '砖',
};
const storey: StoreyEntity = {
  kind: 'storey',
  id: S1,
  projectId: PID,
  index: 0,
  elevationMm: 0,
  heightMm: 3000,
};

/** 插入序**故意**是 W1,S1,P2,P1（升序是 S1,P1,P2,W1）：排序与"别照插入序泄出去"两件事都由它测。 */
function doc(insertion: readonly Entity[]): Document {
  return Document.replaceEntities(
    Document.create(PID, SCHEMA_VERSION),
    new Map<EntityId, Entity>(insertion.map((e) => [e.id, e])),
  );
}

const DOC = doc([wall, storey, point2, point]);

describe('payloadFromDocument：形状与顺序', () => {
  it('往返逐字节同源，且四件事实都活着（三键、按 id 升序、空文档、字段值）', () => {
    const payload = payloadFromDocument(DOC);
    expect(Object.keys(payload).sort()).toEqual(['entities', 'projectId', 'schemaVersion']);
    expect(payload.projectId).toBe(PID);
    expect(payload.schemaVersion).toBe(SCHEMA_VERSION);
    expect(payload.entities.map((e) => e.id)).toEqual([S1, P1, P2, W1]);
    expect(documentFromPayload(payload, 'test').canonical()).toBe(DOC.canonical());
  });

  it('换个插入序得到**同一串字节**（排序是"字节稳定"的产地，不是 Map 的副产品）', () => {
    const a = payloadFromDocument(doc([point, point2, storey, wall]));
    const b = payloadFromDocument(doc([wall, storey, point2, point]));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('零实体的文档：`entities` 是空数组而不是缺键，且照样建得回来', () => {
    const empty = Document.create(PID, SCHEMA_VERSION);
    const payload = payloadFromDocument(empty);
    expect(payload.entities).toEqual([]);
    const back = documentFromPayload(payload, 'test');
    expect(back.entities.size).toBe(0);
    expect(back.canonical()).toBe(empty.canonical());
  });

  it('`encodeDocument(doc)` 与 `JSON.stringify(payloadFromDocument(doc))` 逐字节相同（委托没漂）', () => {
    expect(encodeDocument(DOC)).toBe(JSON.stringify(payloadFromDocument(DOC)));
  });
});

describe('documentFromPayload：过界那一步的牙', () => {
  it('重复 id 当场抛，文案与 T4 读盘那一条逐字相同（T4-M9 挪靶之后唯一的产地）', () => {
    const payload = payloadFromDocument(DOC);
    const next = [...payload.entities, payload.entities[0] as (typeof payload.entities)[number]];
    expect(() => documentFromPayload({ ...payload, entities: next }, 'snapshot 行 7')).toThrow(
      new RegExp('snapshot 行 7 的 entities 里实体 .* 出现两次：一份快照不许有重复 id'),
    );
  });

  it('抛错文案用的是**调用方**给的坐标：同一份 payload，两个标签给出两条不同的话', () => {
    const payload = payloadFromDocument(DOC);
    const next = [...payload.entities, payload.entities[0] as (typeof payload.entities)[number]];
    const bad = { ...payload, entities: next };
    expect(() => documentFromPayload(bad, 'IPC dajia:journal:submit')).toThrow(/IPC dajia:journal:submit/);
    expect(() => documentFromPayload(bad, 'emergency 行 3')).toThrow(/emergency 行 3/);
  });

  it('不管引用完整性：一面没有端点的墙照样建得回来（放行证在别处，这里不许提前叫）', () => {
    const orphan = doc([wall]);
    const built = documentFromPayload(payloadFromDocument(orphan), 'test');
    expect(built.byKind('point')).toEqual([]);
    expect(built.get(W1)?.kind).toBe('wall');
  });
});
```

Run: `npx vitest run apps/desktop/test/unit/document-wire.test.ts apps/desktop/test/unit/codec.test.ts > tmp/t8-wire.log 2>&1; echo "exit=$?"`
Expected: `exit=0`，`document-wire.test.ts` **7 passed**，`codec.test.ts` 的格数**一格不减**（T4 的计划数是 12；执行时以盘上实测为准并把两个数写进回填）。第 4 格红而第 1 格绿 ⇒ 委托写反了（`encodeDocument` 还在自己拼对象）；`codec.test.ts` 那两条读重复 id 文案的格红 ⇒ `where` 没传给 `documentFromPayload`。

再单独量一次编译（`import type` 有没有漏写、`Entity ↔ EntityShape` 那一支对称不对称，只有 `tsc` 看得见）：

```bash
npx tsc --noEmit -p apps/desktop/tsconfig.json > tmp/t8-tsc.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`。若报 `'DocumentPayloadShape' 是类型，必须用 type-only import`，说明上面第 2 行的 `import type` 被写成了值 import —— 那正是 renderer bundle 会去解析 `@dajia/protocol` 的形状，必须改回 `import type`，**不许**改成给 renderer 加 alias。

- [ ] **Step 3: 会话编排 —— `persist/session.ts` + 假钟搬家 + 16 格**

先搬假钟，再写被测文件（顺序反了就要在两个文件之间来回跳）。

**① `apps/desktop/test/unit/fake-timer.ts`**：把 T7 内联在 `autosave.test.ts` 里的 `FakeTimer`（`clock` / `now()` / `schedule()` / `advance()` / `pending()`）与 `tick()` **原样搬进来并加 `export`**，类体、那句"定时器回调是同步触发的，但它 kick 出来的活是 async 的"注释、以及"假钟收到非法延时"那一抛，一个字都不改。为什么搬而不是再写一份小的：假钟的**内部口径**（到点顺序、同刻度按 `id` 稳定序、`advance` 把钟面拨到 `target`）现在有两个读者，而 T7 的第 ① 段与 T8 的 `close` 超时格依赖的是同一套语义。两份假钟一旦漂开，红的那一格就无法判断是代码错还是夹具错 —— 本仓罚过的正是这一型。

新文件顶部只需要一行 import（`import type { SaveTimer, TimerHandle } from '../../src/main/persist/autosave';` —— `verbatimModuleSyntax` 要求 type-only，路径按 `test/unit/` 到 `src/main/` 的实际层级）。

`autosave.test.ts` 的改动有**三**处：删掉那段内联类与 `tick`，加一行 `import { FakeTimer, tick } from './fake-timer';`，并把 autosave 那个 import 块里的 `type SaveTimer,` 与 `type TimerHandle,` **一起删掉** —— 那两个名字只被搬走的那段用到过，留在原地 `tsconfig.test.json`（T1 建，include 覆盖 `test`）会报 `TS6133 'SaveTimer' is declared but its value is never read`。**24 格与判据一字不动**，搬完立刻原样复跑：

```bash
npx vitest run apps/desktop/test/unit/autosave.test.ts > tmp/t8-autosave-move.log 2>&1; echo "exit=$?"
```

Expected: `exit=0` 且格数与搬之前**同一个数**（这是"搬家没丢东西"的判据，不是"跑过了"）。

**② `apps/desktop/src/main/persist/session.ts`**

```ts
import type { Document, EntityId, Patch } from '@dajia/core';
import {
  IPC,
  type CloseRequest,
  type CloseValue,
  type EmergencyRef,
  type OpenDecision,
  type OpenValue,
  type PersistErrorCode,
  type SubmitRequest,
  type SubmitValue,
} from '@dajia/protocol';
import type { MysqlEnv } from '../db/env';
import type { CloseReport, LoadOutcome, OpenIntent } from '../db/repository';
import { documentFromPayload, payloadFromDocument } from '../../shared/document-wire';
import {
  Autosave,
  type EmergencyPayload,
  type JournalSink,
  type SaveStatus,
  type SaveTimer,
  type TimerHandle,
} from './autosave';
import { describeError } from './describe-error';

/**
 * 收尾 flush 的时间上限。**唯一读者是 `close` 里那一发 `withTimeout`**：MySQL 不可达时 `flush()`
 * 挂在重试链上，而窗口在等这次收尾放行 —— 没有上限，"关闭工程"这个动作就没有出口。
 * 为什么不是 `LOCK_TTL_MS` 那种共享常量：那两个数没有同源的理由，硬凑一个名字反而误导（T7 口径）。
 */
export const CLOSE_FLUSH_TIMEOUT_MS = 10_000;

/** 会话侧看得见的仓库。`ProjectRepository` 恰好满足它，两边都不 import 对方的类（T7 的 `JournalSink` 同族做法）。 */
export interface SessionRepo extends JournalSink {
  loadProject(intent: OpenIntent): Promise<LoadOutcome>;
  closeProject(doc: Document): Promise<CloseReport>;
}

export interface DbHandle {
  readonly repo: SessionRepo;
  /**
   * 连接本体的**不透明把手**：session 一个字段都不读它，只在 `acquire(db, …)` 那一发原样递回去。
   * 为什么是 `unknown` 而不是 `Pool`：`PersistPorts` 是 electron-free / mysql-free 的那道边界
   * （P-2 同一把尺），把 `Pool` 写进来就会逼 `persist/session.ts` import mysql2，而那 16 格全跑在纯 node 里。
   * 代价：`ipc-persist.ts` 取回它时要一次向下转型（`db.raw as Pool`）—— 全仓仅此一处，写在它自己的注释里。
   */
  readonly raw: unknown;
  end(): Promise<void>;
}

/** 票已经拿到手之后剩下的两件事。心跳的**调度**不在这里（引擎自己按 `LOCK_HEARTBEAT_INTERVAL_MS` 排）。 */
export interface LockHandle {
  beat(): Promise<'renewed' | 'lost'>;
  release(): Promise<void>;
}

/**
 * 会话的全部外部依赖。`owner`（`机器名:pid`）与 `newLockTicket` 都不在这里：拼票是 `ipc-persist.ts`
 * 的事，session 连 `node:os` 都不许碰（P-2 + `persist-boundary.test.ts` 那一格）。
 */
export interface PersistPorts {
  readonly userDataDir: string;
  readonly timer: SaveTimer;
  /** 没配好就抛（T8 的实现读环境变量）。抛 ⇒ `'not-configured'`，且**不建连接**。 */
  loadConfig(): MysqlEnv;
  openDb(env: MysqlEnv, projectId: EntityId): Promise<DbHandle>;
  /** `null` = 没拿到（`'busy'` 或 `'no-project'`）⇒ 只读打开（第 ⑤ 段）。 */
  acquire(db: DbHandle, projectId: EntityId): Promise<LockHandle | null>;
  readEmergency(userDataDir: string, projectId: EntityId): EmergencyRef[];
  /** 原样转交：session 不数件、不碰 fs，"抢救过几份"这件事的读者是下一次 `open` 的 `readEmergency`。 */
  writeEmergency(payload: EmergencyPayload): void;
  emitStatus(status: SaveStatus): void;
}

export class SessionError extends Error {
  constructor(
    readonly code: PersistErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

/**
 * 一条规则，不是两个调用点（第 ③ 段）。mysql2 抛的错一律带 `code`（`ER_*` / `PROTOCOL_CONNECTION_LOST`
 * / `ECONNREFUSED`）⇒ `'db'`，下一步是"查服务"；不带 `code` 的都是我们自己抛的
 * （T5 的三方对账不平、T5 的 `loadProject` 拒开、T4 的归属守卫）⇒ `'reconcile'`，下一步是"先别再写"。
 */
function persistErrorCode(err: unknown): PersistErrorCode {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code.length > 0 ? 'db' : 'reconcile';
}

/**
 * 各步失败的统一包装：**端口自己已经定了码 ⇒ 原样上抛**，其余的按"这一步默认是什么错"包一层。
 * 为什么需要这一条：`openDb` 里会顺手校验 `actor` 长度（T4 的仓库尺），那一发不是"连不上库"；
 * T9 的 `loadConfig` 会区分"没配"与"解不开已存的配置"。没有这条通道，端口只能把已经查清的结论
 * 降级成一个 `RangeError`，再被下一步的默认码重新解释一遍 —— 那是把事实丢了两次。
 */
function wrap(err: unknown, code: PersistErrorCode, prefix: string): SessionError {
  return err instanceof SessionError ? err : new SessionError(code, `${prefix}：${describeError(err)}`);
}

/**
 * 给 `flush()` 套上限。超时**不取消** `flush`（Promise 取消不了，队列也还在跑），只是让调用方能立刻拆会话：
 * `stop()` 撤掉链上的定时器，`db.end()` 掐了在途连接。
 * 返回 `null` 而不是抛一个自定义 Error：一支路一个形状，读的人不必先认识一个新类型。
 */
async function withTimeout(
  promise: Promise<SaveStatus>,
  ms: number,
  timer: SaveTimer,
): Promise<SaveStatus | null> {
  let handle: TimerHandle | undefined;
  const timeout = new Promise<null>((resolve) => {
    // executor 是同步跑的，所以这里 `handle` 一定有值 —— 但 TS 看不见这件事，故用 `?.`。
    handle = timer.schedule(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    handle?.cancel();
  }
}

/**
 * 一个窗口 ↔ 一个工程 ↔ 一份会话（spec §4.3，第 ⑩ 段）。
 * main 不持文档（P-9）：这里的 `Document` 全是**借来的** —— `open` 从仓库借一份发给屏幕，
 * `submit`/`close` 从屏幕借一份交给引擎/对账，每个方法返回时一个都不留在字段上。
 */
export class ProjectSession {
  private db: DbHandle | null = null;
  private lock: LockHandle | null = null;
  private autosave: Autosave | null = null;
  private projectId: EntityId | null = null;
  private openDecision: OpenDecision = 'read-only';
  /**
   * 已经**发出去**的号，不是已经落盘的号（第 ① 段）。为什么不能读 `autosave.status().lastTurn`：
   * 那一个字段是 `landedTurn`，队列里排上但还没写完的发在它上面看不见 ⇒ 下一发会拿到重复的号，
   * 而重复号在 `uk_project_turn` 那条支路上被吞成 `already-applied` = 静默丢失。
   */
  private issuedTurn = 0;

  constructor(private readonly ports: PersistPorts) {}

  get active(): boolean {
    return this.projectId !== null;
  }

  /** 没有会话 ⇒ `null`，而不是猜一个默认值：横幅与 `reopenAsEdit` 都要能区分"没开"和"开成只读"。 */
  get decision(): OpenDecision | null {
    return this.projectId === null ? null : this.openDecision;
  }

  status(): SaveStatus | null {
    return this.autosave?.status() ?? null;
  }

  async open(projectId: EntityId): Promise<OpenValue> {
    if (this.projectId !== null) {
      throw new SessionError('session', `会话已经开在工程 ${this.projectId} 上：先关再开（第 ⑩ 段）`);
    }
    let env: MysqlEnv;
    try {
      env = this.ports.loadConfig();
    } catch (err) {
      // 这一支**没有** try 里的 teardown：此刻一个资源都没拿到手，多拆一次就会把"谁分配了谁释放"搅浑。
      throw wrap(err, 'not-configured', '连接配置读不出来');
    }
    let db: DbHandle;
    try {
      db = await this.ports.openDb(env, projectId);
    } catch (err) {
      throw wrap(err, 'db', '连不上库');
    }
    // 状态先落地再往下走：下面任何一步抛，都按同一套顺序拆（`teardown` 只认字段，不认参数）。
    this.db = db;
    this.projectId = projectId;
    let lock: LockHandle | null;
    try {
      lock = await this.ports.acquire(db, projectId);
    } catch (err) {
      await this.teardown();
      throw wrap(err, persistErrorCode(err), '拿锁这一发本身坏了');
    }
    const intent: OpenIntent = lock === null ? 'read' : 'edit';
    let loaded: LoadOutcome;
    try {
      loaded = await db.repo.loadProject(intent);
    } catch (err) {
      await this.teardown();
      throw wrap(err, persistErrorCode(err), '读不出这份工程');
    }
    this.lock = lock;
    this.openDecision = lock === null ? 'read-only' : 'edit';
    this.issuedTurn = loaded.header.journalTurn;
    if (lock !== null) {
      this.autosave = new Autosave({
        sink: db.repo,
        timer: this.ports.timer,
        beat: () => lock.beat(),
        onStatus: (status) => this.ports.emitStatus(status),
        onEmergency: (payload) => this.ports.writeEmergency(payload),
        fromJournal: {
          lastTurn: loaded.header.journalTurn,
          snapshotTurn: loaded.snapshot?.turn ?? null,
          rowsSinceSnapshot: loaded.header.journalTurn - (loaded.snapshot?.turn ?? 0),
        },
      });
    }
    return {
      decision: this.openDecision,
      header: loaded.header,
      doc: payloadFromDocument(loaded.doc),
      snapshot: loaded.snapshot,
      replayed: loaded.replayed,
      emergency: this.ports.readEmergency(this.ports.userDataDir, projectId),
    };
  }

  submit(req: SubmitRequest): SubmitValue {
    const autosave = this.autosave;
    const projectId = this.projectId;
    if (autosave === null || projectId === null) {
      throw new SessionError('session', '这个会话是只读的（或已经关了）：屏幕上的改动不会进库');
    }
    if (req.projectId !== projectId) {
      throw new SessionError('session', `这发记在工程 ${req.projectId} 名下，会话开的是 ${projectId}`);
    }
    const state = autosave.status();
    if (state.phase === 'paused') {
      throw new SessionError(
        'session',
        `已经停写（${state.pauseReason ?? '原因未知'}）：请重开工程，不要在同一会话里续写（第 ⑤ 段）`,
      );
    }
    if (state.phase === 'stopped') {
      throw new SessionError('session', '保存引擎已停：这个会话正在收尾');
    }
    // 先解码，后取号。反过来 = 一个坏请求吃掉一个号 ⇒ 下一发 `appendJournal` 从此撞"跳号"永久拒收。
    const doc = documentFromPayload(req.doc, `IPC ${IPC.journalSubmit}`);
    if (doc.projectId !== projectId) {
      throw new SessionError(
        'session',
        `递来的文档签在 ${doc.projectId}，会话开的是 ${projectId}：一份状态不能同时是两个工程的现场`,
      );
    }
    // 这一行是**编译期**那道牙（T4 的 `decodePatch` 同一个写法）：`PatchShape → Patch` 漂了，
    // `tsc -p apps/desktop/tsconfig.json` 当场红，不用等运行时。
    const patch: Patch = req.patch;
    const turn = this.issuedTurn + 1;
    this.issuedTurn = turn;
    const outcome = autosave.submit({ turn, patch, doc });
    return { outcome, acceptedTurn: turn };
  }

  async close(req: CloseRequest): Promise<CloseValue> {
    const projectId = this.projectId;
    const db = this.db;
    if (projectId === null || db === null) {
      throw new SessionError('session', '没有开着的会话：这一发没有可收尾的账');
    }
    if (req.projectId !== projectId) {
      throw new SessionError('session', `要关的工程是 ${req.projectId}，会话开的是 ${projectId}`);
    }
    const autosave = this.autosave;
    if (req.mode === 'abandon' || autosave === null) {
      // 只读会话与 `abandon` 走同一条路：不 flush、不对账、**不写 `clean_shutdown`**（第 ⑤ 段）。
      // 只读那一支要是跑了 `closeProject`，就等于替上一个编辑者宣告"这库干净"，那是撒谎。
      await this.teardown();
      return { elementRows: null, storeyRows: null };
    }
    const doc = documentFromPayload(req.doc, `IPC ${IPC.projectClose}`);
    if (doc.projectId !== projectId) {
      throw new SessionError('session', `收尾递来的文档签在 ${doc.projectId}，会话开的是 ${projectId}`);
    }
    let drained: SaveStatus | null;
    try {
      drained = await withTimeout(autosave.flush(), CLOSE_FLUSH_TIMEOUT_MS, this.ports.timer);
    } catch (err) {
      // 引擎本该把库错吞进 `lastError`（T7 ⑨ 段），所以走到这里要么是接线错要么是链上漏了抛：
      // 码按同一条规则给，但**必须**拆会话 —— 不留半开的锁与池。
      await this.teardown();
      throw wrap(err, persistErrorCode(err), '收尾 flush 直接抛了');
    }
    if (drained === null) {
      await this.teardown();
      throw new SessionError(
        'db',
        `收尾 flush 在 ${CLOSE_FLUSH_TIMEOUT_MS}ms 内没跑完：最后几发没落，跳过对账（不等下去会把窗口卡死）`,
      );
    }
    if (drained.queuedTurns > 0 || drained.phase === 'paused') {
      await this.teardown();
      throw new SessionError(
        drained.phase === 'paused' ? 'session' : 'db',
        `还有 ${drained.queuedTurns} 发没进库（${drained.lastError ?? '无更多信息'}）：这次收尾不对账 —— ` +
          `库里缺最后几发时，文档↔element 必然不平，跑了只会把"没落盘"说成"账坏了"`,
      );
    }
    let report: CloseReport;
    try {
      // 顺序是**先对账再放锁**：反过来会给另一个人留出"我刚写完、他还没对账"的窗口。
      report = await db.repo.closeProject(doc);
    } catch (err) {
      await this.teardown();
      throw wrap(err, persistErrorCode(err), '收尾对账没过');
    }
    await this.teardown();
    return { elementRows: report.elementRows, storeyRows: report.storeyRows };
  }

  /**
   * 唯一的拆卸口：先拆引擎（它的 idle / retry / beat 三个定时器还在排），再放锁，最后关池。
   * 顺序不许改 —— 反过来就留下"锁还在、但已经没人管队列"的那一刻，而 `beat` 会拿着已释放的票去续期。
   * 解锁与关池的失败**只记不抛**：锁会自己过期（T6 的 `LOCK_TTL_MS`），而这一发的结论已经定了。
   */
  private async teardown(): Promise<void> {
    const autosave = this.autosave;
    const lock = this.lock;
    const db = this.db;
    this.autosave = null;
    this.lock = null;
    this.db = null;
    this.projectId = null;
    this.openDecision = 'read-only';
    this.issuedTurn = 0;
    const stopped = autosave?.stop();
    try {
      await lock?.release();
    } catch (err) {
      console.error(`[dajia] 解锁失败，等它自己过期：${describeError(err)}`);
    }
    try {
      await db?.end();
    } catch (err) {
      console.error(`[dajia] 连接池没关掉：${describeError(err)}`);
    }
    if (stopped !== undefined) this.ports.emitStatus(stopped);
  }
}
```

> `<待实测>` 三件：
> ① `header: loaded.header` 直接把 T5 的 `ProjectHeader` 交给 `ProjectHeaderWireSchema`（`persist-schema.ts` 出口那一步会验它）。两边五键同名同号，但 `journalTurn` 若以 `string`（BIGINT 越界的形状，T4 P-17）回来，出口的 `SafeCountSchema` 会红 —— **那是故意的**，越界的账不许过界，把实测读数写进回填。
> ② `snapshot: loaded.snapshot` 与 `replayed: loaded.replayed` 同理靠结构对得上；若 T5 的字段名或可空性与 wire 不一致，红的第一个位置是 `apps/desktop/tsconfig.json` 那一发 `tsc`（不是运行时），按它订正 wire 或 T5 侧并写回填。
> ③ `state.phase === 'stopped'` 那一支：`stop()` 之后 `autosave` 字段已被置 `null`，所以正常路径走不到它，它防的是"将来有人把 `teardown` 拆成两步"。**这一支没有格打得到**（登记的限度，Step 8 汇总）。

**③ `apps/desktop/test/unit/session.test.ts`（16 格，全假把式：零 mysql2、零 electron、零 fs）**

```ts
import { describe, expect, it } from 'vitest';
import {
  Document,
  SCHEMA_VERSION,
  type Entity,
  type EntityId,
  type Patch,
  type PointEntity,
} from '@dajia/core';
import { type CloseRequest, type EmergencyRef, type SubmitRequest } from '@dajia/protocol';
import {
  CLOSE_FLUSH_TIMEOUT_MS,
  ProjectSession,
  SessionError,
  type DbHandle,
  type LockHandle,
  type PersistPorts,
  type SessionRepo,
} from '../../src/main/persist/session';
import type {
  CloseReport,
  JournalEntry,
  JournalOutcome,
  LoadOutcome,
  OpenIntent,
} from '../../src/main/db/repository';
import type { MysqlEnv } from '../../src/main/db/env';
import type { EmergencyPayload, SaveStatus } from '../../src/main/persist/autosave';
import { documentFromPayload, payloadFromDocument } from '../../src/shared/document-wire';
import { FakeTimer, tick } from './fake-timer';

const PID = '0193aa00-0000-7000-8000-00000000000a';
const OTHER = '0193aa00-0000-7000-8000-00000000000c';
const S1 = '0193aa00-0000-7000-8000-000000000001';
const P1 = '0193aa00-0000-7000-8000-000000000002';

const point: PointEntity = { kind: 'point', id: P1, storeyId: S1, x: 1000, y: 0 };
const DOC = Document.replaceEntities(
  Document.create(PID, SCHEMA_VERSION),
  new Map<EntityId, Entity>([[P1, point]]),
);

/** 假把式的 env：这个文件零 mysql2，它只是 `loadConfig` 的返回值形状，永远不会被拨号。 */
const FAKE_ENV: MysqlEnv = {
  host: 'example.invalid',
  port: 3306,
  user: 'fake',
  password: 'fake',
  database: 'dajia_test',
};

const patchOf = (x: number): Patch => ({
  upsert: [{ ...point, x }],
  remove: [],
});

const submitReq = (projectId: EntityId, doc: Document): SubmitRequest => ({
  projectId,
  patch: patchOf(1000),
  doc: payloadFromDocument(doc),
});

const closeReq = (projectId: EntityId, doc: Document, mode: 'graceful' | 'abandon'): CloseRequest => ({
  projectId,
  doc: payloadFromDocument(doc),
  mode,
});

/**
 * 一发真账的形状：补丁把 P1 的 x 改成 `x`，文档就是改完之后的样子。
 * 两边对不上也没人查（引擎不看内容，`closeProject` 的三方对账才看），
 * 但假把式里写一致可以省掉一格"到底是哪一侧漂了"的排查。
 */
const docAt = (x: number): Document =>
  Document.replaceEntities(
    Document.create(PID, SCHEMA_VERSION),
    new Map<EntityId, Entity>([[P1, { ...point, x }]]),
  );

const submitAt = (x: number): SubmitRequest => ({ projectId: PID, patch: patchOf(x), doc: payloadFromDocument(docAt(x)) });

class FakeRepo implements SessionRepo {
  readonly appended: { turn: number; docCanonical: string; patch: Patch }[] = [];
  loadResult: LoadOutcome;
  loadThrows: Error | null = null;
  closeThrows: Error | null = null;
  failTurns = new Set<number>();
  hangAppends = false;

  /** 时间线**只有一个**：`calls` 由 harness 传进来，与 `FakeLock`、`PersistPorts` 三个假把式共用同一根针。 */
  constructor(readonly calls: string[]) {
    this.loadResult = {
      doc: DOC,
      header: {
        projectId: PID,
        name: '接线样例',
        schemaVersion: SCHEMA_VERSION,
        journalTurn: 7,
        wasCleanShutdown: true,
      },
      snapshot: { seq: 3, turn: 5 },
      replayed: { rows: 2, fromSeq: 4, toSeq: 5 },
    };
  }

  async appendJournal(entry: JournalEntry): Promise<JournalOutcome> {
    if (this.hangAppends) return new Promise<JournalOutcome>(() => {});
    if (this.failTurns.has(entry.turn)) {
      // 不带 `code` 是我们自己的抛；带 `code` 的那一型由格 12 用另一支假错打。
      throw new RangeError(`假故障：turn ${entry.turn} 写不进去`);
    }
    this.calls.push(`append:${entry.turn}`);
    this.appended.push({ turn: entry.turn, docCanonical: entry.doc.canonical(), patch: entry.patch });
    return 'applied';
  }

  async writeSnapshot(turn: number): Promise<void> {
    this.calls.push(`snapshot:${turn}`);
  }

  async loadProject(intent: OpenIntent): Promise<LoadOutcome> {
    this.calls.push(`load:${intent}`);
    if (this.loadThrows) throw this.loadThrows;
    return this.loadResult;
  }

  async closeProject(doc: Document): Promise<CloseReport> {
    // 文案只记"是不是同一份文档"：canonical 串太长，会把顺序判据读成噪音。
    this.calls.push(doc.canonical() === DOC.canonical() ? 'close:same' : 'close:other');
    if (this.closeThrows) throw this.closeThrows;
    return { elementRows: 4, storeyRows: 1 };
  }
}

class FakeLock implements LockHandle {
  outcome: 'renewed' | 'lost' = 'renewed';
  constructor(private readonly calls: string[]) {}

  async beat(): Promise<'renewed' | 'lost'> {
    this.calls.push('beat');
    return this.outcome;
  }

  async release(): Promise<void> {
    this.calls.push('release');
  }
}

function harness(over: {
  lock?: LockHandle | null;
  loadConfigThrows?: Error;
  openDbThrows?: Error;
  acquireThrows?: Error;
  emergency?: EmergencyRef[];
} = {}) {
  const calls: string[] = [];
  const repo = new FakeRepo(calls);
  const timer = new FakeTimer();
  const statuses: SaveStatus[] = [];
  const rescued: EmergencyPayload[] = [];
  const lock = over.lock === undefined ? new FakeLock(calls) : over.lock;
  const ports: PersistPorts = {
    userDataDir: '/tmp/dajia-session-test',
    timer,
    loadConfig() {
      calls.push('loadConfig');
      if (over.loadConfigThrows) throw over.loadConfigThrows;
      return FAKE_ENV;
    },
    async openDb(env, projectId) {
      calls.push(`openDb:${projectId}:${env.host}`);
      if (over.openDbThrows) throw over.openDbThrows;
      // `raw` 在这里没有含义：假把式不连库，session 也一个字段都不读它（第 ⑥ 段）。
      const db: DbHandle = { repo, raw: 'fake-pool', async end() { calls.push('end'); } };
      return db;
    },
    async acquire() {
      calls.push('acquire');
      if (over.acquireThrows) throw over.acquireThrows;
      return lock;
    },
    readEmergency(_userDataDir, projectId) {
      calls.push(`readEmergency:${projectId}`);
      return over.emergency ?? [];
    },
    writeEmergency(payload) {
      calls.push(`emergency:${payload.turn}`);
      rescued.push(payload);
    },
    emitStatus(status) {
      statuses.push(status);
    },
  };
  return {
    session: new ProjectSession(ports),
    repo,
    timer,
    lock,
    calls,
    statuses,
    rescued,
  };
}

/** 每格都从这里起步：一个开好的可写会话。 */
async function opened(h?: ReturnType<typeof harness>) {
  const ctx = h ?? harness();
  await ctx.session.open(PID);
  return ctx;
}
```

- [ ] **Step 3 续：16 格逐格落盘**

```ts
describe('open 的失败分型：每一步失败只报自己那一步，后一步零调用', () => {
  it('1. 配置读不出来 ⇒ not-configured，且一个连接都没建', async () => {
    const ctx = harness({ loadConfigThrows: new Error('缺 DAJIA_MYSQL_PASSWORD') });
    await expect(ctx.session.open(PID)).rejects.toMatchObject({ code: 'not-configured' });
    expect(ctx.calls.filter((c) => c.startsWith('openDb'))).toEqual([]);
    expect(ctx.session.active).toBe(false);
  });

  it('2. 连库失败 ⇒ db，且一次锁都没试过', async () => {
    const ctx = harness({ openDbThrows: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    await expect(ctx.session.open(PID)).rejects.toMatchObject({ code: 'db' });
    expect(ctx.calls).toEqual(['loadConfig', 'openDb:0193aa00-0000-7000-8000-00000000000a:example.invalid']);
    expect(ctx.session.active).toBe(false);
  });

  it('3. 读盘拒开（不带 code 的抛）⇒ reconcile；端口自己定了码 ⇒ 原样上抛、不被降级', async () => {
    const a = harness();
    a.repo.loadThrows = new RangeError('journal turn 跳号：盘上记到 3，这发要写 5');
    await expect(a.session.open(PID)).rejects.toMatchObject({ code: 'reconcile' });
    expect(a.calls).toContain('release');
    expect(a.calls).toContain('end');
    expect(a.session.active).toBe(false);

    // `wrap` 的那条通道：端口已经查清的结论不许被下一步的默认码重说一遍
    // （没有这一支，T9 的"配置解不开"到了横幅上就会变成"连不上库"）。
    const b = harness({ acquireThrows: new SessionError('bad-request', '假把式：这台机器名太长') });
    await expect(b.session.open(PID)).rejects.toMatchObject({ code: 'bad-request' });
    expect(b.calls).toContain('release');
    expect(b.session.active).toBe(false);
  });
});

describe('open 的两条岔路', () => {
  it('4. 拿到票 ⇒ edit、loadProject("edit")、引擎起来了，且 fromJournal 三格读数来自库里那份头', async () => {
    const ctx = await opened();
    expect(ctx.session.decision).toBe('edit');
    expect(ctx.calls).toContain('load:edit');
    const status = ctx.session.status();
    expect(status).not.toBeNull();
    expect(status?.phase).toBe('idle');
    // journalTurn=7 而快照在 5 ⇒ 阈值计数器从 2 起算，不是从 0（"每 2000 条"在重启之后还成立靠的就是这一格）
    expect(status?.snapshotTurn).toBe(5);
    expect(status?.rowsSinceSnapshot).toBe(2);
    expect(status?.lastTurn).toBeNull();
  });

  it('5. 拿不到票 ⇒ read、loadProject("read")、没有引擎，submit 一律 session', async () => {
    const ctx = harness({ lock: null });
    const value = await ctx.session.open(PID);
    expect(value.decision).toBe('read-only');
    expect(ctx.session.decision).toBe('read-only');
    expect(ctx.calls).toContain('load:read');
    expect(ctx.session.status()).toBeNull();
    try {
      ctx.session.submit(submitReq(PID, DOC));
      expect.unreachable('只读会话的 submit 必须抛');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionError);
      expect((err as SessionError).code).toBe('session');
    }
  });

  it('6. 回包逐字段同源：doc 往返不漂、snapshot/replayed 原样、emergency 来自 readEmergency', async () => {
    const refs: EmergencyRef[] = [{ turn: 4, path: '/tmp/dajia-session-test/emergency/a.json' }];
    const ctx = harness({ emergency: refs });
    const value = await ctx.session.open(PID);
    expect(documentFromPayload(value.doc, 'test').canonical()).toBe(DOC.canonical());
    expect(value.header).toEqual({
      projectId: PID,
      name: '接线样例',
      schemaVersion: SCHEMA_VERSION,
      journalTurn: 7,
      wasCleanShutdown: true,
    });
    expect(value.snapshot).toEqual({ seq: 3, turn: 5 });
    expect(value.replayed).toEqual({ rows: 2, fromSeq: 4, toSeq: 5 });
    expect(value.emergency).toEqual(refs);
    expect(ctx.calls).toContain(`readEmergency:${PID}`);
  });

  it('7. 会话还开着时二开 ⇒ session，并且现有会话一个资源都没动', async () => {
    const ctx = await opened();
    const before = [...ctx.calls];
    await expect(ctx.session.open(OTHER)).rejects.toMatchObject({ code: 'session' });
    // 调用序列一字没动 ⇒ 没有 second openDb / acquireLock / loadProject，也没有把现有会话的锁放了
    expect(ctx.calls).toEqual(before);
    expect(ctx.calls).not.toContain('release');
    expect(ctx.calls).not.toContain('end');
    expect(ctx.session.active).toBe(true);
  });
});

describe('submit：取号纪律（第 ① 段的全部牙）', () => {
  it('8. 连投三发 ⇒ 8、9、10（起点来自库里的 journalTurn=7），且补丁与文档原样到 sink', async () => {
    const ctx = await opened();
    const turns: number[] = [];
    for (const x of [1000, 2000, 3000]) {
      turns.push(ctx.session.submit(submitAt(x)).acceptedTurn);
    }
    expect(turns).toEqual([8, 9, 10]);
    await tick();
    expect(ctx.repo.appended.map((a) => a.turn)).toEqual([8, 9, 10]);
    expect(ctx.repo.appended[0]?.docCanonical).toBe(docAt(1000).canonical());
    expect(ctx.repo.appended[2]?.patch.upsert[0]?.kind).toBe('point');
  });

  it('9. 坏 payload 吃掉一个号 = 永久跳号，所以解码必须在取号之前', async () => {
    const ctx = await opened();
    const bad = payloadFromDocument(DOC);
    const dup = { ...bad, entities: [...bad.entities, bad.entities[0] as (typeof bad.entities)[number]] };
    expect(() => ctx.session.submit({ projectId: PID, patch: patchOf(1000), doc: dup })).toThrow(
      /出现两次：一份快照不许有重复 id/,
    );
    // 号没有被吃掉：下一发仍然是 8。这一格是"坏请求不吃号"的唯一证人。
    expect(ctx.session.submit(submitReq(PID, DOC)).acceptedTurn).toBe(8);
  });

  it('10. 工程号对不上、文档签名对不上 ⇒ session，且都不消耗号', async () => {
    const ctx = await opened();
    expect(() => ctx.session.submit(submitReq(OTHER, DOC))).toThrow(/记在工程/);
    const otherDoc = Document.replaceEntities(
      Document.create(OTHER, SCHEMA_VERSION),
      new Map<EntityId, Entity>([[P1, point]]),
    );
    expect(() => ctx.session.submit(submitReq(PID, otherDoc))).toThrow(/一份状态不能同时是两个工程的现场/);
    expect(ctx.calls.filter((c) => c.startsWith('append'))).toEqual([]);
    expect(ctx.session.submit(submitReq(PID, DOC)).acceptedTurn).toBe(8);
  });

  it('11. 写失败 ⇒ 抢救件原样转交；丢锁 ⇒ 停写，此后 submit 报 session，且号一个都不许回收', async () => {
    const ctx = await opened();
    ctx.repo.failTurns = new Set([8]);
    ctx.session.submit(submitReq(PID, DOC));
    await tick();
    expect(ctx.rescued.length).toBe(1);
    expect(ctx.rescued[0]?.turn).toBe(8);
    expect(ctx.rescued[0]?.projectId).toBe(PID);
    expect(ctx.session.status()?.phase).toBe('failed');
    (ctx.lock as FakeLock).outcome = 'lost';
    ctx.timer.advance(5_000);
    await tick();
    expect(ctx.session.status()?.phase).toBe('paused');
    expect(() => ctx.session.submit(submitReq(PID, DOC))).toThrow(/已经停写/);
    // 号不回退：停写之前已经发出去的是 8，恢复能力归"重开"，不归原地补号（第 ⑤ 段）
    expect(ctx.repo.appended.map((a) => a.turn)).toEqual([]);
  });
});

describe('close 的五种收场', () => {
  it('12. abandon ⇒ 不 flush、不对账、只拆；两格读数是 null 而不是 0', async () => {
    const ctx = await opened();
    const value = await ctx.session.close(closeReq(PID, DOC, 'abandon'));
    expect(value).toEqual({ elementRows: null, storeyRows: null });
    expect(ctx.calls.filter((c) => c.startsWith('append'))).toEqual([]);
    expect(ctx.calls).not.toContain('close:same');
    expect(ctx.calls).toContain('release');
    expect(ctx.calls).toContain('end');
    expect(ctx.session.active).toBe(false);
    expect(ctx.session.decision).toBeNull();
    expect(ctx.timer.pending()).toBe(0);
    expect(ctx.statuses.at(-1)?.phase).toBe('stopped');
  });

  it('13. 只读会话的 graceful ⇒ 与 abandon 同路，绝不替别人宣告这库干净', async () => {
    const ctx = harness({ lock: null });
    await ctx.session.open(PID);
    const value = await ctx.session.close(closeReq(PID, DOC, 'graceful'));
    expect(value).toEqual({ elementRows: null, storeyRows: null });
    expect(ctx.calls).not.toContain('close:same');
    expect(ctx.calls).toContain('release');
  });

  it('14. graceful 平账 ⇒ 顺序是 flush→closeProject→release→end；读数原样、定时器清零', async () => {
    const ctx = await opened();
    ctx.session.submit(submitReq(PID, DOC));
    await tick();
    const value = await ctx.session.close(closeReq(PID, DOC, 'graceful'));
    expect(value).toEqual({ elementRows: 4, storeyRows: 1 });
    const order = ctx.calls.filter((c) =>
      ['append:8', 'close:same', 'release', 'end'].includes(c),
    );
    expect(order).toEqual(['append:8', 'close:same', 'release', 'end']);
    expect(ctx.timer.pending()).toBe(0);
    expect(ctx.statuses.at(-1)?.phase).toBe('stopped');
  });

  it('15. 对账不平（不带 code 的抛）⇒ reconcile，且 closeProject 只试一次、照样拆干净', async () => {
    const ctx = await opened();
    ctx.repo.closeThrows = new RangeError('对账不平：element↔storey 少一行');
    await expect(ctx.session.close(closeReq(PID, DOC, 'graceful'))).rejects.toMatchObject({
      code: 'reconcile',
    });
    expect(ctx.calls.filter((c) => c === 'close:same')).toEqual(['close:same']);
    expect(ctx.calls).toContain('release');
    expect(ctx.calls).toContain('end');
  });

  it('16. flush 挂死（库不可达）⇒ 到 CLOSE_FLUSH_TIMEOUT_MS 报 db，窗口不许被卡住', async () => {
    const ctx = await opened();
    ctx.repo.hangAppends = true;
    ctx.session.submit(submitReq(PID, DOC));
    const closing = ctx.session.close(closeReq(PID, DOC, 'graceful'));
    // 拨到 10 秒会顺路敲一发心跳（5 秒那一档），但它**不会**留下第二个定时器：
    // `close` 的续体先跑 `stop()`，而 `scheduleBeat()` 第一行就是 `if (this.stopped) return`。
    // 于是下面那句 `pending()` 是 0 而不是 1 —— 读的人不必怀疑这一格会飘（T7 的 `stopped` 闸门在这里第二次上岗）。
    ctx.timer.advance(CLOSE_FLUSH_TIMEOUT_MS);
    await expect(closing).rejects.toMatchObject({ code: 'db' });
    expect(ctx.calls).toContain('release');
    expect(ctx.calls).toContain('end');
    expect(ctx.timer.pending()).toBe(0);
  });
});
```

**格数订正**：上面 1..16 分在四个 `describe` 里 —— 1、2、3 三格，4..7 四格，8..11 四格，12..16 五格 ⇒ 共 **16 格**。计划文本里原先写 14，本 chunk 与 t8a 的 Files 行、Step 3 标题已一并改成 16，理由：写的时候合了两格（"open 前置两步各自失败"），落地时又必须分开 —— `not-configured` 那条的判据是"`openDb` 零调用"（红线"没配好就不许连库"），`db` 那条的判据是"calls 逐字等于两步"，把它们并成一格会让其中一支红时读不出红在哪。Step 8 提交前按盘上实测重数一遍再填验收表（计划 3 的教训：席位被告知计划数会去追幻影差异）。

**夹具订正（同一处文本的两条判据都靠它）**：`FakeRepo` 的 `calls` 现在由 harness 传进来，与 `FakeLock`、`PersistPorts` 共用**同一根时间线针**。原先它自己持有一个数组，于是 `ctx.calls` 里永远看不到 `load:edit` / `append:8` / `close:same` —— 第 4、5 格的 `toContain` 会**假绿**（读不出红），第 12 格那条 `filter(startsWith('append'))` 更是"就算 flush 跑了也说没跑"，而第 14 格"flush→closeProject→release→end"的顺序判据直接立不起来。三件假把式共用一根针是这一族测试的全部价值所在：`toEqual([...])` 逐字比顺序，才读得出"少了一步"和"顺序反了"这两种不同的红。

Run: `npx vitest run apps/desktop/test/unit/session.test.ts apps/desktop/test/unit/document-wire.test.ts apps/desktop/test/unit/autosave.test.ts > tmp/t8-session.log 2>&1; echo "exit=$?"`
Expected: `exit=0`，三档共 `16 + 7 + 24` 格（24 那一档是搬假钟的"没丢东西"证人）。`npx tsc --noEmit -p apps/desktop/tsconfig.test.json` 同码必须 `exit=0`（`session.test.ts` 里那些 `as` 之外的类型都由它判）。

**这一档的两个已知薄弱点，写在这里而不是留给评审去抓**：
① 格 11 的"号一个都不许回收"只断到"停写前 append 是空的"，它没有断"重开之后 `issuedTurn` 与库里的 `journal_turn` 一致"—— 那是 `open` 的 `fromJournal` 读数（格 4）与重开路径（格 12 拆干净 + 下一次 `harness()`）拼起来才成立的主张，跨两格。真库那一头的凭据在 `test/db/autosave-journal.test.ts` 与 T4 的跳号那一格里，不在这里。
② `emitStatus` 在 `open` 那一刻会不会被调，本档**不主张**（T7 的 `report()` 时机是引擎内部的事）。格 12/14 只断"最后一发是 `stopped`"，用的就是 `statuses.at(-1)` 而不是 `statuses[0]` —— 前者不依赖引擎在构造时是否汇报过。

- [ ] **Step 4: 接线那一档 —— `listEmergency` + `ipc-persist.ts` + `main/index.ts` 两行 + 边界三格**

顺序是**先 fs 侧、再 electron 侧**：`ipc-persist.ts` 的 ports 要 import `listEmergency`，反过来不成立（emergency 不认识 electron 也不认识 session）。

**① `apps/desktop/src/main/persist/emergency.ts` 末尾追加**

```ts
/**
 * 抢救件的读侧形状。为什么**不** import protocol 的 `EmergencyRef`：这一族文件住在 fs 侧，
 * `{ turn, path }` 与那张表结构同型，直接写得让 fs 侧认识 protocol —— T9 换 wire 形状时就得改两个包。
 * 同一理由见 `EmergencyInput` 为什么比 `EmergencyPayload` 少一个 `patch`（T7 ⑨ 段）。
 */
export interface EmergencyFound {
  readonly turn: number;
  readonly path: string;
}

/**
 * 读出某个工程在盘上的现场，**按 turn 升序**（写侧的 `pruneEmergency` 是"新的在前"，因为裁剪要砍尾巴；
 * 读侧给横幅，升序才读得出"最新那一份是第几发"）。
 *
 * 除 `userDataDir` 为空串那一刀（`emergencyDir` 的参数守卫，与写侧同一把尺，**不吞** ——
 * 吞了就把"我们没接线"说成"盘上没有现场"），其余失败一律不抛：这一发发生在 `open` 的途中，
 * 读目录失败不能把"打开工程"整个拒掉。但**也不能悄悄返回空**：横幅上"有 K 发没进库"那句
 * 要是因为读不动就说成"没有"，那是这一族文件最不该撒的一句谎 —— 所以除 ENOENT 之外都 `console.error` 一声。
 */
export function listEmergency(userDataDir: string, projectId: EntityId): EmergencyFound[] {
  const dir = emergencyDir(userDataDir);
  const found: EmergencyFound[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as { code?: unknown }).code !== 'ENOENT') {
      console.error(`[dajia] 抢救件目录读不动，"有几发没进库"这一发只能空着：${describeError(err)}`);
    }
    return found;
  }
  for (const name of names) {
    const m = FILE_RE.exec(name);
    const stem = m?.[1];
    const rawTurn = m?.[2];
    // 词干直接等于要查的工程号：形状不认识与别人的文件都从这里出局（与 pruneEmergency 同一口径）。
    if (stem !== projectId || rawTurn === undefined) continue;
    const turn = Number(rawTurn);
    if (!Number.isSafeInteger(turn) || turn < 1) continue;
    found.push({ turn, path: join(dir, name) });
  }
  return found.sort((a, b) => a.turn - b.turn);
}
```

`projectId` 在这里**不做** `isEntityId` 守卫：它是筛选键而不是路径片段（写侧那一刀的理由是"串要进文件名"，读侧没有这件事），非法号自然匹配不到任何东西。调用方递来的号已经过 `parseOpenRequest`（`EntityIdSchema`）。

`apps/desktop/test/unit/emergency.test.ts` 的改动有**两**处：把 import 名单里的 `writeEmergencySnapshot` 那一族加上 `listEmergency`，`vitest` 那一行加上 `vi`（第二格要 spy `console.error`）；然后在文件末尾追加下面这个 `describe`。**六个原有格子与它们的判据一字不动**，`dir` / `dirB` 也不共用 —— 新格子自己造临时目录，否则"几份现场"这个数会被别的格子的写入污染（T7 那 6 格在同一个 `dir` 里反复写）。

```ts
describe('listEmergency：把盘上的现场读回横幅（T8 的唯一读者）', () => {
  // 本 describe 自己的目录：计数类判据不能依赖别的 describe 写过几份。
  let dirC = '';
  beforeAll(() => {
    dirC = mkdtempSync(join(tmpdir(), 'dajia-emergency-list-'));
  });
  afterAll(() => {
    rmSync(dirC, { recursive: true, force: true });
  });

  it('按 turn 升序给出本工程的每一份；别人的、形状不认识的一个都不许混进来', () => {
    // 故意倒着写，而且**最大那份用两位数（10）而不是个位数**：个位数时文件名序与数值序同序
    //（写 9、4、7 读出来就是 4、7、9），"按 turn 升序排"这一发被删掉也照样绿 —— 那一版的这一格只证了 `readdirSync` 的恩赐。
    // 有了 10，`[..., '-turn-10.json', ..., '-turn-4.json', ...]` 与 `[4, 7, 10]` 是两串不同的数，
    // 于是 `found.sort((a, b) => a.turn - b.turn)` 那一句有了能红的判据（变异表 T8-M12）。
    for (const turn of [10, 4, 7]) {
      const w = writeEmergencySnapshot(dirC, {
        projectId: PID_A,
        turn,
        error: '写库失败',
        doc: Document.create(PID_A),
      });
      if (!w.ok) throw new TypeError(`夹具塌了：${w.error}`);
    }
    const other = writeEmergencySnapshot(dirC, {
      projectId: PID_B,
      turn: 1,
      error: '写库失败',
      doc: Document.create(PID_B),
    });
    if (!other.ok) throw new TypeError('夹具塌了：别人的那一份也没写成');
    // 两个"长在这儿但不是现场"的文件：形状不对的（词干非 UUIDv7）与根本不是这族名字的。
    const subdir = join(dirC, EMERGENCY_DIR_NAME);
    writeFileSync(join(subdir, 'notes.txt'), '不是现场', 'utf8');
    writeFileSync(join(subdir, 'bogus-turn-5.json'), '{}', 'utf8');

    const found = listEmergency(dirC, PID_A);
    expect(found.map((f) => f.turn)).toEqual([4, 7, 10]);
    expect(found[0]?.path).toBe(join(subdir, `${PID_A}-turn-4.json`));
    // path 不是装饰：它是能打开的绝对路径，且开出来就是那份 envelope（横幅要给人抄去查）。
    for (const f of found) {
      expect((JSON.parse(readFileSync(f.path, 'utf8')) as { kind: unknown }).kind).toBe(
        'dajia.emergency.v1',
      );
    }
    // 分桶在读侧也成立：B 只看得到自己那一份，A 的三份一份都不许挂到 B 名下。
    expect(listEmergency(dirC, PID_B).map((f) => f.turn)).toEqual([1]);
  });

  it('目录不存在 ⇒ 空且不吭声；读盘真失败 ⇒ 空 + 一声 console.error（不许谎报"没有现场"）', () => {
    // ENOENT 是每个新工程的正常第一面：喊一声等于把噪音做成功能。
    expect(listEmergency(join(dirC, 'never-created'), PID_A)).toEqual([]);

    // "真失败"那一支要造的是**非 ENOENT** 的读盘失败，而形状要挑稳的：把 `emergency` 那一层本身
    // 做成一个普通文件 ⇒ `readdirSync` 直接落在文件节点上，两个平台都给 ENOTDIR。
    // （另一条写法 —— 把 `userDataDir` 指到一个普通文件、靠 `…/a-file/emergency` 去找 —— 不选它：
    // 那要走"祖先不是目录"的映射，Windows 上给的是 ENOENT，会被上面那一支吞掉，
    // 于是这一格在一台机器上绿、在另一台上绿得没有意义。
    // 本机 2026-10-03 实测（探针 `.superpowers/sdd/…/probe-enotdir.mjs`，留在本计划的 git-ignored 工作区里）：
    // `readdirSync(普通文件)` ⇒ `ENOTDIR`，`readdirSync(普通文件 + '/emergency')` ⇒ `ENOENT`。）
    const isolated = mkdtempSync(join(tmpdir(), 'dajia-emergency-eisdir-'));
    const logged: unknown[][] = [];
    try {
      writeFileSync(join(isolated, EMERGENCY_DIR_NAME), 'x', 'utf8');
      const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
      try {
        expect(listEmergency(isolated, PID_A)).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
    expect(logged.length).toBe(1);
    expect(String(logged[0]?.[0])).toMatch(/读不动/);

    // 第三条：空 userDataDir 那一刀**不吞**（参数守卫与写侧同一把尺）。
    expect(() => listEmergency('', PID_A)).toThrow(/不能是空串/);
  });
});
```

**② `apps/desktop/src/main/ipc-persist.ts`**

本文件是 T8 唯一新增的、许 import `electron` 的 main 文件（第 ⑥ 段），也是**唯一**许认识 mysql2 连接本体的地方 —— ports 那张表（`DbHandle.raw: unknown`）就是为它留的向下转型位。

```ts
import { hostname } from 'node:os';
import { app, ipcMain, type BrowserWindow, type WebContents } from 'electron';
import type { Pool } from 'mysql2/promise';
import {
  INVOKE_CHANNELS,
  IPC,
  SAVE_STATUS_EVENT,
  parseCloseRequest,
  parseCloseValue,
  parseOpenRequest,
  parseOpenValue,
  parseSaveStatus,
  parseSubmitRequest,
  parseSubmitValue,
  type IpcChannel,
  type IpcResult,
  type PersistErrorCode,
  type PersistFail,
  type SaveStatusWire,
} from '@dajia/protocol';
import type { EntityId } from '@dajia/core';
import { readMysqlEnv, type MysqlEnv } from './db/env';
import { createDbPool } from './db/pool';
import { migrate } from './db/migrate';
import { acquireLock, heartbeat, newLockTicket, releaseLock, type LockTicket } from './db/locks';
import { ProjectRepository } from './db/repository';
import { realTimer, type EmergencyPayload, type SaveStatus } from './persist/autosave';
import { describeError } from './persist/describe-error';
import { listEmergency, writeEmergencySnapshot } from './persist/emergency';
import {
  ProjectSession,
  SessionError,
  type DbHandle,
  type LockHandle,
  type PersistPorts,
} from './persist/session';

/**
 * 锁的归属串 = `机器名:pid`。两个读者：`project.lock_owner`（VARCHAR(200)，横幅上直接显示的那一行）
 * 与 `command_log.actor`（VARCHAR(64)，谁的哪一号进程写的这发账）。**同一个串**：
 * 分成两份就会漂（"锁在我这儿、账不是"这种现场没法读），而它的上限检查交给各自那把尺
 * （`newLockTicket` 管 200，`ProjectRepository` 管 64），这里不留第二份数（P-4 口径）。
 */
function lockOwner(): string {
  return `${hostname()}:${process.pid}`;
}

/** 当前要送状态的窗口。S1 一个窗口一个工程（第 ⑩ 段），所以是一个，不是一张表。 */
let target: WebContents | null = null;
let session: ProjectSession | null = null;

// —— 三条端口实现（session.ts 不认识 electron / fs / mysql2，全部从这里进来）——

/**
 * 迁移跑在**临时连接**上：一个 `.sql` 版本里是多条 DDL，只有迁移连接开 `multipleStatements`
 * （T2 在 `pool.ts` 的原话，P-17 又钉过那句注释"业务连接永远不开"不许删）。
 * 所以这里确实是两个池：迁完立刻 `end()` 掉那一个，留给会话的永远是不开多语句的这一份。
 *
 * 每次开工程都跑一遍 `migrate`：幂等（已应用的版本读校验和比对，一致就跳过），而 T9 的
 * 建库向导也跑同一条 —— 双跑无害。失败**原样上抛**：连接类失败由 session 包成 `'db'`，
 * 而迁移正文被改过那一抛是 `RangeError`，同样落进 `'db'`。码的口径是"去检查数据库那一侧"，
 * 这个场景下成立（配置指错库 / 迁移文件被改过，两边都是库那一侧的事）。
 *
 * 登记的限度（写进 Step 8 那一族）：T8 **不建库**。`dajia` 库不存在时这一发抛 `ER_BAD_DB_ERROR`
 * ⇒ `'db'`，文案带原话；建库是 T9 连接向导的职责（那也是本计划唯一行使建库授权的地方）。
 */
async function openDb(env: MysqlEnv, projectId: EntityId): Promise<DbHandle> {
  const migration = createDbPool(env, { multipleStatements: true });
  try {
    await migrate(migration, env.database);
  } finally {
    // 关掉迁移连接。**不**把它的失败盖在 migrate 的失败上：migrate 已经抛了就先让它抛，
    // 这里只保证一条 —— 抛出去的那个 `DbHandle` 一个都没留下，连接不漏。
    await migration.end().catch(() => undefined);
  }
  const pool = createDbPool(env);
  try {
    const repo = new ProjectRepository(pool, projectId, lockOwner());
    return { repo, raw: pool, end: () => pool.end() };
  } catch (err) {
    // 先关池再定码：仓库构造失败时池已经建好了（mysql2 的池是懒连接，但句柄在），
    // 不关就是每次重开漏一个池，漏到 connectionLimit 用尽时"连不上库"就不是配置错了，是我们漏的。
    await pool.end().catch(() => undefined);
    // 这一发只可能是仓库自己那把尺（`actor` 长度 1..64，`command_log.actor` 是 VARCHAR(64)）：
    // 池还没被用过，连接层不可能在这里说话。所以**就地定 'internal'**（我们的拼接错了），
    // 而不是让 session 把它包成默认的 'db' —— 那会把"屏幕上的 host:pid 太长"报成"去检查 MySQL 服务"。
    // 这正是 `session.ts` 里 `wrap` 那条"端口自己定了码 ⇒ 原样上抛"的直通通道在 T8 的真读者。
    throw new SessionError('internal', `仓库建不起来：${describeError(err)}`);
  }
}

/**
 * 拿票。`'busy'` 与 `'no-project'` 都返回 `null`（= 只读打开，第 ⑤ 段），**不抛**：
 * 那两种情形是"库里那一行让我只能读"，不是失败。各留一行日志，因为横幅上只显示"只读"，
 * 不显示为什么 —— 排查的人手里得有第二个来源。
 */
async function acquire(db: DbHandle, projectId: EntityId): Promise<LockHandle | null> {
  // 全仓仅此一次向下转型（`DbHandle.raw` 的注释里就写着这一条代价）：
  // session 那一侧必须不认识 Pool，否则 `persist/session.ts` 要 import mysql2，那 16 格就跑不进纯 node。
  const pool = db.raw as Pool;
  let ticket: LockTicket;
  try {
    ticket = newLockTicket({ projectId, owner: lockOwner() });
  } catch (err) {
    // 同样是"票还没拼出来，库一个字节都没动"：`newLockTicket` 那两把尺（projectId 形状 / owner ≤ 200）
    // 抛的是没有 `code` 的 `RangeError`，原样递到 session 会被 `persistErrorCode` 说成 `'reconcile'`
    // （"库里这份账不对，先别再写"）—— 那是把我们的拼接错误报成别人的账目问题。就地定 'internal'。
    throw new SessionError('internal', `锁票拼不出来：${describeError(err)}`);
  }
  const outcome = await acquireLock(pool, ticket);
  if (outcome !== 'acquired') {
    console.log(`[dajia] 锁没拿到（${outcome}），以只读打开工程 ${projectId}`);
    return null;
  }
  return {
    beat: () => heartbeat(pool, ticket),
    async release() {
      const result = await releaseLock(pool, ticket);
      if (result !== 'released') {
        // 'not-mine' = 锁已经被人接管。这不是"解锁失败"，是"我们已经没有那把锁了"：
        // 抛与不抛都是停手（引擎那边早按 'lost' 停了），但这句话必须留在 stdout，
        // 否则 T10 的双进程闸门红了只能看到"写不进去"。
        console.error(`[dajia] 解锁返回 ${result}：锁已被接管，等它自己过期`);
      }
    },
  };
}

/**
 * 事件方向的出站校验（③ 段：出站验值）。**不抛给引擎**：这一发跑在 `Autosave` 的 `onStatus` 钩子里，
 * 抛出会被 `drain` 当成"写库失败"记进 `lastError` —— 而坏掉的是我们的发送通路，不是数据库。
 * 宁可少报一次状态（横幅停在上一发，用户看得见它没动），也不谎报一次写失败。
 */
function emitStatus(status: SaveStatus): void {
  let wire: SaveStatusWire;
  try {
    wire = parseSaveStatus(SAVE_STATUS_EVENT, status);
  } catch (err) {
    console.error(`[dajia] 保存状态过不了自己的 schema：${describeError(err)}`);
    return;
  }
  if (target === null || target.isDestroyed()) return;
  target.send(SAVE_STATUS_EVENT, wire);
}

function writeEmergency(userDataDir: string, payload: EmergencyPayload): void {
  // 原样转交：`EmergencyInput` 比 `EmergencyPayload` 少一个 `patch`（抢救件保整份状态，T7 ⑨ 段），
  // 多余字段按结构赋值出局，这里不重组一份。
  const written = writeEmergencySnapshot(userDataDir, payload);
  if (!written.ok) {
    console.error(`[dajia] 抢救件没写成（${written.path ?? '路径也没算出来'}）：${written.error}`);
  }
}

// —— 分发：入站验请求、出站验值、错误码闭集 ——

/**
 * 会话之外的抛到这里为止。`SessionError` 是各步已经查清过的码，原样用；
 * `TypeError` 只有一个产地 —— protocol 那十个 `parse*` 出口（它们把 `ZodError` 收成一发 `TypeError`，
 * T3/T4 同一族），所以这一档就是"递来的东西形状不对" ⇒ `'bad-request'`。
 * 其余一律 `'internal'`：**默认档是"我们错了"，不是"归个类算了"**（③ 段：闭集里不留 `'unknown'` 的同一个理由）。
 *
 * 唯一的例外是**出站**那一发 `parseXValue`，它也抛 `TypeError` 却必须是 `'internal'` —— 所以它不换码，
 * 而是就地换成 `SessionError('internal', …)`（`parseOutbound`），这一档才不必靠上下文猜方向。
 */
function errorCode(err: unknown): PersistErrorCode {
  if (err instanceof SessionError) return err.code;
  if (err instanceof TypeError) return 'bad-request';
  return 'internal';
}

function fail(code: PersistErrorCode, message: string, channel: IpcChannel): PersistFail {
  if (code === 'internal') {
    // 'internal' 的下一步动作是"人来查"，而查的人只有 stdout：这一码必须同时留原文（③ 段）。
    console.error(`[dajia] ${channel} 报了 internal：${message}`);
  }
  return { ok: false, code, message };
}
function requireSession(): ProjectSession {
  if (session === null) {
    throw new SessionError('internal', '持久化通道在 registerPersistIpc 之前被调用了：窗口比端口早到');
  }
  return session;
}

/** 出站再验一次：`TypeError` 在这里的含义是"main 自己把回包拼错了"，与入站那一档相反。 */
function parseOutbound<T>(
  channel: IpcChannel,
  value: unknown,
  parse: (where: string, raw: unknown) => T,
): T {
  try {
    return parse(channel, value);
  } catch (err) {
    throw new SessionError(
      'internal',
      `main 自己拼的 ${channel} 回包过不了自己的 schema：${describeError(err)}`,
    );
  }
}

/**
 * 屏幕递来的那一份文档会在 `session.submit` / `session.close` 里解码（`documentFromPayload`），
 * 抛的是裸 `TypeError`（重复 id）或 `RangeError`（core 的逐实体 validate）—— **不是** `SessionError`，
 * 因为那一族码归会话（`session.test.ts` 第 9 格钉的就是解码失败不吃号、也不被会话包码）。
 * 到这一层只剩一个问题可答：这一发出自屏幕，还是出自 main？答案固定是"屏幕" ⇒ 就地定 `'bad-request'`，
 * 别让 `errorCode` 的默认档把"用户递错东西"说成"我们拼错了包"。
 *
 * 代价照登记：这一发同时把 submit/close 里**其它**没包码的抛也说成 bad-request。已查过的形状是
 * 会话剩下的每一发都自己定了码（`open` 的四步、`close` 的 flush 与对账），所以剩下的可能只剩"没见过的 bug" ——
 * 它的 message 仍带 `describeError` 原话，T9 的诊断按文本分诊，不被码骗。
 */
async function askSession<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof SessionError) throw err;
    throw new SessionError('bad-request', `递来的文档解不开：${describeError(err)}`);
  }
}

async function dispatch(channel: IpcChannel, raw: unknown): Promise<IpcResult<unknown>> {
  try {
    switch (channel) {
      case IPC.projectOpen: {
        const req = parseOpenRequest(channel, raw);
        // `open` 里没有 inbound 文档解码（它只读库），所以不套 `askSession`：
        // 它的每一步失败都已经在 session 里定过码了。
        const value = parseOutbound(channel, await requireSession().open(req.projectId), parseOpenValue);
        return { ok: true, value };
      }
      case IPC.journalSubmit: {
        const req = parseSubmitRequest(channel, raw);
        const reply = await askSession(() => requireSession().submit(req));
        return { ok: true, value: parseOutbound(channel, reply, parseSubmitValue) };
      }
      case IPC.projectClose: {
        const req = parseCloseRequest(channel, raw);
        const reply = await askSession(() => requireSession().close(req));
        return { ok: true, value: parseOutbound(channel, reply, parseCloseValue) };
      }
      default:
        // 名册与 switch 漂开时（加了通道没写 case）必须报"我们错了"，而不是 `undefined` 回包 ——
        // `ipc-channels.test.ts` 第 1 格也钉这一句，但那一格扫的是文本，这一句兜的是运行时。
        throw new SessionError('internal', `没有给通道 ${channel} 写过 case`);
    }
  } catch (err) {
    // 唯一的出口收窄点：任何异常都不许跨过 IPC（`invoke` 的 reject 到屏幕侧只是一个 Error，码与
    // 下一步动作全丢）。`describeError` 会读 `err.code`，所以 `SessionError` 的 message 长成
    // `SessionError(db): 连不上库：…` —— 前缀与 `code` 字段重复是**有意的**：横幅读字段，日志读文本。
    return fail(errorCode(err), describeError(err), channel);
  }
}

/**
 * 注册持久化通道。**必须在 `app.whenReady()` 之后**（`app.getPath('userData')` 的那条规矩）。
 * 形状照盘上现物那条 `ping`：`removeHandler` + `handle` 成对 ⇒ 重建窗口（`activate` 那一支）不残留旧 handler。
 * 没有 `before-quit` 握手（第 ⑦ 段：那一整块归 T11），所以关窗不会自动收尾 —— 锁等 TTL 过期，
 * 最后那次快照缺席 ⇒ 下次打开 `wasCleanShutdown === false`，那正是 spec §9 要人看见的恢复路径。
 */
export function registerPersistIpc(win: BrowserWindow): void {
  target = win.webContents;
  const userDataDir = app.getPath('userData');
  const ports: PersistPorts = {
    userDataDir,
    timer: realTimer,
    // 配置源是环境变量（④ 段：renderer 没有口令可交，T8 的通道里也不许出现口令）。
    loadConfig: () => readMysqlEnv(),
    openDb,
    acquire,
    readEmergency: listEmergency,
    writeEmergency: (payload) => writeEmergency(userDataDir, payload),
    emitStatus,
  };
  session = new ProjectSession(ports);
  for (const channel of INVOKE_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (_event, raw: unknown) => dispatch(channel, raw));
  }
}
```

三条判据形状在这一族里的落点，写下来免得评审去代码里找：`dispatch` 的 `catch` 是**唯一**的出口收窄点 —— 任何异常都不许跨过 IPC 边界（`ipcRenderer.invoke` 的 reject 在屏幕侧只是一个 `Error`，码与下一步动作全丢了，那正是 spec §9 要避免的形状）。`raw: unknown` 而不是 `any`：入站值在 `parse*` 之前必须是 `unknown`，否则"验过了"这件事没有凭据。

**③ `apps/desktop/src/main/index.ts` 的两行改动**

改动 1 —— import 块里 `import { IPC } from '@dajia/protocol';` 之后加一行：

```ts
import { registerPersistIpc } from './ipc-persist';
```

改动 2 —— `createWindow` 里那对 ping 注册（盘上现物 `apps/desktop/src/main/index.ts:40-41`）之后紧接一行：

```ts
  registerPersistIpc(win);
```

一字不动的部分要写清：**五段 shot 分支、`whenReady` 的参数守卫、菜单摘除时机、`createWindow` 的尺寸与 `webPreferences` 全都不碰**。为什么注册放在 `createWindow` 而不是 `whenReady` 的交互模式分支里：shot 模式也要走到注册（放在 `shotPath === null` 那一支之后会漏，而那一支之后是 `return`），而注册本身不动 DOM、不改窗口尺寸、不连库 —— `readMysqlEnv` 只在 `open` 真的被调用时才跑，`--shot` 的 renderer 一行 IPC 都不发（它没有 `window.dajia.openProject` 的调用点）。五道闸门的像素判据因此与注册前逐字节同；Step 8 由控制位原码复跑五道闸门把这件事变成读数，不是主张。

**④ `apps/desktop/test/unit/persist-boundary.test.ts` 追加三格**

改动有**三**处：`node:fs` 的 import 加 `readdirSync` 与 `join`（`node:path`）、`node:url` 的 `fileURLToPath` 已在；新增两个路径常量与一个递归列目录的辅助函数；末尾追加三个 `it`。**原有 2 格与判据一字不动**（T7 那一格钉的是 `autosave.ts`/`emergency.ts`/`describe-error.ts`，这一族钉的是 T8 新落地的三个文件 —— 两批判据不重叠，别"顺手合并"）。

```ts
// —— T8 追加的三格 ——

const SESSION = '../../src/main/persist/session.ts';

/** 目录名要用**绝对路径**读：`srcOf` 那一套 URL 解析给的是文件，不是目录。 */
const MAIN_ROOT = fileURLToPath(new URL('../../src/main', import.meta.url));
const RENDERER_ROOT = fileURLToPath(new URL('../../src/renderer', import.meta.url));

/** 递归列出目录下的 `.ts` / `.tsx`，返回**排序后的相对路径**。两格共用它，别在别处再写一份遍历。 */
function tsUnder(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...tsUnder(join(root, entry.name)).map((rel) => join(entry.name, rel)));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      // 两种后缀都要：`src/main/**` 今天只有 `.ts`，而 renderer 那一侧**全是 `.tsx`**
      // （App.tsx / PlanCanvas.tsx / panels.tsx）—— 只扫 `.ts` 的名单会把"屏幕侧的 protocol 值 import"
      // 全数漏过，而那正是这一格唯一的靶子。
      out.push(entry.name);
    }
  }
  return out.sort();
}

/**
 * 行级扫描：屏幕侧对 protocol 的 import 必须写成**一行** `import type { A, B } from '@dajia/protocol';`。
 * 多行写法（`import type {` 换行再 `} from '@dajia/protocol';`）会被这一格误红 ——
 * 这是这一族源码扫描已登记的共同限度（⑥ 段"注释里出现 `from 'electron'` 会误红"同族），
 * 换来的是扫描器不需要第二个依赖（AST 解析要装 typescript 到 devDeps，不值得）。
 */
function untypedProtocolImports(src: string): string[] {
  return src
    .split('\n')
    .filter((line) => line.includes("@dajia/protocol'") && !/^\s*import\s+type\s/.test(line));
}

describe('T8 的 import 边界：真把式只能住在 ipc-persist.ts', () => {
  it('session.ts 既不碰 electron / node:fs / node:os，也不 import mysql2', () => {
    const src = srcOf(SESSION);
    for (const banned of ["from 'electron'", "from 'node:fs'", "from 'node:os'", "from 'mysql2"]) {
      expect(src.includes(banned)).toBe(false);
    }
    // 正控制（注入通道确实在用）：缺任何一条，"端口表被绕过"就是这一格唯一会看见的时刻。
    expect(src.includes('this.ports.loadConfig')).toBe(true);
    expect(src.includes('this.ports.openDb')).toBe(true);
    expect(src.includes('this.ports.acquire')).toBe(true);
    expect(src.includes('this.ports.emitStatus')).toBe(true);
  });

  it('src/main/** 里认识 electron 的名单逐字等于 [index.ts, ipc-persist.ts]', () => {
    const hit = tsUnder(MAIN_ROOT).filter((rel) =>
      readFileSync(join(MAIN_ROOT, rel), 'utf8').includes("from 'electron'"),
    );
    // 名单比字面量：这条边界的价值在"没写进名单的那个文件就是漂移"，
    // 而 `length <= 2` 那种宽松判据会把"有人把 createDbPool 挪进 persist/config-store.ts"说成合规。
    // T9 的落盘结论（裁决 P-27）：`safeStorage` 的适配器住在本名单里**已有**的 ipc-persist.ts，
    // 没有人在 config-store.ts 里 import 它 —— 所以这一格一字未动，spec §8.2 的那条例外没有被启用。
    expect(hit).toEqual(['index.ts', 'ipc-persist.ts']);
  });

  it('屏幕侧对 @dajia/protocol 只许 type-only import（zod 不许进 renderer 的 bundle）', () => {
    // 先证扫描器自己会红：这一族扫描最怕的形状是"永远返回空数组"。
    expect(untypedProtocolImports("import { IPC } from '@dajia/protocol';")).toEqual([
      "import { IPC } from '@dajia/protocol';",
    ]);
    expect(untypedProtocolImports("import type { IPC } from '@dajia/protocol';")).toEqual([]);
    const files = tsUnder(RENDERER_ROOT);
    expect(files.length).toBeGreaterThan(0);
    for (const rel of files) {
      expect(untypedProtocolImports(readFileSync(join(RENDERER_ROOT, rel), 'utf8'))).toEqual([]);
    }
  });
});
```

为什么第三格必须存在（而"构建会挡住"这个说法是错的）：`@dajia/protocol` 在 `apps/desktop/package.json` 的 dependencies 里，vite 顺着 workspace link **解析得到**它 —— 屏幕侧写值 import 不会红，只会把 zod 一起打进 renderer 的 bundle，并且让"protocol 只住在有它的那个包"（T4 在 `entity-schema.ts` 顶部写的同一条理由）在屏幕上悄悄失效。所以这一条是**约定**，而约定的常驻证人只能扫文本。

Run: `npx vitest run apps/desktop/test/unit/emergency.test.ts apps/desktop/test/unit/persist-boundary.test.ts > tmp/t8-wiring.log 2>&1; echo "exit=$?"`
Expected: `exit=0`，`emergency.test.ts` **8 格**（T7 的 6 + 本步 2）、`persist-boundary.test.ts` **5 格**（T7 的 2 + 本步 3）。格数以盘上实测为准并把两个数写进回填；**计划数与实测数不一致时改计划文本**（计划 3 的教训：别让席位去追幻影差异）。

再单独量一次编译 —— `ipc-persist.ts` 没有 unit 格，它的三道凭据里编译期是头一道：

```bash
npx tsc --noEmit -p apps/desktop/tsconfig.json > tmp/t8-tsc-main.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`。三处最容易红的地方，先写在这里：`DbHandle.raw as Pool` 那一次向下转型；`readEmergency: listEmergency` 的结构赋值（`EmergencyFound[]` → `EmergencyRef[]`，两侧都是 `readonly` 两键）；`writeEmergencySnapshot` 吃 `EmergencyInput`（少 `patch`）而端口给的是 `EmergencyPayload` —— 结构赋值允许"多余字段"，但**只在对象字面量之外**允许，直接传 `payload` 变量成立，写成字面量展开就会被 excess property check 拦。

`ipc-persist.ts` 这一族**没有 unit 格**，凭据是三条而不是四条，登记清楚：① 编译期（上面那条 `tsc`）；② `ipc-channels.test.ts` 的三格源码扫（Step 5）；③ 五道闸门的原码复跑 + T10 的双进程闸门 + T11 的 `--persist-shot`（真把式只能在真环境里证，这正是 P-2 划界之后剩下的那一半，也是 `persist/**` 保持 electron-free 的全部理由）。限度照登记：本文件里的 ports 实现（`openDb` / `acquire` / `emitStatus` / `writeEmergency`）在纯 node 档不被调用，接线写错（比如把 `SAVE_STATUS_EVENT` 写成 `IPC.saveStatus` 之外的串）只有 T11 才看得见。

- [ ] **Step 5: preload 那一档 —— `DajiaApi` 五件 + `ipc-channels.test.ts` 3 格 + `App.tsx` 的类型**

**① `apps/desktop/src/preload/index.ts` 整文件替换**

```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  SAVE_STATUS_EVENT,
  type CloseRequest,
  type CloseValue,
  type IpcResult,
  type OpenValue,
  type SaveStatusWire,
  type SubmitRequest,
  type SubmitValue,
} from '@dajia/protocol';

/**
 * 屏幕能问 main 的全部事情。**没有一条是"直接写库"**：五个方法背后是三条请求通道 + 一条事件，
 * 参数与回包的形状全部由 `packages/protocol/src/persist-schema.ts` 定义（③ 段）。
 */
export interface DajiaApi {
  ping(): Promise<string>;
  /**
   * 参数写 `string` 而不是 `EntityId`：`EntityId = string` 无品牌（core 的 `ids.ts`），
   * 写两个名字等于让读的人多记一件事，而真正的形状检查在 main 的 `parseOpenRequest`。
   */
  openProject(projectId: string): Promise<IpcResult<OpenValue>>;
  submitJournal(request: SubmitRequest): Promise<IpcResult<SubmitValue>>;
  closeProject(request: CloseRequest): Promise<IpcResult<CloseValue>>;
  /** 返回注销函数：屏幕侧一份 store 一次订阅，撤干净是测试（每格一个 store）与 T11 的前提。 */
  onSaveStatus(listener: (status: SaveStatusWire) => void): () => void;
}

const api: DajiaApi = {
  // 这里的 `as` 是**声明**，不是校验。校验在 main 的出口那一发（`parseXValue`），
  // 而 preload 不可能再验一遍：`apps/desktop` 没有 zod 依赖，pnpm 的严格 node_modules 也解析不到
  // protocol 那一份（T4 写在 `entity-schema.ts` 顶部的同一条理由）。
  ping: () => ipcRenderer.invoke(IPC.ping) as Promise<string>,
  openProject: (projectId) =>
    ipcRenderer.invoke(IPC.projectOpen, { projectId }) as Promise<IpcResult<OpenValue>>,
  submitJournal: (request) =>
    ipcRenderer.invoke(IPC.journalSubmit, request) as Promise<IpcResult<SubmitValue>>,
  closeProject: (request) =>
    ipcRenderer.invoke(IPC.projectClose, request) as Promise<IpcResult<CloseValue>>,
  onSaveStatus: (listener) => {
    // 包一层再挂：`IpcRendererEvent` 不越过 contextBridge（那是 electron 的对象，屏幕侧拿到只会是噪音），
    // 也因为这个注销函数要把**同一个**引用交给 removeListener —— 直接挂 `listener` 就撤不掉。
    const wrapped = (_event: IpcRendererEvent, status: SaveStatusWire): void => {
      listener(status);
    };
    ipcRenderer.on(SAVE_STATUS_EVENT, wrapped);
    return () => ipcRenderer.removeListener(SAVE_STATUS_EVENT, wrapped);
  },
};

contextBridge.exposeInMainWorld('dajia', api);
```

**② `apps/desktop/src/renderer/src/App.tsx`：本 Step 一个字不动**

那块 `declare global { interface Window { dajia: DajiaApi } }`（盘上现物，必填）**不在这里改**，而是由 Step 6 ④ 段附带那一节整块搬进 `projectStore.ts` 并在那里改成可选。搬家而不是就地改的两条理由，写在那里，这里只留一条 Step 5 自己要紧的：

**本 Step 不许顺手把它改成可选。** 就地改会在 `App.tsx` 与 `projectStore.ts` 之间留下两次同名不同型的 `Window['dajia']` 声明 ⇒ `tsc` 报 TS2717，而它红在**这一族没打算碰的那份文件**里。Step 5 的编译判据（本节末那一发 `tsc -p tsconfig.json`）只覆盖 `src/main` / `src/preload` / `src/renderer/src`，红成那样的话读起来像"preload 写坏了"。

顺带交代判据为什么在这儿是"可选"这一族的前提：`readDajia()`（Step 6 落在 `projectStore.ts`）的 null 分支要有类型支撑。写必填就是在告诉每个读者"这里一定有"，于是 `window.dajia.openProject(...)` 直接落地；而 preload 一旦漏注入（打包路径写错那一型），真相是**横幅上什么都不显示 + 屏幕照常能画**，不是崩。可选之后每个调用点被迫先处理没有，而没有的那一支正好是第 ⑧ 段要求的"与没接持久化完全一致"的那一屏。

**③ `apps/desktop/test/unit/ipc-channels.test.ts`（3 格）**

为什么又一个文件只有 3 格：它盯的是**两个进程之间的名单对账**，不是任何一个函数的行为。`persist-schema.test.ts` 第 10 格钉的是"名册 == protocol 的通道全集"（包内自洽），这一格钉的是"名册在 main 与 preload **两边都有落点**"—— 后者只有跨文件扫描才看得见，而跨文件扫描混进那两个文件里都会变成"测试在测 import 语句"。

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INVOKE_CHANNELS, IPC, SAVE_STATUS_EVENT, type IpcChannel } from '@dajia/protocol';

const MAIN = '../../src/main/ipc-persist.ts';
const PRELOAD = '../../src/preload/index.ts';

function srcOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

/**
 * 通道在 `IPC` 表里的**键名**（`projectOpen`）。为什么不扫字符串值（`'dajia:project-open'`）：
 * 注册与订阅在源码里写的都是 `IPC.projectOpen`，扫值会把"硬编码那一条通道名"也算成合规 ——
 * 而硬编码正是这一格要避免的第二份产地。
 */
function keyOf(channel: IpcChannel): string {
  const key = Object.keys(IPC).find((k) => IPC[k as keyof typeof IPC] === channel);
  if (key === undefined) throw new Error(`通道 ${channel} 不在 IPC 表里：名册与表漂了`);
  return key;
}

describe('三条请求通道 + 一条事件的两端对账', () => {
  it('名册里每一条都在 main 有 case、在 preload 有 invoke（只改一边就红）', () => {
    const main = srcOf(MAIN);
    const preload = srcOf(PRELOAD);
    for (const channel of INVOKE_CHANNELS) {
      const key = keyOf(channel);
      expect(main.includes(`case IPC.${key}:`)).toBe(true);
      expect(preload.includes(`ipcRenderer.invoke(IPC.${key}`)).toBe(true);
    }
    // 正控制：名册悄悄变短（或为空）时上面那个循环一句都不断，这一行才是"扫过了三条"的凭据。
    expect(INVOKE_CHANNELS.length).toBe(3);
  });

  it('保存状态这条事件两头都在：main 发、preload 订，且给得出注销', () => {
    expect(srcOf(MAIN).includes('send(SAVE_STATUS_EVENT')).toBe(true);
    const preload = srcOf(PRELOAD);
    expect(preload.includes('ipcRenderer.on(SAVE_STATUS_EVENT')).toBe(true);
    // 注销不是装饰：一个 store 一份订阅（`createProjectStore` 在模块加载时挂一次，`reopenAsEdit()`
    // 不重挂 —— 它靠 `open()` 里那句 `save: null` 清场）。这份注销函数给的是 T8 测试与 T11 的前提：
    // `project-store.test.ts` 每格建一个 store，撤不干净就是往一份已经作废的 store 里写状态。
    expect(preload.includes('ipcRenderer.removeListener(SAVE_STATUS_EVENT')).toBe(true);
  });

  it('preload 一行数据库都不许碰（"renderer 永不接触数据库"的常驻证人）', () => {
    const preload = srcOf(PRELOAD);
    // 正控制先走一步：同一份文本里必须有 `ipcRenderer.invoke`，否则"没搜到"只说明读错了文件。
    expect(preload.includes('ipcRenderer.invoke')).toBe(true);
    for (const banned of ['mysql', 'node:fs', 'readFileSync', 'createPool', 'password']) {
      expect(preload.includes(banned)).toBe(false);
    }
  });
});
```

`'password'` 出现在最后那一格里是④段的另一半：`preload` 的**文本**里连这个键名都不许出现。**T9 落盘时的结论是这条禁令原样保留**（t9e 裁决 P-33）——`DajiaApi` 那五个新入口把口令藏在 `ConnectionInput` 这个**类型名**后面，键名在 preload 的文本里一次都不出现，所以"摘出来"这件事根本不需要发生。这里不留 TODO：下一位编辑者读到"必须单独摘出来"会照做，而把它摘掉的结果是给口令开一条没有证人的通路（④段那句"改判据由计划的作者先说清楚"管的正是这种时刻）。

限度照登记（这一族源码扫描的共同代价）：注释里写出被禁的那串就会误红 —— 本文件的注释用的是 `IPC.projectOpen` 与 `createDbPool`，不是被禁的字面量。`persist-boundary.test.ts` 那一族已按同一把尺登记过。

Run: `npx vitest run apps/desktop/test/unit/ipc-channels.test.ts apps/desktop/test/unit/session.test.ts > tmp/t8-preload.log 2>&1; echo "exit=$?"`
Expected: `exit=0`，`ipc-channels.test.ts` **3 格**、`session.test.ts` 的格数与 Step 3 结束时**同一个数**（16）。这一条跑的是"接线改到 preload 之后，会话那一档没被顺手碰坏"—— 它不是新判据，是复跑判据。

`npx tsc --noEmit -p apps/desktop/tsconfig.json` 同码必须 `exit=0`。**注意是哪一份 tsconfig**：盘上现物 `apps/desktop/tsconfig.node.json` 的 `include` 只有 `electron.vite.config.ts` 一个文件，`src/preload` 住在 `tsconfig.json` 的 `include`（Step 2 之后是 `["src/main", "src/preload", "src/shared", "src/renderer/src"]`；改前三样，盘上现物实测）里 —— 跑错那一份会得到 `exit=0` 而什么都没查（`IpcRendererEvent` 漏写成值 import 这种错只有 `verbatimModuleSyntax` 的那一侧看得见，而这一族错只有真编译过 preload 才看得见）。

- [ ] **Step 6: 屏幕那一档 —— `editorStore` 的换手与四处只读闸门 + `projectStore.ts` + 20 格（9 + 11）**

本步先记一条**改判**，因为它动的是计划 3 已经落地、五道闸门正踩在上面的语义；②～⑦ 才是这一档的代码。写完的顺序也照这个来：先改扳机（②③），再写读者（④），最后两档测试（⑥⑦）。

**①（裁决 P-21）`dispatchBatch` 从「一批只扳一次」改成「每应用一条扳一次」。**

盘上现物（`editorStore.ts` 的 `dispatchBatch` 末尾）是：应用完 N 条之后一发 `set`，注释写着「应用了几条就只 +1 一次 revision：扳机管的是'该重绘了'，不是'重绘几次'」。那句话在计划 3 是对的，因为那时候 `revision` 只有**一个**读者：`PlanCanvas` 的绘制 effect。计划 4 之后它有了第二个读者 —— `projectStore` 的订阅体（⑨段），而那个读者要的不是"该重绘了"，是**"有一条新账"**：它判的是 `log.lastPatch` 的对象身份。两件事在 `dispatch` 上恰好同频（一条命令 = 一次重绘 = 一发账），在 `dispatchBatch` 上**不同频**：

- 删除走的就是 `dispatchBatch`（N 面墙 + M 樘独立洞口 = N+M 条命令）。
- 循环里每条 `log.dispatch(cmd)` 都会换掉 `lastPatch`（T7 第 ① 段），但 `lastPatch` 是**覆盖式**的：循环结束时只剩最后那一条。
- 于是一批只扳一次 ⇒ 订阅体只看得到最后一发 ⇒ **前 N−1 发的补丁永远不会进 `command_log`**：屏幕上删掉了四件东西，库里只记了一件。下一次打开按 `snapshot + 流水` 重建，那三件东西又回来了。
- 这是本计划最恨的那一型（静默丢失），而且它**不抛任何东西**：`appendJournal` 收到的 turn 序列完全合法，T4 的跳号守卫与 T5 的三方对账都只能在对账那一刻才发现"库里少三行"。

改法是把 `set` 挪进循环（每应用成功一条扳一次），批尾只补那一格错误文案。撤销栈的语义一字不动（`S5` 早就写明"一次删除 = 栈上的 N+M 步"，连按 Ctrl+Z 一条条退），改的只是**通知次数**从 1 变成 N —— 而"每发账都要被通知一次"这件事本来就不是新增语义，是计划 3 那句注释在只有一个读者时侥幸成立的前提现在不成立了。

**为什么不许反过来在订阅体里补一条队列**（比如给 `editorStore` 加一个 `pendingPatches: Patch[]`）：那是把真源的流水挪进视图状态，而 `D4` 那条纪律（中途只活在 store 里、不进真源）反过来也成立 —— **进库的东西不许只活在 store 里**。队列要有幂等键就得用 turn，turn 又归 main 分配（P-18），于是屏幕侧要维护一个"已发但没确认"的窗口 —— 那正是 `Autosave` 已经在做的事，做第二份必然漂。让扳机每发一次，队列留在唯一的产地。

**代价照登记**：一次删除会重绘 N 次而不是 1 次（N 是那条批发的命令数，样例房里最大是 4：一面外墙 + 三樘窗 ⇒ 4 次 `buildDrawList` + 4 趟 `paint`）。同步 canvas 重绘在这个量级上是毫秒级，且五道闸门判的都是**终态**像素，不是重绘次数；Step 8 由控制位原码复跑五道闸门把它变成读数。**不许**为了"少重绘几次"把这一条改回去 —— 那等于用静默丢失换一次眨眼。

**② `apps/desktop/src/renderer/src/stores/editorStore.ts` 的五处改动**

除这五处以外一字不动（`DragState`、`viewportStoreyId` 的那段注释、`reportPaintError`、`dispatch` 的 try/catch 本体、`undo`/`redo` 的现物文案，全部保持原样）。

**改动 1 —— import 拆两行。** `TransactionLog` 现在只出现在类型位置（`readonly log: TransactionLog`），`loadProject` 要 `new` 它，于是它变成值 import；core 的 `Document` 是新的类型入参：

改前（第 3 行）：

```ts
import type { Command, TransactionLog, WallEnd } from '@dajia/core';
```

改后：

```ts
import type { Command, Document, WallEnd } from '@dajia/core';
import { TransactionLog } from '@dajia/core';
```

（`verbatimModuleSyntax` 要求这两行分开写：合成一行 `import { TransactionLog, type Document, ... }` 也编得过，但 `Document` 是纯类型、混进值 import 会让"这个文件真的依赖 core 的运行时"这件事看不清 —— 本文件确实依赖了，所以两行都比一行诚实。选拆两行是因为它同时把"哪些名字进了运行时"摊在纸面上，与 `document-wire.ts` 第 ② 段那个先例同形。）

**改动 2 —— `EditorState` 里加三格声明**（插在 `reportPaintError` 之后、`undo` 之前；顺序跟着"视图 → 换手 → 写"排）：

```ts
  /**
   * 只读闸门。`true` 时 `dispatch`/`dispatchBatch`/`undo`/`redo` 四个**写**动作一律只落
   * `lastError` 一个字节都不动真源 —— 视图动作（`setStorey`/`setViewport`/`setTool`/`setDraft`/
   * `setDrag`）不受它管：它们不改文档，挡住只是把"看"也一起废掉。
   *
   * 初始值 `false`：闸门环境里没人调 `setReadOnly`，那一屏与没接持久化时逐字节同（第 ⑧ 段）。
   * 写它只有两个读者：`projectStore.open`（按 `decision`）与 `closeSession`（关掉就停手）。
   */
  readonly readOnly: boolean;
  setReadOnly: (readOnly: boolean) => void;
  /**
   * 换手：把屏幕上这份真源换成**库里那一份**。返回 `false` = 拒收（`storeyId` 在这份文档里
   * 不是 storey），拒收时整个 state 一个字都不动 —— 不许出现"文档换了、层还指着上一层"。
   *
   * `viewport` 与 `viewportStoreyId` 同时置 null，与 `setStorey` 那条 P10 配对同一个理由：
   * 留着上一层的口径配新文档，画出来是一帧错位图；而 `PlanCanvas` 的绘制 effect 第一行就是
   * `if (viewport === null) return`，null 那一帧是干净空白 + 它自己的占位 tab 栏。
   * 重算由 `PlanCanvas` 那个 fit effect 负责 —— 它现在多带一个依赖 `log`，见本步第 ③ 段，
   * 那一行是本发 `set` 能画出来的**前提**，不是顺手加的。
   *
   * 不碰 `readOnly`：写权限由调用方（`projectStore`）按回包的 `decision` 决定，换手本身不越权。
   */
  loadProject: (doc: Document, storeyId: string) => boolean;
```

**改动 3 —— 初始态加一格**，紧跟在 `draft: null,` 之后：

```ts
  readOnly: false,
```

**改动 4 —— 两个新 action**（放在 `setDraft` 之后、`dispatch` 之前）：

```ts
  setReadOnly: (readOnly) => set({ readOnly }),
  // 拒收那一支**不 `set`**：调用方拿到 false 的时候屏幕上还是原来那一屏，
  // 于是"被拒"这件事的记账只有一条路 —— 走 `projectStore` 的 failure 通道，不在这里另开一份。
  loadProject: (doc, storeyId) => {
    if (doc.get(storeyId)?.kind !== 'storey') return false;
    set({
      log: new TransactionLog(doc),
      storeyId,
      viewport: null,
      viewportStoreyId: null,
      drag: null,
      draft: null,
      tool: 'select',
      lastError: null,
      revision: get().revision + 1,
    });
    return true;
  },
```

（`doc.get(storeyId)?.kind !== 'storey'` 是**唯一**那道闸：`Document.get` 对不存在的 id 回 `undefined`，`?.kind` 让"没这个 id"与"有但不是层"落到同一个比较上，一句判两型。不在这里查"这个 storey 属不属于 `doc.projectId`"—— `StoreyEntity.projectId` 与文档的配对由 T4 的归属守卫与 `documentFromPayload` 那条链管，这里再查一遍就是第三个产地。）

**改动 5 —— 四处只读闸门**。四处都是同一形状：**第一行判闸门、只 `set` 那一格 `lastError`、直接 `return`**，原有本体从第二行起一字不动。

```ts
  dispatch: (cmd) => {
    if (get().readOnly) {
      set({ lastError: `只读工程：这一发改不动（${cmd.type}）` });
      return;
    }
    // ↓ 以下（try/catch 与成功那发 `set`）一字不动
```

```ts
  dispatchBatch: (cmds) => {
    if (get().readOnly) {
      set({ lastError: `只读工程：这一批删不掉（${String(cmds.length)} 条命令）` });
      return;
    }
    const log = get().log;
    let failed: string | null = null;
    for (const cmd of cmds) {
      try {
        log.dispatch(cmd);
      } catch (err) {
        failed = String(err);
        break;
      }
      // P-21：**每应用一条扳一次**。原先循环外那一发合并 `set` 没了 —— 理由见 Step 6 第 ① 段：
      // `log.lastPatch` 是覆盖式的，一批只扳一次等于把前 N−1 发补丁永久吞掉，
      // 屏幕上删四件、库里记一件，且不抛任何东西。
      set((s) => ({ revision: s.revision + 1, lastError: null }));
    }
    // 半途失败：真源已经变了的那些发各扳过了，这里只补那一格文案，**不再动 revision**。
    // 一条都没应用成功时循环没进 ⇒ revision 一字不动，与改前同一语义（失败不动扳机那条纪律没破）。
    if (failed !== null) set({ lastError: `删不动：${failed}` });
  },
```

`dispatchBatch` 上面那段「**它不是一个事务**」的注释里，只有「应用了几条就只 +1 一次 revision」那一句要改（改成"每应用一条扳一次，见 P-21"），其余整段 —— `TransactionLog` 没有 begin/commit/rollback、一次删除 = 栈上 N+M 步、`S5` 那条顺序、"批语义归计划 4 真源侧、UI 不许拼假事务" —— 一字不动：它讲的是**撤销栈**，P-21 讲的是**通知次数**，两件事在这里第一次分开。

```ts
  undo: () => {
    if (get().readOnly) {
      set({ lastError: '只读工程：撤销不动（账本没开，退了也没地方记）' });
      return;
    }
    // ↓ 以下一字不动（含 `没有可撤销的操作` 那条现物文案）
```

```ts
  redo: () => {
    if (get().readOnly) {
      set({ lastError: '只读工程：重做不动（账本没开，前进也没有账号可挂）' });
      return;
    }
    // ↓ 以下一字不动
```

（闸门为什么**吃 undo/redo**：只读会话压根没有可退的栈（闸门挡住 dispatch，栈恒空）。真正会走到这一支的是 `closeSession` 之后 —— 账本已经关了，屏幕上再退一步就没有 turn 可挂：`submit` 会在 main 侧撞 `'session'`，但那要等一个 IPC 来回才告诉用户。就地挡住是唯一不骗人的形状。代价登记在第 ⑦ 段末尾。）

**③ `apps/desktop/src/renderer/src/PlanCanvas.tsx` 的一行依赖**

fit 那个 effect 现在的依赖是 `[storeyId, setViewport]`（盘上第 582 行），它里面那句注释写着「依赖里不写 `log`：`log` 是可变类实例、引用永不变，写进依赖挡不住任何东西」。那句话在计划 3 是对的，在计划 4 之后**不再成立**：`loadProject` 会换一个**新的 `TransactionLog` 实例**进来，`log` 的引用正是这时候变的 —— 而它恰恰是必须重算视口的第三个理由。

不加这一行的后果不是画错，是**再也画不出来**：`loadProject` 把 `viewport` 置成 null（改动 4），重算全靠 fit effect 再跑一次。第一次打开工程时 `storeyId` 从样例房的层 id 换成库里的层 id ⇒ 依赖变了 ⇒ 会跑。但 `reopenAsEdit()`（第 ⑤ 段那条"丢锁就重开"）打开的是**同一个工程的同一份文档** ⇒ `tabs[0].storeyId` 逐字相同 ⇒ 依赖没变 ⇒ effect 不跑 ⇒ `viewport` 永远停在 null，屏幕是一张永久空白的画布，而屏幕上没有任何一句话告诉你为什么。

改法：

```ts
  }, [storeyId, setViewport, log]);
```

并把那句注释补一段（**原文那句不许删**，它记录的是 resize 那一型的实测坑；只补"什么时候它不再是永真的"）：

```ts
      // 「依赖里不写 `log`」这句话到计划 4 为止是永真的，现在多了**一个**例外：
      // `loadProject` 换手会换掉 `log` 这个实例（`editorStore` 里 `new TransactionLog(doc)` 那一行）。
      // 引用在除换手以外的每一发 `set` 上都不变 ⇒ 加进依赖表挡不住任何东西（改文档、拖墙、切层
      // 全都还是靠 `revision` 扳），只有换手那一发会重跑 —— 而那正是我们想要的第三个理由：
      // 换手把 `viewport` 置了 null（P10 配对），不重跑就永远空白。
      // 实测过的那一型：`reopenAsEdit()` 重开同一个工程，`storeyId` 逐字回到同一个值，
      // 只有 `log` 的引用变了 ⇒ 少了这一行屏幕是一张不会消失的空画布。
```

（为什么不给 `loadProject` 里那份 null 换个写法、比如"换手时把旧视口留着"：那会画出一帧"新文档 × 旧口径"的错位图，与本文件 `viewportStoreyId` 那段 P10 判据同一个理由。为什么不在 `projectStore.open` 里直接 `setViewport(fitStorey(...))`：`fitStorey` 要的画布**像素尺寸**只有画在屏上的 `PlanCanvas` 量得到（`setStorey` 那条注释早就写明这一点），屏幕侧第二个量尺寸的读者就是第二份口径。）

**④ `apps/desktop/src/renderer/src/stores/projectStore.ts`**

```ts
import { storeyTabsOf } from '@dajia/scene-2d';
import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { Document, EntityId, Patch } from '@dajia/core';
import type {
  CloseRequest,
  CloseValue,
  OpenDecision,
  PersistErrorCode,
  SaveStatusWire,
  SubmitRequest,
} from '@dajia/protocol';
import type { DajiaApi } from '../../../preload/index';
import { documentFromPayload, payloadFromDocument } from '../../../shared/document-wire';
import { useEditor } from './editorStore';
import type { EditorState } from './editorStore';

/**
 * `preload/index.ts` 里那句 `contextBridge.exposeInMainWorld('dajia', api)` 的**另一头**。
 * 这块 `declare global` 从 `App.tsx` 搬进来（同一发要把 App.tsx 里那份删掉，见本节末「④ 段附带」，
 * 不是 Step 7 —— 留着它编译就红在 App.tsx 里），
 * 理由是编译范围而不是口味：`apps/desktop/tsconfig.test.json` 的 `include` 是
 * `["test", "src/main", "src/preload"]`，`App.tsx` 住在 `src/renderer/src` 且没有任何测试 import 它
 * ⇒ 声明留在 App.tsx 里，`readDajia()` 那一行就在**测试那一份 program** 里编不过
 * （`pnpm typecheck` 红，而 `tsc -p tsconfig.json` 绿 —— 两发只有一发红等于判据分不出真假）。
 * 搬到这里之后，声明与它唯一的读者 `readDajia()` 同处一个文件，被任何 import 本文件的程序自然带走。
 */
declare global {
  interface Window {
    dajia?: DajiaApi;
  }
}

export type ProjectPhase = 'off' | 'opening' | 'open' | 'closed';

/** 收尾的两种模式：`abandon` = 停写、解锁、关池，**不** flush、**不**对账（第 ⑤ 段重开前那一发）。 */
export type CloseMode = CloseRequest['mode'];

export type ProjectBannerTone = 'red' | 'amber' | 'grey';

/**
 * 横幅的那一句话。`closable` / `reopenable` 是**按钮的形状**，不是文案的修饰：
 * 它们由 `computeBanner` 与文字同一处决定，因为"能关闭"这件事与"这句话是什么"必须同时答是。
 * 为什么 `banner` 是 store 里的一格而不是 `useProject(bannerOf)` 那样的选择器：
 * 选择器每发都新造一个对象，`useSyncExternalStore` 拿 `Object.is` 判 ⇒ 每帧都"变了" ⇒
 * 整棵 React 树重渲（严重时直接死循环）。派生格落进 store、由唯一的 `put` 维护，才是这一族能测的形状。
 */
export interface ProjectBanner {
  readonly tone: ProjectBannerTone;
  readonly text: string;
  readonly closable: boolean;
  readonly reopenable: boolean;
}

interface ProjectFailure {
  readonly code: PersistErrorCode;
  readonly message: string;
}

/**
 * `open` 成功那一刻抄下来的读数。为什么要抄而不是每次从 `OpenValue` 现算：
 * `doc` 那一格是整份文档，留在 store 里就是 `log.document` 的第二份真源（D2b）；
 * 而横幅要的那六格全是标量，抄一次就够，且"上次是否正常结束"这件事本来就只在打开那一刻有答案。
 */
export interface OpenedProject {
  readonly projectId: EntityId;
  readonly decision: OpenDecision;
  readonly name: string;
  readonly wasCleanShutdown: boolean;
  readonly replayedRows: number;
  readonly emergencyCount: number;
  /** 最新那发抢救件的**绝对路径**（只当字符串用：renderer 一行 fs 都不许碰，spec §4.3）。 */
  readonly emergencyHint: string;
}

export interface ProjectState {
  readonly phase: ProjectPhase;
  readonly opened: OpenedProject | null;
  readonly failure: ProjectFailure | null;
  /** 只从 `SaveStatusWire` 那一发事件来（T7 的 `SaveStatus` 原样过界，③段）。 */
  readonly save: SaveStatusWire | null;
  /**
   * `closeSession('graceful')` 那一发的对账读数（`CloseValue` 的两格）。为什么 store 里要留它：
   * `CloseValueSchema` 是 T8 交出、main 出口验过的形状，屏幕上没有一个读者的话它就是
   * "过界验完就丢"的死字段 —— 而它唯一诚实的落点是关闭那一屏的那句话（31 行元素、2 行楼层
   * 是**这一版真源在盘上的行数**，spec §9 要的"是否丢失"有一半靠它说）。
   * `abandon` 那一支恒为 null：没跑对账就没有读数，把 null 写成 0 等于谎报"库说它干净"。
   */
  readonly closedReport: CloseValue | null;
  readonly banner: ProjectBanner | null;
  open: (projectId: string) => Promise<void>;
  /** 丢锁之后的出路 = 关掉本会话 + 重开同一个工程（第 ⑤ 段；原地 `resume()` 被明令不调）。 */
  reopenAsEdit: () => Promise<void>;
  closeSession: (mode: CloseMode) => Promise<void>;
  /** `save` 的唯一写入口。生产里唯一的读者是 `api.onSaveStatus` 那个包装（Step 5）。 */
  setSaveStatus: (status: SaveStatusWire) => void;
}

/**
 * 横幅文案的唯一产地。**顺序就是优先级**，每条各有一个下一步动作（③段那句"每个码都有下一步动作"
 * 在屏幕侧的对应物）：
 *
 * 1. `failure`：这一发没存上 / 这一屏压根没打开成 —— 屏幕上任何东西都不许盖过它。
 * 2. `opening` / `closed` / `off`：会话生命周期那三格。`off` 回 `null`（⑧段那一屏）。
 *    `closed` 的那一句吃 `closedReport`：有对账读数就说读数，没有（`abandon`）就说"不再是现场"。
 * 3. `reopenable`：只有**可写会话**才可能停写得等用户重开（只读会话压根没有 `Autosave`
 *    ⇒ `save` 恒 null ⇒ 这一支天然只对 edit 开放，不用额外判 `decision`）。
 * 4. `read-only`：告诉用户"这一屏一个字都不会写进库"（⑤段：拿不到锁就用 read 打开）。
 * 5. `failed`：存不进去（`'db'` 那一族，下一步是查服务、查网络 —— 与 3 的"别再写了"相反）。
 * 6. `!wasCleanShutdown`：spec §9 那句"明确告知恢复了什么"（⑦段：没有 before-quit，靠的就是这一格）。
 * 7. `emergencyCount > 0`：有 K 发没并进库，现场在盘上（⑤段的代价 ① 的读者）。
 * 8. 兜底那一句灰的：已经保存到第几发 + 队列里还有几发（①段的代价：renderer 只能读 `lastTurn`）。
 */
function computeBanner(
  s: Pick<ProjectState, 'phase' | 'opened' | 'failure' | 'save' | 'closedReport'>,
): ProjectBanner | null {
  if (s.failure !== null) {
    return { tone: 'red', text: s.failure.message, closable: false, reopenable: false };
  }
  if (s.phase === 'off') return null;
  if (s.phase === 'opening') return { tone: 'grey', text: '正在打开工程…', closable: false, reopenable: false };
  if (s.phase === 'closed') {
    const rep = s.closedReport;
    return {
      tone: 'grey',
      // 两种关闭给两句话：`graceful` 有对账读数就说读数（那是"没丢东西"的唯一凭据），
      // `abandon` 没有 —— 那一支的实话是"这一屏不再是现场"，不是"库是干净的"。
      text:
        rep === null
          ? '工程已关闭：这一屏不再是任何一份账的现场'
          : `工程已关闭：盘上核对到 ${String(rep.elementRows)} 行元素、${String(rep.storeyRows)} 行楼层`,
      closable: false,
      reopenable: false,
    };
  }
  const o = s.opened;
  if (o === null) return null; // 不变式：`phase === 'open'` ⇒ `opened !== null`（`open` 那一发同时 `set`）
  const save = s.save;
  const queued = String(save?.queuedTurns ?? 0);
  const lastTurn = String(save?.lastTurn ?? 0);
  const reopenable = save !== null && (save.phase === 'paused' || save.phase === 'stopped');
  if (reopenable) {
    return {
      tone: 'red',
      text:
        `工程锁丢了，已停写：第 ${lastTurn} 发是最后一发进库的，` +
        `没存上的现场 ${String(o.emergencyCount)} 份（最新一份在 ${o.emergencyHint}）。` +
        '重新接管会丢掉撤销栈，屏幕上已改的东西仍在。',
      closable: true,
      reopenable: true,
    };
  }
  if (o.decision === 'read-only') {
    return {
      tone: 'amber',
      text: `${o.name}：只读打开（别的会话持有工程锁）。这一屏改一个字都不会写进库`,
      closable: true,
      reopenable: false,
    };
  }
  if (save !== null && save.phase === 'failed') {
    return {
      tone: 'red',
      text: `保存失败：${save.lastError ?? '没给出原因'}（屏幕上已经改的东西还在，没存上的那几发在重试队列里）`,
      closable: true,
      reopenable: false,
    };
  }
  if (!o.wasCleanShutdown) {
    return {
      tone: 'amber',
      text: `上次没有正常结束：已从流水重放 ${String(o.replayedRows)} 发取回这份文档`,
      closable: true,
      reopenable: false,
    };
  }
  if (o.emergencyCount > 0) {
    return {
      tone: 'amber',
      text: `盘上留着 ${String(o.emergencyCount)} 份没并进库的现场（最新一份在 ${o.emergencyHint}）`,
      closable: true,
      reopenable: false,
    };
  }
  return {
    tone: 'grey',
    text: `${o.name}：已保存到第 ${lastTurn} 发，队列里还有 ${queued} 发`,
    closable: true,
    reopenable: false,
  };
}

/**
 * 屏幕这一侧的会话装配。**为什么是个工厂而不是一个单例**：`api` 要从外面进来
 * （测试递假把式，模块底部那份从 `window.dajia` 读），而订阅必须在 store 建成那一刻就挂上、
 * 并在测试结束时能撤 —— `create()` 的 initializer 是同步执行的，所以 `subscribe` 的注销函数
 * 只能在 `create` **外面**交回来，这就是返回 `[store, unsubscribe]` 这个形状的全部理由。
 */
export function createProjectStore(
  api: DajiaApi,
  editor: StoreApi<EditorState> = useEditor,
): readonly [UseBoundStore<StoreApi<ProjectState>>, () => void] {
  // 订阅那一刻的**真账**，不是 `null`：样例房是 `demoHouse()` 一路 `dispatch` 建起来的，
  // 屏幕那份 `log.lastPatch` 从第一帧起就不是空。初始化成 null 的话，第一发订阅
  //（哪怕只是切个层）就会把样例房最后那条建墙补丁当成"新账"递出去。
  let lastSeen: Patch | null = editor.getState().log.lastPatch;
  let stopWatching: (() => void) | null = null;

  const store = create<ProjectState>((set, get) => {
    /**
     * 唯一的 `set` 出口：任何改动 state 的路径都必须走它，`banner` 由它在每一发之后重算。
     * 分两拍（先 set 字段、再 set banner）就会有一帧"字段变了、横幅还是上一句话"，
     * 而那一帧正是 `setStorey` 那条 P10 判据在本文件里的同型。
     */
    const put = (partial: Partial<ProjectState>): void => {
      set((s) => ({ ...partial, banner: computeBanner({ ...s, ...partial }) }));
    };

    const submitOne = (doc: Document, patch: Patch, projectId: EntityId): void => {
      // 编码在 `await` **之前**：await 之后 `log.document` 可能已经被下一发命令换掉，
      // 那一发交出去的就是"第 N 发的补丁配第 N+1 发的整份快照" —— 库里两样各自都对，配对错。
      const request: SubmitRequest = { projectId, patch, doc: payloadFromDocument(doc) };
      void api
        .submitJournal(request)
        .then((r) => {
          if (r.ok) {
            // 成功只清自己那一格：`failure` 非 null 且此刻没有别的事故才清。
            // 会不会把"打开失败"那句话抹掉？不会 —— 打开失败时压根没有会话，也就没有发能成功回来。
            if (get().failure !== null) put({ failure: null });
            return;
          }
          put({ failure: { code: r.code, message: r.message } });
          if (r.code === 'reconcile') {
            // 'reconcile' 的语义就是"库里这份账跟屏幕上不是同一份东西"（③段），下一步动作是停手。
            // 'db' 那一族**不**跟着停：服务断了对账仍平，把用户的编辑权拿走才是真的坏消息。
            editor.getState().setReadOnly(true);
          }
        })
        .catch((err: unknown) => {
          // ipcRenderer.invoke 会在通道没注册时 reject。那一发同样没存上 —— 按 'internal' 报。
          put({ failure: { code: 'internal', message: `这一发没送出去：${String(err)}` } });
        });
    };

    const open = async (projectId: string): Promise<void> => {
      const phase = get().phase;
      if (phase === 'opening' || phase === 'open') {
        put({ failure: { code: 'session', message: '上一个工程还没收尾：先关掉再开（顺序由这一侧负责，⑤段）' } });
        return;
      }
      // `opened: null` 跟着进这一发：横幅在"正在打开"那一帧不许留着**上一个**工程的名字。
      put({ phase: 'opening', failure: null, save: null, opened: null, closedReport: null });
      const r = await api.openProject(projectId);
      if (!r.ok) {
        put({ phase: 'off', failure: { code: r.code, message: r.message } });
        return;
      }
      const v = r.value;
      let doc: Document;
      try {
        // 文档在换手之前解不开 ⇒ main 递回来的东西与 `documentFromPayload` 那道闸对不上：
        // 我们的装配错了，'internal'（③段那条"下一步动作是：这一发没存上，屏幕上的东西仍在"）。
        doc = documentFromPayload(v.doc, '打开工程的回包');
      } catch (err) {
        put({ phase: 'off', failure: { code: 'internal', message: `回包里的文档解不开：${String(err)}` } });
        return;
      }
      const tabs = storeyTabsOf(doc, v.header.projectId);
      if (tabs.length === 0) {
        put({
          phase: 'off',
          failure: { code: 'reconcile', message: '库里这个工程一份楼层都没有：没有能画的层，也就不许写' },
        });
        return;
      }
      // 换手在 `put({ phase: 'open' })` **之前**：`loadProject` 会扳一次订阅体，那时候 `phase`
      // 还是 'opening' ⇒ 第一道闸门就把它拦住。新 log 的 `lastPatch` 恒 null 本来也发不出东西，
      // 但两道闸门都留着是对的 —— "新 log 恒空"来自计划 3 的既有实现，不该成为这一发唯一的依赖。
      if (!editor.getState().loadProject(doc, tabs[0].storeyId)) {
        put({ phase: 'off', failure: { code: 'internal', message: '换手被拒：那一层 id 不在刚拿到的文档里' } });
        return;
      }
      editor.getState().setReadOnly(v.decision === 'read-only');
      put({
        phase: 'open',
        failure: null,
        save: null,
        opened: {
          projectId: v.header.projectId,
          decision: v.decision,
          name: v.header.name,
          wasCleanShutdown: v.header.wasCleanShutdown,
          replayedRows: v.replayed.rows,
          emergencyCount: v.emergency.length,
          // `session.ts` 递来的是按 turn **升序**的名单（`listEmergency` 的契约），最后一发就是最新的一份。
          emergencyHint: v.emergency.at(-1)?.path ?? '',
        },
      });
    };

    const closeSession = async (mode: CloseMode): Promise<void> => {
      const o = get().opened;
      if (o === null) return;
      const request: CloseRequest = {
        projectId: o.projectId,
        doc: payloadFromDocument(editor.getState().log.document),
        mode,
      };
      const r = await api.closeProject(request);
      // 闸门落下：账本关了，屏幕上再改的那一发没有 turn 可挂。
      // 放在 `r.ok` 判断**之外** —— main 那侧无论回什么，`close` 都已经把会话拆了（T6 的解锁与
      // T5 的收尾在 `closeProject` 之前/之后各有一支会跑），继续让用户写只会攒一串存不进去的账。
      editor.getState().setReadOnly(true);
      if (!r.ok) {
        put({ phase: 'closed', failure: { code: r.code, message: r.message }, closedReport: null });
        return;
      }
      // `abandon` 恒 null（没跑对账就没有读数）；`graceful` 把 main 的两格读数留下当那一句话。
      put({ phase: 'closed', closedReport: mode === 'graceful' ? r.value : null });
    };

    const reopenAsEdit = async (): Promise<void> => {
      const o = get().opened;
      if (o === null) return;
      await closeSession('abandon');
      await open(o.projectId);
    };

    /**
     * 提交触发点订阅（⑨段）。三道判据的顺序不能换：
     * 1. 身份：`patch === lastSeen` 就什么都不做 —— `revision` 是"该重绘了"的扳机，切层、改工具、
     *    换草稿全都扳它，但都不换 `lastPatch`（T7 只在 dispatch/undo/redo 成功时换它）。
     * 2. **先记账再判断**：`lastSeen` 必须在 null 检查与 phase 检查之前更新。反过来写的话，
     *    换手那一发（`lastPatch` 变 null）不会被记下来，之后每一发订阅都会拿着样例房的旧补丁
     *    重走一遍后面的判据 —— 判据挡住了账，但"为什么挡住"这件事就从每发重演变成了谜。
     * 3. null 与 phase/decision：demo 文档那一串永不允许进用户的库（`phase !== 'open'` 是第一道，
     *    `decision !== 'edit'` 是第二道 —— 只读会话压根没有 Autosave，走到 main 也是 `'session'`）。
     */
    stopWatching = editor.subscribe((state) => {
      const patch = state.log.lastPatch;
      if (patch === lastSeen) return;
      lastSeen = patch;
      if (patch === null) return;
      const s = get();
      if (s.phase !== 'open' || s.opened === null || s.opened.decision !== 'edit') return;
      submitOne(state.log.document, patch, s.opened.projectId);
    });

    return {
      phase: 'off',
      opened: null,
      failure: null,
      save: null,
      closedReport: null,
      banner: null,
      open,
      reopenAsEdit,
      closeSession,
      setSaveStatus: (status) => put({ save: status }),
    };
  });

  if (stopWatching === null) {
    // 不写这一发的话，`stop` 会是个静默的空函数：测试结束时订阅没撤，下一格收走上一格的编辑，
    // 红起来读不出是谁干的。`create` 的 initializer 是同步的，所以走到这里还是 null 就是形状变了。
    throw new Error('createProjectStore：zustand 没同步执行 initializer，订阅撤不掉');
  }
  const stop = stopWatching;
  const unsubscribeStatus = api.onSaveStatus((status) => store.getState().setSaveStatus(status));
  return [store, () => {
    stop();
    unsubscribeStatus();
  }];
}

/**
 * 读 preload 注入的那一份接口。为什么判 `typeof window`：本文件的测试跑在 **node 档**
 * （根 `vitest.config.ts` 没有 jsdom，T1 也没打算加），那一档压根没有 `window` 这个全局 ——
 * 不判的话 import 这个文件就直接 ReferenceError，11 格全体起不来。
 * 而这一发在**模块顶层**就会被 `useProject` 调用，所以它就是"这一族测试能在 node 里 import 屏幕侧
 * store"的那道保险；判在函数里（不是模块顶层的一个常量）也是为了让测试能挂上 `globalThis.window` 再取。
 */
export function readDajia(): DajiaApi | null {
  if (typeof window === 'undefined') return null;
  return window.dajia ?? null;
}

/**
 * 没注入时用的空壳。三个请求方法**诚实回答"没接口"**而不是抛：
 * ⑧段要的那一屏是"横幅说清楚这一屏不会保存，画布照常能画"，不是崩。
 * `ping` 那一支是 `reject`：它在屏幕侧没有读者（`ping` 的读者是 main 的 --shot 那一族探针），
 * 让它响而不让它骗 —— 万一哪天有人接上它，得到的是一句真话。
 */
const NOT_INJECTED: DajiaApi = {
  ping: async () => {
    throw new Error('没有 preload 注入的 dajia 接口：ping 没人能答');
  },
  openProject: async () => ({
    ok: false,
    code: 'internal',
    message: '没有 preload 注入的 dajia 接口：这一屏不会保存任何东西',
  }),
  submitJournal: async () => ({
    ok: false,
    code: 'internal',
    message: '没有 preload 注入的 dajia 接口：这一屏不会保存任何东西',
  }),
  closeProject: async () => ({
    ok: false,
    code: 'internal',
    message: '没有 preload 注入的 dajia 接口：这一屏不会保存任何东西',
  }),
  onSaveStatus: () => () => {
    // 没有桥可订 ⇒ 没有可撤的东西。空函数不是"什么都没做"，是"这一族的注销契约仍然成立"。
  },
};

/**
 * App 用的那一份。`readDajia()` 在 node 档回 null ⇒ 空壳顶上，模块 import 不炸（那既是这一族
 * 测试的前提，也是"打包路径写错 ⇒ 漏注入"那一型在生产里的形状：屏幕照常画，横幅说真话）。
 */
export const useProject = createProjectStore(readDajia() ?? NOT_INJECTED)[0];
```

> `<待实测>` 三件，都是跨包形状，执行时按 `tsc` 的原文订正并写回填：
> ① `import type { StoreApi, UseBoundStore } from 'zustand'`：盘上现物 zustand 5.0.15 的 `index.d.ts` 是 `export * from 'zustand/vanilla'; export * from 'zustand/react';`，两个名字各自在那两份里 —— 本段是按那份 `.d.ts` 写的，没有实测过 `tsc`。若红在 `UseBoundStore` 不导出，改 `import type { StoreApi } from 'zustand'` + `import type { UseBoundStore } from 'zustand/react'`，**不许**退化成 `as any`。
> ② `editor: StoreApi<EditorState> = useEditor`：`useEditor` 是 `UseBoundStore<StoreApi<EditorState>>`，那份 `.d.ts` 里 `UseBoundStore<S>` = `{(...): ExtractState<S>} & S`，于是它**可赋值给** `StoreApi<EditorState>`。默认实参那一支的 `subscribe`/`getState`/`setState` 三个方法全在 `StoreApi` 上 ✓。若 `tsc` 在这一行红，说明 zustand 的 `ExtractState` 那层包装变了形状 —— 那一条只能改参数类型（写成 `typeof useEditor`），不许改 `createProjectStore` 的对外契约（测试靠的是"能塞一个假 store 进来"这件事）。
> ③ `computeBanner({ ...s, ...partial })`：`partial` 里带了 `open`/`closeSession` 这些函数的可能性（`Partial<ProjectState>` 包含 action 键），`Pick<ProjectState, 'phase' | 'opened' | 'failure' | 'save'>` 只读四格 ⇒ 结构上没问题。真报错就按报错那一行改 `put` 的参数为 `Pick<ProjectState, ...>` 的窄形状 + 让三个 action 单独 `set`（那时横幅要重算的那几处仍必须与字段同发落地）。

**④ 段附带：同一发里必须改掉 `App.tsx` 的那块 `declare global`**

上面那份 `projectStore.ts` 一落地，`App.tsx` 里盘上现物的 `dajia: DajiaApi`（必填）就与本文件里的 `dajia?: DajiaApi`（可选）撞成**两次同名不同型的声明** —— `tsc` 报 TS2717（"All declarations of 'dajia' must have identical modifiers"），而它红的位置在**没被改过的那份文件**里，读起来像"projectStore 写错了"。所以这两处必须同一发落地，本文件的改动面就三行：

改前（盘上现物第 1、3—7 行）：

```tsx
import type { DajiaApi } from '../../preload/index';
import { PlanCanvas } from './PlanCanvas';

declare global {
  interface Window {
    dajia: DajiaApi;
  }
}
```

改后（整块删掉，连同那行 `import type` —— 本文件不再需要 `DajiaApi` 这个名字）：

```tsx
import { PlanCanvas } from './PlanCanvas';
```

`export default function App(): React.JSX.Element { return <PlanCanvas />; }` 那一行**一字不动**（横幅归 Step 7 ①，那时才整文件替换）。为什么搬家而不是在 `App.tsx` 里就地改成可选：`apps/desktop/tsconfig.test.json` 的 `include` 是 `["test", "src/main", "src/preload"]`，`src/renderer/src/App.tsx` 不在那份 program 里（盘上 318—333 行实测），而 `project-store.test.ts` 要 `readDajia()` 的 `Window['dajia']` 有声明可解 —— 声明留在 `App.tsx` 就等于"只有 import 过 App 的 program 才看得见它"，`tsc -p tsconfig.test.json` 会红在 `readDajia()` 那一行。

**⑤ `apps/desktop/test/unit/editor-fixtures.ts`**

两个 store 测试文件共用一份"样例房基准 + 复位"，所以它单独成文件（同族先例：t8b 把 `FakeTimer` 与 `tick` 从 `autosave.test.ts` 搬进 `fake-timer.ts` 的理由一模一样 —— 夹具的内部口径有两份实现，红的那一格就说不清是代码错还是夹具错）。`apps/desktop/test/**` 只许 import `@dajia/core`、`@dajia/protocol` 与自己包内源码（P-1 那条纪律），本文件三样都在许可内。

```ts
import { Document, uuidv7, type Entity, type EntityId } from '@dajia/core';
import { useEditor } from '../../src/renderer/src/stores/editorStore';

/**
 * 样例房那份真源的基准三格。**读现成的 state，绝不再调一次 `demoHouse()`**：
 * 它的 id 是随机 UUIDv7，第二次调拿到的是另一套房（`editorStore.ts` 顶上那句"只调一次"
 * 记的就是这件事，而它在测试里同样成立 —— 基准必须是"屏幕上这一套"，不是"长得像的那一套"）。
 */
export const DEMO = {
  log: useEditor.getState().log,
  storeyId: useEditor.getState().storeyId,
  revision: useEditor.getState().revision,
};

/**
 * 把 store 回到"刚 import 完"那一帧。逐字段列出来而不是"存一份快照再整份塞回去"：
 * 快照法会连 `open`/`loadProject` 这些**函数引用**一起塞回去，而那几格本来就不该动 ——
 * 一张写明了"哪些字段属于我"的清单，比一个通配的还原器更能说明本任务动了什么。
 *
 * `DEMO.log` 这份可变实例本身**不回滚**（回滚要调 `undo()`，而那正是被测对象）。
 * 于是所有用例断的是**相对量**：`depth` 与调用前比、`revision` 与 `DEMO.revision` 比。
 */
export function resetEditor(): void {
  useEditor.setState({
    log: DEMO.log,
    storeyId: DEMO.storeyId,
    viewport: null,
    viewportStoreyId: null,
    revision: DEMO.revision,
    lastError: null,
    drag: null,
    draft: null,
    tool: 'select',
    readOnly: false,
  });
}

/** 一份只有一个楼层的最小文档：`loadProject` 的两个分支都用它，不需要真墙。 */
export function oneStoreyDoc(): {
  readonly doc: Document;
  readonly projectId: EntityId;
  readonly storeyId: EntityId;
  readonly wallId: EntityId;
} {
  const projectId = uuidv7();
  const storeyId = uuidv7();
  const wallId = uuidv7();
  const entities = new Map<EntityId, Entity>([
    [storeyId, { kind: 'storey', id: storeyId, projectId, index: 0, elevationMm: 0, heightMm: 3000 }],
    // 一个不属于任何层的墙 id 不进文档：`loadProject` 只看 `storeyId` 那一格是不是 storey，
    // 而"存在但不是层"那一型用**另一个 storey 的 id**去判更准（见 格 5 的第二发）。
    [wallId, {
      kind: 'wall', id: wallId, storeyId, startId: storeyId, endId: storeyId,
      thicknessMm: 200, heightMm: 3000, elevationOffsetMm: 0, loadBearing: false, material: '砖',
    }],
  ]);
  return { doc: Document.replaceEntities(Document.create(projectId), entities), projectId, storeyId, wallId };
}
```

（`oneStoreyDoc` 里那面墙的 `startId/endId` 都指到 `storeyId`：**故意的**，它是给 `loadProject` 的守卫用的形状，`buildDrawList` 永远拿不到它（屏幕上没人画它）。它只需要过 `Document.replaceEntities` 那道 validate（整数毫米 + id 形状），不需要过派生复核 —— 派生复核在命令层（T7 的 `assertDerivesAfterApply`），不在 `replaceEntities` 里。这一点如果评审要问：这就是"夹具只证它该证的"那条口径。）

**⑥ `apps/desktop/test/unit/editor-store.test.ts`（9 格）**

```ts
import { wallSetMaterial, uuidv7 } from '@dajia/core';
import { fitStorey, type Viewport } from '@dajia/scene-2d';
import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from '../../src/renderer/src/stores/editorStore';
import { DEMO, oneStoreyDoc, resetEditor } from './editor-fixtures';

const WALL = DEMO.log.document.byKind('wall')[0];

/** 一次 `set` 之后要逐格比的那几张（**不含** action：函数引用本来就不该动）。 */
const KEYS = [
  'log', 'storeyId', 'viewport', 'viewportStoreyId', 'revision',
  'lastError', 'drag', 'draft', 'tool', 'readOnly',
] as const;

function snapshot(): Record<string, unknown> {
  const s = useEditor.getState();
  const out: Record<string, unknown> = {};
  for (const k of KEYS) out[k] = s[k];
  return out;
}

beforeEach(() => {
  resetEditor();
});

describe('只读闸门：四处写动作、五处视图动作各归各的', () => {
  it('只读挡住 `dispatch` 与 `dispatchBatch`：真源一字不动，只落 lastError', () => {
    const beforeRevision = useEditor.getState().revision;
    const beforeDepth = DEMO.log.depth;
    useEditor.getState().setReadOnly(true);
    useEditor.getState().dispatch(wallSetMaterial({ wallId: WALL.id, material: '混凝土' }));
    expect(useEditor.getState().revision).toBe(beforeRevision);
    expect(DEMO.log.depth).toBe(beforeDepth);
    expect(String(useEditor.getState().lastError)).toMatch(/^只读工程：/);
    // 正控制：闸门真的存在，而不是"命令自己失败了所以看起来像被挡"。
    useEditor.getState().setReadOnly(false);
    useEditor.getState().dispatch(wallSetMaterial({ wallId: WALL.id, material: '混凝土' }));
    expect(useEditor.getState().revision).toBe(beforeRevision + 1);
    expect(DEMO.log.depth).toBe(beforeDepth + 1);
    useEditor.getState().setReadOnly(true);
    useEditor.getState().dispatchBatch([
      wallSetMaterial({ wallId: WALL.id, material: '钢' }),
      wallSetMaterial({ wallId: DEMO.log.document.byKind('wall')[1].id, material: '钢' }),
    ]);
    expect(DEMO.log.depth).toBe(beforeDepth + 1); // 只多了正控制那一发，batch 一条都没进
    expect(String(useEditor.getState().lastError)).toMatch(/^只读工程：这一批删不掉（2 条命令）/);
  });

  it('只读挡住 `undo`/`redo`（账本关了，退了也没地方记）', () => {
    useEditor.getState().dispatch(wallSetMaterial({ wallId: WALL.id, material: '木' }));
    const depth = DEMO.log.depth;
    const revision = useEditor.getState().revision;
    useEditor.getState().setReadOnly(true);
    useEditor.getState().undo();
    useEditor.getState().redo();
    expect(DEMO.log.depth).toBe(depth);
    expect(useEditor.getState().revision).toBe(revision);
    expect(String(useEditor.getState().lastError)).toMatch(/^只读工程：重做不动/);
  });

  it('只读**不挡**视图动作：切层照常 +1 revision，工具/草稿/视口照旧写', () => {
    useEditor.getState().setReadOnly(true);
    const vp: Viewport = fitStorey(DEMO.log.document, DEMO.storeyId, 800, 600);
    const revision = useEditor.getState().revision;
    useEditor.getState().setStorey(DEMO.storeyId, vp);
    expect(useEditor.getState().revision).toBe(revision + 1);
    expect(useEditor.getState().viewportStoreyId).toBe(DEMO.storeyId);
    useEditor.getState().setTool('wall');
    useEditor.getState().setDrag(null);
    useEditor.getState().setViewport(vp, DEMO.storeyId);
    expect(useEditor.getState().tool).toBe('wall');
    expect(useEditor.getState().viewport).toBe(vp);
  });
});

describe('loadProject：换手那一发', () => {
  it('成功那一支：换 log、层跟着换、视口两格同发置 null、其余视图格清零', () => {
    const { doc, storeyId } = oneStoreyDoc();
    useEditor.getState().setTool('wall');
    useEditor.getState().setReadOnly(true);
    const revision = useEditor.getState().revision;
    expect(useEditor.getState().loadProject(doc, storeyId)).toBe(true);
    const s = useEditor.getState();
    expect(s.log).not.toBe(DEMO.log);
    expect(s.log.document.equals(doc)).toBe(true);
    expect(s.storeyId).toBe(storeyId);
    // 两格同一发：`viewport` 与"它为哪一层算的"要么都有要么都没有（P10 同一条）。
    expect(s.viewport).toBeNull();
    expect(s.viewportStoreyId).toBeNull();
    expect(s.revision).toBe(revision + 1);
    expect(s.tool).toBe('select');
    expect(s.drag).toBeNull();
    expect(s.draft).toBeNull();
    expect(s.lastError).toBeNull();
    // 换手不越权决定写权限：`readOnly` 留着调用方（projectStore 按 decision）判。
    expect(s.readOnly).toBe(true);
  });

  it('拒收那一支：整个 state 一字不动（两个非法入参各判一型）', () => {
    const { doc, wallId } = oneStoreyDoc();
    const before = snapshot();
    expect(useEditor.getState().loadProject(doc, uuidv7())).toBe(false); // 没这个 id
    expect(snapshot()).toEqual(before);
    expect(useEditor.getState().loadProject(doc, wallId)).toBe(false); // id 在，但不是层
    expect(snapshot()).toEqual(before);
  });

  it('换手把撤销栈一起换掉：旧工程的"撤销回丢锁之前"没了（⑤段代价 ②）', () => {
    useEditor.getState().dispatch(wallSetMaterial({ wallId: WALL.id, material: '石' }));
    expect(DEMO.log.canUndo).toBe(true);
    const { doc, storeyId } = oneStoreyDoc();
    useEditor.getState().loadProject(doc, storeyId);
    const log = useEditor.getState().log;
    expect(log).not.toBe(DEMO.log);
    expect(log.depth).toBe(0);
    expect(log.canUndo).toBe(false);
    expect(log.canRedo).toBe(false);
    // 旧栈还在旧 log 上：屏幕换到新文档以后，`undo()` 走的是新 log，不会把旧工程的补丁退回新文档里。
    useEditor.getState().undo();
    expect(String(useEditor.getState().lastError)).toBe('没有可撤销的操作');
    expect(DEMO.log.depth).toBe(1);
  });
});

describe('闸门没把计划 3 的语义碰坏', () => {
  it('可写路径：成功 +1 且清 lastError，失败不动 revision 且落 `拖不动：`', () => {
    const revision = useEditor.getState().revision;
    useEditor.getState().dispatch(wallSetMaterial({ wallId: WALL.id, material: 'A' }));
    expect(useEditor.getState().revision).toBe(revision + 1);
    expect(useEditor.getState().lastError).toBeNull();
    useEditor.getState().dispatch(wallSetMaterial({ wallId: uuidv7(), material: 'B' }));
    expect(useEditor.getState().revision).toBe(revision + 1);
    expect(String(useEditor.getState().lastError)).toMatch(/^拖不动：/);
  });

  it('P-21：`dispatchBatch` 每应用一条扳一次；半途失败只扳已应用的那几发', () => {
    const walls = DEMO.log.document.byKind('wall');
    const revision = useEditor.getState().revision;
    useEditor.getState().dispatchBatch([
      wallSetMaterial({ wallId: walls[0].id, material: 'P21-1' }),
      wallSetMaterial({ wallId: walls[1].id, material: 'P21-2' }),
      wallSetMaterial({ wallId: walls[2].id, material: 'P21-3' }),
    ]);
    // 改前这里是 +1（一批一扳），现在是 +3 —— 订阅体（projectStore 格 8）靠的就是这三下。
    expect(useEditor.getState().revision).toBe(revision + 3);
    expect(DEMO.log.depth).toBe(revisionDepthBaseline() + 3);
    expect(useEditor.getState().lastError).toBeNull();

    const r2 = useEditor.getState().revision;
    const d2 = DEMO.log.depth;
    useEditor.getState().dispatchBatch([
      wallSetMaterial({ wallId: walls[3].id, material: 'P21-4' }),
      wallSetMaterial({ wallId: uuidv7(), material: 'P21-x' }), // 第二条起不存在
      wallSetMaterial({ wallId: walls[4].id, material: 'P21-5' }),
    ]);
    expect(useEditor.getState().revision).toBe(r2 + 1);
    expect(DEMO.log.depth).toBe(d2 + 1);
    expect(String(useEditor.getState().lastError)).toMatch(/^删不动：/);

    // 一条都没应用成功：循环一次没进 ⇒ revision 一字不动（"失败不动扳机"那条纪律还在）。
    const r3 = useEditor.getState().revision;
    useEditor.getState().dispatchBatch([wallSetMaterial({ wallId: uuidv7(), material: '没门' })]);
    expect(useEditor.getState().revision).toBe(r3);
    expect(String(useEditor.getState().lastError)).toMatch(/^删不动：/);
  });

  it('闸门是双向门，且现物那两条空栈文案一字没动', () => {
    useEditor.getState().setReadOnly(true);
    useEditor.getState().undo();
    expect(String(useEditor.getState().lastError)).toMatch(/^只读工程：/);
    useEditor.getState().setReadOnly(false);
    useEditor.getState().undo();
    useEditor.getState().redo();
    expect(useEditor.getState().lastError).toBeNull(); // 上面那发 dispatch 把 redoStack 清了，undo 也退了
    useEditor.getState().undo();
    useEditor.getState().undo();
    useEditor.getState().undo();
    const before = useEditor.getState().revision;
    useEditor.getState().undo();
    useEditor.getState().redo();
    const s = useEditor.getState();
    expect(s.revision).toBe(before);
    expect(String(s.lastError)).toMatch(/^(没有可撤销的操作|没有可重做的操作)$/);
  });
});
```

**这一档的格子与 `revisionDepthBaseline()`**：`DEMO.log` 是模块级单例，同一文件里前面那几格已经往它压过撤销记录，所以"绝对 depth"没有意义 —— 上面 格 8 里那个 `revisionDepthBaseline()` 是本文件顶部的一个小助手，写法如下（**别把它写成 `DEMO.log.depth`**：`DEMO` 是 import 那一刻读的，而 格 1～7 已经改过栈）：

```ts
/** 在**调用那一刻**读栈深：`DEMO.log` 是单例，前面每一格都往它压过记录，绝对值不属于任何一格。 */
function revisionDepthBaseline(): number {
  return DEMO.log.depth;
}
```

把它插在 `snapshot()` 之后、`beforeEach` 之前。它是 格 8 那一发唯一的绝对量出口，别的地方一律用"调用前读一次、调用后比"（`const d2 = DEMO.log.depth` 那种）。

> `<待实测>` 两处判据的**方向**依赖计划 3 的现物，执行时按第一次跑的实际读数定，并把读数写进回填：
> ① 本档（`editor-store.test.ts`）格 9 中段那两发 `undo()`/`redo()` 之后 `lastError` 究竟是 null 还是"没有可重做的操作"，取决于前面 8 格一共往 `DEMO.log` 压了几发、退了几发 —— 这一格判的是**那两条现物文案还活着**，不判栈的绝对深度。若实测落在那支"有得退"的分支（`lastError` 为 null、`revision` 变了），就把这一格拆成两句：`expect([null, '没有可撤销的操作', '没有可重做的操作']).toContain(s.lastError)` 是**假判据**（谁都过），不许那样写；改成"先把栈清空"那一支：`while (useEditor.getState().log.canUndo) useEditor.getState().undo();` 之后再判 `没有可撤销的操作` 那句逐字（栈清得空、`canUndo` 是 core 的公开读数，两句都是硬的）。**默认按后一种写法落地**，前一种只作为"如果 `undo()` 中途被派生复核拒绝"的备选 —— 那种情况发生的话说明 9 格里哪一发出问题了，写进回填而不是改判据。
> ② 格 1 那句 `toMatch(/^只读工程：这一批删不掉（2 条命令）/)` 里的中文括号与数字必须与 ② 段那行代码逐字同；改文案就同时改两处，不许只改一处。

**⑦ `apps/desktop/test/unit/project-store.test.ts`（11 格）**

这一档全部是假把式：假 `DajiaApi`、假回包，零 electron、零 mysql2、零真窗口。`useEditor` 用**真单例**（它没有闸门之外的副作用，而"订阅体读的是同一份真源"这件事恰恰要真 store 才证得出来），所以每个 `createProjectStore` 都要在 `afterEach` 里撤干净 —— 忘了撤的代价不是泄漏一个句柄，是**下一格收走上一格的编辑**（两份订阅挂在同一个 editor 上，会各发一份账），那种红读起来像"代码错了"。

```ts
import { wallSetMaterial } from '@dajia/core';
import { demoHouse, fitStorey, storeyTabsOf } from '@dajia/scene-2d';
import { describe, expect, it, afterEach } from 'vitest';
import type {
  CloseRequest,
  DocumentPayloadShape,
  OpenDecision,
  PersistErrorCode,
  SaveStatusWire,
  SubmitRequest,
} from '@dajia/protocol';
import { documentFromPayload, payloadFromDocument } from '../../src/shared/document-wire';
import { useEditor } from '../../src/renderer/src/stores/editorStore';
import { createProjectStore, readDajia } from '../../src/renderer/src/stores/projectStore';
import type { DajiaApi } from '../../src/preload/index';
import { DEMO, resetEditor } from './editor-fixtures';
import { tick } from './fake-timer';

/** 服务端那份文档：**故意**再调一次 `demoHouse()` —— 它必须与屏幕上那套不是同一套房
 *  （随机 id ⇒ 两套房），于是"换手以后屏幕上画的确实是回包那一份"这件事才判得出来。
 *  与 `editor-fixtures.ts` 那句"绝不再调一次"不冲突：那儿要的是**基准**，这儿要的是**对手**。 */
const SERVER = demoHouse();
const SERVER_PID = SERVER.doc.projectId;

const STATUS_IDLE: SaveStatusWire = {
  phase: 'idle', queuedTurns: 0, lastTurn: 7, snapshotTurn: 5,
  rowsSinceSnapshot: 2, lastError: null, pauseReason: null,
};

function openValueFixture(init: {
  doc?: DocumentPayloadShape;
  decision?: OpenDecision;
  name?: string;
  wasCleanShutdown?: boolean;
  replayedRows?: number;
  emergencyCount?: number;
}) {
  const payload = init.doc ?? payloadFromDocument(SERVER.doc);
  const projectId = payload.projectId;
  const count = init.emergencyCount ?? 0;
  return {
    decision: init.decision ?? 'edit',
    header: {
      projectId,
      name: init.name ?? '样例房',
      schemaVersion: 1,
      journalTurn: 0,
      wasCleanShutdown: init.wasCleanShutdown ?? true,
    },
    doc: payload,
    snapshot: null,
    replayed: { rows: init.replayedRows ?? 0, fromSeq: null, toSeq: null },
    emergency: Array.from({ length: count }, (_unused, i) => ({
      turn: i + 1,
      path: `C:/dajia/emergency/${'x'.repeat(36)}-turn-${String(i + 1)}.json`,
    })),
  };
}

function makeApi() {
  const submits: SubmitRequest[] = [];
  const closes: CloseRequest[] = [];
  const opens: string[] = [];
  /**
   * 三个假把式共用的一根顺序针（同族先例：`session.test.ts` 的夹具订正）：
   * `reopenAsEdit()` 那格要判的是"先 abandon 再 open"，而 `toEqual` 逐字比一串名字才读得出
   * "少一步"和"顺序反了" —— 分开数 `closes.length` 与 `opens.length` 只能证"各来了一次"。
   */
  const calls: string[] = [];
  const listeners: Array<(s: SaveStatusWire) => void> = [];
  const queue: ReturnType<typeof openValueFixture>[] = [];
  const box = {
    /** 非 null ⇒ 这一发 `open` 直接回失败（`opens` 与 `calls` 照记：失败重试那一型要有证人）。 */
    openFail: null as { code: PersistErrorCode; message: string } | null,
    submitFail: null as { code: PersistErrorCode; message: string } | null,
  };
  const api: DajiaApi = {
    ping: async () => 'pong',
    openProject: async (projectId) => {
      opens.push(projectId);
      calls.push('open');
      if (box.openFail !== null) return { ok: false, code: box.openFail.code, message: box.openFail.message };
      const next = queue.shift();
      if (next === undefined) throw new Error('夹具没准备回包：这一发 open 会挂在 await 上');
      return { ok: true, value: next };
    },
    submitJournal: async (request) => {
      submits.push(request);
      calls.push('submit');
      if (box.submitFail !== null) {
        return { ok: false, code: box.submitFail.code, message: box.submitFail.message };
      }
      return { ok: true, value: { outcome: 'queued', acceptedTurn: submits.length } };
    },
    closeProject: async (request) => {
      closes.push(request);
      calls.push(`close:${request.mode}`);
      return request.mode === 'abandon'
        ? { ok: true, value: { elementRows: null, storeyRows: null } }
        : { ok: true, value: { elementRows: 31, storeyRows: 2 } };
    },
    onSaveStatus: (listener) => {
      listeners.push(listener);
      return () => {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
  };
  return { api, submits, closes, opens, calls, listeners, queue, box };
}

type Fake = ReturnType<typeof makeApi>;

/** 每一格自己的 store + 订阅，`afterEach` 统一撤（见本节开头那句"下一格收走上一格"）。 */
const stops: Array<() => void> = [];

function mount(f: Fake) {
  const [store, stop] = createProjectStore(f.api, useEditor);
  stops.push(stop);
  return store;
}

/** 把 `open` 走完（含 `loadProject` 那一发订阅与 `put` 那一发），并等 `submitJournal` 的微任务落地。 */
async function openProject(f: Fake, store: ReturnType<typeof mount>, init?: Parameters<typeof openValueFixture>[0]) {
  f.queue.push(openValueFixture(init ?? {}));
  await store.getState().open(SERVER_PID);
  await tick();
}

afterEach(() => {
  for (const stop of stops) stop();
  stops.length = 0;
  resetEditor();
});

describe('readDajia：node 档与注入档', () => {
  it('没有 window 回 null；挂上 window.dajia 回**同一个引用**；撤掉又回 null', () => {
    const g = globalThis as { window?: { dajia?: DajiaApi } };
    expect(readDajia()).toBeNull();
    const api = makeApi().api;
    g.window = { dajia: api };
    expect(readDajia()).toBe(api);
    delete g.window;
    expect(readDajia()).toBeNull();
  });
});

describe('初始态与打开失败', () => {
  it('刚建好：phase off、banner null，屏幕上还是样例房且可写（⑧段那一屏）', () => {
    resetEditor();
    const f = makeApi();
    const store = mount(f);
    const s = store.getState();
    expect(s.phase).toBe('off');
    expect(s.opened).toBeNull();
    expect(s.failure).toBeNull();
    expect(s.save).toBeNull();
    expect(s.closedReport).toBeNull();
    expect(s.banner).toBeNull(); // ⇒ App 一个 DOM 节点都不渲染
    // 屏幕没被碰：还是样例房那一份、还是可写。`DEMO` 是 import 那一刻取的引用（⑤ 段），
    // 这一格刚 `resetEditor()` 过 ⇒ 判"这一发 store 建起来有没有顺手改屏幕"只有拿它对照才判得出。
    expect(useEditor.getState().log).toBe(DEMO.log);
    expect(useEditor.getState().readOnly).toBe(false);
    expect(f.submits.length).toBe(0);
    // 模块级 `useProject` 也在监听同一个 editor 单例，但它 `phase === 'off'` ⇒ 订阅体第一道闸门就拦住。
    // 这一格因此同时是"两份 store 互不干扰"的凭据：判据是 `f.submits` 空，而不是"看起来没事"。
  });

  it('回 `{ok:false, code:\'not-configured\'}` ⇒ red 横幅、phase 回 off、真源**没换手**', async () => {
    resetEditor();
    const f = makeApi();
    f.box.openFail = { code: 'not-configured', message: '没读到 DAJIA_MYSQL_* 环境变量' };
    const store = mount(f);
    await store.getState().open(SERVER_PID);
    const s = store.getState();
    expect(s.phase).toBe('off');
    expect(s.opened).toBeNull();
    expect(s.failure).toEqual({ code: 'not-configured', message: '没读到 DAJIA_MYSQL_* 环境变量' });
    expect(s.banner?.tone).toBe('red');
    expect(s.banner?.text).toBe('没读到 DAJIA_MYSQL_* 环境变量');
    expect(s.banner?.closable).toBe(false);
    expect(s.banner?.reopenable).toBe(false);
    // 真源没换手：样例房那一份 `TransactionLog` 实例还在原处。这一句必须与 `DEMO`（import 那一刻
    // 从活状态取的引用，⑤ 段）比 —— 拿 `useEditor.getState()` 现读一份去和它自己比是假判据：
    // 这一格刚 `resetEditor()` 过，现读读到的正是"没换手"想判的那一份，谁都过。
    expect(useEditor.getState().log).toBe(DEMO.log);
    expect(useEditor.getState().storeyId).toBe(DEMO.storeyId);
    expect(useEditor.getState().readOnly).toBe(false);
    // 只发了一次（失败那支不许重试），而且**没消费任何回包**：走的是 `!r.ok` 那一支，不是成功那一支。
    expect(f.opens).toEqual([SERVER_PID]);
    expect(f.queue.length).toBe(0);
  });
});
```

> 格 3 落地的形状就是上面那段：失败回包由 `f.box.openFail` 给，而不是把 `f.api.openProject`
> 整个换掉 —— 换掉的话夹具里 `opens.push(...)` 那一行就走不到，`expect(f.opens).toEqual([SERVER_PID])
> 会红在夹具上而不是代码上。「真源没换手」那三句必须与 `DEMO` 比（import 那一刻从活状态取的引用）：
> 这一格刚 `resetEditor()` 过，拿 `useEditor.getState()` 现读一份与它自己比是**假判据**，谁都过。

剩下 8 格（4…11）照下面的清单逐格落地，每格的判据都要**能区分"做了"与"没做"**（同族口径：`expect(x).toBe(x)` 那种不算）：

**格 4「open 成功那一支：换手 + 六格读数 + 横幅那一句灰话 + **零发账**」**
`openProject(f, store)` 之后逐条断：
- `store.getState().phase === 'open'`；`opened` 的 `projectId === SERVER_PID`、`decision === 'edit'`、`name === '样例房'`、`wasCleanShutdown === true`、`replayedRows === 0`、`emergencyCount === 0`、`emergencyHint === ''`。
- `useEditor.getState().log.document.equals(SERVER.doc) === true`（换手到手的是**回包那一份**，不是样例房那一份 —— `SERVER` 与 `DEMO` 是两套随机 id 的房子，这一句只有真换手才成）。
- `useEditor.getState().readOnly === false`。
- `banner.tone === 'grey'`、`closable === true`、`reopenable === false`、`text` 含 `'样例房'` 与 `'已保存到第 0 发'`（`save` 还没来过 ⇒ 兜底那一句里的 `lastTurn` 取 `?? 0`，这是①段那句"屏幕上的第几发只能读 `SaveStatus`"的形状）。
- **`f.submits.length === 0`** —— 样例房那份 `lastPatch`（非 null！）与 `loadProject` 那一发扳机都不许变成账。这一句是 ⑤段 `lastSeen` 初值那三行注释的唯一凭据，删掉它那两个写法就分不出来了。

同一格再加**两段**（各自一根新的 `f2`/`f3` 针 + `mount` + `openProject`，别复用 `f`：横幅文案是"最后一发 `put` 的产物"，在同一份 store 上开两次会把上一段的读数搅进去）。这两段是 `computeBanner` 第 6、7 条优先级与 spec §9 那句"明确告知恢复了什么"在屏幕侧**唯一**的落地 —— 少了它们，那两条分支就是没有读者的代码，而 T8 恰恰是它们第一次有读者的那一发：
- **第二段**：`openValueFixture({ wasCleanShutdown: false, replayedRows: 2 })` ⇒ `banner.tone === 'amber'`、`text` 同时含 `'上次没有正常结束'` 与 `'重放 2 发'`、`closable === true`、`reopenable === false`（⑦段那句"没有 `before-quit`，靠的就是这一格"的屏幕侧对应物）。**`opened.wasCleanShutdown === false` 也断一句**：横幅那句话的读数来源就是它，只断文案会让"文案写死"这一型过界。
- **第三段**：`openValueFixture({ emergencyCount: 3 })`（`wasCleanShutdown` 回到默认的 true ⇒ 第 6 条不抢话）⇒ `banner.tone === 'amber'`、`text` 含 `'盘上留着 3 份没并进库的现场'`、`opened.emergencyCount === 3`，且 `text` 含夹具里**最新那份**的 `path` 片段（`emergency.at(-1)?.path` 那一行的凭据：`openValueFixture` 给的是 `…-turn-3.json`，断 `text.includes('turn-3')` 就够 —— 断完整路径等于把夹具的形状钉进判据）。
- 三段各配一发"不许抢话"的反判据：第二段那句 `expect(banner.text).not.toContain('盘上留着')`；第三段那句 `expect(banner.text).not.toContain('上次没有正常结束')`。这两句钉的是**优先级顺序本身**（6 压在 7 上）—— 只有文案没有这两句时，把第 6、7 条 `if` 换成 `||` 合并成一发也能绿。

**格 5「read-only：闸门 + 横幅 + 双保险」**
`openProject(f, store, { decision: 'read-only' })` 之后：`readOnly === true`；`banner.tone === 'amber'` 且 `text` 含 `'只读打开'`；`f.submits.length === 0`；然后 `useEditor.getState().dispatch(wallSetMaterial({ wallId: SERVER.doc.byKind('wall')[0].id, material: '混凝土' }))` ⇒ `lastError` 以 `只读工程：` 开头、`f.submits.length` 仍是 0（**两道闸门同时落下**：editorStore 挡住 dispatch，所以连"发"的机会都没有；把 `setReadOnly` 那一行摘掉，这一句就红在第二道闸门上而不是第一道，两道的读者不同 —— 这一格的存在就是为了把这两道分成两次可判的红）。

**格 6「改一发 = 一发账，undo 也是一发」**
`openProject` 后清 `f.submits.length = 0`；取 `const w = SERVER.doc.byKind('wall')[0]`；
- `dispatch(wallSetMaterial({ wallId: w.id, material: '混凝土' }))` ⇒ `f.submits.length === 1`，且 `f.submits[0].patch === useEditor.getState().log.lastPatch`（**对象身份**，不是 `toEqual` —— ⑨段判的就是身份）、`f.submits[0].projectId === SERVER_PID`；
- `documentFromPayload(f.submits[0].doc, 'test').get(w.id)?.material === '混凝土'`（那一发配的快照是**这一发之后**的真源）；
- `useEditor.getState().undo()` ⇒ `f.submits.length === 2`，且 `f.submits[1].patch !== f.submits[0].patch`（逆补丁是另一个对象）、`documentFromPayload(f.submits[1].doc, 'test').get(w.id)?.material === w.material`（退回旧值 —— 撤销在库里是一发**新**账，不是删掉上一行）。
- `await tick()` 在两发之间各一次：`submitJournal` 那支的 `.then` 是微任务，`failure` 清除那一格要它跑完。

**格 7「视图动作一发都不发」（⑨段的靶子）**
`openProject` 后清 submits；`useEditor.getState().setStorey(tabs[1].storeyId, fitStorey(SERVER.doc, tabs[1].storeyId, 800, 600))`、`setTool('wall')`、`setViewport(另一份 fitStorey 的产物, ...)` 各一次 ⇒ `f.submits.length === 0`，而 `useEditor.getState().revision` 明显变了（**必须同时断这一句**：只断"没发账"而 revision 也没动的话，红的是"扳机根本没扳"，看不出订阅体在不在工作。`tabs` 从 `storeyTabsOf(SERVER.doc, SERVER_PID)` 取，那一行 import 已经在文件顶部那一族里）。
`setDrag`/`setDraft` 不进这一格：`DragState` 要一把真把手（`pickHandle` 的产物），为凑夹具去 scene-2d 造一把等于让这一格测的是 handle 工厂；`setStorey` 已经代表"扳机响但账没换"那一型。

**格 8「`dispatchBatch` 三条 = 三发账，且每发配它自己那一刻的整份快照」（P-21 的凭据）**
`openProject` 后清 submits；取 `const walls = SERVER.doc.byKind('wall')`、`const baseMat = [walls[0].material, walls[1].material, walls[2].material]`；
`dispatchBatch([material(walls[0],'P-1'), material(walls[1],'P-2'), material(walls[2],'P-3')])`，`await tick()`：
- `f.submits.length === 3`（**这一句就是 P-21 的靶子**：改回"一批一扳"它变 1）；
- 三发 patch 两两不是同一对象（`f.submits[0].patch !== f.submits[1].patch` 等三句）；
- 第一发的快照里第二、三面墙**还是旧材料**：`documentFromPayload(f.submits[0].doc, 'test').get(walls[1].id)?.material === baseMat[1]`；
- 第三发的快照里第二面已是 `'P-2'`：`documentFromPayload(f.submits[2].doc, 'test').get(walls[1].id)?.material === 'P-2'`。
（后两句是"每发配同源快照"的判据 —— 只数条数的话，把三次编码全写成最终态那份 doc 也能绿。那正是 `submitOne` 里"编码在 await 之前"那行注释要的证人。）
再加半途失败那一支：清 submits，`dispatchBatch([material(walls[3],'Q-1'), material(不存在的 id,'Q-x'), material(walls[4],'Q-2')])` ⇒ `f.submits.length === 1`（第三条根本不该应用）、`lastError` 以 `删不动：` 开头、`useEditor.getState().log.depth` 比调用前**只多 1**。

**格 9「保存状态事件驱动横幅，`stop()` 两条订阅都撤干净」**

```ts
  it('保存状态驱动横幅四档；`stop()` 撤掉事件订阅**和**编辑订阅', async () => {
    const f = makeApi();
    const [store, stop] = createProjectStore(f.api, useEditor); // 不用 `mount`：这一格要 `stop` 本体
    stops.push(stop);
    await openProject(f, store);
    expect(f.listeners.length).toBe(1);

    f.listeners[0](STATUS_IDLE);
    expect(store.getState().save?.phase).toBe('idle');
    expect(store.getState().banner?.text).toContain('已保存到第 7 发');
    f.listeners[0]({ ...STATUS_IDLE, phase: 'paused', pauseReason: '锁已丢' });
    expect(store.getState().banner?.tone).toBe('red');
    expect(store.getState().banner?.reopenable).toBe(true); // 第 ⑤ 段的出路在这一屏上长成一个按钮
    // 第四档 = `computeBanner` 的第 5 条（`failed`）。它与上一档只差一个 `phase`，判据差在两端：
    // `failed` 给的是"查服务"（下一步动作在库那侧，`reopenable` 必须回 false —— 重开也修不好断连），
    // `paused` 给的是"别再写了"（下一步动作在用户这侧）。少了这一发，第 5 条那一句就没有读者，
    // 而把 3、5 两条并成一个 `if` 也照样绿 —— 那一并正是"每个码都有下一步动作"③段最容易被磨平的形状。
    f.listeners[0]({ ...STATUS_IDLE, phase: 'failed', lastError: 'ECONNREFUSED' });
    expect(store.getState().banner?.tone).toBe('red');
    expect(store.getState().banner?.text).toContain('保存失败：ECONNREFUSED');
    expect(store.getState().banner?.reopenable).toBe(false);

    const callback = f.listeners[0];
    stop();
    // (a) 事件那一半：注册表空了。`onSaveStatus` 返回空函数的话这一句红 —— 而**不能**改成
    // "再调一次 `callback`，看 `save` 更没更新"：手里已经抓住的那个闭包永远还能写 store，
    // 生产里 `removeListener` 之后根本不会再有人调它。假把式能证的只有引用有没有撤干净。
    expect(f.listeners.length).toBe(0);
    callback({ ...STATUS_IDLE, phase: 'saving', queuedTurns: 9 }); // 拿着旧引用硬打一发：不作为判据
    // (b) 编辑那一半：订阅也撤了。这一句才是本节开头"下一格收走上一格的编辑"的证人。
    f.submits.length = 0;
    useEditor.getState().dispatch(wallSetMaterial({ wallId: SERVER.doc.byKind('wall')[0].id, material: '混凝土' }));
    await tick();
    expect(f.submits.length).toBe(0);
    // `afterEach` 会对同一个 `stop` 再发一次：`removeListener` 与夹具的 `splice` 都吃重复，
    // 所以这一格不需要把 `stop` 从 `stops` 里摘出去（摘出去反而会让"忘了撤"那一型失去守卫）。
  });
```

**格 10「`reopenAsEdit()` = 先 abandon 再 open，顺序读得出来」**

`openProject`（edit）→ 塞一个 paused 状态（`f.listeners[0]({ ...STATUS_IDLE, phase: 'paused', pauseReason: '锁已丢' })`，把横幅推到 `reopenable === true` 那一档，这一发才像在真实出路按的钮）→ `f.queue.push(openValueFixture({}))`（重开那一发的回包）→ `await store.getState().reopenAsEdit()` → `await tick()`。判据吃**一根共享的 `calls: string[]` 针**（夹具里三个假把式各记一条 `'open'` / `` `close:${mode}` `` / `'submit'`；同族先例：`session.test.ts` 的夹具订正 —— `toEqual` 逐字比一串名字才读得出"少一步"和"顺序反了"，分开数 `closes.length` 与 `opens.length` 只能证"各来了一次"）：
- `f.calls` 逐字等于 `['open', 'close:abandon', 'open']`；
- `f.closes[0].mode === 'abandon'`；`f.opens` 长度 2 且两次都是 `SERVER_PID`；
- `store.getState().phase === 'open'`、`useEditor.getState().readOnly === false`（从只读那一支翻回可写只有一条路：重开）；
- `documentFromPayload(f.closes[0].doc, 'test').equals(SERVER.doc) === true` —— 交上去的是**换手之后**那份文档，不是样例房那一份（`abandon` 不跑对账 ⇒ `CloseValue` 两格 null，夹具已经按这个形状回了）。

**同一格的第二段：`closeSession('graceful')` 的那两格读数有人读**（另起一根针 `f2 = makeApi()` + `mount(f2)` + `openProject(f2, store2)`，免得把上面那串 `calls` 搅长）。`await store2.getState().closeSession('graceful')` 之后逐条断：
- `f2.calls` 逐字等于 `['open', 'close:graceful']`（模式名进针里就是这一句的用处：`abandon` 与 `graceful` 在源码里只差一个词）；
- `store2.getState().phase === 'closed'`、`failure` 仍是 null、`closedReport` 逐字等于 `{ elementRows: 31, storeyRows: 2 }`（夹具给的那一份，原样过界没人重算）；
- `banner.tone === 'grey'` 且 `banner.text` 同时含 `'31 行元素'` 与 `'2 行楼层'`，`closable === false`（关了就没有第二个关）；
- `useEditor.getState().readOnly === true`，且再 `dispatch` 一发墙材料 ⇒ `lastError` 以 `只读工程：` 开头、`f2.submits.length === 0` —— 这一句是 `setReadOnly(true)` 放在 `r.ok` 判断**之外**那条注释的唯一证人：把 `close` 的回包换成 `{ok:false}` 那一支也得落下闸门，而成功这一支同样不许漏。
- 收尾再证一句"**关了之后可以重开**"（第 ⑤ 段那条顺序的另一半）：`f2.queue.push(openValueFixture({}))` 之后 `await store2.getState().open(SERVER_PID)` ⇒ `f2.calls` 以第三个 `'open'` 收尾、`phase` 回 `'open'`、`useEditor.getState().readOnly === false`（`open` 成功那一支自己会把闸门抬回去）。**`open` 的闸门只挡 `opening / open`，不挡 `closed`** —— 这一句就是它不挡的凭据，落地时别"顺手"给它加第三道 phase 判据（加了这一句就红，而 `reopenAsEdit()` 那条路也会被同一道闸拦死）。

**格 11「`'reconcile'` 停手，`'db'` 不停手」**
`openProject`（edit）→ `f.box.submitFail = { code: 'reconcile', message: '三方对账不平' }` → `dispatch` 一发 → `await tick()` ⇒ `banner.tone === 'red'`、`banner.text` 含 `'三方对账不平'`、**`useEditor.getState().readOnly === true`**（③段那句"reconcile 的下一步动作是停下来别再写了"在屏幕侧唯一的落地）。
另起一个 store：`f2.box.submitFail = { code: 'db', message: 'ECONNREFUSED' }` → 同样的 dispatch → `await tick()` ⇒ `banner.tone === 'red'`（同一格文案位置）但 `readOnly === false`（服务断了不代表账错了 —— 把用户的编辑权拿走才是更坏的消息）。
这一格的两支必须**各自一个 store**：`readOnly` 是 editor 单例上的格，前一支设成 true 之后不 reset 就会串到后一支，得到一个"两边都只读"的假绿。

Run: `npx vitest run apps/desktop/test/unit/editor-store.test.ts apps/desktop/test/unit/project-store.test.ts > tmp/t8-screen.log 2>&1; echo "exit=$?"`
Expected: `exit=0`，共 **20 格**（editor-store 9 + project-store 11）。若 `project-store.test.ts` 全体红在 `ReferenceError: window is not defined`，那是 `readDajia()` 的 `typeof window` 那一行被写成了模块顶层的常量 —— 本档 11 格能 import 这个文件这件事就是那道保险的证人。

Run: `npx tsc --noEmit -p apps/desktop/tsconfig.json > tmp/t8-screen-tsc.log 2>&1; echo "exit=$?"`，再 `npx tsc --noEmit -p apps/desktop/tsconfig.test.json > tmp/t8-screen-tsc-test.log 2>&1; echo "exit=$?"`
Expected: 两发都 `exit=0`。**两发都要跑**：前一份 program 里没有测试文件（`include` 是 `src/main`/`src/preload`/`src/shared`/`src/renderer/src`），后一份没有 `App.tsx`/`panels.tsx`（它们不被任何测试 import）—— 只跑一发会得到一个绿的假象，而 `declare global` 搬家（本节 ④ 段那条理由）恰恰是只有后一份才看得见的那一型错。

**交给 T9 的两件事**（写在这里是因为它们是 T8 的形状留下的口子，不是 T9 自己发明的）：
1. 这一屏**没有**任何"打开工程"的入口：`useProject.getState().open(id)` 在生产里的读者是 T11 的 `--persist-shot`（它经 main 递 id 进来），T9 才把它接进 UI。同理 `reopenAsEdit()` 的按钮由 `banner.reopenable` 给出形状，但按钮**在横幅上**、横幅会在 T9 整理界面时搬进面板（⑧段最后一句）。
2. 只读会话**没有**"重试接管"：横幅上只有「关闭工程」。重开一个 read-only 会话再抢一次锁 = `closeSession('abandon')` + `open(id)`，`reopenAsEdit()` 这个名字与它的 `reopenable` 判据今天都只对**丢了的写锁**开放。T9 要放宽的话，改 `computeBanner` 第 3 条那一句的判据（`save !== null` → 加 `|| o.decision === 'read-only'`），别改 `submit` 那三道闸门。

**本档登记的限度**（Step 8 汇总时并进"登记的限度"）：
① `dispatchBatch` 半途失败那一支在**真源**上留下已应用的前几发（改前也一样，且 `S5` 那条命令顺序就是为它排的），本档只保证这些发各有一发账 —— "一次删除要么整组进库要么整组不进"这个批语义在 S1 **不存在**，它是计划 4 真源侧没排的决定。
② 20 格里没有一条真 IPC：`ipc-persist.ts` 那三格凭据仍是 Step 4 登记的那三条（`tsc` + `ipc-channels.test.ts` 扫描 + 真窗口闸门与 T10/T11）。屏幕侧测的是"store 与假 api 之间"的那一层，`window.dajia` 这个对象在生产里由 contextBridge 给 —— 它是**唯一一个没被任何测试构造过的边界**，那一发的凭据只能来自 Step 8 的 `--prop-shot`（它跑的是真窗口、真 preload）。
③ `NOT_INJECTED` 那一支（漏注入）在生产路径上没有测试覆盖它的**触发**（node 档永远没有 `window`，格 1 判的是 `readDajia()` 的回 null，不是"Electron 里 preload 真的没注入"）。spec §9 要的那句分型诊断在这种情况下会说什么，靠 格 2 的初始态与 格 3 的形状间接保证。
④ 闸门吃 `undo`/`redo` 之后，`closeSession` 那一屏连带失去"退回去看看刚才改了什么"的能力（屏幕上没有一句话解释为什么退不动，只有 `lastError`）。S1 接受：账本关了还能退，比这个不便更危险。

---

- [ ] **Step 7: 横幅上屏 —— `App.tsx` 的固定横幅 + `--prop-shot` 那一发"零节点"探针**

**① `apps/desktop/src/renderer/src/App.tsx` 整文件替换**

```tsx
import { PlanCanvas } from './PlanCanvas';
import { useProject } from './stores/projectStore';
import type { ProjectBanner, ProjectBannerTone } from './stores/projectStore';

/**
 * 两件事在这一发同时成立才叫"闸门环境一字不动"：
 * 1. `banner === null`（`phase === 'off'` ⇒ `computeBanner` 第 2 条回 null，见 projectStore 那段注释）；
 * 2. 那一支渲染的是 `null` 而不是一个空 div —— 于是 ③ 段那一发 DOM 探针读回来是 0，不是 1。
 * `declare global` 那块已经搬进 `projectStore.ts`（Step 6 ④ 段：测试那一份 program 不 import 本文件，
 * 声明留在这里 `readDajia()` 就编不过），所以本文件不再 import `DajiaApi`。
 */
export default function App(): React.JSX.Element {
  const banner = useProject((s) => s.banner);
  return (
    <>
      <PlanCanvas />
      {banner === null ? null : <SessionBanner banner={banner} />}
    </>
  );
}

const TONE_BG: Record<ProjectBannerTone, string> = {
  red: '#8b1d1d',
  amber: '#8a5a00',
  grey: '#2b2f36',
};

function SessionBanner({ banner }: { banner: ProjectBanner }): React.JSX.Element {
  return (
    <div
      data-dajia-banner=""
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        // `fixed` + 不占流：⑧段那句话的形状 —— 会盖住画布下缘，S1 接受（T9 整理界面时搬进面板）。
        // 但**不许**挤占任何 flex 尺寸：多一根 24px 的常驻条就把 `fitStorey` 量到的画布高度挪走了，
        // 全体像素判据（1167×833 / 墨迹 30742 / click=(113,416)）随之作废。
        padding: '6px 10px',
        color: '#f2f2f2',
        background: TONE_BG[banner.tone],
        fontSize: 12,
        lineHeight: '18px',
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        zIndex: 10,
      }}
    >
      <span>{banner.text}</span>
      {banner.closable ? (
        <button type="button" onClick={() => void useProject.getState().closeSession('graceful')}>
          关闭工程
        </button>
      ) : null}
      {banner.reopenable ? (
        <button type="button" onClick={() => void useProject.getState().reopenAsEdit()}>
          重新接管
        </button>
      ) : null}
    </div>
  );
}
```

三个写法各有理由，别在评审时被问倒：
- **`useProject.getState()` 在 handler 里，不在组件顶层**：两个按钮要的只是**动作引用**（永远稳定），订阅它们等于让每次保存状态变化都重渲一次横幅以外的东西。同族先例：`PlanCanvas` 那句"走 `getState()` 而不是订阅"（本文件 ② 段改动 5 的 `reportPaintError` 也是同一个口径）。
- **`data-dajia-banner=""`**：② 段那一发探针的靶子。用属性而不是类名 —— 类名会被任何一次样式重构碰掉，属性是这一族测试与屏幕之间唯一的契约。（仓里没有 CSS 文件：`apps/desktop/src/renderer` 下 `find -name "*.css"` 回空，全部样式是内联的，所以这里也不开第一个 CSS 文件。）
- **`React.JSX.Element` / `React.` 命名空间没有 import**：与本文件盘上现物同形（`jsx: 'react-jsx'` 的自动 runtime + `@types/react` 的全局 `React` 命名空间），改它要连带 import 一行 —— 不动。

**② `apps/desktop/src/main/index.ts`：`runPropShot` 里加一发探针**

位置在 **15) 终态**那六道 `throw` 之后、`// 逐步读数` 那句注释之前（盘上 2351 行与 2353 行之间）。这一段的键名不在 `fin` 里，撞车守卫在下一节（`collided`）会替它兜着。

```ts
  // 15b) 横幅在这一屏上必须一个节点都不渲染（⑧段的 DOM 侧凭据，与终态那一份视口/尺寸判据同一批）。
  // 判据放在 **main 侧**而不是脚本侧：脚本那边每加一条 PASS 行就要给 `expectedChecksByMode.prop`
  // 挪一个字面量（现物 30），而那五个数是闸门自己的账 —— 这一发的价值在"要么红要么根本不说"，
  // 不在"多一行绿"。读数照写进 `extras` 留档（见下面那份），红了能直接看到当时是几。
  const bannerNodes = (await win.webContents.executeJavaScript(
    'document.querySelectorAll("[data-dajia-banner]").length',
  )) as number;
  if (bannerNodes !== 0) {
    throw new Error(
      `闸门环境里屏幕上渲染了 ${String(bannerNodes)} 个横幅节点：` +
        '`useProject` 的 phase 应当在 off、banner 应当在 null`' +
        '（多出来的常驻 DOM 会把五道闸门的像素判据全体作废 —— ⑧段）',
    );
  }
```

（`extras` 里加一行 `bannerNodesAtPropGate: bannerNodes,`，紧跟在 `viewportAtStart` 那一族之后即可 —— 它是**收据**不是判据：上面那一发 throw 之后它恒等于 0，留着是为了报告里能看见"这一发放过言"。引号写法照上面那段：模板串里那句 markdown 反引号是**故意**不用的，报错文案里出现反引号会让人以为在读代码。）

**③ 计数与编译**

Run: `npx vitest run apps/desktop/test/unit/ipc-channels.test.ts apps/desktop/test/unit/persist-boundary.test.ts apps/desktop/test/unit/editor-store.test.ts apps/desktop/test/unit/project-store.test.ts > tmp/t8-banner.log 2>&1; echo "exit=$?"`
Expected: `exit=0`。四档格数按**盘上实测**记（计划数：3 + 5 + 9 + 11 = 28），回填里同时写 `persist-boundary.test.ts` 那一档里"renderer 的 protocol import 恒 type-only"这一格现在是**真的扫到了文件**还是扫了个空 —— 它自带 `files.length > 0` 的正控制，但把实测文件数一并抄进回填更有用。

Run: `pnpm --filter @dajia/desktop build > tmp/t8-build.log 2>&1; echo "exit=$?"`
Expected: `exit=0`。这一发不是仪式，它是**闸门自己会跑的那一发**（`scripts/desktop-shot.mjs` 第一手就是 `pnpm --filter @dajia/desktop build`，实测过的那一行在它 72 行的 `runPnpm('pnpm --filter @dajia/desktop build')`）：`src/shared/document-wire.ts` 被 `src/renderer/src/**` 相对 import 这件事，只有 rollup 的构建会说真话 —— `tsc` 只查类型，vite 的 `server.fs.allow` 只在 dev 起服时生效，而这两者都不在生产路径上。红法有两种，分开治：`Could not resolve "../../shared/document-wire"` ⇒ `electron.vite.config.ts` 的 root 比预期窄（**不许**改构建配置，改 import 路径写法或把 wire 挪进 `@dajia/core` 之外的第三个包都属于"给构建面找事"，停下来回报）；`@dajia/protocol` 被解析进 renderer chunk ⇒ `projectStore.ts` 里那条 `import type` 被写成了值 import（Step 4 ④ 段第 (c) 格的运行时对应物）。

Run: `pnpm typecheck > tmp/t8-typecheck.log 2>&1; echo "exit=$?"`
Expected: `exit=0`（四包 + desktop 的三份 tsconfig，T1 已经把 `tsconfig.test.json` 串进 desktop 那条 `typecheck`）。

**本步不许动的东西**（Step 8 复跑五道闸门之前先照这几条自查，改动面越小越好判）：`PlanCanvas.tsx` 除 Step 6 ③ 那一行依赖与那段注释之外一字不动；`panels.tsx` 一字不动；`electron.vite.config.ts` 一字不动；`index.html`/`main.tsx` 一字不动；`STOREY_TAB_HEIGHT_PX`、画布尺寸口径、`--prop` 的 `click=(113,416)` 三个闸门字面量一个都不许碰。

- [ ] **Step 8: 控制位独占全量复跑 + 提交**

**棒次（先把这一发交给谁定清楚，再谈命令）**：

- **Step 7 与 Step 8 不分给同一个座位。** 理由不是工作量，是同一发命令会在两步里各跑一次：Step 7 的最后一发是 `pnpm --filter @dajia/desktop build`（编译计数的靶子），Step 8 的第一发又是它（五道闸门各自内部还会再跑一次）。一个座位手里握着两发同名命令，第二发必然凭第一发的印象写回填 —— 本计划罚过的正是"把上一次绿抄成这一次绿"。
- **Step 8 的闸门复跑由控制位独占**（既有口径：席位不跑闸门）。席位在 Step 1…7 里只跑自己那几档 `npx vitest run <file>`，回报里给的是**格数与判据**，不是闸门读数。
- **变异表单独一棒**，`cp` 备份 + md5 还原；座位上**不许** `git checkout`/`switch`/`restore`/`stash`/`reset`/`clean`。

控制位跑法（五道闸门一律 `> tmp/*.log 2>&1; echo exit=$?`，绝不 `| tail` —— 判据条数与那句 JSON `report` 都在日志尾部，管道会吃掉它）：

```bash
pnpm verify > tmp/t8e-verify.log 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' tmp/t8e-verify.log | grep -E "^ *(Test Files|Tests) |FAIL"
pnpm test:db > tmp/t8e-db.log 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' tmp/t8e-db.log | grep -E "^ *(Test Files|Tests) |FAIL"
npx tsc --noEmit -p apps/desktop/tsconfig.json > tmp/t8e-tsc-main.log 2>&1; echo "exit=$?"
npx tsc --noEmit -p apps/desktop/tsconfig.test.json > tmp/t8e-tsc-test.log 2>&1; echo "exit=$?"
pnpm --filter @dajia/desktop build > tmp/t8e-build.log 2>&1; echo "exit=$?"
pnpm shot      > tmp/t8e-shot.log 2>&1; echo "exit=$?"
pnpm pick-shot > tmp/t8e-pick.log 2>&1; echo "exit=$?"
pnpm edit-shot > tmp/t8e-edit.log  2>&1; echo "exit=$?"
pnpm draw-shot > tmp/t8e-draw.log  2>&1; echo "exit=$?"
pnpm prop-shot > tmp/t8e-prop.log  2>&1; echo "exit=$?"
git status --porcelain
```

Expected：

1. `pnpm verify` `exit=0`。`Test Files` 比 T7 的回填值 **+6**（`persist-schema` / `document-wire` / `session` / `ipc-channels` / `editor-store` / `project-store` —— 全是新档），`Tests` **+61**，拆开是 protocol 10 + document-wire 7 + session 16 + ipc-channels 3 + editor-store 9 + project-store 11 + emergency 2 + persist-boundary 3。
   - **`Test Files` +7 或 +8**：有人把夹具命名成了 `*.test.ts`（`fake-timer.test.ts` / `editor-fixtures.test.ts`）。夹具不是档，改回名字，别给 `vitest.config.ts` 的 include 开洞。
   - **`Tests` +58**：少的 3 格只会是 `persist-boundary.test.ts` 那一族里新加的三个（它改的是既有档，新格被"顺手"并进了 T7 那两个 `it` 的话，计数就不涨）；**+59** 少的 2 格同型，在 `emergency.test.ts`。这两档的红法都是"追加变成了合并"，按 Step 3/4 的原文把它们各自成 `it`。
   - **`autosave.test.ts` 仍是 24 格**（假钟搬去 `fake-timer.ts` 的那一发不许丢东西）；`codec.test.ts` 的格数与 T4 回填一致（委托没削牙）。这两个数在 `verify` 的逐档输出里读，不用单跑。
2. `pnpm test:db` `exit=0`，`Test Files` 与 `Tests` 与 T7 的回填值**一字不差** —— T8 不新增连库档。这一发仍然必须跑，因为它是 `codec.ts` 那两行委托的**下游**：`test/db/repository.test.ts` 与 `test/db/autosave-journal.test.ts` 都经 `decodeDocument` → `documentFromPayload` 读快照，而这条链在 `verify` 里只被 `document-wire.test.ts` 的假 payload 摸过。**若这一发红而 `verify` 绿**：`codec.ts` 里那六个"一字不动"的名字（`RowRef` / `where` / `asJsonValue` / `encodeEntity` / `decodeEntity` / `encodePatch`）被人顺手改了，按 T4 原文还原，不许改判据。
3. 两份 tsconfig 各 `exit=0`，**两发都要单独跑**。`pnpm verify` 里那一串 `typecheck` 也覆盖它们，但两发同码各跑一次读的是**哪一份红**：`declare global` 搬家那一型（TS2717，Step 6 ④ 段）只有 `tsconfig.test.json` 看得见；`ipc-persist.ts` 的三处形状（`db.raw as Pool`、`readEmergency: listEmergency` 的结构赋值、`EmergencyPayload` → `EmergencyInput`）只有 `tsconfig.json` 看得见。只跑 `verify` 会得到一句红而说不出是谁红的。
4. `pnpm --filter @dajia/desktop build` `exit=0`，红法两型按 Step 7 ③ 那一段治（`Could not resolve "../../shared/document-wire"` ⇒ 构建 root；`@dajia/protocol` 进了 renderer chunk ⇒ `import type` 被写成值 import）。**不许**动 `electron.vite.config.ts`。
5. 五道闸门 `exit=0`，PASS 条数 **6 / 11 / 22 / 28 / 30**（`shot` / `pick` / `edit` / `draw` / `prop`），FAIL **0**。那五个数在 `scripts/desktop-shot.mjs:346` 的 `expectedChecksByMode` 里，是**闸门自己的账** —— 本任务只往 main 侧加了一发会抛的探针（15b），它不给 PASS 名单加一条。
   - **`--prop-shot` 报"判据条数对不上：实到 31"** ⇒ 有人把 15b 搬到了脚本侧（每条 PASS 都要动那个字面量，等于让测试改闸门的账）。搬回 main 侧，判据一字不动。
   - **`--prop-shot` 报 `闸门环境里屏幕上渲染了 N 个横幅节点`** ⇒ Step 7 ① 那一支渲染了常驻 DOM（⑧段）。这是唯一一条会因"多一个空 div"而红的判据，别用调尺寸绕开。
   - 超时口径照盘上现物：`draw` 与 `prop` 各 300s，其余 180s，前面都还有一发 `build`。慢机上先确认是超时还是 FAIL 再谈复跑。
6. `git status --porcelain` 里**不许出现**：`dajia-emergency-*` / `dajia-session-*` 之类的临时目录、任何 `*-turn-<n>.json`、`apps/desktop/out/**`、`tmp/*.log`（后两样 `.gitignore` 已收，出现说明忽略规则被改过）。真出现 ⇒ `userDataDir` 被写成了仓库路径，那是测试自己的缺陷，先修测试再谈落盘。
7. 跑完确认库清干净（命令同 T6 Step 5 那一发，**从 `apps/desktop` 目录跑**，`node -e` 按 cwd 解析裸说明符）。Expected：输出里既没有 `dajia_test` 也**没有 `dajia`**。后一句是本任务新增的收据：T8 是第一个在生产侧连库的任务（`ipc-persist.ts` 的 `openDb` 真会 `createConnection`），而它**不该建库** —— 建库是 T9 向导的职责，也是本计划唯一行使那条建库授权的地方。若 `dajia` 出现了：有代码绕过了 T2 的 `assertDatabaseName` ⇒ **停手回报，不自己删库**（授权里没有 DROP）。

提交（代码棒只提交 `src` 与 `test`，`docs/` 归控制位）：

```bash
git status --porcelain
git diff --stat
git add packages/protocol/src/ipc.ts packages/protocol/src/entity-schema.ts \
  packages/protocol/src/persist-schema.ts packages/protocol/src/index.ts \
  packages/protocol/test/persist-schema.test.ts \
  apps/desktop/src/shared/document-wire.ts apps/desktop/src/main/db/codec.ts \
  apps/desktop/tsconfig.json \
  apps/desktop/test/unit/document-wire.test.ts apps/desktop/test/unit/fake-timer.ts \
  apps/desktop/test/unit/autosave.test.ts apps/desktop/test/unit/session.test.ts \
  apps/desktop/src/main/persist/session.ts apps/desktop/src/main/persist/emergency.ts \
  apps/desktop/test/unit/emergency.test.ts \
  apps/desktop/src/main/ipc-persist.ts apps/desktop/src/main/index.ts \
  apps/desktop/src/preload/index.ts \
  apps/desktop/test/unit/ipc-channels.test.ts apps/desktop/test/unit/persist-boundary.test.ts \
  apps/desktop/src/renderer/src/stores/editorStore.ts apps/desktop/src/renderer/src/stores/projectStore.ts \
  apps/desktop/src/renderer/src/PlanCanvas.tsx apps/desktop/src/renderer/src/App.tsx \
  apps/desktop/test/unit/editor-fixtures.ts apps/desktop/test/unit/editor-store.test.ts \
  apps/desktop/test/unit/project-store.test.ts
git commit -m "$(cat <<'EOF'
feat(persist): IPC 契约与会话接线 —— 五条通道、一个会话、一条横幅

protocol：persist-schema.ts 把请求方向一律钉成 strictObject（多一键即拒，password 键
单独一格），错误码闭集 7 个，parse 出口按通道具名；SaveStatus 的键集合与 autosave.ts
做源码级对账，autosave 加字段而 UI 看不见那一型从此有牙。

desktop/shared：document-wire.ts 是 payload ↔ Document 的唯一产地（P-19），codec.ts
的 encode/decode 改成委托，重复 id 的文案逐字保留 —— T4 那两格正则一字不动。

session.ts：编排 electron-free / fs-free / mysql-free（P-2 的第三个证人）。取号在解码
之后（坏请求吃掉一个号 = 永久跳号）、'stopped' 之外只有 paused 停写、只读会话与 abandon
同路（绝不替别人宣告这库干净）、close 的顺序是 flush→closeProject→release→end。

ipc-persist.ts：本任务唯一新增的、许 import electron 的 main 文件；三格扫描档
（ipc-channels / persist-boundary）是它与 preload 的常驻证人。

renderer：projectStore 订阅 useEditor 的 log.lastPatch（对象身份，不是 revision —— 切层
不发账），三道闸门 + 'reconcile' 停手 / 'db' 不停手；editorStore 加 readOnly 与四处闸门，
dispatchBatch 按 P-21 每应用一条扳一次；App.tsx 的横幅在 banner===null 时一个节点都不渲染，
--prop-shot 的 15b 探针在 main 侧数那个节点数。
EOF
)"
```

---

**Task 8 的改坏验证**（变异棒，`cp` 备份 + md5 还原；**座位不许 `git checkout`/`restore`/`stash`/`reset`/`clean`**）：

用例引用一律用 `it` 的名字。⑦ 段那 8 格 prose 标题落地时 `it()` 第一参**逐字**取「」内的句子，所以本表的引用也就是盘上的名字。跑法同前：改坏一处 → 只跑受影响的档 → `cp` 还原 → 同码复跑确认回到绿。五道闸门不在这一棒里（控制位独占）。

| # | 改坏哪里 | 哪一格红、为什么 |
|---|---|---|
| T8-M1 | `OpenRequestSchema` 从 `z.strictObject` 换成 `z.object`（"宽松点好改"） | 「打开工程的请求只认 projectId 一个键：缺、多、非 UUIDv7 三型都拒」红（多一个 `name` 过了）；「带 password 键的请求一律拒（口令不进 IPC 的那道牙，第 ④ 段）红在 Open 那一支（Submit/Close 仍 strict ⇒ 三条里只有一条过）。**"以后加字段方便"的第一颗糖就是这么化的**：请求方向一旦宽松，T9 想往 `OpenRequest` 里塞 `host` 就没人红 |
| T8-M2 | `CloseRequestSchema.mode` 从 `z.enum([...])` 换成 `z.string()` | 「收尾请求的 mode 只认两值；缺 mode 与第三种拼法都拒」红；**session 那 16 格全绿** —— 假把式直接构造 TS 字面量，不经 parse。这一行是 P-20 那句"parse 只住在 IPC 外壳"的分工图示：`'force'` 那一型在生产里由 `ipc-persist.ts` 挡，`session.ts` 压根不认识它 |
| T8-M3 | `PERSIST_ERROR_CODES` 加第八个（如 `'timeout'`） | 「错误码是闭集：七个各过，`unknown` 与大小写不同都整包拒」第一句 `[...PERSIST_ERROR_CODES]` 逐字比数组即红。附注：`z.enum` 会跟着变宽，`session.ts` / `ipc-persist.ts` 的 `switch` 少一支而**无人红** —— 那一型只有 T9 的分型诊断读得到，所以闭集的默认答案永远是"不加新码" |
| T8-M4 | `SaveStatusSchema` 里 `pauseReason` 加 `.optional()` | 「SaveStatus 的键集合与 phase 取值 == autosave.ts 里那一份（源码对账）」红（"少任意一格也拒"那个 `for` 循环）。**`tsc` 不红**（`SaveStatusWire` 跟着变 optional，`projectStore` 的读点照编）、**五道闸门不红** —— 这一发是那一格存在的全部理由：autosave 加了字段而 UI 永远看不见，编译期是看不见的 |
| T8-M5 | `fail()` 的模板从 `${where} 解不开${what}：` 改成 `${what} 解不开：` | 「parse 出口的文案 = `<通道名> 解不开<那一句>：<点号路径>: …」红（正则 `^dajia:project:open 解不开…` 落空）。那串前缀是 T9 分型诊断的唯一线索：没有它，日志里三行"解不开请求"分不出是哪条通道 |
| T8-M6 | `INVOKE_CHANNELS` 摘掉 `IPC.projectClose`（"反正 close 走同一个 handler"） | protocol 侧「名册三条 + 事件那一条 == IPC 里除 ping 的全部（漏登记即红）」红；desktop 侧「名册里每一条都在 main 有 case、在 preload 有 invoke（只改一边就红）」也红（`INVOKE_CHANNELS.length === 3` 那发正控制）。**`tsc` 不红**（只是数组短一条）⇒ 名册这类"清单"的牙只能在扫源码的档里 |
| T8-M7 | `payloadFromDocument` 去掉按 id 升序（"Map 的插入序本来就是稳的"） | 「换个插入序得到**同一串字节**（排序是"字节稳定"的产地，不是 Map 的副产品）」红；「`encodeDocument(doc)` 与 `JSON.stringify(payloadFromDocument(doc))` 逐字节相同（委托没漂）」同型红；**`codec.test.ts` 第 9 格跟着红**（它拿 `encodeDocument` 的产物与 T4 形状表逐字节比）—— 三处证人，最后一处是 T4 那档在 T8 之后继续上岗的凭据 |
| T8-M8 | `documentFromPayload` 里重复 id 那道 `if` 删掉（"Map.set 取后者，反正不炸"） | 「重复 id 当场抛，文案与 T4 读盘那一条逐字相同（T4-M9 挪靶之后唯一的产地）」红；`codec.test.ts` 吃那条文案的两格红；**session「9. 坏 payload 吃掉一个号 = 永久跳号，所以解码必须在取号之前」也红** —— 不抛了那一发就把 8 号吃掉，下一发变 9。第三红才是这一发的价值：丢牙的后果不是"报错变少"，是库里从此永久跳号 |
| T8-M9 | `documentFromPayload(payload, where)` 里把 `where` 写死成 `'doc'`（或调用方不传） | 「抛错文案用的是**调用方**给的坐标：同一份 payload，两个标签给出两条不同的话」红；连带 `codec.test.ts` 那两条 `snapshot 行 3` 前缀红（委托把前缀吃掉了）。session「9.」不吃文案坐标，不红 —— 分工照旧 |
| T8-M10 | `open` 里 `this.issuedTurn = loaded.header.journalTurn` 换成 `= 0` | 「8. 连投三发 ⇒ 8、9、10（起点来自库里的 journalTurn=7），且补丁与文档原样到 sink」红（1、2、3；真库里是 `appendJournal` 撞跳号）。**「4. 拿到票…fromJournal 三格读数」不红** —— 那三格读的是引擎自己的账，`issuedTurn` 是会话侧的号，两份状态各有一个证人。这一对不连带红是有意的：它说明第 ① 段"收进主进程只剩一条纪律"确实只剩一处赋值 |
| T8-M11 | `new Autosave({ fromJournal })` 里 `rowsSinceSnapshot` 写死 0（"刚打开哪来新行"） | 「4. 拿到票 ⇒ edit、loadProject("edit")、引擎起来了，且 fromJournal 三格读数来自库里那份头」红（`rowsSinceSnapshot` 该是 2）。这一发是"每 2000 条"这个阈值**在重开之后仍然成立**的唯一凭据：T7 的阈值计数器住在引擎里，接错线就在重启后从头数 |
| T8-M12 | `listEmergency` 末尾那句 `found.sort((a, b) => a.turn - b.turn)` 删掉 | 「按 turn 升序给出本工程的每一份；别人的、形状不认识的一个都不许混进来」红（`[10, 4, 7]`：文件名序把 `-turn-10` 排在 `-turn-4` 前）。**这就是 Step 3 那格把最大一份从 9 改成 10 的全部理由** —— 全个位数时这一发造不出红 |
| T8-M13 | `listEmergency` 的词干筛选 `stem !== projectId` 放宽成"目录里都算" | 同一格红（B 那份混进来，且 `listEmergency(dirC, PID_B)` 那一发从 `[1]` 变 `[1, 4, 7, 10]`）；session「6. 回包逐字段同源…」不红（`readEmergency` 是假端口）。写侧与认侧同集合那条主张在 T7 有 `keep=2` 那一格，读侧的对应物就是这一格 |
| T8-M14 | `persistErrorCode` 改成一律 `'db'`（"驱动不都说话吗"） | 「3. 读盘拒开（不带 code 的抛）⇒ reconcile；端口自己定了码 ⇒ 原样上抛、不被降级」红在第一支（T5 的三方对账不平被说成"去检查 MySQL"）。屏幕侧「`'reconcile'` 停手，`'db'` 不停手」看不见它 —— 假 api 直接给码，不经 session |
| T8-M15 | `wrap` 里 `err instanceof SessionError ? err : …` 那一句去掉（一律重包） | 同一格红在第二支：端口自己定的 `'bad-request'` 被降级成默认码。M14 管**来源规则**，M15 管**直通通道**，两条判据在不同断言上 —— 并成一格就有一型会假绿（Step 3 的格数订正 14→16 记的是同件事） |
| T8-M16 | `open` 开头"已有会话就拒"那一道删掉 | 「7. 会话还开着时二开 ⇒ session，并且现有会话一个资源都没动」红（`ctx.calls` 变长：第二次 `openDb`/`acquire`/`load`，而现有会话的锁被后面那发 `teardown` 放了）。这一发漏掉的不是错误码，是**连接池与锁的泄漏** |
| T8-M17 | `submit` 里 `state.phase === 'paused'` 那道判据删掉 | 「11. 写失败 ⇒ 抢救件原样转交；丢锁 ⇒ 停写，此后 submit 报 session，且号一个都不许回收」红（丢锁后照样取号 9 进队列，而队列里的号会在别人已经占用的 turn 上被 ODKU 吞成 `already-applied`）。**`'stopped'` 那一支的对应变异不红** —— 登记在限度 ② |
| T8-M18 | `new Autosave({ onEmergency: () => {} })`（"抢救件反正 main 会写"） | 「11.…」红（`ctx.rescued.length` 从 1 变 0）。这一发是"session 不数件、不碰 fs，原样转交"那条主张唯一的牙：钩子空了以后，`listEmergency` 在下次 `open` 里读到的是空目录 ⇒ 横幅那句"盘上留着 K 份现场"从此不说谎，因为**真的没有现场** |
| T8-M19 | `close` 里 `req.mode === 'abandon' || autosave === null` 只留前半 | 「13. 只读会话的 graceful ⇒ 与 abandon 同路，绝不替别人宣告这库干净」红（`close:same` 出现 ⇒ 只读会话跑了 `closeProject`，替上一个编辑者写了 `clean_shutdown = 1`）。这是本表里唯一一型"绿着撒谎"的改坏：它对账可能真的平，而那条平账不是它挣来的 |
| T8-M20 | `close` 的顺序改成先 `teardown()` 再 `closeProject(doc)`（"先放锁安全"） | 「14. graceful 平账 ⇒ 顺序是 flush→closeProject→release→end；读数原样、定时器清零」红（`order` 变 `['append:8','release','end','close:same']`）。反过来给另一个人留出"我刚写完、他还没对账"的窗口 —— T6 的 CAS 只保并发写，不保"账对完之前锁在"这件事 |
| T8-M21 | `teardown` 末尾那发 `this.ports.emitStatus(stopped)` 删掉（"会话都拆了还给谁发"） | 「12. abandon ⇒ 不 flush、不对账、只拆；两格读数是 null 而不是 0」与「14. graceful 平账…」两格红（`ctx.statuses.at(-1)?.phase` 停在上一发）。屏幕侧那 11 格看不见：它们的 `STATUS_IDLE` 是假把式喂的。后果是横幅永远停在"saving"那一档，而库里已经不会再有东西进来 |
| T8-M22 | `withTimeout` 摘掉，`drained = await autosave.flush()` 裸奔 | 「16. flush 挂死（库不可达）⇒ 到 CLOSE_FLUSH_TIMEOUT_MS 报 db，窗口不许被卡住」红在**超时**而不是断言（那一格 await 的 promise 永不 settle）。**读日志时别当成抖动**：`Test timed out in 5000ms` 才是它，`expect` 那几行根本走不到 |
| T8-M23 | `ipc-persist.ts` 里 `case IPC.projectClose:` 复制粘贴漏改成 `projectOpen` | 「名册里每一条都在 main 有 case、在 preload 有 invoke（只改一边就红）」红（projectClose 那条没 case）。**五道闸门不红** —— shot 分支一行 IPC 都不发（第 ⑩ 段），这一型只有 T10/T11 的真会话看得见 |
| T8-M24 | preload 的 `onSaveStatus` 只 `ipcRenderer.on(...)`，注销函数回空体 | 「保存状态这条事件两头都在：main 发、preload 订，且给得出注销」红；屏幕侧「保存状态驱动横幅四档；`stop()` 撤掉事件订阅**和**编辑订阅」**不红** —— 它数的是假 api 自己的 `listeners`。这正是 t8d 限度 ② 的具体化：`window.dajia` 是唯一没被任何测试构造过的边界 |
| T8-M25 | `persist/session.ts` 顶部加一行 `import { app } from 'electron';`（或 `node:os` / `mysql2` / `node:fs`） | 「session.ts 既不碰 electron / node:fs / node:os，也不 import mysql2」红而**运行不红**（16 格全走注入端口，那三个 import 一个都不被调用）。同族先例 T7-M21；代价也一样：注释里写出 `from 'electron'` 会误红 |
| T8-M26 | 有人把 `createDbPool` 挪进 `persist/config-store.ts` 并在那儿 `import { safeStorage } from 'electron'`（T9 会真做的事的提早上演） | 「`src/main/**` 里认识 electron 的名单逐字等于 [index.ts, ipc-persist.ts]」红。这一格就是 T9 交接里那句"必须**同时**改这一格并写明它是 spec §8.2 的例外"的牙 —— 名单比字面量，宽松判据（`length <= 3`）会把这件事说成合规 |
| T8-M27 | `projectStore.ts` 里 `import type { SaveStatusWire }` 写成值 import | 「屏幕侧对 @dajia/protocol 只许 type-only import（zod 不许进 renderer 的 bundle）」红，而 `tsc`、`vitest`、`build` 三者全绿（值 import 完全合法，只是把 zod 拖进 renderer chunk）。同一格自带的正控制（`untypedProtocolImports("import { IPC } from '@dajia/protocol';")` 非空）是"这一格不是永远返回空数组"的凭据 |
| T8-M28 | `dispatchBatch` 循环里那发 `set(...)` 挪回循环外（改回"一批一扳"） | editor-store「P-21：`dispatchBatch` 每应用一条扳一次；半途失败只扳已应用的那几发」红 + project-store 格 8「`dispatchBatch` 三条 = 三发账，且每发配它自己那一刻的整份快照」（标题外的注脚是"P-21 的凭据"）红（`f.submits.length` 从 3 变 1）。两档各盯一半：store 侧证扳机次数，屏幕侧证账数。**只剩一档红 ⇒ 有人把订阅改回读 `revision` 了** |
| T8-M29 | `undo` 的只读闸门删掉（"只读会话反正栈是空的"） | 「只读挡住 `undo`/`redo`（账本关了，退了也没地方记）」红（第一支；`redo` 同型）。真正会走到这一支的是 `closeSession` 之后 —— 那一屏的栈**不空**，闸门是唯一不骗人的形状（代价登记在限度 ⑨） |
| T8-M30 | `loadProject` 里 `viewport: null, viewportStoreyId: null` 两格删掉（"留着上一层的视口更顺"） | 「成功那一支：换 log、层跟着换、视口两格同发置 null、其余视图格清零」红。留着会得到一帧"新文档 × 旧口径"的错位图，与 `setStorey` 那条 P10 判据同一个理由 |
| T8-M31 | `loadProject` 的守卫从 `doc.get(storeyId)?.kind !== 'storey'` 换成 `storeyId === ''` | 「拒收那一支：整个 state 一字不动（两个非法入参各判一型）」红在第二型（存在但不是层的 id 过了闸）。`?.kind` 那一句一句判两型，换成显式判空就少一型 |
| T8-M32 | 订阅体里 `if (patch === lastSeen) return;` 那一句删掉（"每发重算一次好了"） | 格 7「视图动作一发都不发」红：`setStorey` 扳 `revision` ⇒ 订阅体跑 ⇒ 上一发的 `lastPatch` 被当新账再发一次（同一 turn 重放同一补丁）。同时「刚建好：phase off、banner null，屏幕上还是样例房且可写（⑧段那一屏）」仍绿（`phase !== 'open'` 在更前面）—— 两道的分工照登 |
| T8-M33 | `submitOne` 里 `doc` 从订阅体给的 `state.log.document` 改成现读 `editor.getState().log.document` | 「`dispatchBatch` 三条 = 三发账，且每发配它自己那一刻的整份快照」红在后两句（三发都带最终态：`f.submits[0].doc` 里第二面墙已是 `'P-2'`）。这一发是"编码在 `await` 之前"那三行注释的唯一凭据 —— 只数条数的话它照样绿 |
| T8-M34 | `closeSession` 里 `setReadOnly(true)` 挪进 `if (!r.ok)` 那一支 | 「`reopenAsEdit()` = 先 abandon 再 open，顺序读得出来」那格的**第二段**红（`graceful` 成功之后 `readOnly` 仍是 false，再 `dispatch` 一发出了 `f2.submits`）。放在判据之外是因为 main 那侧无论回什么会话都已拆 —— 成功那一支同样不许漏，这一格是唯一证人 |
| T8-M35 | `reopenAsEdit` 改成只 `await open(o.projectId)`（跳过 `closeSession('abandon')`） | 「`reopenAsEdit()` = 先 abandon 再 open，顺序读得出来」红：`f.calls` 从 `['open','close:abandon','open']` 变 `['open','open']`，而第二发被 `open` 自己的 phase 闸门挡回 `'off'` + 那句"上一个工程还没收尾" ⇒ 用户按"重新接管"看到的却是"你没关"。锁也没放，重开永远拿不到票 |
| T8-M36 | `computeBanner` 把第 1 条（`failure` 先判）挪到第 8 条之后 | 「回 `{ok:false, code:'not-configured'}` ⇒ red 横幅、phase 回 off、真源**没换手**」红（`phase === 'off'` 先回 null ⇒ 屏幕上压根没有横幅，失败一个字都不说）；「`'reconcile'` 停手，`'db'` 不停手」同型红。顺序就是优先级这一句的凭据 |
| T8-M37 | `App.tsx` 的 `banner === null ? null : <SessionBanner/>` 换成常驻 `<div data-dajia-banner style={{height:0}}/>` | **五档 node 测试全绿**，红的是 `--prop-shot` 的 15b 探针（main 侧 throw，`bannerNodesAtPropGate` 非 0）。这一行是"DOM 侧的零节点没有 unit 证人"的示例：`⑧段` 那句只能由真窗口给 |
| T8-M38 | `open` 里把 `editor.getState().loadProject(...)` 挪到 `put({ phase: 'open', opened: {...} })` **之后** | **本任务用例全绿** —— 两道闸门互为冗余是故意的：换手那一发原来靠 `phase !== 'open'` 挡，改序后靠 `opened === null` 挡，`f.submits.length === 0` 两版都过。写进行里是因为 Step 6 那句注释（"两道闸门都留着是对的"）没有独立证人；把它当"必须红"的判据去找，会误报成测试没写完 |
| T8-M39 | 订阅体里 `lastSeen = patch` 挪到 null/phase 三道判据**之后**（"先判断再记账"） | **全绿** —— 那一挪的差别只在"被挡住的那一发有没有留下记性"，不改变任何外部行为。判据 2 的价值是**可读性**（每发都答得出为什么挡住），不在可判性。登记在限度 ⑩ |
| T8-M40 | `let lastSeen: Patch \| null = editor.getState().log.lastPatch;` 初值改成 `null` | **本任务 11 格全绿**（第一发订阅时 `phase === 'off'` 就先挡了）。这一发要等到**同一进程里有第二份 store** 才可见 ⇒ 真读者是 T11 `--persist-shot` 里那第二份 store（限度 ⑪）。别为它造一格：为"两个 store 同时活"写单测等于重写一遍 `createProjectStore` |
| T8-M41 | `PlanCanvas.tsx` 的 fit effect 依赖表把 `log` 删掉（回到 `[storeyId, setViewport]`） | **全绿**，且 `--prop-shot` 也绿 —— 五道闸门压根不打开工程，`viewport` 一直是样例房那一份。后果（`reopenAsEdit()` 之后画布永久空白）只有 T11 的 `--persist-shot` 会走到那一发（限度 ⑪）。这一行不进"必须红"的账：它是**屏幕侧**的依赖表，本任务的靶子在 node 档 |
| T8-M42 | `open` 成功那一支里的 `useEditor.getState().setReadOnly(v.decision === 'read-only')` 摘掉，或写成死值 `setReadOnly(false)` | 格 5「read-only：闸门 + 横幅 + 双保险」红在**第二道闸门**：`readOnly` 仍是 false ⇒ `dispatch` 不再落 `只读工程：`，真源改了、订阅体看见 `phase === 'open'` 就发账 ⇒ `f.submits.length` 从 0 变 1。与 M34 是一对（M34 管"关"那一支漏抬闸，这一行管"开"那一支漏落闸），两行红在不同格 —— 少了这一行，"开"侧那道闸门就只剩横幅文案一个读者，而文案读的是 `v.decision` 不是 `readOnly`。**补在表尾**是因为 M38–M41 那四行"不红"是一组；这一行是普通可判红，别把它读进那一组 |

**Task 8 登记的限度**（Step 8 汇总；写在这里是给下一个动这一族的人看的，不是待办）：

① **批语义在 S1 不存在**（t8d ①）。`dispatchBatch` 半途失败会在真源上留下已应用的前几发（改前也一样，`S5` 那条命令顺序就是为它排的），本任务只保证这些发各有一发账。"一次删除要么整组进库要么整组不进"是计划 4 真源侧没排的决定。

② **`submit` 的 `'stopped'` 那一支没有格打得到**（t8b ③ 的 `<待实测>`）。`stop()` 之后 `autosave` 字段已被置 `null`，正常路径走不到它；它防的是"将来有人把 `teardown` 拆成两步"。T8-M17 只证 `paused` 那一支。

③ **T8 不建库**（t8c Step 3）。`dajia` 库不存在时 `openDb` 抛 `ER_BAD_DB_ERROR` ⇒ `'db'`，文案带原话。建库是 T9 连接向导的职责，那也是本计划唯一行使建库授权的地方 —— Step 8 第 7 项那条库收据就是这一条的常驻证人。

④ **`ipc-persist.ts` 没有 unit 格**（t8c Step 4）。它的凭据是三条：编译期、`ipc-channels.test.ts` 的三格源码扫、真环境（五道闸门 + T10 双进程 + T11）。本文件里的 ports 实现（`openDb` / `acquire` / `emitStatus` / `writeEmergency`）在纯 node 档**一次都不被调用**，接线写错只有 T11 看得见。

⑤ **`window.dajia` 是唯一没被任何测试构造过的边界**（t8d ②）。屏幕侧那 20 格测的是"store 与假 api 之间"那一层；真 preload 由 contextBridge 给那个对象，凭据只来自 `--prop-shot` 跑的真窗口。T8-M24 那一行是这个分工的图示，不是它的补丁。

⑥ **`NOT_INJECTED` 那一支的触发没有覆盖**（t8d ③）。node 档永远没有 `window`，格 1 判的是 `readDajia()` 回 null，不是"Electron 里 preload 真的没注入"。那种情况下 spec §9 要的分型诊断会说什么，靠 格 2 的初始态与 格 3 的形状间接保证。

⑦ **源码扫描这一族的共同代价**（t8c Step 4/5）：注释里写出被禁的那串就误红（`from 'electron'`、`createDbPool`、`password`）；多行写法 `import type {\n A,\n} from '@dajia/protocol'` 也误红。换来的是扫描器不需要 AST 依赖。改判据之前先想清楚这两型误红。

⑧ **`'password'` 今天被 `ipc-channels.test.ts` 第 3 格整条禁在 preload 文本里**。T9 的配置通道必须**单独**把它摘出来并写明"只许在请求方向出现"，这条与 T8-M26 那道名单一起改 —— 两处都在 T9 的交接里，漏一处就是要么写不进去、要么把口令打进日志。

⑨ **`close` 之后屏幕失去"退回去看看刚才改了什么"**（t8d ④），且没有一句话解释为什么退不动，只有 `lastError`。账本关了还能退比这个不便更危险，S1 接受。

⑩ **订阅体里"先记账再判断"那一句没有可判的红**（T8-M39）。它改的是失败可读性，不是行为。别把它当测试缺口补一格 —— 真要判它，得让 `phase` 与 `opened` 在不同发上分两次变，那个形状在生产里不存在。

⑪ **换手那一发的两条依赖只在真窗口里可判**（T8-M40、T8-M41）：`lastSeen` 的初值要第二份 store，`log` 进依赖表要 `reopenAsEdit()` 真的重开一个工程。两者都归 T11 的 `--persist-shot`（它构造那第二份 store，也真按"重新接管"）。T10 的 `--lock-shot` 只证两进程抢锁，别把这两个数当已经证过。

⑫ **`CLOSE_FLUSH_TIMEOUT_MS = 10_000` 这个数值本身没证**。T8-M22 与格 16 吃的是常量，改数值格子跟着走 —— 假钟一拨就到。真库里 flush 要多久、10 秒够不够，只有 T11 的真进程给得出读数。

⑬ **跨实体的引用/几何不变式在 `submit` 那一发不查**（t8a ⑩）。过界那一发只走 `documentFromPayload` 的逐实体 validate 与 T4 的归属守卫；整层派生复核的读者仍是 T5 的读盘与 T3 的那一档。T8 不重跑 `assertTruthSourceInvariants`（每发 O(实体数) 的第三次验同一份数据）。

⑭ **真并发不在这里证**（沿用 T7 限度 1）。本任务的 16 + 20 格全是单进程、单会话、单池。两台机器同时开一个库那一型在 T10 的 `--lock-shot`，进程被 SIGKILL 那一型在 T11。
