# 搭家（Dajia）· S1 结构设计

- 日期：2026-09-25
- 状态：待用户审阅（设计八段已逐段口头确认）
- 产品名：**搭家 / Dajia**（npm scope `dajia`，注册时确认空闲；`zhujia` 已被占用故排除）
- 代码仓库：`https://github.com/Jamens/Slogan`（审阅时为空仓库，零 commit）
- 本文档覆盖子项目 **S1**；S2–S6 见第 14 节

---

## 1. 背景与定位

需求来源：做一个 React + TypeScript + pnpm 的桌面客户端，参考酷家乐，用户可"自己搭建房子装修"，并能导出图纸。

与酷家乐的关键差异，是本文档所有决定的出发点：**酷家乐是在已存在的户型上做装修；搭家是从地基、楼层、承重墙、屋面开始把房子搭出来，再谈装修。**

明确的自我限制（不回避）：酷家乐是数百人团队 + 云端渲染农场 + 百万级三维模型库。搭家不在照片级渲染和模型库上竞争。只对标它落地页上两个具体能力：户型/平面绘制，与施工图导出。

## 2. 决策记录

| # | 决定 | 内容 | 理由 | 已告知并被接受的代价 |
|---|---|---|---|---|
| D1 | 领域模型 | 先搭房子再装修，楼层与结构构件为一等公民 | 差异化所在，且不依赖渲染农场 | 工作量大于纯装修工具 |
| D2 | 编辑模型 | 2D/3D 双视图双向编辑 | 非技术用户靠 3D 建立直觉，靠 2D 保证精度 | 用户在被明确标注"工期翻倍"后仍选定；靠 D2 硬约束消化 |
| D2b | **硬约束** | 几何模型是唯一真源，3D 场景是纯派生投影，一切编辑必经 command 层写回 | 违反则双向编辑必然返工 | 由 lint 规则强制，见第 4.2 节 |
| D3 | 图纸等级 | 可施工级结构施工图 | 与 D1 一致；"导出图纸"是用户自定的验收线 | S2 从"导出功能"升级为"绘图引擎"，约五倍工作量 |
| D4 | PDF 生成 | **自研 PDF 内容流后端**，不用 `printToPDF`，不用栅格化 | 施工图靠线宽与字高表达语义，不能让给浏览器排版 | S2/S1-M1.5 工期 +1～2 周；需嵌中文字体 |
| D5 | 数据层 | Electron 主进程直连本机 MySQL 8.x，保留用户最初方案 | 用户否决了"本地 SQLite + MySQL 上移云端"的推荐方案 | **每台目标机需自行安装配置 MySQL；"给不懂技术的人用"实际依赖上门安装或远程协助。** 设计方对此持保留意见，已记录 |
| D6 | 二维渲染 | 自绘 Canvas 2D 视口，不用 Konva/SVG | 精确控制线型线宽；上千实体加连续缩放不掉帧 | 视口变换、命中测试、吸附需手写，约两千行 |
| D7 | 三维库 | Three.js + react-three-fiber | 体块级显示而非游戏，包体与生态优先 | — |
| D8 | 单位系统 | 真源坐标为整数毫米；浮点只存在于视口投影与临时构造计算 | 可施工图纸的唯一前提 | — |

## 3. S1 范围

**一句话交付物：从空工程到导出一页可施工级的 A3 平面图 PDF。**

对齐 D3 的口径，免得日后被当成缩水：**S1 交付的是"可施工级平面图"这一种图纸；一套完整施工图集（立面、剖面、门窗表、多图纸成册）在同一大版本的后半段交付**，二者共用 S1 建立的 IR 与标注引擎，不需要重写。

