import { describe, expect, it } from 'vitest';
import {
  Document,
  SCHEMA_VERSION,
  type Entity,
  type EntityId,
  type PointEntity,
  type StoreyEntity,
  type WallEntity,
} from '@dajia/core';
import { encodeDocument } from '../../src/main/db/codec';
import {
  documentFromPayload,
  payloadFromDocument,
  snapshotPayloadFromDocument,
} from '../../src/shared/document-wire';

/**
 * 夹具手写，不走命令：这一族判的是形状与字节，"几何成不成立"归 T3 的读盘不变式与 T5 的 loadProject。
 * id 的字面量与 `codec.test.ts` 同族（同一批 `0193aa00-…-7000-8000-…`），因为两边的对账文案要能并排读。
 */
const PID = '0193aa00-0000-7000-8000-00000000000a';
const S1 = '0193aa00-0000-7000-8000-000000000001';
const P1 = '0193aa00-0000-7000-8000-000000000002';
const P2 = '0193aa00-0000-7000-8000-000000000003';
const W1 = '0193aa00-0000-7000-8000-000000000004';

const point: PointEntity = { kind: 'point', id: P1, storeyId: S1, x: 0, y: 0 };
const point2: PointEntity = { kind: 'point', id: P2, storeyId: S1, x: 4000, y: 0 };
const wall: WallEntity = {
  kind: 'wall',
  id: W1,
  storeyId: S1,
  startId: P1,
  endId: P2,
  thicknessMm: 200,
  heightMm: 2800,
  elevationOffsetMm: 0,
  loadBearing: false,
  material: '砖',
};
const storey: StoreyEntity = {
  kind: 'storey',
  id: S1,
  projectId: PID,
  index: 0,
  elevationMm: 0,
  heightMm: 3000,
};

/** 插入序**故意**是 W1,S1,P2,P1（升序是 S1,P1,P2,W1）：排序与"别照插入序泄出去"两件事都由它测。 */
function doc(insertion: readonly Entity[]): Document {
  return Document.replaceEntities(
    Document.create(PID, SCHEMA_VERSION),
    new Map<EntityId, Entity>(insertion.map((e) => [e.id, e])),
  );
}

const DOC = doc([wall, storey, point2, point]);

describe('payloadFromDocument / snapshotPayloadFromDocument：形状与顺序', () => {
  it('往返逐字节同源，且四件事实都活着（三键、按 id 升序、空文档、字段值）', () => {
    const payload = payloadFromDocument(DOC);
    expect(Object.keys(payload).sort()).toEqual(['entities', 'projectId', 'schemaVersion']);
    expect(payload.projectId).toBe(PID);
    expect(payload.schemaVersion).toBe(SCHEMA_VERSION);
    expect(payload.entities.map((e) => e.id)).toEqual([S1, P1, P2, W1]);
    expect(documentFromPayload(payload, 'test').canonical()).toBe(DOC.canonical());
  });

  it('换个插入序得到**同一串字节**（排序是"字节稳定"的产地，不是 Map 的副产品）', () => {
    const a = payloadFromDocument(doc([point, point2, storey, wall]));
    const b = payloadFromDocument(doc([wall, storey, point2, point]));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('零实体的文档：`entities` 是空数组而不是缺键，且照样建得回来', () => {
    const empty = Document.create(PID, SCHEMA_VERSION);
    const payload = payloadFromDocument(empty);
    expect(payload.entities).toEqual([]);
    const back = documentFromPayload(payload, 'test');
    expect(back.entities.size).toBe(0);
    expect(back.canonical()).toBe(empty.canonical());
  });

  it('`encodeDocument(doc, turn)` 与 `JSON.stringify(snapshotPayloadFromDocument(doc, turn))` 逐字节相同（委托没漂）', () => {
    expect(encodeDocument(DOC, 11)).toBe(JSON.stringify(snapshotPayloadFromDocument(DOC, 11)));
  });

  it('两份形状只差 `journalTurn` 一键，`entities` 是同一串字节（排序与键序只有一个产地，P-70）', () => {
    const wire = payloadFromDocument(DOC);
    const snap = snapshotPayloadFromDocument(DOC, 11);
    expect(Object.keys(wire).sort()).toEqual(['entities', 'projectId', 'schemaVersion']);
    // 键序按**产物**比、不 sort：这一串字节就是 `encodeDocument` 的产物形状，与 codec.test.ts
    // 「两份契约」那一格吃的是同一个序 —— 两处各写一份的话，改动其中一处另一处必须红。
    expect(Object.keys(snap)).toEqual(['projectId', 'schemaVersion', 'journalTurn', 'entities']);
    expect(JSON.stringify(snap.entities)).toBe(JSON.stringify(wire.entities));
    // 四键那份照样过 `documentFromPayload`（codec 的 decodeSnapshot 就靠这一句成立）：
    // 三键参数是它的结构子集，多出来的 turn 这里一个字段都不读。
    expect(documentFromPayload(snap, 'test').canonical()).toBe(DOC.canonical());
  });
});

describe('documentFromPayload：过界那一步的牙', () => {
  it('重复 id 当场抛，文案与 T4 读盘那一条逐字相同（T4-M9 挪靶之后唯一的产地）', () => {
    const payload = payloadFromDocument(DOC);
    const next = [...payload.entities, payload.entities[0] as (typeof payload.entities)[number]];
    expect(() => documentFromPayload({ ...payload, entities: next }, 'snapshot 行 7')).toThrow(
      new RegExp('snapshot 行 7 的 entities 里实体 .* 出现两次：一份快照不许有重复 id'),
    );
  });

  it('抛错文案用的是**调用方**给的坐标：同一份 payload，两个标签给出两条不同的话', () => {
    const payload = payloadFromDocument(DOC);
    const next = [...payload.entities, payload.entities[0] as (typeof payload.entities)[number]];
    const bad = { ...payload, entities: next };
    expect(() => documentFromPayload(bad, 'IPC dajia:journal:submit')).toThrow(/IPC dajia:journal:submit/);
    expect(() => documentFromPayload(bad, 'emergency 行 3')).toThrow(/emergency 行 3/);
  });

  it('不管引用完整性：一面没有端点的墙照样建得回来（放行证在别处，这里不许提前叫）', () => {
    const orphan = doc([wall]);
    const built = documentFromPayload(payloadFromDocument(orphan), 'test');
    expect(built.byKind('point')).toEqual([]);
    expect(built.get(W1)?.kind).toBe('wall');
  });
});
