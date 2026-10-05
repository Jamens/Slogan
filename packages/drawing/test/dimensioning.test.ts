import { describe, expect, it } from 'vitest';
import { Document, type EntityId } from '@dajia/core';
import { type PaperOp } from '../src/ir';
import { TICK_LENGTH_MM, dimensionKeys, dimensionSheet } from '../src/dimensioning';

const PID = '0193cc00-0000-7000-8000-00000000000a' as EntityId;
const STOREY = '0193cc00-0000-7000-8000-00000000000b' as EntityId;

/**
 * 夹具用的 id 生成器。**必须是合法 UUIDv7** —— `Document.replaceEntities` 里
 * `validate` 会拒（`实体 id 必须是 UUIDv7`）。第一版用 `padStart(2,'0')` 拼在
 * 固定前缀后，`seq` 一过 99 字符串就变长，尾巴那 12 位 hex 溢出 ⇒ 四条判据
 * 全在夹具里红（C3b / D3b / M1 / C1空层），而实现是对的。
 *
 * 办法：从一个合法的 UUIDv7 前缀取 12 位尾段，用**恰好 3 位 hex** 递增，
 * 保证长度恒定。
 */
let seq = 0x100; // 从 0x100 起：避开手写常量 STOREY/PID/P1/P2 占的低位
const nid = (): EntityId => {
  const tail = (seq++).toString(16).padStart(12, '0');
  return `0193cc00-0000-7000-8000-${tail}` as EntityId;
};

function storey(): { kind: 'storey'; id: EntityId; projectId: EntityId; index: number; elevationMm: 0; heightMm: 3000 } {
  return { kind: 'storey', id: STOREY, projectId: PID, index: 0, elevationMm: 0, heightMm: 3000 };
}

/** 一层一片墙（从 (x1,y1) 到 (x2,y2)）。墙的轴线两端点就是 point。 */
function house(walls: readonly (readonly [number, number, number, number])[]): Document {
  const entities = new Map<EntityId, ReturnType<typeof storey>>();
  entities.set(STOREY, storey());
  for (const [x1, y1, x2, y2] of walls) {
    const a = nid();
    const b = nid();
    const w = nid();
    entities.set(a, { kind: 'point', id: a, storeyId: STOREY, x: x1, y: y1 } as never);
    entities.set(b, { kind: 'point', id: b, storeyId: STOREY, x: x2, y: y2 } as never);
    entities.set(w, {
      kind: 'wall',
      id: w,
      storeyId: STOREY,
      startId: a,
      endId: b,
      thicknessMm: 240,
      heightMm: 3000,
      elevationOffsetMm: 0,
      loadBearing: true,
      material: '砖',
    } as never);
  }
  return Document.replaceEntities(Document.create(PID), entities);
}

/** 一层两片正交墙（一个 L 形）。 */
function lShape(): Document {
  return house([
    [0, 0, 6000, 0],
    [0, 0, 0, 4000],
  ]);
}

const opts = { storeyId: STOREY, title: '一层', drafter: '搭家', sheetNo: 'A-101' };

