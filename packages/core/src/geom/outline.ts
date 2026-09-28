import type { EntityId } from '../ids';
import type { Document } from '../model/document';
import { mustExist } from '../model/read';
import { applyPatch, type Patch } from '../model/patch';
import { cornerPoint, wallAxis, type WallAxis } from './axis';
import { deriveJoints, memberTrim, type Joint, type JointMember } from './joint';
import { openingSpans, piecesFromSpans, type WallPiece } from './opening';
import type { Vec2 } from './vec';

/**
 * 一面墙的矩形（斜切后是梯形）轮廓。corners 是**环序**：
 * 0 = start 侧 +normal，1 = end 侧 +normal，2 = end 侧 -normal，3 = start 侧 -normal。
 * 顺序即契约 —— 计划 3 描边、计划 5 标注都以它为前提。
 */
export interface WallQuad {
  readonly wallId: EntityId;
  readonly corners: readonly [Vec2, Vec2, Vec2, Vec2];
  readonly areaMm2: number;
}

/**
 * 鞋带公式，返回绝对值。注意：自相交的蝴蝶形两叶带符号相消 → 给 0，
 * 所以"面积对"不等于"形状对"，调用方要单独保证不自交（joint.ts 的 assertNoFlip）。
 */
export function polygonArea(points: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/**
 * 轴线 + 两端的斜切量 → 四角。角点一律走 axis.ts 的 cornerPoint（它内部经 vec.ts 的
 * point() 构造向量），本文件不自建 Vec2 字面量 —— 于是 -0 无从产生（±0 纪律）。
 */
export function wallQuad(axis: WallAxis, startTrim: JointMember, endTrim: JointMember): WallQuad {
  const corners: [Vec2, Vec2, Vec2, Vec2] = [
    cornerPoint(axis, 'start', 1, startTrim.trimLeftMm),
    cornerPoint(axis, 'end', 1, endTrim.trimLeftMm),
    cornerPoint(axis, 'end', -1, endTrim.trimRightMm),
    cornerPoint(axis, 'start', -1, startTrim.trimRightMm),
  ];
  return { wallId: axis.wallId, corners, areaMm2: polygonArea(corners) };
}

/**
 * joints 可传入以避免重复派生（Task 6 的整层入口一次派生两处用）。
 * 不传就内部派生：绝不因为"没接头表"就退化成平接 —— 那样接头会静默开裂。
 * 顺序跟着 doc.byKind('wall')（墙 id 升序），不跟着创建顺序。
 */
export function deriveWallQuads(doc: Document, joints?: readonly Joint[]): WallQuad[] {
  const table = joints ?? deriveJoints(doc);
  return doc.byKind('wall').map((wall) => {
    const axis = wallAxis(doc, wall);
    return wallQuad(axis, memberTrim(table, wall.id, 'start'), memberTrim(table, wall.id, 'end'));
  });
}

/**
 * 一层的完整派生几何 —— 计划 3 的 2D 视图、Task 9 的空间索引都只吃这一个出口。
 * pieces 是"沿轴区间"，不是多边形：把墙垛再切成梯形属计划 5（图纸要画断开的材料），
 * 这里保持与真源同构，避免第二份几何。
 */
export interface StoreyGeometry {
  readonly storeyId: EntityId;
  readonly walls: readonly WallQuad[];
  readonly joints: readonly Joint[];
  readonly pieces: readonly WallPiece[];
}

export function deriveStoreyGeometry(doc: Document, storeyId: EntityId): StoreyGeometry {
  mustExist(doc, storeyId, '楼层');
  const walls = doc.byKind('wall').filter((wall) => wall.storeyId === storeyId);
  const ids = new Set(walls.map((wall) => wall.id));
  // 接头表整体派生一次：斜切量是全局性质（同一点上所有墙端一起算），不能按层各算各的
  const allJoints = deriveJoints(doc);
  const joints = allJoints.filter((j) => j.members.every((m) => ids.has(m.wallId)));
  const endsSeen = new Map<EntityId, number>();
  for (const joint of joints) {
    for (const m of joint.members) endsSeen.set(m.wallId, (endsSeen.get(m.wallId) ?? 0) + 1);
  }
  // 每面本层墙必须在接头表里出现两次（两端各一次）。少一次 = 某端的接头被别层墙共享，
  // 于是被上面的 filter 丢掉 —— 斜切量会静默消失，墙画出缝来。Task 3 的 resolvePointRef
  // 挡着命令层，但 Document 不校验引用完整性，这里必须自己发现。
  for (const wall of walls) {
    if ((endsSeen.get(wall.id) ?? 0) !== 2) {
      throw new RangeError(
        `墙 ${wall.id} 的某个端点接头不在本层（楼层 ${storeyId}）：` +
          `存在跨楼层共享端点，派生会静默丢掉斜切量`,
      );
    }
  }
  // Task 5 回填 O1：这里必须喂**未过滤的** allJoints，按层裁剪发生在返回值上。
  // 误传上面那张 joints（filter 过的）在单楼层 fixture 上完全隐形（filter 是 no-op），
  // 多楼层才抛 /接头表里找不到墙/；若传"按成员删过但骨架还在"的表，更坏：成员数一变
  // kindOf 就把 cross 降级成 tee、tee 降级成 corner，斜切量静默算错而一条异常都不抛。
  // 另：joints 非空时 deriveJoints 不跑，assertNoSameRay / requireEqualThrough / star 抛错 /
  // assertNoFlip 四道守卫随之缺席 —— 所以这张表只能来自同一个 doc 的同一次 deriveJoints。
  const quads = deriveWallQuads(doc, allJoints).filter((q) => ids.has(q.wallId));
  const pieces = walls.flatMap((wall) =>
    piecesFromSpans(wall.id, wallAxis(doc, wall).lengthMm, openingSpans(doc, wall)),
  );
  return { storeyId, walls: quads, joints, pieces };
}

/**
 * 命令层的**派生复核**：把候选补丁贴到草稿文档上跑一次整层派生，派生抛则命令抛。
 *
 * 为什么在写入侧而不是 UI 侧：`deriveStoreyGeometry` 的四道守卫（star 接头、同向重叠、
 * 近平行求不出接缝点、轮廓翻面）只有这一个产地。屏幕若自己再算一遍接头分类去预言"这一发
 * 画不画得出来"，就是第二份规则 —— 复述的规则一定漂，而漂掉的那一遍永远没人看
 * （`commands/opening.ts` 顶部那句"命令层绝不复述区间规则"同一条理由）。
 * `applyPatch` 是纯函数、不动传进来的 doc，所以这张草稿是免费的（`assertFitsAfterInsert` 同一条手法）。
 *
 * 只给**改几何**的命令用（wall.create / wall.moveEndpoint / wall.setThickness）。删除路径
 * 一律不复核：坏数据必须还能删，守卫挡住删除就等于把文档锁死（`openingMove` 把正数那条
 * 守卫放在 move 而不是 requireOpening 里，是同一条纪律）。柱与板不在这张派生表里
 * （`deriveStoreyGeometry` 只读墙），所以 column/slab 命令也不必复核。
 */
export function assertDerivesAfterApply(doc: Document, patch: Patch, storeyId: EntityId): void {
  const next = applyPatch(doc, patch).doc;
  deriveStoreyGeometry(next, storeyId);
}
