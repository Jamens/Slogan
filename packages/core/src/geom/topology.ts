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

/** 被两面以上墙共享的点（结果按 id 升序）。接头分组不从它出发：deriveJoints 自己按 pointId 建 members 表。 */
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
 *
 * 返回顺序 = 下面各个 for 循环的书写顺序（Set 的插入序），且每一类内部按 id 升序：
 * 点 → 墙 → 柱 → 板；墙 → 洞口；楼层 → 墙 → 洞口 → 柱 → 板。
 * `incidentWallEnds` 与 `sharedPointIds` 已各自写明顺序，这里同样写明：Task 9 的重建闭包
 * 会把它拼进日志，顺序不明就等于日志不可比对（id 升序来自 doc.byKind，不是创建顺序）。
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
    case 'opening':
    case 'column':
    case 'slab':
      // 这三类没有下游依赖者（写成事实，不是穷尽检查；穷尽由下面的 never 汇合点保证）
      break;
    default: {
      const exhaustive: never = entity;
      throw new TypeError(`dependentsOf 未处理的实体类型：${String(exhaustive)}`);
    }
  }
  return [...out];
}

/**
 * 同层同坐标不许立两根柱。判据取**坐标 + 同层**，不取 pointId —— 同一个 (x, y) 给两次
 * 字面坐标会新建出第二个点实体，"id 相等"那条对这种重影全然是瞎的。候选坐标一律是真源里
 * 那对整数毫米（由调用方保证），所以这里是精确相等比较，不引入 epsilon。
 *
 * `exceptPointId` 给"整个点带着它的柱一起搬家"的调用方用（`wallMoveEndpoint`）：骑手柱自己
 * 不算对手。同一点上本来就只准一根柱（建柱时本函数就禁止），所以这句至多排除掉一根。
 * 悬空引用（柱指着不存在的点）是内部不变式被破坏，`requirePoint` 直接抛，不 continue。
 */
export function assertNoGhostColumn(
  doc: Document,
  storeyId: EntityId,
  at: { readonly x: number; readonly y: number },
  exceptPointId?: EntityId,
): void {
  for (const column of doc.byKind('column')) {
    if (column.storeyId !== storeyId) continue;
    if (column.pointId === exceptPointId) continue;
    const owner = requirePoint(doc, column.pointId, '柱落点');
    if (owner.x === at.x && owner.y === at.y) {
      throw new RangeError(
        `该坐标已有柱 ${column.id}（点 ${column.pointId}，落在 (${owner.x}, ${owner.y})）：` +
          `同一层的同一个坐标上不能立两根柱`,
      );
    }
  }
}
