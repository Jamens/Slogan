// 这一族用例全部走 `handBuild(...)`：命令层造不出这些坏文档（守卫就在命令里），
// 而读盘检查器的职责正是"库里/手搓出来的坏文档不许上屏"。造它只有一条合法通路 ——
// Document.replaceEntities（它 validate id 形状与整数毫米，但对引用完整性与 -0 全盲）。
// 第 6 格专门证这句"全盲"：-0 能进文档，所以必须在这里拦。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  assertTruthSourceInvariants,
  Document,
  storeyCreate,
  TransactionLog,
  wallCreate,
  type Entity,
  type EntityId,
  type PointEntity,
  type SlabEntity,
  type StoreyEntity,
  type WallEntity,
} from '../src/index';

const ID = {
  project: '0193aa00-0000-7000-8000-000000000001',
  lower: '0193aa00-0000-7000-8000-000000000002',
  upper: '0193aa00-0000-7000-8000-000000000003',
  otherProject: '0193aa00-0000-7000-8000-000000000004',
  pa: '0193aa00-0000-7000-8000-000000000005',
  pb: '0193aa00-0000-7000-8000-000000000006',
  pc: '0193aa00-0000-7000-8000-000000000007',
  pd: '0193aa00-0000-7000-8000-00000000000c',
  wall: '0193aa00-0000-7000-8000-000000000008',
  opening: '0193aa00-0000-7000-8000-000000000009',
  column: '0193aa00-0000-7000-8000-00000000000a',
  slab: '0193aa00-0000-7000-8000-00000000000b',
} satisfies Record<string, EntityId>;

const storeyAt = (id: EntityId, elevationMm: number, heightMm: number, index = 0, projectId: EntityId = ID.project): StoreyEntity =>
  ({ kind: 'storey', id, projectId, index, elevationMm, heightMm });
const pointAt = (id: EntityId, storeyId: EntityId, x: number, y: number): PointEntity =>
  ({ kind: 'point', id, storeyId, x, y });
const wallAt = (storeyId: EntityId, startId: EntityId, endId: EntityId, thicknessMm: number): WallEntity =>
  ({ kind: 'wall', id: ID.wall, storeyId, startId, endId, thicknessMm, heightMm: 3000, elevationOffsetMm: 0, loadBearing: true, material: 'brick' });
const slabOf = (ids: readonly EntityId[], storeyId: EntityId = ID.lower): SlabEntity =>
  ({ kind: 'slab', id: ID.slab, storeyId, boundaryPointIds: [...ids], thicknessMm: 120, elevationOffsetMm: 0 });

/** 最小正例宿主：一层 + 不共线三点（板退化那一格在它上面换顶点坐标）。 */
const HOSTS: Entity[] = [
  storeyAt(ID.lower, 0, 3000),
  pointAt(ID.pa, ID.lower, 0, 0),
  pointAt(ID.pb, ID.lower, 4000, 0),
  pointAt(ID.pc, ID.lower, 0, 4000),
];
const HOSTS_WITH_WALL: Entity[] = [...HOSTS, wallAt(ID.lower, ID.pa, ID.pb, 240)];

/** 下界表：`[带坏字段的实体, 期望消息里出现的字段名]`。逐条循环断言，别写成一串 if。
 *  每条都叠在 `HOSTS_WITH_WALL` 上（同 id 覆盖同号），于是"坏的那一格"永远是唯一变量。 */