| 里程碑 | 内容 | 退出条件 |
|---|---|---|
| M1.0 | pnpm workspace、electron-vite、TS 5 strict、包依赖方向 lint 规则、CI（typecheck / test / build） | CI 全绿 |
| M1.1 | `@dajia/core`：实体模型、command 层与撤销、`quantize`、AABB 索引、轴线→轮廓与接头派生、属性测试 | 不变式测试通过 |
| M1.2 | `@dajia/scene-2d`：三层 canvas 视口、拉墙/拖点/删除、吸附、数值输入、楼层管理、构件属性面板（厚度 / 承重 / 材料） | 可交互完成一栋两层房子并改外墙厚到 240mm |
| M1.3 | 持久化：迁移、repository、首启连接向导、工程锁与心跳、自动保存与崩溃恢复 | kill 进程重开无静默丢失 |
| M1.4 | `@dajia/drawing`：图面 IR、图框、线型表、三道尺寸线、指北针与标高、A3 单页排版 | IR 快照测试通过 |
| M1.5 | 自研 PDF 内容流后端 + 中文字体嵌入 + 比例尺自检 | 打印实测误差 ≤ 0.5mm |
| M1.6 | `@dajia/scene-3d` 的 M1 形态：只读拉伸体 + 选中状态双向同步 | 3D 无构件级写入；选中在 2D/3D 间双向一致 |
| M1.7 | 3D 视口内拖动整层：拖拽**必须**解释为 `storey.setElevation` 命令写回，禁止顶点级编辑 | 3D 拖动后 2D 与图纸结果一致 |
| M1.8 | （可裁剪，默认含最简版）描图底图 + 两点定标 | 底图可缩放到真实尺寸 |

### 3.1 S1 明确不做

| 不做 | 去向 | 原因 |
|---|---|---|
| 在 3D 里拉墙、开门窗 | S3 | 需独立约束求解系统；与 M1.6/M1.7 架构不冲突，事后加不改前两层 |
| 立面、剖面、门窗表 | 同一大版本后半段 | 与平面共用 IR 与标注引擎，平面打通即验证全链路 |
| 弧形墙、复杂拓扑接缝 | S3 | S1 支持直墙 + L / T / 十字接头，已覆盖自建房绝大多数轮廓 |
| 楼梯、坡屋面几何 | S3 | S1 屋面只支持平板 |
| 家具、材质、效果图渲染 | S3 | 与"可施工图纸"正交 |
| 水电点位、开关插座布置 | S4 | 依赖 S1 点位模型 |
| 工程量清单与预算 | S5 | 纯下游计算 |
| 云同步、多人、账号体系 | S6 | `command_log` 已是其传输格式，届时不重做 |
| DWG 双向 | 未排期 | 需引入 libredwg / ODA，另一条成本线，用户未选择 |
| 冲突合并 | 不做 | 单机场景，靠工程锁消除并发 |
| 多语言 | 不做 | 仅中文 |

## 4. 架构

### 4.1 包结构

```
packages/core       @dajia/core       几何内核：毫米坐标、构件实体、拓扑、command 层。零运行时依赖
packages/drawing    @dajia/drawing    图纸引擎：图面 IR → SVG / PDF。只依赖 core
packages/scene-2d   @dajia/scene-2d   2D 视口：Canvas 2D 场景图、命中、吸附、手柄
packages/scene-3d   @dajia/scene-3d   3D 投影：Three.js + react-three-fiber，从 core 单向派生
packages/protocol   @dajia/protocol   IPC 契约 + zod schema，main 与 renderer 共用
apps/desktop        @dajia/desktop    Electron 壳：main / preload / React renderer
```

拆包的两个理由，缺一不可：`core` 与 `drawing` 必须能在纯 Node 下测试（施工图错误靠肉眼验不出来）；图纸引擎将来可被 CLI 或云端复用。

技术栈：Electron + `electron-vite` + React 19 + TypeScript 5 strict；打包 `electron-builder` 出 NSIS 安装器；自动更新走 GitHub Releases；renderer 状态用 zustand。

### 4.2 依赖方向（强制）

`core` ← `{ scene-2d, scene-3d, drawing }`；三个消费方**互相禁止 import**。由 eslint 规则约束。这是 D2b 单一真源的执行机制，不依赖人工自觉。

### 4.3 进程模型

renderer 永不接触数据库。所有持久化路径为：renderer → preload 暴露的窄接口 → main 进程 `mysql2` 连接池 → repository。IPC 消息在两侧均由 `@dajia/protocol` 的 zod schema 校验。

## 5. 几何内核

### 5.1 实体层级

`Project → Storey(楼层) → Element`。Element 为联合类型：墙、柱、梁、楼板、屋面、门窗洞口、点位、房间。ID 用 UUIDv7（时间有序，撤销与未来同步均需稳定引用）。

