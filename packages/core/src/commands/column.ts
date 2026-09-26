import { uuidv7, type EntityId } from '../ids';
import { assertMm, quantizeMm, type Mm } from '../units/mm';
import type { Command } from '../model/command';
import type { Document } from '../model/document';
import type { ColumnEntity, Entity, PointEntity } from '../model/entity';
import { requireStorey } from '../model/read';
import { isExistingPoint, resolvePointRef, type PointRef } from '../geom/topology';

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

function positiveMm(value: Mm, label: string): Mm {
  if (value <= 0) throw new RangeError(`${label}必须为正，收到 ${value}`);
  return value;
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
      // 一根柱占一个点：同点两柱在图纸上是重影，在 3D 里是 z-fighting，在算量里是双份混凝土。
      for (const column of doc.byKind('column')) {
        if (column.pointId === pointId) {
          throw new RangeError(`该点已有柱 ${column.id}（点 ${pointId}）：一个点上不能立两根柱`);
        }
      }
      const upsert: Entity[] = [];
      // 建不建新点看**入参形态**而不是 existing === null：两者等价（resolvePointRef 只对坐标
      // 字面量返回 null），但这个写法让 TS 把 at 收窄成 {x, y}，免掉一条修道路断言
      if (!isExistingPoint(at)) {
        const created: PointEntity = {
          kind: 'point',
          id: pointId,
          storeyId: input.storeyId,
          x: quantizeMm(at.x),
          y: quantizeMm(at.y),
        };
        upsert.push(created);
      }
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
