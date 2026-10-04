// 这一族用例全部走 `handBuild(...)`：命令层造不出这些坏文档（守卫就在命令里），
// 而读盘检查器的职责正是"库里/手搓出来的坏文档不许上屏"。造它只有一条合法通路 ——
// Document.replaceEntities（它 validate id 形状与整数毫米，但对引用完整性与 -0 全盲）。
// 第 6 格专门证这句"全盲"：-0 能进文档，所以必须在这里拦。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  assertTruthSourceInvariants,
  Document,
  INTEGER_FIELDS,
  storeyCreate,
  TransactionLog,
  wallCreate,
  type Entity,
  type EntityId,
  type EntityKind,
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
  column2: '0193aa00-0000-7000-8000-000000000011',
  ghostPoint: '0193aa00-0000-7000-8000-00000000000d',
  ghostOpening: '0193aa00-0000-7000-8000-00000000000e',
  ghostColumn: '0193aa00-0000-7000-8000-00000000000f',
  ghostSlab: '0193aa00-0000-7000-8000-000000000010',
} satisfies Record<string, EntityId>;

const storeyAt = (id: EntityId, elevationMm: number, heightMm: number, index = 0, projectId: EntityId = ID.project): StoreyEntity =>
  ({ kind: 'storey', id, projectId, index, elevationMm, heightMm });
const pointAt = (id: EntityId, storeyId: EntityId, x: number, y: number): PointEntity =>
  ({ kind: 'point', id, storeyId, x, y });
const wallAt = (storeyId: EntityId, startId: EntityId, endId: EntityId, thicknessMm: number): WallEntity =>
  ({ kind: 'wall', id: ID.wall, storeyId, startId, endId, thicknessMm, heightMm: 3000, elevationOffsetMm: 0, loadBearing: true, material: 'brick' });
const slabOf = (ids: readonly EntityId[], storeyId: EntityId = ID.lower): SlabEntity =>
  ({ kind: 'slab', id: ID.slab, storeyId, boundaryPointIds: [...ids], thicknessMm: 120, elevationOffsetMm: 0 });
const columnAt = (id: EntityId, pointId: EntityId, storeyId: EntityId = ID.lower): Entity =>
  ({ kind: 'column', id, storeyId, pointId, widthMm: 400, depthMm: 400, heightMm: 3000, loadBearing: true, material: 'concrete' });

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

