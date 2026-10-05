import {
  Document,
  deriveStoreyGeometry,
  wallAxis,
  type ColumnEntity,
  type EntityId,
  type SlabEntity,
  type Vec2,
} from '@dajia/core';
import { polygon, text, type PaperOp, type PaperVec2, type Sheet } from './ir';
import { PEN_BY_LINE_TYPE } from './linetypes';
import { mmToPaperMm, type PaperMm } from './units';

/**
 * 平面图内容：一层的墙 / 洞口 / 柱 / 板 → 图面 IR。
 *
 * ## 本模块最重要的一条：它不重算任何几何
 *
 * - 墙的轮廓来自 `deriveStoreyGeometry(doc, storeyId).walls[].corners`（四边四角）
 * - 墙身被洞口切成的分段来自同一份返回值的 `pieces`
 *   （`WallPiece { wallId, fromMm, toMm }`，core 的 `piecesFromSpans` 已算好）
 * - 板的多边形直接读 `SlabEntity.boundaryPointIds` 逐个取点
 *
 * **本模块一个几何数都不自己算**，它只做"沿轴按 mm 区间取点、再乘比例"
 * 这一件机械活。
 *
 * 为什么这条这么重要：墙的轮廓在计划 2 那个世界里已经被四道守卫验过
 * （斜切、接头、同射线、零长）。drawing 侧重算一遍 ⇒ 出现第二份
 * "墙画出来该是什么形状"的真源，而它漂的时候**图只是慢慢变得不对**，
 * 一句错都不抛。P1 与 P3 两格判据钉的就是这件事。
 */

export interface PlanOptions {
  /** 画哪一层。 */
  readonly storeyId: EntityId;
  /** 标题栏那几格的字段（T6 的 `frame.ts` 会消费；本模块只把楼层标高写进 annotation）。 */
  readonly title: string;
  readonly drafter: string;
  readonly sheetNo: string;
}

/** 纸面幅面（mm）。T6 的 `frame.ts` 会把它变成参数与图框；这里先给A3 横式。 */
const SHEET_MM = { width: 420, height: 297 } as const;

/**
 * 一层墙身的实心段 —— **直接转发 core 的派生产物**。
 *
 * 洞口越界由 core 的 `assertSpansFit`（经 `piecesFromSpans`）在同一路径上抛，
 * drawing 侧**不重算一遍**（plan5 §四 P5）。零长段 core 也不产，本函数照原样透出。
 */
export function wallPiecesOf(
  doc: Document,
  storeyId: EntityId,
  wallId: EntityId,
): readonly { readonly wallId: EntityId; readonly fromMm: number; readonly toMm: number }[] {
  return deriveStoreyGeometry(doc, storeyId).pieces.filter((p) => p.wallId === wallId);
}

/** 模型点 → 纸面点。**y 取反**（模型 y 向上，纸面 y 向下 —— `units.ts` U2）。 */
function toPaper(x: number, y: number): PaperVec2 {
  return { x: mmToPaperMm(x), y: mmToPaperMm(-y) };
}

/** 取一个点的模型坐标。`Document.get` 给的是 union，所以这里收窄一次。 */
function pointOf(doc: Document, id: EntityId): Vec2 {
  const e = doc.get(id);
  if (!e) throw new RangeError(`点 ${id} 不存在：图纸侧要画它而模型里没有`);
  if (e.kind !== 'point') throw new TypeError(`实体 ${id} 是 ${e.kind}，不是点`);
  return { x: e.x, y: e.y };
}

/**
 * 墙身的一个实心段 → 一个纸面四边形。
 *
 * 横向边界取 `wallAxis` 的 `normal × thicknessMm/2`（core 的斜切量在
 * `pieces` 的 from/to 里已经算不到了 —— 斜切动的是横向，所以这里用 core
 * 的 `WallQuad.corners` 做横向端点才是准的；见 `planSheet` 里的注释）。
 */
