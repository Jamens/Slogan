import { uuidv7, type EntityId } from '../ids';
import { assertMm, positiveMm, quantizeMm, type Mm } from '../units/mm';
import { requirePoint, requireStorey, requireWall } from '../model/read';
import { endPointId, otherEnd, wallAxis, type WallEnd } from '../geom/axis';
import { length, sub, vec } from '../geom/vec';
import {
  assertNoGhostColumn,
  incidentWallEnds,
  isExistingPoint,
  resolvePointRef,
  type PointRef,
} from '../geom/topology';
import { assertSpansFit, spansOfOpenings } from '../geom/opening';
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
  const lengthMm = length(sub(vec(x1, y1), vec(x0, y0)));
  if (thicknessMm >= lengthMm) {
    throw new RangeError(
      `墙厚 ${thicknessMm} 不小于墙长 ${Math.round(lengthMm)}，轮廓会自相交`,
    );
  }
}

export function wallCreate(input: WallCreateInput): Command {
  const thicknessMm = positiveMm(assertMm(input.thicknessMm, '墙厚'), '墙厚');
  const heightMm = positiveMm(assertMm(input.heightMm, '墙高'), '墙高');
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
      requireStorey(doc, input.storeyId);
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
      positiveMm(thicknessMm, '墙厚');
      if (thicknessMm >= wallAxis(doc, wall).lengthMm) {
        throw new RangeError(`墙厚 ${thicknessMm} 不小于墙长，轮廓会自相交`);
      }
      return { upsert: [{ ...wall, thicknessMm }], remove: [] };
    },
  };
}

/**
 * 该墙缩到 newLengthMm 以后，把挂在它上面的洞口沿轴往起点方向夹回来。
 * 只减 distanceMm，绝不动 widthMm —— 洞口宽度是产品尺寸，静默改窄比报错危险。
 * 夹完必须复核整表：往回夹会让两樘撞上（新墙长排不开它们），那种拖动施工上不成立。
 * 复核用 Task 6 的 assertSpansFit，不在这里重写区间规则。
 * 只有真被夹动的才进 upsert：affected 是"这次到底改了什么"的记录，
 * 每次拖动都重述全部洞口会把它稀释成噪音（用例「拉长墙」盯着这条）。
 */
function clampOpeningsToWall(
  doc: Document,
  wall: WallEntity,
  newLengthMm: number,
  upsert: Entity[],
): void {
  const final: OpeningEntity[] = [];
  const dirty: OpeningEntity[] = [];
  for (const opening of doc.byKind('opening')) {
    if (opening.hostWallId !== wall.id) continue;
    if (opening.distanceMm + opening.widthMm <= newLengthMm) {
      final.push(opening);
      continue;
    }
    // floor 不是随手写的：轴长是浮点（斜墙 1999.698），round 会舍到墙外去
    const maxDistanceMm = assertMm(
      Math.floor(newLengthMm - opening.widthMm),
      '夹取后的洞口距离',
    );
    if (maxDistanceMm < 0) {
      throw new RangeError(
        `墙 ${wall.id} 缩到 ${Math.round(newLengthMm)}mm，放不下洞口 ${opening.id}` +
          `（宽 ${opening.widthMm}）：请先改小或删掉这个洞口`,
      );
    }
    const clamped: OpeningEntity = { ...opening, distanceMm: maxDistanceMm };
    final.push(clamped);
    dirty.push(clamped);
  }
  if (dirty.length === 0) return;
  // 升序（同距离按 id 升序）由 spansOfOpenings 保证：这张表与 openingSpans 走同一份产地，
  // 喂给 assertSpansFit 的升序前提不在这儿各写一遍。
  const spans = spansOfOpenings(final);
  // 这里不查楼层：洞口不是新数据，只是把真源里已有的东西重述一遍。
  // 跨层洞口的判定仍归 openingSpans，在 deriveStoreyGeometry 里守。
  assertSpansFit(wall.id, newLengthMm, spans);
  upsert.push(...dirty);
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
      // 轴长一律按"补丁应用之后"的两个端点算：这里与 wallAxis 用的是 geom/vec 的同一个出口
      // （length(sub(vec, vec))），所以预测值与派生层事后重算的值逐位相同 —— 由构造保证，
      // 不再靠"Math.hypot 恰好同式"。夹回来的洞口于是差不了 1mm。
      const selfLengthMm = length(sub(vec(x, y), vec(anchor.x, anchor.y)));
      if (wall.thicknessMm >= selfLengthMm) {
        throw new RangeError(
          `移动端点会让墙 ${wall.id} 的墙厚 ${wall.thicknessMm} 不小于轴长 ${Math.round(selfLengthMm)}，轮廓会自相交`,
        );
      }
      // 端点一动，所有共享它的墙轴长都变了。逐面守卫，同时把新轴长记下来给洞口跟随用：
      // affected 只有那一个点，靠它找不到这些墙（Task 9 的扩脏闭包就是为这个存在的）。
      const resized: Array<{ wall: WallEntity; lengthMm: number }> = [
        { wall, lengthMm: selfLengthMm },
      ];
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
        const lengthMm = length(sub(vec(x, y), vec(other.x, other.y)));
        if (neighbour.thicknessMm >= lengthMm) {
          throw new RangeError(
            `移动端点会让墙 ${neighbour.id} 的墙厚 ${neighbour.thicknessMm} 不小于轴长 ${Math.round(lengthMm)}，轮廓会自相交`,
          );
        }
        resized.push({ wall: neighbour, lengthMm });
      }
      // 挂在这个点上的柱会跟着点一起走（D1）。建柱时那条"同层同坐标只准一根柱"的判据必须在
      // 拖动之后再判一次：不然把柱搬到另一根柱的头上，真源里留下一对重影 —— 而
      // deriveStoreyGeometry 不派生柱、SpatialIndex 只装墙与洞口，视图与索引都看不见它。
      // 取 moving.storeyId 而不是 wall.storeyId：被撞的是"这个点所属的层"里的柱。
      assertNoGhostColumn(doc, moving.storeyId, { x, y }, moving.id);
      const upsert: Entity[] = [{ ...moving, x, y }];
      // resized 的顺序确定（本墙在前，邻墙按 byKind 的 id 升序），所以补丁逐字节可重放。
      // 各墙的洞口互不相干，顺序不影响文档：canonical() 按 id 排实体、按键名排序，
      // 顺序只体现在 affected 这个 Set 的迭代序上（Task 9 遍历它重建索引时要能复现）。
      for (const entry of resized) {
        clampOpeningsToWall(doc, entry.wall, entry.lengthMm, upsert);
      }
      return { upsert, remove: [] };
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
