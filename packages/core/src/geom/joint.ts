import type { EntityId } from '../ids';
import type { Document } from '../model/document';
import type { WallEntity } from '../model/entity';
import {
  awayDir,
  endPoint,
  endPointId,
  wallAxis,
  type WallAxis,
  type WallEnd,
} from './axis';
import { advance, dot, intersectLines, isParallel, sub, type Vec2 } from './vec';

/**
 * 接头分类（spec 第 10 节）。身份只来自拓扑：**同一个 pointId** 才算接头，
 * 坐标撞在一起但不共享点的两面墙是两个 free 端，绝不是 corner。
 */
export type JointKind = 'free' | 'corner' | 'tee' | 'cross' | 'collinear' | 'star';

/**
 * 某个墙端在该接头处的斜切量，两侧各一个，**可正可负**：
 * 正 = 沿 awayDir 内退，负 = 越过共享点外伸。L 角必然一侧正一侧负（见计划说明），
 * 所以不能只给一个标量。left = +normal 侧，right = -normal 侧。
 */
export interface JointMember {
  readonly wallId: EntityId;
  readonly end: WallEnd;
  readonly trimLeftMm: number;
  readonly trimRightMm: number;
}

export interface Joint {
  readonly pointId: EntityId;
  readonly kind: JointKind;
  readonly members: readonly JointMember[];
}

interface Member {
  readonly wallId: EntityId;
  readonly end: WallEnd;
  readonly axis: WallAxis;
  /** 指向墙内部的单位向量 */
  readonly away: Vec2;
  readonly normal: Vec2;
  readonly dir: Vec2;
  readonly half: number;
  /** 共享点在浮点侧的位置 */
  readonly vertex: Vec2;
}

function toMember(wall: WallEntity, end: WallEnd, axis: WallAxis): Member {
  return {
    wallId: wall.id,
    end,
    axis,
    away: awayDir(axis, end),
    normal: axis.normal,
    dir: axis.dir,
    half: axis.thicknessMm / 2,
    vertex: endPoint(axis, end),
  };
}

/**
 * 按无向轴线分组：所有成员的轴线都过共享点，故方向平行即同一条直线。
 *
 * 分组是**贪心且以代表元比对**的：每个成员只与该桶的第一个成员（代表元）比 `isParallel`，
 * 不与桶内其余成员比，所以"平行"在这个桶里不传递。误差量级算过：`PARALLEL_EPS = 1e-9`
 * 是 |sinθ| 的相对容差，整数毫米坐标在 2e5 mm 量级下能落进这个带的最大折角约 2.5e-11 rad，
 * 对应的接缝错位是微米级 —— 整数毫米输出里看不见，故按现状保留，不做两两比对。
 */
function lineGroups(members: readonly Member[]): Member[][] {
  const lines: Array<{ dir: Vec2; items: Member[] }> = [];
  for (const m of members) {
    // 只与 l.dir（该桶代表元 = items[0] 的方向）比：见上面文档块的量级结论
    const hit = lines.find((l) => isParallel(l.dir, m.dir));
    if (hit) hit.items.push(m);
    else lines.push({ dir: m.dir, items: [m] });
  }
  return lines.map((l) => l.items);
}

/**
 * 同一线族里出现**同向**的两个墙端 = 两条完全重叠的墙带（用户在同一个点上朝同一方向画了两笔）。
 * `lineGroups` 按无向方向折桶，所以这种输入会落到 `collinear`（members.length === 2 时 trim 全 0），
 * 甚至藏进 tee/cross 的"直通两墙"里 —— 分类照样给出合法的缝，图纸上却是双份材料，
 * 而 Task 10 的 Σ 面积恒等是**逐墙**的，双份材料两边同时成立、抓不到它。所以不变式 3 在这一层拦：
 * 非法即抛，且在分类之前抛，collinear / tee / cross / star 一律覆盖。
 * 三个以上成员同线不必特判：两条射线放三个端点，鸽笼原理保证必有一对同向，逐对检查自然命中。
 */
function assertNoSameRay(pointId: EntityId, members: readonly Member[]): void {
  for (const line of lineGroups(members)) {
    for (let i = 0; i < line.length; i += 1) {
      for (let j = i + 1; j < line.length; j += 1) {
        const a = line[i]!;
        const b = line[j]!;
        if (dot(a.away, b.away) > 0) {
          const coSame = line.filter((m) => dot(m.away, a.away) > 0).length;
          throw new RangeError(
            `接头 ${pointId} 有 ${coSame} 个墙端在同一点同向重叠（墙 ${a.wallId} 的 ${a.end} 端与墙 ${b.wallId} 的 ${b.end} 端朝同一方向离开该点），` +
              `S1 不支持：请把其中一面墙挪开或删掉`,
          );
        }
      }
    }
  }
}