/** 捕获检查器抛出的消息；没抛就立刻让这一格红（不许把"放行"当成通过）。 */
function messageOf(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('没抛：这一格要求检查器抛');
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
    // 本格（「楼层竖向重叠 ⇒ 抛；正好贴邻与留空隙都不抛」的第一发，断言 not.toThrow）与
    // 下一格（「楼层 index 重复 / 负 index / 归属别的工程 ⇒ 三发各抛一处」的第一发，断言
    // toThrow(/index 重复/)）喂给检查器的是**逐字节相同的文档**（两层的 projectId 同为 ID.project、index 同为 0），
    // 同一份数据不可能既不抛又抛 index 重复：任何实现都至少违背其中一格，所以缺陷在夹具而不在实现。
    // （m8：这里按**格子标题**引用，不引 brief 的行号 —— 那份 781 行的文本一改排，行号就漂。）
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

  it('墙形状退化进读盘门（C1：assertWallShape 从命令层搬进来后的读盘证人）：厚 5000 装 4000 长墙抛、厚=长 4000 的 `>=` 边界也抛、不同 id 同坐标的两点抛在「零长」且文案带得出墙 id', () => {
    // 这三发钉的是搬进来的那一份判据：摘掉墙循环里的 `assertWallShape(...)` 调用，
    // 前两发会被派生层**放行**（审查席探针 [A][B]），第三发会红在 geom/axis 的
    // 「轴线无方向」那句上 —— 所以零长那一发吃 `两端点量化后同为` 这个独有子串。
    expect(() => assertTruthSourceInvariants(handBuild([...HOSTS, wallAt(ID.lower, ID.pa, ID.pb, 5000)]))).toThrow(/不小于墙长/);
    expect(() => assertTruthSourceInvariants(handBuild([...HOSTS, wallAt(ID.lower, ID.pa, ID.pb, 4000)]))).toThrow(/不小于墙长/);
    const zeroDoc = handBuild([
      storeyAt(ID.lower, 0, 3000),
      pointAt(ID.pa, ID.lower, 0, 0),
      pointAt(ID.pb, ID.lower, 0, 0), // 不同 id、同坐标：引用与同层判据对它全盲，只有这一发拦得住
      wallAt(ID.lower, ID.pa, ID.pb, 240),
    ]);
    expect(() => assertTruthSourceInvariants(zeroDoc)).toThrow(/零长/);
    expect(() => assertTruthSourceInvariants(zeroDoc)).toThrow(/两端点量化后同为/);
    expect(() => assertTruthSourceInvariants(zeroDoc)).toThrow(new RegExp(ID.wall));
  });

  it('洞顶标高超过宿主墙高 ⇒ 抛（派生层只算沿轴区间，竖向这条必须在读盘门显式拦：窗台 200 + 高 2900 超 3000 墙高）', () => {
    // 摘掉 opening 循环末尾那条竖向判据，这一发会被整道门放行（审查席探针 [F]）——
    // 竖向不进派生表，没有任何后补的产地会响。
    const doc = handBuild([...HOSTS_WITH_WALL, { kind: 'opening', id: ID.opening, storeyId: ID.lower, hostWallId: ID.wall, distanceMm: 1000, widthMm: 900, heightMm: 2900, sillMm: 200, category: 'window' as const }]);
    expect(() => assertTruthSourceInvariants(doc)).toThrow(/顶标高/);
    expect(() => assertTruthSourceInvariants(doc)).toThrow(/超过宿主墙高/);
  });

  it('洞口 distanceMm 为负 ⇒ 抛在它自己那句上（与 sillMm 那条分开钉：「门必须 sillMm = 0」格里 openingAt(-1, …) 的 -1 落的是 sill，摘掉 distance 这行不会牵动它）', () => {
    const doc = handBuild([...HOSTS_WITH_WALL, { kind: 'opening', id: ID.opening, storeyId: ID.lower, hostWallId: ID.wall, distanceMm: -1, widthMm: 900, heightMm: 2100, sillMm: 0, category: 'door' as const }]);
    expect(() => assertTruthSourceInvariants(doc)).toThrow(/distanceMm 不能为负/);
  });

  it('幽灵柱：同层、同坐标、不同点 id 的两根柱 ⇒ 抛（柱不进派生表也不进索引，这一发是读盘侧唯一凭据；R2-1 后"同一枚点挂两柱"那一型也被关住了，但它红在另一句上 —— 见下一格，两型红相分开钉）', () => {
    const doc = handBuild([
      storeyAt(ID.lower, 0, 3000),
      pointAt(ID.pa, ID.lower, 0, 4000),
      pointAt(ID.pb, ID.lower, 0, 4000), // 与 pa 同坐标、不同 id
      columnAt(ID.column, ID.pa),
      columnAt(ID.column2, ID.pb),
    ]);
    expect(() => assertTruthSourceInvariants(doc)).toThrow(/已有柱/);
    expect(() => assertTruthSourceInvariants(doc)).toThrow(new RegExp(ID.column2));
    // 两型分账：这一型的对手是**另一枚点**，本门那条落点唯一判据（`${storeyId}:${pointId}` 键）
    // 对它不响 —— 摘掉 assertNoGhostColumn 只红这一格，摘掉落点判据只红下一格。
    expect(messageOf(() => assertTruthSourceInvariants(doc))).not.toMatch(/同一枚落点/);
  });

  it('同一枚落点挂两根柱（同一 pointId、同层）⇒ 抛在读盘门自有的落点唯一判据上：geom/topology 那句"该坐标已有柱"在这一型上是瞎的（exceptPointId 按点 id 排除，对手被当成"自己"），所以这一型必须有独立证人', () => {
    const doc = handBuild([
      storeyAt(ID.lower, 0, 3000),
      pointAt(ID.pa, ID.lower, 0, 4000), // 全场只有一枚落点
      columnAt(ID.column, ID.pa),
      columnAt(ID.column2, ID.pa), // 第二根柱挂在同一枚点 id 上
    ]);
    // 夹具可达性自检（R2-1 的反向核验）：这手搓文档**造得出来** ——
    // `Document.replaceEntities` 的 validate 只查 id 形状（UUIDv7）与 INTEGER_FIELDS 整数毫米，
    // 对"两柱共用同一枚点"全盲，也没有任何跨实体唯一性检查。于是拦它的只能是读盘门。
    expect(doc.get(ID.column2)).toBeDefined();
    const msg = messageOf(() => assertTruthSourceInvariants(doc));
    expect(msg).toMatch(/柱/);
    expect(msg).toMatch(/同一枚落点/);
    expect(msg).toContain(ID.lower); // 键带得出归属：楼层 id
    expect(msg).toContain(ID.pa); // 键带得出归属：共用的那枚落点 id
    expect(msg).toContain(ID.column2); // 拒的是后到的那根柱（byKind 按 id 升序，…0011 后到）
    expect(msg).not.toMatch(/该坐标已有柱/); // 与上一格（不同 id 同坐标）的红相分开
    // 反向：同一枚点上一根柱完全合法 —— 防"过严实现把落点判据扩成一柱一落点也不红"的假绿。
    expect(() =>
      assertTruthSourceInvariants(handBuild([
        storeyAt(ID.lower, 0, 3000),
        pointAt(ID.pa, ID.lower, 0, 4000),
        columnAt(ID.column, ID.pa),
      ])),
    ).not.toThrow();
  });

  it('点引用一枚不存在的楼层 ⇒ 抛（point 循环那发 requireStorey 是唯一拦截者：没有任何构件引用这枚点，派生层对孤儿点永远是瞎的）', () => {
    const doc = handBuild([storeyAt(ID.lower, 0, 3000), pointAt(ID.pa, ID.ghostPoint, 0, 0)]);
    expect(() => assertTruthSourceInvariants(doc)).toThrow(/楼层 不存在/);
    expect(() => assertTruthSourceInvariants(doc)).toThrow(new RegExp(ID.ghostPoint));
  });

  it('洞口 / 柱 / 楼板各引用一枚不存在的楼层 ⇒ 三发各被自己那发 requireStorey 拦下：消息带得出该类专属的幽灵层 id、且不是下游同层判据（摘掉对应那行，这一发会红在「必须同层」的文案上）', () => {
    const msgOpening = messageOf(() =>
      assertTruthSourceInvariants(handBuild([
        ...HOSTS_WITH_WALL,
        { kind: 'opening', id: ID.opening, storeyId: ID.ghostOpening, hostWallId: ID.wall, distanceMm: 1000, widthMm: 900, heightMm: 2100, sillMm: 0, category: 'door' as const },
      ])),
    );
    expect(msgOpening).toMatch(/不存在/);
    expect(msgOpening).toContain(ID.ghostOpening); // 「洞口」那一发点名：幽灵层 id 只有它自己的 requireStorey 会带出
    expect(msgOpening).not.toMatch(/同层/); // 摘掉 opening 循环的 requireStorey：会落到「洞口与宿主必须同层」

    const msgColumn = messageOf(() =>
      assertTruthSourceInvariants(handBuild([...HOSTS, columnAt(ID.column, ID.pc, ID.ghostColumn)])),
    );
    expect(msgColumn).toMatch(/不存在/);
    expect(msgColumn).toContain(ID.ghostColumn); // 「柱」那一发点名
    expect(msgColumn).not.toMatch(/同层/); // 摘掉 column 循环的 requireStorey：会落到「柱与落点必须同层」

    const msgSlab = messageOf(() =>
      assertTruthSourceInvariants(handBuild([...HOSTS, slabOf([ID.pa, ID.pb, ID.pc], ID.ghostSlab)])),
    );
    expect(msgSlab).toMatch(/不存在/);
    expect(msgSlab).toContain(ID.ghostSlab); // 「楼板」那一发点名
    expect(msgSlab).not.toMatch(/同层/); // 摘掉 slab 循环的 requireStorey：会落到顶点那条「必须同层」
  });

  it('`-0` 按类逐字段全拒：六类 × INTEGER_FIELDS 里每个整数字段各一发（旧版只有墙那一发有证人，其余五类的 assertNoNegativeZero 摘掉都不红）', () => {
    // 每类一个合法基准实体，叠在 HOSTS_WITH_WALL 上（同 id 覆盖同号），坏的那一格永远是唯一变量。
    // storey 钉的是 lower 自己（同 id 覆盖）：若钉后到的 upper，`elevationMm: -0` 会让 lower 迭代里
    // 的 assertNoVerticalOverlap 先抛「标高重叠」，证人红在错的门上。
    const baseFactories: Record<EntityKind, () => Entity> = {
      storey: () => storeyAt(ID.lower, 0, 3000),
      point: () => pointAt(ID.pa, ID.lower, 0, 0),
      wall: () => wallAt(ID.lower, ID.pa, ID.pb, 240),
      opening: () => ({ kind: 'opening', id: ID.opening, storeyId: ID.lower, hostWallId: ID.wall, distanceMm: 1000, widthMm: 900, heightMm: 2100, sillMm: 0, category: 'door' }),
      column: () => columnAt(ID.column, ID.pc),
      slab: () => slabOf([ID.pa, ID.pb, ID.pc]),
    };
    for (const kind of Object.keys(INTEGER_FIELDS) as EntityKind[]) {
      for (const field of INTEGER_FIELDS[kind]) {
        const entity = { ...baseFactories[kind](), [field]: -0 } as unknown as Entity;
        const doc = handBuild([...HOSTS_WITH_WALL, entity]);
        // 钉的是 assertNoNegativeZero 那句独有文案（`<字段> 不接受 -0`），不是裸 /-0/：
        // id 里就带「-0」子串，裸匹配会被任何一句带 id 的消息假绿。
        expect(() => assertTruthSourceInvariants(doc)).toThrow(new RegExp(`${field} 不接受 -0`));
      }
    }
  });

  it('楼层 index 是正数但不安全（2**53）⇒ 抛在「必须为非负整数」那句上：与「index 重复」分得开（摘掉 Number.isSafeInteger 半边，这一发会被放行）', () => {
    const doc = handBuild([storeyAt(ID.lower, 0, 3000, 2 ** 53)]);
    expect(() => assertTruthSourceInvariants(doc)).toThrow(/必须为非负整数/);
    expect(() => assertTruthSourceInvariants(doc)).not.toThrow(/index 重复/);
  });

  it('mm() 字段缺失不许悄悄放行：typeof 守卫当场抛并点名实体 id + 字段名（走 replaceEntities 会先红在 document.validate 的「必须是整数毫米」，所以证人先建好文档、再毁掉文档里那枚实体对象的字段）', () => {
    const doc = handBuild([...HOSTS_WITH_WALL]);
    const wall = doc.get(ID.wall) as WallEntity;
    delete (wall as unknown as { thicknessMm?: number }).thicknessMm;
    expect(() => assertTruthSourceInvariants(doc)).toThrow(/必须是数字毫米/);
    expect(() => assertTruthSourceInvariants(doc)).toThrow(new RegExp(`${ID.wall}\\.thicknessMm`));
  });

  it('storey.ts 走共享判据：import 行按行首锚定钉死，且同一行内没有第二份区间判定', () => {
    const src = readFileSync(new URL('../src/commands/storey.ts', import.meta.url), 'utf8');
    // P-56：旧的 toContain("from '../model/invariants'") 是整文件子串匹配，注释里写一句路径
    // 都能假绿 —— 换成行首起锚、花括号不跨语句的形状（Task 2 变异棒 `[^;]*` 跨列假绿的同族教训）。
    expect(src).toMatch(/^import\s*\{[^}]*\bassertNoVerticalOverlap\b[^}]*\}\s*from '\.\.\/model\/invariants'/m);
    // 第二发的 0 计数保留，但它真正证的只有「同一行内没有第二份区间判定」：
    // 正则不带 s 旗标，`.` 不跨行 ⇒ **跨行写法的复述（把 `elevationMm +` 与 `heightMm` 拆到两行）
    // 不在这一发的射程内** —— 这一限度在此登记。真调用点的牙在 commands-column-slab.test.ts 的两发。
    expect((src.match(/elevationMm \+ .*heightMm/g) ?? []).length).toBe(0);
  });
});
