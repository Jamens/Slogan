import { parseExportPlanRequest, type ExportPlanResultShape } from '@dajia/protocol';
import type { ClipLine } from '@dajia/drawing';
import { decodeDocumentPayload } from '../../shared/document-wire';
import { exportPlan, type ExportPlanOptions } from '../draw/export-plan';

/**
 * 导出通路的**电子自由内核**：把一份 IPC 请求变成一次落盘，并给回可分辨的结果。
 *
 * ## 为什么 handler 拆成两个文件
 *
 * `export-plan.ts`（隔壁）是唯一 import electron 的那一层，它只做三件事：
 * 取保存路径、cancel 判 null、把 raw 递进来。而"解 payload → 还原文档 → 调 exportPlan"
 * 这一整段是**纯逻辑**，它必须能在 unit 档（不启 Electron）里被真窗口之外的判据验到 ——
 * 整个合进 electron 文件，那这段就只能靠 `--shot` 真窗口取证，而真窗口一次几十秒。
 * 与 plan4 T7 的 `autosave.ts` / `emergency.ts` 同一族拆分：**逻辑与副作用各住一处**。
 *
 * ## 错误一律**不抛**，而是回 `{ ok: false, error }`
 *
 * `ipcMain.handle` 里抛出去，renderer 侧只看得见一句 `Error invoking remote method`，
 * 且**分不清**"用户取消了保存对话框"与"图纸侧抛了"（洞口越界 / 实体缺失）。
 * 这一层把两种情况收成同一个可判别的形状，`ok:false` 那一格在 unit 里能直接断言。
 */

/** 抛点文案的前缀，沿用 codec / entity-schema 那一族（`where` 由通道名给）。 */
const WHERE = '导出平面图';

/**
 * 契约层的 `ClipLineShape` → drawing 的 `ClipLine`。
 *
 * **显式逐字段搬，而不是 `as ClipLine` 断言**：两边结构同形，但依赖方向是
 * `protocol ⇍ drawing`（D2b，`protocol: []`），契约里那个类型不是 drawing 的那个类型。
 * 一次显式搬运 = 两个包真的认识对方，而不是"形状碰巧一样"。同 A2 那条纪律。
 */
function toClipLine(line: { a: { x: number; y: number }; b: { x: number; y: number } }): ClipLine {
  return { a: { x: line.a.x, y: line.a.y }, b: { x: line.b.x, y: line.b.y } };
}

/**
 * 跑一次导出：`raw` 是 renderer 递过来的未经信任的任意值。
 *
 * 落盘路径由调用方给（`export-plan.ts` 那一层从保存对话框拿），**这个函数自己不碰 dialog** ——
 * 于是"路径从哪来"与"导出做了什么"分成两格可分别验证的判据。
 */
export function runExportPlan(raw: unknown, outPath: string): ExportPlanResultShape {
  let opts: ExportPlanOptions;
  let doc: ReturnType<typeof decodeDocumentPayload>;
  try {
    const request = parseExportPlanRequest(WHERE, raw);
    // 契约字段逐个搬到 export-plan 的入参上：不多带（`journalTurn` 那类假字段不许出现）、
    // 不少带（`clipLine` 缺省就是"单页"，X8 的两页由它有没有决定）。
    const planOptions: ExportPlanOptions = {
      storeyId: request.opts.storeyId,
      title: request.opts.title,
      drafter: request.opts.drafter,
      sheetNo: request.opts.sheetNo,
      date: request.opts.date,
      scaleText: request.opts.scaleText,
      clipLine: request.opts.clipLine === undefined ? undefined : toClipLine(request.opts.clipLine),
    };
    opts = planOptions;
    doc = decodeDocumentPayload(WHERE, request.doc);
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  try {
    exportPlan(doc, opts, outPath);
    return { ok: true, outPath };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
