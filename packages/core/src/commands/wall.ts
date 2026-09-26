import { uuidv7, type EntityId } from '../ids';
import { assertMm, quantizeMm, type Mm } from '../units/mm';
import { mustExist, requirePoint, requireWall } from '../model/read';
import { endPointId, otherEnd, wallAxis, type WallEnd } from '../geom/axis';
import {
  incidentWallEnds,
  isExistingPoint,
  resolvePointRef,
  type PointRef,
} from '../geom/topology';
import type { Command } from '../model/command';
import type { Document } from '../model/document';
import type { Entity, OpeningEntity, WallEntity } from '../model/entity';

export interface WallCreateInput {
  storeyId: EntityId;
  /** 共享端点：`{ pointId }` 复用既有点，两面墙于是拓扑闭合（Task 3） */
  start: PointRef;
  end: PointRef;
  thicknessMm: Mm;
  heightMm: Mm;
  elevationOffsetMm?: Mm;
  loadBearing?: boolean;
  material?: string;
}

/** 端点解析结果：id 为 null 表示这个点还要新建。 */
interface ResolvedEnd {
  readonly id: EntityId | null;
  readonly x: Mm;
  readonly y: Mm;
}

function resolveEnd(doc: Document, ref: PointRef, storeyId: EntityId): ResolvedEnd {
  const existing = resolvePointRef(doc, ref, storeyId);
  if (existing !== null) return { id: existing.id, x: existing.x, y: existing.y };
  if (isExistingPoint(ref)) {
    // resolvePointRef 对 pointId 形态要么返点要么抛，走不到这里；留着是让类型收窄成立
    throw new TypeError(`端点 ${ref.pointId} 无法解析`);
  }
  return { id: null, x: quantizeMm(ref.x), y: quantizeMm(ref.y) };
}

/** 轮廓能不能成立。文案与计划 1 逐字相同 —— commands.test.ts 的 /零长/、/不小于墙长/ 靠它。 */
function assertWallShape(thicknessMm: Mm, x0: Mm, y0: Mm, x1: Mm, y1: Mm): void {
  if (x0 === x1 && y0 === y1) {
    throw new RangeError(`零长墙：两端点量化后同为 (${x0}, ${y0})`);
  }
  const lengthMm = Math.hypot(x1 - x0, y1 - y0);
  if (thicknessMm >= lengthMm) {
    throw new RangeError(
      `墙厚 ${thicknessMm} 不小于墙长 ${Math.round(lengthMm)}，轮廓会自相交`,
    );
  }
}

export function wallCreate(input: WallCreateInput): Command {
  const thicknessMm = assertMm(input.thicknessMm, '墙厚');
  const heightMm = assertMm(input.heightMm, '墙高');
  const elevationOffsetMm = assertMm(input.elevationOffsetMm ?? 0, '标高偏移');
  const startRef = input.start;
  const endRef = input.end;
  // 两端都是字面量时构造期就能判；只要有一端复用，坐标在文档里，只能等 build 再判。
  if (!isExistingPoint(startRef) && !isExistingPoint(endRef)) {
    assertWallShape(
      thicknessMm,
      quantizeMm(startRef.x),
      quantizeMm(startRef.y),
      quantizeMm(endRef.x),
      quantizeMm(endRef.y),
    );
  }
  return {
    type: 'wall.create',
    build(doc: Document) {
      mustExist(doc, input.storeyId, '楼层');
      const a = resolveEnd(doc, input.start, input.storeyId);
      const b = resolveEnd(doc, input.end, input.storeyId);
      assertWallShape(thicknessMm, a.x, a.y, b.x, b.y);
      const upsert: Entity[] = [];
      const startId = a.id ?? uuidv7();
      if (a.id === null) {
        upsert.push({
          kind: 'point',
          id: startId,
          storeyId: input.storeyId,
          x: a.x,
          y: a.y,
        });
      }
      const endId = b.id ?? uuidv7();
      if (b.id === null) {
        upsert.push({
          kind: 'point',
          id: endId,
          storeyId: input.storeyId,
          x: b.x,
          y: b.y,
        });
      }
      const wall: WallEntity = {
        kind: 'wall',
        id: uuidv7(),
        storeyId: input.storeyId,
        startId,
        endId,
        thicknessMm,
        heightMm,
        elevationOffsetMm,
        loadBearing: input.loadBearing ?? true,
        material: input.material ?? 'brick',
      };
      upsert.push(wall);
      return { upsert, remove: [] };
    },
  };
}

