# 搭家 Dajia

一个自研的 **Electron 桌面端房屋建模软件**,对标酷家乐,但走了一条相反的路。

> **酷家乐是在已存在的户型上做装修;搭家是从地基、楼层、承重墙、屋面开始把房子搭出来,再谈装修。**

这句差异不是口号,它决定了仓库里每一个取舍:第一类实体是**墙 / 柱 / 板 / 洞口**(带标高、层高、承重属性),而不是"客厅 / 卧室"这种空间。

当前进度:**S1 阶段 M1.0 – M1.5 已完成**,M1.3(持久化)接线落地、M1.6(`scene-3d`)未动。

---

## 快速开始

```bash
pnpm install
pnpm verify        # typecheck + lint:deps + test,不连库
pnpm dev           # 启动 Electron 开发窗口
```

### 环境要求

| 项 | 版本 | 说明 |
|---|---|---|
| Node | **>= 24** | `engines` 字段声明;低于 24 会有 `Unsupported engine` 警告 |
| pnpm | 11.x | 仓库用 pnpm workspace |
| MySQL | 8.x,监听 `127.0.0.1:3306` | **仅持久化测试需要**,应用运行期也直连它 |

> ⚠️ 若在 WorkBuddy 内置运行时里跑,默认 node 是 22。切到系统 node 24:
> ```bash
> export PATH="/c/Program Files/nodejs:$PATH"
> pnpm verify
> ```

---

## 架构

```
                    ┌─────────────────────┐
                    │   @dajia/desktop    │  Electron 壳(main / preload / React renderer)
                    └──────────┬──────────┘
             ┌─────────────────┼─────────────────┐
             ▼                 ▼                 ▼
      ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
      │ scene-2d    │   │ scene-3d    │   │  drawing    │   三个消费方
      │ Canvas 视口 │   │ Three.js 投影│   │  图纸 IR→PDF│   互相禁止 import
      └──────┬──────┘   └──────┬──────┘   └──────┬──────┘
             └─────────────────┼─────────────────┘
                               ▼
                    ┌─────────────────────┐
                    │    @dajia/core      │  几何内核 · 整数毫米真源 · 零运行时依赖
                    └─────────────────────┘
                    ┌─────────────────────┐
                    │   @dajia/protocol   │  IPC 契约 + zod schema
                    └─────────────────────┘
                               ▼
                    ┌─────────────────────┐
                    │  本机 MySQL 8.x     │  dajia / dajia_test
                    └─────────────────────┘
```

### 包职责

| 包 | 职责 | 状态 |
|---|---|---|
| `@dajia/core` | 几何内核:毫米坐标、构件实体、拓扑、command 层。**零运行时依赖** | ✅ 3032 行 |
| `@dajia/scene-2d` | 2D 视口:Canvas 场景图、命中、吸附、手柄 | ✅ 2552 行 |
| `@dajia/protocol` | IPC 契约 + zod schema,main 与 renderer 共用 | ✅ 556 行 |
| `@dajia/drawing` | 图纸引擎:图面 IR → SVG / PDF(M1.4) | ✅ 1133 行 |
| `@dajia/pdf` | 自研 PDF 内容流后端 + 中文字体嵌入(M1.5) | ✅ 581 行 |
| `@dajia/scene-3d` | 3D 投影:从 core 单向派生 | ⬜ 占位(M1.6/M1.7) |
| `@dajia/desktop` | Electron 壳 + 持久化(主进程) | ✅ 8423 行(src) |

`scene-3d` 目前只有一行占位。**这是刻意的** —— spec §3.1 明确把它划到 M1.6 / M1.7。
`drawing` 与 `pdf` 已落地,「导出平面图 PDF」这条路从几何到落盘全通
(计划 5 闭环),且已串进真实 Electron IPC(见「导出平面图」那一节)。

---

## 不可破的约束

这几条是项目的地基,改代码前先读一遍。

### 1. 依赖方向由 CI 强制

```
core ← { scene-2d, scene-3d, drawing }
```

三个消费方**互相禁止 import**。执行机制是 `scripts/check-package-deps.mjs`(跑 `pnpm lint:deps`),**不是 eslint 规则**——因为约束本身必须可测。未知包目录一律抛错,避免"新增包忘了登记 → 扫不到 → 静默通过"。

违反则双向编辑必然返工。

### 2. 整数毫米真源

