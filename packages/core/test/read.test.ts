import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  mustExist,
  requirePoint,
  requireStorey,
  requireWall,
  storeyCreate,
  uuidv7,
  wallCreate,
} from '@dajia/core';

const projectId = uuidv7();
const MISSING = '00000000-0000-7000-8000-000000000009';

function logWithOneWall(): TransactionLog {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  const storeyId = log.document.byKind('storey')[0]!.id;
  log.dispatch(
    wallCreate({
      storeyId,
      start: { x: 0, y: 0 },
      end: { x: 3600, y: 0 },
      thicknessMm: 240,
      heightMm: 3000,
    }),
  );
  return log;
}

describe('model/read 的四个断言', () => {
  it('mustExist 缺失时抛中文 label + id', () => {
    const log = logWithOneWall();
    expect(() => mustExist(log.document, MISSING, '楼层')).toThrow(/楼层 不存在/);
    expect(() => mustExist(log.document, MISSING, '楼层')).toThrow(MISSING);
  });

  it('requireWall 对非墙实体抛「不是墙，是 <kind>」', () => {
    const log = logWithOneWall();
    const storeyId = log.document.byKind('storey')[0]!.id;
    expect(() => requireWall(log.document, storeyId)).toThrow(/不是墙，是 storey/);
  });

  it('requirePoint 对非点实体抛中文文案', () => {
    const log = logWithOneWall();
    const wall = log.document.byKind('wall')[0]!;
    expect(() => requirePoint(log.document, wall.id, '墙起点')).toThrow(/墙起点 不是 point 实体/);
  });

  it('requirePoint 正常路径返回点本体', () => {
    const log = logWithOneWall();
    const wall = log.document.byKind('wall')[0]!;
    expect(requirePoint(log.document, wall.startId, '墙起点').x).toBe(0);
  });

  it('requireStorey 对非楼层实体抛「不是楼层，是 <kind>」，缺失抛中文 label', () => {
    const log = logWithOneWall();
    const wall = log.document.byKind('wall')[0]!;
    expect(() => requireStorey(log.document, wall.id)).toThrow(/不是楼层，是 wall/);
    expect(() => requireStorey(log.document, MISSING)).toThrow(/楼层 不存在/);
    // 正常路径：楼层实体原样返回 —— 柱高默认值就靠这一步拿到 heightMm
    expect(requireStorey(log.document, log.document.byKind('storey')[0]!.id).heightMm).toBe(3000);
  });
});
