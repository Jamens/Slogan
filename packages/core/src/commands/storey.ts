import { uuidv7, type EntityId } from '../ids';
import { assertMm, type Mm } from '../units/mm';
import type { Command } from '../model/command';
import type { Document } from '../model/document';
import type { StoreyEntity } from '../model/entity';
import { requireStorey } from '../model/read';

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
  const heightMm = assertMm(input.heightMm, '层高');
  if (heightMm <= 0) throw new RangeError(`层高必须为正，收到 ${heightMm}`);
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
