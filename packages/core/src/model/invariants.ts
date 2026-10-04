import type { EntityId } from '../ids';
import { assertSimpleRing } from '../geom/ring';
import { vec, type Vec2 } from '../geom/vec';
import { deriveStoreyGeometry } from '../geom/outline';
import { INTEGER_FIELDS, type Document } from './document';
import type { Entity, StoreyEntity } from './entity';
import { requirePoint, requireStorey, requireWall } from './read';

/**
 * 楼层竖向重叠：**这份是唯一的产地**。`commands/storey.ts` 的 create / setElevation 与
 * 读盘检查器共用它 —— 计划 2 交下来的原话是"两份规则一定会漂"。
 * 报错文案逐字保留（`commands/storey.ts` 的现有用例吃它），搬动时一个字符都不许改。
 *
 * 竖向不重叠：楼层占用 [elevationMm, elevationMm + heightMm)。
 * 正好贴邻合法（一层的顶就是二层的地），留出空隙也合法（错层、夹层、吊顶），
 * 只有重叠是物理上不可能。负标高合法（地下室），所以符号一律不查。
 * storeyCreate 与 storeySetElevation 共用这一份：两份规则一定会漂。
 */
export function assertNoVerticalOverlap(doc: Document, candidate: StoreyEntity): void {
  const top = candidate.elevationMm + candidate.heightMm;
  for (const other of doc.byKind('storey')) {
    if (other.id === candidate.id || other.projectId !== candidate.projectId) continue;
    const otherTop = other.elevationMm + other.heightMm;
    const from = Math.max(candidate.elevationMm, other.elevationMm);
    const to = Math.min(top, otherTop);
    if (from < to) {
      throw new RangeError(
        `楼层标高重叠：${candidate.id} 占 ${candidate.elevationMm}–${top}，` +
          `与楼层 ${other.id} 的 ${other.elevationMm}–${otherTop} 相交（区间按半开算，贴邻合法）`,
      );
    }
  }
}

function tag(entity: Entity): string {
  return `${entity.kind} ${entity.id}`;
}

/** 取整数毫米字段：`INTEGER_FIELDS` 是唯一表产地（document.ts），这里只读不另立名单。 */
function mm(entity: Entity, field: string): number {
  return (entity as unknown as Record<string, unknown>)[field] as number;
}

function assertNoNegativeZero(entity: Entity): void {
  for (const field of INTEGER_FIELDS[entity.kind]) {
    if (Object.is(mm(entity, field), -0)) {
      throw new TypeError(`${tag(entity)}.${field} 不接受 -0：真源里的零不许带符号`);
    }
  }
}

function assertAtLeastOne(entity: Entity, fields: readonly string[]): void {
  for (const field of fields) {
    const v = mm(entity, field);
    if (v < 1) throw new RangeError(`${tag(entity)}.${field} 必须 ≥ 1mm，收到 ${String(v)}`);
  }
}

/**
 * 引用完整性 + 同层 + 下界 + 门规 + 竖向不重叠 + `-0`：读盘侧的放行证。
 * **零层文档合法**（刚 createProject 还没画层），所以本函数不许要求"至少一层"——
 * 命令层那条"最后一层不许删"是 `storeyDelete` 的规则，不是数据规则，别在这里复制。
 * 几何退化（零长墙、墙厚不小于墙长、洞口超宿主、接头不闭合）不在这里重算：
 * 最后那一遍逐层 `deriveStoreyGeometry` 就是复用派生层那份唯一产地。
 */
