// 这一格是"两份文本"的裁判，不是普通单测：protocol 不许 import core（D2b），
// 所以 zod shape 与 core 的 interface 一定是两份，同步只能靠读源码文本对账。
// 读源码不算 import：check-package-deps 只认 `@dajia/...` 说明符，这里是 node:fs + 相对路径。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ColumnSchema,
  EntitySchema,
  INTEGER_FIELDS_SHAPE,
  OpeningSchema,
  PatchSchema,
  PointSchema,
  SlabSchema,
  StoreySchema,
  UUID_RE_TEXT,
  WallSchema,
} from '../src/entity-schema';

const entitySrc = readFileSync(
  new URL('../../core/src/model/entity.ts', import.meta.url),
  'utf8',
);
const idsSrc = readFileSync(new URL('../../core/src/ids.ts', import.meta.url), 'utf8');
const documentSrc = readFileSync(
  new URL('../../core/src/model/document.ts', import.meta.url),
  'utf8',
);
const wallSrc = readFileSync(
  new URL('../../core/src/commands/wall.ts', import.meta.url),
  'utf8',
);

/** 抠 `export interface PointEntity { … }` 花括号里的字段名（注释行以 `/**` 或 ` *` 起头，不匹配）。 */
function coreFields(name: string): string[] {
  const block = entitySrc.match(
    new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`),
  );
  if (block === null) throw new Error(`core 的 interface ${name} 没抠到 —— entity.ts 结构变了`);
  return [...block[1].matchAll(/^ {2}(?:readonly )?(\w+)\??:/gm)].map((m) => m[1]).sort();
}

/** 抠 `const INTEGER_FIELDS: Record<EntityKind, readonly string[]> = { … }` 里的表，返回 `{ point: ['x','y'], … }`。 */
function parseFieldTable(body: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of body.matchAll(/(\w+): \[([^\]]*)\]/g)) {
    out[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map((f) => f[1]);
  }
  if (Object.keys(out).length !== 6) throw new Error(`INTEGER_FIELDS 抠到 ${String(Object.keys(out).length)} 类，应有 6 类`);
  return out;
}

// 六枚固定 id：测试里不许现调 uuidv7()（同毫秒不单调，失败样本就不可复现）。
const A = '0193aa00-0000-7000-8000-000000000001';
const B = '0193bb00-0000-7000-8000-000000000002';
const C = '0193cc00-0000-7000-8000-000000000003';
const D = '0193dd00-0000-7000-8000-000000000004';
const E = '0193ee00-0000-7000-8000-000000000005';

const POINT_OK = { kind: 'point', id: A, storeyId: B, x: 0, y: 0 };
const WALL_OK = { kind: 'wall', id: A, storeyId: B, startId: C, endId: D, thicknessMm: 240, heightMm: 3000, elevationOffsetMm: 0, loadBearing: true, material: 'brick' };
const OPENING_OK = { kind: 'opening', id: A, storeyId: B, hostWallId: C, distanceMm: 1000, widthMm: 900, heightMm: 2100, sillMm: 0, category: 'door' };
const STOREY_OK = { kind: 'storey', id: A, projectId: B, index: 0, elevationMm: 0, heightMm: 3000 };
const COLUMN_OK = { kind: 'column', id: A, storeyId: B, pointId: C, widthMm: 400, depthMm: 400, heightMm: 3000, loadBearing: true, material: 'concrete' };
const SLAB_OK = { kind: 'slab', id: A, storeyId: B, boundaryPointIds: [C, D, E], thicknessMm: 120, elevationOffsetMm: 0 };
/** `kind → 合法样例`，整数毫米循环那一格按 `INTEGER_FIELDS_SHAPE` 的键取它。 */
const VALID_BY_KIND: Record<string, Readonly<Record<string, unknown>>> = {
  point: POINT_OK, wall: WALL_OK, opening: OPENING_OK, storey: STOREY_OK, column: COLUMN_OK, slab: SLAB_OK,
};

describe('实体 schema ↔ core 真源对账', () => {
  // `.shape` 六个调用点全部写开：`pairs` 那种数组形状会让 TS 拿到一个 ZodObject 联合类型，
  // 联合的 `safeParse` 与 `shape` 在 strict 下不可同时调用（"每个成员都有签名，但互不兼容"）。
  it('六类实体的键集合逐字等于 core 的 interface 字段，且合法样例过 zod', () => {
    expect(Object.keys(PointSchema.shape).sort()).toEqual(coreFields('PointEntity'));
    expect(Object.keys(WallSchema.shape).sort()).toEqual(coreFields('WallEntity'));
    expect(Object.keys(OpeningSchema.shape).sort()).toEqual(coreFields('OpeningEntity'));
    expect(Object.keys(StoreySchema.shape).sort()).toEqual(coreFields('StoreyEntity'));
    expect(Object.keys(ColumnSchema.shape).sort()).toEqual(coreFields('ColumnEntity'));
    expect(Object.keys(SlabSchema.shape).sort()).toEqual(coreFields('SlabEntity'));
    for (const ok of [POINT_OK, WALL_OK, OPENING_OK, STOREY_OK, COLUMN_OK, SLAB_OK]) {
      expect(EntitySchema.safeParse(ok).success).toBe(true);
    }
  });

  it('.strict() 拒多余字段：计划 2 转下游 #5 那一型（{x, y, pointId: undefined}）进不来', () => {
    const r = PointSchema.safeParse({ ...POINT_OK, pointId: undefined });
    expect(r.success).toBe(false);
    // 只有"多余键被拒"才算过：把 strictObject 换成 object 时这里是 true（S5 的 foot-gun 复活）。
    // 第二发钉的是"派生值不许混进真源"：lengthMm 是派生量，压根不是实体字段。
    const w = WallSchema.safeParse({ ...WALL_OK, lengthMm: 4000 });
    expect(w.success).toBe(false);
  });

  it('整数毫米：INTEGER_FIELDS 里每个字段填 1.5 与 -0 都被拒，原值都通过', () => {
    // 表本身也钉住：core 的 INTEGER_FIELDS 源码文本 ↔ protocol 侧那份（改一边就红，见 T3-M4）
    const coreTable = documentSrc.match(/const INTEGER_FIELDS[^=]*=\s*\{([\s\S]*?)\n\};/);
    if (coreTable === null) throw new Error('core 的 INTEGER_FIELDS 没抠到');
    expect(INTEGER_FIELDS_SHAPE).toEqual(parseFieldTable(coreTable[1]));
    for (const kind of Object.keys(INTEGER_FIELDS_SHAPE)) {
      const base = VALID_BY_KIND[kind];
      if (base === undefined) throw new Error(`VALID_BY_KIND 缺 ${kind}：表加了类，样例没跟上`);
      for (const field of INTEGER_FIELDS_SHAPE[kind] ?? []) {
        expect(EntitySchema.safeParse({ ...base, [field]: 1.5 }).success).toBe(false);
        expect(EntitySchema.safeParse({ ...base, [field]: -0 }).success).toBe(false);
        expect(EntitySchema.safeParse(base).success).toBe(true);
      }
    }
  });

  it('UUIDv7 正则与 core 的 V7_RE 逐字符相同（两份文本必须一起改）', () => {
    const core = idsSrc.match(/const V7_RE = \/(.*)\/;/);
    if (core === null) throw new Error('core 的 V7_RE 没抠到');
    expect(UUID_RE_TEXT).toBe(core[1]);
  });

  it('material 的 32 字上界与空串/首尾空白规则同 core 的 assertMaterial 一处产地', () => {
    const max = wallSrc.match(/不能超过 (\d+) 字符/);
    if (max === null) throw new Error('core 的 assertMaterial 字数上界没抠到');
    expect(WallSchema.safeParse({ ...WALL_OK, material: 'x'.repeat(Number(max[1]) + 1) }).success).toBe(false);
    expect(WallSchema.safeParse({ ...WALL_OK, material: '' }).success).toBe(false);
    expect(WallSchema.safeParse({ ...WALL_OK, material: ' brick' }).success).toBe(false);
  });

  it('category 只认 door / window，kind 未知即拒', () => {
    expect(OpeningSchema.safeParse({ ...OPENING_OK, category: 'window ' }).success).toBe(false);
    expect(EntitySchema.safeParse({ kind: 'furniture', id: A }).success).toBe(false);
  });

  it('PatchSchema 收得下纯数据补丁，收不下坏实体（这是 command_log 的落库单位）', () => {
    expect(PatchSchema.safeParse({ upsert: [POINT_OK], remove: [] }).success).toBe(true);
    expect(PatchSchema.safeParse({ upsert: [{ kind: 'wall' }], remove: [] }).success).toBe(false);
    expect(PatchSchema.safeParse({ upsert: [POINT_OK], remove: ['not-a-uuid'] }).success).toBe(false);
    // 数组里的 kind 判别也认：discriminatedUnion 对"合法形状但未知 kind"必须拒，不是放行
    expect(PatchSchema.safeParse({ upsert: [{ ...POINT_OK, kind: 'beam' }], remove: [] }).success).toBe(false);
  });
});
