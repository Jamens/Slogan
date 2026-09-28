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
  EMPTY_SELECTION,
  fitStorey,
  HANDLE_COLOR,
  HANDLE_RADIUS_PX,
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
  viewportOf,
  type DragHandle,
  type Selection,
} from '@dajia/scene-2d';

const house = demoHouse();
const view = fitStorey(house.doc, house.lowerStoreyId, 1200, 900, 60);
const ops = buildDrawList(house.doc, house.lowerStoreyId, view, EMPTY_SELECTION);

const sel = (...ids: string[]): Selection => ({ ids: new Set(ids) });

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
    // (4000, 1200)：southEast 变 4326、southWest 变 4000、stem 变 1800，三面都远大于各自墙厚
    expect(legalDrop(house.doc, junction.id, 'start', { x: corner.x, y: corner.y + 1200 })).toBe(true);
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
    // 探针报的毫米必须是**它那对像素的不动点**（`moveTargetOf(view, toPx) === targetMm`）。
    // 上面那句 `legalDrop` 判的就是这一对毫米，所以三句话连起来才成立：
    // 探针说合法 → renderer 松手算出同一对毫米 → 命令必然成功 → `--edit-shot` 才许拿"逐字相等"当判据。
    expect(moveTargetOf(view, p.toPx)).toEqual(p.targetMm);
    // 三枚像素必须全是整数：`sendInputEvent` 只收整数 DIP，主进程一发 `Math.round` 就把落点
    // 挪到另一对毫米上（fitStorey 的 0.13 px/mm 下差 1~4mm），上面那句"不动点"立刻变成随机红。
    // 摘掉 `snapPx` 这里必须红 —— 这条断言是 `--edit-shot` 第 0 步与第 3 步的地基。
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

  it('三种颜色两两之间最大通道差 > 2×PIXEL_CHANNEL_TOL ⇒ 像素计数不会串道', () => {
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
    // 三对分开写而不是套循环：红了直接知道是哪一对颜色串道，不必再反推 i/j。
    const min = PIXEL_CHANNEL_TOL * 2;
    expect(spread(SELECTED, HANDLE_COLOR)).toBeGreaterThan(min);
    expect(spread(SELECTED, PREVIEW_COLOR)).toBeGreaterThan(min);
    expect(spread(HANDLE_COLOR, PREVIEW_COLOR)).toBeGreaterThan(min);
  });
});
