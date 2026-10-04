import { describe, expect, it } from 'vitest';
import {
  assertTruthSourceInvariants,
  Document,
  SCHEMA_VERSION,
  applyPatch,
  type Entity,
  type OpeningEntity,
  type PointEntity,
  type SlabEntity,
  type StoreyEntity,
  type WallEntity,
} from '@dajia/core';
import { DocumentPayloadSchema } from '@dajia/protocol';
import {
  asJsonValue,
  decodeDocument,
  decodeEntity,
  decodePatch,
  encodeDocument,
  encodeEntity,
  encodePatch,
  type RowRef,
} from '../../src/main/db/codec';

/**
 * 夹具是**手写**的一堆实体，不走任何命令：codec 判的是字节形状，
 * "这份文档在几何上成不成立"归 T3 的读盘不变式与 T5 的 loadProject。
 * 于是这里能给出一面厚 5000 装在 4000 长墙上的墙而不会抛 —— 那不是漏判，是分工（见正文 ②③）。
 */
const PID = '0193aa00-0000-7000-8000-00000000000a';
const S1 = '0193aa00-0000-7000-8000-000000000001';
const P1 = '0193aa00-0000-7000-8000-000000000002';
const P2 = '0193aa00-0000-7000-8000-000000000003';
const P3 = '0193aa00-0000-7000-8000-00000000000b';
const W1 = '0193aa00-0000-7000-8000-000000000004';
const O1 = '0193aa00-0000-7000-8000-000000000005';
const C1 = '0193aa00-0000-7000-8000-000000000006';
const B1 = '0193aa00-0000-7000-8000-000000000007';

const point: PointEntity = { kind: 'point', id: P1, storeyId: S1, x: 0, y: 0 };
const point2: PointEntity = { kind: 'point', id: P2, storeyId: S1, x: 4000, y: 0 };
const point3: PointEntity = { kind: 'point', id: P3, storeyId: S1, x: 0, y: 4000 };
const wall: WallEntity = {
  kind: 'wall',
  id: W1,
  storeyId: S1,
  startId: P1,
  endId: P2,
  thicknessMm: 5000, // 故意大于墙长：codec 不管几何，这一格要的是"字节进得来"
  heightMm: 2800,
  elevationOffsetMm: 0,
  loadBearing: true,
  material: '混凝土',
};
const opening: OpeningEntity = {
  kind: 'opening',
  id: O1,
  storeyId: S1,
  hostWallId: W1,
  distanceMm: 1000,
  widthMm: 900,
  heightMm: 2100,
  sillMm: 0,
  category: 'door',
};
const storey: StoreyEntity = {
  kind: 'storey',
  id: S1,
  projectId: PID,
  index: 0,
  elevationMm: 0,
  heightMm: 3000,
};
const column: Entity = {
  kind: 'column',
  id: C1,
  storeyId: S1,
  pointId: P1,
  widthMm: 400,
  depthMm: 400,
  heightMm: 3000,
  loadBearing: true,
  material: '混凝土',
};
const slab: SlabEntity = {
  kind: 'slab',
  id: B1,
  storeyId: S1,
  boundaryPointIds: [P1, P2, P3],
  thicknessMm: 120,
  elevationOffsetMm: 0,
};
const ALL: readonly Entity[] = [point, point2, point3, wall, opening, storey, column, slab];

const ELEMENT: RowRef = { table: 'element', id: P1 };
const LOG: RowRef = { table: 'command_log', id: '7' };
const SNAP: RowRef = { table: 'snapshot', id: '3' };

function docOf(entities: readonly Entity[]): Document {
  const base = Document.create(PID);
  return Document.replaceEntities(base, new Map(entities.map((e) => [e.id, e])));
}

