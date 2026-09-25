import { uuidv7, type EntityId } from '../ids';
import { assertMm, quantizeMm, type Mm } from '../units/mm';
import type { Command } from '../model/command';
import type { Document } from '../model/document';
import type { Entity, OpeningEntity, PointEntity, WallEntity } from '../model/entity';

export interface WallCreateInput {
  storeyId: EntityId;
  start: { x: number; y: number };
  end: { x: number; y: number };
  thicknessMm: Mm;
  heightMm: Mm;
  elevationOffsetMm?: Mm;
  loadBearing?: boolean;
  material?: string;
}

function mustExist(doc: Document, id: EntityId, label: string): Entity {
  const entity = doc.get(id);
  if (!entity) throw new TypeError(`${label} 不存在：${id}`);
  return entity;
}

function requireWall(doc: Document, wallId: EntityId): WallEntity {
  const entity = mustExist(doc, wallId, '墙');
  if (entity.kind !== 'wall') throw new TypeError(`${wallId} 不是墙，是 ${entity.kind}`);
  return entity;
}

function requirePoint(doc: Document, id: EntityId, label: string): PointEntity {
  const entity = mustExist(doc, id, label);
  if (entity.kind !== 'point') throw new TypeError(`${label} 不是 point 实体：${id}`);
  return entity;
}

function axisLengthMm(doc: Document, wall: WallEntity): number {
  const a = requirePoint(doc, wall.startId, '墙起点');
  const b = requirePoint(doc, wall.endId, '墙终点');
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** 共享端点与接头吸附属计划 2，这里总是新建两个端点。 */
export function wallCreate(input: WallCreateInput): Command {
  const thicknessMm = assertMm(input.thicknessMm, '墙厚');
  const heightMm = assertMm(input.heightMm, '墙高');
  const elevationOffsetMm = assertMm(input.elevationOffsetMm ?? 0, '标高偏移');
  const x0 = quantizeMm(input.start.x);
  const y0 = quantizeMm(input.start.y);
  const x1 = quantizeMm(input.end.x);
  const y1 = quantizeMm(input.end.y);
  if (x0 === x1 && y0 === y1) {
    throw new RangeError(`零长墙：两端点量化后同为 (${x0}, ${y0})`);
  }
  const lengthMm = Math.hypot(x1 - x0, y1 - y0);
  if (thicknessMm >= lengthMm) {
    throw new RangeError(
      `墙厚 ${thicknessMm} 不小于墙长 ${Math.round(lengthMm)}，轮廓会自相交`,
    );
  }
  return {
    type: 'wall.create',
    build(doc: Document) {
      mustExist(doc, input.storeyId, '楼层');
      const start: PointEntity = {
        kind: 'point',
        id: uuidv7(),
        storeyId: input.storeyId,
        x: x0,
        y: y0,
      };
      const end: PointEntity = {
        kind: 'point',
        id: uuidv7(),
        storeyId: input.storeyId,
        x: x1,
        y: y1,
      };
      const wall: WallEntity = {
        kind: 'wall',
        id: uuidv7(),
        storeyId: input.storeyId,
        startId: start.id,
        endId: end.id,
        thicknessMm,
        heightMm,
        elevationOffsetMm,
        loadBearing: input.loadBearing ?? true,
        material: input.material ?? 'brick',
      };
      return { upsert: [start, end, wall], remove: [] };
    },
  };
}

export function wallSetThickness(input: { wallId: EntityId; thicknessMm: Mm }): Command {
  const thicknessMm = assertMm(input.thicknessMm, '墙厚');
  return {
    type: 'wall.setThickness',
    build(doc: Document) {
      const wall = requireWall(doc, input.wallId);
      if (thicknessMm <= 0) throw new RangeError(`墙厚必须为正，收到 ${thicknessMm}`);
      if (thicknessMm >= axisLengthMm(doc, wall)) {
        throw new RangeError(`墙厚 ${thicknessMm} 不小于墙长，轮廓会自相交`);
      }
      return { upsert: [{ ...wall, thicknessMm }], remove: [] };
    },
  };
}

export function wallMoveEndpoint(input: {
  wallId: EntityId;
  end: 'start' | 'end';
  x: number;
  y: number;
}): Command {
  const x = quantizeMm(input.x);
  const y = quantizeMm(input.y);
  return {
    type: 'wall.moveEndpoint',
    build(doc: Document) {
      const wall = requireWall(doc, input.wallId);
      const moving = requirePoint(
        doc,
        input.end === 'start' ? wall.startId : wall.endId,
        '端点',
      );
      const anchor = requirePoint(
        doc,
        input.end === 'start' ? wall.endId : wall.startId,
        '另一端点',
      );
      if (anchor.x === x && anchor.y === y) {
        throw new RangeError(`零长墙：端点移到与另一端 (${x}, ${y}) 重合`);
      }
      return { upsert: [{ ...moving, x, y }], remove: [] };
    },
  };
}

export function wallDelete(input: { wallId: EntityId }): Command {
  return {
    type: 'wall.delete',
    build(doc: Document) {
      const wall = requireWall(doc, input.wallId);
      const remove: EntityId[] = [wall.id];
      const openings: readonly OpeningEntity[] = doc.byKind('opening');
      for (const opening of openings) {
        if (opening.hostWallId === wall.id) remove.push(opening.id);
      }
      for (const pointId of [wall.startId, wall.endId]) {
        if (!stillReferenced(doc, pointId, wall.id)) remove.push(pointId);
      }
      return { upsert: [], remove };
    },
  };
}

/** 除被删的这面墙之外，还有谁指着这个点。柱与板也要查，否则孤儿判定会误删。 */
function stillReferenced(doc: Document, pointId: EntityId, excludeWallId: EntityId): boolean {
  for (const w of doc.byKind('wall')) {
    if (w.id === excludeWallId) continue;
    if (w.startId === pointId || w.endId === pointId) return true;
  }
  for (const c of doc.byKind('column')) {
    if (c.pointId === pointId) return true;
  }
  for (const s of doc.byKind('slab')) {
    if (s.boundaryPointIds.includes(pointId)) return true;
  }
  return false;
}
