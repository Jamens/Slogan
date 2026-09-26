import type { Document } from './document';
import type { Patch } from './patch';

/** spec 5.5 的 S1 命令全集 + storey.setElevation（spec 第 7 节 M1.7 的 3D 唯一写路径）。 */
export type CommandType =
  | 'storey.create'
  | 'storey.setElevation'
  | 'wall.create'
  | 'wall.moveEndpoint'
  | 'wall.setThickness'
  | 'wall.delete'
  | 'opening.create'
  | 'opening.move'
  | 'opening.delete'
  | 'column.create'
  | 'slab.create';

export interface Command {
  readonly type: CommandType;
  /** 纯函数：只读 doc，产出 Patch，绝不改 doc。 */
  build(doc: Document): Patch;
}