function kindOf(members: readonly Member[]): JointKind {
  if (members.length === 1) return 'free';
  const lines = lineGroups(members);
  if (lines.length === 1) return 'collinear';
  if (members.length === 2) return 'corner';
  if (members.length === 3 && lines.length === 2) return 'tee';
  if (members.length === 4 && lines.length === 2 && lines.every((l) => l.length === 2)) {
    return 'cross';
  }
  return 'star';
}

/** 某成员某一侧的边线（无限直线）与该边线上一点。 */
function sideVertex(a: Member, sideA: 1 | -1, b: Member, sideB: 1 | -1): Vec2 {
  const hit = intersectLines(
    advance(a.vertex, a.normal, sideA * a.half),
    a.dir,
    advance(b.vertex, b.normal, sideB * b.half),
    b.dir,
  );
  if (hit === null) {
    // 不可达：两支墙平行时它们同属一条轴线，分类阶段就走不到 corner/tee/cross 的配对；
    // 这里只是 intersectLines 返回 null 的兜底，不静默退回"按端点平接"
    throw new RangeError(`接头处两侧边线近平行，求不出接缝点：墙 ${a.wallId} 与墙 ${b.wallId}`);
  }
  return hit;
}

/** 把接缝点换算成该成员该侧的斜切量（沿 awayDir 的有符号距离）。 */
function trimOf(m: Member, hit: Vec2): number {
  return dot(sub(hit, m.vertex), m.away);
}

/**
 * 与 `side` 相反的那一侧。不写 `-side`：TS 的一元负号把 `1 | -1` 展宽成 `number`，
 * 传回 sideVertex/put 会撞 TS2345（`otherEnd` 在 axis.ts 里是同样的显式写法）。
 */
function otherSide(side: 1 | -1): 1 | -1 {
  return side === 1 ? -1 : 1;
}

/** 直通墙的哪一侧面朝支墙。唯一的调用点是 putFlatJoin，且逐支墙各算一次。 */
function faceSide(through: Member, stem: Member): 1 | -1 {
  const facing = dot(through.normal, stem.away);
  if (facing === 0) {
    // 支墙与直通墙平行时两者同属一条轴线，分组阶段就不会走到 tee/cross：这里只是兜底
    throw new RangeError(`支墙 ${stem.wallId} 与直通墙 ${through.wallId} 的几何无面线可辨`);
  }
  return facing > 0 ? 1 : -1;
}

/**
 * corner：该成员的哪一侧是**内侧面**（朝对面那堵墙实体的一面）。
 * 两墙的内侧面交于轮廓的凹角点，两条外侧面交于凸角点 —— 这两个点才是共用的接缝端点。
 *
 * 不能按"各自的第 s 条边线相交"配对：那只在一墙 start、一墙 end 时恰好成立。
 * 用户在同一个点上连画两笔（start/start）时，两墙的 +normal 一内一外，
 * 同侧配对称出的交点落在两堵墙之外，两墙轮廓随即重叠 —— 而接缝闭合、
 * trimLeft = -trimRight、Σ 面积恒等三条**全都照样成立**（两侧取的是同一个交点，
 * 误差被构造本身抹平），所以这三条属性抓不到它。能抓到的只有两处：joint.test.ts 那两条
 * 「同向起画」的定值用例，和 Task 10 那条**按侧**比对闭式解的属性测试 ——
 * 它的预言里没有任何"第几条边线"的约定，只有两墙的内向向量与半厚。
 */
function innerSide(m: Member, other: Member): 1 | -1 {
  const facing = dot(other.away, m.normal);
  if (facing === 0) {
    // 两墙轴线平行时 kindOf 早就判成 collinear 了：这条同样只是兜底
    throw new RangeError(`接头处墙 ${m.wallId} 与墙 ${other.wallId} 的边线无内外侧面可辨`);
  }
  return facing > 0 ? 1 : -1;
}

function requireEqualThrough(pointId: EntityId, through: readonly Member[]): void {
  const [a, b] = [through[0]!, through[1]!];
  if (a.axis.thicknessMm !== b.axis.thicknessMm) {
    throw new RangeError(
      `接头 ${pointId} 的直通两墙厚度不同（${a.axis.thicknessMm} / ${b.axis.thicknessMm}），` +
        `S1 的 T 接与十字要求直通两墙同厚：请统一墙厚，或把它改画成 L 角`,
    );
  }
}

