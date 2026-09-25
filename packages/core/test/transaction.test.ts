import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  uuidv7,
  type Command,
  type EntityId,
  type PointEntity,
  type WallEntity,
} from '@dajia/core';

const storeyId = uuidv7();
const PID = (n: number) => `00000000-0000-7000-8000-00000000000${n}`;

function point(id: string, x: number, y: number): PointEntity {
  return { kind: 'point', id, storeyId, x, y };
}

function wall(id: string, startId: string, endId: string): WallEntity {
  return {
    kind: 'wall',
    id,
    storeyId,
    startId,
    endId,
    thicknessMm: 240,
    heightMm: 3000,
    elevationOffsetMm: 0,
    loadBearing: true,
    material: 'brick',
  };
}

function seed(): TransactionLog {
  const doc = Document.replaceEntities(
    Document.create(uuidv7()),
    new Map<string, PointEntity | WallEntity>([
      [PID(1), point(PID(1), 0, 0)],
      [PID(2), point(PID(2), 3600, 0)],
      [PID(3), wall(PID(3), PID(1), PID(2))],
    ]),
  );
  return new TransactionLog(doc);
}

const movePoint = (id: EntityId, x: number, y: number): Command => ({
  type: 'wall.moveEndpoint',
  build(doc) {
    const target = doc.get(id) as PointEntity;
    return { upsert: [{ ...target, x, y }], remove: [] };
  },
});

describe('TransactionLog', () => {
  it('dispatch 后可见新状态，affected 覆盖改动面', () => {
    const log = seed();
    log.dispatch(movePoint(PID(1), 100, 200));
    expect((log.document.get(PID(1)) as PointEntity).x).toBe(100);
    expect(log.affected).toEqual(new Set([PID(1)]));
    expect(log.canUndo).toBe(true);
    expect(log.canRedo).toBe(false);
  });

  it('undo 还原并开 redo', () => {
    const log = seed();
    const before = log.document.canonical();
    log.dispatch(movePoint(PID(1), 100, 200));
    expect(log.undo()).toBe(true);
    expect(log.document.canonical()).toBe(before);
    expect(log.canRedo).toBe(true);
  });

  it('undo/redo 的 affected 跟着被撤/被重做的那笔走', () => {
    const setThickness = (): Command => ({
      type: 'wall.setThickness',
      build(doc) {
        const w = doc.get(PID(3)) as WallEntity;
        return { upsert: [{ ...w, thicknessMm: 120 }], remove: [] };
      },
    });
    const log = seed();
    log.dispatch(movePoint(PID(1), 100, 200));
    log.dispatch(setThickness());
    expect(log.affected).toEqual(new Set([PID(3)]));
    expect(log.undo()).toBe(true);
    expect(log.undo()).toBe(true);
    // 撤到第一笔：不随 undo 刷新的话这里会停在 {PID(3)}
    expect(log.affected).toEqual(new Set([PID(1)]));
    expect(log.redo()).toBe(true);
    expect(log.redo()).toBe(true);
    expect(log.affected).toEqual(new Set([PID(3)]));
  });

  it('redo 再应用，与不撤销等价', () => {
    const log = seed();
    log.dispatch(movePoint(PID(1), 100, 200));
    const moved = log.document.canonical();
    log.undo();
    expect(log.redo()).toBe(true);
    expect(log.document.canonical()).toBe(moved);
  });

  it('新命令清空 redo 栈（撤销后改一笔，原分支不可再 redo）', () => {
    const log = seed();
    log.dispatch(movePoint(PID(1), 100, 200));
    log.undo();
    log.dispatch(movePoint(PID(2), 500, 500));
    expect(log.canRedo).toBe(false);
    expect(log.redo()).toBe(false);
  });

  it('空栈 undo/redo 返回 false，不抛', () => {
    const log = seed();
    expect(log.undo()).toBe(false);
    expect(log.redo()).toBe(false);
    expect(log.depth).toBe(0);
  });

  it('连撤 30 步回到起点，连重做 30 步回到末尾（S1 验收 2 的前置）', () => {
    const log = seed();
    const before = log.document.canonical();
    for (let i = 0; i < 30; i++) {
      log.dispatch(movePoint(PID(1), i * 10, i * 20));
    }
    for (let i = 0; i < 30; i++) {
      expect(log.undo()).toBe(true);
    }
    expect(log.document.canonical()).toBe(before);
    expect(log.depth).toBe(0);
    for (let i = 0; i < 30; i++) {
      expect(log.redo()).toBe(true);
    }
    for (let i = 0; i < 30; i++) {
      log.undo();
    }
    expect(log.document.canonical()).toBe(before);
  });

  it('命令 build 抛错时不留半条事务记录', () => {
    const log = seed();
    const before = log.document.canonical();
    const boom: Command = {
      type: 'wall.delete',
      build() {
        throw new TypeError('故意失败');
      },
    };
    expect(() => log.dispatch(boom)).toThrow(/故意失败/);
    expect(log.document.canonical()).toBe(before);
    expect(log.depth).toBe(0);
  });
});
