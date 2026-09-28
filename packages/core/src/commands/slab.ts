import { uuidv7, type EntityId } from '../ids';
import { assertMm, positiveMm, quantizeMm } from '../units/mm';
import type { Command } from '../model/command';
import type { Document } from '../model/document';
import type { Entity, PointEntity, SlabEntity } from '../model/entity';
import { mustExist, requireStorey } from '../model/read';
import {
  isExistingPoint,
  pointStillReferenced,
  resolvePointRef,
  type PointRef,
} from '../geom/topology';
import { assertSimpleRing } from '../geom/ring';
import { vec } from '../geom/vec';

export interface SlabCreateInput {
  storeyId: EntityId;
  /** 开环：首尾不重复，闭合由派生方隐含。至少 3 个，顺序就是真源里的边界走向。 */
  boundary: PointRef[];
  thicknessMm: number;
  elevationOffsetMm?: number;
}

/** 与 `commands/opening.ts` 里那份 `requireOpening` 同一口径：读取断言长在用的那个文件里。 */
function requireSlab(doc: Document, id: EntityId): SlabEntity {
  const entity = mustExist(doc, id, '板');
  if (entity.kind !== 'slab') throw new TypeError(`${id} 不是板，是 ${entity.kind}`);
  return entity;
}

export function slabCreate(input: SlabCreateInput): Command {
  const thicknessMm = positiveMm(assertMm(input.thicknessMm, '板厚'), '板厚');
  const elevationOffsetMm = assertMm(input.elevationOffsetMm ?? 0, '板标高偏移');
  // 入参在构造期只判"形状"（数量与重复），坐标本身要等 build 才读得到（可能是复用的点）
  if (input.boundary.length < 3) {
    throw new RangeError(`板边界至少 3 个顶点，收到 ${input.boundary.length}`);
  }
  const seen = new Set<EntityId>();
  for (const ref of input.boundary) {
    if (isExistingPoint(ref)) {
      if (seen.has(ref.pointId)) throw new RangeError(`板边界有重复的顶点 id：${ref.pointId}`);
      seen.add(ref.pointId);
    }
  }
  return {
    type: 'slab.create',
    build(doc: Document) {
      // 楼层检查一次就够：requireStorey 内部已含 mustExist（返回值本任务用不上，
      // 但板的标高偏移迟早要和楼层标高相加，先走同一道门）
      requireStorey(doc, input.storeyId);
      const ids: EntityId[] = [];
      const points: PointEntity[] = [];
      for (const ref of input.boundary) {
        if (isExistingPoint(ref)) {
          // 这个分支里 resolvePointRef 必然返回点（点若不存在它当场就抛了；null 只给坐标字面量），
          // 所以 `!` 只是把这条已成立的推理告诉 TS，不是兜底
          const existing = resolvePointRef(doc, ref, input.storeyId)!;
          ids.push(existing.id);
          points.push(existing);
          continue;
        }
        const created: PointEntity = {
          kind: 'point',
          id: uuidv7(),
          storeyId: input.storeyId,
          x: quantizeMm(ref.x),
          y: quantizeMm(ref.y),
        };
        ids.push(created.id);
        points.push(created);
      }
      // 环的合法性在这里判完就够：计划 2 没有任何派生出口会再读板的边界，
      // 命令层是唯一一道门，漏过去就一路躺到计划 5 的图纸上。
      assertSimpleRing('板边界', points.map((p) => vec(p.x, p.y)));
      const slab: SlabEntity = {
        kind: 'slab',
        id: uuidv7(),
        storeyId: input.storeyId,
        boundaryPointIds: ids,
        thicknessMm,
        elevationOffsetMm,
      };
      const upsert: Entity[] = [...points.filter((p) => !doc.get(p.id)), slab];
      return { upsert, remove: [] };
    },
  };
}

/**
 * 删一块板，并把它**独占**的边界点一起带走。孤儿判定问 `pointStillReferenced`
 * （与 `wallDelete` / `columnDelete` 同一份产地）：板的角点常常就是墙端点。
 * 被删点的顺序跟着 `boundaryPointIds` 的环序走 —— 那是真源里已有的顺序，
 * 不必再按 id 重排（重排是第二套口径，且 `remove` 的顺序只影响 `affected` 的迭代序）。
 */
export function slabDelete(input: { slabId: EntityId }): Command {
  return {
    type: 'slab.delete',
    build(doc: Document) {
      const slab = requireSlab(doc, input.slabId);
      const remove: EntityId[] = [slab.id];
      const except = new Set<EntityId>([slab.id]);
      for (const pointId of slab.boundaryPointIds) {
        if (pointStillReferenced(doc, pointId, except)) continue;
        // 引用早就悬空（点不在文档里）时跳过：`applyPatch` 对不存在的 remove id 是**抛**的，
        // 而"坏数据必须还能删"—— 一块角点已经丢了的板，绝不能因为删不掉而把文档锁死。
        if (!doc.get(pointId)) continue;
        remove.push(pointId);
      }
      return { upsert: [], remove };
    },
  };
}
