import { uuidv7, type EntityId } from '../ids';
import { assertMm, quantizeMm, type Mm } from '../units/mm';
import type { Command } from '../model/command';
import type { Document } from '../model/document';
import type { ColumnEntity, Entity, PointEntity } from '../model/entity';
import { requirePoint, requireStorey } from '../model/read';
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
      // 一根柱占一个坐标：同坐标两柱在图纸上是重影，在 3D 里是 z-fighting，在算量里是双份混凝土。
      // 判据取**坐标 + 同层**，不取 pointId —— 同一个 (x, y) 给两次字面坐标就会新建出第二个点
      // 实体，id 相等那条对这种重影全然是瞎的（板侧 geom/ring.ts 按坐标查重，柱侧按 id 查，
      // 一起提交的两个文件自相矛盾）。候选坐标直接取 landing.x/y，也就是真源里那对整数毫米，
      // 判据与真源不许有两套口径。
      // 限定同层是给计划 3 的柱网留的：柱网逐层复用同一平面坐标，不限定就会把
      // "二层同一根轴线上的柱"判成重影。层内柱指着的东西必须是真实存在的点，
      // 所以拿 requirePoint 断言（悬空引用是内部不变式被破坏，抛，不 continue）。
      for (const column of doc.byKind('column')) {
        if (column.storeyId !== input.storeyId) continue;
        const owner = requirePoint(doc, column.pointId, '柱落点');
        if (owner.x === landing.x && owner.y === landing.y) {
          // 两边都是整数毫米 → 精确相等比较，不引入 epsilon
          throw new RangeError(
            `该坐标已有柱 ${column.id}（点 ${column.pointId}，落在 (${owner.x}, ${owner.y})）：` +
              `同一层的同一个坐标上不能立两根柱`,
          );
        }
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
