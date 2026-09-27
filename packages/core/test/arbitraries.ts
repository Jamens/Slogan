import fc from 'fast-check';

/** 坐标：整数毫米，范围取真实建房量级 */
export const arbMm = fc.integer({ min: -20_000, max: 20_000 });
/**
 * 非整数坐标：模拟 UI/吸附前落到命令层的值。用整数除以 10 造，不用 fc.double，
 * 后者会产极小/极大与各种特殊浮点，把"没量化就进真源"这条路淹在噪声里。
 */
export const arbFractionalMm = fc.integer({ min: -200_000, max: 200_000 }).map((n) => n / 10);
export const arbThickness = fc.integer({ min: 50, max: 500 });
export const arbHeight = fc.integer({ min: 1000, max: 6000 });
export const arbWallLength = fc.integer({ min: 2000, max: 12_000 });
export const arbWallAngle = fc.integer({ min: -179, max: 179 });

/**
 * 墙的形状，刻意不用 filter：
 * - 墙长下界 2000 > 墙厚上界 500，"墙厚 ≥ 墙长"的非法输入生成不出来；
 * - 墙长 ≥ 2000 使量化后两端点必不重合，零长墙也生成不出来。
 * 生成器自己就不产非法值，比 filter 掉非法值强：不减速、不触发 no-allocation 告警，
 * 也不会让人误以为"非法值测过了"。
 *
 * 起点取非整数值：命令层负责量化，这样不变式 4 才真的在考"有没有旁路把浮点送进真源"。
 */
export const arbWallShape = fc
  .tuple(arbFractionalMm, arbFractionalMm, arbWallLength, arbWallAngle, arbThickness, arbHeight)
  .map(([x, y, len, angleDeg, thicknessMm, heightMm]) => {
    const rad = (angleDeg * Math.PI) / 180;
    return {
      start: { x, y },
      end: {
        x: x + Math.round(len * Math.cos(rad)),
        y: y + Math.round(len * Math.sin(rad)),
      },
      thicknessMm,
      heightMm,
    };
  });

// ---------- 计划 2 · Task 10：墙链、洞口尺寸、操作序列 ----------

/** 折线顶点。整数毫米，但本文件不调 `quantizeMm`：这里的数天生就是整数。 */
export interface ChainPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * 一条开放墙链：points.length = walls.length + 1。
 * `forward` 是这份生成器存在的理由：true 表示这一段按折线正方向画（start = 前一个点），
 * false 表示反着画。相邻两段的 forward 相同 ⇒ 共享点是 (end, start) 混合角；
 * 不同 ⇒ 是 (start, start) 或 (end, end) 同向角 —— 只有同向角才会露出边线配对的破绽
 * （Task 4 的 `innerSide` 就是为它加的）。随机布尔保证两种角都会大量出现。
 */
export interface ChainShape {
  readonly points: readonly ChainPoint[];
  readonly walls: ReadonlyArray<{ readonly thicknessMm: number; readonly forward: boolean }>;
}

const arbChainSegment = fc
  .record({
    turn: fc.integer({ min: 30, max: 150 }),
    side: fc.constantFrom(1, -1),
    lengthMm: fc.integer({ min: 4000, max: 12000 }),
    thicknessMm: fc.integer({ min: 100, max: 400 }),
    forward: fc.boolean(),
  })
  .map(({ turn, side, lengthMm, thicknessMm, forward }) => ({
    turnDeg: side * turn,
    lengthMm,
    thicknessMm,
    forward,
  }));

/**
 * 折线靠"每段相对上一段转 ±[30°,150°]"来保证合法，不用 filter（关键判断 2）。
 * 顶点坐标是取整后的整数：真实轴长与转角跟名义值差不到 0.71mm / 0.02°，
 * 所以测试侧的界一律留了余量（轴长 3900、sinθ 0.49），见 geometry-properties.test.ts 顶部。
 * 链**允许**自交（不相邻的两段在平面上压过去）：接头只由共享 pointId 决定，自交不产生
 * 新接头，也不影响"Σ 面积 = Σ 轴长 × 墙厚"—— 那条是逐墙恒等式，不是并集面积。
 */
