/**
 * 计划 2 的验收属性测试。三件事：
 * 1. 闭式解预言 —— 按侧比对每个墙端的斜切量（关键判断 1，Task 4 那个 bug 的唯一随机探测器）；
 * 2. 随机操作序列下，接头分类 / 生成器边界 / 洞口分段互补 / 轮廓接缝 / 非法写 no-op / 夹取 /
 *    索引三方一致 / 撤销重放 每步逐一成立；
 * 3. 非法写按"抛在 build 还是抛在构造期"分两组定向钉（关键判断 4）。
 *
 * 本文件不 import `geom/axis` 与 `geom/joint` 的任何导出，连 dot/cross/perp 都另写一份：
 * 预言一旦与实现共享约定，就不再是第二份证据。轮廓面积同理不 import `polygonArea`，
 * 原因写在 Step 3 开头的 import 规矩里。
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  Document,
  SpatialIndex,
  TransactionLog,
  deriveJoints,
  deriveStoreyGeometry,
  deriveWallQuads,
  openingCreate,
  openingDelete,
  openingMove,
  openingSpans,
  storeyCreate,
  uuidv7,
  wallCreate,
  wallDelete,
  wallMoveEndpoint,
  wallSetThickness,
  type Aabb,
  type Command,
  type IndexEntry,
  type PointRef,
  type WallEntity,
  type WallPiece,
  type WallQuad,
} from '@dajia/core';
import { arbChainOps, arbChainShape, type ChainOp, type ChainShape } from './arbitraries';

const projectId = uuidv7();

/** 整条链 + 每步六个检查器（外加夹取记账）的成本不低：操作序列 80 次，只画链的轻档 200 次。 */
const NUM_RUNS_OPS = 80;
const NUM_RUNS_LIGHT = 200;
/** 测试 10 每一步都多建一次全量索引，所以它自己降档：40 × 12 步已经把五种计数灌满了。 */
const NUM_RUNS_INDEX = 40;

/** 生成器的界。名义界是轴长 4000 / sinθ ≥ 0.5（关键判断 2），这里留取整余量。 */
const MIN_AXIS_MM = 3900;
const MIN_SIN = 0.49;
const MIN_THICKNESS_MM = 100;
const MAX_THICKNESS_MM = 400;
const WALL_HEIGHT_MM = 3000;
const WINDOW_SILL_MM = 900;
/** 预言自检的地板：低于它闭式解数值发散，宁可抛，不要比一个不准的数。 */
const ORACLE_MIN_SIN = 0.4;
/** 实现走两直线求交，预言走闭式解：两条算式必须在 1e-6 mm 内一致。 */
const TRIM_DIGITS = 6;

// ---------- ① 预言：只读真源字段，不碰任何几何实现 ----------

interface Vec {
  readonly x: number;
  readonly y: number;
}

const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const scale = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
const perp = (a: Vec): Vec => ({ x: -a.y, y: a.x });
const flip = (a: Vec): Vec => ({ x: -a.x, y: -a.y });

/** 真源里的一个墙端。inward = awayDir（'start' 端是 dir，'end' 端是 −dir）；normal 恒取 perp(dir)。 */
interface EndVec {
  readonly wallId: string;
  readonly end: 'start' | 'end';
  readonly p: Vec;
  readonly inward: Vec;
  readonly normal: Vec;
  readonly half: number;
  readonly thicknessMm: number;
  readonly axisLengthMm: number;
}

function pointAt(doc: Document, id: string): Vec {
  const entity = doc.get(id);
  if (entity?.kind !== 'point') throw new TypeError(`真源里没有点 ${id}`);
  return { x: entity.x, y: entity.y };
}

