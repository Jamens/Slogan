import { uuidv7, type EntityId } from '../ids';
import { assertMm, positiveMm, type Mm } from '../units/mm';
import type { Command } from '../model/command';
import type { Document } from '../model/document';
import type { StoreyEntity } from '../model/entity';
import { requireStorey } from '../model/read';
import { dependentsOf } from '../geom/topology';

export interface StoreyCreateInput {
  projectId: EntityId;
  index: number;
  elevationMm: Mm;
  heightMm: Mm;
}

/**
 * 竖向不重叠：楼层占用 [elevationMm, elevationMm + heightMm)。
 * 正好贴邻合法（一层的顶就是二层的地），留出空隙也合法（错层、夹层、吊顶），
 * 只有重叠是物理上不可能。负标高合法（地下室），所以符号一律不查。
 * storeyCreate 与 storeySetElevation 共用这一份：两份规则一定会漂。
 */
function assertNoVerticalOverlap(doc: Document, candidate: StoreyEntity): void {
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

export function storeyCreate(input: StoreyCreateInput): Command {
  const elevationMm = assertMm(input.elevationMm, '楼层标高');
  const heightMm = positiveMm(assertMm(input.heightMm, '层高'), '层高');
  if (!Number.isInteger(input.index) || input.index < 0) {
    throw new RangeError(`楼层序号必须为非负整数，收到 ${input.index}`);
  }
  return {
    type: 'storey.create',
    build(doc: Document) {
      const clash = doc
        .byKind('storey')
        .some((s) => s.projectId === input.projectId && s.index === input.index);
      if (clash) {
        throw new TypeError(`楼层 index 重复：project=${input.projectId} index=${input.index}`);
      }
      const storey: StoreyEntity = {
        kind: 'storey',
        id: uuidv7(),
        projectId: input.projectId,
        index: input.index,
        elevationMm,
        heightMm,
      };
      assertNoVerticalOverlap(doc, storey);
      return { upsert: [storey], remove: [] };
    },
  };
}

export function storeySetElevation(input: { storeyId: EntityId; elevationMm: number }): Command {
  const elevationMm = assertMm(input.elevationMm, '楼层标高');
  return {
    type: 'storey.setElevation',
    build(doc: Document) {
      const storey = requireStorey(doc, input.storeyId);
      // 标高只在楼层上，层内墙与点的 (x, y) 一个字都不动 —— 这也是为什么这条命令
      // 能当 M1.7 的 3D 唯一写路径：拖动整层 = 改一个整数，不碰任何构件几何。
      assertNoVerticalOverlap(doc, { ...storey, elevationMm });
      return { upsert: [{ ...storey, elevationMm }], remove: [] };
    },
  };
}

/**
 * 删一层 = 连它的全部构件一起带走。三条口径：
 *
 * ① **级联不自己数，问 `dependentsOf`。** 楼层的下游（墙 / 洞口 / 柱 / 板）已经在
 *    `geom/topology.ts` 里有一份，且那份的返回顺序写进了注释。这里再数一遍就是第二个产地，
 *    将来多一类构件（计划 4 的家具？）漂掉的必然是本函数这一遍。点不在这张表里
 *    （`dependentsOf` 的 storey 分支只列构件），所以点按 `storeyId` 单独收 —— 那也不是
 *    复述引用规则，点是**属于**这层的，不是被这层引用的。
 * ② **删完不许留悬空引用，靠闭合性检查而不是靠"上面那条规则肯定全了"。**
 *    真源不校验引用完整性（`Document` 只管整数毫米与 id 形状），所以"别层的墙指着本层的点"
 *    这种文档是可能被读盘或手搓造出来的。逐条问 `dependentsOf`：被删的每个 id，它的下游
 *    必须也在删除集里，否则抛。这条检查顺带是 ① 那份表写错时的哨兵。
 * ③ **最后一层不许删。** 零层项目在数据上没有毛病，但 `fitStorey` / `buildDrawList` 走的
 *    `aabbOfPoints([])` 是**抛**的（计划 2 立的口径），于是"删掉最后一层"会让屏幕进入一个
 *    画不出任何东西、且每次重绘都抛的状态。与其让 UI 兜，不如让真源不产这种状态。
 *    代价：删错了不能靠"删空再重建"回到起点，得先 `storeyCreate` 一层再删旧的。
 *
 * 撤销：`invertPatch` 按前像逐条重插，所以一次 Ctrl+Z 把整层（含构件与点）原样还回来 ——
 * 不需要"批事务"，因为这一条命令的补丁本来就是一整块。
 */
export function storeyDelete(input: { storeyId: EntityId }): Command {
  return {
    type: 'storey.delete',
    build(doc: Document) {
      const storey = requireStorey(doc, input.storeyId);
      const hasSibling = doc
        .byKind('storey')
        .some((s) => s.projectId === storey.projectId && s.id !== storey.id);
      if (!hasSibling) {
        throw new RangeError(
          `楼层 ${storey.id} 是项目 ${storey.projectId} 的最后一层：S1 不许出现零层项目`,
        );
      }
      const remove: EntityId[] = [storey.id];
      const removal = new Set<EntityId>([storey.id]);
      for (const id of dependentsOf(doc, storey.id)) {
        removal.add(id);
        remove.push(id);
      }
      for (const point of doc.byKind('point')) {
        if (point.storeyId !== storey.id) continue;
        removal.add(point.id);
        remove.push(point.id);
      }
      for (const id of remove) {
        for (const dependentId of dependentsOf(doc, id)) {
          if (removal.has(dependentId)) continue;
          const dependent = doc.get(dependentId);
          throw new RangeError(
            `删除楼层 ${storey.id} 会留下悬空引用：${dependentId}` +
              `（${dependent?.kind ?? '未知'}）引用着本层的东西，但它不在本层，删不掉`,
          );
        }
      }
      return { upsert: [], remove };
    },
  };
}