`Storey` 持有标高、层高、序号。一栋房子 = 地基 + N 层 + 屋面，每层有独立的墙、洞口与楼板。

### 5.2 轴线为真源

墙的真源是**轴线**，不是轮廓多边形。一面墙存：首尾两个轴网点 id、厚度、高度、标高偏移、`loadBearing`、材料。

矩形轮廓、以及两墙相交的 L / T / 十字接头，全部从轴线派生（端点按夹角自动切 45° 或平接）。因此"拖动一个拐角，两面墙同时跟随且不脱开"是天然成立的。

### 5.3 拓扑

端点是可被多构件共享的一等实体。两根墙吸到同一 `pointId` 即形成拓扑闭合。房间边界、面积、工程量均由此拓扑推出，**不存第二份**。

### 5.4 洞口

门、窗挂在宿主墙上，以「沿墙距离 + 宽 + 高 + 窗台高」定位。移动或拉伸墙时洞口自动跟随。这是"先搭房子再持续改装修"的前提。

### 5.5 command 层与视图状态

所有变更为 `{ type, payload, inverse }`，撤销栈即命令流，自动保存为"快照 + 增量命令"。

命令分两档，避免"实现了却没界面"变成隐疾：

- **S1 有编辑器 UI 的**：`wall.create`、`wall.moveEndpoint`、`wall.setThickness`、`wall.delete`、`opening.create`、`opening.move`、`opening.delete`、`storey.create`、`storey.setElevation`。
- **数据模型与命令层已实现、S1 不提供 UI 的**：`column.create`、`slab.create`。放进 S1 是因为 D1 要求结构语义一开始就在真源里，删掉会让 S3 改内核；UI 分别随 S3（楼梯、柱网）与 S2（楼板关联剖面）开放。验收标准只覆盖上一档。

每条 command 必须实现 `inverse`，且属性测试要求 `apply → inverse` 回到逐字节相同的状态。

**唯一例外**：选中状态（selection）不进真源、不进撤销栈、不落库，存放于 `apps/desktop/src/renderer/stores/selection.ts`（zustand），2D 与 3D 各自订阅。视图状态不属于文档内容。

### 5.6 精度防线

任何写回真源的坐标必过 `quantize()` 到整数毫米；开发模式记录浮点来源，使"差了 0.4mm"可追溯。

## 6. 渲染与双向同步

`packages/scene-2d/src/viewport.ts`：视口变换为「整数毫米 → 屏幕像素」的仿射，缩放系数为浮点，真源不动。

`packages/core/src/spatial/index.ts`：派生 AABB 索引，command 后只重建受影响节点局部，支撑命中与拾取。

`packages/scene-2d/src/snapping.ts`：端点 / 中点 / 垂足 / 轴网交点 / 15° 角度 / 正交，按优先级排序。阈值以屏幕像素给定、换算为毫米比较，保证放大时吸附不变松。

三层 canvas 叠加：底层网格与轴网、中层构件、顶层交互（橡皮筋、手柄、实时尺寸）。连续拖动只重绘顶层。

3D 侧 `packages/scene-3d/src/extrude.ts`：墙轴线 + 厚 + 高 → 棱柱；按 command 的 `affectedIds` 增量重建 mesh，不做全场景重建。M1.6 阶段 3D 视口完全只读；M1.7 起，3D 的唯一写路径是把整层拖拽解释为 `storey.setElevation` 命令，**禁止顶点级与构件级编辑**（后者属 S3）。

## 7. 图纸引擎

**图面 IR + 多后端**：`drawing` 先产出与格式无关的图面 IR（直线、折线、多边形、文字、填充，带线型、线宽、图层、纸面坐标），后端再将其转为 SVG（预览）或 PDF（交付）。屏幕与交付物共用同一份几何。

**比例与字高按纸面定义**：模型毫米 × 比例（1:50 / 1:100）→ 纸面毫米。文字固定 2.5 / 3.5mm 纸面高；线宽取 0.18 / 0.25 / 0.35 / 0.5 / 0.7。图纸不用 HTML/CSS 排版，因为 CSS 无"纸面毫米"概念。

