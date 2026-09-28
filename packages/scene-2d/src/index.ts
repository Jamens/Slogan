export const SCENE_2D_PACKAGE = 'scene-2d';

export * from './viewport';
export * from './drawlist';
export * from './pick';
export * from './demo';
export * from './handles';
export * from './snapping';
// Task 6 棒 A 的临时形状：`MoveTarget` / `moveTargetOf` 在 `handles.ts` 与 `snapping.ts` 里
// 各住一份（从 `handles.ts` 迁出是棒 C 的活）。两个同名成员撞进 `export *` 会报 TS2308，
// 这里显式把出口钉到 `snapping.ts` 那一份 —— 两份实现行为逐字相同（同一对
// `quantizeMm(pxToMm(...))`），这一句只是消歧，不改变任何既有调用方的读数。
// 棒 C 把它们从 `handles.ts` 删掉之后，下面两行连同本注释一起删除。
export { moveTargetOf } from './snapping';
export type { MoveTarget } from './snapping';
export * from './editing';
