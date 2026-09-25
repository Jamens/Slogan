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
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.doc = applyPatch(this.doc, invertPatch(entry.patch, entry.previous)).doc;
    this.redoStack.push(entry);
    this.lastAffected = affectedIds(entry.patch);
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this.doc = applyPatch(this.doc, entry.patch).doc;
    this.undoStack.push(entry);
    this.lastAffected = affectedIds(entry.patch);
    return true;
  }
}