export function wallSetThickness(input: { wallId: EntityId; thicknessMm: Mm }): Command {
  const thicknessMm = assertMm(input.thicknessMm, '墙厚');
  return {
    type: 'wall.setThickness',
    build(doc: Document) {
      const wall = requireWall(doc, input.wallId);
      if (thicknessMm <= 0) throw new RangeError(`墙厚必须为正，收到 ${thicknessMm}`);
      if (thicknessMm >= wallAxis(doc, wall).lengthMm) {
        throw new RangeError(`墙厚 ${thicknessMm} 不小于墙长，轮廓会自相交`);
      }
      return { upsert: [{ ...wall, thicknessMm }], remove: [] };
    },
  };
}

export function wallMoveEndpoint(input: {
  wallId: EntityId;
  end: WallEnd;
  x: number;
  y: number;
}): Command {
  const x = quantizeMm(input.x);
  const y = quantizeMm(input.y);
  return {
    type: 'wall.moveEndpoint',
    build(doc: Document) {
      const wall = requireWall(doc, input.wallId);
      const moving = requirePoint(doc, endPointId(wall, input.end), '端点');
      const anchor = requirePoint(doc, endPointId(wall, otherEnd(input.end)), '另一端点');
      if (anchor.x === x && anchor.y === y) {
        throw new RangeError(`零长墙：端点移到与另一端 (${x}, ${y}) 重合`);
      }
      // 被拖的这面墙自己也要查：计划 1 只让 wallCreate / wallSetThickness 管墙厚与轴长的关系，
      // 拖端点是第三条能改轴长的路。少了这一条，把 3600 长的 240 墙拖到 200 就成功了，
      // 而 Task 5 的轮廓会自相交 —— 真源里绝不能留这种东西。
      const selfLengthMm = Math.hypot(x - anchor.x, y - anchor.y);
      if (wall.thicknessMm >= selfLengthMm) {
        throw new RangeError(
          `移动端点会让墙 ${wall.id} 的墙厚 ${wall.thicknessMm} 不小于轴长 ${Math.round(selfLengthMm)}，轮廓会自相交`,
        );
      }
      // 共享端点：这一动会带走所有指着同一个点的墙。逐面按同样的规矩检查，
      // 绝不允许把邻墙拖成零长或非法轮廓 —— 真源里不留坏几何，抛错比画歪便宜得多。
      for (const inc of incidentWallEnds(doc, moving.id, wall.id)) {
        const neighbour = requireWall(doc, inc.wallId);
        const other = requirePoint(doc, endPointId(neighbour, otherEnd(inc.end)), '邻墙另一端点');
        if (other.x === x && other.y === y) {
          throw new RangeError(
            `移动端点会让墙 ${neighbour.id} 变成零长：它与本墙共享端点 ${moving.id}`,
          );
        }
        const lengthMm = Math.hypot(x - other.x, y - other.y);
        if (neighbour.thicknessMm >= lengthMm) {
          throw new RangeError(
            `移动端点会让墙 ${neighbour.id} 的墙厚 ${neighbour.thicknessMm} 不小于轴长 ${Math.round(lengthMm)}，轮廓会自相交`,
          );
        }
      }
      return { upsert: [{ ...moving, x, y }], remove: [] };
    },
  };
}

export function wallDelete(input: { wallId: EntityId }): Command {
  return {
    type: 'wall.delete',
    build(doc: Document) {
      const wall = requireWall(doc, input.wallId);
      const remove: EntityId[] = [wall.id];
      const openings: readonly OpeningEntity[] = doc.byKind('opening');
      for (const opening of openings) {
        if (opening.hostWallId === wall.id) remove.push(opening.id);
      }
      for (const pointId of [wall.startId, wall.endId]) {
        if (!stillReferenced(doc, pointId, wall.id)) remove.push(pointId);
      }
      return { upsert: [], remove };
    },
  };
}

/** 除被删的这面墙之外，还有谁指着这个点。柱与板也要查，否则孤儿判定会误删。 */
function stillReferenced(doc: Document, pointId: EntityId, excludeWallId: EntityId): boolean {
  for (const w of doc.byKind('wall')) {
    if (w.id === excludeWallId) continue;
    if (w.startId === pointId || w.endId === pointId) return true;
  }
  for (const c of doc.byKind('column')) {
    if (c.pointId === pointId) return true;
  }
  for (const s of doc.byKind('slab')) {
    if (s.boundaryPointIds.includes(pointId)) return true;
  }
  return false;
}
