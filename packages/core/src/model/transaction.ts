import type { EntityId } from '../ids';
import type { Command } from './command';
// TransactionLog 只在类型位置用到 Document（字段/参数/返回值），不调它的静态方法，
// 所以是类型导入；Task 6 的反例（applyPatch 调 Document.replaceEntities）才需要值导入。
import type { Document } from './document';
import type { Entity } from './entity';
import { applyPatch, invertPatch, type Patch } from './patch';

interface Entry {
  patch: Patch;
  previous: ReadonlyMap<EntityId, Entity | undefined>;
}

export function affectedIds(patch: Patch): Set<EntityId> {
  const ids = new Set<EntityId>();
  for (const entity of patch.upsert) ids.add(entity.id);
  for (const id of patch.remove) ids.add(id);
  return ids;
}

/**
 * 撤销即应用逆补丁。重做直接再应用正向补丁：撤销后的文档状态与原 dispatch
 * 前状态相同（由 applyPatch/invertPatch 的成对性保证），故无需复用存的 previous。
 */
export class TransactionLog {
  private doc: Document;
  private readonly undoStack: Entry[] = [];
  private readonly redoStack: Entry[] = [];
  private lastAffected: Set<EntityId> = new Set();

  /**
   * 最近一次**真的打过**的补丁：`dispatch` 记正向、`undo` 记逆向、`redo` 记正向。
   * 计划 4 的 `command_log` 存的就是这一发（裁决 P-3的 `{ type, patch }`），
   * 而 undo/redo 各产出一发新的账（裁决 P-5），所以这一发在外面无法重算：
   * `invertPatch(entry.patch, entry.previous)` 的两个输入都住在本类内部。
   * 抛错时它停在上一发 —— `dispatch` 里赋值点在 `applyPatch` 之后，`cmd.build` 抛则一个字都没改，
   * 把失败的补丁报出去等于让保存引擎把一次没发生过的状态变更写进库。
   */
  private lastPatchApplied: Patch | null = null;

  constructor(doc: Document) {
    this.doc = doc;
  }

  get document(): Document {
    return this.doc;
  }

  /** 最近一次 dispatch/undo/redo 触及的实体 id，供计划 3 的 3D 增量重建使用。 */
  get affected(): ReadonlySet<EntityId> {
    return this.lastAffected;
  }

  /** 最近一次成功落地的补丁；`undo()`/`redo()` 返回 false 时它不动（没打过就没得报）。 */
  get lastPatch(): Patch | null {
    return this.lastPatchApplied;
  }

  get depth(): number {
    return this.undoStack.length;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  dispatch(cmd: Command): void {
    const patch = cmd.build(this.doc);
    const result = applyPatch(this.doc, patch);
    this.doc = result.doc;
    this.undoStack.push({ patch, previous: result.previous });
    this.redoStack.length = 0;
    this.lastAffected = affectedIds(patch);
    this.lastPatchApplied = patch;
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    // 逆补丁**必须命名**：否则记进 lastPatchApplied 的那份与打出去的那份是两次
    // invertPatch 调用的两个对象 —— 值相同、来源不同，读账的人无从判断哪个是"打过的那一发"。
    const inverse = invertPatch(entry.patch, entry.previous);
    this.doc = applyPatch(this.doc, inverse).doc;
    this.redoStack.push(entry);
    this.lastAffected = affectedIds(entry.patch);
    this.lastPatchApplied = inverse;
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this.doc = applyPatch(this.doc, entry.patch).doc;
    this.undoStack.push(entry);
    this.lastAffected = affectedIds(entry.patch);
    this.lastPatchApplied = entry.patch;
    return true;
  }
}
