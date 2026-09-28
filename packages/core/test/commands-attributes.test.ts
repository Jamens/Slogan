// 属性命令（wall.setMaterial / wall.setLoadBearing）与那一条材料写法（assertMaterial）。
// 计划 3 Task 7 的 A4：不做 noop 检查、不进派生复核。两条都是**付了代价**的选择 ——
// 代价（反复点同一个选项会各留一条撤销记录）写在最后一条用例里，别让人以为是没想过。
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  assertMaterial,
  storeyCreate,
  uuidv7,
  wallCreate,
  wallSetLoadBearing,
  wallSetMaterial,
  type EntityId,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();

/** 一层楼 + 一面 4000×240 的墙。只有一面墙，所以 byKind 下标没有歧义。 */
function oneWall(): { log: TransactionLog; wall: WallEntity; storeyId: EntityId } {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  const storeyId = log.document.byKind('storey')[0]!.id;
  log.dispatch(
    wallCreate({
      storeyId,
      start: { x: 0, y: 0 },
      end: { x: 4000, y: 0 },
      thicknessMm: 240,
      heightMm: 3000,
    }),
  );
  return { log, wall: log.document.byKind('wall')[0]!, storeyId };
}

describe('assertMaterial：材料名的写法纪律', () => {
  it('非空、不带首尾空白、不超 32 字符，三种毛病各有自己的文案', () => {
    expect(() => assertMaterial('')).toThrow(/材料不能为空/);
    expect(() => assertMaterial(' 混凝土 ')).toThrow(/不能带首尾空白/);
    expect(() => assertMaterial('a'.repeat(33))).toThrow(/不能超过 32 字符，收到 33 个/);
  });

  it('合法的那一侧：32 字符正好、中文与句中空格都放行（图纸标注要写"240 砖砌"这种话）', () => {
    expect(assertMaterial('a'.repeat(32))).toHaveLength(32);
    expect(assertMaterial('240 砖砌', '墙材料')).toBe('240 砖砌');
  });

  it('label 只改文案不改规则：wallCreate 那份报错说的是"墙材料"', () => {
    expect(() => assertMaterial('', '墙材料')).toThrow(/墙材料不能为空/);
    expect(() =>
      wallCreate({
        storeyId: uuidv7(),
        start: { x: 0, y: 0 },
        end: { x: 1000, y: 0 },
        thicknessMm: 240,
        heightMm: 3000,
        material: '',
      }),
    ).toThrow(/墙材料不能为空/);
  });
});

describe('wallSetMaterial', () => {
  it('补丁只有一个 upsert、只有 material 变了，其余字段逐字不动', () => {
    const { log, wall } = oneWall();
    const patch = wallSetMaterial({ wallId: wall.id, material: 'concrete' }).build(log.document);
    expect(patch.remove).toEqual([]);
    expect(patch.upsert).toHaveLength(1);
    expect(patch.upsert[0]).toEqual({ ...wall, material: 'concrete' });
  });

  it('省略 material 时默认 brick；改完之后真源里就是新值', () => {
    const { log, wall } = oneWall();
    expect(wall.material).toBe('brick');
    log.dispatch(wallSetMaterial({ wallId: wall.id, material: '混凝土' }));
    expect(log.document.byKind('wall')[0]!.material).toBe('混凝土');
  });

  it('墙不存在 → TypeError，文案点名是"墙"（读取断言只有一个产地）', () => {
    const { log } = oneWall();
    const missing = uuidv7();
    let caught: unknown;
    try {
      wallSetMaterial({ wallId: missing, material: 'brick' }).build(log.document);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toBe(`墙 不存在：${missing}`);
  });

  it('拿楼层 id 当墙用 → 类型不符也抛（mustExist 之后还要过 kind 这一道）', () => {
    const { log, storeyId } = oneWall();
    expect(() =>
      wallSetMaterial({ wallId: storeyId, material: 'brick' }).build(log.document),
    ).toThrow(/不是墙，是 storey/);
  });

  it('材料不进派生：写法合法就只管写，值一样也照写不误（noop 不检查，见最后一条用例的代价）', () => {
    const { log, wall } = oneWall();
    expect(() => wallSetMaterial({ wallId: wall.id, material: 'brick' }).build(log.document)).not.toThrow();
  });
});

describe('wallSetLoadBearing', () => {
  it('默认承重为 true，改成 false 只动那一个字段', () => {
    const { log, wall } = oneWall();
    expect(wall.loadBearing).toBe(true);
    const patch = wallSetLoadBearing({ wallId: wall.id, loadBearing: false }).build(log.document);
    expect(patch.upsert).toEqual([{ ...wall, loadBearing: false }]);
  });

  it('撤销/重做把属性原样还回来，也原样再放回去', () => {
    const { log, wall } = oneWall();
    log.dispatch(wallSetMaterial({ wallId: wall.id, material: '混凝土' }));
    log.dispatch(wallSetLoadBearing({ wallId: wall.id, loadBearing: false }));
    expect(log.depth).toBe(4); // 楼层 + 墙 + 两条属性
    log.undo();
    log.undo();
    expect(log.document.get(wall.id)).toEqual(wall);
    // redo 逆着 undo 的顺序回来：先材料，后承重
    log.redo();
    expect(log.document.byKind('wall')[0]!.material).toBe('混凝土');
    log.redo();
    expect(log.document.byKind('wall')[0]!.loadBearing).toBe(false);
  });

  it('反复点同一个选项各留一条撤销记录：A4 选的代价，不是遗漏', () => {
    const { log, wall } = oneWall();
    const before = log.depth;
    // 值没变也照样出一发补丁 —— 哪天有人"顺手"加一句 noop 短路，这一发就断在补丁上，
    // 而不是断在撤销栈深度上（空补丁同样压栈，光看 depth 是看不出来的）。
    expect(wallSetMaterial({ wallId: wall.id, material: 'brick' }).build(log.document).upsert)
      .toEqual([wall]);
    log.dispatch(wallSetMaterial({ wallId: wall.id, material: 'brick' }));
    log.dispatch(wallSetMaterial({ wallId: wall.id, material: 'brick' }));
    expect(log.depth).toBe(before + 2);
    // 文档内容没变，所以这两发在 canonical() 上不可见 —— 撤销栈里却实实在在有两层
    expect(log.document.byKind('wall')[0]!.material).toBe('brick');
    log.undo();
    expect(log.document.byKind('wall')[0]!.material).toBe('brick');
  });

  it('属性命令不碰别的实体：applyPatch 之后未触及的墙保持同一个对象', () => {
    const { log, wall } = oneWall();
    log.dispatch(
      wallCreate({
        storeyId: log.document.byKind('storey')[0]!.id,
        start: { x: 0, y: 2000 },
        end: { x: 4000, y: 2000 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    );
    const untouched = log.document.byKind('wall').find((w) => w.id !== wall.id)!;
    const next = log.document;
    log.dispatch(wallSetMaterial({ wallId: wall.id, material: 'concrete' }));
    // 不可变文档的同一性保证：屏幕侧靠对象引用做增量重建，被误替换的实体会白白重算
    expect(log.document.byKind('wall').find((w) => w.id === untouched.id)).toBe(untouched);
    expect(next.byKind('wall').find((w) => w.id === wall.id)).toBe(wall);
  });
});
