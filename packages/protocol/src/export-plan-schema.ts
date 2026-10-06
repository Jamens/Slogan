import { z } from 'zod';
import { DocumentPayloadSchema, EntityIdSchema } from './entity-schema';

/**
 * 「导出平面图」这条 IPC 的线上契约（plan4 Task 8 棒 D 的一部分，消费 plan5 T7/T8）。
 *
 * ## 为什么文档快照用 `DocumentPayloadSchema` 而不是 `SnapshotPayloadSchema`
 *
 * 后者是**盘上契约**（四键，多一个 `journalTurn`），它的注释已经写明：线上继续用
 * `DocumentPayloadSchema` —— **renderer 没有合法的 turn 可填**（P-18）。
 * 导出这份快照是 renderer 递给主进程的读数，不是 journal 的一发，所以那个键不存在。
 * 少一个键不是"少校验一层"：`DocumentPayloadSchema` 自己就把 `entities` 全量过了一遍
 * `EntitySchema`，重复 id 由 `document-wire` 那道 Map 守卫当场抛。
 *
 * ## 本包不许 import `@dajia/*`（D2b）
 *
 * 剖切线在这里是**平面 mm 数字**的 `{a,b}`，不是 `@dajia/drawing` 的 `ClipLine`：
 * 依赖方向是 `drawing ← desktop`，`protocol` 不认识 drawing（D2b，`ALLOWED_DEPS` 里
 * `protocol: []`）。两边结构同形，主进程那侧做一次显式映射（`export-plan-core.ts`），
 * 与 A2「两族线型各留一格钉住映射」同一条纪律 —— 契约不许靠"结构碰巧一样"活着。
 */

/** 纸面坐标（mm，可浮点）。**不是** `MmSchema`：那个是整数模型真源，这是乘过比例的图面量。 */
const PaperVec2Schema = z.strictObject({
  x: z.number().refine((v) => Number.isFinite(v), '纸面坐标必须是有限数'),
  y: z.number().refine((v) => Number.isFinite(v), '纸面坐标必须是有限数'),
});

/** 剖切线（D1：视图状态，不进真源）。法向**右侧**为保留侧（X4）。 */
export const ClipLineSchema = z.strictObject({
  a: PaperVec2Schema,
  b: PaperVec2Schema,
});
export type ClipLineShape = z.output<typeof ClipLineSchema>;

/**
 * 导出选项。**日期/设计人是入参（plan5 T8 E3）** —— 这里没有任何"取当前时间"的余地，
 * 契约层就不给它开口子：想要可复现的字节，日期只能由调用方递进来。
 */
export const ExportPlanOptionsSchema = z.strictObject({
  storeyId: EntityIdSchema,
  title: z.string().min(1, '图名不能为空'),
  drafter: z.string().min(1, '设计人不能为空'),
  sheetNo: z.string().min(1, '图号不能为空'),
  date: z.string().min(1, '日期不能为空'),
  scaleText: z.string().min(1).optional(),
  /** 给了就多导一页剖切轮廓（T7 X8 的两页 PDF）；不给就是单页平面图。 */
  clipLine: ClipLineSchema.optional(),
});
export type ExportPlanOptionsShape = z.output<typeof ExportPlanOptionsSchema>;

export const ExportPlanRequestSchema = z.strictObject({
  doc: DocumentPayloadSchema,
  opts: ExportPlanOptionsSchema,
});
export type ExportPlanRequestShape = z.output<typeof ExportPlanRequestSchema>;

/**
 * 导出结果。**不是**"抛错穿回 IPC"：`ipcMain.handle` 里抛出去在 renderer 侧只看得见
 * 一句 `Error invoking remote method`，而这一格要能把"用户取消了保存对话框"与
 * "图纸侧抛了"分成两种可分辨的文案。
 */
export const ExportPlanResultSchema = z.strictObject({
  ok: z.boolean(),
  /** 落盘绝对路径（`ok` 为真时给）。 */
  outPath: z.string().optional(),
  error: z.string().optional(),
});
export type ExportPlanResultShape = z.output<typeof ExportPlanResultSchema>;

function issueText(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`).join('; ');
}

/** `where` 由调用方给（IPC 通道名）。文案前缀沿用 codec / entity-schema 那一族的形状。 */
export function parseExportPlanRequest(where: string, value: unknown): ExportPlanRequestShape {
  const r = ExportPlanRequestSchema.safeParse(value);
  if (!r.success) throw new TypeError(`${where} 解不出导出请求：${issueText(r.error)}`);
  return r.data;
}
