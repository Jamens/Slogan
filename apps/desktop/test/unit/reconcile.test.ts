import { describe, expect, it } from 'vitest';
import {
  Document,
  type Entity,
  type EntityId,
  type StoreyEntity,
  type WallEntity,
} from '@dajia/core';
import {
  MISMATCH_REPORT_CAP,
  diffDocAgainstElement,
  diffStoreyIdColumn,
  diffStoreyProjection,
  formatMismatches,
  reconcileProjection,
  storeyIdOf,
  type ElementRowView,
  type StoreyRowView,
} from '../../src/main/db/reconcile';

const PID = '0193aa00-0000-7000-8000-00000000000a';
const S1 = '0193aa00-0000-7000-8000-000000000001';
const P1 = '0193aa00-0000-7000-8000-000000000002';
const P2 = '0193aa00-0000-7000-8000-000000000003';
const W1 = '0193aa00-0000-7000-8000-000000000004';
const W2 = '0193aa00-0000-7000-8000-00000000000c';
const GHOST = '0193bb00-0000-7000-8000-000000000001';

const storey: StoreyEntity = {
  kind: 'storey',
  id: S1,
  projectId: PID,
  index: 0,
  elevationMm: 0,
  heightMm: 3000,
};
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
const doc = Document.replaceEntities(
  Document.create(PID),
  new Map<EntityId, Entity>([
    [S1, storey],
    [W1, wall],
  ]),
);

/**
 * 平账的那份"盘上应该长什么样"由真源现推，不手抄 —— 手抄的基线会跟着夹具一起漂，
 * 那一型本档抓不住（`storeyIdOf` 就是写列与审列共用的那份规则，见 T5-M14）。
 */
function flatElementRows(): ElementRowView[] {
  return [...doc.entities.values()].map((entity) => ({
    id: entity.id,
    storeyId: storeyIdOf(entity),
    entity,
  }));
}
function flatStoreyRows(): StoreyRowView[] {
  return [
    { id: S1, indexNo: storey.index, elevationMm: storey.elevationMm, heightMm: storey.heightMm },
  ];
}
function withoutId(rows: readonly ElementRowView[], id: EntityId): ElementRowView[] {
  return rows.filter((r) => r.id !== id);
}

describe('平账的形状', () => {
  it('盘上照抄真源时，三对都是空', () => {
    expect(reconcileProjection(doc, flatElementRows(), flatStoreyRows())).toEqual([]);
  });

  it('storeyIdOf：楼层自己就是层 ⇒ null；别的四类 ⇒ 带着自己的 storeyId', () => {
    expect(storeyIdOf(storey)).toBeNull();
    expect(storeyIdOf(wall)).toBe(S1);
  });
});

describe('element ↔ storey（P-7 的投影）', () => {
  it('storey 表少一行 ⇒ 只在左侧（element 有楼层行，storey 表没有）', () => {
    expect(diffStoreyProjection([storey], [])).toEqual([
      { pair: 'element↔storey', id: S1, problem: 'left-only', fields: [] },
    ]);
  });

  it('storey 表多一行 ⇒ 只在右侧（投影漂的另一半）', () => {
    const ghost: StoreyRowView = { id: GHOST, indexNo: 0, elevationMm: 0, heightMm: 3000 };
    expect(diffStoreyProjection([], [ghost])).toEqual([
      { pair: 'element↔storey', id: GHOST, problem: 'right-only', fields: [] },
    ]);
  });

  it('标高差 1 毫米也要点名是哪个字段（整行比会把这条线索抹掉）', () => {
    const row: StoreyRowView = { id: S1, indexNo: 0, elevationMm: 1, heightMm: 3000 };
    expect(diffStoreyProjection([storey], [row])).toEqual([
      { pair: 'element↔storey', id: S1, problem: 'differs', fields: ['elevationMm'] },
    ]);
  });

  it('序号、标高、层高各归各的字段：三处一起漂就报三个名字，且按名序', () => {
    const row: StoreyRowView = { id: S1, indexNo: 7, elevationMm: -300, heightMm: 2900 };
    expect(diffStoreyProjection([storey], [row])).toEqual([
      {
        pair: 'element↔storey',
        id: S1,
        problem: 'differs',
        fields: ['elevationMm', 'heightMm', 'indexNo'],
      },
    ]);
  });

  it('-0 与 0 不算相等（Object.is 口径；与 codec 侧"盘上不存 -0"的实测互补）', () => {
    const negative: StoreyEntity = { ...storey, elevationMm: -0 };
    expect(diffStoreyProjection([negative], flatStoreyRows())).toEqual([
      { pair: 'element↔storey', id: S1, problem: 'differs', fields: ['elevationMm'] },
    ]);
  });
});

describe('element.storey_id 列 ↔ 同一行的 payload', () => {
  it('列指错层 ⇒ 抓到（idx_storey_kind 会静默少查一面墙，那一型没人看得见）', () => {
    const rows: ElementRowView[] = [{ id: W1, storeyId: P1, entity: wall }];
    expect(diffStoreyIdColumn(rows)).toEqual([
      { pair: 'element.storey_id↔payload', id: W1, problem: 'differs', fields: ['storeyId'] },
    ]);
  });

  it('楼层行把 storey_id 写成了自己的 id ⇒ 抓到（该为 null 的那一型）', () => {
    const rows: ElementRowView[] = [{ id: S1, storeyId: S1, entity: storey }];
    expect(diffStoreyIdColumn(rows)).toEqual([
      { pair: 'element.storey_id↔payload', id: S1, problem: 'differs', fields: ['storeyId'] },
    ]);
  });
});

