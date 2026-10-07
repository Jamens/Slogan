import { create } from 'zustand';
import type { Command, Document, WallEnd } from '@dajia/core';
import { TransactionLog } from '@dajia/core';
import {
  demoHouse,
  type DraftWall,
  type DragHandle,
  type DropTarget,
  type MoveTarget,
  type Px,
  type Tool,
  type Viewport,
} from '@dajia/scene-2d';

// demoHouse() 只调一次（T3 的理由照旧：调两次就是"屏幕画 B、命中查 A"，且不报错）。
const demo = demoHouse();

/** 一次进行中的拖拽。中途只活在这里，不进真源（D4）。 */
export interface DragState {
  readonly wallId: string;
  readonly end: WallEnd;
  readonly pointId: string;
  /** 按下那一发从真源读到的坐标：松手回到它 ⇒ noop，一个字都不写。 */
  readonly atMm: MoveTarget;
  readonly fromPx: Px;
  readonly cursorPx: Px;
  readonly targetMm: MoveTarget;
  /**
   * 按下命中的那把把手（S4 ②）：吸附的**锚点**（`handle.anchorMm`）与**排除集**
   * （`handle.atMm`）都长在它身上，所以拖拽态必须带上它 —— 不带就只能在 `onMove` 里
   * 重算 `pickHandle`，而重算出来的把手与按下那一把不是同一个对象，中途换墙就是改语义。
   */
  readonly handle: DragHandle;
  /**
   * 吸附后的完整落点（`raw` / `mm` / `snap`）。`targetMm` 恒等于 `drop.mm`，两个字段都留着
   * 是因为 T5 的三处判据（noop 比对、`wallMoveEndpoint` 入参、`DropReport.targetMm`）写的是
   * `targetMm`，而第四色标记要读的是 `drop.snap`。按下那一发 `drop === null`（S4 ①：不吸）。
   */
  readonly drop: DropTarget | null;
}

export interface EditorState {
  readonly log: TransactionLog;
  readonly storeyId: string;
  /** null = 还没量过窗口尺寸，一帧都还没画 */
  readonly viewport: Viewport | null;
  /**
   * 眼下这份 `viewport` 是**为哪一层**算的。它与 `viewport` 必须同一发 `set`，理由与 P10 同一条：
   * 分两拍就有一个"新一层的图配旧一层的口径"的中间帧，而这里更糟 —— 那一帧上两个字段都对，
   * 只有配对错，屏幕上什么都看不出来。
   *
   * 它存在的唯一理由是 `--prop-shot` 第 1 步那条 P10 判据需要一颗牙，而数值那一口咬不住：
   * 样例房两层是同一 footprint（实测 `fitStorey` 两次的 `pxPerMm` 与 `origin` 逐字相同，
   * 见 2026-09-30 的 t8E 注记），所以"切层后视口数值变了"这句话在样例房里**根本不成立**，
   * 计划原文那句「`pxPerMm` 与 `origin` 逐字等于同一次调用算出的 `fitStorey(二层)`」只能降级成
   * "视口是为这一层算的" + "两次切回来数值逐字回到第 0 步"。摘掉 `setStorey` 里那份重算，
   * 这一格就留在上一层 ⇒ 判据红；只改 `storeyId` 不改视口，那一发也红。
   */
  readonly viewportStoreyId: string | null;
  /**
   * 唯一的"该重绘了"扳机（D6）。`log` 是可变类实例，引用永远不变 ⇒ zustand 的
   * `Object.is` 判定相等 ⇒ 只订阅 `{log}` 的组件**永不重渲**，所以这不是保险，是唯一的通路。
   * 它只在 `dispatch`/`dispatchBatch`/`undo`/`redo` **成功**之后 +1：失败不动它 ⇒ 既不重绘也无副作用，
   * 于是计划 2 转下游 #11（`log.lastAffected` 在抛错后留着上一批 id）在本任务里根本没有读者。
   */
  readonly revision: number;
  readonly lastError: string | null;
  readonly drag: DragState | null;
  /** 工具态。`'wall'` 时不画把手、点选不生效，按下即起草稿（S2 的屏幕侧形状）。 */
  readonly tool: Tool;
  /** 进行中的墙草稿。中途只活在这里，不进真源（与 `drag` 同一条 D4 纪律）。 */
  readonly draft: DraftWall | null;
  /**
   *  resize / 挂载那一发的视口写入。`storeyId` 是**这次 fitStorey 是为哪一层算的** ——
   *  它必须跟着视口一起进来：分两拍就有一个"视口是新一层、记账还是旧一层"的中间帧
   *  （`--prop-shot` 第 1 步的 P10 牙就判这一对，见 `viewportStoreyId`）。
   */
  setViewport: (viewport: Viewport | null, storeyId: string | null) => void;
  /**
   * P10：换层与视口复位必须是同一次 `set`。调用方负责清选中集（store 不碰 selectionStore），
   * 尺寸也由调用方算好递进来（只有画在屏上的 `PlanCanvas` 量得到画布自己有多大）。
   *
   * 这一发顺手把 `revision` +1：切层不是真源编辑，是视图状态，而扳的正是"派生读数该重算了" ——
   * `storeyTabsOf` 与 `wallPropsOf` 都吃文档，文档没变但"当前层"变了，不扳一次面板与 tab
   * 就留着上一层的读数。与上面那句"只在成功之后 +1"不冲突：切层没有失败那一支。
   */
  setStorey: (storeyId: string, viewport: Viewport) => void;
  setDrag: (drag: DragState | null) => void;
  setTool: (tool: Tool) => void;
  setDraft: (draft: DraftWall | null) => void;
  dispatch: (cmd: Command) => void;
  /** 一批命令 = 一个循环，**不是一个事务**（见下面那条注释）。 */
  dispatchBatch: (cmds: readonly Command[]) => void;
  /**
   * 绘制/派生那一趟抛了时的报告口：**只动 `lastError`、绝不动 `revision`** —— 上面那条纪律
   * （失败路径动 revision 等于"为一件没发生的事重绘整张图"）在这里一字不差地成立，
   * 而且更狠：这一抛什么都没改（真源没动、几何没变），重绘只会拿同一份坏几何再抛一次。
   */
  reportPaintError: (err: unknown) => void;
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
  undo: () => void;
  redo: () => void;
}

