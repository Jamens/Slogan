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