export function assertTruthSourceInvariants(doc: Document): void {
  const seenIndex = new Set<string>();
  for (const storey of doc.byKind('storey')) {
    if (storey.projectId !== doc.projectId) {
      throw new TypeError(`楼层 ${storey.id} 的 projectId ${storey.projectId} 与文档 ${doc.projectId} 不一致：归属别的项目的数据不许混进来`);
    }
    if (!Number.isSafeInteger(storey.index) || storey.index < 0) {
      throw new RangeError(`楼层 ${storey.id} 的 index 必须为非负整数，收到 ${String(storey.index)}`);
    }
    const key = `${storey.projectId}:${storey.index}`;
    if (seenIndex.has(key)) throw new RangeError(`楼层 index 重复：${key}`);
    seenIndex.add(key);
    assertNoNegativeZero(storey);
    assertAtLeastOne(storey, ['heightMm']);
    assertNoVerticalOverlap(doc, storey);
  }

  for (const point of doc.byKind('point')) {
    assertNoNegativeZero(point);
    requireStorey(doc, point.storeyId); // 不存在即抛，消息带 id
  }

  for (const wall of doc.byKind('wall')) {
    assertNoNegativeZero(wall);
    assertAtLeastOne(wall, ['thicknessMm', 'heightMm']);
    const owner = requireStorey(doc, wall.storeyId);
    const start = requirePoint(doc, wall.startId, '墙起点');
    const end = requirePoint(doc, wall.endId, '墙终点');
    for (const p of [start, end]) {
      if (p.storeyId !== wall.storeyId) {
        throw new TypeError(
          `墙 ${wall.id} 属于楼层 ${owner.id}，端点 ${p.id} 属于楼层 ${p.storeyId}：跨层的端点会让两层墙网凭空焊死，同层判据不许放宽`,
        );
      }
    }
    if (start.x === end.x && start.y === end.y) {
      throw new RangeError(`零长墙：${wall.id} 两端点同为 (${start.x}, ${start.y})`);
    }
  }

  for (const opening of doc.byKind('opening')) {
    assertNoNegativeZero(opening);
    assertAtLeastOne(opening, ['widthMm', 'heightMm']);
    requireStorey(doc, opening.storeyId);
    const host = requireWall(doc, opening.hostWallId);
    if (host.storeyId !== opening.storeyId) {
      throw new TypeError(`洞口 ${opening.id} 在楼层 ${opening.storeyId}，宿主墙 ${host.id} 在楼层 ${host.storeyId}：洞口与宿主必须同层`);
    }
    if (mm(opening, 'distanceMm') < 0) throw new RangeError(`洞口 ${opening.id} 的 distanceMm 不能为负`);
    if (mm(opening, 'sillMm') < 0) throw new RangeError(`洞口 ${opening.id} 的 sillMm 不能为负`);
    if (opening.category === 'door' && mm(opening, 'sillMm') !== 0) {
      throw new RangeError(`门 ${opening.id} 的 sillMm 必须为 0，收到 ${String(mm(opening, 'sillMm'))}`);
    }
  }

  for (const column of doc.byKind('column')) {
    assertNoNegativeZero(column);
    assertAtLeastOne(column, ['widthMm', 'depthMm', 'heightMm']);
    requireStorey(doc, column.storeyId);
    const at = requirePoint(doc, column.pointId, '柱落点');
    if (at.storeyId !== column.storeyId) {
      throw new TypeError(`柱 ${column.id} 在楼层 ${column.storeyId}，落点 ${at.id} 在楼层 ${at.storeyId}：必须同层`);
    }
  }

  for (const slab of doc.byKind('slab')) {
    assertNoNegativeZero(slab);
    assertAtLeastOne(slab, ['thicknessMm']);
    requireStorey(doc, slab.storeyId);
    const ring: Vec2[] = slab.boundaryPointIds.map((id: EntityId) => {
      const p = requirePoint(doc, id, '楼板顶点');
      if (p.storeyId !== slab.storeyId) {
        throw new TypeError(`楼板 ${slab.id} 的顶点 ${id} 属于楼层 ${p.storeyId}：必须同层`);
      }
      return vec(p.x, p.y);
    });
    assertSimpleRing(`楼板 ${slab.id}`, ring); // 共线 / 自交 / 顶点数退化的唯一产地
  }

  // 最后一道：把派生层跑一遍。这一遍不是"顺手也算一次几何"，是**复用**已有的那套退化判据
  // （墙厚不小于墙长、洞口超出宿主、接头闭合），invariants 里一条都不重算。
  for (const storey of doc.byKind('storey')) {
    deriveStoreyGeometry(doc, storey.id);
  }
}
