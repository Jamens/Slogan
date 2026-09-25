/** 真源唯一的长度类型：整数毫米（spec D8）。 */
export type Mm = number;

export const MM_PER_M = 1000;

/**
 * 把任意浮点构造结果落到整数毫米。唯一允许写回真源的入口。
 * 用 Math.round：0.5 向正无穷侧舍入，-0.5 → -0（与 0 全等）。
 */
export function quantizeMm(value: number): Mm {
  if (!Number.isFinite(value)) {
    throw new RangeError(`quantizeMm 需要有限数，收到 ${value}`);
  }
  return Math.round(value);
}

/** 断言已经是整数毫米，用于所有命令构造器的入参校验。 */
export function assertMm(value: number, label: string): Mm {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} 必须是整数毫米，收到 ${value}：浮点坐标须先过 quantizeMm`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} 超出安全整数范围：${value}`);
  }
  return value;
}

/** 仅用于 UI 显示与图纸标注文案，绝不写回真源。 */
export function mmToMeters(mm: Mm): number {
  return mm / MM_PER_M;
}