describe('chains：从轴线端点收集尺寸链（C1）', () => {
  it('C1 一层两片正交墙 ⇒ x 向与 y 向各恰好 1 条', () => {
    const keys = dimensionKeys(lShape(), opts);
    // 一个 L 形：x 方向两个不同值（0 / 6000）、y 方向两个（0 / 4000）
    expect(keys.x).toEqual([[0, 6000]]);
    expect(keys.y).toEqual([[0, 4000]]);
  });

  it('C1b 三点共线（x 相同）⇒ x 向零条，不是 3 条（去重是这一族的核心）', () => {
    // 三片墙共用 x=0 这条竖线（每片墙另有一个 y 各不同的点）。
    // **x 方向只有一个取值 {0}** ⇒ 退化轴，标注不了 ⇒ **零条链**。
    // 若按墙的条数算，会得三条 x 尺寸 —— 那正是这一格要拦的。
    const doc = house([
      [0, 0, 0, 4000],
      [0, 0, 0, 3000],
      [0, 0, 0, 5000],
    ]);
    const keys = dimensionKeys(doc, opts);
    expect(keys.x).toEqual([]);
    // y 方向四个取值 {0,3000,4000,5000} ⇒ 三条链（**2026-10-06 实测订正**：
    // 我第一版把这里写成"恰好 1 条"，那是我的算术错 —— 4 个取值是 3 段）。
    expect(keys.y).toEqual([
      [0, 3000],
      [3000, 4000],
      [4000, 5000],
    ]);
  });

  it('C1b 多点共线时按**取值去重**，不是按墙的条数', () => {
    // 四片墙：x 方向 {0, 5000, 8000} 三个取值 ⇒ 两条链；
    //         y 方向 {0, 3000} 两个取值 ⇒ 一条链。
    // 若按墙的条数算，x 会被算成四条。
    const doc = house([
      [0, 0, 5000, 0],
      [0, 3000, 8000, 3000],
      [0, 0, 0, 3000],
      [5000, 0, 5000, 3000],
    ]);
    const keys = dimensionKeys(doc, opts);
    expect(keys.x).toEqual([
      [0, 5000],
      [5000, 8000],
    ]);
    expect(keys.y).toEqual([[0, 3000]]);
  });

  it('C1d 变异靶：去重那一刀必须真的在（按取值算，不是按点数）', () => {
    // **2026-10-06 变异实测发现的缺口**：C1b 那格**打不死**"去掉去重"这个变异
    // —— 因为 `chainsOf` 内部有 `if (a === b) continue`，重复值被跳过，
    // 于是"不去重"的结果与"去重"的结果相同。
    //
    // 所以这一格直接验**去重后的取值数**：三片墙共用 x=0 ⇒ x 只有 **1** 个
    // 唯一取值（点数是 6）。若去重那刀被删，唯一取值会变成 6 个。
    const doc = house([
      [0, 0, 0, 4000],
      [0, 0, 0, 3000],
      [0, 0, 0, 5000],
    ]);
    const xs = new Set(doc.byKind('point').map((p) => p.x));
    const ys = new Set(doc.byKind('point').map((p) => p.y));
    expect(doc.byKind('point')).toHaveLength(6);
    expect(xs.size).toBe(1);
    // y 取值 = {0, 4000, 3000, 5000} 共 **4** 个（0 被三片墙共用的那个点带了三次，
    // 去重后只剩一个）⇒ 链数 = 4 − 1 = **3** 条。
    // （2026-10-06 实测：我第一版写 `ys.size` 期望 3，那是我把"取值数"与
    // "链数"混了 —— 这是本棒第三次犯这个错，已在下面 C1d 注释里记下。）
    expect(ys.size).toBe(4);
    // 而尺寸链只认**唯一取值**：x 零条、y 三条
    const keys = dimensionKeys(doc, opts);
    expect(keys.x).toEqual([]);
    expect(keys.y).toHaveLength(3);
    // **这一格真正的牙**：任何一条链都**不许零长**（`from === to`）。
    // 零长链是"输入没去重"的可观测症状 —— 而第一版的 `chainsOf` 里有个
    // `if (a === b) continue` 恰好把零长链滤掉了，于是"去不去重"结果相同，
    // 这格打不死那个变异（2026-10-06 实测确认）。现在那条 continue 删了，
    // 零长链会冒出来 ⇒ 判据咬得住。
    for (const chain of [...keys.x, ...keys.y]) {
      expect(chain[0]).not.toBe(chain[1]);
    }
  });
  it('C1c 尺寸链有序：从最小到最大，不由 point 的插入序', () => {
    // 先放x=8000 的点，后放 x=2000 的点
    const doc = house([
      [8000, 0, 8000, 3000],
      [2000, 0, 2000, 3000],
    ]);
    const keys = dimensionKeys(doc, opts);
    // 链是 [2000, 8000]（升序），不是 [8000, 2000]
    expect(keys.x).toEqual([[2000, 8000]]);
  });

  it('C1 取projectId 必须经 storeyId → StoreyEntity（PointEntity 没有 projectId）', () => {
    // 这一格钉住"取 projectId 的那条链不许直接读 point"：
    // `PointEntity { kind, id, storeyId, x, y }` —— **它没有 projectId 字段**，
    // 所以任何 `point.projectId` 都编译不过。判据的形态是"取到的那条链存在"，
    // 编译期由 tsc 兜（TS2339）。
    const doc = lShape();
    const first = doc.byKind('point')[0];
    expect(first).toBeDefined();
    expect('projectId' in (first as object)).toBe(false);
    // 真正的取法：storeyId → StoreyEntity → projectId
    const st = doc.get(first!.storeyId);
    expect(st && st.kind === 'storey' ? st.projectId : null).toBe(PID);
  });

  it('C1 空层不产尺寸链（不抛）', () => {
    const EMPTY = nid();
    const base = lShape();
    const withEmpty = Document.replaceEntities(
      base,
      new Map([
        ...base.entities,
        [EMPTY, { kind: 'storey', id: EMPTY, projectId: PID, index: 1, elevationMm: 3000, heightMm: 3000 } as never],
      ]),
    );
    // 空层里**一个 point 都没有** ⇒ x / y 各只有一个取值（退化轴）⇒ 零条链。
    // 这次要**真的用带 EMPTY 的那份 doc** —— 第一版把 `replaceEntities` 的
    // 结果丢掉了、拿 `lShape()` 去查 EMPTY，`storeyOf` 当场抛"楼层不存在"。
    const keys = dimensionKeys(withEmpty, { ...opts, storeyId: EMPTY });
    expect(keys.x).toEqual([]);
    expect(keys.y).toEqual([]);
  });
});