任何写回真源的坐标必过 `quantize()` 到**整数毫米**。浮点只允许存在于视口投影与临时构造计算中。这是可施工图纸的唯一前提。

### 3. 墙的真源是轴线,不是轮廓

一面墙存的是**首尾两个轴网点 id + 厚度 + 高度 + 标高偏移 + 承重 + 材料**。矩形轮廓、以及两墙相交的 L / T / 十字接头,**全部从轴线派生**。

所以"拖动一个拐角,两面墙同时跟随且不脱开"是天然成立的,不需要额外的同步代码。

### 4. 3D 是 2D 的纯派生投影

几何模型是唯一真源,一切编辑必经 command 层。3D 侧唯一允许的写操作是**把整层拖拽解释为 `storey.setElevation` 命令**——明确禁止顶点级与构件级编辑(那属 S3)。

### 5. renderer 永不接触数据库

```
renderer → preload 窄接口 → main 进程 mysql2 连接池 → repository
```

IPC 消息两侧均由 `@dajia/protocol` 的 zod schema 校验。

### 6. 存盘失败绝不清空内存真源

MySQL 不可达、断网、盘满时,屏幕上的模型必须仍在。表现为顶部红条 + 持续重试 + 向 `userData` 写 emergency JSON 快照。

---

## 命令

| 命令 | 作用 | 范围 |
|---|---|---|
| `pnpm verify` | typecheck + lint:deps + test | **不连库**,CI 跑这个 |
| `pnpm test:db` | 真 MySQL 集成测试 | **需环境变量**,故意不进 verify |
| `pnpm typecheck` | 6 次 tsc --noEmit:core / protocol / scene-2d 三包 + desktop 三个 tsconfig |
| `pnpm build` | 构建 desktop | |
| `pnpm dev` | Electron 开发窗口 | |
| `pnpm shot` / `pick-shot` / `edit-shot` / `draw-shot` / `prop-shot` | 真窗口像素回读闸门 | |

### 为什么库测试不进 verify

CI 的 ubuntu runner 没有 MySQL,也没有口令。所以:

- `vitest.config.ts` → 收 `packages/*/test/**` + `scripts/test/**` + `apps/desktop/test/unit/**`,进 `pnpm verify`
- `vitest.db.config.ts` → 只收 `apps/desktop/test/db/**`,`fileParallelism: false`(多文件共享 `dajia_test` 会互踩),`testTimeout: 60s`

**缺环境变量时 `pnpm test:db` 必须以点名缺哪个变量的方式响亮失败(exit ≠ 0),不许 skip。** 静默跳过的集成测试等于没有测试。

---

## 测试现状

`pnpm verify` 当前:**70 文件 / 852 条全绿**(Node 24.14.1 实测,2026-10-07)。

| 层 | 文件 | 手段 |
|---|---|---|
| core | 26 | vitest + fast-check 属性测试 |
| scene-2d | 7 | 逻辑单测(视口变换、吸附优先级) |
| drawing | 6 | 图面 IR 快照 + 剖切轮廓(D1/D2/D3) |
| protocol | 6 | zod shape 与 core 接口对账(T9 起多一份连接配置/列表/试连的契约档) |
| pdf | 1 | PDF 字节往返 + 100mm 校准页 |
| desktop unit | 22 | 不连库的部分(T9 起多一份库侧分型诊断档) |
| scripts | 2 | 闸门基线 + 依赖守卫 |
| **合计** | **68** | |
| desktop db | 6 | 真 MySQL,**不计入上表** |

`pnpm test:db` 最近一次实跑(2026-10-07,MySQL 8.0.45):**6 文件 / 110 条全绿,零skip**。
跑完 `dajia` 与 `dajia_test` **无残留**,15 个用户库逐名等于基线。

核心不变式用属性测试锁住:

- 接头在任何随机墙网下闭合
- 洞口永不超出宿主墙长
- `quantize`幂等
- `apply → inverse` 回到**逐字节相同**的状态
- 导出:同 doc + 同 opts 连跑两次**字节逐字相同**(E2),实体排序不随插入序漂(E4)

---

## 数据库

```
dajia
  project        一行一工程:schema_version、名称、单位、lock_token、lock_expires_at
  storey楼层:project_id、标高、层高、序号
  element        构件:id(UUIDv7)、project_id、storey_id、kind、payload JSON
                 + MySQL 8 生成列抽出 kind / loadBearing / 长度,并建索引
  command_log    增量命令:project_id、seq、actor、payload JSON、created_at
  snapshot       压缩快照:project_id、seq、payload JSON
  asset          描图底图、字体、纹理
```