/** 轴长。本文件唯一的算法：Math.hypot，与 geom/vec 的 length 同式，所以逐位相同（Step 3 的 toBe 靠它）。 */
function axisLengthOf(doc: Document, wall: WallEntity): number {
  const a = pointAt(doc, wall.startId);
  const b = pointAt(doc, wall.endId);
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function coordsOf(doc: Document): Map<string, Vec> {
  const out = new Map<string, Vec>();
  for (const entity of doc.entities.values()) {
    if (entity.kind === 'point') out.set(entity.id, { x: entity.x, y: entity.y });
  }
  return out;
}

function endVecFrom(coords: Map<string, Vec>, wall: WallEntity, end: 'start' | 'end'): EndVec {
  const at = (id: string): Vec => {
    const hit = coords.get(id);
    if (!hit) throw new TypeError(`预言：真源里没有点 ${id}`);
    return hit;
  };
  const start = at(wall.startId);
  const finish = at(wall.endId);
  const delta = sub(finish, start);
  const axisLengthMm = Math.hypot(delta.x, delta.y);
  if (axisLengthMm === 0) throw new RangeError(`预言：墙 ${wall.id} 两端重合，轴线无方向`);
  const dir = { x: delta.x / axisLengthMm, y: delta.y / axisLengthMm };
  return {
    wallId: wall.id,
    end,
    p: end === 'start' ? start : finish,
    inward: end === 'start' ? dir : flip(dir),
    // 法向永远从 start→end 取：JointMember 的 left/right 认的是它，不是 inward 的 perp。
    // 写成 perp(inward) 会让 'end' 端的左右整体反号 —— 而那正是配对 bug 的对称面。
    normal: perp(dir),
    half: wall.thicknessMm / 2,
    thicknessMm: wall.thicknessMm,
    axisLengthMm,
  };
}

/** 按共享 pointId 给本层所有墙端分组。接头从真源来，不从 deriveJoints 来。 */
function endsByPoint(
  coords: Map<string, Vec>,
  doc: Document,
  storeyId: string,
): Map<string, EndVec[]> {
  const groups = new Map<string, EndVec[]>();
  for (const wall of doc.byKind('wall')) {
    if (wall.storeyId !== storeyId) continue;
    for (const end of ['start', 'end'] as const) {
      const pointId = end === 'start' ? wall.startId : wall.endId;
      const member = endVecFrom(coords, wall, end);
      const bucket = groups.get(pointId);
      if (bucket) bucket.push(member);
      else groups.set(pointId, [member]);
    }
  }
  return groups;
}

/** 该端某一侧的轮廓角点：与 cornerPoint 同一构造，但斜切量来自预言。 */
const vertexOf = (e: EndVec, side: 1 | -1, trim: number): Vec =>
  add(add(e.p, scale(e.inward, trim)), scale(e.normal, side * e.half));

/** 一套"前提"：哪些界属于被测前提，哪些只是随机生成器的自留地。 */
interface Premises {
  /** 轴长下界 + 墙厚区间。生成器的事：手算夹具是几百毫米的小样，不该被它挡在门外。 */
  readonly generatorBounds: boolean;
  /** 低于此值闭式解发散：生成器用 0.49（名义 30°/150° 的余量），预言自检用 0.4。 */
  readonly minSin: number;
}

/**
 * 接头的可用前提：一个点最多挂两个墙端，且二成员接头的 sinθ 过线。
 * 越界即抛，消息带实测数字。
 * 为什么抛而不是返 false：这条判据在属性体里跑，抛了就是"前提破了"，fast-check 会带着
 * 收缩后的 Counterexample 红给用户看；返 false 会让人以为被测代码错了。
 * 唯一"要返 false"的调用方是 withinChainBounds（试法），它把这同一个判据包起来用。
 */
function assertPremises(groups: Iterable<EndVec[]>, premises: Premises): number {
  let cornerCount = 0;
  for (const bucket of groups) {
    if (premises.generatorBounds) {
      for (const e of bucket) {
        if (e.axisLengthMm < MIN_AXIS_MM) {
          throw new RangeError(
            `墙 ${e.wallId} 轴长 ${e.axisLengthMm.toFixed(1)} 掉到下界 ${MIN_AXIS_MM} 以下`,
          );
        }
        if (e.thicknessMm < MIN_THICKNESS_MM || e.thicknessMm > MAX_THICKNESS_MM) {
          throw new RangeError(
            `墙 ${e.wallId} 墙厚 ${e.thicknessMm} 出了 [${MIN_THICKNESS_MM}, ${MAX_THICKNESS_MM}]`,
          );
        }
      }
    }
    if (bucket.length > 2) {
      throw new RangeError(
        `墙端 ${bucket[0]!.wallId} 所在的点挂了 ${bucket.length} 个墙端：` +
          `随机链只该有自由端与角，tee/cross/star 是 Step 5 的定值活（非目标 1）`,
      );
    }
    if (bucket.length === 2) {
      const [a, b] = [bucket[0]!, bucket[1]!];
      const sin = Math.abs(cross(a.inward, b.inward));
      if (sin < premises.minSin) {
        throw new RangeError(
          `墙 ${a.wallId} 与墙 ${b.wallId} 的接头 sinθ=${sin.toFixed(4)} 低于 ${premises.minSin}`,
        );
      }
      cornerCount++;
    }
  }
  return cornerCount;
}

/** 生成器边界的看门狗（关键判断 2 + 3）：轴长/墙厚 + 接头前提，全开。 */
const assertChainBounds = (groups: Iterable<EndVec[]>): number =>
  assertPremises(groups, { generatorBounds: true, minSin: MIN_SIN });

/** 试法用的非抛版本（关键判断 3）。try 里只有本文件自己的界判据，没有任何 src 调用被吞。 */
function withinChainBounds(groups: Iterable<EndVec[]>): boolean {
  try {
    assertChainBounds(groups);
    return true;
  } catch {
    return false;
  }
}

interface ExpectedTrim {
  readonly left: number;
  readonly right: number;
  /** +1 = 内侧在 +normal 侧。由对面墙的内向量在本墙法向上的符号决定，不看成员顺序。 */
  readonly innerSide: 1 | -1;
}

/**
 * 闭式解（关键判断 1 那个框）：
 *   trim_内侧 = (h_other + h_self·cosθ) / sinθ，trim_外侧 = −trim_内侧
 * 没有任何一处依赖"第几条边线"或成员先后：配对错了在这里必然算出另一个数。
 */
function expectedTrims(self: EndVec, other: EndVec): ExpectedTrim {
  const cos = dot(self.inward, other.inward);
  const sin = Math.abs(cross(self.inward, other.inward));
  if (sin < ORACLE_MIN_SIN) {
    throw new RangeError(`预言自检：sinθ=${sin.toFixed(4)} 低于 ${ORACLE_MIN_SIN}，闭式解在此发散`);
  }
  const inner = (other.half + self.half * cos) / sin;
  const facing = dot(other.inward, self.normal);
  if (facing === 0) throw new RangeError('预言自检：对面墙与本墙共线，内侧面无定义');
  const innerSide: 1 | -1 = facing > 0 ? 1 : -1;
  const left = innerSide === 1 ? inner : -inner;
  return { left, right: -left, innerSide };
}

/** 一个接头的凹角点与凸角点：凹 = P + trim_内侧·i + s·h·n，凸 = 2P − 凹。 */
function oracleCornerPoints(self: EndVec, other: EndVec): { inner: Vec; outer: Vec } {
  const t = expectedTrims(self, other);
  const inner = vertexOf(self, t.innerSide, t.innerSide === 1 ? t.left : t.right);
  return { inner, outer: { x: 2 * self.p.x - inner.x, y: 2 * self.p.y - inner.y } };
}

/**
 * 整张图的期望斜切表，key = `${wallId}:${end}`。
 * 前提检查走 `{ generatorBounds: false, minSin: ORACLE_MIN_SIN }`（不带轴长/墙厚那两档）：
 * 本函数的消费者既有 4000mm 的随机链，也有 1000mm 的手算夹具 —— 生成器的自留地管不到它们。
 */
function oracleTrims(doc: Document, storeyId: string): Map<string, ExpectedTrim> {
  const groups = endsByPoint(coordsOf(doc), doc, storeyId);
  assertPremises(groups.values(), { generatorBounds: false, minSin: ORACLE_MIN_SIN });
  const out = new Map<string, ExpectedTrim>();
  for (const bucket of groups.values()) {
    if (bucket.length !== 2) continue;
    const [a, b] = [bucket[0]!, bucket[1]!];
    out.set(`${a.wallId}:${a.end}`, expectedTrims(a, b));
    out.set(`${b.wallId}:${b.end}`, expectedTrims(b, a));
  }
  return out;
}

/** 实现给的斜切表，同一套 key。 */
function implementationTrims(doc: Document): Map<string, { left: number; right: number }> {
  const out = new Map<string, { left: number; right: number }>();
  for (const joint of deriveJoints(doc)) {
    for (const m of joint.members) {
      out.set(`${m.wallId}:${m.end}`, { left: m.trimLeftMm, right: m.trimRightMm });
    }
  }
  return out;
}

/**
 * 逐侧比对，left 对 left、right 对 right。
 * 顺带把实现自己的 `trimRight = −trimLeft` 也钉上（那条不区分配对对错，但它是 Task 5
 * "面积 = 轴长 × 墙厚"的前提，值得在随机样本里每步重验）。
 * 返回比对条数，调用方拿它做防空跑的下界。
 */
function expectTrimsMatchOracle(doc: Document, storeyId: string): number {
  const oracle = oracleTrims(doc, storeyId);
  const impl = implementationTrims(doc);
  for (const [key, want] of oracle) {
    const got = impl.get(key);
    if (!got) throw new TypeError(`实现没给 ${key} 的斜切量`);
    expect(got.left).toBeCloseTo(want.left, TRIM_DIGITS);
    expect(got.right).toBeCloseTo(want.right, TRIM_DIGITS);
    expect(got.right).toBeCloseTo(-got.left, TRIM_DIGITS);
  }
  return oracle.size;
}

const fmt = (p: Vec): string => `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
const sortPts = (pts: readonly Vec[]): Vec[] =>
  [...pts].sort((p, q) => p.x - q.x || p.y - q.y);

/**
 * 两点集合的容差匹配：每个 got 点认领一枚距离 ≤ 1e-6 mm 的 want 点，认领不到就抛。
 *
 * 为什么不用"排序后逐位比"（第一版是这么写的，它是个坑）：接头处 A 墙与 B 墙各自算出的
 * 同名角点只在 1e-13 量级上一致，而**轴线水平的那面墙，该端两枚角点的 x 逐位相同**
 * （dir = (±1,0)、normal = (0,±1)，法向那一项的 x 分量精确为 0），于是排序第二键 y 生效；
 * 斜着的那面墙两枚角点 x 相差 1e-13，谁前谁后纯看浮点噪声。两串的键不一样，
 * 逐位比对就会拿左下角去比右上角 —— 红在一个完全合法的状态上。
 *
 * 贪心即最优的前提在这里成立：同端两角相距一个墙厚（≥ 100mm），比 1e-6 的容差大八个数量级，
 * 不存在"两枚都想认领同一枚"的歧义。随机链允许自交，但两座独立接头恰好重合到 1e-6
 * 以内的概率是 0（顶点是整数，交角是无理数倍）。
 */
function expectSamePointSet(got: readonly Vec[], want: readonly Vec[]): void {
  expect(got.length).toBe(want.length);
  const taken = want.map(() => false);
  for (const p of got) {
    const hit = taken.findIndex(
      (used, i) => !used && Math.abs(want[i]!.x - p.x) <= 1e-6 && Math.abs(want[i]!.y - p.y) <= 1e-6,
    );
    if (hit < 0) throw new Error(`点集里没有 ${fmt(p)} 的容身之处：${want.map(fmt).join(' | ')}`);
    taken[hit] = true;
  }
}

// ---------- ② Harness：一切从真源现读 ----------

/**
 * 为什么不维护"折线镜像"：wallDelete 会连带删掉不再被引用的点，undo 又把实体按原 id 放回来。
 * 测试侧的镜像在这两处必然与真源走偏，而走偏的镜像比没有镜像更坏 —— 断言会去比镜像。
 * 所以墙、洞口、坐标一律从 doc 现读；只有 drawChain 在画的那一小段里需要知道
 * "第 i 个顶点是哪个 pointId"（决定写 {pointId} 还是字面量），那是本地临时变量。
 */
interface Harness {
  readonly log: TransactionLog;
  readonly storeyId: string;
  /** 画完链、动手之前的栈深：快照 0 之下那些笔是准备动作，不参与逐张比对 */
  readonly baseDepth: number;
  readonly snapshots: string[];
  readonly stats: OpStats;
}

interface ClampRecord {
  readonly openingId: string;
  readonly beforeMm: number;
  readonly afterMm: number;
  readonly axisLengthMm: number;
  readonly widthMm: number;
}

interface OpStats {
  applied: number;
  skipped: number;
  /** 真正发生过夹取的次数（不是"检查过夹取"的次数）：测试 9 的防空跑下界 */
  clamps: number;
  /** 每种操作各成功派发过多少次：测试 5/7 靠它证明"分类检查真的见过删墙与改厚" */
  byKind: Record<ChainOp['kind'], number>;
  probes: {
    zeroLength: number;
    outOfHost: number;
    thickness: number;
    doorSill: number;
  };
  index: { compared: number; hits: number; empty: number; partial: number; pruned: number };
  corners: { same: number; mixed: number };
  oracleEntries: number;
}

const newStats = (): OpStats => ({
  applied: 0,
  skipped: 0,
  clamps: 0,
  byKind: { opening: 0, moveOpening: 0, deleteOpening: 0, movePoint: 0, thickness: 0, deleteWall: 0 },
  probes: { zeroLength: 0, outOfHost: 0, thickness: 0, doorSill: 0 },
  index: { compared: 0, hits: 0, empty: 0, partial: 0, pruned: 0 },
  corners: { same: 0, mixed: 0 },
  oracleEntries: 0,
});

/** 把一次运行的计数并进总账：跨 Counterexample 累计，末尾钉下界（关键判断 3 的"两边都数"）。 */
function absorbStats(into: OpStats, from: OpStats): void {
  into.applied += from.applied;
  into.skipped += from.skipped;
  into.clamps += from.clamps;
  for (const key of ['opening', 'moveOpening', 'deleteOpening', 'movePoint', 'thickness', 'deleteWall'] as const) {
    into.byKind[key] += from.byKind[key];
  }
  for (const key of ['zeroLength', 'outOfHost', 'thickness', 'doorSill'] as const) {
    into.probes[key] += from.probes[key];
  }
  for (const key of ['compared', 'hits', 'empty', 'partial', 'pruned'] as const) {
    into.index[key] += from.index[key];
  }
  into.corners.same += from.corners.same;
  into.corners.mixed += from.corners.mixed;
  into.oracleEntries += from.oracleEntries;
}

function wallJustCreated(log: TransactionLog): WallEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new TypeError('最近一次 dispatch 没有新建墙');
}

const liveWalls = (h: Harness): WallEntity[] =>
  h.log.document.byKind('wall').filter((w) => w.storeyId === h.storeyId);

const liveOpenings = (h: Harness) =>
  h.log.document.byKind('opening').filter((o) => o.storeyId === h.storeyId);

/**
 * 折线 → 真源。顶点 i 的点实体在画第 i 段时已经存在（除 i = 0），所以第 i 段
 * 有一端写 {pointId}、另一端写字面量 —— 共享端点就是这么进真源的（Task 3）。
 * `forward` 决定共享点落在 start 还是 end：相邻两段 forward 相同 ⇒ 混合角 (end,start)，
 * 不同 ⇒ 同向角 (start,start) / (end,end)。同向角才是 Task 4 那个 bug 的现场。
 */
function drawChain(
  shape: ChainShape,
  stats: OpStats = newStats(),
  onStep?: (log: TransactionLog, storeyId: string) => void,
): Harness {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: WALL_HEIGHT_MM }));
  const storeyId = log.document.byKind('storey')[0]!.id;
  // 测试 14 要的是"索引从一张空层开始长大"，所以回调在**一段墙都还没有**时先叫一次。
  // 其余 13 条都不传 onStep：可选参数保证它们的执行序列逐字不变。
  if (onStep) onStep(log, storeyId);
  const vertexIds: Array<string | undefined> = [];
  shape.walls.forEach((segment, i) => {
    const near = shape.points[i]!;
    const far = shape.points[i + 1]!;
    const shared = vertexIds[i];
    const sharedRef: PointRef = shared ? { pointId: shared } : near;
    const startRef: PointRef = segment.forward ? sharedRef : far;
    const endRef: PointRef = segment.forward ? far : sharedRef;
    log.dispatch(
      wallCreate({
        storeyId,
        start: startRef,
        end: endRef,
        thicknessMm: segment.thicknessMm,
        heightMm: WALL_HEIGHT_MM,
      }),
    );
    const wall = wallJustCreated(log);
    vertexIds[i] = segment.forward ? wall.startId : wall.endId;
    vertexIds[i + 1] = segment.forward ? wall.endId : wall.startId;
    if (onStep) onStep(log, storeyId);
  });
  return {
    log,
    storeyId,
    baseDepth: log.depth,
    snapshots: [log.document.canonical()],
    stats,
  };
}

/**
 * 洞口沿轴位置。写成"轴长减宽"的百分比而不是轴长的百分比，是为了让 `pct` 的上界与
 * 轴的长短无关：`to = d + w ≤ pct% × (L − w) + w < L` 对任意 `L > w` 恒成立，
 * 于是一句代数就挡住了 `openingCreate` 的"超出宿主墙"，生成器不需要 filter（关键判断 2）。
 * 传进来的 `percent` 最大 95，`w` 最大 1200，`L` 最小 3900 ⇒ `to ≤ 0.95L + 60 < L`。
 */
function legalDistanceMm(axisLengthMm: number, widthMm: number, percent: number): number {
  return Math.floor(((axisLengthMm - widthMm) * percent) / 100);
}

/**
 * 一步随机操作 → 命令，或 null（跳过并计数，关键判断 3）。
 * 这里不加 try/catch：planOp 里算过的界保证命令建得出补丁，真抛了就是缺陷，该红。
 * 三种"跳过"各有各的理由，都体现在返回值上而不是吞掉：
 *   - 没有可操作的实体（活墙/活洞口为空，或删到只剩一面）：继续跑测不出东西；
 *   - 目标墙上已经有洞口：非目标 2 的"一墙至多一樘"；
 *   - movePoint 没过试法：见 planOp 的 movePoint 分支。
 */
function planOp(h: Harness, op: ChainOp): Command | null {
  const doc = h.log.document;
  const walls = liveWalls(h);
  if (walls.length === 0) return null;
  const target = walls[op.index % walls.length]!;
  switch (op.kind) {
    case 'opening': {
      if (openingSpans(doc, target).length > 0) return null;
      const sillMm = op.category === 'door' ? 0 : WINDOW_SILL_MM;
      const lengthMm = axisLengthOf(doc, target);
      const distanceMm = legalDistanceMm(lengthMm, op.widthMm, op.distancePercent);
      // 横向由 legalDistanceMm 兜住（to < 轴长）。竖向：窗 900 + 2100 = 3000 正好压顶
      // （assertFitsAfterInsert 用 > 号，合法），再高就被这个 min 夹回来 ——
      // 界写在这里而不是生成器里，因为它是墙高的函数。
      const heightMm = Math.min(op.heightMm, WALL_HEIGHT_MM - sillMm);
      return openingCreate({
        hostWallId: target.id,
        distanceMm,
        widthMm: op.widthMm,
        heightMm,
        sillMm,
        category: op.category,
      });
    }
    case 'moveOpening': {
      const openings = liveOpenings(h);
      if (openings.length === 0) return null;
      const opening = openings[op.index % openings.length]!;
      const host = doc.get(opening.hostWallId);
      if (host?.kind !== 'wall') return null;
      const lengthMm = axisLengthOf(doc, host);
      // 同样走 legalDistanceMm：pct 最大 95 时 to 仍严格小于新轴长，
      // 于是 moveOpening 自己从不越界 —— 越界只由"墙先变短"造成，那正是测试 9 要数的夹取。
      const distanceMm = legalDistanceMm(lengthMm, opening.widthMm, op.distancePercent);
      return openingMove({ openingId: opening.id, distanceMm });
    }
    case 'deleteOpening': {
      const openings = liveOpenings(h);
      if (openings.length === 0) return null;
      return openingDelete({ openingId: openings[op.index % openings.length]!.id });
    }
    case 'movePoint': {
      // 用 dx/dy 的符号决定拖哪一端：不加新槽位，也不引入"每步只能拖 start"的偏差
      const end: 'start' | 'end' = op.dy >= 0 ? 'start' : 'end';
      const pointId = end === 'start' ? target.startId : target.endId;
      const here = pointAt(doc, pointId);
      const coords = coordsOf(doc);
      coords.set(pointId, { x: here.x + op.dx, y: here.y + op.dy });
      if (!withinChainBounds(endsByPoint(coords, doc, h.storeyId).values())) return null;
      return wallMoveEndpoint({ wallId: target.id, end, x: here.x + op.dx, y: here.y + op.dy });
    }
    case 'thickness': {
      // 从已有的随机槽位派生 100..400 的整数百：不新增生成器字段，也不出关键判断 2 的界。
      // 异厚角是闭式解最吃紧的地方（h_self 与 h_other 不等，两条边的斜切量差很多）。
      const thicknessMm = 100 + ((op.index + Math.abs(op.dx)) % 4) * 100;
      if (thicknessMm === target.thicknessMm) return null;
      return wallSetThickness({ wallId: target.id, thicknessMm });
    }
    case 'deleteWall': {
      if (walls.length < 2) return null;
      return wallDelete({ wallId: target.id });
    }
  }
}

/** 派发前记下每个洞口的 distanceMm，派发后比对 —— 洞口实体一律现读，不留镜像。 */
function openingDistances(doc: Document): Map<string, number> {
  const out = new Map<string, number>();
  for (const opening of doc.byKind('opening')) out.set(opening.id, opening.distanceMm);
  return out;
}

/**
 * 夹取的判据不是"距离变了"，而是"距离变成了 floor(轴长 − 宽)"。
 * 后者是 clampOpeningsToWall 的算法本身，跑在它外面才算第二份证据；
 * 顺带钉"动过的必然曾经越界"（before + w > 新轴长）与"落地后仍在宿主墙里"。
 *
 * `causedByWallEdit` 是这条记录能成立的前提，不是修饰：`openingMove` 也会改 distanceMm，
 * 而它是合法位移。把两种改混成一谈，第一簇随机 moveOpening 就会撞上
 * `before + w > 轴长` 而红在无关的操作上 —— 只有 wallMoveEndpoint 会缩短轴长
 * （wallSetThickness 与 wallDelete 都不动别的墙的轴长，见 Task 3 的自厚守卫），
 * 所以只有它引发的位移才配叫夹取。
 */
function recordClamps(h: Harness, before: Map<string, number>, causedByWallEdit: boolean): void {
  const doc = h.log.document;
  for (const [id, distanceMm] of before) {
    const opening = doc.get(id);
    if (opening?.kind !== 'opening') continue;
    if (opening.distanceMm === distanceMm) continue;
    const host = doc.get(opening.hostWallId);
    if (host?.kind !== 'wall') continue;
    const axisLengthMm = axisLengthOf(doc, host);
    if (!causedByWallEdit) {
      // 洞口是自己被挪的：只钉"仍然整个待在宿主墙里"，不记进夹取账
      expect(opening.distanceMm + opening.widthMm).toBeLessThanOrEqual(axisLengthMm);
      continue;
    }
    const record: ClampRecord = {
      openingId: id,
      beforeMm: distanceMm,
      afterMm: opening.distanceMm,
      axisLengthMm,
      widthMm: opening.widthMm,
    };
    h.stats.clamps++;
    expect(record.beforeMm + record.widthMm).toBeGreaterThan(record.axisLengthMm);
    expect(record.afterMm).toBe(Math.floor(record.axisLengthMm - record.widthMm));
    expect(record.afterMm + record.widthMm).toBeLessThanOrEqual(record.axisLengthMm);
  }
}

function checkBounds(h: Harness): void {
  assertChainBounds(endsByPoint(coordsOf(h.log.document), h.log.document, h.storeyId).values());
}

/** 接头分类与真源端点计数一致；链上不该出现 tee/cross/star（非目标 1 的反面）。 */
function checkKinds(h: Harness): void {
  const doc = h.log.document;
  const groups = endsByPoint(coordsOf(doc), doc, h.storeyId);
  const joints = deriveJoints(doc);
  expect(joints.map((j) => j.pointId)).toEqual([...groups.keys()].sort());
  for (const joint of joints) {
    const bucket = groups.get(joint.pointId);
    if (!bucket) throw new TypeError(`接头 ${joint.pointId} 在真源里没被任何墙端引用`);
    expect(joint.members.length).toBe(bucket.length);
    expect(joint.kind).toBe(bucket.length === 1 ? 'free' : 'corner');
    expect(['tee', 'cross', 'star']).not.toContain(joint.kind);
    if (bucket.length === 2) {
      // 同向角 vs 混合角：Task 4 的配对 bug 只在同向角上露头，这里数着它（测试 13 吃这个数）
      if (bucket[0]!.end === bucket[1]!.end) h.stats.corners.same++;
      else h.stats.corners.mixed++;
    }
  }
  expect(implementationTrims(doc).size).toBe(2 * liveWalls(h).length);
}

/**
 * 接缝闭合：角上两墙在该端的两枚角点两两重合；自由端的两枚角点关于共享点对称。
 * 这条**抓不到**边线配对错（错配对也是同一个交点，两墙共用 —— 关键判断 1），
 * 它抓的是环序改动与"角点没按斜切量摆"。
 * 下标 [0,3] = start 侧、[1,2] = end 侧用的是 WallQuad 契约表里那条环序：
 * 那是接口约定，不是几何约定（Step 6 第 5 处变异专门冲它红）。
 */
function checkContours(h: Harness): void {
  const doc = h.log.document;
  const groups = endsByPoint(coordsOf(doc), doc, h.storeyId);
  const quads = new Map(deriveWallQuads(doc).map((q) => [q.wallId, q] as const));
  const atEnd = (e: EndVec): Vec[] => {
    const quad = quads.get(e.wallId);
    if (!quad) throw new TypeError(`墙 ${e.wallId} 没有轮廓`);
    return e.end === 'start' ? [quad.corners[0], quad.corners[3]] : [quad.corners[1], quad.corners[2]];
  };
  for (const bucket of groups.values()) {
    if (bucket.length === 1) {
      const [only] = bucket as [EndVec];
      const pts = atEnd(only);
      expectSamePointSet(
        pts,
        pts.map((p) => ({ x: 2 * only.p.x - p.x, y: 2 * only.p.y - p.y })),
      );
      continue;
    }
    const [a, b] = bucket as [EndVec, EndVec];
    expectSamePointSet(atEnd(a), atEnd(b));
  }
}

/**
 * 洞口分段与洞口区间严格互补 —— 结构比对，端点精确相等。
 * 为什么不用"Σ 段长 = 轴长 − Σ 洞宽"：浮点求和会把 ±1mm 的错位摊进余量。
 * 这里的内端点全是整数（distance/width 是整数毫米），只有最后一段的 toMm 是浮点轴长，
 * 而它与 axisLengthOf 同为 Math.hypot 的结果，逐位相同，所以 toEqual 敢用 === 比浮点。
 */
function checkSpans(h: Harness): void {
  const doc = h.log.document;
  const geometry = deriveStoreyGeometry(doc, h.storeyId);
  const piecesOf = new Map<string, WallPiece[]>();
  for (const piece of geometry.pieces) {
    const list = piecesOf.get(piece.wallId);
    if (list) list.push(piece);
    else piecesOf.set(piece.wallId, [piece]);
  }
  for (const wall of liveWalls(h)) {
    const lengthMm = axisLengthOf(doc, wall);
    const expected: WallPiece[] = [];
    let cursor = 0;
    for (const span of openingSpans(doc, wall)) {
      if (span.fromMm > cursor) expected.push({ wallId: wall.id, fromMm: cursor, toMm: span.fromMm });
      cursor = span.toMm;
    }
    if (cursor < lengthMm) expected.push({ wallId: wall.id, fromMm: cursor, toMm: lengthMm });
    expect(piecesOf.get(wall.id) ?? []).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  }
}

function checkOracle(h: Harness): void {
  h.stats.oracleEntries += expectTrimsMatchOracle(h.log.document, h.storeyId);
}

/**
 * 非法写：抛对中文错 + 文档/栈深/affected 三样都不动。
 * 深比对 canonical 而不是比对象身份：抛之前偷改一处，对象还是那个对象，身份比不出来。
 */
function expectRejected(h: Harness, make: () => Command, pattern: RegExp): void {
  const log = h.log;
  const before = log.document.canonical();
  const depth = log.depth;
  const affected = [...log.affected].sort();
  expect(() => log.dispatch(make())).toThrow(pattern);
  expect(log.document.canonical()).toBe(before);
  expect(log.depth).toBe(depth);
  expect([...log.affected].sort()).toEqual(affected);
}

/**
 * 四种探针按抛在哪一层分两组（关键判断 4）：前三条抛在 build，才真正考 dispatch 的时序；
 * 第四条抛在构造期，dispatch 根本没被调用，"文档没动"是白送的。
 * 正则全部抄自 Task 3 / Task 7 已写下的断言。
 */
function checkIllegalWrites(h: Harness): void {
  const doc = h.log.document;
  const walls = liveWalls(h);
  if (walls.length === 0) return;
  const host = walls[0]!;
  // 1（build）：两端复用同一个 pointId —— 只有解析引用之后才知道是同一个点
  expectRejected(
    h,
    () =>
      wallCreate({
        storeyId: h.storeyId,
        start: { pointId: host.startId },
        end: { pointId: host.startId },
        thicknessMm: 240,
        heightMm: WALL_HEIGHT_MM,
      }),
    /零长/,
  );
  h.stats.probes.zeroLength++;
  // 2（build）：把洞口挪出宿主墙末端。Math.round 不能省 —— 轴长是浮点，
  // 直接 +1000 会让 openingMove 在构造期就抛"整数毫米"，那就白测了 build 的时序。
  const opening = liveOpenings(h)[0];
  const openingHost = opening ? doc.get(opening.hostWallId) : undefined;
  if (opening && openingHost?.kind === 'wall') {
    const overshoot = Math.round(axisLengthOf(doc, openingHost)) + 1000;
    expectRejected(h, () => openingMove({ openingId: opening.id, distanceMm: overshoot }), /超出宿主墙/);
    h.stats.probes.outOfHost++;
  }
  // 3（build）：墙厚调到不小于轴长
  const tooThick = Math.round(axisLengthOf(doc, host)) + 10;
  expectRejected(h, () => wallSetThickness({ wallId: host.id, thicknessMm: tooThick }), /不小于墙长/);
  h.stats.probes.thickness++;
  // 4（构造期）：门洞带窗台。考不到 dispatch 时序，留着是让两组并排看得见差别。
  expectRejected(
    h,
    () =>
      openingCreate({
        hostWallId: host.id,
        distanceMm: 0,
        widthMm: 700,
        heightMm: 1000,
        sillMm: 300,
        category: 'door',
      }),
    /门洞窗台高必须为 0/,
  );
  h.stats.probes.doorSill++;
}

type Checker = (h: Harness) => void;

/**
 * 每步跑的检查。顺序有讲究：bounds 在最前 —— 它一破，后面的预言与轮廓比对都是在比
 * 一个前提已经不成立的状态，红出来会把人引去改实现。索引那条不进这个数组：
 * 它每步多建一次整层全量索引，只有测试 10 付这个钱。
 */
const CHECK_ALL: Checker[] = [
  checkBounds,
  checkKinds,
  checkContours,
  checkSpans,
  checkOracle,
  checkIllegalWrites,
];

function runOps(shape: ChainShape, ops: ChainOp[], checkers: Checker[], stats?: OpStats): Harness {
  const h = drawChain(shape, stats);
  for (const op of ops) {
    const cmd = planOp(h, op);
    if (!cmd) {
      h.stats.skipped++;
      continue;
    }
    const distances = openingDistances(h.log.document);
    h.log.dispatch(cmd);
    h.stats.applied++;
    h.stats.byKind[op.kind]++;
    // 紧跟 dispatch：before 只有在这一刻还在
    recordClamps(h, distances, op.kind === 'movePoint');
    h.snapshots.push(h.log.document.canonical());
    for (const check of checkers) check(h);
  }
  // 每步必须有交代：既不许偷偷 skip 掉一半，也不许有操作类型一次都没跑过就被"验证"了
  expect(h.stats.applied + h.stats.skipped).toBe(ops.length);
  return h;
}

// ---------- ③ 用例 ----------

/**
 * 严格凸：相邻三点的叉积同号且非零。本文件自己写一份，不从 outline.test.ts 借 ——
 * 借来的那份与借出方同源，就不再是第二份证据（Task 5 里同样是复制的）。
 * 判据用精确 0：随机链的 sinθ ≥ 0.49 由 checkBounds 先钉住，这里不会有擦边零。
 */
function strictlyConvex(pts: readonly Vec[]): boolean {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const c = pts[(i + 2) % pts.length]!;
    const turn = cross(sub(b, a), sub(c, b));
    if (turn === 0) return false;
    if (sign === 0) sign = Math.sign(turn);
    else if (Math.sign(turn) !== sign) return false;
  }
  return true;
}

/**
 * 反向画：顶点数组与段数组**一起**反序，`forward` 一律不动。
 * 两段都得反：反序后第 j 段落在原第 n−1−j 段的位置上，只反顶点数组会把墙厚配到别的段上
 * （异厚链于是变成另一栋房子，Σ 面积与角点集合当然不同 —— 实测反例 t=100/101）。
 * 两个数组一起反，每面墙仍落在自己那段轴线上，只是 start/end 对调 —— 这才是"同一条链反着画"。
 */
function reverseChain(shape: ChainShape): ChainShape {
  return { points: [...shape.points].reverse(), walls: [...shape.walls].reverse() };
}

// ---------- 三条跑序列的工具：放在两个 describe 之前，读的人不用往后翻 ----------

/**
 * 一轮"随机链 + 随机操作序列"。放在 module 级是因为测试 13 也要跑同样一轮：
 * 定义在 describe B 里面的话，describe C 只能把 runOps 再抄一遍。
 */
function runAll(
  assert: (shape: ChainShape, ops: ChainOp[], h: Harness) => void,
  total: OpStats,
  checkers: Checker[] = CHECK_ALL,
): void {
  fc.assert(
    fc.property(arbChainShape, arbChainOps, (shape, ops) => {
      const stats = newStats();
      const h = runOps(shape, ops, checkers, stats);
      assert(shape, ops, h);
      absorbStats(total, stats);
    }),
    { numRuns: NUM_RUNS_OPS },
  );
}

/**
 * 手写的闭区间相交判据 —— 故意不调 `aabbIntersects`。
 * Task 9 的变异 3 就是这件事的教材：它的 bruteForce 与 query 共用 aabbIntersects，
 * 把 `<=` 改成 `<` 两边一起错、比对照样绿，红的是另两条反证。
 * 这里另写一份，谁把闭区间改成开区间，这条立刻红。
 */
function overlaps(a: Aabb, b: Aabb): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

function bruteOverlaps(entries: readonly IndexEntry[], rect: Aabb): string[] {
  return entries
    .filter((entry) => overlaps(entry.aabb, rect))
    .map((entry) => entry.id)
    .sort();
}

interface ProbeRects {
  readonly tight: Aabb;
  readonly full: Aabb;
  readonly empty: Aabb;
  readonly point: Vec;
  readonly jointWalls: string[];
}

/**
 * 三个探针矩形各司其职，缺一个就有空跑的余地：
 * tight（贴着一个接头的小盒）证明能命中且不报全表，full（整层外框）证明不漏，
 * empty（外框平移一百万）证明能说"没有"。point 是拾取：P 是那枚共享端点，
 * 它必须落在**每一个成员墙**的盒子里 —— 这条不是白送的，界要算：
 * 沿轴方向，P 那一端的角点最多外伸 `trim ≤ (400 + 400) / 0.49 ≈ 1633mm`（闭式解里
 * `sinθ ≥ MIN_SIN`、半厚 ≤ 200），而远端的角点最少也在 `3900 − 1633 > 0` 处，
 * 所以墙盒在轴向上跨过 P；法向一侧两枚角点恒为 ±h，P 正落在中间。
 * 两个界都靠 `checkBounds` 先钉住轴长 ≥ 3900 与 sinθ ≥ 0.49，破了就是前提红而不是这里红。
 *
 * full 的 ±1 余量为什么够：索引里只有两类盒子 —— 墙盒就是它自己四枚角点的 AABB，
 * 洞口盒是宿主墙带内的一块（`openingAabb` 取 span 两端 ± 自身 half，横向往内收、
 * 竖向正好等于 half thickness）—— 两者都落在全体角点取极值再外扩 1mm 的框里。
 */
function probeRects(h: Harness, n: number): ProbeRects {
  const doc = h.log.document;
  const groups = [...endsByPoint(coordsOf(doc), doc, h.storeyId).values()];
  const bucket = groups[n % groups.length]!;
  const p = bucket[0]!.p;
  const corners = deriveWallQuads(doc).flatMap((q) => [...q.corners]);
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const full: Aabb = {
    minX: Math.min(...xs) - 1,
    minY: Math.min(...ys) - 1,
    maxX: Math.max(...xs) + 1,
    maxY: Math.max(...ys) + 1,
  };
  return {
    tight: { minX: p.x - 1, minY: p.y - 1, maxX: p.x + 1, maxY: p.y + 1 },
    full,
    empty: { minX: full.minX + 1_000_000, minY: full.minY, maxX: full.minX + 1_000_001, maxY: full.minY },
    point: p,
    jointWalls: bucket.map((e) => e.wallId),
  };
}

/**
 * 索引不进 `runOps`，而是把同一条序列**再跑一遍**、这一遍带着索引。
 * 为什么不塞进 runOps 的某个位置：`applyAffected` 要拿"这一笔的 `log.affected`"，
 * 而 `checkIllegalWrites` 自己 dispatch 过一次就把 affected 换掉了 —— 除非给 runOps
 * 钉一条"索引必须排在探针前面"的隐式顺序。隐式顺序迟早被下一次插入的检查打破，
 * 不如把这一遍自己写出来：它的成本只多付一次 dispatch 与一次全量重建，不多证任何东西，
 * 但也不需要跟别的检查抢时机。
 *
 * "同一条序列再跑一遍"而不是"把 Command 对象重放进新日志"，是因为后者根本走不通：
 * 新日志里的 pointId / wallId 全是新造的 uuid，老命令里的 `{ pointId }` 引用与 wallId
 * 全都指不到东西。而 planOp 只看几何与 `op.index % 存活数`，uuid 谁大都影响不到选谁，
 * 所以两轮的墙数、洞口数、每步走哪个分支逐笔相同 —— 这才是可重放的口径。
 */
function runOpsWithIndex(shape: ChainShape, ops: ChainOp[], stats: OpStats): void {
  const h = drawChain(shape, stats);
  const index = SpatialIndex.fromDoc(h.log.document, h.storeyId);
  let probeCount = 0;
  const probe = (): void => {
    const doc = h.log.document;
    const live = index.snapshot();
    expect(live).toEqual(SpatialIndex.fromDoc(doc, h.storeyId).snapshot());
    const rects = probeRects(h, probeCount++);
    for (const rect of [rects.tight, rects.full, rects.empty]) {
      expect(index.query(rect)).toEqual(bruteOverlaps(live, rect));
      stats.index.compared++;
    }
    expect(index.query(rects.full)).toEqual(live.map((e) => e.id));
    expect(index.query(rects.empty)).toEqual([]);
    const tight = index.query(rects.tight);
    if (tight.length > 0) stats.index.hits++;
    if (tight.length < live.length) stats.index.partial++;
    if (live.length > 0 && index.cellVisits(rects.tight) < index.cellVisits(rects.full)) {
      stats.index.pruned++;
    }
    if (index.query(rects.empty).length === 0) stats.index.empty++;
    const picked = index.queryPoint(rects.point.x, rects.point.y);
    for (const wallId of rects.jointWalls) expect(picked).toContain(wallId);
  };
  probe();
  for (const op of ops) {
    const cmd = planOp(h, op);
    if (!cmd) {
      stats.skipped++;
      continue;
    }
    const distances = openingDistances(h.log.document);
    h.log.dispatch(cmd);
    stats.applied++;
    stats.byKind[op.kind]++;
    recordClamps(h, distances, op.kind === 'movePoint');
    // 唯一的、真正的差别：affected 还热着
    index.applyAffected(h.log.document, h.log.affected);
    probe();
    checkBounds(h);
  }
  expect(stats.applied + stats.skipped).toBe(ops.length);
}

/**
 * 撤销到底再重做：每个中间态必须逐字节复现。
 * 从快照 0（画完链、动手之前）起算，栈深 == 快照数 − 1 先钉住，
 * 否则"少撤一笔"与"多撤一笔"都可能被后面的 canonical 比对放过。
 */
function expectReplay(h: Harness): void {
  const snaps = h.snapshots;
  expect(h.log.depth).toBe(h.baseDepth + snaps.length - 1);
  expect(snaps.length).toBe(h.stats.applied + 1);
  for (let i = snaps.length - 1; i >= 1; i--) {
    expect(h.log.undo()).toBe(true);
    // 撤掉第 i 笔之后回到第 i−1 张快照：撤一笔少一张，比对晚一个下标
    expect(h.log.document.canonical()).toBe(snaps[i - 1]);
  }
  expect(h.log.document.canonical()).toBe(snaps[0]);
  for (let i = 1; i < snaps.length; i++) {
    expect(h.log.redo()).toBe(true);
    expect(h.log.document.canonical()).toBe(snaps[i]);
  }
  expect(h.log.canRedo).toBe(false);
  // 重放完之后，几何还得是活的状态：撤销重做的不是字符串，是那张图。
  // 探针那条不在这里跑：它每回要 dispatch 四次注定失败的命令，跟"重放完图还活着"无关。
  for (const check of CHECK_ALL.filter((c) => c !== checkIllegalWrites)) check(h);
}

/**
 * 定向制造一次夹取。随机那条路径产不出来（实测 80 轮：movePoint 派发 143 次、洞口存在 106+ 次，
 * 两者同时成立的时机 37 对，其中宿主墙真被缩短的 7 对，最接近的一次 margin = −772mm，clamps = 0）——
 * 三条界互相咬死：legalDistanceMm 的上界 95% 恒留 5% 轴长（≥195mm）的余量，单次拖动位移上界 848mm，
 * 而试法又要求轴长 ≥ 3900。关键判断 4 对非法形状用的正是这个手法（自己定向造），夹取同理。
 * 手算：轴长 8000 的墙上开 1000 宽的门，distance = floor((8000−1000)×0.95) = 6650，远端 7650；
 * 把共享端点从 (8000,0) 拖到 (7000,500) ⇒ 新轴长 √(7000²+500²) ≈ 7017.83 < 7650
 * ⇒ 夹到 floor(7017.83 − 1000) = 6017。拖到带小数的那一端是故意的：整数轴长下 floor 与 round 同值，
 * Step 6 变异 7（clampOpeningsToWall 的 floor → round）就打不中，下面第三行断言把这件事钉在测试里。
 */
function clampDirected(): Harness {
  const h = drawChain({
    points: [
      { x: 0, y: 0 },
      { x: 8000, y: 0 },
      { x: 8000, y: 8000 },
    ],
    walls: [
      { thicknessMm: 200, forward: true },
      { thicknessMm: 200, forward: true },
    ],
  });
  const host = liveWalls(h).find((w) => {
    const a = pointAt(h.log.document, w.startId);
    const b = pointAt(h.log.document, w.endId);
    return a.y === b.y;
  });
  if (!host) throw new TypeError('定向夹具里没有水平墙');
  expect(axisLengthOf(h.log.document, host)).toBe(8000);
  h.log.dispatch(
    openingCreate({
      hostWallId: host.id,
      distanceMm: legalDistanceMm(8000, 1000, 95),
      widthMm: 1000,
      heightMm: 1000,
      sillMm: 0,
      category: 'door',
    }),
  );
  // before 必须在 dispatch 之前现读：`log.document` 是同一个活对象（transaction.ts 的 getter
  // 直接 return this.doc），提前存下引用等于在拖完之后读拖完之后的值 —— 夹取就看不见"变过"。
  const distances = openingDistances(h.log.document);
  // 端点共享：这一拖同时把邻墙带走，接头还在，只是变成斜的（sinθ = 0.980，过 0.49 的线）
  h.log.dispatch(wallMoveEndpoint({ wallId: host.id, end: 'end', x: 7000, y: 500 }));
  recordClamps(h, distances, true);
  const opening = liveOpenings(h)[0];
  if (!opening) throw new TypeError('定向夹具的洞口读不回来');
  const lengthMm = axisLengthOf(h.log.document, host);
  // 轴长与 src 的 wallAxis 同用 Math.hypot，所以这里敢用 === 比浮点（checkSpans 同一句理由）
  expect(lengthMm).toBe(Math.hypot(7000, 500));
  expect(opening.distanceMm).toBe(Math.floor(lengthMm - 1000));
  // 这一行不是装饰：它保证上面那条 floor 断言在 floor → round 的变异面前会红
  expect(Math.floor(lengthMm - 1000)).not.toBe(Math.round(lengthMm - 1000));
  checkBounds(h);
  checkSpans(h);
  return h;
}

describe('闭式解预言：按侧比对，不按多重集', () => {
  const drawn = (
    points: readonly [Vec, Vec, Vec],
    walls: readonly [
      { thicknessMm: number; forward: boolean },
      { thicknessMm: number; forward: boolean },
    ],
  ): Harness => drawChain({ points, walls });

  /** 混合角 (end, start)：A (0,0)→(1000,0)，B 从 (1000,0) 北上。 */
  const mixedCorner = (ta: number, tb: number) =>
    drawn([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 800 }], [
      { thicknessMm: ta, forward: true },
      { thicknessMm: tb, forward: true },
    ]);

  /**
   * 同向角 (start, start)：两面墙都从 (0,0) 起画。
   * 这是 Task 4 那个配对 bug 唯一露头的形状（两条墙都从共享点出发时，
   * 各自的 +normal 一内一外，"同侧配对"会取到外面那个交点）。
   */
  const startStartCorner = (ta: number, tb: number) =>
    drawn([{ x: 1000, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1000 }], [
      { thicknessMm: ta, forward: false },
      { thicknessMm: tb, forward: true },
    ]);

  /** 按几何认成员（水平轴的那面墙在前），不靠分组顺序 —— 预言与成员先后无关，测试也不该依赖它。 */
  function jointMembers(h: Harness): [EndVec, EndVec] {
    const doc = h.log.document;
    const buckets = [...endsByPoint(coordsOf(doc), doc, h.storeyId).values()];
    const joint = buckets.find((b) => b.length === 2);
    if (!joint) throw new TypeError('夹具里没有二成员接头');
    const [a, b] = [joint[0]!, joint[1]!];
    return a.inward.y === 0 ? [a, b] : [b, a];
  }

  it('手算三个接头：等厚直角、异厚直角、3-4-5 钝角；遇三成员必须抛', () => {
    // (a) 等厚直角。i_A = (−1,0)、i_B = (0,1) ⇒ cosθ = 0、sinθ = 1，两侧都恰为半厚 120。
    const h1 = mixedCorner(240, 240);
    const [a1, b1] = jointMembers(h1);
    const t1a = expectedTrims(a1, b1);
    const t1b = expectedTrims(b1, a1);
    expect([t1a.innerSide, t1b.innerSide]).toEqual([1, 1]);
    expect(t1a.left).toBeCloseTo(120, 9);
    expect(t1b.left).toBeCloseTo(120, 9);
    expect(expectTrimsMatchOracle(h1.log.document, h1.storeyId)).toBe(2);

    // (b) 异厚直角 200 / 370：薄墙切得比厚墙多（185 vs 100），凹角点在 (815, 100)。
    const h2 = mixedCorner(200, 370);
    const [a2, b2] = jointMembers(h2);
    const t2a = expectedTrims(a2, b2);
    const t2b = expectedTrims(b2, a2);
    expect(t2a.left).toBeCloseTo(185, 9);
    expect(t2b.left).toBeCloseTo(100, 9);
    expect(t2a.left).toBeGreaterThan(t2b.left);
    const p2 = oracleCornerPoints(a2, b2);
    expect(p2.inner.x).toBeCloseTo(815, 9);
    expect(p2.inner.y).toBeCloseTo(100, 9);
    expect(expectTrimsMatchOracle(h2.log.document, h2.storeyId)).toBe(2);

    // (c) 3-4-5 钝角（θ ≈ 126.87°，cosθ = −0.6、sinθ = 0.8），异厚 200 / 370。
    //     斜切量异号：B 的 trimLeft 是 −13.75 —— 负数意味着 B 的轮廓**越过**共享点往外伸，
    //     这是 JointMember 契约里"可正可负"那条唯一的定值凭据之一（另一条在 Task 4）。
    const h3 = drawn([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 4000, y: 4000 }], [
      { thicknessMm: 200, forward: true },
      { thicknessMm: 370, forward: true },
    ]);
    const [a3, b3] = jointMembers(h3);
    const t3a = expectedTrims(a3, b3);
    const t3b = expectedTrims(b3, a3);
    expect(t3a.left).toBeCloseTo(156.25, 9);
    expect(t3a.right).toBeCloseTo(-156.25, 9);
    expect(t3b.left).toBeCloseTo(-13.75, 9);
    expect(t3b.right).toBeCloseTo(13.75, 9);
    const p3 = oracleCornerPoints(a3, b3);
    expect(p3.inner.x).toBeCloseTo(843.75, 9);
    expect(p3.inner.y).toBeCloseTo(100, 9);
    expect(p3.outer.x).toBeCloseTo(1156.25, 9);
    expect(p3.outer.y).toBeCloseTo(-100, 9);
    expect(expectTrimsMatchOracle(h3.log.document, h3.storeyId)).toBe(2);

    // 预言只证过二成员：喂它一个 tee 必须抛，不许悄悄拿前两个成员算完给个绿。
    // 三面墙的轴长都取 4000 而不是 3000：assertChainBounds 的生成器档（轴长 ≥ MIN_AXIS_MM）
    // 跑在成员数判据之前，一根 3000 的支墙会先红在轴长那条消息上，/挂了 3 个墙端/ 就永远测不到。
    const tee = new TransactionLog(Document.create(projectId));
    tee.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: WALL_HEIGHT_MM }));
    const teeStorey = tee.document.byKind('storey')[0]!.id;
    tee.dispatch(
      wallCreate({
        storeyId: teeStorey,
        start: { x: 0, y: 0 },
        end: { x: 4000, y: 0 },
        thicknessMm: 240,
        heightMm: WALL_HEIGHT_MM,
      }),
    );
    const junction = wallJustCreated(tee).endId;
    for (const end of [{ x: 8000, y: 0 }, { x: 4000, y: 4000 }]) {
      tee.dispatch(
        wallCreate({
          storeyId: teeStorey,
          start: { pointId: junction },
          end,
          thicknessMm: 240,
          heightMm: WALL_HEIGHT_MM,
        }),
      );
    }
    const teeBuckets = [
      ...endsByPoint(coordsOf(tee.document), tee.document, teeStorey).values(),
    ];
    expect(teeBuckets.some((b) => b.length === 3)).toBe(true);
    expect(() => assertChainBounds(teeBuckets)).toThrow(/挂了 3 个墙端/);
    expect(() => oracleTrims(tee.document, teeStorey)).toThrow(/挂了 3 个墙端/);
  });

  it('按侧比对才有区分力：交换两侧后多重集不变、按侧全错', () => {
    const h = startStartCorner(240, 240);
    const [a, b] = jointMembers(h);
    const want = expectedTrims(a, b);
    const wantB = expectedTrims(b, a);
    const got = implementationTrims(h.log.document).get(`${a.wallId}:${a.end}`);
    if (!got) throw new TypeError('实现没给 A 的斜切量');
    // 两侧符号必须相反且非零，否则"交换"没有区分力，整条测试会白绿
    expect(want.left).not.toBe(want.right);
    expect(Math.abs(want.left)).toBeCloseTo(120, 9);
    expect(got).toEqual({ left: want.left, right: want.right });
    // 多重集口径放行配对 bug：交换后的两侧与原来同样"对"
    expect([want.left, want.right].sort()).toEqual([want.right, want.left].sort());
    expect(want.left).not.toBe(want.right);
    // 现场演示"接缝闭合为什么放行它"：等厚直角下，同侧配对等于把两墙的斜切量各自取反。
    // 那样 A 与 B 在该端的两枚角点**仍然是同样两个点**（下面第一行绿），
    // 但 A 的内侧角已经跨过共享点压到 B 的带里去了（下面两行：+normal 侧那枚角点，
    // 正确的是 x = +120 落在房屋内侧，错误的是 x = −120 跑到墙外）。
    // 只比 +normal 侧那一枚：另一枚（外侧角）本来就落在共享点之外（凸角必然外伸），
    // 拿 min(两枚) 去比 0 在正确的配对下也成立不了。
    const buggyA = [vertexOf(a, 1, -want.left), vertexOf(a, -1, -want.right)];
    const buggyB = [vertexOf(b, 1, -wantB.left), vertexOf(b, -1, -wantB.right)];
    expectSamePointSet(buggyA, buggyB);
    const good = [vertexOf(a, 1, want.left), vertexOf(a, -1, want.right)];
    expect(sortPts(good).map(fmt)).not.toEqual(sortPts(buggyA).map(fmt));
    expect(buggyA[0]!.x).toBeLessThan(0);
    expect(good[0]!.x).toBeGreaterThanOrEqual(0);
  });

  it('随机墙链：每个接头每一侧的斜切量都吻合闭式解', () => {
    let entries = 0;
    let runs = 0;
    fc.assert(
      fc.property(arbChainShape, (shape) => {
        runs++;
        const h = drawChain(shape);
        entries += expectTrimsMatchOracle(h.log.document, h.storeyId);
      }),
      { numRuns: NUM_RUNS_LIGHT },
    );
    expect(runs).toBe(NUM_RUNS_LIGHT);
    // 链至少 2 段 ⇒ 至少 1 个二成员接头 ⇒ 每次运行至少 2 条 keyed 比对。
    // 达不到这个量就是空跑：要么 key 拼错了，要么 oracleTrims 的分组没吃到角。
    expect(entries).toBeGreaterThanOrEqual(2 * NUM_RUNS_LIGHT);
  });

  it('随机墙链：接缝闭合、自由端对称、严格凸、面积 = 轴长 × 墙厚', () => {
    let quads = 0;
    fc.assert(
      fc.property(arbChainShape, (shape) => {
        const h = drawChain(shape);
        const doc = h.log.document;
        checkBounds(h);
        checkContours(h);
        const derived = deriveWallQuads(doc);
        expect(derived.length).toBe(liveWalls(h).length);
        for (const quad of derived) {
          expect(strictlyConvex(quad.corners)).toBe(true);
          const wall = doc.get(quad.wallId);
          if (wall?.kind !== 'wall') throw new TypeError(`轮廓 ${quad.wallId} 引用了不存在的墙`);
          // 这四条（闭合 / 对称 / 凸 / 面积）在错误配对下**全都照样成立** —— 测试 2 刚演过。
          // 它们是"轮廓有没有摆歪"的证据，不是"边线配对对不对"的证据，别拿它们代替测试 3。
          expect(quad.areaMm2).toBeCloseTo(axisLengthOf(doc, wall) * wall.thicknessMm, 6);
          quads++;
        }
      }),
      { numRuns: NUM_RUNS_LIGHT },
    );
    expect(quads).toBeGreaterThanOrEqual(2 * NUM_RUNS_LIGHT);
  });
});

describe('随机操作序列：每步之后逐条核对', () => {
  it('接头分类与真源端点计数一致，链上不出现 tee/cross/star', () => {
    const total = newStats();
    runAll(() => {}, total);
    // 分类检查真的见过"墙没了"与"墙变厚"：一次都没跑过的话，这一整轮只测了新建路径。
    // 概率：80 次 × 平均 12 步 = 960 步里一次都不落到某个 kind，约 (5/6)^960 ≈ 1e-78。
    expect(total.byKind.deleteWall).toBeGreaterThan(0);
    expect(total.byKind.thickness).toBeGreaterThan(0);
    expect(total.applied).toBeGreaterThan(0);
  });

  it('整条链始终守住关键判断 2 的三条界，且试法真的拦下过东西', () => {
    const total = newStats();
    runAll(() => {}, total, [checkBounds]);
    expect(total.applied).toBeGreaterThan(0);
    // 跳过量下界：拦不住任何东西的"试法"等于没写（关键判断 3 的最后一句）
    expect(total.skipped).toBeGreaterThan(0);
    expect(total.byKind.movePoint).toBeGreaterThan(0);
  });

  it('洞口分段与洞口区间严格互补，端点精确相等', () => {
    const total = newStats();
    runAll(() => {}, total, [checkBounds, checkSpans]);
    expect(total.byKind.opening).toBeGreaterThan(0);
    expect(total.byKind.moveOpening).toBeGreaterThan(0);
    expect(total.byKind.deleteOpening).toBeGreaterThan(0);
  });

  it('四种非法探针：抛对中文错，且文档 / 栈深 / affected 三样都不动', () => {
    const total = newStats();
    runAll(() => {}, total, [checkIllegalWrites]);
    // 四条各自下界：只钉"探针总数 > 0"的话，三条没跑过、一条跑了 99 次也是绿的
    expect(total.probes.zeroLength).toBeGreaterThan(0);
    expect(total.probes.thickness).toBeGreaterThan(0);
    expect(total.probes.doorSill).toBeGreaterThan(0);
    expect(total.probes.outOfHost).toBeGreaterThan(0);
  });

  it('缩墙夹取确实发生过，且每次夹到 floor(轴长 − 宽)', () => {
    const total = newStats();
    fc.assert(
      fc.property(arbChainShape, arbChainOps, (shape, ops) => {
        const stats = newStats();
        const h = drawChain(shape, stats);
        for (const op of ops) {
          const cmd = planOp(h, op);
          if (!cmd) {
            stats.skipped++;
            continue;
          }
          const distances = openingDistances(h.log.document);
          h.log.dispatch(cmd);
          stats.applied++;
          stats.byKind[op.kind]++;
          // 与 runOps 唯一的差别：recordClamps 必须紧跟 dispatch，晚一步 before 就没了。
          // 夹取公式在 recordClamps 里就地断言，这里只数"发生过没有"。
          recordClamps(h, distances, op.kind === 'movePoint');
          h.snapshots.push(h.log.document.canonical());
          checkBounds(h);
          checkSpans(h);
        }
        expect(stats.applied + stats.skipped).toBe(ops.length);
        absorbStats(total, stats);
      }),
      { numRuns: NUM_RUNS_OPS },
    );
    // 夹取的"发生过"这一票由上面那 80 轮与下面那一笔定向共同投：随机那一遍的计数
    // 不作下界（实测理由见 clampDirected 的注释块），承重的是定向那一笔 —— 它保证
    // Step 6 变异 7（clampOpeningsToWall 的 floor → round）必红，而不是"绿着骗人"。
    const directed = clampDirected();
    expect(directed.stats.clamps).toBe(1);
    expect(total.clamps + directed.stats.clamps).toBeGreaterThan(0);
    expect(total.byKind.movePoint).toBeGreaterThan(0);
  });

  it('索引：增量 == 全量 == 手算暴力扫，五类计数都非零', () => {
    const total = newStats();
    fc.assert(
      fc.property(arbChainShape, arbChainOps, (shape, ops) => {
        const stats = newStats();
        runOpsWithIndex(shape, ops, stats);
        absorbStats(total, stats);
      }),
      { numRuns: NUM_RUNS_INDEX },
    );
    expect(total.index.compared).toBeGreaterThan(0);
    expect(total.index.empty).toBeGreaterThan(0);
    expect(total.index.partial).toBeGreaterThan(0);
    expect(total.index.pruned).toBeGreaterThan(0);
    expect(total.index.hits).toBeGreaterThan(0);
  });

  it('撤销到底再重做，每个中间态逐字节复现', () => {
    let replays = 0;
    fc.assert(
      fc.property(arbChainShape, arbChainOps, (shape, ops) => {
        const h = runOps(shape, ops, []);
        expectReplay(h);
        replays += h.snapshots.length;
      }),
      { numRuns: NUM_RUNS_OPS },
    );
    // 比对的快照张数：每步一张，80 次运行至少 80 × (1 + 6) 张（序列最短 6 步）
    expect(replays).toBeGreaterThanOrEqual(NUM_RUNS_OPS * 7);
  });
});

// ---------- ③ 段（续）：生成器自觉 ----------

/** Σ 轮廓面积。反向画前后必须同一个数（逐墙恒等式求和，不是并集面积）。 */
const areaSum = (quads: readonly WallQuad[]): number =>
  quads.reduce((total, quad) => total + quad.areaMm2, 0);

/**
 * 相对容差比对。不用 toBeCloseTo(x, 6)：那要求绝对差 < 5e-7，而这里的数在 1e7 量级，
 * 双精度在这个量级的固有噪声本身就有 1e-9 级，求和顺序又跟着 uuid 排序变。
 * 1e-9 的相对容差 = 1e-2 mm² 的绝对容差：比噪声大七个数量级，比任何真实几何改动小三个数量级
 * （改动最小的形态是挪掉一个 100×100 的角 = 10000 mm²）。
 */
function expectNearRel(got: number, want: number, label: string): void {
  const tol = 1e-9 * Math.max(1, Math.abs(want));
  if (Math.abs(got - want) > tol) {
    throw new Error(`${label} 反向画前后不等：${got} vs ${want}（容差 ${tol}）`);
  }
}

describe('生成器自觉：这个随机空间真长出过我们要的东西吗', () => {
  it('反向画同一条链：接头规模、墙数、Σ 面积、全体角点集合四项不变', () => {
    let quads = 0;
    fc.assert(
      fc.property(arbChainShape, (shape) => {
        const a = drawChain(shape);
        const b = drawChain(reverseChain(shape));
        checkBounds(a);
        checkBounds(b);
        // 只比"每个接头挂几个墙端"的多重集：pointId 是 uuid，两份日志之间没法按 id 对上
        const sizes = (h: Harness): number[] =>
          deriveJoints(h.log.document)
            .map((j) => j.members.length)
            .sort();
        expect(sizes(a)).toEqual(sizes(b));
        const qa = deriveWallQuads(a.log.document);
        const qb = deriveWallQuads(b.log.document);
        expect(qa.length).toBe(qb.length);
        expectNearRel(areaSum(qa), areaSum(qb), 'Σ 轮廓面积');
        expectSamePointSet(
          qa.flatMap((q) => [...q.corners]),
          qb.flatMap((q) => [...q.corners]),
        );
        quads += qa.length;
      }),
      { numRuns: NUM_RUNS_LIGHT },
    );
    expect(quads).toBeGreaterThanOrEqual(2 * NUM_RUNS_LIGHT);
  });

  it('同向角与混合角都出现过，而且出现过的那些都被闭式解比过', () => {
    const total = newStats();
    runAll(() => {}, total, [checkBounds, checkKinds, checkOracle]);
    expect(total.corners.same).toBeGreaterThan(0);
    expect(total.corners.mixed).toBeGreaterThan(0);
    expect(total.oracleEntries).toBeGreaterThan(0);
  });
});

// ---------- ③ 段（续三）：索引跟着画墙（测试 14）----------

/**
 * 全体条目盒的外框，±1mm 余量（口径与 `probeRects.full` 相同，理由写在那儿）。
 * 不用一个写死的"世界大框"：4000mm 的格子下，±1e6 的框一次要扫 25 万格，
 * 而本条每步要查 2 + N 个矩形 × 40 轮 —— 外框从条目现取，代价随链长走，不随坐标范围走。
 */
function unionBox(entries: readonly IndexEntry[]): Aabb {
  if (entries.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return {
    minX: Math.min(...entries.map((e) => e.aabb.minX)) - 1,
    minY: Math.min(...entries.map((e) => e.aabb.minY)) - 1,
    maxX: Math.max(...entries.map((e) => e.aabb.maxX)) + 1,
    maxY: Math.max(...entries.map((e) => e.aabb.maxY)) + 1,
  };
}

describe('索引跟着画墙：从一张空层开始', () => {
  it('每画一段 applyAffected 一次：增量 == 全量，且每条目的自查盒 == 暴力扫', () => {
    let steps = 0;
    let emptyStarts = 0;
    let reuseSteps = 0;
    let partials = 0;
    fc.assert(
      fc.property(arbChainShape, (shape) => {
        let index: SpatialIndex | undefined;
        let reusedBefore = 0;
        const step = (log: TransactionLog, storeyId: string): void => {
          const doc = log.document;
          const walls = doc.byKind('wall').filter((w) => w.storeyId === storeyId);
          if (index === undefined) {
            // 第一次回调 = storeyCreate 之后、一段墙都还没有。Task 9 的 T10 义务 ⑤：
            // 空层既不能抛，也不能把"这层没墙"和"楼层 id 写错"混成同一个空索引。
            expect(walls.length).toBe(0);
            index = SpatialIndex.fromDoc(doc, storeyId);
            expect(index.size).toBe(0);
            expect(index.query({ minX: 0, minY: 0, maxX: 0, maxY: 0 })).toEqual([]);
            emptyStarts++;
            return;
          }
          index.applyAffected(doc, log.affected);
          const live = index.snapshot();
          expect(live).toEqual(SpatialIndex.fromDoc(doc, storeyId).snapshot());
          expect(live.length).toBe(walls.length);
          for (const entry of live) {
            // 拿条目自己的盒子当查询矩形：接头两侧的墙盒在共角端互相盖住，
            // 所以这既是"命中非空"又是"不全表"，一个矩形干两件事，还都是紧的。
            const hit = index.query(entry.aabb);
            expect(hit).toEqual(bruteOverlaps(live, entry.aabb));
            if (hit.length < live.length) partials++;
          }
          const full = unionBox(live);
          expect(index.query(full)).toEqual(live.map((e) => e.id));
          expect(
            index.query({
              minX: full.maxX + 1_000_000,
              minY: full.minY,
              maxX: full.maxX + 1_000_001,
              maxY: full.minY,
            }),
          ).toEqual([]);
          steps++;
          // 复用数 = 2×墙数 − 不同端点数。链上每加一段必然复用 1 个 ⇒ 严格递增一步。
          const ends = new Set(walls.flatMap((w) => [w.startId, w.endId]));
          const reused = walls.length * 2 - ends.size;
          if (reused > reusedBefore) reuseSteps++;
          reusedBefore = reused;
        };
        drawChain(shape, newStats(), step);
      }),
      { numRuns: NUM_RUNS_INDEX },
    );
    expect(emptyStarts).toBe(NUM_RUNS_INDEX);
    expect(steps).toBeGreaterThanOrEqual(2 * NUM_RUNS_INDEX);
    expect(reuseSteps).toBeGreaterThan(0);
    expect(partials).toBeGreaterThan(0);
  });
});
