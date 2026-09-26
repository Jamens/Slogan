import type { EntityId } from '../ids';
import type { Document } from '../model/document';
import type { WallEntity } from '../model/entity';
import {
  awayDir,
  endPoint,
  endPointId,
  wallAxis,
  wallAxisById,
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

/** 按无向轴线分组：所有成员的轴线都过共享点，故方向平行即同一条直线。 */
function lineGroups(members: readonly Member[]): Member[][] {
  const lines: Array<{ dir: Vec2; items: Member[] }> = [];
  for (const m of members) {
    const hit = lines.find((l) => isParallel(l.dir, m.dir));
    if (hit) hit.items.push(m);
    else lines.push({ dir: m.dir, items: [m] });
  }
  return lines.map((l) => l.items);
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

/** 直通墙的哪一侧面朝支墙。两支墙分居直通墙两侧时逐支各算一次，见 cross 分支。 */
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
  const base: Trim[] = members.map(() => ({ left: 0, right: 0 }));
  const at = (m: Member): number => members.indexOf(m);
  const put = (m: Member, side: 1 | -1, hit: Vec2): void => {
    const t = base[at(m)]!;
    const v = trimOf(m, hit);
    if (side === 1) t.left = v;
    else t.right = v;
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
      // 直通两墙同轴同厚，它们的 face 侧面是同一条物理直线，故取 through[0] 与顺序无关；
      // 支墙自己两侧同号（两条边线交在同一条面线上），不是 corner 那种一正一负
      const face = faceSide(through[0]!, stem);
      for (const side of [1, -1] as const) {
        put(stem, side, sideVertex(stem, side, through[0]!, face));
      }
      return base;
    }
    case 'cross': {
      const lines = lineGroups(members);
      const [l1, l2] = [lines[0]!, lines[1]!];
      const through = lineAngle(l1[0]!.dir) <= lineAngle(l2[0]!.dir) ? l1 : l2;
      const stemLine = through === l1 ? l2 : l1;
      requireEqualThrough(pointId, through);
      requireEqualThrough(pointId, stemLine);
      for (const stem of stemLine) {
        // face 必须逐支墙算：两支墙分居直通墙的两侧，共用一个 face 会把其中一支
        // 切到直通墙的**背面**去（trim 变负，轮廓穿过横带、与直通墙重叠）。
        const face = faceSide(through[0]!, stem);
        for (const side of [1, -1] as const) {
          put(stem, side, sideVertex(stem, side, through[0]!, face));
        }
      }
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
 */
function assertNoFlip(doc: Document, joints: readonly Joint[]): void {
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
    if (!start || !end) throw new RangeError(`墙 ${wallId} 的接头成员不齐（内部错误）`);
    const axis = wallAxisById(doc, wallId);
    for (const side of ['trimLeftMm', 'trimRightMm'] as const) {
      const sum = start[side] + end[side];
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
 */
export function deriveJoints(doc: Document): Joint[] {
  const groups = new Map<EntityId, Member[]>();
  for (const wall of doc.byKind('wall')) {
    const axis = wallAxis(doc, wall);
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
  assertNoFlip(doc, joints);
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