- **混合模型**(实体行 + JSON payload + 命令日志),不是整文档单一大 JSON
- `element` / `storey` 表是**投影,不是加载源**——为 S5 的 SQL 聚合保留
- 读路径 = 最近 snapshot + 重放其后的 `command_log`
- 时间一律交给服务端(`NOW(3)`),客户端**只报 TTL、绝不报自己的时钟**

### 库名护栏

本机 MySQL 里还有用户的其他库。`assertDatabaseName()` 只放行 `dajia` / `dajia_test`,其余一律抛,**且在建连接之前抛**。每个连库的测试文件自己把库名钉成字面量 `dajia_test`,并在用例第一条断言 `SELECT DATABASE()` 等于它。

理由不是洁癖:照抄 `env.database` 时,配错一个环境变量就会把迁移打进用户真工程库,且**一句错都不报**。

---

## 已知取舍与代价

设计文档(`docs/superpowers/specs/2026-09-25-dajia-s1-design.md` §2)逐条记录了代价,这里摘要最需要注意的三条:

| 决定 | 代价 |
|---|---|
| 直连本机 MySQL(用户否决了 SQLite + 云端的推荐方案) | **每台目标机需自行安装配置 MySQL**;"给不懂技术的人用"实际依赖上门安装。设计方对此持保留意见,已记录 |
| 自研 PDF 内容流后端(不用 `printToPDF`,不栅格化) | 工期 +1~2 周,需嵌中文字体 |
| 手写 Canvas 2D 视口(不用 Konva/SVG) | 视口变换、命中测试、吸附需手写,约两千行 |

### S1 明确不做

3D 内拉墙开门窗、弧形墙、楼梯与坡屋面、家具材质与效果图、水电点位、工程量清单、云同步与多人、DWG 双向。各自去向见 spec §3.1。

### 需要人工验证、设计文档不打勾的项

- A3 实体打印后拿尺量图框与标注(校准页已能产出,但没量过)
- 干净虚拟机上的安装体验
- Windows Defender / 防火墙弹窗
- 真实断电或强杀进程后的恢复
- **抗锯齿边缘的像素判据在正常 GPU 机器上复跑一次**(见上面软件光栅那条)

---

## 开发约定

- **单功能单 commit**,提交前跑 `pnpm typecheck` + `build` 验证
- 提交信息带 scope:`feat(core):` / `fix(scene-2d):` / `test(plan4):` / `docs(plan4):`
- `.workbuddy/` 不入库
- **push 由用户本人执行**;破坏性 git 操作(`reset --hard`、force-push、改已提交、`--no-verify`、`branch -D`)需明确指示
- 不许`git checkout` / `switch` / `restore` / `stash` / `reset` / `clean`(单checkout 仓库,切分支会悄悄挪走在跑的工作)
- 跑闸门一律重定向取 exit:`pnpm verify > tmp/x.log 2>&1; echo exit=$?`,**绝不 `| tail`**(管道吃 CJK 行)
- 一次性脚本与日志写进 `.superpowers/sdd/<日期-计划名>/`(该目录被自身 `.gitignore` 的 `*` 忽略);`tmp/` 只放 `*.log`

### 跑库测试需要的环境变量

```bash
export DAJIA_MYSQL_HOST=127.0.0.1
export DAJIA_MYSQL_PORT=3306
export DAJIA_MYSQL_USER=root
export DAJIA_MYSQL_PASSWORD=<本机口令,不要写进仓库>
export DAJIA_MYSQL_DATABASE=dajia_test   # 连库测试只碰这一个库
pnpm test:db > tmp/testdb.log 2>&1; echo "exit=$?"
```

口令只作为环境变量传入。`dajia` 与 `dajia_test` 由测试自建自清。

### 三个容易踩的坑

**`drawing` 与 `scene-3d` 不在 `pnpm typecheck` 里。** `pnpm typecheck` 显式列了 core / protocol / scene-2d 与 desktop 三处,这两个占位包没被串进去(它们也没有 test 目录)。**往这两个包写第一批代码时,记得同步把它们加进根 `package.json` 的 `typecheck` 串**,否则类型错误要等 build 才暴露。`lint:deps` 倒是已经覆盖它们——`ALLOWED_DEPS` 里有条目,一旦违反依赖方向仍会被拦下。

