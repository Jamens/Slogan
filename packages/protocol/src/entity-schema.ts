import { z } from 'zod';

/**
 * 边界层唯一的整数毫米判据。用 `z.number().refine` 而不是 `z.int()`：
 * `Number.isSafeInteger` 一句同时管住"整数"与"范围"，而 zod 4 小版本里 `z.int()` 与
 * `z.number().int()` 的形态有出入 —— 少一处 API 面就少一处打包后才发现的实测风险。
 * 三条判据一条都不许省：`-0` 那条是计划 2 转下游 #5 的收口点，`Document.validate` 放行它
 * （`Number.isInteger(-0)` 为 true），只有这里拒。
 */
export const MmSchema = z
  .number()
  .refine((v) => Number.isSafeInteger(v), '必须是安全整数毫米')
  .refine((v) => !Object.is(v, -0), '不接受 -0：真源里的零不许带符号');

/**
 * 与 core `ids.ts` 的 `V7_RE` 逐字符相同的一份。为什么有两份：D2b 不许 core import protocol，
 * 边界校验又必须在 protocol 里 —— 于是这条规则只能复制，靠测试钉死（改一边就红）。
 */
const UUID_V7_TEXT = '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

export const EntityIdSchema = z.string().regex(new RegExp(UUID_V7_TEXT), 'id 必须是 UUIDv7');

/** 给对账测试用：源码文本口径，别拿它做运行时判断。 */
export const UUID_RE_TEXT = UUID_V7_TEXT;

/** 材料名：空串、首尾空白、超长三条与 core 的 `assertMaterial` 同一条口径（那边是产地，这里是边界复刻，第 5 格钉字数上界）。 */
const MaterialSchema = z
  .string()
  .min(1, '材料不能为空')
  .refine((v) => v === v.trim(), '材料不能带首尾空白')
  .max(32, '材料不能超过 32 个字符');

const Kind = <K extends string>(k: K) => z.literal(k);

export const PointSchema = z.strictObject({
  kind: Kind('point'),
  id: EntityIdSchema,
  storeyId: EntityIdSchema,
  x: MmSchema,
  y: MmSchema,
});

export const WallSchema = z.strictObject({
  kind: Kind('wall'),
  id: EntityIdSchema,
  storeyId: EntityIdSchema,
  startId: EntityIdSchema,
  endId: EntityIdSchema,
  thicknessMm: MmSchema,
  heightMm: MmSchema,
  elevationOffsetMm: MmSchema,
  loadBearing: z.boolean(),
  material: MaterialSchema,
});

export const OpeningSchema = z.strictObject({
  kind: Kind('opening'),
  id: EntityIdSchema,
  storeyId: EntityIdSchema,
  hostWallId: EntityIdSchema,
  distanceMm: MmSchema,
  widthMm: MmSchema,
  heightMm: MmSchema,
  sillMm: MmSchema,
  category: z.enum(['door', 'window']),
});

export const StoreySchema = z.strictObject({
  kind: Kind('storey'),
  id: EntityIdSchema,
  projectId: EntityIdSchema,
  index: z.number().refine((v) => Number.isSafeInteger(v) && v >= 0, '楼层序号必须为非负整数'),
  elevationMm: MmSchema,
  heightMm: MmSchema,
});

export const ColumnSchema = z.strictObject({
  kind: Kind('column'),
  id: EntityIdSchema,
  storeyId: EntityIdSchema,
  pointId: EntityIdSchema,
  widthMm: MmSchema,
  depthMm: MmSchema,
  heightMm: MmSchema,
  loadBearing: z.boolean(),
  material: MaterialSchema,
});

export const SlabSchema = z.strictObject({
  kind: Kind('slab'),
  id: EntityIdSchema,
  storeyId: EntityIdSchema,
  // 下界 3 只是**形状**下界（数组长度）。几何退化（共线、自交）由 core 的 assertSimpleRing 判 ——
  // 三道 4 点共线的边界数据在这里过、在 loadProject 那一步抛，这是分工不是漏判。
  boundaryPointIds: z.array(EntityIdSchema).min(3, '楼板边界至少 3 个顶点'),
  thicknessMm: MmSchema,
  elevationOffsetMm: MmSchema,
});

export const EntitySchema = z.discriminatedUnion('kind', [
  PointSchema,
  WallSchema,
  OpeningSchema,
  StoreySchema,
  ColumnSchema,
  SlabSchema,
]);

export type EntityShape = z.output<typeof EntitySchema>;

/** 落库的写路径单位。core 的 `Patch` 是纯数据，所以这一格没有转换层。 */
export const PatchSchema = z.strictObject({
  upsert: z.array(EntitySchema),
  remove: z.array(EntityIdSchema),
});

/** 幂等键：客户端分配的单调计数（P-6）。非负安全整数，别的都不收。 */
export const JournalTurnSchema = z
  .number()
  .refine((v) => Number.isSafeInteger(v) && v >= 0, 'journal turn 必须为非负安全整数');

/**
 * 与 core `document.ts` 的 `INTEGER_FIELDS` 同一张表的一份副本（同 UUID 正则的理由：依赖方向不许反）。
 * 它同时是本包测试的循环表，不是给运行时用的装饰 —— 导出的唯一理由是测试。
 */
export const INTEGER_FIELDS_SHAPE: Record<string, readonly string[]> = {
  point: ['x', 'y'],
  wall: ['thicknessMm', 'heightMm', 'elevationOffsetMm'],
  opening: ['distanceMm', 'widthMm', 'heightMm', 'sillMm'],
  storey: ['elevationMm', 'heightMm'],
  column: ['widthMm', 'depthMm', 'heightMm'],
  slab: ['thicknessMm', 'elevationOffsetMm'],
};

/**
 * 快照 payload 的**盘上契约**。住在这里而不是 `codec.ts`：`apps/desktop` 没有 zod 依赖，
 * pnpm 的严格 node_modules 也让它解析不到 protocol 的那一份 —— zod 只能住在有它的那个包里。
 * 三个 `parse*` 出口把 `ZodError` 在这里就收成一个普通 `TypeError`，边界另一侧只见文本。
 */
export const DocumentPayloadSchema = z.strictObject({
  projectId: EntityIdSchema,
  schemaVersion: z
    .number()
    .refine((v) => Number.isSafeInteger(v) && v >= 1, 'schemaVersion 必须是正整数'),
  entities: z.array(EntitySchema),
});

export type DocumentPayloadShape = z.output<typeof DocumentPayloadSchema>;
export type PatchShape = z.output<typeof PatchSchema>;

function issueText(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`).join('; ');
}

/** `where` 由调用方给（表名 + 行 id，或 T8 的 IPC 通道名）；文案形状是 codec.test.ts 的正则吃的样子。 */
export function parseEntityShape(where: string, value: unknown): EntityShape {
  const r = EntitySchema.safeParse(value);
  if (!r.success) throw new TypeError(`${where} 解不出实体：${issueText(r.error)}`);
  return r.data;
}

export function parsePatchShape(where: string, value: unknown): PatchShape {
  const r = PatchSchema.safeParse(value);
  if (!r.success) throw new TypeError(`${where} 解不出补丁：${issueText(r.error)}`);
  return r.data;
}

export function parseDocumentPayload(where: string, value: unknown): DocumentPayloadShape {
  const r = DocumentPayloadSchema.safeParse(value);
  if (!r.success) throw new TypeError(`${where} 解不出文档快照：${issueText(r.error)}`);
  return r.data;
}