function pieceQuad(
  doc: Document,
  wallId: EntityId,
  fromMm: number,
  toMm: number,
): PaperVec2[] {
  const wall = doc.get(wallId);
  if (!wall) throw new RangeError(`墙 ${wallId} 不存在：墙身分段要求它存在`);
  if (wall.kind !== 'wall') throw new TypeError(`实体 ${wallId} 是 ${wall.kind}，不是墙`);
  const axis = wallAxis(doc, wall);
  const half = axis.thicknessMm / 2;
  // 沿轴的两个位置，各向两侧偏半厚。`normal` 是逆时针 90°，指向墙的左侧 ——
  // 两个符号都画出来，所以"哪一侧是左"不影响结果。
  const at = (along: number, across: number): PaperVec2 =>
    toPaper(
      axis.start.x + axis.dir.x * along + axis.normal.x * across,
      axis.start.y + axis.dir.y * along + axis.normal.y * across,
    );
  return [at(fromMm, half), at(toMm, half), at(toMm, -half), at(fromMm, -half)];
}

/** 柱的平面轮廓：一个**矩形**（`widthMm` × `depthMm`，各向异性，不是正方形）。 */
function columnQuad(doc: Document, column: ColumnEntity): PaperVec2[] {
  const c = pointOf(doc, column.pointId);
  const hw = column.widthMm / 2;
  const hd = column.depthMm / 2;
  return [
    toPaper(c.x - hw, c.y - hd),
    toPaper(c.x + hw, c.y - hd),
    toPaper(c.x + hw, c.y + hd),
    toPaper(c.x - hw, c.y + hd),
  ];
}

/** 板的外轮廓（纸面多边形，逐个读 `boundaryPointIds`）。 */
function slabPolygon(doc: Document, slab: SlabEntity): PaperVec2[] {
  // 边界点少于三个就不成多边形 —— 那是 core 的不变式，此处只是不画。
  if (slab.boundaryPointIds.length < 3) return [];
  return slab.boundaryPointIds.map((id) => {
    const p = pointOf(doc, id);
    return toPaper(p.x, p.y);
  });
}

/**
 * 一层 → 一张图。
 *
 * 图元顺序即绘制顺序（plan5 §三 的 `PAPER_LAYERS`）：`structure` 在前，
 * `annotation` 在后。**这是 P7 那格的对账对象** —— 层号不许往回走。
 *
 * **P2 的形状说明（洞口是留白，不是画一个洞的轮廓线）**：墙身按 core 的 `pieces`
 * 逐段各产一个多边形，洞口那一段**天然不在pieces 里** ⇒ 图上那里什么都没有。
 * 若反过来"先画整面墙、再画一个洞的边框"，就得多一份"洞的边界该在哪"的算术，
 * 而它漂的时候图上只是多了一道不该有的线。
 */
export function planSheet(doc: Document, opts: PlanOptions): Sheet {
  const geom = deriveStoreyGeometry(doc, opts.storeyId);
  const ops: PaperOp[] = [];

  // ① 墙：按 core 的 pieces 逐段产多边形。
  for (const piece of geom.pieces) {
    ops.push(polygon(pieceQuad(doc, piece.wallId, piece.fromMm, piece.toMm), PEN_BY_LINE_TYPE.solid, false));
  }

  // ② 柱与板（S1 有实体但无 UI，图上要画出来）。同在 `structure` 层（P6）。
  for (const column of doc.byKind('column')) {
    if (column.storeyId !== opts.storeyId) continue;
    ops.push(polygon(columnQuad(doc, column), PEN_BY_LINE_TYPE.solid, false));
  }
  for (const slab of doc.byKind('slab')) {
    if (slab.storeyId !== opts.storeyId) continue;
    // 板在平面图里是**轮廓线**（不是填充）—— S1 不做材质（D3 那条同源口径）。
    const outline = slabPolygon(doc, slab);
    if (outline.length >= 3) ops.push(polygon(outline, PEN_BY_LINE_TYPE.dashed, false));
  }

  // ③ annotation：楼层标高。**取 `StoreyEntity.elevationMm`**（P8）——
  // 它就是模型的层高，不是任何"真源的派生"。
  const storey = doc.get(opts.storeyId);
  if (storey && storey.kind === 'storey') {
    const elevMm: PaperMm = mmToPaperMm(storey.elevationMm);
    ops.push(
      text(
        { x: 0, y: 0 },
        2.5,
        `${opts.title}  标高 ±${elevMm.toFixed(2)}`,
        { ...PEN_BY_LINE_TYPE.solid, layer: 'annotation' },
      ),
    );
  }

  return { widthMm: SHEET_MM.width, heightMm: SHEET_MM.height, ops };
}