- `linetypes.ts`：线型表**全局唯一一份**，2D 视口与导出共用。剖断线粗实线、可见线中实线、不可见虚线、轴线与墙边线点划线。
- `dimensioning/`：三道尺寸线（细部 / 轴线 / 总尺寸）。算法为从轴线收集尺寸链、按图面留白自动分道、相交处断线、端点用建筑制图的 45° 短斜线而非箭头。此模块单元测试配额最高。
- `frame.ts`：A1 / A2 / A3 横竖图框与标题栏，自动填图名、比例、日期、设计人、图号。
- `schedules.ts`：门窗表由拓扑统计生成，编号规则 `M-01` / `C-01`。（S1 后半段实现，见 3.1）
- `sectioning/`：剖切线对 core 几何求切面交线 → 立面/剖面轮廓。（同上，S1 后半段）
- `pdf/`：自研 PDF 内容流后端，仅需覆盖 IR 用到的子集（直线、折线、文字、填充）与内置字体嵌入，非通用渲染器。

## 8. 持久化

### 8.1 库与表

```
dajia
  project        一行一工程：schema_version、名称、单位、lock_token、lock_expires_at
  storey         楼层：project_id、标高、层高、序号
  element        构件：id(UUIDv7)、project_id、storey_id、kind、payload JSON
                 + MySQL 8 生成列抽出 kind / loadBearing / 长度，并建索引
  command_log    增量命令：project_id、seq、actor、payload JSON、created_at
  snapshot       压缩快照：project_id、seq、payload JSON
  asset          描图底图、字体、纹理：BLOB 或 userData 路径
```

选择混合模型（实体行 + JSON payload + 命令日志）而非整文档单一大 JSON：core 内存真源本就是完整对象图，读取不需要 SQL 查构件，全列化只会带来写放大与 schema 演进痛苦；但 S5 工程量与门窗表确需 SQL 聚合，生成列索引保留了这条路径，无需解析整份 payload。

不设用户表、不设 owner 列（YAGNI，S6 再议）。

### 8.2 加载、保存、锁

加载 = 最近 snapshot + 重放其后的 `command_log`。保存 = 追加 command；每 2000 条命令、或连续 60 秒无编辑，二者先到即合并出新 snapshot。一次保存包在一个事务内。

`project.lock_token` + 心跳行是 **S1 必做项**：工程被持有效锁时，第二个实例检测到即以只读打开并显示顶部横幅。这是 D5（直连共享 MySQL）自带的账单 —— 没有它，两台机器打开同一库会静默互相覆盖。

迁移用极简顺序 `.sql` runner（`apps/desktop/src/main/db/migrations/`，`_migration` 表记版本），不引入 ORM。

连接配置经 Electron `safeStorage` 加密后存本地，不明文落盘。

## 9. 错误处理与数据安全

三层边界，失败方式各不相同：core 内部不变式被违反时**直接抛出，不做兜底**（几何已损坏继续绘制只会更坏）；IPC 边界 zod 校验 + 结构化错误码；UI 层人话提示 + 一键复制诊断。

**存盘失败绝不清空内存真源**：MySQL 不可达、断网、盘满时，屏幕上的模型必须仍在。表现为顶部红条 + 持续重试 + 同步向 `userData` 写 emergency JSON 快照。

启动时若发现 `command_log` 存在未合并片段，走恢复流程并明确告知恢复了什么、是否丢失。

连接失败给明确诊断（端口占用 / 服务未启动 / 认证失败 / 库不存在分别不同文案与下一步），不白屏。首启连接向导含"测试连接"。

## 10. 测试策略

| 层 | 手段 | 断言对象 |
|---|---|---|
| `core` | vitest（纯 Node）+ fast-check 属性测试 | 接头在任何随机墙网下闭合；洞口永不超出宿主墙长；`quantize` 幂等；`apply → inverse` 回到逐字节相同状态 |
| `drawing` | IR 快照测试 | 三道尺寸线分道的输出坐标逐个钉死；改坏时报"哪一道第几段从哪移到哪" |
| `pdf` | golden file + 文本抽取 | 1:100 下 3600mm 墙纸面必须 36.0mm ± 0.1；字号与线宽数值 |
| `repository` | 真 MySQL 集成测试，独立库 `dajia_test`，自建自清，**不 mock** | 事务、迁移、锁、崩溃恢复（写一半 kill 进程后重启可恢复） |
| `scene-2d` | 逻辑单测 | 视口变换、吸附优先级排序。渲染本身不做像素测试 |
| 端到端 | Playwright + Electron | 一条金路径：新建工程 → 画两面带接头的墙 → 开一门一窗 → 导出 A3 |

