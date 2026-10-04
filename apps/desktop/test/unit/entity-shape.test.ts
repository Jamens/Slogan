import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  Document,
  type Entity,
  type EntityId,
  type OpeningEntity,
  type PointEntity,
  type SlabEntity,
  type StoreyEntity,
  type WallEntity,
} from '@dajia/core';
import { PatchSchema, type EntityShape, parseEntityShape } from '@dajia/protocol';

/**
 * 这一档**天生是绿的**，它的价值由变异证明（T4-M6）：把 `OpeningSchema.category` 从
 * `z.enum(['door','window'])` 改成 `z.string()`，Task 3 的行为用例与键集合对账**全绿**，
 * 只有这里红 —— 而且是 `tsc` 红（`apps/desktop/tsconfig.test.json` 由 T1 建、T1 把它串进
 * `pnpm typecheck`）。所以这一档的判据是"能红"，不是"跑过"。
 *
 * 为什么单独一档：`scripts/check-package-deps.mjs` 只查 `@dajia/*` 的说明符方向，查不到形状漂移；
 * 类型检查又不在 vitest 里发生（它只转译）。`codec.ts` 里那两处不写 `as` 的返回值是同一个判据的
 * 第二证人（漂在 protocol 时它也红），两处都留着才能指出漂在哪一侧。
 */
const PID = '0193aa00-0000-7000-8000-00000000000a';
const S1 = '0193aa00-0000-7000-8000-000000000001';
const P1 = '0193aa00-0000-7000-8000-000000000002';
const P2 = '0193aa00-0000-7000-8000-000000000003';
const P3 = '0193aa00-0000-7000-8000-00000000000b';
const W1 = '0193aa00-0000-7000-8000-000000000004';
const O1 = '0193aa00-0000-7000-8000-000000000005';
const C1 = '0193aa00-0000-7000-8000-000000000006';
const B1 = '0193aa00-0000-7000-8000-000000000007';

const point: PointEntity = { kind: 'point', id: P1, storeyId: S1, x: 0, y: 0 };
const point2: PointEntity = { kind: 'point', id: P2, storeyId: S1, x: 4000, y: 0 };
const point3: PointEntity = { kind: 'point', id: P3, storeyId: S1, x: 0, y: 4000 };
const wall: WallEntity = {
  kind: 'wall',
  id: W1,
  storeyId: S1,
  startId: P1,
  endId: P2,
  thicknessMm: 200,
  heightMm: 2800,
  elevationOffsetMm: 0,
  loadBearing: true,
  material: '混凝土',
};
const opening: OpeningEntity = {
  kind: 'opening',
  id: O1,
  storeyId: S1,
  hostWallId: W1,
  distanceMm: 1000,
  widthMm: 900,
  heightMm: 2100,
  sillMm: 0,
  category: 'door',
};
const storey: StoreyEntity = {
  kind: 'storey',
  id: S1,
  projectId: PID,
  index: 0,
  elevationMm: 0,
  heightMm: 3000,
};
const column: Entity = {
  kind: 'column',
  id: C1,
  storeyId: S1,
  pointId: P1,
  widthMm: 400,
  depthMm: 400,
  heightMm: 3000,
  loadBearing: true,
  material: '混凝土',
};
const slab: SlabEntity = {
  kind: 'slab',
  id: B1,
  storeyId: S1,
  boundaryPointIds: [P1, P2, P3],
  thicknessMm: 120,
  elevationOffsetMm: 0,
};
const FIXTURES: readonly Entity[] = [point, point2, point3, wall, opening, storey, column, slab];

describe('边界与真源之间不许有第二套形状', () => {
  it('两个方向都过：Entity 能当 EntityShape 递出去，解回来还能当 Entity 收进来', () => {
    for (const entity of FIXTURES) {
      const shape: EntityShape = entity; // 方向一：core → protocol（写盘那一侧）
      const back: Entity = parseEntityShape(
        `element 行 ${entity.id}`,
        JSON.parse(JSON.stringify(shape)),
      ); // 方向二：protocol → core（读盘那一侧）
      expect(back).toEqual(entity);
    }
  });

  it('手写一份 EntityShape 能直接进 `Document`（T5 的 loadProject 走的就是这条路）', () => {
    const shape: EntityShape = {
      id: W1,
      storeyId: S1,
      kind: 'wall',
      startId: P1,
      endId: P2,
      thicknessMm: 200,
      heightMm: 2800,
      elevationOffsetMm: 0,
      loadBearing: false,
      material: '砖',
    };
    // 这一行是编译期判据：键序、可选性、字面量收窄全都在这一个赋值上判
    const entity: Entity = shape;
    const doc = Document.replaceEntities(
      Document.create(PID),
      new Map<EntityId, Entity>([[entity.id, entity]]),
    );
    expect(doc.get(W1)).toBe(entity);
    expect(doc.byKind('wall')).toEqual([entity]);
  });

  it('第五份对账（I3）：PatchSchema 的键集合逐字等于 core `Patch` 接口里的字段名（改名必红，两侧各钉一次）', () => {
    // 为什么这一发存在：`PatchSchema`（protocol）与 core 的 `Patch` 是盘上 command_log.payload
    // 的键名产地，此前没有任何对账 —— 今天把 `upsert`/`remove` 改名不会有任何格子红，
    // 而 `upsert`/`remove` 是**写进磁盘 JSON 的字面键名**，改了就是给旧库留一份读不出来的账。
    // 形状照 `invariants.test.ts` 的 storey 判据那一格写（Task 3 的 P-56 教训：`toContain` 的
    // 整文件子串匹配会因"注释里留一句话"假绿 ⇒ 一律行首锚定，且只在接口体内取字段）。
    const src = readFileSync(
      new URL('../../../../packages/core/src/model/patch.ts', import.meta.url),
      'utf8',
    );
    // 只截 `export interface Patch { … }` 的**体内**文本：`[^}]*` 到第一个 `}` 停，
    // 于是接口上方的 JSDoc（`/** 落库的写路径单位 … */`）里若提到字段名也进不了射程。
    const body = src.match(/export interface Patch \{([^}]*)\}/)?.[1];
    expect(body, 'core 里没找到 `export interface Patch { … }`，对账失去对象').toBeDefined();
    // 逐行行首锚定取字段名（`m` 旗标让 `^` 落在每一行开头，不用 `s` —— 跨行合并正是 P-56 那一族假绿）。
    const coreFields = [...body!.matchAll(/^[ \t]*readonly[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*:/gm)].map(
      (m) => m[1] as string,
    );
    // 盘上契约的键名逐字钉死这一对，且**两侧各自**都钉：任何一侧单独改名、或两侧一起改名
    // （后者会同时改掉盘上 JSON 的键名），红的都是这一发而不是静默通过。
    expect(coreFields.sort()).toEqual(['remove', 'upsert']);
    expect(Object.keys(PatchSchema.shape).sort()).toEqual(['remove', 'upsert']);
    // 两份必须相等：schema 漂了而 core 没漂（或反之）时，这一发点名差异集。
    expect(coreFields.sort()).toEqual(Object.keys(PatchSchema.shape).sort());
  });
});