export const useEditor = create<EditorState>((set, get) => ({
  log: demo.log,
  storeyId: demo.lowerStoreyId,
  viewport: null,
  viewportStoreyId: null,
  revision: 0,
  lastError: null,
  drag: null,
  tool: 'select',
  draft: null,
  readOnly: false,
  // `viewport === null` 时那一格也必须 null：留着一层的 id 配一份不存在的视口，
  // 判据读到的是"记账说有、屏幕上没有"。
  setViewport: (viewport, storeyId) =>
    set({ viewport, viewportStoreyId: viewport === null ? null : storeyId }),
  // 一次 `set` 换两格（P10）：分两次就留一个中间帧 —— 新一层的图配旧一层的 `origin`，
  // 画在画布外，红形是"pxPerMm 对不上"这种谁也看不懂的话。
  // 代价照付：`storeyId` 的变更入口从"随便谁 set"收成一个函数，以后滚轮切层也得走这一道。
  // 第三格 `viewportStoreyId` 是同一发 `set` 里的记账（不是第四次 `set`）：
  // 视口与"它为哪一层算的"永远成对出现，缺一半就是 P10 那个中间帧。
  setStorey: (storeyId, viewport) =>
    set({
      storeyId,
      viewport,
      viewportStoreyId: storeyId,
      draft: null,
      tool: 'select',
      revision: get().revision + 1,
    }),
  setDrag: (drag) => set({ drag }),
  setTool: (tool) => set({ tool }),
  setDraft: (draft) => set({ draft }),
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
  // 失败路径**必须**只动 lastError：动 revision 就是"为一件没发生的事重绘整张图"。
  dispatch: (cmd) => {
    if (get().readOnly) {
      set({ lastError: `只读工程：这一发改不动（${cmd.type}）` });
      return;
    }
    try {
      get().log.dispatch(cmd);
    } catch (err) {
      set({ lastError: `拖不动：${String(err)}` });
      return;
    }
    set((s) => ({ revision: s.revision + 1, lastError: null }));
  },
  /**
   * 删除走这里，拉墙仍走 `dispatch`（一条命令一条路，别为了"统一"把单发也套进循环）。
   *
   * **它不是一个事务**：读过源码，`TransactionLog` 只有 `dispatch` / `undo` / `redo` 三个动作
   * 与 `affected` / `depth` / `canUndo` / `canRedo` 四个读数，没有 begin/commit/rollback。
   * 所以一次删除（N 面墙 + M 樘独立洞口）= 撤销栈上的 **N+M 步**，连按 Ctrl+Z 会一条条退回去；
   * 而 `S5` 排的"洞口在前、墙在后"保证了第 ② 条命令不会 `requireOpening` 抛在半途 ——
   * 顺序反了才真会留下半套状态（那条由 `editing.test.ts` 的 E1 钉住）。
   * 代价照付：批语义（一次撤销退一整组）是计划 4 真源侧的决定，UI 不许私自拿
   * "连发多条 + 出错回滚" 拼一个假事务：回滚要逆序重放补丁，那是第二套 `invertPatch`。
   */
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
  /**
   * 绘制那一趟的抛点记账：**只动 lastError，一个字的 revision 都不碰**（接口上那条注释是纪律原文）。
   * 文案沿用 `拖不动：` / `删不动：` 的同一口径 —— 屏幕上出现的中文报错只有一种形状，
   * 判据（与 T7 已落地的 `assertDerivesAfterApply`——见 `packages/core/src/commands/wall.ts`
   * 里 `wallSetThickness.build` 末尾那一句）才分得出"哪一路抛的"而不用读栈。
   */
  reportPaintError: (err) => {
    set({ lastError: `画不出来：${String(err)}` });
  },
  undo: () => {
    if (get().readOnly) {
      set({ lastError: '只读工程：撤销不动（账本没开，退了也没地方记）' });
      return;
    }
    if (!get().log.undo()) {
      set({ lastError: '没有可撤销的操作' }); // D7：栈空要给反馈，不许静默返回 false
      return;
    }
    set((s) => ({ revision: s.revision + 1, lastError: null }));
  },
  redo: () => {
    if (get().readOnly) {
      set({ lastError: '只读工程：重做不动（账本没开，前进也没有账号可挂）' });
      return;
    }
    if (!get().log.redo()) {
      set({ lastError: '没有可重做的操作' });
      return;
    }
    set((s) => ({ revision: s.revision + 1, lastError: null }));
  },
}));
