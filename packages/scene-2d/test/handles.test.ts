import { describe, expect, it } from 'vitest';
import {
  applyPatch,
  deriveStoreyGeometry,
  Document,
  TransactionLog,
  requirePoint,
  storeyCreate,
  uuidv7,
  vec,
  wallAxisById,
  wallCreate,
  wallMoveEndpoint,
  type WallEntity,
} from '@dajia/core';
import {
  buildDrawList,
  demoHouse,
  dragHandlesOf,
  dragProbe,
  dropTargetOf,
  EMPTY_SELECTION,
  fitStorey,
  HANDLE_COLOR,
  HANDLE_RADIUS_PX,
  handleDropTarget,
  legalDrop,
  mmToPx,
  moveTargetOf,
  pickHandle,
  pickOne,
  PIXEL_CHANNEL_TOL,
  pointSnapshot,
  PREVIEW_COLOR,
  pxToMm,
  PICK_TOL_PX,
  SELECTED,
  snapFieldOf,
  SNAP_COLOR,
  SNAP_TOL_PX,
  viewportOf,
  type DragHandle,
  type MoveTarget,
  type Px,
  type Selection,
  type Viewport,
} from '@dajia/scene-2d';

const house = demoHouse();
const view = fitStorey(house.doc, house.lowerStoreyId, 1200, 900, 60);
const ops = buildDrawList(house.doc, house.lowerStoreyId, view, EMPTY_SELECTION);

const sel = (...ids: string[]): Selection => ({ ids: new Set(ids) });

/**
 * `handles.ts` 里 `PROBE_OFFSETS` 那十发的**副本**（那是文件私有常量，出口里没有它）。
 * 复制而不是导入是故意的：探针扫的就是这十个偏移，测试要拿同一套偏移去覆盖它，
 * 二者必须逐字相同 —— 而"改了那边忘了这边"的红法由最后一条覆盖判据负责（那一句会红）。
 */
const SWEEP_OFFSETS: readonly MoveTarget[] = [
  { x: 0, y: 800 },
  { x: 800, y: 0 },
  { x: 0, y: -800 },
  { x: -800, y: 0 },
  { x: 600, y: 600 },
  { x: -600, y: 600 },
  { x: 600, y: -600 },
  { x: -600, y: -600 },
  { x: 0, y: 2400 },
  { x: 2400, y: 0 },
];

/**
 * 样例房一层拐角 (4000, 0) 上的两面墙：southEast 向东、stem 向北，两者的 startId
 * 是同一枚点（southWest 的 end）。共享点与非共享点在这里才分得开。
 *
 * 按坐标找墙，不按创建顺序：uuidv7 同毫秒不单调，`byKind` 又是 id 升序，
 * "第 n 面墙"这种说法在真源里没有意义（T2 的 demo.ts 为此把八面墙写成八个具名 const）。
 */
function wallsAtJunction(): { junction: WallEntity; other: WallEntity } {
  const byXY = (ax: number, ay: number, bx: number, by: number): WallEntity => {
    for (const w of house.doc.byKind('wall')) {
      if (w.storeyId !== house.lowerStoreyId) continue;
      const a = requirePoint(house.doc, w.startId, '墙端点');
      const b = requirePoint(house.doc, w.endId, '墙端点');
      if (a.x === ax && a.y === ay && b.x === bx && b.y === by) return w;
    }
    throw new Error(`样例房一层找不到 (${ax}, ${ay})→(${bx}, ${by}) 这面墙`);
  };
  return { junction: byXY(4000, 0, 8000, 0), other: byXY(4000, 0, 4000, 3000) };
}

/**
 * 合成一层：被拖的那枚接头 A 是**两面墙**（北墙 0→(0,1040)、东墙 0→(1040,0)，同厚 240）共用的
 * **角（corner，2 向）**，另挂一面对手墙把第三发候选的裸落点吸走。它只服务下面这一条用例
 * （三套探针夹具里唯一用到它的一套），所以判据口径按这条用例的意图重新设计。
 *
 * 为什么不能像旧夹具那样把四面墙钉在同一个 A 上：那样 A 恒为 **star（4 向）**，而
 * `deriveStoreyGeometry` 对 star 抛 `RangeError` —— `dragProbe` 里的 `derivesAfterMove` 正是拿它
 * 当谓词，于是 A 的任何非原地落点全被筛掉，探针恒 `null`（这是 2026-09-29 那条恒红的真凶）。
 * 更深一层：把一枚接头**吸到既有点 `pointId`** 上，`wallMoveEndpoint` 复用那枚点就造出 3 向接头
 * = star，在 `derivesAfterMove` 之下这一档对探针**结构性不可达**。所以这里的吸附靶子是一枚
 * **坐标重合、拓扑上不共用点**的垂足（对手墙 x=40 那条竖轴的垂足）：它 `SnapKind='foot'`、
 * `pointId=null`，把 A 挪到 (40,-800) 后 A 仍是那两面墙的角 ⇒ 派生得出、探针给得出非 null。
 *
 * A 的 id 只认第一次 `wallCreate` 的 affected（`createdWallOf`），**不许** `byKind('point')[0]`：
 * uuidv7 同毫秒不单调，那样写会把 A 拿成 (0,1040) 那枚点，两面墙端点错配、core 当场抛。
 */
function wallsForProbeSnap(): { log: TransactionLog; storeyId: string } {
  const projectId = uuidv7();
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  let storeyId = '';
  for (const id of log.affected) {
    if (log.document.get(id)?.kind === 'storey') storeyId = id;
  }
  if (storeyId === '') throw new TypeError('affected 里没有新建的楼层');
  log.dispatch(wallCreate({ storeyId, start: { x: 0, y: 0 }, end: { x: 0, y: 1040 }, thicknessMm: 240, heightMm: 3000 }));
  const a = createdWallOf(log).startId;
  log.dispatch(wallCreate({ storeyId, start: { pointId: a }, end: { x: 1040, y: 0 }, thicknessMm: 240, heightMm: 3000 }));
  // 对手墙：竖轴 x=40（y 从 -1200 到 -400）。第三发候选 (0,-800) 的裸落点到这条轴的垂足是
  // (40,-800) —— 离裸落点 40mm，0.1px/mm 下 4px（容差 8px 之内）⇒ 探针必吸它。它是 free 端点
  // 的墙、不碰 A，所以 A 吸过去仍是角。
  log.dispatch(wallCreate({ storeyId, start: { x: 40, y: -1200 }, end: { x: 40, y: -400 }, thicknessMm: 240, heightMm: 3000 }));
  return { log, storeyId };
}

/**
 * 最近一次 dispatch 的 affected 里那面墙。**不许** `byKind('wall').at(-1)`：uuidv7 同毫秒
 * 不单调，`byKind` 又是 id 升序，"最后一面"跟"最后建的"不是一回事。
 */
function createdWallOf(log: TransactionLog): WallEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new TypeError('affected 里没有新建的墙');
}

