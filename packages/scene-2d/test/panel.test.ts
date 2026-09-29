import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  assertMaterial,
  columnCreate,
  openingCreate,
  storeyCreate,
  uuidv7,
  wallCreate,
  wallDelete,
  wallSetLoadBearing,
  wallSetMaterial,
  wallSetThickness,
  type PointRef,
  type WallEntity,
} from '@dajia/core';
import {
  MIN_WALL_LENGTH_MM,
  PANEL_MATERIAL_OPTIONS,
  demoHouse,
  selectedWallForPanel,
  storeyTabsOf,
  trialCommand,
  wallPropsOf,
} from '@dajia/scene-2d';

const house = demoHouse();

function synthStorey(heightMm = 3000): { log: TransactionLog; storeyId: string; projectId: string } {
  const projectId = uuidv7();
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm }));
  let storeyId = '';
  for (const id of log.affected) {
    if (log.document.get(id)?.kind === 'storey') storeyId = id;
  }
  if (storeyId === '') throw new TypeError('affected 里没有新建的楼层');
  return { log, storeyId, projectId };
}

function wallAt(log: TransactionLog, storeyId: string, start: PointRef, end: PointRef): WallEntity {
  log.dispatch(wallCreate({ storeyId, start, end, thicknessMm: 240, heightMm: 3000 }));
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new TypeError('affected 里没有新建的墙');
}

/** 一面墙 + 一根柱 + 一樘洞口：面板取墙那几条要区分"点得到的"与"点不到的"。 */
function wallWithNeighbours(): {
  log: TransactionLog;
  storeyId: string;
  wall: WallEntity;
  columnId: string;
  openingId: string;
} {
  const { log, storeyId } = synthStorey();
  const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
  log.dispatch(columnCreate({ storeyId, at: { x: 500, y: 500 }, widthMm: 400, depthMm: 400 }));
  const columnId = [...log.affected].find((id) => log.document.get(id)?.kind === 'column');
  if (columnId === undefined) throw new TypeError('affected 里没有那根柱');
  log.dispatch(
    openingCreate({ hostWallId: wall.id, distanceMm: 1200, widthMm: 1000, heightMm: 2100, category: 'door' }),
  );
  const openingId = [...log.affected].find((id) => log.document.get(id)?.kind === 'opening');
  if (openingId === undefined) throw new TypeError('affected 里没有那樘洞口');
  return { log, storeyId, wall, columnId, openingId };
}

/**
 * 一面墙的 T 接现场：贯通线 (0,0)→(4000,0)→(8000,0) 在 (4000,0) 上立一根 stem。
 * `wall.setThickness` 的派生复核只在这一发上说话（命令层前三道门全过），所以整条
 * 「输入预言」用例都建在它上面。2026-09-28 实测：stem 在时改贯通任一侧 ⇒
 * 「接头 … 的直通两墙厚度不同（370 / 240）…」；摘掉 stem（T 变纯贯通两臂点）⇒ 同值改得动。
 */
function teeJoint(): {
  log: TransactionLog;
  storeyId: string;
  west: WallEntity;
  east: WallEntity;
  stem: WallEntity;
} {
  const { log, storeyId } = synthStorey();
  const west = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
  const east = wallAt(log, storeyId, { pointId: west.endId }, { x: 8000, y: 0 });
  log.dispatch(
    wallCreate({
      storeyId,
      start: { pointId: east.startId },
      end: { x: 4000, y: 3000 },
      thicknessMm: 120,
      heightMm: 3000,
    }),
  );
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall' && entity.thicknessMm === 120) return { log, storeyId, west, east, stem: entity };
  }
  throw new TypeError('affected 里没有那根 stem');
}