const BELOW_ONE: readonly [Entity, string][] = [
  [wallAt(ID.lower, ID.pa, ID.pb, 0), 'thicknessMm'],
  [{ ...wallAt(ID.lower, ID.pa, ID.pb, 240), heightMm: 0 }, 'heightMm'],
  [{ kind: 'opening', id: ID.opening, storeyId: ID.lower, hostWallId: ID.wall, distanceMm: 1000, widthMm: 0, heightMm: 2100, sillMm: 0, category: 'door' }, 'widthMm'],
  [{ kind: 'opening', id: ID.opening, storeyId: ID.lower, hostWallId: ID.wall, distanceMm: 1000, widthMm: 900, heightMm: 0, sillMm: 0, category: 'window' }, 'heightMm'],
  [{ kind: 'column', id: ID.column, storeyId: ID.lower, pointId: ID.pc, widthMm: 0, depthMm: 400, heightMm: 3000, loadBearing: true, material: 'concrete' }, 'widthMm'],
  [{ kind: 'column', id: ID.column, storeyId: ID.lower, pointId: ID.pc, widthMm: 400, depthMm: 400, heightMm: 0, loadBearing: true, material: 'concrete' }, 'heightMm'],
  [{ ...slabOf([ID.pa, ID.pb, ID.pc]), thicknessMm: 0 }, 'thicknessMm'],
  [storeyAt(ID.lower, 0, 0), 'heightMm'],
];

function handBuild(entities: readonly Entity[]): Document {
  const map = new Map<EntityId, Entity>();
  for (const e of entities) map.set(e.id, e);
  return Document.replaceEntities(Document.create(ID.project), map);
}

