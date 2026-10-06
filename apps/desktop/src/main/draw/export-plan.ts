import { writeFileSync } from 'node:fs';
import { type Document } from '@dajia/core';
import {
  clipSheet,
  type ClipLine,
  type PlanOptions,
  type Sheet,
  type TitleBlock,
  frameSheet,
  planSheet,
} from '@dajia/drawing';
import { loadDefaultFont, writeSheets, type PdfFont } from '@dajia/pdf';

/**
 * 导出出口（plan5 T8，E1–E4）。
 *
 * **这是「唯一」允许把图面 IR 落到盘上的 Electron 侧文件**（与 T7 的 P-2 同一条纪律）：
 * 它是一个纯函数 `(doc, opts, outPath) => void`，**不 import electron**——
 * 渲染器侧把 storeyId / 剖切线 / 标题栏字段这些「视图状态」当参数递进来，
 * 本文件只认 `node:fs` 的写盘通道和 pdf 包的后端，不认识 `app`/`ipcMain` 任何东西。
 *
 * 字节稳定性（E2）：同 `doc` + 同 `opts` 连跑两次逐字相同。本文件不引入任何
 * 随时间变化的值——日期是入参（E3）、字体是常量字节、PDF 后端 `buildPdf`
 * 固定对象顺序且不嵌 `CreationDate`——所以可复现。
 */

/** 导出选项（plan5 §四 F3 + T8 E3：日期/设计人/图号都是入参，不许用运行时时钟或 userInfo 取）。 */
export interface ExportPlanOptions extends PlanOptions {
  /** 标题栏日期（纸面规范量，入参）。 */
  readonly date: string;
  /** 比例文字（默认 `1:100`）。 */
  readonly scaleText?: string;
  /** 剖切线（视图状态，D1）：给了就额外导出一页剖切轮廓（X8 的两页 PDF）。 */
  readonly clipLine?: ClipLine;
}

/** 组装一页「带图框的平面图」：图框 + 标题栏在前，图面内容在后。 */
function planSheetWithFrame(doc: Document, opts: ExportPlanOptions): Sheet {
  const planOpts: PlanOptions = {
    storeyId: opts.storeyId,
    title: opts.title,
    drafter: opts.drafter,
    sheetNo: opts.sheetNo,
  };
  const titleBlock: TitleBlock = {
    title: opts.title,
    scaleText: opts.scaleText ?? '1:100',
    date: opts.date, // E3：入参，不是运行时时钟取
    drafter: opts.drafter,
    sheetNo: opts.sheetNo,
  };
  const frame = frameSheet(titleBlock);
  const plan = planSheet(doc, planOpts);
  // 图框/标题栏先画，内容上叠——层顺序由各自模块保证（P7 / X8），这里只拼。
  return { ...frame, ops: [...frame.ops, ...plan.ops] };
}

/**
 * 把一层导出成 PDF 存盘。无剖切线 ⇒ 单页平面图；给了剖切线 ⇒ 两页（平面图 + 剖切轮廓，X8）。
 *
 * 字体默认内嵌思源黑体子集（`loadDefaultFont`），中文标题栏/标高才能显示。
 */
export function exportPlan(doc: Document, opts: ExportPlanOptions, outPath: string): void {
  const planOpts: PlanOptions = {
    storeyId: opts.storeyId,
    title: opts.title,
    drafter: opts.drafter,
    sheetNo: opts.sheetNo,
  };
  const sheets: Sheet[] = [planSheetWithFrame(doc, opts)];
  if (opts.clipLine) {
    sheets.push(clipSheet(doc, planOpts, opts.clipLine, opts.date));
  }
  const font: PdfFont = loadDefaultFont();
  const bytes = writeSheets(sheets, { font, compress: true });
  writeFileSync(outPath, bytes);
}
