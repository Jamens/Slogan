import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  affectedIds,
  applyPatch,
  uuidv7,
  type Command,
  type EntityId,
  type Patch,
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

  it('lastPatch：新 log 是 null，dispatch 之后是这一发的正向补丁', () => {
    const log = seed();
    expect(log.lastPatch).toBeNull();
    log.dispatch(movePoint(PID(1), 100, 200));
    expect(log.lastPatch).toEqual({ upsert: [point(PID(1), 100, 200)], remove: [] });
  });

  it('lastPatch：undo 记的是**逆补丁**，不是 undoStack 顶上那份原件', () => {
    const log = seed();
    log.dispatch(movePoint(PID(1), 100, 200));
    const beforeUndo = log.document;
    expect(log.undo()).toBe(true);
    const patch = log.lastPatch;
    if (!patch) throw new TypeError('撤销之后 lastPatch 不该是 null');
    // 形状：撤销那一发把 x 从 100 抬回 0。
    expect(patch).toEqual({ upsert: [point(PID(1), 0, 0)], remove: [] });
    // 功能：把它应用到"撤销前"的文档，得到的就是"撤销后"的文档 —— 记的确实是打过的那一发。
    expect(applyPatch(beforeUndo, patch).doc.canonical()).toBe(log.document.canonical());
  });

  it('lastPatch：redo 之后又是正向补丁，且与 dispatch 那发逐字相同', () => {
    const log = seed();
    log.dispatch(movePoint(PID(1), 100, 200));
    const forward = log.lastPatch;
    // `lastPatch` 不存在时它是 `undefined`，而 `undefined` 与 `undefined` 恒等 ⇒
    // 下面那道 `toEqual(forward)` 在"没这个功能"时**也会绿**。这一格因此自己先钉住
    // "它是一个真补丁"，再比相等。
    if (!forward) throw new TypeError('dispatch 之后 lastPatch 不该是空');
    expect(forward.upsert).toEqual([point(PID(1), 100, 200)]);
    log.undo();
    expect(log.redo()).toBe(true);
    const afterRedo = log.lastPatch;
    if (!afterRedo) throw new TypeError('redo 之后 lastPatch 不该是空');
    expect(afterRedo).toEqual(forward);
  });

  it('lastPatch：空栈 undo/redo 返回 false 时不刷（没有"成功落地"就没得报）', () => {
    const log = seed();
    log.dispatch(movePoint(PID(1), 100, 200));
    const patch = log.lastPatch;
    if (!patch) throw new TypeError('dispatch 之后 lastPatch 不该是空');
    expect(log.undo()).toBe(true);
    // 第一格先钉住"成功落地会刷"：undo 产出的是**逆补丁**（P-5 口径，x 抬回 0），
    // 不是 dispatch 那发原件 —— 这一条是下面两格"不刷"的前提。
    const afterUndo = log.lastPatch;
    if (!afterUndo) throw new TypeError('撤销之后 lastPatch 不该是空');
    expect(afterUndo.upsert).toEqual([point(PID(1), 0, 0)]);
    // 空栈那一次：不许动 lastPatch。**与 `patch` 比**（"刚才那次成功的落地的结果"），
    // 而不是与 `afterUndo` 比 —— 后者只在"空栈调用顺手刷了"时也成立，恒真。
    expect(log.undo()).toBe(false);
    expect(log.lastPatch).toEqual(afterUndo);
    expect(log.redo()).toBe(true);
    const afterRedo = log.lastPatch;
    if (!afterRedo) throw new TypeError('重做之后 lastPatch 不该是空');
    expect(afterRedo).toEqual(patch);
    // 同样空栈：重做栈已空，这一次不许动。
    expect(log.redo()).toBe(false);
    expect(log.lastPatch).toEqual(afterRedo);
    // 此时 undo 栈还剩 dispatch 那一格（redo 把它放回去了），所以下面这次 undo 是**成功**的：
    // 它产出一发逆补丁，lastPatch 随之变成x=0 —— 不是"不刷"。
    expect(log.undo()).toBe(true);
    const afterSecondUndo = log.lastPatch;
    if (!afterSecondUndo) throw new TypeError('第二次撤销之后 lastPatch 不该是空');
    expect(afterSecondUndo.upsert).toEqual([point(PID(1), 0, 0)]);
    // 现在两栈都空了：这一次是真空栈，不许动。
    expect(log.undo()).toBe(false);
    expect(log.lastPatch).toEqual(afterSecondUndo);
  });

  it('lastPatch：build 抛错之后停在上一发，失败的补丁绝不进账', () => {
    const log = seed();
    log.dispatch(movePoint(PID(1), 100, 200));
    const good = log.lastPatch;
    // 与上一格同一个坑：`good` 在功能缺失时是 `undefined`，而 `toEqual(good)` 恒真。
    // 先把它钉成"一个真补丁"，这道判据才有牙。
    if (!good) throw new TypeError('dispatch 之后 lastPatch 不该是空');
    expect(good.upsert).toEqual([point(PID(1), 100, 200)]);
    const boom: Command = {
      type: 'wall.delete',
      build() {
        throw new TypeError('故意失败');
      },
    };
    expect(() => log.dispatch(boom)).toThrow(/故意失败/);
    // 上一格的兄弟：那一格管"文档与 depth 没动"，这一格管"持久化侧看不见失败的补丁"。
    // 若这里改成失败的补丁，autosave 会把一次没发生过的状态变更写进 command_log。
    expect(log.lastPatch).toEqual(good);
    expect(log.lastPatch).not.toEqual(null);
  });

  it('lastPatch：remove 型补丁带着 remove 名单（账本里删墙那一发靠它）', () => {
    const log = seed();
    const removeWall: Command = {
      type: 'wall.delete',
      build() {
        return { upsert: [], remove: [PID(3)] };
      },
    };
    log.dispatch(removeWall);
    const patch = log.lastPatch as Patch;
    expect(patch.remove).toEqual([PID(3)]);
    expect(patch.upsert).toEqual([]);
    expect(affectedIds(patch)).toEqual(new Set([PID(3)]));
  });

  it('lastPatch：连撤 30 步，每一发的逆补丁都打得回去（S1 验收 2 的持久化侧前置）', () => {
    const log = seed();
    for (let i = 0; i < 30; i++) {
      log.dispatch(movePoint(PID(1), i * 10, i * 20));
    }
    for (let i = 0; i < 30; i++) {
      const before = log.document;
      expect(log.undo()).toBe(true);
      const patch = log.lastPatch;
      if (!patch) throw new TypeError(`撤到第 ${i + 1} 发时 lastPatch 是 null`);
      expect(affectedIds(patch)).toEqual(new Set([PID(1)]));
      // 逐发验证"记的就是打过的那一发"：30 发里任何一发记错（比如记成原件而不是逆件）都会在这里红。
      expect(applyPatch(before, patch).doc.canonical()).toBe(log.document.canonical());
    }
  });
});
