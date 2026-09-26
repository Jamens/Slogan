import type { EntityId } from '../ids';
import { assertMm } from '../units/mm';
import type { Document } from '../model/document';
import type { OpeningEntity, WallEntity } from '../model/entity';
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

export interface SpatialIndexOptions {
  readonly cellSizeMm?: number;
}

const DEFAULT_CELL_SIZE_MM = 4000;

function assertCellSize(value: number): number {
  // 网格边长也走 assertMm：整数毫米，免得浮点渗进 cell key（key 一变，插进去的盒子就找不回来了）
  const mm = assertMm(value, '网格边长');
  if (mm <= 0) throw new RangeError(`网格边长必须为正，收到 ${mm}`);
  return mm;
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
 * 接头表仍然一次派生整层 —— 斜切量是全局性质（Task 4），一面墙的两端各被别的墙牵着，
 * 没有"只重算这一段"的合法做法。
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

  /** 按 id 升序的条目快照：测试用它比对局部重建与整层重建，计划 3 用它做调试面板。 */
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
   * 双向闭包：真源反向依赖（expandAffected）∪ 盒子的共享端点（entry.dependsOn）。
   * 少了后半段，"删一面墙"与"改一面墙的墙厚"两条都会留下发霉的邻墙盒子。
   */
  private dirtyIds(doc: Document, affected: ReadonlySet<EntityId>): Set<EntityId> {
    const dirty = new Set<EntityId>();
    const queue: EntityId[] = [...affected];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (dirty.has(id)) continue;
      dirty.add(id);
      // 已删除的实体在 doc 里查不到，但它在本索引里的记录还在 —— 它依赖的那些 id 必须入队
      const entry = this.entries.get(id);
      if (entry) for (const dep of entry.dependsOn) queue.push(dep);
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
      dependsOn: [wall.startId, wall.endId],
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
      dependsOn: [wall.id, wall.startId, wall.endId],
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
