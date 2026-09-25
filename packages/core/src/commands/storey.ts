import { uuidv7, type EntityId } from '../ids';
import { assertMm, type Mm } from '../units/mm';
import type { Command } from '../model/command';
import type { Document } from '../model/document';
import type { StoreyEntity } from '../model/entity';

export interface StoreyCreateInput {
  projectId: EntityId;
  index: number;
  elevationMm: Mm;
  heightMm: Mm;
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
      return { upsert: [storey], remove: [] };
    },
  };
}
