import type { EntityId } from '../ids';
// Document 必须是值导入：applyPatch 运行时调用 Document.replaceEntities，
// 用 import type 会被 verbatimModuleSyntax 擦掉，测试里表现为 ReferenceError。
import { Document } from './document';
import type { Entity } from './entity';

export interface Patch {
  readonly upsert: readonly Entity[];
  readonly remove: readonly EntityId[];
}

export interface PatchResult {
  doc: Document;
  /** patch 涉及的每个 id 都要有记录；新建的记为 undefined。求逆的唯一依据。 */
  previous: ReadonlyMap<EntityId, Entity | undefined>;
}

export function applyPatch(doc: Document, patch: Patch): PatchResult {
  const upsertIds = new Set<EntityId>();
  for (const entity of patch.upsert) {
    if (upsertIds.has(entity.id)) {
      throw new TypeError(`Patch.upsert 内 id 重复：${entity.id}`);
    }
    upsertIds.add(entity.id);
  }
  for (const id of patch.remove) {
    if (upsertIds.has(id)) {
      throw new TypeError(`Patch 同一 id 既 upsert 又 remove：${id}`);
    }
    if (!doc.entities.has(id)) {
      throw new TypeError(`Patch.remove 的实体不存在：${id}`);
    }
  }

  const previous = new Map<EntityId, Entity | undefined>();
  for (const id of patch.remove) previous.set(id, doc.entities.get(id));
  for (const entity of patch.upsert) {
    if (!previous.has(entity.id)) previous.set(entity.id, doc.entities.get(entity.id));
  }

  const next = new Map(doc.entities);
  for (const id of patch.remove) next.delete(id);
  for (const entity of patch.upsert) next.set(entity.id, entity);

  return { doc: Document.replaceEntities(doc, next), previous };
}

export function invertPatch(
  patch: Patch,
  previous: ReadonlyMap<EntityId, Entity | undefined>,
): Patch {
  const restore: Entity[] = [];
  const drop: EntityId[] = [];
  for (const id of patch.remove) {
    const entity = previous.get(id);
    if (entity) restore.push(entity);
  }
  for (const entity of patch.upsert) {
    const before = previous.get(entity.id);
    if (before) restore.push(before);
    else drop.push(entity.id);
  }
  return { upsert: restore, remove: drop };
}