describe('assertTruthSourceInvariants：读盘放行证', () => {
  it('命令层造出的好文档一条都不抛（正例，防检查器过严把真项目全拒了）', () => {
    const log = new TransactionLog(Document.create(ID.project));
    log.dispatch(storeyCreate({ projectId: ID.project, index: 0, elevationMm: 0, heightMm: 3000 }));
    const storeyId = [...log.affected][0]!;
    log.dispatch(wallCreate({ storeyId, start: { x: 0, y: 0 }, end: { x: 4000, y: 0 }, thicknessMm: 240, heightMm: 3000 }));
    expect(() => assertTruthSourceInvariants(log.document)).not.toThrow();
  });

  it('零层文档合法：刚建工程还没画层时要能加载（命令层"最后一层不许删"是另一条规则，读盘侧不复制）', () => {
    expect(() => assertTruthSourceInvariants(Document.create(ID.project))).not.toThrow();
  });

  it('悬空引用：墙指着一枚不存在的点 ⇒ 抛，且消息里带着那枚 id', () => {
    const doc = handBuild([
      { kind: 'storey', id: ID.lower, projectId: ID.project, index: 0, elevationMm: 0, heightMm: 3000 },
      { kind: 'wall', id: ID.wall, storeyId: ID.lower, startId: ID.pa, endId: ID.pb, thicknessMm: 240, heightMm: 3000, elevationOffsetMm: 0, loadBearing: true, material: 'brick' },
    ]);
    expect(() => assertTruthSourceInvariants(doc)).toThrow(/不存在/);
    expect(() => assertTruthSourceInvariants(doc)).toThrow(new RegExp(ID.pa));
  });

  it('跨层引用：墙在一层、端点在另一层 ⇒ 抛（两层墙网凭空焊死那一型）', () => {
    const doc = handBuild([
      { kind: 'storey', id: ID.lower, projectId: ID.project, index: 0, elevationMm: 0, heightMm: 3000 },
      { kind: 'storey', id: ID.upper, projectId: ID.project, index: 1, elevationMm: 3000, heightMm: 3000 },
      { kind: 'point', id: ID.pa, storeyId: ID.upper, x: 0, y: 0 },
      { kind: 'point', id: ID.pb, storeyId: ID.upper, x: 4000, y: 0 },
      { kind: 'wall', id: ID.wall, storeyId: ID.lower, startId: ID.pa, endId: ID.pb, thicknessMm: 240, heightMm: 3000, elevationOffsetMm: 0, loadBearing: true, material: 'brick' },
    ]);
    expect(() => assertTruthSourceInvariants(doc)).toThrow(/不属于本层|同层/);
  });

  it('洞口与宿主不同层 ⇒ 抛；同层 ⇒ 不抛（区分"做了/没做"，两型各一发）', () => {
    const base = [
      { kind: 'storey', id: ID.lower, projectId: ID.project, index: 0, elevationMm: 0, heightMm: 3000 },
      { kind: 'storey', id: ID.upper, projectId: ID.project, index: 1, elevationMm: 3000, heightMm: 3000 },
      { kind: 'point', id: ID.pa, storeyId: ID.lower, x: 0, y: 0 },
      { kind: 'point', id: ID.pb, storeyId: ID.lower, x: 4000, y: 0 },
      { kind: 'wall', id: ID.wall, storeyId: ID.lower, startId: ID.pa, endId: ID.pb, thicknessMm: 240, heightMm: 3000, elevationOffsetMm: 0, loadBearing: true, material: 'brick' },
      { kind: 'opening', id: ID.opening, storeyId: ID.upper, hostWallId: ID.wall, distanceMm: 1000, widthMm: 900, heightMm: 2100, sillMm: 0, category: 'door' as const },
    ] satisfies Entity[];
    expect(() => assertTruthSourceInvariants(handBuild(base))).toThrow(/同层/);
    expect(() => assertTruthSourceInvariants(handBuild(base.map((e) => (e.kind === 'opening' ? { ...e, storeyId: ID.lower } : e))))).not.toThrow();
  });

  it('门必须 sillMm = 0，窗可以带台；负 sill 一律拒（下界与门规各一发）', () => {
    const openingAt = (sillMm: number, category: 'door' | 'window'): Entity =>
      ({ kind: 'opening', id: ID.opening, storeyId: ID.lower, hostWallId: ID.wall, distanceMm: 1000, widthMm: 900, heightMm: 2100, sillMm, category });
    expect(() => assertTruthSourceInvariants(handBuild([...HOSTS_WITH_WALL, openingAt(0, 'door')]))).not.toThrow();
    expect(() => assertTruthSourceInvariants(handBuild([...HOSTS_WITH_WALL, openingAt(100, 'door')]))).toThrow(/门/);
    expect(() => assertTruthSourceInvariants(handBuild([...HOSTS_WITH_WALL, openingAt(100, 'window')]))).not.toThrow();
    expect(() => assertTruthSourceInvariants(handBuild([...HOSTS_WITH_WALL, openingAt(-1, 'window')]))).toThrow(/sillMm/);
  });

  it('-0 进得了文档、进不了屏幕：`Document.validate` 放行它（Number.isInteger(-0) 为 true），本检查器拒 —— 这一格同时是"为什么必须有这里"的证据', () => {
    const doc = handBuild([...HOSTS, { ...wallAt(ID.lower, ID.pa, ID.pb, 240), thicknessMm: -0 }]);
    expect(doc.get(ID.wall)).toBeDefined(); // 文档本身造得出来：拦它不是 Document 的活
    expect(() => assertTruthSourceInvariants(doc)).toThrow(/-0/);
  });

  it('尺寸下界：墙厚 / 墙高 / 洞口宽高 / 柱三维 / 板厚 / 层高 < 1 全拒（一表循环，别写成一串 if）', () => {
    for (const [entity, field] of BELOW_ONE) {
      expect(() => assertTruthSourceInvariants(handBuild([...HOSTS_WITH_WALL, entity]))).toThrow(new RegExp(field));
    }
  });

  it('楼层竖向重叠 ⇒ 抛；正好贴邻与留空隙都不抛（半开区间那三条口径在读盘侧同样成立）', () => {
    // 【对 brief 的实测订正，见 task-3-report.md 的 brief 缺陷 B1】
    // brief 原文这三发的上层都写作 `storeyAt(ID.upper, …)`（不传 index），而夹具里
    // `storeyAt(id, elevationMm, heightMm, index = 0, …)` 的默认 index 就是 0 —— 于是
    // 第 545 行（本格第一发，断言 not.toThrow）与第 552 行（下一格第一发，断言 toThrow(/index 重复/)）
    // 喂给检查器的是**逐字节相同的文档**（两层的 projectId 同为 ID.project、index 同为 0），
    // 同一份数据不可能既不抛又抛 index 重复：任何实现都至少违背其中一格，所以缺陷在夹具而不在实现。
    // 现在的写法：只给上层补一个显式 `index = 1`（其余参数、三条断言一字未动），
    // 于是这一格的唯一变量回到它标题声称的那件事 —— 竖向区间的重叠/贴邻/空隙。
    expect(() => assertTruthSourceInvariants(handBuild([storeyAt(ID.lower, 0, 3000), storeyAt(ID.upper, 3000, 3000, 1)]))).not.toThrow();
    expect(() => assertTruthSourceInvariants(handBuild([storeyAt(ID.lower, 0, 3000), storeyAt(ID.upper, 2000, 3000, 1)]))).toThrow(/重叠/);
    // 空隙（错层）合法：这条不许被"必须贴邻"式的过严实现蒙过去
    expect(() => assertTruthSourceInvariants(handBuild([storeyAt(ID.lower, 0, 2000), storeyAt(ID.upper, 3000, 3000, 1)]))).not.toThrow();
  });

  it('楼层 index 重复 / 负 index / 归属别的工程 ⇒ 三发各抛一处', () => {
    expect(() => assertTruthSourceInvariants(handBuild([storeyAt(ID.lower, 0, 3000, 0), storeyAt(ID.upper, 3000, 3000, 0)]))).toThrow(/index 重复/);
    expect(() => assertTruthSourceInvariants(handBuild([storeyAt(ID.lower, 0, 3000, -1)]))).toThrow(/index/);
    expect(() => assertTruthSourceInvariants(handBuild([storeyAt(ID.lower, 0, 3000, 0, ID.otherProject)]))).toThrow(/projectId|归属/);
  });

  it('板边界退化：三点不共线放行，三点共线与两点各抛一处（顶点数与共线一律走 assertSimpleRing，不在这里重算）', () => {
    expect(() => assertTruthSourceInvariants(handBuild([...HOSTS, slabOf([ID.pa, ID.pb, ID.pc])]))).not.toThrow();
    const collinear: Entity[] = [...HOSTS, pointAt(ID.pd, ID.lower, 2000, 0), slabOf([ID.pa, ID.pd, ID.pb])];
    expect(() => assertTruthSourceInvariants(handBuild(collinear))).toThrow(/顶点共线/);
    expect(() => assertTruthSourceInvariants(handBuild([...HOSTS, slabOf([ID.pa, ID.pb])]))).toThrow(/至少 3 个顶点/);
  });

  it('过了下界、引用也齐全，但派生炸的一型：洞口宽 5000 装在 4000 长的宿主墙上 ⇒ 只有末尾那遍逐层 deriveStoreyGeometry 拦得住', () => {
    // 这一格是"派生那一遍不是顺手多算一次几何"的唯一凭据：摘掉它（变异 T3-M7），
    // 四条显式检查一条都不会响，坏文档就放行到屏幕上了。
    const doc = handBuild([...HOSTS_WITH_WALL, { kind: 'opening', id: ID.opening, storeyId: ID.lower, hostWallId: ID.wall, distanceMm: 1000, widthMm: 5000, heightMm: 2100, sillMm: 100, category: 'window' as const }]);
    expect(() => assertTruthSourceInvariants(doc)).toThrow(/超出宿主墙/);
  });

  it('storey.ts 不许留第二份重叠规则：它必须 import 共享版，且本文件不含区间判定那几行', () => {
    const src = readFileSync(new URL('../src/commands/storey.ts', import.meta.url), 'utf8');
    expect(src).toContain("from '../model/invariants'");
    expect((src.match(/elevationMm \+ .*heightMm/g) ?? []).length).toBe(0);
  });
});