export const arbChainShape: fc.Arbitrary<ChainShape> = fc
  .record({
    x: fc.integer({ min: -20_000, max: 20_000 }),
    y: fc.integer({ min: -20_000, max: 20_000 }),
    headingDeg: fc.integer({ min: 0, max: 359 }),
    segments: fc.array(arbChainSegment, { minLength: 2, maxLength: 5 }),
  })
  .map(({ x, y, headingDeg, segments }) => {
    const points: ChainPoint[] = [{ x, y }];
    let heading = (headingDeg * Math.PI) / 180;
    for (const segment of segments) {
      const prev = points[points.length - 1]!;
      heading += (segment.turnDeg * Math.PI) / 180;
      points.push({
        x: Math.round(prev.x + segment.lengthMm * Math.cos(heading)),
        y: Math.round(prev.y + segment.lengthMm * Math.sin(heading)),
      });
    }
    return {
      points,
      walls: segments.map((s) => ({ thicknessMm: s.thicknessMm, forward: s.forward })),
    };
  });

/**
 * 洞口尺寸。`distancePercent` 不是"距起点百分之几"，而是 `legalDistanceMm` 的分子：
 * `d = floor((轴长 − 宽) × pct / 100)`，所以 `to = d + w ≤ 0.95 × 轴长 + 0.05 × 宽 < 轴长`
 * （最后一步要 `w < L`，由轴长下界 3900 > 宽上界 1200 白送）。
 * 上界取 95 而不是 40 的理由在 Step 3 的测试 9：夹取那条要有红得起来的可能。
 */
export interface OpeningShape {
  readonly widthMm: number;
  readonly heightMm: number;
  readonly distancePercent: number;
  readonly category: 'door' | 'window';
}

export const arbOpeningShape: fc.Arbitrary<OpeningShape> = fc.record({
  widthMm: fc.integer({ min: 700, max: 1200 }),
  // 窗台默认 900（openingCreate 给），所以 900 + 2100 = 3000 正好顶到墙高上界
  heightMm: fc.constantFrom(1000, 1200, 1500, 1800, 2100),
  distancePercent: fc.integer({ min: 0, max: 95 }),
  category: fc.constantFrom('door' as const, 'window' as const),
});

/**
 * 一步随机操作。`index` 是一个共享的"挑哪一个"槽位（运行时对当前存活集合取模）：
 * 取模会让操作分布不均匀，但它是**选择**不是**被测值**，被测值（坐标、尺寸）都来自主档。
 * 六种操作各管一段责任：
 * - opening / moveOpening / deleteOpening：洞口三式，配合"一墙至多一樘"（非目标 2）
 * - movePoint：拖共享端点，两墙跟随，会触发 Task 7 的洞口夹取
 * - thickness：改墙厚。异厚角是 `innerSide` 与闭式解最吃紧的地方
 * - deleteWall：删一面墙，接头降级 —— Task 9 双向闭包的那条漏网边
 */
export type ChainOp = OpeningShape & {
  readonly kind: 'opening' | 'moveOpening' | 'deleteOpening' | 'movePoint' | 'thickness' | 'deleteWall';
  readonly index: number;
  readonly dx: number;
  readonly dy: number;
};

export const arbChainOp: fc.Arbitrary<ChainOp> = fc
  .tuple(
    arbOpeningShape,
    fc.record({
      kind: fc.constantFrom(
        'opening' as const,
        'moveOpening' as const,
        'deleteOpening' as const,
        'movePoint' as const,
        'thickness' as const,
        'deleteWall' as const,
      ),
      index: fc.integer({ min: 0, max: 9 }),
      // 600mm 的拖动量对 4000mm 以上的段最多改 8.5° 方向角：单步很少越界，
      // 但连续多步会累积，所以 movePoint 仍要过关键判断 3 的试法。
      dx: fc.integer({ min: -600, max: 600 }),
      dy: fc.integer({ min: -600, max: 600 }),
    }),
  )
  .map(([opening, op]) => ({ ...opening, ...op }));

/**
 * 6..18 步。为什么不是 30 步：spec 11.2 那"连续撤销 30 步"是**定值**要求，
 * 由 Step 5 的两层房逐条数出来（2 楼层 + 16 墙 + 8 洞口 + 4 编辑 = 30）。
 * 这里的序列只管长度覆盖：随机撤销重放一步的成本是整层派生 + 索引三件套，
 * 18 步 × 80 次运行已经把每个中间态都翻了两遍，再长只是让 CI 变慢。
 */
export const arbChainOps = fc.array(arbChainOp, { minLength: 6, maxLength: 18 });
