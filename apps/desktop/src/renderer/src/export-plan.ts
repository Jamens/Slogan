import { wallAxis, type Document, type WallEntity } from '@dajia/core';
import { encodeDocumentPayload } from '../../shared/document-payload';
import { useEditor } from './stores/editorStore';

/**
 * renderer 侧的导出入口：把**眼下的文档**与标题栏字段打包成线上快照，递给 preload。
 *
 * ## 为什么不 import `@dajia/protocol` / `@dajia/drawing`（值导入）
 *
 * 这一段跑在渲染上下文里，而 `electron.vite.config.ts` 的 renderer 段只 alias 了
 * `core` 与 `scene-2d`。在这里值导入 protocol 会把 **zod 拖进渲染包**（`entity-schema`
 * 是它的一部分），而我们需要它的只是几个类型 —— 类型用 `import type` 会被擦掉，
 * 零运行时代价。`drawing` 同理：它会顺着 `pdf` 把 `node:zlib`/`node:fs` 拖进浏览器包。
 * **落盘、弹对话框、PDF 字节组装全在主进程**，这一层只负责"把数据递过去"。
 */

/** 剖切线（纸面 mm）。视图状态（D1），不进真源。结构与契约的 `ClipLineShape` 同形。 */
export type ExportClipLine = { a: { x: number; y: number }; b: { x: number; y: number } };

/** 导出结果的形状。**刻意与契约的 `ExportPlanResultShape` 同形而不是 import 它**（理由见文件头）。 */
export interface ExportOutcome {
  readonly ok: boolean;
  readonly outPath?: string;
  readonly error?: string;
}

/**
 * 导出当前方案。
 *
 * **日期由调用方给**（E3 的口径一路传到 UI）：`new Date()` 出现在这里的话，
 * "同一天点两次导出得到同一份字节"这条性质就没法作为判据存在了。真实产品里
 * 标题栏日期是一个输入框，不是一个时钟读数。
 */
export async function requestPlanExport(opts: {
  readonly title: string;
  readonly drafter: string;
  readonly sheetNo: string;
  readonly date: string;
  readonly scaleText?: string;
  readonly clipLine?: ExportClipLine;
}): Promise<ExportOutcome> {
  // 现取 store：`log` 是可变类实例、引用永不变，订阅拿到的永远是同一份壳（editorStore D6）。
  const { log, storeyId } = useEditor.getState();
  // T8 把 `Window['dajia']` 改成可选（裁决 T8-A④：真实调用点在这一份文件，不在 panels.tsx）。
  // 漏注入那一支的文案口径照「没有 preload 注入的 dajia 接口」一族 —— 返回而不是抛：
  // 这一族的契约本来就是"错误走 `ok:false`，不拿 reject 穿 IPC"。
  const api = window.dajia;
  if (api === undefined) {
    return { ok: false, error: '没有 preload 注入的 dajia 接口：这一屏不会保存任何东西' };
  }
  return api.exportPlan({
    doc: encodeDocumentPayload(log.document),
    opts: {
      storeyId,
      title: opts.title,
      drafter: opts.drafter,
      sheetNo: opts.sheetNo,
      date: opts.date,
      scaleText: opts.scaleText,
      clipLine: opts.clipLine,
    },
  });
}

/**
 * 按当前层的几何**算一条**横剖切线（纸面 mm）。
 *
 * 存在的理由：T7 的 `clipLine` 是视图状态（D1），而 S1 没有"画剖切线"这个交互 ——
 * 若没有这个助手，剖切轮廓那条路在真实 UI 上永远走不到（只有单测走得到）。
 *
 * **它不重算几何**：墙的轴线由 core 的 `wallAxis` 给（spec 5.2「轮廓与接头一律派生」），
 * 这里只取本层全部轴线端点的 y 跨度中点。这与 drawing 侧 P1「不写第二份几何派生」同一条纪律。
 *
 * y 取反（`plan.ts` 的 `toPaper` 同一口径：模型 y 向上、纸面 y 向下）。横线 `a.x < b.x`，
 * 于是 `sideOf(centroid)` 的"法向右侧"落在图面上半 —— 与 T7 测例同一侧，
 * **不是**这里重新定的（判据在 `clip.ts`）。
 *
 * 比例是 1:100（B1 锁定的唯一档）。本该 import `mmToPaperMm`，但那会把 `@dajia/drawing`
 * 拖进渲染包（见文件头）；S2 做 1:50 时本函数与这一行一起搬进共享层并改用 `mmToPaperMm`。
 */
export function clipLineAcrossStorey(doc: Document, storeyId: string): ExportClipLine | null {
  const walls: readonly WallEntity[] = doc.byKind('wall').filter((w) => w.storeyId === storeyId);
  const ys: number[] = [];
  for (const wall of walls) {
    // 零长墙会抛（core 的不变式，命令层就该拒）：不静默吞掉，那会让"剖切线算不出来"
    // 与"这层没有墙"两种情形分不开。
    const axis = wallAxis(doc, wall);
    ys.push(axis.start.y, axis.start.y + axis.dir.y * axis.lengthMm);
  }
  if (ys.length === 0) return null;
  const midMm = (Math.min(...ys) + Math.max(...ys)) / 2;
  const yPaper = -midMm / 100;
  // 横贯 ±50 纸面 mm：够宽到穿过整层（测例里两堵墙相距 4000mm ⇒ 40 纸面 mm）。
  return { a: { x: -50, y: yPaper }, b: { x: 50, y: yPaper } };
}