describe('codec：盘上字节 ↔ core 数据', () => {
  it('八条实体 encode→decode 逐字段回来（六类各有样本）', () => {
    for (const entity of ALL) {
      const back = decodeEntity({ table: 'element', id: entity.id }, encodeEntity(entity));
      expect(back).toEqual(entity);
    }
    // 六类都得在场：少一类就是"这一类从没穿过 codec"，新增字段时会静默漂
    const kinds = new Set(ALL.map((e) => e.kind));
    expect([...kinds].sort()).toEqual(['column', 'opening', 'point', 'slab', 'storey', 'wall']);
  });

  it('文档 encode→decode 之后 canonical() 逐字节相同', () => {
    const doc = docOf(ALL);
    const back = decodeDocument(SNAP, encodeDocument(doc));
    expect(back.canonical()).toBe(doc.canonical());
    expect(back.projectId).toBe(PID);
    expect(back.schemaVersion).toBe(doc.schemaVersion);
  });

  it('键序被打乱的快照文本照样回到同一个 canonical()（MySQL 重排 JSON 键也不影响）', () => {
    const doc = docOf(ALL);
    const shuffled = JSON.stringify({
      entities: [...ALL].map((e) => {
        // 逐条把键序倒过来写：canonical() 自己排序，所以字节层乱序不该改变任何判据
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(e).reverse()) out[k] = (e as unknown as Record<string, unknown>)[k];
        return out;
      }),
      schemaVersion: doc.schemaVersion,
      projectId: doc.projectId,
    });
    expect(decodeDocument(SNAP, shuffled).canonical()).toBe(doc.canonical());
  });

  it('多余字段在读取侧被拒（`.strict()` 的那一半：core 不看的东西这里必须看）', () => {
    const bad = { ...point, lengthMm: 4000 };
    expect(() => decodeEntity(ELEMENT, JSON.stringify(bad))).toThrow(/解不出实体/);
  });

  it('浮点毫米与越界整数在读取侧被拒', () => {
    expect(() => decodeEntity(ELEMENT, JSON.stringify({ ...point, x: 1.5 }))).toThrow(/解不出实体/);
    expect(() =>
      decodeEntity(ELEMENT, JSON.stringify({ ...point, x: 9007199254740993 })),
    ).toThrow(/解不出实体/);
  });

  it('-0 只有从**手写文本**进来才拦得住（JSON.stringify(-0) 是 "0"）', () => {
    expect(() =>
      decodeEntity(ELEMENT, `{"kind":"point","id":"${P1}","storeyId":"${S1}","x":-0,"y":0}`),
    ).toThrow(/解不出实体/);
    // 这一格的存在理由是这个不对称：-0 的判据（T3 的 MmSchema）真正的用武之地是
    // 读别人的字节（盘上的、IPC 进来的、迁移脚本塞进去的），不是拦自己人。
    // Step 1 的 B 档实测：MySQL 的 JSON 存储把 -0 归一成 0，所以"盘上读到 -0"这一型
    // 只能由这条**纯文本**用例覆盖（不经数据库），第 10 格钉的正是"经编码就没了"。
    expect(() => decodeEntity(ELEMENT, JSON.stringify({ ...point, x: -0 }))).not.toThrow();
  });

  it('抛错文案带表名与行 id：三张表各一发（排查时只有这两个字段能落到一行上）', () => {
    const junk = JSON.stringify({ kind: 'point' });
    expect(() => decodeEntity(ELEMENT, junk)).toThrow(/^element 行 0193aa00-\S+ 解不出实体：/);
    expect(() => decodePatch(LOG, junk)).toThrow(/^command_log 行 7 解不出补丁：/);
    expect(() => decodeDocument(SNAP, junk)).toThrow(/^snapshot 行 3 解不出文档快照：/);
  });

  it('decodePatch 只管形状：upsert 里重复 id 交回 core 抛（两个边界各守各的，不许混）', () => {
    // 走 encodePatch 而不是手搓 JSON.stringify：这一发顺带把补丁的编码路径也穿过一次 codec，
    // 且 encode→decode 之后重复 id 原样保留（encode 不 dedup，形状判据归 decodePatch + applyPatch）。
    const decoded = decodePatch(LOG, encodePatch({ upsert: [point, point], remove: [] }));
    expect(decoded.upsert.length).toBe(2);
    expect(() => applyPatch(docOf(ALL), decoded)).toThrow(/Patch\.upsert 内 id 重复/);
  });

  it('encodeDocument 的形状就是三键，且 entities 按 id 升序（与 canonical() 同一个口径）', () => {
    expect(Object.keys(DocumentPayloadSchema.shape).sort()).toEqual([
      'entities',
      'projectId',
      'schemaVersion',
    ]);
    const parsed = JSON.parse(encodeDocument(docOf(ALL))) as {
      projectId: string;
      schemaVersion: number;
      entities: { id: string }[];
    };
    expect(parsed.projectId).toBe(PID);
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
    const ids = parsed.entities.map((e) => e.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('encode 不是校验器：它把 -0 写成 "0"，且照样不抛', () => {
    const text = encodeEntity({ ...point, x: -0 });
    expect(text).toContain('"x":0');
    expect(() => decodeEntity(ELEMENT, text)).not.toThrow();
  });

  it('快照里同一 id 出现两次 ⇒ 抛（静默取后者等于盘上同时存着两个真值）', () => {
    const text = JSON.stringify({
      projectId: PID,
      schemaVersion: SCHEMA_VERSION,
      entities: [point, { ...point, x: 123 }, point2],
    });
    expect(() => decodeDocument(SNAP, text)).toThrow(/entities 里实体 \S+ 出现两次/);
  });

  it('asJsonValue：字符串走 JSON.parse，对象原样过，坏文本抛，null 原样过', () => {
    expect(asJsonValue('{"a":1}')).toEqual({ a: 1 });
    expect(asJsonValue({ a: 1 })).toEqual({ a: 1 });
    expect(asJsonValue(null)).toBe(null);
    expect(() => asJsonValue('{不是 JSON')).toThrow(/不是合法 JSON 文本/);
  });

  it('往返哨兵：解码把整数毫米落成 JS number，读盘门那三个新产地各红一次（钉的是 codec→门这条链不许把毫米喂成字符串）', () => {
    // 三发都先 encode 再 decode，然后把**解码产物**喂给 `assertTruthSourceInvariants`：
    // 只有当 decodeDocument 没抛（⇒ zod 收到的毫米是 JS number，不是字符串形态），
    // 控制权才会走到读盘门的几何判据上，红才落在下面这三条独有文案上而不是
    // `解不出实体`（毫米若漂成字符串会在这里被 MmSchema 的 `typeof` 当场拒掉，走不到门）。
    // 于是这一格同时钉住两件事：解码落 number（Task 3 的 mm() 守卫）+ 三个新产地各有一次真红。
    // 夹具形状照 packages/core/test/invariants.test.ts 的「墙形状退化进读盘门」「洞顶超宿主墙高」，
    // 零长那一发的两点用不同 id、同坐标（引用与同层判据对它全盲，只有 assertWallShape 拦得住）。

    // ① 厚 ≥ 墙长：docOf(ALL) 的 W1 厚 5000 装在 4000 长的 P1→P2 上。
    const thick = decodeDocument(SNAP, encodeDocument(docOf(ALL)));
    expect(() => assertTruthSourceInvariants(thick)).toThrow(/不小于墙长/);

    // ② 零长：P1、P2 同坐标 (0,0)、不同 id，墙 200 厚 —— 端点重合走的是 `零长` 那一句。
    const zeroLen = decodeDocument(
      SNAP,
      encodeDocument(
        docOf([
          storey,
          point,
          { ...point2, x: 0, y: 0 },
          { ...wall, thicknessMm: 200 },
        ]),
      ),
    );
    expect(() => assertTruthSourceInvariants(zeroLen)).toThrow(/零长/);
    expect(() => assertTruthSourceInvariants(zeroLen)).toThrow(/两端点量化后同为/);

    // ③ 洞顶超宿主墙高：合法薄墙（200 厚、2800 高）挂一扇窗，窗台 200 + 洞高 2900 = 3100 > 2800。
    const badTop = decodeDocument(
      SNAP,
      encodeDocument(
        docOf([
          storey,
          point,
          point2,
          { ...wall, thicknessMm: 200 },
          { ...opening, category: 'window', sillMm: 200, heightMm: 2900 },
        ]),
      ),
    );
    expect(() => assertTruthSourceInvariants(badTop)).toThrow(/顶标高/);
    expect(() => assertTruthSourceInvariants(badTop)).toThrow(/超过宿主墙高/);
  });
});