describe('材料候选集', () => {
  it('每一项都真发得出去：五项逐个试跑 `wall.setMaterial`，reason 逐字为 null', () => {
    const { log, storeyId } = synthStorey();
    const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    for (const option of PANEL_MATERIAL_OPTIONS) {
      const trial = trialCommand(log.document, () =>
        wallSetMaterial({ wallId: wall.id, material: option.value }),
      );
      // 判 reason 逐字为 null 而不是"没抛"：候选集里漂进一个带空格的写法时，
      // 真源的文案会进来，而 `ok` 那一路已经先红 —— 两句一起看才知道是谁在说话。
      expect({ value: option.value, ok: trial.ok, reason: trial.reason }).toEqual({
        value: option.value,
        ok: true,
        reason: null,
      });
    }
  });

  it('写法纪律问 core 的 `assertMaterial`：候选集全过，自造的三种写法全拒', () => {
    const materialLegal = (material: string): boolean => {
      try {
        assertMaterial(material);
        return true;
      } catch {
        return false;
      }
    };
    for (const option of PANEL_MATERIAL_OPTIONS) {
      expect(materialLegal(option.value)).toBe(true);
    }
    // 素材自证：这一条真的在问写法，不是恒真 —— 空串、首尾空白、超长各一。
    expect(materialLegal('')).toBe(false);
    expect(materialLegal(' brick')).toBe(false);
    expect(materialLegal('砖'.repeat(33))).toBe(false);
  });

  it('标签非空、值不带空白，且首屏那面墙的当前材料在候选里找得到', () => {
    for (const option of PANEL_MATERIAL_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.value).toBe(option.value.trim());
    }
    const { log, storeyId } = synthStorey();
    const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const props = wallPropsOf(log.document, wall.id);
    if (props === null) throw new TypeError('刚建好的墙读不出属性');
    // 下拉框打开时当前值必须在候选里，否则面板显示空白而真源里那面墙有材料（两套口径）
    expect(PANEL_MATERIAL_OPTIONS.some((o) => o.value === props.material)).toBe(true);
    expect(props.material).toBe('brick'); // 真源默认（`wallCreate` 里那句 `?? 'brick'`）
  });
});

describe('面板取哪一面墙', () => {
  it('恰好一面本层墙 ⇒ 就是它（逐字同一引用，面板不复制实体）', () => {
    const { log, storeyId, wall } = wallWithNeighbours();
    expect(selectedWallForPanel(log.document, storeyId, [wall.id])).toBe(wall);
  });

  it('两面墙一起选中 ⇒ null：面板不许"取第一面"，那等于偷偷改用户的选中集', () => {
    const { log, storeyId } = synthStorey();
    const a = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const b = wallAt(log, storeyId, { x: 0, y: 2000 }, { x: 4000, y: 2000 });
    expect(selectedWallForPanel(log.document, storeyId, [a.id, b.id])).toBeNull();
    // 素材自证：单发同一面墙仍是答案 ⇒ 上一发红在"两面"，不红在"这面墙读不出"
    expect(selectedWallForPanel(log.document, storeyId, [b.id])).toBe(b);
  });

  it('柱、洞口、已消失的 id、别层的墙四种都拿 null', () => {
    const { log, storeyId, columnId, openingId } = wallWithNeighbours();
    expect(selectedWallForPanel(log.document, storeyId, [columnId])).toBeNull();
    expect(selectedWallForPanel(log.document, storeyId, [openingId])).toBeNull();
    expect(selectedWallForPanel(log.document, storeyId, ['gone'])).toBeNull();
    const upper = house.doc.byKind('wall').find((w) => w.storeyId === house.upperStoreyId);
    if (upper === undefined) throw new TypeError('样例房二层应当有墙');
    expect(selectedWallForPanel(house.doc, house.lowerStoreyId, [upper.id])).toBeNull();
    // 素材自证：同一枚别层墙问到它自己的层就给答案 ⇒ 上一发红在认层
    expect(selectedWallForPanel(house.doc, house.upperStoreyId, [upper.id])).toBe(upper);
  });

  it('空集给 null 不抛；混选（墙 + 柱）仍是那面墙', () => {
    const { log, storeyId, wall, columnId } = wallWithNeighbours();
    expect(selectedWallForPanel(log.document, storeyId, [])).toBeNull();
    // 混选给墙：面板照开。柱只是**改不了属性**（S1 没有柱面板），不是删不掉（Task 8 接了 columnDelete）
    expect(selectedWallForPanel(log.document, storeyId, [columnId, wall.id])).toBe(wall);
  });
});

describe('面板读值', () => {
  it('三格逐字取自真源，第四格是这面墙的轴长', () => {
    const { log, storeyId } = synthStorey(3600);
    const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    expect(wallPropsOf(log.document, wall.id)).toEqual({
      wallId: wall.id,
      thicknessMm: 240,
      // 墙高读墙自己的字段，不读层高：3600 的层上画 3000 的墙是本夹具故意留的差别。
      // 面板显示层高的话，用户在屏幕上看不见"这面墙够不到顶"。
      heightMm: 3000,
      material: 'brick',
      loadBearing: true,
      axisLengthMm: 4000,
    });
  });

  it('撤销掉正被选中的那面墙：读值与取墙双双回到 null，面板清空而不抛', () => {
    const { log, storeyId } = synthStorey();
    const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    expect(wallPropsOf(log.document, wall.id)).not.toBeNull();
    expect(log.undo()).toBe(true);
    expect(wallPropsOf(log.document, wall.id)).toBeNull();
    expect(selectedWallForPanel(log.document, storeyId, [wall.id])).toBeNull();
  });

  it('楼层与柱的 id 不是墙：读值 null，不抛（挡住把 `wallAxisById` 接进面板）', () => {
    const { log, storeyId } = wallWithNeighbours();
    expect(wallPropsOf(log.document, storeyId)).toBeNull();
    const column = log.document.byKind('column')[0];
    if (column === undefined) throw new TypeError('夹具里没有柱');
    expect(wallPropsOf(log.document, column.id)).toBeNull();
  });
});

