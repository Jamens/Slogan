export const DRAWING_PACKAGE = 'drawing';

// M1.5：PDF / SVG 等后端要消费图面 IR，必须把 IR 与单位类型作为本包的公开 API 暴露出来，
// 而不是让后端去 `import '../drawing/src/ir'`（跨包够文件是 D2b 要堵的写法）。
export * from './ir';
export * from './units';
export * from './section/clip';

