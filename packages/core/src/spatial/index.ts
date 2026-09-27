import type { EntityId } from '../ids';
import { assertMm, positiveMm } from '../units/mm';
import type { Document } from '../model/document';
import type { Entity, OpeningEntity, WallEntity } from '../model/entity';
import { mustExist, requireWall } from '../model/read';
import { dependentsOf } from '../geom/topology';
import { deriveJoints, memberTrim, type Joint } from '../geom/joint';
import { wallAxis, wallAxisById, type WallAxis } from '../geom/axis';
import { advance, type Vec2 } from '../geom/vec';
import { wallQuad } from '../geom/outline';
import { openingSpans, type OpeningSpan } from '../geom/opening';

/** 轴对齐包围盒。分量是浮点：它由派生轮廓（本身是浮点）取极值而来。 */
export interface Aabb {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export function aabbOfPoints(points: readonly Vec2[]): Aabb {
  if (points.length === 0) throw new RangeError('aabbOfPoints 需要至少一个点');
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * 闭区间相交：贴边与包含都算"碰上"。索引宁可多报候选也不能漏，
 * 开区间会在两个盒子恰好共边时漏掉真实可拾取的构件。
 */
export function aabbIntersects(a: Aabb, b: Aabb): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/**
 * 洞口沿墙方向的盒子：轴线区间 × 墙厚，**不含接头斜切**。
 * 洞口本身恒真包含在这个盒子里（斜切只会削墙的角，不会削洞口），所以它是合法的保守候选盒。
 */
export function openingAabb(axis: WallAxis, span: OpeningSpan): Aabb {
  const half = axis.thicknessMm / 2;
  const from = advance(axis.start, axis.dir, span.fromMm);
  const to = advance(axis.start, axis.dir, span.toMm);
  return aabbOfPoints([
    advance(from, axis.normal, half),
    advance(to, axis.normal, half),
    advance(to, axis.normal, -half),
    advance(from, axis.normal, -half),
  ]);
}

/**
 * 真源引用关系的反向闭包（dependentsOf 迭代到不动点），含 seed 自身。
 * 注意它**只是**真源闭包：删一面墙时邻墙的接头会变，改一面墙的墙厚时共角邻墙的斜切会变，
 * 而这两种"邻居"都不在引用关系里。SpatialIndex 自己再走一层（见 dirtyIds 的双向闭包）。
 * 终止性由 kind 顺序保证：point → wall / column / slab，wall → opening，storey → 层内构件，
 * opening / column / slab 无下游。真源再怎么悬空引用也构不成环，所以这里不需要访问上限。
 */
export function expandAffected(doc: Document, seed: ReadonlySet<EntityId>): Set<EntityId> {
  const out = new Set<EntityId>(seed);
  const queue: EntityId[] = [...seed];
  while (queue.length > 0) {
    const id = queue.shift()!;
    // 被删的实体没有下游：它的下游要么同批被删（本来就在 seed 里），要么根本不引用它
    if (doc.get(id) === undefined) continue;
    for (const dependent of dependentsOf(doc, id)) {
      if (!out.has(dependent)) {
        out.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return out;
}

export type IndexedKind = 'wall' | 'opening';

/**
 * 一条索引记录。dependsOn 是"这个盒子由哪些 id 决定"：
 * 墙 = 两个端点；洞口 = 宿主墙 + 那两个端点。局部重建的反向闭包靠它，
 * 因为"两墙共享端点"这条边不在真源的引用关系里（见 expandAffected 的注释）。
 */
export interface IndexEntry {
  readonly id: EntityId;
  readonly kind: IndexedKind;
  readonly aabb: Aabb;
  readonly dependsOn: readonly EntityId[];
}

/**
 * 一面墙的盒子由哪些 id 决定。条目的 dependsOn 与局部重建的脏闭包**共用这一份定义**：
 * 各写一遍迟早漂，而漂的方向是"少给一条边"→ 少重建 → 计划 3 点不动。
 */
function wallDeps(wall: WallEntity): readonly EntityId[] {
  return [wall.startId, wall.endId];
}

/** 一樘洞口的盒子由哪些 id 决定：宿主墙 + 宿主墙那两个端点（端点口径上面那份，不重抄）。 */
function openingDeps(host: WallEntity): readonly EntityId[] {
  return [host.id, ...wallDeps(host)];
}

/**
 * 从**实体**现取依赖边。唯一的用户是 dirtyIds 的第 2 步回落：刚建成的构件此刻还没有条目，
 * 它两端挂着的既有邻墙于是没人认领（这就是邻墙盒子发霉的那条路）。
 * point / column / slab 没有盒子，返空 —— 它们的下游本来就走 expandAffected。
 * 洞口的宿主墙查不到、或查到了却不是墙时只回 [hostWallId]：这不是兜底，边照走，
 * 病态文档随后在 openingEntry 里由 requireWall / openingSpans 抛，
 * 抛错的那一步仍然只有一处（脏闭包不该比盒子派生更严格）。
 */
function entityDeps(doc: Document, entity: Entity): readonly EntityId[] {
  if (entity.kind === 'wall') return wallDeps(entity);
  if (entity.kind === 'opening') {
    const host = doc.get(entity.hostWallId);
    return host?.kind === 'wall' ? openingDeps(host) : [entity.hostWallId];
  }
  return [];
}

export interface SpatialIndexOptions {
  readonly cellSizeMm?: number;
}

const DEFAULT_CELL_SIZE_MM = 4000;

function assertCellSize(value: number): number {
  // 网格边长也走 assertMm：整数毫米，免得浮点渗进 cell key（key 一变，插进去的盒子就找不回来了）
  return positiveMm(assertMm(value, '网格边长'), '网格边长');
}

function assertQueryable(rect: Aabb): void {
  if (
    !Number.isFinite(rect.minX) ||
    !Number.isFinite(rect.minY) ||
    !Number.isFinite(rect.maxX) ||
    !Number.isFinite(rect.maxY)
  ) {
    throw new RangeError(`查询矩形必须是有限数，收到 ${JSON.stringify(rect)}`);
  }
  if (rect.minX > rect.maxX || rect.minY > rect.maxY) {
    throw new RangeError(
      `查询矩形上下界颠倒：(${rect.minX}, ${rect.minY})–(${rect.maxX}, ${rect.maxY})`,
    );
  }
}

/**
 * 一层的 AABB 均匀网格。spec 第 9 节：command 后只重建受影响节点局部。
 *
 * "局部"的确切口径（别对外吹）：**盒子只为脏条目重算，网格只为脏条目重挂**。
 * 接头表一次派生**整个文档** —— `deriveJoints(doc)` 吃的是 doc，不看 storeyId：
 * 斜切量是全局性质（Task 4），一面墙的两端各被别的墙牵着，没有"只重算这一段"的合法做法。
 * 两条后果都是明账：① 一层的重建是 O(全档墙数)而不是 O(本层墙数)；
 * ② 别层一个非法接头（同点同向重叠、带台阶的直通、极小夹角翻面、星形交点）会让本层
 * 这次重建直接抛 —— 与"内部不变式破了就抛、绝不兜底"的口径一致，整层重建同样抛，
 * 所以这是作用域的账，不是正确性缺口。
 */
export class SpatialIndex {
  private readonly storeyId: EntityId;
  private readonly cellSizeMm: number;
  private readonly entries = new Map<EntityId, IndexEntry>();
  private readonly cells = new Map<string, Set<EntityId>>();

  private constructor(storeyId: EntityId, cellSizeMm: number) {
    this.storeyId = storeyId;
    this.cellSizeMm = cellSizeMm;
  }

  static fromDoc(
    doc: Document,
    storeyId: EntityId,
    options: SpatialIndexOptions = {},
  ): SpatialIndex {
    const index = new SpatialIndex(
      storeyId,
      assertCellSize(options.cellSizeMm ?? DEFAULT_CELL_SIZE_MM),
    );
    index.rebuild(doc);
    return index;
  }

  get size(): number {
    return this.entries.size;
  }

  /** 按 id 升序的条目快照：测试用它比对局部重建与整层重建。 */
  snapshot(): readonly IndexEntry[] {
    return [...this.entries.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  entryOf(id: EntityId): IndexEntry | undefined {
    return this.entries.get(id);
  }

  rebuild(doc: Document): void {
    // 楼层不存在就别往下建：不查这一句，fromDoc(doc, 乱写的 id) 会静默建成一个空索引，
    // 而空索引在 query 里和"这层真的没有墙"长得一模一样 —— 计划 3 的症状是点不动，查不到根因
    mustExist(doc, this.storeyId, '楼层');
    this.clear();
    const joints = deriveJoints(doc);
    for (const wall of doc.byKind('wall')) {
      if (wall.storeyId === this.storeyId) this.insert(this.wallEntry(doc, wall, joints));
    }
    for (const opening of doc.byKind('opening')) {
      if (opening.storeyId !== this.storeyId) continue;
      this.insert(this.openingEntry(doc, opening));
    }
  }

  applyAffected(doc: Document, affected: ReadonlySet<EntityId>): void {
    const dirty = this.dirtyIds(doc, affected);
    if (dirty.size === 0) return;
    let joints: readonly Joint[] | null = null;
    // id 升序遍历：同一批脏条目里先墙后洞口的顺序会影响 Map 的插入序，
    // 排序之后 snapshot() 的比对不受 dispatch 顺序影响（契约：派生层按 id 升序）
    for (const id of [...dirty].sort()) {
      const entity = doc.get(id);
      if (!entity || entity.kind === 'storey' || entity.storeyId !== this.storeyId) {
        this.remove(id);
        continue;
      }
      if (entity.kind === 'wall') {
        joints ??= deriveJoints(doc);
        this.insert(this.wallEntry(doc, entity, joints));
      } else if (entity.kind === 'opening') {
        this.insert(this.openingEntry(doc, entity));
      } else {
        // point / column / slab：本计划不入索引（Task 8 的非目标）， remove 是空操作
        this.remove(id);
      }
    }
  }

  /**
   * 矩形命中：返回的是**候选**，不是几何证明 —— AABB 相交 ≠ 几何相交。多报来自两处：
   *
   * 1. **洞口盒不带斜切**。它是「沿轴区间 × 墙厚」（见 `openingAabb`），而墙的两端被接头
   *    削成梯形，所以端头被斜掉的那块三角里仍会报出这樘洞口。方向仍安全：斜切只削墙的角、
   *    不削洞口，洞口盒恒真包含洞口本身（`openingAabb` 那条用例把 ±half 与 to-from=width
   *    两个边界都钉死了）。
   * 2. **墙盒是斜切后梯形的包围盒**，共角那一端的外伸方块会整块落进邻墙的盒子里：
   *    L 角上 A 的框是 x[0,3720]、B 的框是 x[3480,3720]×y[-120,2400]，A 越过轴线端点
   *    3600 的那一竖条其实全是 B 的材料 —— 这一问在 AABB 层面根本分不开共角的两面墙。
   *
   * 保守方向是**宁多不漏**：漏一个候选，计划 3 的症状就是"点了没反应"，根因却在几万行之外；
   * 多一个候选只是让上层白测一次。精确命中（点在不在这个梯形里、在不在这个洞口矩形里）
   * 归 `scene-2d`，本计划还没有那一层。
   */
  query(rect: Aabb): EntityId[] {
    assertQueryable(rect);
    const hits = new Set<EntityId>();
    for (const key of this.cellKeys(rect)) {
      for (const id of this.cells.get(key) ?? []) {
        const entry = this.entries.get(id);
        // 精筛：格子是粗的，落在同一格不等于盒子相交
        if (entry && aabbIntersects(entry.aabb, rect)) hits.add(id);
      }
    }
    return [...hits].sort();
  }

  queryPoint(x: number, y: number): EntityId[] {
    return this.query({ minX: x, minY: y, maxX: x, maxY: y });
  }

  /** 这个矩形会扫多少个格子。局部性的度量，也是 Step 6 第 4、5 条变异的靶子。 */
  cellVisits(rect: Aabb): number {
    assertQueryable(rect);
    return this.cellKeys(rect).length;
  }

  /**
   * 这个 id 的盒子由哪些 id 决定 —— **一条回落链，两个来源，顺序不能反**：
   * 1. 索引里还留着条目就用它。这既是**已删除**实体唯一的边来源（`doc.get(id)` 对它已是
   *    undefined，「删一面墙」那条全靠旧条目把共享端点带出来），也是本次重建那一刻之前
   *    那张真实生效的依赖图。
   * 2. 条目不存在而实体还活着，就从实体现取（`entityDeps`）。刚 `wallCreate` /
   *    `openingCreate` 出来的构件正是这一类：它自己还没有条目，两端却可能挂着既有邻墙。
   * 只走第 1 步会漏新建实体（邻墙盒子发霉），只走第 2 步会漏被删实体 —— 两步必须留在同一条
   * 回落链上、由 dirtyIds 里唯一的消费点取边；写成两次独立遍历的话，后者会悄悄替前者干活，
   * 变异检查（删掉那一行 for）也就再也红不起来了。
   */
  private dependsOnOf(doc: Document, id: EntityId): readonly EntityId[] {
    const entry = this.entries.get(id);
    if (entry) return entry.dependsOn;
    const entity = doc.get(id);
    return entity ? entityDeps(doc, entity) : [];
  }

  /**
   * 双向闭包：真源反向依赖（expandAffected）∪ 盒子的共享端点（dependsOnOf：条目优先、实体回落）。
   * 少了后半段，"删一面墙""改一面墙的墙厚""新建的墙复用既有端点""在既有端点之间合上一间房"
   * 四条都会留下发霉的邻墙盒子（实测：摘掉下面那行 for，红的正是这四条 + 拖拐角仍绿）。
   */
  private dirtyIds(doc: Document, affected: ReadonlySet<EntityId>): Set<EntityId> {
    const dirty = new Set<EntityId>();
    const queue: EntityId[] = [...affected];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (dirty.has(id)) continue;
      dirty.add(id);
      // 盒子的依赖边只有这一个产地（连"本次补丁里的新实体"一起走，见 dependsOnOf）。
      // "两墙共享端点"这条边不在真源的引用关系里，删掉这一行，四条邻墙发霉的用例同时红。
      for (const dep of this.dependsOnOf(doc, id)) queue.push(dep);
      for (const dependent of expandAffected(doc, new Set([id]))) {
        if (!dirty.has(dependent)) queue.push(dependent);
      }
    }
    return dirty;
  }

  private wallEntry(doc: Document, wall: WallEntity, joints: readonly Joint[]): IndexEntry {
    const axis = wallAxis(doc, wall);
    const quad = wallQuad(
      axis,
      memberTrim(joints, wall.id, 'start'),
      memberTrim(joints, wall.id, 'end'),
    );
    return {
      id: wall.id,
      kind: 'wall',
      aabb: aabbOfPoints(quad.corners),
      dependsOn: wallDeps(wall),
    };
  }

  private openingEntry(doc: Document, opening: OpeningEntity): IndexEntry {
    const wall = requireWall(doc, opening.hostWallId);
    // 区间只有一份口径：走 openingSpans，顺带把它内建的「洞口与宿主墙同层」检查也用了。
    // 自己拼 distanceMm + widthMm 更短，但那条楼层检查就会成为索引独缺的一道守卫。
    const span = openingSpans(doc, wall).find((s) => s.openingId === opening.id);
    if (!span) throw new TypeError(`洞口 ${opening.id} 在宿主墙 ${wall.id} 上派生不出区间`);
    return {
      id: opening.id,
      kind: 'opening',
      aabb: openingAabb(wallAxisById(doc, wall.id), span),
      dependsOn: openingDeps(wall),
    };
  }

  private cellKeys(rect: Aabb): string[] {
    const x0 = Math.floor(rect.minX / this.cellSizeMm);
    const x1 = Math.floor(rect.maxX / this.cellSizeMm);
    const y0 = Math.floor(rect.minY / this.cellSizeMm);
    const y1 = Math.floor(rect.maxY / this.cellSizeMm);
    const keys: string[] = [];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) keys.push(`${cx},${cy}`);
    }
    return keys;
  }

  private insert(entry: IndexEntry): void {
    // 这一句是承重的，别当"顺手简化掉"的候选：盒子挪过之后旧格子里那个 id 不会自己消失，
    // 不先 remove 就永远留着 —— `cells` 只增不减，扫得越来越宽（内存与扫描成本，不是错答案）。
    // 之所以**没有测试钉得住它**：这件事公开 API 看不见。幽灵成员既不会多报（下面 `query`
    // 那条精筛用的是**当前** entries 里的盒子，共格条件恰好保证真相交的条目必在矩形所扫的
    // 某一格里）也不会漏报（insert 与 query 同一个 cellKeys），而 snapshot/size/entryOf/
    // cellVisits 都不读桶内容。变异检查实测 0 红 ⇒ 等价变异（brief Step 6 第 6 条预测
    // "expectSame 红"是错的）；将来若给同格子加"按插入序"的优化，它就变成可观察量，届时
    // 只能加一个只读格子访问器来钉 —— 那得等到真需要它的任务，别为了这条注释先造旁路表。
    this.remove(entry.id);
    this.entries.set(entry.id, entry);
    for (const key of this.cellKeys(entry.aabb)) {
      const bucket = this.cells.get(key);
      if (bucket) bucket.add(entry.id);
      else this.cells.set(key, new Set([entry.id]));
    }
  }

  private remove(id: EntityId): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    for (const key of this.cellKeys(entry.aabb)) {
      const bucket = this.cells.get(key);
      if (!bucket) continue;
      bucket.delete(id);
      if (bucket.size === 0) this.cells.delete(key);
    }
  }

  private clear(): void {
    this.entries.clear();
    this.cells.clear();
  }
}
