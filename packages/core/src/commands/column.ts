import { uuidv7, type EntityId } from '../ids';
import { assertMm, positiveMm, quantizeMm } from '../units/mm';
import type { Command } from '../model/command';
import type { Document } from '../model/document';
import type { ColumnEntity, Entity, PointEntity } from '../model/entity';
import { mustExist, requireStorey } from '../model/read';
import {
  assertNoGhostColumn,
  isExistingPoint,
  pointStillReferenced,
  resolvePointRef,
  type PointRef,
} from '../geom/topology';

export interface ColumnCreateInput {
  storeyId: EntityId;
  /** 柱心/柱角点：坐标字面量新建点，或复用墙端点（柱落在墙角是常态） */
  at: PointRef;
  widthMm: number;
  depthMm: number;
  /** 省略时取所在楼层层高：S1 的柱一律到顶，短柱属 S3 */
  heightMm?: number;
  loadBearing?: boolean;
  material?: string;
}

/** 与 `commands/opening.ts` 里那份 `requireOpening` 同一口径：读取断言长在用的那个文件里。 */
function requireColumn(doc: Document, id: EntityId): ColumnEntity {
  const entity = mustExist(doc, id, '柱');
  if (entity.kind !== 'column') throw new TypeError(`${id} 不是柱，是 ${entity.kind}`);
  return entity;
}

export function columnCreate(input: ColumnCreateInput): Command {
  const widthMm = positiveMm(assertMm(input.widthMm, '柱截面宽'), '柱截面宽');
  const depthMm = positiveMm(assertMm(input.depthMm, '柱截面深'), '柱截面深');
  const heightMm =
    input.heightMm === undefined ? null : positiveMm(assertMm(input.heightMm, '柱高'), '柱高');
  // 坐标走 quantizeMm（与 wallCreate 同一口径），构造期就能判的都在这里判完
  const at = input.at;
  if (!isExistingPoint(at)) {
    quantizeMm(at.x);
    quantizeMm(at.y);
  }
  return {
    type: 'column.create',
    build(doc: Document) {
      const storey = requireStorey(doc, input.storeyId);
      const existing = resolvePointRef(doc, at, input.storeyId);
      const pointId = existing?.id ?? uuidv7();
      const upsert: Entity[] = [];
      let landing: PointEntity;
      // 建不建新点看**入参形态**而不是 existing === null：两者等价（resolvePointRef 只对坐标
      // 字面量返回 null），但这个写法让 TS 把 at 收窄成 {x, y}，免掉一条修道路断言。
      // 复用那一支的 `!` 是同一条推理的另一半（这里 existing 必然非空），与 slab.ts 里
      // resolvePointRef(...)! 是同一个例外，不是兜底。
      if (isExistingPoint(at)) {
        landing = existing!;
      } else {
        landing = {
          kind: 'point',
          id: pointId,
          storeyId: input.storeyId,
          x: quantizeMm(at.x),
          y: quantizeMm(at.y),
        };
        upsert.push(landing);
      }
      // 一根柱占一个坐标：判据住在 geom/topology.ts 的 assertNoGhostColumn —— 建柱与
      // 拖动共享端点（柱跟着点走）吃同一份算式，两处不许各写一遍。
      assertNoGhostColumn(doc, input.storeyId, landing);
      const column: ColumnEntity = {
        kind: 'column',
        id: uuidv7(),
        storeyId: input.storeyId,
        pointId,
        widthMm,
        depthMm,
        // 默认到层高：柱是竖向承重构件，"柱高 = 这一层多高"是唯一不用问用户的默认
        heightMm: heightMm ?? storey.heightMm,
        loadBearing: input.loadBearing ?? true,
        material: input.material ?? 'concrete',
      };
      upsert.push(column);
      return { upsert, remove: [] };
    },
  };
}

/**
 * 删一根柱，并把它**独占**的那枚落点一起带走（孤儿判定问 `pointStillReferenced`，
 * 与 `wallDelete` 同一份产地：柱落点常常就是墙端点，不查就是删柱拆墙）。
 * 不跑派生复核：柱不在 `deriveStoreyGeometry` 的表里（那张表只读墙），而且删除路径
 * 一律不许被守卫挡住（见 `storeyDelete` 的 ② 与 `commands/opening.ts` 顶部那句）。
 */
export function columnDelete(input: { columnId: EntityId }): Command {
  return {
    type: 'column.delete',
    build(doc: Document) {
      const column = requireColumn(doc, input.columnId);
      const remove: EntityId[] = [column.id];
      const except = new Set<EntityId>([column.id]);
      if (!pointStillReferenced(doc, column.pointId, except)) remove.push(column.pointId);
      return { upsert: [], remove };
    },
  };
}
