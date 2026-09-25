import { describe, expect, it } from 'vitest';
import {
  Document,
  applyPatch,
  invertPatch,
  uuidv7,
  type Entity,
  type PointEntity,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();
const storeyId = uuidv7();

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

const P = (n: number) => `00000000-0000-7000-8000-00000000000${n}`;

function docWith(...entities: Entity[]): Document {
  const map = new Map(entities.map((e) => [e.id, e]));
  return Document.replaceEntities(Document.create(projectId), map);
}

describe('applyPatch', () => {
  it('upsert 新建实体并记录 previous 为 undefined', () => {
    const doc = docWith();
    const r = applyPatch(doc, { upsert: [point(P(1), 0, 0)], remove: [] });
    expect(r.doc.entities.size).toBe(1);
    expect(r.previous.get(P(1))).toBeUndefined();
    // previous 必须"有这个键"，否则 invertPatch 分不出"没记录"与"原本不存在"
    expect(r.previous.has(P(1))).toBe(true);
  });

  it('upsert 覆盖已有实体时保留旧值', () => {
    const doc = docWith(wall(P(2), P(1), P(3)));
    const thick240 = doc.get(P(2)) as WallEntity;
    const r = applyPatch(doc, {
      upsert: [{ ...thick240, thicknessMm: 120 }],
      remove: [],
    });
    expect((r.doc.get(P(2)) as WallEntity).thicknessMm).toBe(120);
    expect((r.previous.get(P(2)) as WallEntity).thicknessMm).toBe(240);
  });

  it('remove 删除实体并留下旧值供求逆', () => {
    const doc = docWith(point(P(1), 0, 0));
    const r = applyPatch(doc, { upsert: [], remove: [P(1)] });
    expect(r.doc.entities.size).toBe(0);
    expect(r.previous.get(P(1))?.kind).toBe('point');
  });

  it('原 doc 不被改动（不可变）', () => {
    const doc = docWith(point(P(1), 0, 0));
    applyPatch(doc, { upsert: [], remove: [P(1)] });
    expect(doc.entities.size).toBe(1);
  });

  it('同一 id 既 upsert 又 remove 时抛错：命令写错了就该炸', () => {
    const doc = docWith();
    expect(() => applyPatch(doc, { upsert: [point(P(1), 0, 0)], remove: [P(1)] })).toThrow(
      /同一 id 既 upsert 又 remove/,
    );
  });

  it('remove 不存在的 id 时抛错：不变式违反不兜底（spec 第 9 节）', () => {
    expect(() => applyPatch(docWith(), { upsert: [], remove: [P(9)] })).toThrow(/不存在/);
  });

  it('upsert 内 id 重复时抛错，避免后写覆盖前写的歧义', () => {
    expect(() =>
      applyPatch(docWith(), { upsert: [point(P(1), 0, 0), point(P(1), 1, 1)], remove: [] }),
    ).toThrow(/重复/);
  });
});

describe('invertPatch', () => {
  it('新建的逆是删除', () => {
    const doc = docWith();
    const patch = { upsert: [point(P(1), 0, 0)], remove: [] };
    const { previous } = applyPatch(doc, patch);
    const inv = invertPatch(patch, previous);
    expect(inv.upsert).toEqual([]);
    expect(inv.remove).toEqual([P(1)]);
  });

  it('删除的逆是原样恢复', () => {
    const doc = docWith(point(P(1), 100, 200));
    const patch = { upsert: [], remove: [P(1)] };
    const { previous } = applyPatch(doc, patch);
    const inv = invertPatch(patch, previous);
    expect(inv.remove).toEqual([]);
    expect(inv.upsert).toEqual([point(P(1), 100, 200)]);
  });

  it('修改的逆是写回旧值', () => {
    const doc = docWith(wall(P(2), P(1), P(3)));
    const before = doc.get(P(2)) as WallEntity;
    const patch = { upsert: [{ ...before, thicknessMm: 120 }], remove: [] };
    const { previous } = applyPatch(doc, patch);
    const inv = invertPatch(patch, previous);
    expect((inv.upsert[0] as WallEntity).thicknessMm).toBe(240);
    expect(inv.remove).toEqual([]);
  });

  it('apply 后再 apply 其逆，canonical 逐字节还原（Task 9 属性测试的种子用例）', () => {
    const doc = docWith(wall(P(2), P(1), P(3)), point(P(1), 0, 0), point(P(3), 3600, 0));
    const before = doc.canonical();
    const patch = {
      upsert: [point(P(4), 10, 10), { ...(doc.get(P(2)) as WallEntity), thicknessMm: 120 }],
      remove: [P(1)],
    };
    const applied = applyPatch(doc, patch);
    expect(applied.doc.canonical()).not.toBe(before);
    const undone = applyPatch(applied.doc, invertPatch(patch, applied.previous));
    expect(undone.doc.canonical()).toBe(before);
  });
});
