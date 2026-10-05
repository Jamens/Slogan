/**
 * 比例与纸面换算的**唯一产地**（plan5 决策 U3/U4/U6）。
 *
 * 为什么这个文件只有二十几行却要单独占一个文件：施工图上"模型 3600mm 的墙在
 * 纸面上是36.00mm"这件事，横跨 `plan.ts`（画墙）、`dimensioning/`（尺寸文字）、
 * `frame.ts`（图框）三处。三处各写一份 `/ 100` 就是三份真源，而它们漂的时候
 * **一句错都不抛** —— 图只是慢慢变得不对。所以比例常数与换算函数都锁在这里，
 * 别的文件只许 import。
 */

/** 纸面坐标单位：**毫米**（不是米、不是像素、不是 pt）。 */
export type PaperMm = number;

/**
 * 比例分母的**唯一产地**（U6）。S1 只做 1:100（plan5 决策 B1，对齐 spec §11
 * 验收第1 条）；1:50 与 1:20 留 S2。
 *
 * 改动这个数会影响全部图元 —— 它是"数值唯一产地"那句话的兑现处，
 * 改它必须同时改 U6 那条判据的读数。
 */
export const SCALE_DENOMINATOR = 100;

/**
 * 收口到 0.01 纸面毫米（U3）。裸的 `mm / 100` 会产出 `0.30000000000000004`
 * 这类尾巴 —— 它们在屏幕上无害，但会进 IR 的 `s` 字段、会在 golden file 里
 * 逐字对不上、会让"两次跑出同样字节"那条判据（plan5 E2）随机漂。
 *
 * `Number(x.toFixed(2))` 而不是字符串：`PaperOp` 的坐标是 number，
 * 文本化留给后端（`text` 图元那一步），那时它自己会再格式化一次。
 */
function trim(mm: number): number {
  return Number(mm.toFixed(2));
}

/** 比例守卫（U4）。非法值在**构造期**抛，不许带着它算完半张图再炸。 */
export function requireScale(denominator: number): number {
  if (!Number.isSafeInteger(denominator) || denominator < 1) {
    throw new RangeError(
      `比例分母必须是 >=1 的安全整数，收到 ${String(denominator)}：` +
        `0 或负数会让纸面换算没有意义，非整数是还没把"比例"想清楚就动了手`,
    );
  }
  return denominator;
}

/**
 * 模型毫米 → 纸面毫米（U1/U3）。**算法只有"除以分母 + 收两位"这一种**
 * —— U6 那条判据正是靠这一点把"分母在两处各写一份"钉住。
 */
export function mmToPaperMm(modelMm: number, denominator: number = SCALE_DENOMINATOR): PaperMm {
  if (!Number.isFinite(modelMm)) {
    throw new TypeError(`模型坐标必须是有限数，收到 ${String(modelMm)}：NaN 进纸面就是 NaN 图元`);
  }
  return trim(modelMm / requireScale(denominator));
}

/**
 * 显式收口版本（U3 的常驻证人用）。与 `mmToPaperMm` 同一个算法，
 * 拆出来只为让判据能写成"结果恒等于本函数"，而不必复述一遍除法。
 */
export function scaleAndRound(modelMm: number, denominator: number = SCALE_DENOMINATOR): PaperMm {
  return mmToPaperMm(modelMm, denominator);
}

/**
 * 纸面毫米 → 模型毫米：**S1 故意没有**（U5）。
 *
 * 为什么不留一个能跑的空实现：施工图是单向的（模型 → 图面），S1 没有任何
 * 读者需要反向换算。而一个"返回粗略值"的反向函数比抛着的占位危险得多 ——
 * 有人会拿它当"把图上量的尺寸录回模型"的入口，而它的精度是假的。
 * 真正需要它的时候是 S2（模型库按图面尺寸检索、或视口与图面双向换算），
 * 那时连同精度约定一起写。
 */
export function paperToMm(_paperMm: number): number {
  throw new Error(
    '纸面 → 模型的逆换算 S1 未实现（plan5 U5）：施工图是单向的。' +
      '需要它的读者在 S2，届时连同精度约定一起落。',
  );
}