describe('拖拽把手', () => {
  it('空选中集没有把手；选中一面墙给两个，端点与点 id 配对钉死', () => {
    const { junction } = wallsAtJunction();
    expect(dragHandlesOf(house.doc, house.lowerStoreyId, EMPTY_SELECTION, view)).toEqual([]);
    const handles = dragHandlesOf(house.doc, house.lowerStoreyId, sel(junction.id), view);
    expect(handles).toHaveLength(2);
    const start = handles.find((h) => h.end === 'start');
    const end = handles.find((h) => h.end === 'end');
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    // 角色配对：标着 'start' 的那把引用的必须是 startId。若实现把两端写反（计划 1 真反过一次），
    // 屏幕上两个把手会互换位置，而"两个把手"这条计数照过 —— 所以必须逐把对 id。
    expect(start!.pointId).toBe(junction.startId);
    expect(end!.pointId).toBe(junction.endId);
    const axis = wallAxisById(house.doc, junction.id);
    const startPx = mmToPx(view, axis.start);
    const endPx = mmToPx(view, axis.end);
    // 位置与墙多边形同一个产地（wallAxisById）：各算各的就会在斜切墙脚上错开半个把手
    expect([start!.atPx.x, start!.atPx.y]).toEqual([startPx.x, startPx.y]);
    expect([end!.atPx.x, end!.atPx.y]).toEqual([endPx.x, endPx.y]);
    // anchorPx 是"另一端"：压扁拖要的正是这个值，配错端就等于给了一条不存在的靶子
    expect([start!.anchorPx.x, start!.anchorPx.y]).toEqual([endPx.x, endPx.y]);
    expect([end!.anchorPx.x, end!.anchorPx.y]).toEqual([startPx.x, startPx.y]);
    // atMm 就是真源里那对整数毫米，没经过任何 px ↔ mm 往返（往返会漂）
    const corner = requirePoint(house.doc, junction.startId, '拐角');
    expect(start!.atMm).toEqual({ x: corner.x, y: corner.y });
    expect(Number.isInteger(start!.atMm.x) && Number.isInteger(start!.atMm.y)).toBe(true);
    // 半径要画得出来，且小于命中容差：否则"看得见却点不中"，用户只会说鼠标坏了
    expect(HANDLE_RADIUS_PX).toBeGreaterThan(0);
    expect(HANDLE_RADIUS_PX).toBeLessThan(PICK_TOL_PX);
  });

  it('别层的墙、洞口 id、楼层 id、根本不存在的 id 一律不给把手（且不抛）', () => {
    const upper = house.doc.byKind('wall').find((w) => w.storeyId === house.upperStoreyId);
    const opening = house.doc.byKind('opening')[0];
    expect(upper).toBeDefined(); // 先证明样例房真有二层墙与洞口，否则这条是空的
    expect(opening).toBeDefined();
    expect(
      dragHandlesOf(
        house.doc,
        house.lowerStoreyId,
        sel(upper!.id, opening!.id, house.lowerStoreyId, '00000000-0000-7000-8000-000000000009'),
        view,
      ),
    ).toEqual([]);
  });

  it('把手顺序与选中集的插入顺序无关（决定性与可重放）', () => {
    const { junction, other } = wallsAtJunction();
    const forward = dragHandlesOf(house.doc, house.lowerStoreyId, sel(junction.id, other.id), view);
    const backward = dragHandlesOf(house.doc, house.lowerStoreyId, sel(other.id, junction.id), view);
    expect(forward).toHaveLength(4);
    expect(backward).toEqual(forward);
    // 排序键 `${wallId}:${end}` 升序 —— 这一行就是约定的全部含义，不藏别的语义。
    // 同一面墙内 'end' 排在 'start' 前（字符串序），它只是"谁先"的凭据，不代表谁更重要。
    const keys = forward.map((h) => `${h.wallId}:${h.end}`);
    expect(keys).toEqual([...keys].sort());
  });
});

describe('落点与命中', () => {
  it('moveTargetOf 把浮点屏幕位置落成整数毫米，且对已是整数的输入幂等', () => {
    // 故意自造视口：0.13 px/mm 保证整数像素映射到分数毫米。
    // 不拿 `view` 做这件事 —— 它是 0.125 px/mm（T4 那条注算过），整数像素很可能本来就落在
    // 整数毫米上，那"确实有分数"这句会假红；而拿一个本来就整的输入测舍入，等于什么都没测。
    const v = viewportOf(1200, 900, { pxPerMm: 0.13, center: vec(4000, 3000) });
    const cursor = { x: 517, y: 289 };
    const raw = pxToMm(v, cursor);
    expect(raw.x % 1 !== 0 || raw.y % 1 !== 0).toBe(true); // 先证明这一发真的有分数
    const target = moveTargetOf(v, cursor);
    expect(Number.isInteger(target.x) && Number.isInteger(target.y)).toBe(true);
    // 钉住"四舍五入"这一个动作：换成 floor / ceil / trunc 都会在这里红（0.5 向正无穷侧走）
    expect(target).toEqual({ x: Math.round(raw.x), y: Math.round(raw.y) });
    // 幂等：已经是整数毫米的输入再过一遍不许漂（T6 的吸附叠在它之后，两者口径不能互相改）
    expect(moveTargetOf(v, mmToPx(v, vec(target.x, target.y)))).toEqual(target);
  });

  it('pickHandle：容差边界含等于，远处与 NaN 给 null（合成把手，不借 dragHandlesOf）', () => {
    // 合成把手的像素取整数：边界判据要精确落在 PICK_TOL_PX 上，
    // 从 mmToPx 里捞出来的浮点坐标做 `+ PICK_TOL_PX` 会因舍入误差在 `<=` 上抖。
    const handleAt = (px: number, py: number, id: string): DragHandle => ({
      wallId: id,
      end: 'start',
      pointId: `${id}-point`,
      atMm: { x: px, y: py },
      atPx: { x: px, y: py },
      anchorMm: { x: 0, y: 0 },
      anchorPx: { x: 0, y: 0 },
    });
    const handles = [handleAt(100, 40, 'a'), handleAt(300, 40, 'b')];
    expect(pickHandle(handles, { x: 100, y: 40 })?.wallId).toBe('a');
    // 与下一句是一对：答案只能由把手集合决定，不能由数组顺序决定。
    // （`dragHandlesOf` 出来的是排好序的，所以"排过序"这件事在真实路径上看不出来 ——
    // 并列的牙齿必须在这里用同一像素上的两把 synthetic 把手来试。）
    const tied = [handleAt(100, 40, 'zz'), handleAt(100, 40, 'aa')];
    expect(pickHandle(tied, { x: 100, y: 40 })?.wallId).toBe('aa');
    expect(pickHandle([...tied].reverse(), { x: 100, y: 40 })?.wallId).toBe('aa');
    // 与 T4 的 pickAt 同一口径：正好容差算命中，再多 0.01px 不算
    expect(pickHandle(handles, { x: 100 + PICK_TOL_PX, y: 40 })?.wallId).toBe('a');
    expect(pickHandle(handles, { x: 100 + PICK_TOL_PX + 0.01, y: 40 })).toBeNull();
    expect(pickHandle(handles, { x: 200, y: 40 })).toBeNull(); // 两把正中（各差 100px）都不中
    // NaN 钉的是**比较式的写法**：`!(dist <= tol)` 为真 ⇒ 跳过；若写成 `if (dist > tol) continue`，
    // NaN > tol 是 false ⇒ 不跳过，第一把把手会被当成命中（T4 第 8 条同款病，这里再守一次）。
    expect(pickHandle(handles, { x: Number.NaN, y: 40 })).toBeNull();
    expect(pickHandle(handles, { x: 100, y: Number.NaN })).toBeNull();
  });

  it('同一枚共享点上并列的两把把手：命中给唯一答案，且两把指的确实是同一个点', () => {
    const { junction, other } = wallsAtJunction();
    const corner = requirePoint(house.doc, junction.startId, '拐角');
    expect(junction.startId).toBe(other.startId); // 先证明"并列"真的是同一枚点，不是坐标恰好吧
    const both = dragHandlesOf(house.doc, house.lowerStoreyId, sel(junction.id, other.id), view);
    const at = mmToPx(view, vec(corner.x, corner.y));
    const tied = both.filter((h) => h.atPx.x === at.x && h.atPx.y === at.y);
    expect(tied).toHaveLength(2);
    expect(new Set(tied.map((h) => h.pointId)).size).toBe(1);
    const picked = pickHandle(both, at);
    expect(picked).not.toBeNull();
    expect(picked!.wallId).toBe([junction.id, other.id].sort()[0]!);
    // 换插入顺序再问一次，答案不许变："谁赢"只能取决于排序键，不能取决于 Set 的迭代序
    const shuffled = dragHandlesOf(house.doc, house.lowerStoreyId, sel(other.id, junction.id), view);
    expect(pickHandle(shuffled, at)).toEqual(picked);
  });
});

