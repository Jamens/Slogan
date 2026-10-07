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

  /**
   * 为什么这里要一个 `as`：TS 的控制流分析**无法知道** zustand 的 `create` initializer 会被
   * 同步执行，于是它认定 `stopWatching = editor.subscribe(...)` 之后该变量**永远**是那个函数，
   * 初始的 `null` 永远到不了下面 —— 于是 `const stop = stopWatching` 被收窄成 `never`，
   * `stop()` 就红成 `TS2349: Type 'never' has no call signatures`（T8 接线时 `tsc` 抓出来的）。
   *
   * 断言是**声明**那一侧的形状，不是"绕过检查"：`create` 的 initializer 同步执行是 zustand 的
   * 既成事实（同 `put` 那条"唯一的 `set` 出口"注释的前提）。下面那道守卫**仍然保留**：
   * 万一哪天它不同步了，跑起来会抛那句人话，而不是安静地漏一个订阅 ——
   * 守卫**在断言之前**判的是"订阅到底有没有挂上"，那件事 TS 答不了。
   * 换句话说：**编译期用断言，运行时用守卫**，两边各管一件事。
   */
  if (stopWatching === null) {
    // 不写这一发的话，`stop` 会是个静默的空函数：测试结束时订阅没撤，下一格收走上一格的编辑，
    // 红起来读不出是谁干的。
    throw new Error('createProjectStore：zustand 没同步执行 initializer，订阅撤不掉');
  }
  const stop = stopWatching as () => void;
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
  // brief 定稿于计划 5 之前，`NOT_INJECTED` 只写了五件；裁决 T8-A③ 把 `exportPlan` 留在
  // `DajiaApi` 上，于是这个对象字面量必须补第六件才编得过 —— 文案口径与下面三件同族。
  exportPlan: async () => ({
    ok: false,
    error: '没有 preload 注入的 dajia 接口：这一屏不会保存任何东西',
  }),
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
  onSaveStatus: (_listener) => () => {
    // 没有桥可订 ⇒ 没有可撤的东西。空函数不是"什么都没做"，是"这一族的注销契约仍然成立"。
    //
    // 参数**必须显式写出来**（`_listener` 而不是 `() => …`）：`DajiaApi.onSaveStatus` 吃一个回调，
    // 而 TS 的严格函数类型要求实现与签名兼容 —— 零参实现传给那个签名时调用点会红。
    // `_` 前缀标出"有意不用"，`noUnusedParameters` 才不报。
    return () => {
      // 注销函数照契约返回，但底下没有东西可撤。
    };
  },
};

/**
 * App 用的那一份。`readDajia()` 在 node 档回 null ⇒ 空壳顶上，模块 import 不炸（那既是这一族
 * 测试的前提，也是"打包路径写错 ⇒ 漏注入"那一型在生产里的形状：屏幕照常画，横幅说真话）。
 */
export const useProject = createProjectStore(readDajia() ?? NOT_INJECTED)[0];