/**
 * 无向方向角落在 [0, π)：用于十字的确定性 tie-break。
 * 两族的这个值与"谁在 members 里排前面"无关（同一族内反向的两条轴线折到同一个值），
 * 所以直通族的选取不受 uuidv7 的排序运气影响。
 */
function lineAngle(dir: Vec2): number {
  const a = Math.atan2(dir.y, dir.x);
  return ((a % Math.PI) + Math.PI) % Math.PI;
}

interface Trim {
  left: number;
  right: number;
}

function trimsFor(pointId: EntityId, kind: JointKind, members: readonly Member[]): Trim[] {
  // 一格一成员：put 直接查表，不再每次写回都 members.indexOf(m) 线性找下标
  const slots = new Map<Member, Trim>();
  const base: Trim[] = members.map((m) => {
    const t: Trim = { left: 0, right: 0 };
    slots.set(m, t);
    return t;
  });
  const put = (m: Member, side: 1 | -1, hit: Vec2): void => {
    const t = slots.get(m)!;
    const v = trimOf(m, hit);
    if (side === 1) t.left = v;
    else t.right = v;
  };
  /**
   * 平接斜切：把支墙两侧都切到直通墙朝它的那一面上，故两侧**同号**（不是 corner 的一正一负）。
   * tee 与 cross 共用这一块 —— 计划文本里两处逐字重复，而重复正是本任务那次假变异的产地
   * （把 `const face` 提到 cross 的循环外、被循环内的块级声明遮蔽，实现等价、18 条全绿）。
   * 抽成单一实现后 face 只有一个产地，"提到循环外"这种遮蔽写法在结构上不再存在。
   * face 逐支墙算：两支墙分居直通墙两侧时共用一个 face 会把其中一支切到**背面**去
   * （trim 变负，轮廓穿过横带、与直通墙重叠）。
   */
  const putFlatJoin = (stem: Member, through: Member): void => {
    const face = faceSide(through, stem);
    for (const side of [1, -1] as const) {
      put(stem, side, sideVertex(stem, side, through, face));
    }
  };

  switch (kind) {
    case 'free':
    case 'collinear':
      return base;
    case 'corner': {
      const [a, b] = [members[0]!, members[1]!];
      // 内侧配内侧（凹角点）、外侧配外侧（凸角点）：见 innerSide 的注释
      const sa = innerSide(a, b);
      const sb = innerSide(b, a);
      const inner = sideVertex(a, sa, b, sb);
      const outer = sideVertex(a, otherSide(sa), b, otherSide(sb));
      put(a, sa, inner);
      put(b, sb, inner);
      put(a, otherSide(sa), outer);
      put(b, otherSide(sb), outer);
      return base;
    }
    case 'tee': {
      const lines = lineGroups(members);
      const through = lines.find((l) => l.length === 2)!;
      const stem = lines.find((l) => l.length === 1)![0]!;
      requireEqualThrough(pointId, through);
      // 直通两墙同轴同厚，它们的 face 侧面是同一条物理直线，故取 through[0] 与顺序无关
      putFlatJoin(stem, through[0]!);
      return base;
    }
    case 'cross': {
      const lines = lineGroups(members);
      const [l1, l2] = [lines[0]!, lines[1]!];
      const through = lineAngle(l1[0]!.dir) <= lineAngle(l2[0]!.dir) ? l1 : l2;
      const stemLine = through === l1 ? l2 : l1;
      // 只要求**真直通那一族**同厚：两支臂被直通带隔开、彼此从不同时接触，
      // 支族异厚画出的是"带台阶的平接"（北臂切到 y=1120、南臂切到 y=880，无缝无重叠），
      // 是合法图纸。计划文本在这里还要求 stemLine 同厚，那句「直通两墙厚度不同」说的
      // 并不是这一对墙，等于用一条不成立的规矩拒掉合法图纸 —— 故不加。
      requireEqualThrough(pointId, through);
      for (const stem of stemLine) putFlatJoin(stem, through[0]!);
      return base;
    }
    case 'star':
      throw new RangeError(
        `接头 ${pointId} 有 ${members.length} 个墙端、${lineGroups(members).length} 个方向在同一点相交（star），` +
          `S1 不支持：请把其中一面墙打断成两段，让交点变成 T 接`,
      );
  }
}

