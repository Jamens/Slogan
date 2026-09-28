import { uuidv7, type EntityId } from '../ids';
import { assertMm, positiveMm, quantizeMm } from '../units/mm';
import type { Command } from '../model/command';
import type { Document } from '../model/document';
import type { ColumnEntity, Entity, PointEntity } from '../model/entity';
import { requireStorey } from '../model/read';
import {
  assertNoGhostColumn,
  isExistingPoint,
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
