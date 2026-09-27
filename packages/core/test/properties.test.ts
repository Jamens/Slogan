import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  quantizeMm,
  storeyCreate,
  uuidv7,
  wallCreate,
  wallDelete,
  wallMoveEndpoint,
  wallSetThickness,
  type WallCreateInput,
  type WallEntity,
} from '@dajia/core';
import { arbThickness, arbWallShape } from './arbitraries';

type WallShape = Omit<WallCreateInput, 'storeyId'>;

function freshStorey(): { log: TransactionLog; storeyId: string } {
  const projectId = uuidv7();
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  return { log, storeyId: log.document.byKind('storey')[0]!.id };
}

function withStorey(storeyId: string, shape: WallShape): WallCreateInput {
  return { storeyId, ...shape };
}

/**
 * 取刚 dispatch 出来的那面墙。不许用 `byKind('wall').at(-1)`：byKind 按 id 升序，
 * 同毫秒的 uuidv7 不保证有序，at(-1) 拿到的是"id 最大的墙"而不是"刚建的墙"。
 */
function wallJustCreated(log: TransactionLog): WallEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new TypeError('最近一次 dispatch 没有新建墙');
}

/** 点的坐标：靠判别式而不是 cast。点不在真源里就抛，别让下一行炸成 undefined.x。 */
function pointXY(log: TransactionLog, id: string): { x: number; y: number } {
  const entity = log.document.get(id);
  if (entity?.kind !== 'point') throw new TypeError(`真源里点 ${id} 不存在或不是 point`);
  return { x: entity.x, y: entity.y };
}

/**
 * 反例哨兵。随机样本不可复现，属性测试红过之后必须把 Counterexample 抄成写死的用例，
 * 否则下一次改代码它可能再也随机不到。这里先钉两条生成器边界。
 */
const REGRESSIONS: Array<{ note: string; shape: WallShape }> = [
  {
    note: '轴长下界 2000 配墙厚上界 500：thickness < length 的临界仍须放行',
    shape: { start: { x: 0, y: 0 }, end: { x: 2000, y: 0 }, thicknessMm: 500, heightMm: 1000 },
  },
  {
    note: '45° 斜墙：偏移取整后轴长 1999mm，墙厚 500 仍小于它',
    shape: { start: { x: 0, y: 0 }, end: { x: 1414, y: 1414 }, thicknessMm: 500, heightMm: 6000 },
  },
];

describe('反例哨兵', () => {
  it.each(REGRESSIONS)('$note', ({ shape }) => {
    const { log, storeyId } = freshStorey();
    const before = log.document.canonical();
    log.dispatch(wallCreate(withStorey(storeyId, shape)));
    const wall = log.document.byKind('wall')[0]!;
    expect(wall.thicknessMm).toBe(shape.thicknessMm);
    expect(log.undo()).toBe(true);
    expect(log.document.canonical()).toBe(before);
  });
});

describe('不变式 1：quantizeMm 幂等', () => {
  it('有界范围内任意浮点，量化两次与一次相同', () => {
    let executed = 0;
    fc.assert(
      fc.property(fc.double({ min: -1e12, max: 1e12, noNaN: true }), (v) => {
        executed++;
        expect(quantizeMm(quantizeMm(v))).toBe(quantizeMm(v));
      }),
      { numRuns: 2000 },
    );
    expect(executed).toBe(2000);
  });
});

describe('不变式 2：随机命令序列全撤销后逐字节还原', () => {
  it('建若干墙 → 随机改端点/改厚/删墙/加墙 → 全撤 → canonical 回到初始', () => {
    let executed = 0;
    fc.assert(
      fc.property(
        fc.array(arbWallShape, { minLength: 1, maxLength: 8 }),
        fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 0, maxLength: 20 }),
        (shapes, editPicks) => {
          executed++;
          const { log, storeyId } = freshStorey();
          // 只撤本次序列，不越过建楼层那笔：baseline 之下的栈是测试的准备动作
          const baseline = log.depth;
          const initial = log.document.canonical();

          for (const shape of shapes) log.dispatch(wallCreate(withStorey(storeyId, shape)));
          expect(log.document.canonical()).not.toBe(initial);

          for (const pick of editPicks) {
            const walls = log.document.byKind('wall');
            if (walls.length === 0) break;
            const target = walls[pick % walls.length]!;
            if (pick === 0) {
              // 相对锚点偏移，保证永不可能与另一端点重合（否则命令层会抛）
              const anchor = pointXY(log, target.startId);
              log.dispatch(
                wallMoveEndpoint({
                  wallId: target.id,
                  end: 'end',
                  x: anchor.x + 1000,
                  y: anchor.y + 700,
                }),
              );
            } else if (pick === 1) {
              log.dispatch(wallSetThickness({ wallId: target.id, thicknessMm: 120 }));
            } else if (pick === 2) {
              log.dispatch(wallDelete({ wallId: target.id }));
            } else {
              log.dispatch(
                wallCreate({
                  storeyId,
                  start: { x: 0, y: 0 },
                  end: { x: 5000, y: 0 },
                  thicknessMm: 240,
                  heightMm: 3000,
                }),
              );
            }
          }

          let guard = 0;
          while (log.depth > baseline && guard++ < 500) log.undo();
          expect(guard).toBeLessThan(500);
          expect(log.depth).toBe(baseline);
          expect(log.document.canonical()).toBe(initial);
        },
      ),
      { numRuns: 300 },
    );
    expect(executed).toBe(300);
  });

  // Counterexample 抄成写死的用例：属性测试红过之后必须留下哨兵，
  // 否则下次改动可能再也随机不到同一条路径。
  it('哨兵：一面墙、零编辑，撤销不得越过准备动作', () => {
    const { log, storeyId } = freshStorey();
    const baseline = log.depth;
    const initial = log.document.canonical();
    log.dispatch(
      wallCreate({
        storeyId,
        start: { x: 0, y: 0 },
        end: { x: 2000, y: 0 },
        thicknessMm: 50,
        heightMm: 1000,
      }),
    );
    expect(log.depth).toBe(baseline + 1);
    expect(log.undo()).toBe(true);
    expect(log.depth).toBe(baseline);
    expect(log.document.canonical()).toBe(initial);
    // baseline 之下还剩建楼层那笔：再撤一次就到空文档
    expect(log.canUndo).toBe(true);
    log.undo();
    expect(log.document.entities.size).toBe(0);
  });
});

