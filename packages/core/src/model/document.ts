import { isEntityId, type EntityId } from '../ids';
import type { Entity, EntityKind, EntityOf } from './entity';
import { stableStringify } from './stable-stringify';

export const SCHEMA_VERSION = 1;

/**
 * 每种实体必须为整数毫米的字段。含点的 x/y：spec D8 写的是"坐标与长度一律整数毫米"，
 * 只校验 *Mm 后缀会把浮点坐标留在真源里。
 */
const INTEGER_FIELDS: Record<EntityKind, readonly string[]> = {
  point: ['x', 'y'],
  wall: ['thicknessMm', 'heightMm', 'elevationOffsetMm'],
  opening: ['distanceMm', 'widthMm', 'heightMm', 'sillMm'],
  storey: ['elevationMm', 'heightMm'],
  column: ['widthMm', 'depthMm', 'heightMm'],
  slab: ['thicknessMm', 'elevationOffsetMm'],
};

function byId(a: Entity, b: Entity): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function validate(entity: Entity): void {
  if (!isEntityId(entity.id)) {
    throw new TypeError(`实体 id 必须是 UUIDv7，收到 ${JSON.stringify(entity.id)}`);
  }
  for (const field of INTEGER_FIELDS[entity.kind]) {
    const value = (entity as unknown as Record<string, unknown>)[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new TypeError(`${entity.kind}.${field} 必须是整数毫米，收到 ${JSON.stringify(value)}`);
    }
  }
}

/** 不可变文档。改它只有一条路：Document.replaceEntities 造新实例。 */
export class Document {
  private constructor(
    readonly projectId: EntityId,
    readonly schemaVersion: number,
    readonly entities: ReadonlyMap<EntityId, Entity>,
  ) {}

  static create(projectId: EntityId, schemaVersion: number = SCHEMA_VERSION): Document {
    if (!isEntityId(projectId)) throw new TypeError('projectId 必须是 UUIDv7');
    return new Document(projectId, schemaVersion, new Map());
  }

  static replaceEntities(doc: Document, entities: ReadonlyMap<EntityId, Entity>): Document {
    const next = new Map<EntityId, Entity>();
    for (const [id, entity] of entities) {
      validate(entity);
      if (entity.id !== id) {
        throw new TypeError(`Map 的 key 与实体 id 不一致：${id} vs ${entity.id}`);
      }
      next.set(id, entity);
    }
    return new Document(doc.projectId, doc.schemaVersion, next);
  }

  get(id: EntityId): Entity | undefined {
    return this.entities.get(id);
  }

  byKind<K extends EntityKind>(kind: K): EntityOf<K>[] {
    const out: EntityOf<K>[] = [];
    for (const entity of this.entities.values()) {
      if (entity.kind === kind) out.push(entity as EntityOf<K>);
    }
    return out.sort(byId);
  }

  /** 确定性序列化：实体按 id 升序 + 键递归排序。equals 与属性测试都靠它。 */
  canonical(): string {
    return stableStringify({
      projectId: this.projectId,
      schemaVersion: this.schemaVersion,
      entities: [...this.entities.values()].sort(byId),
    });
  }

  equals(other: Document): boolean {
    return this.canonical() === other.canonical();
  }
}
