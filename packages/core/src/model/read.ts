import type { EntityId } from '../ids';
import type { Document } from './document';
import type { Entity, PointEntity, StoreyEntity, WallEntity } from './entity';

export function mustExist(doc: Document, id: EntityId, label: string): Entity {
  const entity = doc.get(id);
  if (!entity) throw new TypeError(`${label} 不存在：${id}`);
  return entity;
}

export function requireWall(doc: Document, wallId: EntityId): WallEntity {
  const entity = mustExist(doc, wallId, '墙');
  if (entity.kind !== 'wall') throw new TypeError(`${wallId} 不是墙，是 ${entity.kind}`);
  return entity;
}

export function requirePoint(doc: Document, id: EntityId, label: string): PointEntity {
  const entity = mustExist(doc, id, label);
  if (entity.kind !== 'point') throw new TypeError(`${label} 不是 point 实体：${id}`);
  return entity;
}

export function requireStorey(doc: Document, storeyId: EntityId): StoreyEntity {
  const entity = mustExist(doc, storeyId, '楼层');
  if (entity.kind !== 'storey') throw new TypeError(`${storeyId} 不是楼层，是 ${entity.kind}`);
  return entity;
}