describe('合法落点与拖拽探针', () => {
  it('legalDrop 就是真源那道守卫的预言：合法 true、压扁给 false，而 false 那一发真的抛', () => {
    const { junction, other } = wallsAtJunction();
    const corner = requirePoint(house.doc, junction.startId, '拐角');
    const farEnd = requirePoint(house.doc, junction.endId, '另一端点');
    // 沿贯通线拖 (5200, 0)：southEast 变 2800、southWest 变 5200、stem 变 3231，三面都远大于各自墙厚。
    // Task 7 之前这里用的是 (4000, 1200)（southEast 4326 / southWest 4000 / stem 1800，命令层六道守卫全过
    // ⇒ 当时为 true）；派生复核挂上 `wallMoveEndpoint.build` 之后那一发把三臂拧成 star ⇒ 改判 false，
    // 合法的那一发只剩"仍然留在贯通线上"这一类。下面第三句把它钉成红字，别让 A1 悄悄改掉这条的靶子。
    expect(legalDrop(house.doc, junction.id, 'start', { x: corner.x + 1200, y: corner.y })).toBe(true);
    expect(legalDrop(house.doc, junction.id, 'start', { x: corner.x, y: corner.y + 1200 })).toBe(false);
    expect(() =>
      wallMoveEndpoint({
        wallId: junction.id,
        end: 'start',
        x: corner.x,
        y: corner.y + 1200,
      }).build(house.doc),
    ).toThrow(/S1 不支持/);
    // 拖到自己另一端上：判据不许 scene-2d 自己重算一遍轴长，它试跑的就是 core 的那道守卫
    expect(legalDrop(house.doc, junction.id, 'start', { x: farEnd.x, y: farEnd.y })).toBe(false);
    expect(() =>
      wallMoveEndpoint({ wallId: junction.id, end: 'start', x: farEnd.x, y: farEnd.y }).build(
        house.doc,
      ),
    ).toThrow(/零长墙/);
    // 最要紧的第三条：坏的不是被拖那面墙，是**邻墙**。junction（southEast）拖到 (4000, 3000)
    // 自己变 4272、southWest 变 5000，两头都合格；只有 stem 的两端重合了。
    // 屏幕上若要自己算，算的必然是"我这一面够不够长" ⇒ 判成 true ⇒ 松手才报错。
    const stemFar = requirePoint(house.doc, other.endId, 'stem 另一端点');
    expect([corner.x, corner.y]).not.toEqual([stemFar.x, stemFar.y]); // 空话防线：两个落点别是同一个
    expect(legalDrop(house.doc, junction.id, 'start', { x: stemFar.x, y: stemFar.y })).toBe(false);
    expect(() =>
      wallMoveEndpoint({
        wallId: junction.id,
        end: 'start',
        x: stemFar.x,
        y: stemFar.y,
      }).build(house.doc),
    ).toThrow(/变成零长/); // 红在邻墙那条，不是红在别的守卫上
    // 试跑不许留下痕迹：house.doc 是下面每一条共用的那份文档，被写脏了后面全不可信
    expect(requirePoint(house.doc, junction.startId, '拐角')).toEqual(corner);
  });

  it('探针只认共享点：一面孤墙（两端都没有第二面墙指着）返回 null', () => {
    const projectId = uuidv7();
    const log = new TransactionLog(Document.create(projectId));
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    const storeyId = [...log.affected].find((id) => log.document.get(id)?.kind === 'storey')!;
    log.dispatch(
      wallCreate({
        storeyId,
        start: { x: 0, y: 0 },
        end: { x: 4000, y: 0 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    );
    const wallId = [...log.affected].find((id) => log.document.get(id)?.kind === 'wall')!;
    const v = fitStorey(log.document, storeyId, 1200, 900, 60);
    // 孤墙上"选中它给两个把手"照样成立 ⇒ 上一个用例没把把手和共享点混为一谈
    expect(dragHandlesOf(log.document, storeyId, sel(wallId), v)).toHaveLength(2);
    expect(
      dragProbe(log.document, storeyId, buildDrawList(log.document, storeyId, v, EMPTY_SELECTION), v),
    ).toBeNull();
  });

  it('探针给的落点必然合法、必然真的移动、锚点必然不合法、三枚像素全为整数，且 fromPx 先点必选中那面墙', () => {
    const probe = dragProbe(house.doc, house.lowerStoreyId, ops, view);
    expect(probe).not.toBeNull(); // 样例房一层有六枚共享端点 ⇒ 拿不到靶子是探针坏了，不是没素材
    const p = probe!;
    expect(p.sharedBy).toBeGreaterThanOrEqual(2);
    const point = requirePoint(house.doc, p.pointId, '探针点');
    expect([p.targetMm.x, p.targetMm.y]).not.toEqual([point.x, point.y]); // 真的移动，不是原地空放
    expect(legalDrop(house.doc, p.wallId, p.end, p.targetMm)).toBe(true);
    expect(legalDrop(house.doc, p.wallId, p.end, moveTargetOf(view, p.anchorPx))).toBe(false);
    // 探针报的毫米必须是**renderer 松手那一发算出来的毫米**（T6 之前这里是
    // `expect(moveTargetOf(view, p.toPx)).toEqual(p.targetMm)`，本行是它换掉的写法）。
    // 为什么必须换：拖拽路径 T6 起吃吸附，样例房 16 把把手 × 10 发候选里有 14 发的落点
    // **不等于**裸落点（15° 档把它们改写了，见下面"拖拽路径真的在吃吸附"那条），而"哪面墙先被扫到"
    // 由 uuidv7 决定 ⇒ 老写法实测 10 个进程红 2 个。换掉之后这一句恒等：两边是同一个纯函数、
    // 同一对入参。上面那句 `legalDrop` 判的就是这一对毫米，三句话连起来才成立：
    // 探针说合法 → renderer 算出同一对毫米 → 命令必然成功 → `--edit-shot` 才许拿"逐字相等"当判据。
    const probeField = snapFieldOf(house.doc, house.lowerStoreyId);
    const probeHandle = dragHandlesOf(house.doc, house.lowerStoreyId, sel(p.wallId), view).find(
      (x) => x.end === p.end,
    )!;
    expect(
      handleDropTarget(view, p.toPx, probeHandle, probeField).mm,
    ).toEqual(p.targetMm);
    // 三枚像素必须全是整数：`sendInputEvent` 只收整数 DIP，主进程一发 `Math.round` 就把落点
    // 挪到另一对毫米上（fitStorey 的 0.13 px/mm 下差 1~4mm），上面那句"不动点"立刻变成随机红。
    // 但**这一条不是咬 snapPx 的那颗牙**：样例房 0.125px/mm 配百米毫米的坐标，取整前后本来就是
    // 同一个数，摘掉 `snapPx`（HC2）实测 8 个进程在这条上零红 —— 咬它的是下面那份 1200×901 的尺子。
    for (const spot of [p.fromPx, p.toPx, p.anchorPx]) {
      expect(Number.isInteger(spot.x) && Number.isInteger(spot.y)).toBe(true);
    }
    // D5 的"拖之前先选中"能在真窗口里成立，靠的就是这一句：起点那一发点选中的就是被拖那面墙
    expect(pickOne(ops, p.fromPx)?.ownerId).toBe(p.wallId);
    expect(p.fromPx.x).toBeGreaterThanOrEqual(0);
    expect(p.fromPx.x).toBeLessThanOrEqual(view.widthPx);
    expect(p.fromPx.y).toBeGreaterThanOrEqual(0);
    expect(p.fromPx.y).toBeLessThanOrEqual(view.heightPx);
  });

  it('探针的落点像素必须在画布内、且那一发派生得出（否则闸门点的是别的像素、屏幕会白屏）', () => {
    // 这两条都是实测账单：`--edit-shot` 曾红成"压扁拖没被拒"，真凶是探针给的 toPx=(253,-18) ——
    // `sendInputEvent` 把越界坐标**悄悄夹到边界上**，于是那一发根本没压在端点上。
    // 另一种红是 renderer 抛 `RangeError: 接头…（star），S1 不支持`：命令的六道守卫放行了
    // 一个"派生画不出"的落点。两者都不是"测不到"，是"测的不是它声称测的那一发"。
    // 换 8 份样例房：探针候选按墙 id 排，而 id 是 uuidv7 ⇒ 单份样本会靠运气绿。
    for (let i = 0; i < 8; i += 1) {
      const h = demoHouse();
      // 1427×839 与 1427×865 是这台机器实测过的两种画布高（窗口 show/focus 后自己会变）
      const v = fitStorey(h.doc, h.lowerStoreyId, 1427, i % 2 === 0 ? 839 : 865, 40);
      const probe = dragProbe(
        h.doc,
        h.lowerStoreyId,
        buildDrawList(h.doc, h.lowerStoreyId, v, EMPTY_SELECTION),
        v,
      );
      expect(probe).not.toBeNull();
      const p = probe!;
      for (const spot of [p.fromPx, p.toPx]) {
        expect(spot.x >= 0 && spot.y >= 0).toBe(true);
        expect(spot.x <= v.widthPx - 1 && spot.y <= v.heightPx - 1).toBe(true);
      }
      expect(() =>
        deriveStoreyGeometry(
          applyPatch(
            h.doc,
            wallMoveEndpoint({
              wallId: p.wallId,
              end: p.end,
              x: p.targetMm.x,
              y: p.targetMm.y,
            }).build(h.doc),
          ).doc,
          h.lowerStoreyId,
        ),
      ).not.toThrow();
    }
  });

  it('探针幂等：同一份文档连问两次逐字节相同（回读判据不许每次跑给出不同靶子）', () => {
    expect(dragProbe(house.doc, house.lowerStoreyId, ops, view)).toEqual(
      dragProbe(house.doc, house.lowerStoreyId, ops, view),
    );
  });
});

describe('拖拽吃吸附（Task 6）', () => {
  it('anchorMm 是另一端那对整数毫米：与 atMm 分居两端、与 anchorPx 同产地', () => {
    const { junction } = wallsAtJunction();
    const handles = dragHandlesOf(house.doc, house.lowerStoreyId, sel(junction.id), view);
    const s = handles.find((h) => h.end === 'start')!;
    const e = handles.find((h) => h.end === 'end')!;
    const corner = requirePoint(house.doc, junction.startId, '拐角');
    const far = requirePoint(house.doc, junction.endId, '另一端');
    expect(s.atMm).toEqual({ x: corner.x, y: corner.y });
    expect(s.anchorMm).toEqual({ x: far.x, y: far.y });
    expect(e.anchorMm).toEqual({ x: corner.x, y: corner.y });
    // 两把把手的"另一端"恰是彼此的落点：配错端（把 anchorMm 写成 atMm、或两端写反）在这里红，
    // 而它在屏幕上的后果是角度档拿错锚 —— 拖出来的方向对着空气对齐，毫米账却全对。
    expect(s.anchorMm).toEqual(e.atMm);
    expect(e.anchorMm).toEqual(s.atMm);
    expect(s.anchorMm).not.toEqual(s.atMm);
    // 与 anchorPx 同产地：同一端换算两次必须逐字相同，不许一把取轴、一把取点
    expect(s.anchorPx).toEqual(mmToPx(view, vec(s.anchorMm.x, s.anchorMm.y)));
    expect(e.anchorPx).toEqual(mmToPx(view, vec(e.anchorMm.x, e.anchorMm.y)));
    expect(Number.isInteger(s.anchorMm.x) && Number.isInteger(s.anchorMm.y)).toBe(true);
  });

  it('anchorMm 就是压扁拖那一发：每把把手按它拖都必然不合法，按 atMm 原地不动必然合法', () => {
    const { junction, other } = wallsAtJunction();
    const handles = dragHandlesOf(house.doc, house.lowerStoreyId, sel(junction.id, other.id), view);
    expect(handles).toHaveLength(4); // 空样本防线：循环一次都不进的话，下面六句全是 vacuous truth
    for (const h of handles) {
      expect(legalDrop(house.doc, h.wallId, h.end, h.anchorMm)).toBe(false);
      expect(() =>
        wallMoveEndpoint({
          wallId: h.wallId,
          end: h.end,
          x: h.anchorMm.x,
          y: h.anchorMm.y,
        }).build(house.doc),
      ).toThrow(/零长/);
      // 对照组：这一句让上一条循环不能靠"怎么拖都不合法"蒙过去
      expect(legalDrop(house.doc, h.wallId, h.end, h.atMm)).toBe(true);
    }
  });

  it('拖拽路径真的在吃吸附：160 发候选里 72 发吸成恒等、14 发被 15° 档改写，改写全来自 angle15', () => {
    // 这条是上一批用例里那句 `moveTargetOf(view, toPx) === targetMm` 换掉的**理由**：
    // 拖拽落点从 T6 起走 `dropTargetOf`，而样例房里绝大多数候选确实吸上了东西 ——
    // 垂足（54 发）与正交（17 发）吸的是恒等（点本来就在自己那面墙的轴线上），中点 1 发；
    // 真正把落点挪走的是 15° 档那 14 发（最大位移 6.97px，仍在 `SNAP_TOL_PX` 之内）。
    // 计数跑在**全部把手 × 全部偏移**上，所以它与"uuidv7 决定探针挑哪面墙"无关：
    // 16 把把手、160 发、恒等 72、改写 14，这几个数在十个进程里逐字相同（2026-09-28 实测）。
    const fd = snapFieldOf(house.doc, house.lowerStoreyId);
    const walls = house.doc.byKind('wall').filter((w) => w.storeyId === house.lowerStoreyId);
    const handles = dragHandlesOf(house.doc, house.lowerStoreyId, sel(...walls.map((w) => w.id)), view);
    expect(handles).toHaveLength(16); // 空样本防线：一把把手都没有的话下面两个计数就是 vacuous truth
    let identity = 0;
    let rewritten = 0;
    for (const h of handles) {
      for (const off of SWEEP_OFFSETS) {
        const rawPx = mmToPx(view, vec(h.atMm.x + off.x, h.atMm.y + off.y));
        const toPx = { x: Math.round(rawPx.x), y: Math.round(rawPx.y) }; // 与探针同一发整数像素
        const ask = handleDropTarget(view, toPx, h, fd);
        expect(Number.isInteger(ask.mm.x) && Number.isInteger(ask.mm.y)).toBe(true);
        if (ask.snap === null) continue;
        expect(ask.snap.distPx).toBeLessThanOrEqual(SNAP_TOL_PX); // 吸附不许把落点甩到容差外
        if (ask.mm.x === ask.raw.x && ask.mm.y === ask.raw.y) identity++;
        else {
          rewritten++;
          // 被挪走的只可能是 15° 档：轴对齐的候选落在轴对齐墙的轴线上，垂足与正交只能给恒等。
          // 这一句是整条用例里唯一带"不许"的判据 —— 哪天垂足开始把对角候选拉回轴线，
          // 它先红在这里，而不是红在 `--edit-shot` 的逐字对账上。
          expect(ask.snap.kind).toBe('angle15');
        }
      }
    }
    expect(identity).toBeGreaterThanOrEqual(8); // 实测 72：判据只要求"吸了但没挪走"确实存在
    expect(rewritten).toBeGreaterThanOrEqual(1); // 实测 14：判据只要求"吸了且挪走了"确实存在
    // 扫的必须**盖住**探针真会走的那十发，否则上面两个数只是别人的账：
    // 从探针返回的像素反算偏移，必须能在 `SWEEP_OFFSETS` 里找到同一发（±8mm 容得下取整像素的 0.5px）。
    const p = dragProbe(house.doc, house.lowerStoreyId, ops, view)!;
    const h = dragHandlesOf(house.doc, house.lowerStoreyId, sel(p.wallId), view).find(
      (x) => x.end === p.end,
    )!;
    const atCursorMm = pxToMm(view, p.toPx);
    const delta = { x: Math.round(atCursorMm.x - h.atMm.x), y: Math.round(atCursorMm.y - h.atMm.y) };
    expect(
      SWEEP_OFFSETS.some((o) => Math.abs(o.x - delta.x) <= 8 && Math.abs(o.y - delta.y) <= 8),
    ).toBe(true);
  });

  it('把手按在原地那一发：排掉自己就谁也不吸，不排就吸回自己（dragProbe 传的就是前者）', () => {
    // 判的是 `dragProbe` 与 renderer 都传给 `dropTargetOf` 的那对参数：光标停在把手自己的像素上。
    // 这一发最容易写错成"按 pointId 排除"，而原地同时是①它自己那枚端点、②它所在轴线的 t=0 垂足、
    // ③与它同坐标的邻墙候选 —— 三个候选同一个坐标，只排 id 会漏掉后两个，表现就是"一松手墙没动"。
    // 实测样例房 16 把把手全部：传排除 ⇒ `snap === null` 且落点就是原地；不传 ⇒ 吸回自己那枚点。
    const fd = snapFieldOf(house.doc, house.lowerStoreyId);
    const walls = house.doc.byKind('wall').filter((w) => w.storeyId === house.lowerStoreyId);
    const handles = dragHandlesOf(house.doc, house.lowerStoreyId, sel(...walls.map((w) => w.id)), view);
    expect(handles.length).toBeGreaterThanOrEqual(4);
    for (const h of handles) {
      const at = { x: Math.round(h.atPx.x), y: Math.round(h.atPx.y) }; // 回读脚本发得出的那一发
      const excluded = handleDropTarget(view, at, h, fd);
      const kept = dropTargetOf(view, at, h.anchorMm, fd);
      expect(excluded.snap).toBeNull();
      expect(excluded.mm).toEqual(h.atMm); // 排掉自己之后原地那一发谁也不吸，落点就是它自己
      expect(kept.snap?.pointId).toBe(h.pointId); // 不排就吸回自己：这道筛确实有东西要挡
      expect(kept.mm).toEqual(h.atMm);
    }
  });

  it('探针吃的是吸附后的毫米：两发正向候选被真源挡下，第三发被一枚垂足接住', () => {
    // 现场故意造到"A 是那两面墙的角、前发正向候选把某面墙拖到墙厚（非法）、第三发的裸落点离一
    // 枚垂足 4px"，于是吃场的探针报**吸到垂足之后**的毫米 (40,-800)，不吃场的探针报**裸**毫米
    // (0,-800) —— 两个答案不同。靶子换成垂足而不是旧夹具那枚既有点，是因为既有点会造 star、
    // 在 derivesAfterMove 下恒被筛掉（见 `wallsForProbeSnap` 的注释）。2026-09-28 实测这条咬住的
    // 改坏：探针传 `EMPTY_SNAP_FIELD`（HB3：垂足档被清空 ⇒ 报裸 (0,-800) ⇒ 定值那句红）与换回
    // `moveTargetOf`（HB4：报裸 ⇒ `not.toEqual` 那句红），两条各红这条 + 下面那条「合法性判的是
    // 吸附后的毫米」。锚点（HB1）与排除（HB2）不在这里判 —— 它们收在 `handleDropTarget` 出口里，
    // 改出口会让"拖拽路径真的在吃吸附"与"把手按在原地那一发"逐进程红（实测 8/8），判在探针调用点
    // 上反而漏（那时探针与 renderer 一起改，行为没变）。判裸落点还是判吸附后（HB5）由下面那条专门
    // 咬，这条夹具里裸与吸两侧都合法，判不出。
    const { log, storeyId } = wallsForProbeSnap();
    // 1px = 10mm ⇒ 整数像素与整数毫米逐字往返，红的时候不必先排除舍入
    const v = viewportOf(1000, 800, { pxPerMm: 0.1, center: vec(300, 300) });
    const doc = log.document;
    const p = dragProbe(doc, storeyId, buildDrawList(doc, storeyId, v, EMPTY_SELECTION), v);
    expect(p).not.toBeNull();
    expect(p!.sharedBy).toBe(2);
    // 先自证现场：裸落点确实是第三发那一发，而探针给的是**吸到垂足之后**那对毫米
    expect(moveTargetOf(v, p!.toPx)).toEqual({ x: 0, y: -800 });
    expect(p!.targetMm).toEqual({ x: 40, y: -800 });
    expect(p!.targetMm).not.toEqual(moveTargetOf(v, p!.toPx));
    // 而合法性判的也是吸附后的毫米：原地那枚垂足把墙拖成的形状必须真的过得了真源那道守卫
    expect(legalDrop(doc, p!.wallId, p!.end, p!.targetMm)).toBe(true);
    expect(legalDrop(doc, p!.wallId, p!.end, { x: 0, y: -800 })).toBe(true); // 两个都合法 ⇒ 上面那句不是巧合
    // 前面被跳过的候选是真源挡下的，不是假设：逐发当场验一遍。这套角夹具把朝两根臂方向的
    // (0,800)/(800,0) 各把一面墙拖到墙厚 240（≤ 轴长即非法），于是探针跳过去才轮到第三发；
    // 另两发 (0,-800)/(-800,0) 是把两臂拖**长**（合法），但 (0,-800) 是赢的那发（裸合法 + 吸到垂足，
    // 见上），(-800,0) 在它之后、探针已返回不再评估。前提漂了这里先红，不会让上面那两句变成猜。
    for (const off of [
      { x: 0, y: 800 },
      { x: 800, y: 0 },
    ]) {
      expect(legalDrop(doc, p!.wallId, p!.end, { x: off.x, y: off.y })).toBe(false);
    }
  });

  it('合法性判的是吸附后的毫米：裸对角被 star 挡下、吸回贯通线那一发过得了守卫', () => {
    // Task 7 把派生复核挂上 `wallMoveEndpoint.build`（裁决 A1）之后，star 在松手前就拒，
    // 于是这里能造出"同一发整数像素，裸落点非法、吸上去那一发合法"的分歧 —— 上一条例用里裸与吸
    // 两侧都合法，判不出这件事，所以它只能证"探针在吃吸附"，证不了"合法性判在吸附之后"。
    // 夹具：一个 T 接 —— 贯通线 x=0（A→(0,1000) 与 A→(0,-1000) 共点 A）+ 一根 45° 斜撑 A→(700,-700)，
    // A 是三臂点。尺子取 1px = 100mm（`pxPerMm: 0.01`）：容差 8px 在这把尺子上就是 800mm，
    // 所以第五发对角 (600,600) 的裸落点虽然离贯通线还有 600mm，仍然吸得回来（垂足档，6.00px）。
    // 裸的那一发把三臂拧成 star ⇒ S1 不支持；吸回线上 (0,600) 的那一发仍是"一条线 + 一根撑" ⇒ 过守卫。
    // 于是判 `drop.raw` 的实现（改坏 HB5）会把十发全筛光 ⇒ 报 null（2026-09-28 实测：本夹具上
    // 判 raw 的探针给 null，判 mm 的给 to=(506,394)、mm=(0,600)），两条探针用例一起红。
    // **Task 8 D3 之后那一发 mm 换成 (0,500)**：这把尺子 1px = 100mm，而贯通线那截墙的**中点**
    // 就在 (0,500) —— 它与原来的垂足 (0,600) 在屏幕上只差 1px，具名点优先那条规则（`FOOT_ABSORB_PX`
    // = 1.5px）因此把无名垂足挡在池外。判据没换：裸落点 (600,600) 仍然拧成 star 被拒，
    // 吸回来的那一发仍然在贯通线上、仍然过守卫，只是"线上那一点"从垂足换成了那截墙的中点。
    const projectId = uuidv7();
    const log = new TransactionLog(Document.create(projectId));
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    let storeyId = '';
    for (const id of log.affected) {
      if (log.document.get(id)?.kind === 'storey') storeyId = id;
    }
    if (storeyId === '') throw new TypeError('affected 里没有新建的楼层');
    log.dispatch(wallCreate({ storeyId, start: { x: 0, y: 0 }, end: { x: 0, y: 1000 }, thicknessMm: 240, heightMm: 3000 }));
    const up = createdWallOf(log);
    log.dispatch(wallCreate({ storeyId, start: { pointId: up.startId }, end: { x: 0, y: -1000 }, thicknessMm: 240, heightMm: 3000 }));
    log.dispatch(wallCreate({ storeyId, start: { pointId: up.startId }, end: { x: 700, y: -700 }, thicknessMm: 240, heightMm: 3000 }));
    const v = viewportOf(1000, 800, { pxPerMm: 0.01, center: vec(0, 0) });
    const doc = log.document;
    const ops = buildDrawList(doc, storeyId, v, EMPTY_SELECTION);
    const p = dragProbe(doc, storeyId, ops, v);
    expect(p).not.toBeNull();
    expect(p!.sharedBy).toBe(3); // 三臂点：star 这条判据要的就是"搬起来会拧成三方向"
    // 现场自证分歧真的存在：同一发整数像素，裸落点过不了守卫，吸上去那一发过得了。
    expect(moveTargetOf(v, p!.toPx)).toEqual({ x: 600, y: 600 });
    expect(p!.targetMm).toEqual({ x: 0, y: 500 });
    expect(legalDrop(doc, p!.wallId, p!.end, { x: 600, y: 600 })).toBe(false);
    expect(() =>
      wallMoveEndpoint({ wallId: p!.wallId, end: p!.end, x: 600, y: 600 }).build(doc),
    ).toThrow(/S1 不支持/);
    expect(legalDrop(doc, p!.wallId, p!.end, p!.targetMm)).toBe(true);
    // 前提不许是假设：探针**赢的那把把手**上，前四发（+y / +x / -y / -x）吸附后的落点逐发非法，
    // 第五发才第一次合法 —— 前提漂了这里先红，上面那五句不会变成猜。
    const field = snapFieldOf(doc, storeyId);
    const handle = dragHandlesOf(
      doc,
      storeyId,
      { ids: new Set(doc.byKind('wall').filter((w) => w.storeyId === storeyId).map((w) => w.id)) },
      v,
    ).find((h) => h.wallId === p!.wallId && h.end === p!.end)!;
    const firstFour = [
      { x: 0, y: 800 },
      { x: 800, y: 0 },
      { x: 0, y: -800 },
      { x: -800, y: 0 },
    ];
    const pxOf = (mm: MoveTarget): { x: number; y: number } => {
      const at = mmToPx(v, mm);
      return { x: Math.round(at.x), y: Math.round(at.y) };
    };
    for (const off of firstFour) {
      const px = pxOf(off);
      expect(legalDrop(doc, handle.wallId, handle.end, handleDropTarget(v, px, handle, field).mm)).toBe(false);
    }
    const fifth = handleDropTarget(v, pxOf({ x: 600, y: 600 }), handle, field);
    expect(fifth.raw).toEqual({ x: 600, y: 600 });
    expect(fifth.mm).toEqual({ x: 0, y: 500 });
    // Task 8 D3 之前这两句钉的是 (0,600) 与 `'foot'`（"吸的是垂足，不是既有点"）。这把尺子
    // 1px = 100mm，而贯通线那截墙的中点 (0,500) 与那枚垂足在屏幕上只差 1px ⇒ 具名点优先
    // （`FOOT_ABSORB_PX` = 1.5px）把无名垂足挡在池外，赢的换成中点。**本条用例判的还是同一件事**：
    // 裸落点 (600,600) 拧成 star 被拒，吸附后那一发在贯通线上、过得了守卫 —— 换的只是
    // "线上那一点"由谁提供。垂足档本身仍然有牙，而且是在"离具名点足够远"的那一侧：
    // `snapping.test.ts`「垂足比端点近时距离赢」（垂足离端点 200mm = 4px）与
    // 「中段垂足照吸：离两端与中点都远超一像素的落点仍然是 foot（不许过吸）」两条钉着它。
    expect(fifth.snap?.kind).toBe('midpoint');
  });

  it('探针的三枚像素在分数尺子下才见取整的牙齿：取整前是浮点，报出来全为整数', () => {
    // T5 那条「三枚像素全为整数」在样例房那份 `fitStorey(…, 1200, 900, 60)` 上是**假绿**：
    // 0.125px/mm 配百米毫米的坐标，取整前后本来就是同一个数（2026-09-28 实测：摘掉 `snapPx`
    // 八个进程零红）。这一份 1200×901 把尺子换成 781/6240 px/mm，把手与候选的像素全是浮点，
    // 于是那三句"整数"判的才真是取整这一步 —— 而它是 `--edit-shot`「落点逐字相等」的地基：
    // 主进程 `sendInputEvent` 只收整数 DIP，探针给浮点就是拿浮点跟主进程对赌。
    const frac = fitStorey(house.doc, house.lowerStoreyId, 1200, 901, 60);
    const p = dragProbe(
      house.doc,
      house.lowerStoreyId,
      buildDrawList(house.doc, house.lowerStoreyId, frac, EMPTY_SELECTION),
      frac,
    )!;
    const h = dragHandlesOf(house.doc, house.lowerStoreyId, sel(p.wallId), frac).find(
      (x) => x.end === p.end,
    )!;
    // 现场自证：这把把手的原生像素就是浮点 ⇒ 下面三句不是"本来就整数"蒙过去的
    expect(Number.isInteger(h.atPx.x) && Number.isInteger(h.atPx.y)).toBe(false);
    expect(Number.isInteger(p.fromPx.x) && Number.isInteger(p.fromPx.y)).toBe(true);
    expect(Number.isInteger(p.toPx.x) && Number.isInteger(p.toPx.y)).toBe(true);
    expect(Number.isInteger(p.anchorPx.x) && Number.isInteger(p.anchorPx.y)).toBe(true);
    // 报出来的像素 = 原生像素四舍五入，不是"另算一遍"：`fromPx` 与把手必须同源
    expect(p.fromPx).toEqual({ x: Math.round(h.atPx.x), y: Math.round(h.atPx.y) });
    // 取整那一发反算的毫米与真源现值不同 ⇒ 这一发真的被搬到了整数像素上
    expect(p.targetMm).not.toEqual(h.atMm);
    // 与 renderer 同一个调用：同一发整数像素再问一次，答案逐字相同（浮点尺子下这条更要紧）
    expect(
      handleDropTarget(frac, p.toPx, h, snapFieldOf(house.doc, house.lowerStoreyId)).mm,
    ).toEqual(p.targetMm);
  });

  it('探针交出的三发像素全在画布内（锚点也算一发）：四份视口相位都交得出可用靶子（相位扫，牙在下一条）', () => {
    // `--edit-shot` 第 9 步「压扁到锚点」按的是 `anchorPx`。T5 写这条探针时画布铺满整个窗口
    // ⇒ 越界不可能发生，`anchorPx` 因此从没进过筛（`fromPx` / `toPx` 都进了）。Task 8 的三格布局
    // 把画布缩成 1167×833，同一份样例房第一次出现"锚点在画布外"的靶子（2026-09-29 实测
    // `anchorPx=(1302,-32)`），那一发点到属性面板上 ⇒ `lastError` 恒空，闸门在十秒等待上抛。
    // 判据口径与 `wallProbe` 的筛⑤ 同一条（留 2px 边：`Math.round` 出来的 0 与 `widthPx` 本身
    // 压在边界像素上，而画布外侧没有像素）。
    // **这一条是相位扫，不是牙**：样例房哪把把手赢由 uuidv7 定，"锚点出界"只在恰好挑中那一把时
    // 才红（本仓库实测：同一份 1167×833，真窗口那次挑中了出界的那把、单元测试连跑几次都挑中
    // 没出界的）⇒ 确定性判据在下一条夹具用例。这一条管的是反面：锚点筛若过严把靶子全筛光，红在这儿。
    const inside = (v: Viewport, px: Px): boolean =>
      px.x >= 2 && px.y >= 2 && px.x < v.widthPx - 2 && px.y < v.heightPx - 2;
    for (const [wPx, hPx] of [
      [1167, 833], // Task 8 之后真窗口的实测画布
      [1427, 865], // Task 8 之前那一份
      [1200, 901], // 上面那条分数尺子用例用的那一份
      [900, 700], // 再窄一档：整张图缩得更小，锚点更容易跑出画布
    ]) {
      const v = fitStorey(house.doc, house.lowerStoreyId, wPx, hPx, 60);
      const p = dragProbe(
        house.doc,
        house.lowerStoreyId,
        buildDrawList(house.doc, house.lowerStoreyId, v, EMPTY_SELECTION),
        v,
      );
      expect(p, `${String(wPx)}×${String(hPx)} 这份视口下探针给不出靶子`).not.toBeNull();
      for (const [label, px] of [
        ['fromPx', p!.fromPx],
        ['toPx', p!.toPx],
        ['anchorPx', p!.anchorPx],
      ] as const) {
        expect(inside(v, px), `${String(wPx)}×${String(hPx)} 的 ${label}=(${px.x},${px.y}) 出界`).toBe(true);
      }
    }
  });

  it('锚点出界的靶子一律不许交出去：宽窄两份视口只差锚点那一发出不出画布', () => {
    // `--edit-shot` 第 9 步「压扁到锚点」按的是 `anchorPx`，而 `dragProbe` 只筛了 `fromPx` 与
    // `toPx`（T5 那两份），锚点从来没进筛 —— 画布铺满整窗时它不可能出界，于是这条漏筛在
    // Task 6/7 一直不可见。Task 8 把画布缩成 1167×833 之后它第一次被真窗口踩中：探针交出的
    // `anchorPx=(1302,-32)` 落在属性面板上，那一发点不到画布 ⇒ `lastError` 恒空，闸门在
    // 「压扁拖没被拒」那一句十秒等待上抛（2026-09-29 实测）。
    // 夹具刻意做成"除了锚点，两条视口之间没有任何差别"：A 是三臂以外的普通共享端点（两臂），
    // 两根 40000mm 的长墙把两端推到画布外，而 800 / 2400mm 那十发偏移在窄视口里仍然全在画布内。
    const projectId = uuidv7();
    const log = new TransactionLog(Document.create(projectId));
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    let storeyId = '';
    for (const id of log.affected) {
      if (log.document.get(id)?.kind === 'storey') storeyId = id;
    }
    if (storeyId === '') throw new TypeError('affected 里没有新建的楼层');
    log.dispatch(wallCreate({ storeyId, start: { x: 0, y: 0 }, end: { x: 40000, y: 0 }, thicknessMm: 240, heightMm: 3000 }));
    const east = createdWallOf(log);
    log.dispatch(wallCreate({ storeyId, start: { pointId: east.startId }, end: { x: 0, y: 40000 }, thicknessMm: 240, heightMm: 3000 }));
    const doc = log.document;
    const inside = (v: Viewport, px: Px): boolean =>
      px.x >= 2 && px.y >= 2 && px.x < v.widthPx - 2 && px.y < v.heightPx - 2;
    const roundPx = (px: Px): Px => ({ x: Math.round(px.x), y: Math.round(px.y) });
    const probeAt = (v: Viewport) =>
      dragProbe(doc, storeyId, buildDrawList(doc, storeyId, v, EMPTY_SELECTION), v);
    const wide = viewportOf(1000, 800, { pxPerMm: 0.01, center: vec(20000, 20000) });
    const narrow = viewportOf(1000, 800, { pxPerMm: 0.1, center: vec(0, 0) });
    // 素材自证 ①：宽的那一份给得出靶子，三发像素（含锚点）全在画布内 ⇒ 这套夹具是"可探针"的
    const pWide = probeAt(wide);
    expect(pWide).not.toBeNull();
    expect(inside(wide, pWide!.fromPx) && inside(wide, pWide!.toPx) && inside(wide, pWide!.anchorPx)).toBe(true);
    // 素材自证 ②：换到窄的那一份，**同一把把手的按下点仍然在画布内**，跑出去的只有锚点
    const h = dragHandlesOf(doc, storeyId, sel(pWide!.wallId), narrow).find((x) => x.end === pWide!.end)!;
    expect(inside(narrow, roundPx(h.atPx))).toBe(true);
    expect(inside(narrow, roundPx(h.anchorPx))).toBe(false);
    // 于是窄的那一份里 null 只可能来自锚点这一道筛 —— 它现在不 null，交出的正是那发出界的靶子
    const pNarrow = probeAt(narrow);
    expect(pNarrow === null || inside(narrow, pNarrow.anchorPx), `锚点出界的靶子被交了出去：${JSON.stringify(pNarrow?.anchorPx)}`).toBe(true);
  });
});

describe('回读用的投影与配色', () => {
  it('pointSnapshot 的键集合恰是本层墙端点的去重集（多一个少一个都红）', () => {
    const snap = pointSnapshot(house.doc, house.lowerStoreyId);
    const lower = house.doc.byKind('wall').filter((w) => w.storeyId === house.lowerStoreyId);
    const upper = house.doc.byKind('wall').filter((w) => w.storeyId === house.upperStoreyId);
    const lowerIds = new Set(lower.flatMap((w) => [w.startId, w.endId]));
    expect(lowerIds.size).toBeGreaterThan(0); // 空样本会让下面全部断言变成恒真
    // 键集合**就是**本层全部墙端点：混进别层的点、或漏掉共享点（去重后少一枚）都红
    expect(Object.keys(snap).sort()).toEqual([...lowerIds].sort());
    for (const id of lowerIds) {
      const point = requirePoint(house.doc, id, '端点');
      expect(snap[id]).toEqual({ x: point.x, y: point.y });
      expect(Number.isInteger(snap[id]!.x) && Number.isInteger(snap[id]!.y)).toBe(true);
    }
    for (const w of upper) {
      // 同一件事的第二证法：别层的两枚端点都不该在表里
      expect(snap[w.startId]).toBeUndefined();
      expect(snap[w.endId]).toBeUndefined();
    }
  });

  it('四种颜色两两之间最大通道差 > 2×PIXEL_CHANNEL_TOL ⇒ 像素计数不会串道', () => {
    const rgb = (hex: string): [number, number, number] => [
      Number.parseInt(hex.slice(1, 3), 16),
      Number.parseInt(hex.slice(3, 5), 16),
      Number.parseInt(hex.slice(5, 7), 16),
    ];
    const spread = (a: string, b: string): number => {
      const ca = rgb(a);
      const cb = rgb(b);
      return Math.max(...ca.map((c, k) => Math.abs(c - cb[k]!)));
    };
    // 每一侧的认色窗口宽 2×TOL（±TOL），两窗口不重叠 ⇔ 最大通道差 > 2×TOL。
    // 分开写而不是套循环：红了直接知道是哪一对颜色串道，不必再反推 i/j。
    // T6 加第四色（吸附标记）：判据一字不改，只是每对都多一列要过同一把尺。
    const min = PIXEL_CHANNEL_TOL * 2;
    expect(spread(SELECTED, HANDLE_COLOR)).toBeGreaterThan(min);
    expect(spread(SELECTED, PREVIEW_COLOR)).toBeGreaterThan(min);
    expect(spread(SELECTED, SNAP_COLOR)).toBeGreaterThan(min);
    expect(spread(HANDLE_COLOR, PREVIEW_COLOR)).toBeGreaterThan(min);
    expect(spread(HANDLE_COLOR, SNAP_COLOR)).toBeGreaterThan(min);
    expect(spread(PREVIEW_COLOR, SNAP_COLOR)).toBeGreaterThan(min);
  });
});