**别用 `byKind(...).at(-1)` 当"刚创建的那个"。** `uuidv7` 同毫秒不单调。取新建实体只认 `log.affected` + `kind` 判别式。

**每条新判据提交前先证明它能红。** 改坏一个界看它叫——这一条在"对账型"测试上尤其当真(`element` 表与文档对账、`storey` 表与 `element` 对账、zod shape 与 core 接口对账,三条都必须有"只改一边"的变异样本能打到红)。

**测试要 import `.tsx` 就得给 `tsconfig.test.json` 加 `"jsx": "react-jsx"`。** 它不随 `tsconfig.json` 继承(那份显式写了 jsx、这份只 extends base),缺了就报 `TS6142: … but '--jsx' is not set`。屏幕侧组件**刻意不进**那个文件的 `include` —— 它由自己的读者传递带进来。

**源码级判据必须剥掉注释再扫。** 本仓注释里到处写着被禁的词名(`SaveStatusBar.tsx` 文件头就写着"不许 import `computeBanner`"),连注释一起扫那一格永远红 —— 而若为让判据绿而删掉那句注释,等于**为迁就判据删掉纪律原文**。见 `save-bar.test.ts` 的 `codeOf()`。

**判据里"取基线"必须在被测动作之前。** 写成 `expect(x).toBe(baseline() + n)` 而 `baseline()` 读的是当前值,它就是"和刚才那发比"而不是"和调用前比" —— 恒红。同族:撤销栈的深浅取决于同文件前面几格打过几发,判据不能靠"打三次就假定空了"。

---

## 路线图

| 编号 | 子项目 | 依赖 |
|---|---|---|
| **S1** | **结构建模 + 平面图 + 持久化(进行中)** | — |
| S2 | 立面、剖面、门窗表、多图纸成册(复用 S1 的 IR 与标注引擎) | S1 |
| S3 | 3D 内直接编辑、弧形墙、楼梯与坡屋面、家具与材质 | S1, S2 |
| S4 | 水电点位、开关插座布置图 | S1, S2 |
| S5 | 工程量清单与装修预算 | S1, S4 |
| S6 | 模型库、云同步、多人协同(以 `command_log` 为同步载荷) | S1 |

S1 内部里程碑:

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1.0 | pnpm workspace、electron-vite、TS strict、依赖 lint、CI | ✅ |
| M1.1 | `@dajia/core`:实体模型、command 层与撤销、几何派生、属性测试 | ✅ |
| M1.2 | `@dajia/scene-2d`:三层 canvas、拉墙/拖点/删除、吸附、属性面板 | ✅ |
| M1.3 | 持久化:迁移、repository、工程锁、自动保存与崩溃恢复 | ✅ T1–T8 落码并接线(三条通道 +存盘状态事件 + 横幅上屏),剩 T9(连接配置向导与首屏)/ T10(双进程闸门)/ T11(关窗握手) |
| M1.4 | `@dajia/drawing`:图面 IR、图框、线型表、三道尺寸线、A3 排版 | ✅ |
| M1.5 | 自研 PDF 后端 + 中文字体嵌入 + 比例尺自检 | ✅ 代码侧完成;**打印实测未做**(见「需要人工验证」) |
| M1.6 | `@dajia/scene-3d` M1 形态:只读拉伸体 + 选中双向同步 | ⬜ `scene-3d` 仍 1 行占位 |
| M1.7 | 3D 视口内拖动整层(解释为 `storey.setElevation`) | ⬜ |
| M1.8 | 描图底图 + 两点定标(可裁剪) | ⬜ |

### 导出平面图(T7/T8 → 真实 IPC)

面板右上「导出平面图」→ preload → main 弹保存框 → `@dajia/pdf` 落盘 PDF。
给了剖切线就多导一页剖切轮廓(两页 PDF)。日期与设计人是**入参**—— 契约层不给
运行时时钟开口子,这样「同 doc + 同 opts 连跑两次字节逐字相同」才成立。

**存盘状态横幅**已在屏幕侧:`projectStore.computeBanner` 的八级优先级(failed /
锁丢了 / 只读 / 恢复提示 / 兜底灰话)是文案的唯一产地,组件只做选色与接线。
它是**浮层**(`position: absolute`,挂在画布格内)—— 因为画布原点被五道真窗口闸门
逐字钉在 `y === 32`,横幅一旦占位就会让五道闸门全红。

### 真窗口闸门:五道全部跑通(2026-10-07)

