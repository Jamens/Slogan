/** 真源唯一的长度类型：整数毫米（spec D8）。 */
export type Mm = number;

export const MM_PER_M = 1000;

/**
 * 把任意浮点构造结果落到整数毫米。唯一允许写回真源的入口。
 * 用 Math.round：0.5 向正无穷侧舍入，-0.5 → -0，再 +0 归一为 +0。
 * 归一是必须的：-0 与 0 在 `Object.is`/vitest 断言下不等，而 JSON.stringify(-0)
 * 是 "0"，所以它在字节比对里完全隐身，只会在内存中的不变式检查上炸。
 */
export function quantizeMm(value: number): Mm {
  if (!Number.isFinite(value)) {
    throw new RangeError(`quantizeMm 需要有限数，收到 ${value}`);
  }
  return Math.round(value) + 0;
}

/** 断言已经是整数毫米，用于所有命令构造器的入参校验。 */
export function assertMm(value: number, label: string): Mm {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} 必须是整数毫米，收到 ${value}：浮点坐标须先过 quantizeMm`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} 超出安全整数范围：${value}`);
  }
  // 校验放行 -0（Number.isInteger(-0) 为 true），但真源里不接受带符号的零。
  return value === 0 ? 0 : value;
}

/** 已过 assertMm 的量再守正负：0 与负数在真源里都不成立。label 自带冒号位（`${label}必须为正`）。 */
export function positiveMm(value: Mm, label: string): Mm {
  if (value <= 0) throw new RangeError(`${label}必须为正，收到 ${value}`);
  return value;
}

/** 仅用于 UI 显示与图纸标注文案，绝不写回真源。 */
export function mmToMeters(mm: Mm): number {
  return mm / MM_PER_M;
}