describe('不变式 3：单步 dispatch → undo 等价于没发生', () => {
  it('wallCreate 后 undo 回到建墙前', () => {
    fc.assert(
      fc.property(arbWallShape, (shape) => {
        const { log, storeyId } = freshStorey();
        const before = log.document.canonical();
        log.dispatch(wallCreate(withStorey(storeyId, shape)));
        log.undo();
        expect(log.document.canonical()).toBe(before);
      }),
      { numRuns: 300 },
    );
  });

  it('wallSetThickness 后 undo → redo 与不撤销相同', () => {
    fc.assert(
      fc.property(arbWallShape, arbThickness, (shape, thickness) => {
        const { log, storeyId } = freshStorey();
        log.dispatch(wallCreate(withStorey(storeyId, shape)));
        const wall = log.document.byKind('wall')[0]!;
        log.dispatch(wallSetThickness({ wallId: wall.id, thicknessMm: thickness }));
        const after = log.document.canonical();
        expect(log.undo()).toBe(true);
        expect(log.redo()).toBe(true);
        expect(log.document.canonical()).toBe(after);
      }),
      { numRuns: 300 },
    );
  });

  it('wallDelete 后 undo 找回墙与其端点', () => {
    fc.assert(
      fc.property(arbWallShape, (shape) => {
        const { log, storeyId } = freshStorey();
        log.dispatch(wallCreate(withStorey(storeyId, shape)));
        const before = log.document.canonical();
        const wall = log.document.byKind('wall')[0]!;
        log.dispatch(wallDelete({ wallId: wall.id }));
        expect(log.document.canonical()).not.toBe(before);
        log.undo();
        expect(log.document.canonical()).toBe(before);
      }),
      { numRuns: 300 },
    );
  });
});

describe('不变式 4：没有旁路能把非法值写进真源', () => {
  /** 非整数偏移：量化前后必不相同，用来暴露"忘了调 quantizeMm"的旁路 */
  const FRACTIONAL_OFFSETS: Array<{ dx: number; dy: number }> = [
    { dx: 999.6, dy: 700.4 },
    { dx: -800.4, dy: 1500.6 },
    { dx: 1500.25, dy: -1100.4 },
    { dx: -1200.5, dy: -900.5 },
  ];

  it('随机序列跑完，每个整数毫米字段（含点的 x/y）都仍是安全整数', () => {
    let executed = 0;
    let fractionalInputs = 0;
    fc.assert(
      fc.property(fc.array(arbWallShape, { minLength: 1, maxLength: 6 }), (shapes) => {
        executed++;
        const { log, storeyId } = freshStorey();
        for (const [i, shape] of shapes.entries()) {
          if (!Number.isInteger(shape.start.x) || !Number.isInteger(shape.end.y)) {
            fractionalInputs++;
          }
          log.dispatch(wallCreate(withStorey(storeyId, shape)));
          const wall = wallJustCreated(log);
          const anchor = pointXY(log, wall.startId);
          // 同样用相对锚点偏移：绝对坐标有极小概率正好落在 start 上，命令层会抛零长墙，
          // 那是生成器的运气问题不是被测代码的缺陷，不该让它变成红测试。
          const { dx, dy } = FRACTIONAL_OFFSETS[i % FRACTIONAL_OFFSETS.length]!;
          log.dispatch(
            wallMoveEndpoint({ wallId: wall.id, end: 'end', x: anchor.x + dx, y: anchor.y + dy }),
          );
          // 移动端点不新建墙：读回来必须还是同一面。这里若换成 wallJustCreated 会抛，
          // 那本身就是"wallMoveEndpoint 只改点不改墙"的断言。
          const grown = log.document.get(wall.id);
          if (grown?.kind !== 'wall') throw new TypeError(`墙 ${wall.id} 拉伸后读不回来`);
          log.dispatch(wallSetThickness({ wallId: grown.id, thicknessMm: 50 }));
        }
        for (const entity of log.document.entities.values()) {
          const record = entity as unknown as Record<string, unknown>;
          for (const [key, value] of Object.entries(record)) {
            // 点的 x/y 也在这里：字段名不带 Mm 后缀，靠后缀扫会整条漏掉
            const isMmField =
              key.endsWith('Mm') || (entity.kind === 'point' && (key === 'x' || key === 'y'));
            if (!isMmField) continue;
            expect(typeof value).toBe('number');
            expect(Number.isSafeInteger(value)).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
    expect(executed).toBe(200);
    // 正对照：生成器若哪天不再产浮点，上面那条扫描就成了空跑
    expect(fractionalInputs).toBeGreaterThan(0);
  });
});
