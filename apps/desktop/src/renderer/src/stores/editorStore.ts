import { create } from 'zustand';
import type { Command, TransactionLog, WallEnd } from '@dajia/core';
import { demoHouse, type MoveTarget, type Px, type Viewport } from '@dajia/scene-2d';

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
}

export interface EditorState {
  readonly log: TransactionLog;
  readonly storeyId: string;
  /** null = 还没量过窗口尺寸，一帧都还没画 */
  readonly viewport: Viewport | null;
  /**
   * 唯一的"该重绘了"扳机（D6）。`log` 是可变类实例，引用永远不变 ⇒ zustand 的
   * `Object.is` 判定相等 ⇒ 只订阅 `{log}` 的组件**永不重渲**，所以这不是保险，是唯一的通路。
   * 它只在 `dispatch`/`undo`/`redo` **成功**之后 +1：失败不动它 ⇒ 既不重绘也无副作用，
   * 于是计划 2 转下游 #11（`log.lastAffected` 在抛错后留着上一批 id）在本任务里根本没有读者。
   */
  readonly revision: number;
  readonly lastError: string | null;
  readonly drag: DragState | null;
  setViewport: (viewport: Viewport | null) => void;
  setDrag: (drag: DragState | null) => void;
  dispatch: (cmd: Command) => void;
  undo: () => void;
  redo: () => void;
}

export const useEditor = create<EditorState>((set, get) => ({
  log: demo.log,
  storeyId: demo.lowerStoreyId,
  viewport: null,
  revision: 0,
  lastError: null,
  drag: null,
  setViewport: (viewport) => set({ viewport }),
  setDrag: (drag) => set({ drag }),
  // 失败路径**必须**只动 lastError：动 revision 就是"为一件没发生的事重绘整张图"。
  dispatch: (cmd) => {
    try {
      get().log.dispatch(cmd);
    } catch (err) {
      set({ lastError: `拖不动：${String(err)}` });
      return;
    }
    set((s) => ({ revision: s.revision + 1, lastError: null }));
  },
  undo: () => {
    if (!get().log.undo()) {
      set({ lastError: '没有可撤销的操作' }); // D7：栈空要给反馈，不许静默返回 false
      return;
    }
    set((s) => ({ revision: s.revision + 1, lastError: null }));
  },
  redo: () => {
    if (!get().log.redo()) {
      set({ lastError: '没有可重做的操作' });
      return;
    }
    set((s) => ({ revision: s.revision + 1, lastError: null }));
  },
}));
