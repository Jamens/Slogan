import { create } from 'zustand';

export interface SelectionState {
  readonly ids: ReadonlySet<string>;
  select: (id: string) => void;
  toggle: (id: string) => void;
  clear: () => void;
  retain: (keep: Iterable<string>) => void;
}

/**
 * 选中集独立于 editorStore：spec 明令它不进真源、不进撤销栈、不落库（关窗口就该忘掉，
 * 撤销一次拖拽不该顺手改回选中）。这里每次返回**新的 Set** —— 原地 add/delete 让
 * zustand 的 `Object.is` 判定相等、订阅者不重渲，屏幕就不跟着红，那是"点了没反应"里最难查的一种。
 * 重复点同一个构件、清空已经空的集，都原样返回 state：不为了"看着安全"多刷一帧。
 *
 * `retain` 是**删除之后**的剪枝：屏幕上不去猜"这条命令的补丁会收走哪些 id"，真源落完之后拿
 * `doc.get(id)` 问一遍（`pruneSelection` 就是那一问）。`undo` / `redo` **不走**它 —— D7 判过
 * "撤销的是文档，不是视图"，于是撤销掉一面正被选中的墙之后，选中集里会留一个不存在的 id。
 * 那无害（`buildDrawList` 与 `dragHandlesOf` 都按 `doc.get` 找不到就跳过），但它是 Task 8 的接缝。
 */
export const useSelection = create<SelectionState>((set) => ({
  ids: new Set<string>(),
  select: (id) => set((s) => (s.ids.size === 1 && s.ids.has(id) ? s : { ids: new Set([id]) })),
  toggle: (id) =>
    set((s) => {
      const next = new Set(s.ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ids: next };
    }),
  clear: () => set((s) => (s.ids.size === 0 ? s : { ids: new Set<string>() })),
  retain: (keep) =>
    set((s) => {
      const allowed = new Set(keep);
      const next = new Set([...s.ids].filter((id) => allowed.has(id)));
      // `next` 是 `s.ids` 的子集，所以"元素个数相等"就等价于"集合相等"⇒ 一个都没剪掉时
      // 原样返回 state：换了新 Set 的引用会让订阅者白重渲一帧，画的是同一张图。
      if (next.size === s.ids.size) return s;
      return { ids: next };
    }),
}));