describe('文档 ↔ element', () => {
  it('文档多一发（渲染器画了但那一发没落盘）⇒ 只在左侧', () => {
    const extra: WallEntity = { ...wall, id: W2, loadBearing: false };
    const bigger = Document.replaceEntities(
      doc,
      new Map<EntityId, Entity>([
        [S1, storey],
        [W1, wall],
        [W2, extra],
      ]),
    );
    expect(diffDocAgainstElement(bigger, flatElementRows())).toEqual([
      { pair: 'document↔element', id: W2, problem: 'left-only', fields: [] },
    ]);
  });

  it('盘上残留一行（文档已经删了）⇒ 只在右侧', () => {
    const extra: WallEntity = { ...wall, id: W2, loadBearing: false };
    expect(
      diffDocAgainstElement(doc, [...flatElementRows(), { id: W2, storeyId: S1, entity: extra }]),
    ).toEqual([{ pair: 'document↔element', id: W2, problem: 'right-only', fields: [] }]);
  });

  it('同一 id 的 payload 字段不等 ⇒ 报字段名', () => {
    const rows = flatElementRows().map((r) =>
      r.id === W1 ? { ...r, entity: { ...wall, thicknessMm: 240 } } : r,
    );
    expect(diffDocAgainstElement(doc, rows)).toEqual([
      { pair: 'document↔element', id: W1, problem: 'differs', fields: ['thicknessMm'] },
    ]);
  });

  it('键序不同不算漂（判据取键集合，不是 stringify 出来的串）', () => {
    const shuffled: Entity = {
      thicknessMm: 200,
      material: '混凝土',
      endId: P2,
      startId: P1,
      elevationOffsetMm: 0,
      loadBearing: true,
      heightMm: 2800,
      kind: 'wall',
      storeyId: S1,
      id: W1,
    };
    const rows = [...withoutId(flatElementRows(), W1), { id: W1, storeyId: S1, entity: shuffled }];
    expect(diffDocAgainstElement(doc, rows)).toEqual([]);
  });

  it('文档侧的 -0 也抓到（与投影侧同一口径）', () => {
    const negative: StoreyEntity = { ...storey, elevationMm: -0 };
    const rows = [...withoutId(flatElementRows(), S1), { id: S1, storeyId: null, entity: negative }];
    expect(diffDocAgainstElement(doc, rows)).toEqual([
      { pair: 'document↔element', id: S1, problem: 'differs', fields: ['elevationMm'] },
    ]);
  });
});

describe('合成与报告文案', () => {
  it('超出上限只列前 12 处，但把总数说全（对账结果要进日志，条数不许骗人）', () => {
    const ghosts: StoreyRowView[] = [];
    for (let i = 0; i < 15; i += 1) {
      ghosts.push({
        id: `0193bb00-0000-7000-8000-0000000000${String(i).padStart(2, '0')}`,
        indexNo: 0,
        elevationMm: 0,
        heightMm: 3000,
      });
    }
    const mismatches = diffStoreyProjection([], ghosts);
    expect(mismatches).toHaveLength(15);
    const text = formatMismatches(PID, mismatches);
    expect(text).toContain('15 处');
    expect(text).toContain(`另有 ${String(15 - MISMATCH_REPORT_CAP)} 处未列出`);
    expect(text.split('\n').filter((l) => l.startsWith('  - '))).toHaveLength(MISMATCH_REPORT_CAP);
    expect(text).toContain('command_log');
  });

  it('平账时不产出任何条目行（repository 只在 length > 0 时才调它，这一格证它自己不编话）', () => {
    const lines = formatMismatches(PID, []).split('\n');
    expect(lines.filter((l) => l.startsWith('  - '))).toEqual([]);
    expect(lines[0]).toContain(PID);
  });

  it('给人读的那半行也有归属：PAIR_TEXT / PROBLEM_TEXT 的两句原话真进了文案', () => {
    // 其余对账用例断的都是 `pair` 的原形标签（`/element↔storey/` 那一族），六句人类文案零证人。
    // 这一格只补归属，不动任何判据：文案漂了（改字、漏字、整张表换掉）红在这里，而不是红在"没人读得懂"。
    const rows = flatElementRows().map((r) =>
      r.id === W1 ? { ...r, entity: { ...wall, thicknessMm: 240 } } : r,
    );
    const text = formatMismatches(PID, diffDocAgainstElement(doc, rows));
    expect(text).toContain('文档（真源）↔ element 投影');
    expect(text).toContain('同 id 的字段不等');
    expect(text).toContain('thicknessMm');
  });

  it('输出顺序确定：先按对、再按 id（两份日志要能人肉比对）', () => {
    const extra: WallEntity = { ...wall, id: W2, loadBearing: false };
    // 三对定序里**中间那一支**（`element.storey_id↔payload`）以前从来没进过断言：那两行只造出
    // document↔element 与 element↔storey 两对，中间那一支删掉也不会有格红。
    // 现在 W1 这一行的列指到别人的点（P1）上、payload 一个字不动 ⇒ 只有行内自比看得见它。
    // 定序由名字决定：'.' (0x2E) 排在 '↔' 之前 ⇒ document↔element、element.storey_id↔payload、element↔storey。
    const rows = [
      ...flatElementRows().map((r) => (r.id === W1 ? { ...r, storeyId: P1 } : r)),
      { id: W2, storeyId: S1, entity: extra },
    ];
    const storeyRows = [...flatStoreyRows(), { id: GHOST, indexNo: 0, elevationMm: 0, heightMm: 3000 }];
    expect(reconcileProjection(doc, rows, storeyRows).map((m) => `${m.pair}|${m.id}`)).toEqual([
      `document↔element|${W2}`,
      `element.storey_id↔payload|${W1}`,
      `element↔storey|${GHOST}`,
    ]);
  });
});