describe('输入框那一发的预言', () => {
  it('命令工厂里那半道门也在 try 内：非整数毫米给文案，不给未捕获异常', () => {
    const { log, storeyId } = synthStorey();
    const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    // `wallSetThickness(240.5)` 在**构造期**就抛（`assertMm`），所以 `trialCommand` 吃的是工厂函数。
    // 改成吃 Command 对象的话这一行是"测试自己抛"，红在测试而不是红在预言 —— 那条红同样有效，
    // 但它不告诉下一个人为什么签名是 `() => Command`。
    const rough = trialCommand(log.document, () =>
      wallSetThickness({ wallId: wall.id, thicknessMm: 240.5 }),
    );
    expect(rough.ok).toBe(false);
    expect(rough.reason).toMatch(/必须是整数毫米/);
  });

  it('真源三道门各一句文案：非正、墙厚不小于轴长、墙不存在', () => {
    const { log, storeyId } = synthStorey();
    const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    expect(trialCommand(log.document, () => wallSetThickness({ wallId: wall.id, thicknessMm: 370 }))).toEqual({
      ok: true,
      reason: null,
    });
    for (const mm of [0, -240]) {
      const bad = trialCommand(log.document, () => wallSetThickness({ wallId: wall.id, thicknessMm: mm }));
      expect(bad.ok).toBe(false);
      expect(bad.reason).toMatch(/必须为正/);
    }
    const tooThick = trialCommand(log.document, () =>
      wallSetThickness({ wallId: wall.id, thicknessMm: 4000 }),
    );
    expect(tooThick.reason).toMatch(/不小于墙长/); // 真源那句带数字，比屏幕自编的"太大"有用
    const gone = trialCommand(log.document, () => wallSetThickness({ wallId: 'gone', thicknessMm: 240 }));
    expect(gone.ok).toBe(false);
    expect(gone.reason).toMatch(/不存在|不是墙/); // `mustExist` / `requireWall` 的文案，屏幕不复述
  });

  it('T 接改厚被派生复核挡下：命令层三道门全过，拒它的是「直通两墙厚度不同」', () => {
    const tee = teeJoint();
    const doc = tee.log.document;
    // 先自证命令层看不见这件事：370 < 轴长 4000、是正整数、墙存在 ⇒ 前三道门全过
    expect(tee.west.thicknessMm).toBe(240);
    const trial = trialCommand(doc, () => wallSetThickness({ wallId: tee.west.id, thicknessMm: 370 }));
    expect(trial.ok).toBe(false);
    expect(trial.reason).toMatch(/直通两墙厚度不同/);
    // 素材自证 ①：stem（垂直那臂）加厚不受这条纪律约束 ⇒ 上一发红在"贯通两墙"，不红在"加厚"
    expect(trialCommand(doc, () => wallSetThickness({ wallId: tee.stem.id, thicknessMm: 370 })).ok).toBe(true);
    // 素材自证 ②：同值重设合法 ⇒ 红在"两侧不同厚"，不红在"这面墙谁都改不动"
    expect(trialCommand(doc, () => wallSetThickness({ wallId: tee.west.id, thicknessMm: 240 })).ok).toBe(true);
  });

  it('两侧逐条连发改不动 T 接：每条各自复核自己那一发之后的世界', () => {
    // 这是属性面板的**能力边界**，写成判据而不是注释：屏幕上"把两侧都改成 800"只能是两次派发，
    // 第一次派发时另一侧还是 240 ⇒ 被拒；第二次时两侧仍不同（第一次没落地）⇒ 再被拒。
    // 拆掉 stem（T 变纯贯通两臂点）之后同两发改得动 —— 2026-09-28 实测：厚度 800/800、深度 7。
    const tee = teeJoint();
    const log = tee.log;
    const first = trialCommand(log.document, () =>
      wallSetThickness({ wallId: tee.west.id, thicknessMm: 800 }),
    );
    expect(first.ok).toBe(false);
    const second = trialCommand(log.document, () =>
      wallSetThickness({ wallId: tee.east.id, thicknessMm: 800 }),
    );
    expect(second.ok).toBe(false);
    expect(log.depth).toBe(4); // 三层 + 一根 stem，一次派发都没发生
    // 拆掉 stem ⇒ T 接不在这里了，两发连发就过（面板给出的下一步"改画成 L 角"真的走得通）
    log.dispatch(wallDelete({ wallId: tee.stem.id }));
    expect(trialCommand(log.document, () => wallSetThickness({ wallId: tee.west.id, thicknessMm: 800 })).ok).toBe(true);
    log.dispatch(wallSetThickness({ wallId: tee.west.id, thicknessMm: 800 }));
    expect(trialCommand(log.document, () => wallSetThickness({ wallId: tee.east.id, thicknessMm: 800 })).ok).toBe(true);
  });

  it('试跑不动真源：墙数、那面墙的厚度、撤销栈深度三票原样', () => {
    const { log, storeyId } = synthStorey();
    const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const depthBefore = log.depth;
    expect(trialCommand(log.document, () => wallSetThickness({ wallId: wall.id, thicknessMm: 370 })).ok).toBe(true);
    expect(log.depth).toBe(depthBefore);
    expect(log.document.get(wall.id)).toEqual(wall); // 引用逐字相同：不可变文档没被试跑动过
    const rejected = trialCommand(log.document, () =>
      wallSetThickness({ wallId: wall.id, thicknessMm: 9999 }),
    );
    expect(rejected.ok).toBe(false); // 9999 > 轴长 4000：预言给 false，而真源一个字没动
    expect(log.document.get(wall.id)).toEqual(wall);
    expect(log.depth).toBe(depthBefore);
    // 反证：真的派发一次，三票全变 ⇒ 上面那两句不是"恒不变"
    log.dispatch(wallSetThickness({ wallId: wall.id, thicknessMm: 370 }));
    expect(log.depth).toBe(depthBefore + 1);
  });

  it('承重与材料不进派生：同值反复点各留一条撤销记录（T7 裁决 A4 的代价在屏幕侧有读者）', () => {
    const { log, storeyId } = synthStorey();
    const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    for (const material of ['brick', 'brick', 'brick']) {
      expect(trialCommand(log.document, () => wallSetMaterial({ wallId: wall.id, material })).ok).toBe(true);
    }
    const depthBefore = log.depth;
    log.dispatch(wallSetLoadBearing({ wallId: wall.id, loadBearing: true })); // 与现值相同的一发
    expect(log.depth).toBe(depthBefore + 1);
    expect(log.undo()).toBe(true);
    expect(log.document.get(wall.id)).toEqual(wall); // 撤销回到原样 ⇒ 代价只是栈里多一条空改动
  });

  it('屏幕常量不是输入框的上限：300mm 的墙真源收，而 `MIN_WALL_LENGTH_MM` 是 500', () => {
    // Task 6 交过来的那一条（E17 的凭据登记在这里）。三个事实摞在一起才叫"分家"：
    // ① 真源对长度只有两道（零长、墙厚 < 轴长），一面 300mm 的墙建得出来 —— 短得没法施工，但合法；
    // ② `MIN_WALL_LENGTH_MM` = 500 比真源严，而它只活在 `wallProbe` 挑靶子里；
    // ③ 于是面板若拿 ② 当输入上限，就会拒掉真源已经收下的一发 ⇒ 屏幕上"这面墙存在"与"改不动它"同时发生。
    const { log, storeyId } = synthStorey();
    const short = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 300, y: 0 });
    const props = wallPropsOf(log.document, short.id);
    if (props === null) throw new TypeError('300mm 的墙读不出属性');
    expect(props.axisLengthMm).toBe(300);
    expect(300).toBeLessThan(MIN_WALL_LENGTH_MM);
    expect(trialCommand(log.document, () => wallSetThickness({ wallId: short.id, thicknessMm: 299 })).ok).toBe(true);
    // 真源那两道门仍然在说话：240 厚 240 长的墙连建都建不出来（屏幕常量换成真源口径也不放宽）
    expect(() =>
      wallCreate({
        storeyId,
        start: { x: 500, y: 500 },
        end: { x: 740, y: 500 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    ).toThrow(/不小于墙长/);
  });
});

describe('楼层 tab', () => {
  it('样例房两层：按 index 升序、标签逐字、标高读真源（二层是被编辑过的那一份）', () => {
    const lower = house.doc.get(house.lowerStoreyId);
    if (lower?.kind !== 'storey') throw new TypeError('一层读出来不是楼层实体');
    const projectId = lower.projectId;
    expect(storeyTabsOf(house.doc, projectId)).toEqual([
      // 二层被 `storeySetElevation` 从 6000 改成 3000（demo.ts 的第 4 次编辑）。
      // tab 读真源而不是算 `index * heightMm`：改过标高之后两者不等，屏幕上写的是假数字。
      { storeyId: house.lowerStoreyId, index: 0, elevationMm: 0, heightMm: 3000, label: '第 1 层' },
      { storeyId: house.upperStoreyId, index: 1, elevationMm: 3000, heightMm: 3000, label: '第 2 层' },
    ]);
  });

  it('外来项目的楼层不进本项目的 tab', () => {
    const { log, storeyId, projectId } = synthStorey();
    const foreign = uuidv7();
    log.dispatch(storeyCreate({ projectId: foreign, index: 0, elevationMm: 0, heightMm: 3000 }));
    const foreignStoreyId = [...log.affected].find(
      (id) => log.document.get(id)?.kind === 'storey' && id !== storeyId,
    );
    if (foreignStoreyId === undefined) throw new TypeError('affected 里没有外来项目那层');
    expect(storeyTabsOf(log.document, projectId).map((t) => t.storeyId)).toEqual([storeyId]);
    expect(storeyTabsOf(log.document, foreign).map((t) => t.storeyId)).toEqual([foreignStoreyId]);
    expect(log.document.byKind('storey').length).toBe(2); // 素材自证：过滤真的在筛，文档里确实两层
  });

  it('顺序按 index 而不是按 id：十轮打乱里至少五轮 id 序与 index 序不同（摘掉 sort 的凭据）', () => {
    // `Document.byKind` 按 id 升序返回，而 uuidv7 在同一毫秒内不单调 ⇒ "照抄 byKind 的顺序"
    // 是一个跨进程漂的写法。这一条把 sort 的凭据钉成**可数的量**：同一套夹具跑十轮，
    // 数出"byKind 的 index 序列 ≠ tab 的 index 序列"的轮数。
    // 2026-09-28 跑六次，十轮里的轮数依次为 9、8、9、8、7、9 ⇒ 下限取 5（每轮独立，
    // 10 轮全序的概率约 (1/6)^10；写成 5 而不是实测最小值，是为了不把这条变成"今天 uuid 恰好这么排"）。
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
      [2, 1, 0],
      [1, 2, 0],
      [2, 0, 1],
      [0, 2, 1],
    ];
    let disagrees = 0;
    for (const permutation of permutations) {
      const projectId = uuidv7();
      const log = new TransactionLog(Document.create(projectId));
      // 三层各 3000 高、贴邻不重叠（`storeyCreate` 判重叠，贴邻合法）；index 由这一轮给
      for (const [level, index] of permutation.entries()) {
        log.dispatch(storeyCreate({ projectId, index, elevationMm: level * 3000, heightMm: 3000 }));
      }
      const tabs = storeyTabsOf(log.document, projectId);
      expect(tabs.map((t) => t.index)).toEqual([0, 1, 2]);
      // tab 的 storeyId 必须与那一层真源的 index / 标高配套：只按 index 排序、
      // 但字段抄自另一层（排序排错了对象）时这两句红，上面那句只看 index 不够。
      for (const tab of tabs) {
        const storey = log.document.get(tab.storeyId);
        if (storey?.kind !== 'storey') throw new TypeError('tab 指着的实体不是楼层');
        expect(storey.index).toBe(tab.index);
        expect(storey.elevationMm).toBe(tab.elevationMm);
        expect(storey.heightMm).toBe(tab.heightMm);
      }
      const byId = log.document
        .byKind('storey')
        .filter((s) => s.projectId === projectId)
        .map((s) => s.index);
      if (byId.join(',') !== tabs.map((t) => t.index).join(',')) disagrees += 1;
    }
    // 写成下限而不是等号：等号会让这条变成"今天 uuid 恰好这么排"的第二个跨进程判据。
    console.log("DISAGREES=" + disagrees); expect(disagrees).toBeGreaterThanOrEqual(5);
  });

  it('只有一层时 tab 也有一条：不许"单层就不显示列表"把切换入口一起砍掉', () => {
    const { log, storeyId, projectId } = synthStorey();
    expect(storeyTabsOf(log.document, projectId)).toEqual([
      { storeyId, index: 0, elevationMm: 0, heightMm: 3000, label: '第 1 层' },
    ]);
  });
});