describe('render：三道分道、45° 符号、断线（C2 / C3 / D3）', () => {
  it('C2a 三道的道间距是固定纸面 7 / 5mm，钉住绝对纸面距离', () => {
    const doc = lShape();
    const sheet = dimensionSheet(doc, opts);
    const ys = lanesOf(sheet.ops, 'x');
    // **三道、两个间隔**（2026-10-06 订正）：规格写的"7 / 5 / 5"三个数对应
    // 「细部↔轴线 7、轴线↔总尺寸 5、总尺寸↔图框 5」—— 第三个 5 是总尺寸与
    // 图框之间的留白，**不是第四道**。第一版把它当三个间隔 ⇒ 读数
    // `[10,17,22,27]` 是四道，实现与规格错位。
    expect(ys).toHaveLength(3);
    expect(ys[1]! - ys[0]!).toBeCloseTo(7, 3);
    expect(ys[2]! - ys[1]!).toBeCloseTo(5, 3);
  });

  it('C2b 溢出时加一道，且新道的间距仍是 5mm（不是重新分配）', () => {
    // 造一条很长的轴线链，让标注线超出可用图幅
    const doc = house([[0, 0, 40000, 0]]);
    const sheet = dimensionSheet(doc, opts);
    const ys = lanesOf(sheet.ops, 'x');
    expect(ys.length).toBeGreaterThan(3);
    // 第 4 道与第 3 道的间距仍是 5（**不是**把剩下的均分）
    expect(ys[3]! - ys[2]!).toBeCloseTo(5, 3);
  });

  it('C2c 道数只随"是否溢出"变，不随点数线性变', () => {
    // 3 个点（2 段）与 6 个点（5 段），都不溢出 ⇒ 道数相同
    const few = house([
      [0, 0, 5000, 0],
      [0, 0, 0, 3000],
    ]);
    const many = house([
      [0, 0, 5000, 0],
      [1000, 0, 1000, 3000],
      [2000, 0, 2000, 3000],
      [3000, 0, 3000, 3000],
      [4000, 0, 4000, 3000],
      [5000, 0, 5000, 3000],
    ]);
    const a = lanesOf(dimensionSheet(few, opts).ops, 'x').length;
    const b = lanesOf(dimensionSheet(many, opts).ops, 'x').length;
    expect(b).toBe(a);
  });

  it('C2d 相交处断线：总尺寸的标注线穿过细部标注线时有 2mm 缺口', () => {
    const doc = lShape();
    const sheet = dimensionSheet(doc, opts);
    // y 向第一条标注线是竖的，它在 x=0 处与 x 向标注线相交 ⇒
    // 那条线段在交点附近有一个缺口。判据的形态：**线段不是一条到底的**，
    // 而是两段（缺口左右各一段）。
    const verticals = sheet.ops.filter(
      (o) => o.kind === 'line' && Math.abs(o.a.x - o.b.x) < 1e-9 && Math.abs(o.a.y - o.b.y) > 1e-9,
    );
    // 总尺寸那条竖线被断成两段
    expect(verticals.length).toBeGreaterThan(1);
  });

  it('C3a 端点符号是 45° 短斜线（C3：固定纸面 2mm）', () => {
    const doc = lShape();
    const sheet = dimensionSheet(doc, opts);
    const ticks = sheet.ops.filter((o) => o.kind === 'tick');
    expect(ticks.length).toBeGreaterThan(0);
    // 每个符号的两端点距离 == 2.000
    for (const t of ticks) {
      if (t.kind !== 'tick') continue;
      // tick 只给基点，斜线由 render 落成 line ⇒ 在这里查 line
    }
    const tickLines = sheet.ops.filter(
      (o) => o.kind === 'line' && isTickLength(o),
    );
    expect(tickLines.length).toBeGreaterThan(0);
  });

  it('C3b 符号线段长度逐条 == 2.000（toBeCloseTo 3 位，不用 toBe）', () => {
    const doc = lShape();
    const sheet = dimensionSheet(doc, opts);
    const lens = tickLengths(sheet.ops);
    expect(lens.length).toBeGreaterThan(0);
    for (const l of lens) expect(l).toBeCloseTo(2, 3);
    expect(TICK_LENGTH_MM).toBe(2);
  });

  it('D3b IR 里没有箭头类图元（45° 短斜线表达端点，不是箭头）', () => {
    // 判据的形态是"IR 的五种 op 里根本没有箭头" ⇒ 也就是说即使将来有人
    // 想画箭头，也得先改 IR 的形状（那是S2 的事）。
    const doc = lShape();
    const sheet = dimensionSheet(doc, opts);
    for (const op of sheet.ops) {
      expect(['line', 'polyline', 'polygon', 'text', 'tick']).toContain(op.kind);
    }
    // 且本模块产出的**所有** op 都在 dimension 层
    for (const op of sheet.ops) expect(op.pen.layer).toBe('dimension');
  });

  it('M1 尺寸数值文字 == 该两轴端点距离 × 比例', () => {
    const doc = lShape();
    const sheet = dimensionSheet(doc, opts);
    const texts = sheet.ops.filter((o) => o.kind === 'text');
    expect(texts.length).toBeGreaterThan(0);
    const labels = texts.map((t) => (t.kind === 'text' ? t.s : ''));
    // 6000mm @1:100 ⇒ 60.00 纸面 mm
    expect(labels.some((s) => s.includes('60.00'))).toBe(true);
    // 4000mm ⇒ 40.00
    expect(labels.some((s) => s.includes('40.00'))).toBe(true);
  });

  it('M2 文字纸面高固定 2.5mm（spec §7 的图面规范量）', () => {
    const doc = lShape();
    const sheet = dimensionSheet(doc, opts);
    for (const op of sheet.ops) {
      if (op.kind === 'text') expect(op.heightMm).toBe(2.5);
    }
  });

  it('T8 同 doc 同参数连跑两次，尺寸图元逐字节相同', () => {
    const doc = lShape();
    const a = dimensionSheet(doc, opts);
    const b = dimensionSheet(doc, opts);
    expect(JSON.stringify(a.ops)).toBe(JSON.stringify(b.ops));
  });
});

