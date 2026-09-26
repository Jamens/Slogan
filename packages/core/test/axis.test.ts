import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  awayDir,
  cornerPoint,
  endPoint,
  endPointId,
  otherEnd,
  wallAxisById,
  storeyCreate,
  uuidv7,
  wallCreate,
  type PointEntity,
} from '@dajia/core';

const projectId = uuidv7();

function buildWalls(
  specs: Array<{ start: { x: number; y: number }; end: { x: number; y: number }; thicknessMm: number }>,
) {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  const storeyId = log.document.byKind('storey')[0]!.id;
  for (const s of specs) {
    log.dispatch(wallCreate({ storeyId, heightMm: 3000, ...s }));
  }
  return { log, storeyId };
}

function axisOf(log: TransactionLog, i: number) {
  const wall = log.document.byKind('wall')[i]!;
  return wallAxisById(log.document, wall.id);
}

describe('WallAxis', () => {
  it('正交墙：dir 与 normal 单位正交，lengthMm 精确', () => {
    const { log } = buildWalls([{ start: { x: 0, y: 0 }, end: { x: 3600, y: 0 }, thicknessMm: 240 }]);
    const axis = axisOf(log, 0);
    expect(axis.start).toEqual({ x: 0, y: 0 });
    expect(axis.end).toEqual({ x: 3600, y: 0 });
    expect(axis.dir).toEqual({ x: 1, y: 0 });
    expect(axis.normal).toEqual({ x: 0, y: 1 });
    expect(axis.lengthMm).toBe(3600);
    expect(axis.thicknessMm).toBe(240);
    expect(axis.storeyId).toBe(log.document.byKind('storey')[0]!.id);
  });

  it('斜墙：lengthMm 是浮点，不谎报整数', () => {
    const { log } = buildWalls([{ start: { x: 0, y: 0 }, end: { x: 1000, y: 1000 }, thicknessMm: 200 }]);
    const axis = axisOf(log, 0);
    expect(axis.lengthMm).toBeCloseTo(Math.SQRT2 * 1000, 9);
    expect(Number.isInteger(axis.lengthMm)).toBe(false);
    // 单位向量：长度 1，分量各 0.707…
    expect(Math.hypot(axis.dir.x, axis.dir.y)).toBeCloseTo(1, 12);
  });

  it('反向墙：dir 跟着起终点走，normal 始终逆时针 90°', () => {
    const { log } = buildWalls([{ start: { x: 3600, y: 0 }, end: { x: 0, y: 0 }, thicknessMm: 240 }]);
    const axis = axisOf(log, 0);
    expect(axis.dir).toEqual({ x: -1, y: 0 });
    expect(axis.normal).toEqual({ x: 0, y: -1 });
  });

  it('otherEnd / endPoint / awayDir 三件套自洽', () => {
    const { log } = buildWalls([{ start: { x: 0, y: 0 }, end: { x: 4000, y: 0 }, thicknessMm: 240 }]);
    const axis = axisOf(log, 0);
    const wall = log.document.byKind('wall')[0]!;
    expect(otherEnd('start')).toBe('end');
    expect(otherEnd('end')).toBe('start');
    expect(endPointId(wall, 'start')).toBe(wall.startId);
    expect(endPointId(wall, 'end')).toBe(wall.endId);
    expect(endPointId(wall, otherEnd('start'))).toBe(wall.endId);
    expect(endPoint(axis, 'start')).toEqual({ x: 0, y: 0 });
    expect(endPoint(axis, 'end')).toEqual({ x: 4000, y: 0 });
    // awayDir 从该端点指向墙内部：start 端朝 +x，end 端朝 -x
    expect(awayDir(axis, 'start')).toEqual({ x: 1, y: 0 });
    expect(awayDir(axis, 'end')).toEqual({ x: -1, y: 0 });
    expect(awayDir(axis, 'start')).not.toBe(awayDir(axis, 'end'));
    expect(wall.startId).not.toBe(wall.endId);
  });

  it('cornerPoint：trim=0 时是平接四角，trim>0 时沿轴内退', () => {
    const { log } = buildWalls([{ start: { x: 0, y: 0 }, end: { x: 4000, y: 0 }, thicknessMm: 240 }]);
    const axis = axisOf(log, 0);
    expect(cornerPoint(axis, 'start', 1, 0)).toEqual({ x: 0, y: 120 });
    expect(cornerPoint(axis, 'start', -1, 0)).toEqual({ x: 0, y: -120 });
    expect(cornerPoint(axis, 'end', 1, 0)).toEqual({ x: 4000, y: 120 });
    // start 端内退 120：x 增大；end 端内退 120：x 减小。两侧同号才不串。
    expect(cornerPoint(axis, 'start', 1, 120)).toEqual({ x: 120, y: 120 });
    expect(cornerPoint(axis, 'end', 1, 120)).toEqual({ x: 3880, y: 120 });
  });

  it('cornerPoint 在斜墙上仍落在两侧边线上（用 normal 分量核验）', () => {
    const { log } = buildWalls([{ start: { x: 0, y: 0 }, end: { x: 3000, y: 4000 }, thicknessMm: 200 }]);
    const axis = axisOf(log, 0);
    const c = cornerPoint(axis, 'end', 1, 100);
    // 该点到轴线的垂直距离必须等于半厚 100
    const along = ((c.x - axis.start.x) * axis.dir.x + (c.y - axis.start.y) * axis.dir.y);
    const perpDist = Math.abs(
      (c.x - axis.start.x) * axis.normal.x + (c.y - axis.start.y) * axis.normal.y,
    );
    expect(perpDist).toBeCloseTo(100, 9);
    expect(along).toBeCloseTo(Math.hypot(3000, 4000) - 100, 9);
  });

  it('端点实体缺失时抛，而不是返回 NaN 几何', () => {
    const { log, storeyId } = buildWalls([{ start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, thicknessMm: 50 }]);
    const wall = log.document.byKind('wall')[0]!;
    // 手工构造一个"墙指着不存在的点"的文档：Document.replaceEntities 不校验引用完整性
    const broken = Document.replaceEntities(
      log.document,
      new Map([...log.document.entities].filter(([id]) => id !== wall.startId)),
    );
    expect(() => wallAxisById(broken, wall.id)).toThrow(/墙起点 不存在/);
    expect(storeyId).toBeTruthy();
  });

  it('两端点重合的墙抛零方向（防 normalize 崩在别处）', () => {
    const log = new TransactionLog(Document.create(projectId));
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    const storeyId = log.document.byKind('storey')[0]!.id;
    const shared = '00000000-0000-7000-8000-000000000077';
    const p: PointEntity = { kind: 'point', id: shared, storeyId, x: 5, y: 5 };
    const doc = Document.replaceEntities(log.document, new Map([...log.document.entities, [shared, p]]));
    const degenerate = {
      kind: 'wall' as const,
      id: '00000000-0000-7000-8000-000000000078',
      storeyId,
      startId: shared,
      endId: shared,
      thicknessMm: 100,
      heightMm: 3000,
      elevationOffsetMm: 0,
      loadBearing: true,
      material: 'brick',
    };
    const bad = Document.replaceEntities(doc, new Map([...doc.entities, [degenerate.id, degenerate]]));
    expect(() => wallAxisById(bad, degenerate.id)).toThrow(/两端点重合|零长/);
  });
});