/**
 * 轮廓翻面守卫：同一侧的两端角点不能越过彼此，否则四边形自相交，
 * 图纸上就是一个蝴蝶结。夹角极小时斜切量会爆（cot(θ/2) → ∞），这里兜住。
 *
 * 轴长取 deriveJoints 已经算好的那张 axis 表，不再 wallAxisById 回查文档：
 * 回查是第二次派生（同一面墙算两遍），还要顺带做楼层存在性检查 —— 一个几何守卫
 * 没有资格去判"这份文档的引用完不完整"，那是 model/read 与命令层的事。
 */
function assertNoFlip(axes: ReadonlyMap<EntityId, WallAxis>, joints: readonly Joint[]): void {
  const ends = new Map<EntityId, Partial<Record<WallEnd, JointMember>>>();
  for (const joint of joints) {
    for (const m of joint.members) {
      const slot = ends.get(m.wallId) ?? {};
      slot[m.end] = m;
      ends.set(m.wallId, slot);
    }
  }
  for (const [wallId, slot] of ends) {
    const start = slot.start;
    const end = slot.end;
    // 不可达：joints 由 deriveJoints 对每面墙的 start 与 end 各建一个成员，
    // 同一面墙的两个条目必到齐；缺一个就是本文件的建组逻辑写错了，属内部错误
    if (!start || !end) throw new RangeError(`墙 ${wallId} 的接头成员不齐（内部错误）`);
    // 不可达：axes 与 ends 的键都来自同一个 doc.byKind('wall') 循环，按构造必然命中
    const axis = axes.get(wallId)!;
    for (const side of ['trimLeftMm', 'trimRightMm'] as const) {
      const sum = start[side] + end[side];
      // 用 >= 而不是 >：合计恰好等于轴长时该侧两端角点重合在同一点，四边形退化成一条线 ——
      // 与越过彼此同样画不出轮廓，所以"等于"这一合法边界是**故意**非法的，别改成 >
      if (sum >= axis.lengthMm) {
        throw new RangeError(
          `墙 ${wallId} 在 ${side === 'trimLeftMm' ? '+normal' : '-normal'} 侧的两端斜切量合计 ${Math.round(sum)} ` +
            `不小于轴长 ${Math.round(axis.lengthMm)}，轮廓会翻面`,
        );
      }
    }
  }
}

/**
 * 每个被墙端引用的点一个接头，自由端也算（kind 'free'），这样 Task 5 只需一次查表
 * 就能拿到一面墙四角的斜切量，不必区分"有没有接头"。顺序：pointId 升序，组内按墙 id 升序
 * （来自 doc.byKind('wall')，不是"建墙顺序" —— 同毫秒的 uuidv7 不保证单调）。
 * 分类与斜切量的任何判据都只读这个确定顺序里的**几何量**（轴线角、厚度、点积符号），
 * 绝不读下标本身：十字的直通族由 lineAngle 选出，tee 的直通族由组内成员数选出。
 * 非法输入一律抛、不兜底：同一点同向重叠的墙端（assertNoSameRay）、带台阶的直通
 * （requireEqualThrough）、极小夹角导致的轮廓翻面（assertNoFlip）、超过十字的星形交点。
 */
export function deriveJoints(doc: Document): Joint[] {
  const groups = new Map<EntityId, Member[]>();
  const axes = new Map<EntityId, WallAxis>();
  for (const wall of doc.byKind('wall')) {
    const axis = wallAxis(doc, wall);
    axes.set(wall.id, axis);
    for (const end of ['start', 'end'] as const) {
      const pointId = endPointId(wall, end);
      const list = groups.get(pointId);
      const member = toMember(wall, end, axis);
      if (list) list.push(member);
      else groups.set(pointId, [member]);
    }
  }
  const joints: Joint[] = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([pointId, members]) => {
      // 先拦同向重叠，再分类：见 assertNoSameRay 的注释（collinear / tee / cross 一律覆盖）
      assertNoSameRay(pointId, members);
      const kind = kindOf(members);
      const trims = trimsFor(pointId, kind, members);
      return {
        pointId,
        kind,
        members: members.map((m, i) => ({
          wallId: m.wallId,
          end: m.end,
          trimLeftMm: trims[i]!.left,
          trimRightMm: trims[i]!.right,
        })),
      };
    });
  assertNoFlip(axes, joints);
  return joints;
}

/** Task 5 的入口：一面墙某一端的斜切量。找不到就抛，绝不返回 0 蒙过去。 */
export function memberTrim(
  joints: readonly Joint[],
  wallId: EntityId,
  end: WallEnd,
): JointMember {
  for (const joint of joints) {
    for (const m of joint.members) {
      if (m.wallId === wallId && m.end === end) return m;
    }
  }
  throw new RangeError(`接头表里找不到墙 ${wallId} 的 ${end} 端（内部错误）`);
}