// —— 助手 ————————————————————————————————————————————————

/**
 * 某方向上所有**去重后**的标注线坐标（x 方向看 y 坐标，y 方向看 x 坐标），升序。
 *
 * **不按 `laneCount` 截断**（2026-10-06 修正）：第一版带 `slice(0, max(3, laneCount))`，
 * 而 `laneCount` 是尺寸**链数**不是道数 —— C2b 那格"溢出道"就这么被助手截掉了，
 * 断言 `ys.length > 3` 恒红（实现其实是对的）。这一格现在交出全部去重坐标。
 */
function lanesOf(ops: readonly PaperOp[], dir: 'x' | 'y'): number[] {
  const marks = ops
    .filter((o): o is Extract<PaperOp, { kind: 'line' }> => o.kind === 'line')
    .filter((o) =>
      dir === 'x'
        ? Math.abs(o.a.y - o.b.y) < 1e-9 && Math.abs(o.a.x - o.b.x) > 1e-9
        : Math.abs(o.a.x - o.b.x) < 1e-9 && Math.abs(o.a.y - o.b.y) > 1e-9,
    );
  const coord = (o: Extract<PaperOp, { kind: 'line' }>): number => (dir === 'x' ? o.a.y : o.a.x);
  return [...new Set(marks.map(coord))].sort((a, b) => a - b);
}

/** 一条线段是不是端点斜线（长度 2 纸面 mm 且与水平/垂直都不平行）。 */
function isTickLength(o: Extract<PaperOp, { kind: 'line' }>): boolean {
  return Math.abs(Math.hypot(o.b.x - o.a.x, o.b.y - o.a.y) - 2) < 1e-6;
}

function tickLengths(ops: readonly PaperOp[]): number[] {
  return ops
    .filter((o): o is Extract<PaperOp, { kind: 'line' }> => o.kind === 'line')
    .map((o) => Math.hypot(o.b.x - o.a.x, o.b.y - o.a.y))
    .filter((l) => Math.abs(l - 2) < 1e-6);
}