`pnpm shot` / `pick-shot` / `edit-shot` / `draw-shot` / `prop-shot` **首次全部 exit=0**。

`shot` 报告的关键读数:`canvasOriginPx = (0, 32)` —— 存盘横幅用浮层
(`position: absolute`,挂在画布格内)所以没有破坏布局;`saveBar: {text: null}`
印证「没打开工程时不渲染横幅」。

这一晚踩穿了**四层「build 通过但真进程起不来」**,全部实测、全部记在
`electron.vite.config.ts` 与 `scripts/desktop-shot.mjs` 的注释里:

| 层 | 症状 | 根因 |
|---|---|---|
| 1 | `SyntaxError: does not provide an export named 'BrowserWindow'` | `type: module` 下产物是 ESM,Electron 按 CJS 解释 |
| 2 | 同一句错(改了 ESM + `.mjs` 之后) | Electron 加载 `.mjs` 的桥接**不支持具名 ESM import**(文档把 ESM 标为实验档) |
| 3 | 入口失配 | `format: 'cjs'` 单独写会落 `.cjs`,而 `main` 字段还指 `.js` |
| 4 | `Electron failed to install correctly` | `electron` 在 `devDependencies` ⇒ 没被 external ⇒ 它的 `index.js` 被内联 |

⇒ 定在 **CJS + `.cjs` + 同步 `main` 字段 + `electron` external**,四处一致。

另有两个**环境层**(不是代码问题,但同样让五道闸门全红):

- **`ELECTRON_RUN_AS_NODE=1`**:来自**跑命令的那个 shell**,不在仓库配置里、profile 也没有。
  决定性证据 —— `electron.exe --version` 打印 `v24.21.0`(Node 的版本)而不是 `v44.4.5`。
  那个模式下 `require('electron')` 拿到的是 npm 包装包 ⇒ `app` 是 `undefined`。
  现在 `desktop-shot.mjs` 在 spawn 的 `env` 里**显式删掉它**,不要求每个调用方记得 unset。
- **GPU**:容器环境里 GPU 子进程反复 ACCESS_VIOLATION ⇒ `GPU process isn't usable`。
  **单给 `--disable-gpu` 不够,缺的是 `--no-sandbox`**。

> ⚠️ **软件光栅的代价**:上面关了 GPU,而 `--shot` 那一族是 Canvas 2D 像素回读、
> 本来不经 GPU,所以闸门要验的东西不受影响。**但抗锯齿边缘的亚像素精度与 GPU 路径
> 略有差异** —— 涉及抗锯齿边缘的像素判据,仍应在一台正常 GPU 的机器上复跑一次。

### S1 验收标准

1. 建一栋两层、外墙 240mm、含 4 门洞 4 窗洞的房子,导出 A3 1:100 平面图 PDF,三道尺寸线齐全,打印实测误差 ≤ 0.5mm
2. 连续撤销 30 步不崩溃、状态正确
3. 强杀进程后重开,未落盘命令被恢复,无静默丢失
4. 两个实例同开一工程,第二个为只读并有可见提示
5. `pnpm typecheck`、`pnpm test`、`pnpm build` 全绿
6. 一台未装 MySQL 的机器上安装本应用,能得到"下一步该做什么"的可读指引

---

## 深入阅读

| 文档 | 内容 |
|---|---|
| `docs/superpowers/specs/2026-09-25-dajia-s1-design.md` | **S1 完整结构设计** —— 背景、8 条决策记录、范围、架构、几何内核、图纸引擎、持久化、错误处理、测试策略、验收标准 |
| `docs/superpowers/plans/2026-09-25-dajia-plan1-core-foundation.md` | 计划 1:内核地基(M1.0–M1.1) |
| `docs/superpowers/plans/2026-09-25-dajia-plan2-geometry-invariants.md` | 计划 2:几何与不变式 |
| `docs/superpowers/plans/2026-09-27-dajia-plan3-scene-2d-editor.md` | 计划 3:2D 视图与编辑器(M1.2) |
| `docs/superpowers/plans/2026-10-01-dajia-plan4-persistence.md` | 计划 4:持久化(M1.3)—— **进行中** |

这些计划文档密度极高(含逐条判据、变异样本清单、执行回填账),**动 `core` / `scene-2d` / 持久化代码前请先查对应计划里是否已有裁决**。文档里反复出现的"P-nn"编号是裁决编号,被引用时不要改口径。

代码仓库:`https://github.com/Jamens/Slogan`
