import type { EntityId } from '../ids';
import type { Document } from '../model/document';
import type { PointEntity } from '../model/entity';
import { mustExist, requirePoint } from '../model/read';
// 只引类型：otherEnd / endPointId 本文件用不上（incidentWallEnds 直接给 end），
// 留着会撞 noUnusedLocals。Task 4 拿 {wallId, end} 找回共享点时用的是 axis 那两个导出。
import type { WallEnd } from './axis';

/**
 * 命令入参的端点：给坐标就新建点，给 pointId 就复用既有点。
 * 拓扑闭合（接头、整层连通性）全靠后者 —— 真源里存"两个坐标相同的点"永远合不上。
 */
export type PointRef =
  | { readonly x: number; readonly y: number }
  | { readonly pointId: EntityId };

/**
 * 判据是 pointId 而非 'x' in ref：TS 的 `in` 收窄要求两者互斥，
 * 而调用方传多余字段（{x, y, pointId}）时"以 pointId 为准"是本函数定的规矩。
 */
export function isExistingPoint(ref: PointRef): ref is { readonly pointId: EntityId } {
  return 'pointId' in ref;
}

export interface WallEndRef {
  readonly wallId: EntityId;
  readonly end: WallEnd;
}

/**
 * ref 落到文档里的点。字面坐标返回 null（点还不存在，由命令层新建）。
 * 复用即跨层检查：点必须存在、必须是 point、必须属于这个构件的楼层。
 * 少这一条，拖楼层 1 的拐角会改掉楼层 2 的墙 —— 两层的墙网凭空焊死。
 * 第三个参数一律取"新构件所在层"：Task 8 的柱与板传自己的 storeyId，共用这一份判据。
 */
export function resolvePointRef(
  doc: Document,
  ref: PointRef,
  storeyId: EntityId,
): PointEntity | null {
  if (!isExistingPoint(ref)) return null;
  const point = requirePoint(doc, ref.pointId, '端点');
  if (point.storeyId !== storeyId) {
    throw new TypeError(
      `端点 ${point.id} 属于楼层 ${point.storeyId}，不能给楼层 ${storeyId} 复用`,
    );
  }
  return point;
}

/** 指着这个点的墙端（byKind 已按 id 升序，故结果确定）。excludeWallId 用于"除我之外还有谁"。 */
export function incidentWallEnds(
  doc: Document,
  pointId: EntityId,
  excludeWallId?: EntityId,
): WallEndRef[] {
  const out: WallEndRef[] = [];
  for (const wall of doc.byKind('wall')) {
    if (wall.id === excludeWallId) continue;
    // 两个 if 不写 else：一堵墙理论上不可能两端同点（零长墙在命令层就被拒），
    // 但真源不校验引用完整性，写出这种墙时这里必须两条都报，而不是静默漏一条。
    if (wall.startId === pointId) out.push({ wallId: wall.id, end: 'start' });
    if (wall.endId === pointId) out.push({ wallId: wall.id, end: 'end' });
  }
  return out;
}

/** 被两面以上墙共享的点。Task 4 的接头分组从它出发。 */
export function sharedPointIds(doc: Document): EntityId[] {
  const count = new Map<EntityId, number>();
  for (const wall of doc.byKind('wall')) {
    for (const id of [wall.startId, wall.endId]) {
      count.set(id, (count.get(id) ?? 0) + 1);
    }
  }
  return [...count]
    .filter(([, n]) => n >= 2)
    .map(([id]) => id)
    .sort();
}

/**
 * 反向依赖**一层**：这个实体被谁直接引用。
 * 闭包（迭代到不动点）是调用方的事 —— Task 9 的局部重建要的是"点脏 → 墙脏 → 墙上洞口也脏"，
 * 在这一层里塞递归会让本函数没法单测。
 * 计划 1 的 `wallDelete.stillReferenced` 是它的特例（"还有没有人引用，有则不许删点"）。
 */
export function dependentsOf(doc: Document, id: EntityId): EntityId[] {
  const entity = mustExist(doc, id, '实体');
  const out = new Set<EntityId>();
  switch (entity.kind) {
    case 'point':
      for (const wall of doc.byKind('wall')) {
        if (wall.startId === id || wall.endId === id) out.add(wall.id);
      }
      for (const column of doc.byKind('column')) {
        if (column.pointId === id) out.add(column.id);
      }
      for (const slab of doc.byKind('slab')) {
        if (slab.boundaryPointIds.includes(id)) out.add(slab.id);
      }
      break;
    case 'wall':
      for (const opening of doc.byKind('opening')) {
        if (opening.hostWallId === id) out.add(opening.id);
      }
      break;
    case 'storey':
      // 楼层的下游是该层全部构件：Task 8 改标高时要一起重算，漏一类就是漏算下游
      for (const wall of doc.byKind('wall')) if (wall.storeyId === id) out.add(wall.id);
      for (const opening of doc.byKind('opening')) if (opening.storeyId === id) out.add(opening.id);
      for (const column of doc.byKind('column')) if (column.storeyId === id) out.add(column.id);
      for (const slab of doc.byKind('slab')) if (slab.storeyId === id) out.add(slab.id);
      break;
    default:
      // opening / column / slab 没有下游依赖者
      break;
  }
  return [...out];
}