**需人工验证、本设计不打勾的项**：A3 实体打印后拿尺量图框与标注；干净虚拟机上的安装体验；Windows Defender / 防火墙弹窗；真实断电或强杀进程后的恢复。

## 11. S1 验收标准

1. 建一栋两层、外墙 240mm、含 4 门洞 4 窗洞的房子，导出 A3 1:100 平面图 PDF，三道尺寸线齐全，打印实测误差 ≤ 0.5mm。
2. 连续撤销 30 步不崩溃、状态正确。
3. 强杀进程后重开，未落盘命令被恢复，无静默丢失。
4. 两个实例同开一工程，第二个为只读并有可见提示。
5. `pnpm typecheck`、`pnpm test`、`pnpm build` 全绿。
6. 一台未装 MySQL 的机器上安装本应用，能得到"下一步该做什么"的可读指引（验证 D5 的缓解措施确实生效）。

## 12. 环境事实

**已在 2026-09-25 实测验证**：

- Node v24.14.1；pnpm 11.18.0；git 2.53.0.windows.2
- MySQL **8.0.45** 监听 `127.0.0.1:3306`，`root` / `1234560` **登录成功**
- 服务端参数：`character_set_server=utf8mb4`、`collation_server=utf8mb4_0900_ai_ci`、`lower_case_table_names=1`、`max_connections=151`
- 该实例现有 18 个数据库（其中 `mysql`、`information_schema`、`performance_schema`、`sys` 为系统库，用户库 14 个，含 `smartscrm`、`smartscrm_react`、`flowmart`、`ledger_db` 等），搭家使用独立的 `dajia` 与 `dajia_test`，不触碰其余
- `npm` 上包名 `dajia` 未被占用（`zhujia` 已占用，故排除）
- `Jamens/Slogan` 为零 commit 的空仓库
- 全局 `git config core.autocrlf=true`，`user.name=JunHao`。实测提交时 git 已警告会做 LF→CRLF 转换，因此 **M1.0 必须包含 `.gitattributes`（`* text=auto eol=lf`）**，否则跨平台行尾会污染 diff

**未验证**：以上除端口握手与只读登录外，均无建库、建表、写入操作。

## 13. 待用户确认事项

1. ~~**建库授权**~~ → **已获授权。** 用户于 2026-09-25 明确"允许在 MySQL 建 `dajia` 和 `dajia_test` 库"。授权覆盖 M1.3 所需的建库与建表；执行时点仍按里程碑排在 M1.3，本文档写入时尚未执行。
2. 是否将 `Jamens/Slogan` 改名为更贴合产品名的仓库（如 `dajia`）。当前默认保留原名，仅本地 `git init` + 配置 remote，**push 由用户本人执行**。
3. M1.8 描图底图是否保留在 S1（默认保留最简版）。
4. **安装包代码签名，需要你拍。** 本文档第 1 版漏了这一项。NSIS 安装包若无代码签名证书，Windows SmartScreen 会拦一个蓝色全屏警告，"使用者为不懂技术的人"这一条会让它看起来像病毒。三条路：(a) 买 OV/EV 证书（约 ¥1500–4000/年，EV 才能立刻消除警告）；(b) 不签名，改为一页图文安装说明 + 你远程协助；(c) 先按 (b) 做，等确有外部用户再补证书。**当前默认按 (c) 写**，M1.0 的打包配置预留签名开关。

## 14. 后续子项目路线图

每个子项目独立走「spec → 实现计划 → 实现」，S1 不越界实现下述内容。

| 编号 | 子项目 | 依赖 |
|---|---|---|
| S2 | 立面、剖面、门窗表、多图纸成册（复用 S1 的 IR 与标注引擎） | S1 |
| S3 | 3D 内直接编辑、弧形墙、楼梯与坡屋面、家具与材质 | S1, S2 |
| S4 | 水电点位、开关插座布置图 | S1, S2 |
| S5 | 工程量清单与装修预算 | S1, S4 |
| S6 | 模型库、云同步、多人协同（以 `command_log` 为同步载荷） | S1 |
