import {
  aabbOfPoints,
  advance,
  deriveStoreyGeometry,
  requireStorey,
  spansOfOpenings,
  vec,
  wallAxisById,
  type Document,
  type OpeningSpan,
  type WallAxis,
} from '@dajia/core';
import {
  fitViewport,
  mmToPx,
  viewportOf,
  type Px,
  type Viewport,
} from './viewport';

export type DrawLayer = 'structure' | 'opening' | 'annotation';

/**
 * 绘制顺序 = 指令数组的顺序 = 层序。数组下标越大越靠上（后画的盖住先画的），
 * 命中测试的取舍按它排（见 pick.ts 的 R3）—— 所以它是层序的唯一真源，
 * 不是给人看的注释：加一层必须同时改 buildDrawList 的产出顺序，否则层序压倒距离就是空话。
 */
export const DRAW_LAYERS: readonly DrawLayer[] = ['structure', 'opening', 'annotation'];

export type LineType = 'solid' | 'dashed' | 'dash-dot';

export interface Pen {
  readonly layer: DrawLayer;
  readonly lineType: LineType;
  readonly widthPx: number;
  readonly color: string;
}

/**
 * 一条指令 = 一个画法 + 它的来源实体。ownerId 是 T4 命中测试唯一的桥：
 * 屏幕点 → 指令 → 实体 id。派生出、不对应单一实体的指令写 null，别写假 id。
 */
export type DrawOp =
  | {
      readonly kind: 'polygon';
      readonly ownerId: string | null;
      readonly pts: readonly Px[];
      readonly fill: string | null;
      readonly pen: Pen;
    }
  | { readonly kind: 'line'; readonly ownerId: string | null; readonly from: Px; readonly to: Px; readonly pen: Pen }
  | {
      readonly kind: 'text';
      readonly ownerId: string | null;
      readonly at: Px;
      readonly text: string;
      readonly sizePx: number;
      readonly pen: Pen;
    };

export interface Selection {
  readonly ids: ReadonlySet<string>;
}

export const EMPTY_SELECTION: Selection = { ids: new Set<string>() };

export const INK = '#1f1f1f';
const GLAZING = '#2f6fb3';
export const SELECTED = '#c9252d';

const WALL_PEN: Pen = { layer: 'structure', lineType: 'solid', widthPx: 2, color: INK };
const AXIS_PEN: Pen = { layer: 'structure', lineType: 'dash-dot', widthPx: 1, color: INK };
const JAMB_PEN: Pen = { layer: 'opening', lineType: 'solid', widthPx: 1.5, color: INK };
const GLAZING_PEN: Pen = { layer: 'opening', lineType: 'dashed', widthPx: 1, color: GLAZING };
const LABEL_PEN: Pen = { layer: 'annotation', lineType: 'solid', widthPx: 1, color: INK };

const LABEL_OFFSET_MM = 300;
const LABEL_SIZE_PX = 14;

/** 同一面墙的轴线可能被轮廓段与洞口各要一次；wallAxisById 里有开根号，缓存掉。 */
function axisOf(cache: Map<string, WallAxis>, doc: Document, wallId: string): WallAxis {
  const hit = cache.get(wallId);
  if (hit !== undefined) return hit;
  const axis = wallAxisById(doc, wallId);
  cache.set(wallId, axis);
  return axis;
}

/** 沿轴 mm → 世界点。dir 是单位向量，所以 advance 的第三个参数直接是沿轴距。 */
function alongAxis(axis: WallAxis, mm: number) {
  return advance(axis.start, axis.dir, mm);
}

