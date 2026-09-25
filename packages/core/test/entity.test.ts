import { describe, expect, it } from 'vitest';
import {
  Document,
  stableStringify,
  uuidv7,
  type Entity,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();
const A_ID = '00000000-0000-7000-8000-00000000000a';

function wall(over: Partial<WallEntity> = {}): WallEntity {
  return {
    kind: 'wall',
    id: uuidv7(),
    storeyId: uuidv7(),
    startId: uuidv7(),
    endId: uuidv7(),
    thicknessMm: 240,
    heightMm: 3000,
    elevationOffsetMm: 0,
    loadBearing: true,
    material: 'brick',
    ...over,
  };
}

function point(x: number, y: number) {
  return { kind: 'point', id: uuidv7(), storeyId: uuidv7(), x, y } as const;
}

describe('stableStringify', () => {
  it('键顺序无关', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it('数组顺序有关', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('嵌套对象也按键排序', () => {
    expect(stableStringify({ x: { b: 1, a: [true, null, 's'] } })).toBe(
      '{"x":{"a":[true,null,"s"],"b":1}}',
    );
  });

  it('NaN / Infinity 抛错，不能悄悄变成 null 而看不出差异', () => {
    expect(() => stableStringify({ v: Number.NaN })).toThrow(TypeError);
    expect(() => stableStringify({ v: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });

  it('Map 抛错：必须先转有序数组，否则序不确定', () => {
    expect(() => stableStringify(new Map([['a', 1]]))).toThrow(TypeError);
  });
});

describe('Document', () => {
  it('新建即空', () => {
    const doc = Document.create(uuidv7());
    expect(doc.entities.size).toBe(0);
    expect(doc.byKind('wall')).toEqual([]);
  });

  it('byKind 按 id 升序返回，与插入顺序无关（canonical 确定性的前提）', () => {
    const w1 = wall({ id: '00000000-0000-7000-8000-000000000001' });
    const w2 = wall({ id: '00000000-0000-7000-8000-000000000002' });
    const doc = Document.create(uuidv7());
    const after = Document.replaceEntities(doc, new Map([[w2.id, w2], [w1.id, w1]]));
    expect(after.byKind('wall').map((w) => w.id)).toEqual([w1.id, w2.id]);
  });

  it('canonical 与实体插入顺序无关', () => {
    const a = wall();
    const b = wall();
    const d1 = Document.replaceEntities(Document.create(projectId), new Map([[a.id, a]]));
    const both = new Map([[a.id, a], [b.id, b]]);
    const reversed = new Map([[b.id, b], [a.id, a]]);
    expect(Document.replaceEntities(d1, both).canonical()).toBe(
      Document.replaceEntities(d1, reversed).canonical(),
    );
  });

  it('equals 对同一份内容返回 true', () => {
    const entities = new Map([[A_ID, wall({ id: A_ID })]]);
    const one = Document.replaceEntities(Document.create(projectId), entities);
    const two = Document.replaceEntities(Document.create(projectId), new Map(entities));
    expect(one.equals(two)).toBe(true);
  });

  it('浮点尾差进不了真源：构造文档时直接抛，不靠 equals 去分辨', () => {
    expect(() =>
      Document.replaceEntities(
        Document.create(projectId),
        new Map([[A_ID, wall({ id: A_ID, thicknessMm: 240.0001 })]]),
      ),
    ).toThrow(/thicknessMm/);
  });

  it('坐标同属整数毫米约定：点带浮点 x 必须被拒（spec D8）', () => {
    const p = point(1200.5, 0);
    expect(() =>
      Document.replaceEntities(Document.create(projectId), new Map([[p.id, p]])),
    ).toThrow(/point\.x/);
    const ok = point(1200, 0);
    const doc = Document.replaceEntities(Document.create(projectId), new Map([[ok.id, ok]]));
    expect(doc.byKind('point')[0]?.x).toBe(1200);
  });

  it('拒绝形状不合法的实体：id 不是 v7 就抛', () => {
    const doc = Document.create(uuidv7());
    expect(() =>
      Document.replaceEntities(
        doc,
        new Map([['wall-1', { ...(wall() as Entity), id: 'wall-1' }]]),
      ),
    ).toThrow(/id/);
  });

  it('拒绝 Map 的 key 与实体 id 不一致', () => {
    const w = wall();
    expect(() =>
      Document.replaceEntities(Document.create(projectId), new Map([[uuidv7(), w]])),
    ).toThrow(/key 与实体 id 不一致/);
  });
});
