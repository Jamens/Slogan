import { z } from 'zod';

/**
 * 与 core `model/command.ts` 的 `CommandType` 并排的另一半（同一族"两份文本 + 测试钉死"，
 * 理由见 entity-schema.ts 顶部）。落库的 `command_log.type` 只认这 16 条。
 */
export const COMMAND_TYPES = [
  'storey.create',
  'storey.setElevation',
  'storey.delete',
  'wall.create',
  'wall.moveEndpoint',
  'wall.setThickness',
  'wall.setMaterial',
  'wall.setLoadBearing',
  'wall.delete',
  'opening.create',
  'opening.move',
  'opening.delete',
  'column.create',
  'column.delete',
  'slab.create',
  'slab.delete',
] as const;

export const CommandTypeSchema = z.enum(COMMAND_TYPES);