export function buildDrawList(
  doc: Document,
  storeyId: string,
  v: Viewport,
  sel: Selection = EMPTY_SELECTION,
): DrawOp[] {
  const geo = deriveStoreyGeometry(doc, storeyId);
  // 短路必须在包围盒之前：aabbOfPoints 在零点上抛 RangeError，
  // 而"空层没有任何指令"是本层唯一的真话 —— 标签也没有，因为没有可标注的东西。
  if (geo.walls.length === 0) return [];

  const axes = new Map<string, WallAxis>();
  const ops: DrawOp[] = [];
  const penFor = (ownerId: string, base: Pen): Pen =>
    sel.ids.has(ownerId) ? { ...base, color: SELECTED } : base;

  // ① structure：墙轮廓。角点一律来自派生 —— 这里再算一份就是第二份几何。
  for (const quad of geo.walls) {
    ops.push({
      kind: 'polygon',
      ownerId: quad.wallId,
      pts: quad.corners.map((c) => mmToPx(v, c)),
      fill: null,
      pen: penFor(quad.wallId, WALL_PEN),
    });
  }

  // ② structure：轴线按墙垛分段。geo.pieces 已经是"被洞口打断的沿轴区间"，
  //    照它出图，洞口处自然断开 —— 连墙带轴一起画是错的，那是把洞抹掉了。
  for (const piece of geo.pieces) {
    const axis = axisOf(axes, doc, piece.wallId);
    ops.push({
      kind: 'line',
      ownerId: piece.wallId,
      from: mmToPx(v, alongAxis(axis, piece.fromMm)),
      to: mmToPx(v, alongAxis(axis, piece.toMm)),
      pen: penFor(piece.wallId, AXIS_PEN),
    });
  }

  // 洞口的沿轴区间只有一个产地：core 的 `spansOfOpenings`（计划 2 终审 I-3 合并出来的出口，
  // 命令层的夹取复核与墙垛分段吃的是同一份算式）。这里再写一遍 `distanceMm + widthMm`
  // 就是第三份投影，漂一次的后果是"图上的洞口与墙垛对不上"。
  const spanById = new Map<string, OpeningSpan>();
  for (const span of spansOfOpenings(
    doc.byKind('opening').filter((o) => o.storeyId === storeyId),
  )) {
    spanById.set(span.openingId, span);
  }

  // ③ opening：每樘洞口两条断口线（横穿墙厚），窗再补一条沿轴中线。
  for (const opening of doc.byKind('opening')) {
    if (opening.storeyId !== storeyId) continue;
    const axis = axisOf(axes, doc, opening.hostWallId);
    const half = axis.thicknessMm / 2;
    // 查不空：spanById 的过滤条件与上面的 continue 逐字相同。留着这句是让类型收窄成立
    // （同 commands/wall.ts 的 resolveEnd 那条不可达抛错的规矩），不是给 UI 准备的错误分支。
    const span = spanById.get(opening.id);
    if (span === undefined) throw new TypeError(`洞口 ${opening.id} 没有沿轴区间（内部错误）`);
    const near = alongAxis(axis, span.fromMm);
    const far = alongAxis(axis, span.toMm);
    for (const jamb of [near, far]) {
      ops.push({
        kind: 'line',
        ownerId: opening.id,
        from: mmToPx(v, advance(jamb, axis.normal, -half)),
        to: mmToPx(v, advance(jamb, axis.normal, half)),
        pen: penFor(opening.id, JAMB_PEN),
      });
    }
    if (opening.category === 'window') {
      ops.push({
        kind: 'line',
        ownerId: opening.id,
        from: mmToPx(v, near),
        to: mmToPx(v, far),
        pen: penFor(opening.id, GLAZING_PEN),
      });
    }
  }

  // ④ annotation：楼层标签写在包围盒左上外侧，永远排最后（它必须盖住墙）。
  const storey = requireStorey(doc, storeyId);
  const box = aabbOfPoints(geo.walls.flatMap((q) => [...q.corners]));
  ops.push({
    kind: 'text',
    ownerId: storeyId,
    at: mmToPx(v, vec(box.minX, box.maxY + LABEL_OFFSET_MM)),
    text: `楼层 ${storey.index} · 标高 ${(storey.elevationMm / 1000).toFixed(3)}`,
    sizePx: LABEL_SIZE_PX,
    pen: penFor(storeyId, LABEL_PEN),
  });

  return ops;
}

/**
 * 该层在当前画布尺寸下的初始视口。放在 scene-2d 是因为它要读派生几何，
 * 而 renderer 一条几何都不许算。空层返回默认视口：打开一个还没画墙的层是正常状态。
 */
export function fitStorey(
  doc: Document,
  storeyId: string,
  widthPx: number,
  heightPx: number,
  padPx: number = 40,
): Viewport {
  const geo = deriveStoreyGeometry(doc, storeyId);
  if (geo.walls.length === 0) return viewportOf(widthPx, heightPx);
  return fitViewport(
    widthPx,
    heightPx,
    aabbOfPoints(geo.walls.flatMap((q) => [...q.corners])),
    padPx,
  );
}
