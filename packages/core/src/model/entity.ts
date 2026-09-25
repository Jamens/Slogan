import type { Mm } from '../units/mm';
import type { EntityId } from '../ids';

export type EntityKind = 'point' | 'wall' | 'opening' | 'storey' | 'column' | 'slab';

export interface PointEntity {
  kind: 'point';
  id: EntityId;
  storeyId: EntityId;
  x: Mm;
  y: Mm;
}

/** 真源是轴线两端点 + 厚度；轮廓与接头一律派生（spec 5.2）。 */
export interface WallEntity {
  kind: 'wall';
  id: EntityId;
  storeyId: EntityId;
  startId: EntityId;
  endId: EntityId;
  thicknessMm: Mm;
  heightMm: Mm;
  elevationOffsetMm: Mm;
  loadBearing: boolean;
  material: string;
}

export interface OpeningEntity {
  kind: 'opening';
  id: EntityId;
  storeyId: EntityId;
  hostWallId: EntityId;
  /** 沿宿主墙起点到洞口近端的距离 */
  distanceMm: Mm;
  widthMm: Mm;
  heightMm: Mm;
  /** 洞底距本层楼面的高度，门恒为 0 */
  sillMm: Mm;
  category: 'door' | 'window';
}

export interface StoreyEntity {
  kind: 'storey';
  id: EntityId;
  projectId: EntityId;
  index: number;
  elevationMm: Mm;
  heightMm: Mm;
}

/** S1 有类型、有命令、无编辑器 UI（spec 5.5 第二档）。 */
export interface ColumnEntity {
  kind: 'column';
  id: EntityId;
  storeyId: EntityId;
  pointId: EntityId;
  widthMm: Mm;
  depthMm: Mm;
  heightMm: Mm;
  loadBearing: boolean;
  material: string;
}

export interface SlabEntity {
  kind: 'slab';
  id: EntityId;
  storeyId: EntityId;
  boundaryPointIds: EntityId[];
  thicknessMm: Mm;
  elevationOffsetMm: Mm;
}

export type Entity =
  | PointEntity
  | WallEntity
  | OpeningEntity
  | StoreyEntity
  | ColumnEntity
  | SlabEntity;

export type EntityOf<K extends EntityKind> = Extract<Entity, { kind: K }>;
