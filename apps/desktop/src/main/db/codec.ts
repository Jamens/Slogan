import { Document, type Entity, type EntityId, type Patch } from '@dajia/core';
import {
  parseEntityShape,
  parsePatchShape,
  parseSnapshotPayload,
  type SnapshotPayloadShape,
} from '@dajia/protocol';

export type RowTable = 'element' | 'command_log' | 'snapshot';

/** 抛错文案里的坐标：哪张表、哪一行。排查时只有这两个字段能把一条 zod 报错落到一行上。 */
export interface RowRef {
  readonly table: RowTable;
  readonly id: string;
}

function where(ref: RowRef): string {
  return `${ref.table} 行 ${ref.id}`;
}

/**
 * JSON 列的回读形态由驱动决定（对象还是串），Step 1 的 A 档给主路（写进下面的注释）。
 * **两条分支都不许删**：`typeCast` 或驱动版本一变，删掉的那一条就是"今天绿、明天红"的那种红。
 * 这一条也不是"`A || B` 都算过" —— 两支喂进同一个 zod，解不出照样抛，判据在 zod 那边。
 * 实测主路（Step 1 回填，`tmp/t4-probe.log`）：`typeof` = `object`（mysql2 把 JSON 列直接回读成 JS 对象）。
 * ⇒ 对象那一支是主路；字符串那一支是"驱动升级 / `typeCast` 变更 / 别的写入者把列存成文本"的兜底。
 */
export function asJsonValue(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as unknown;
    } catch (err) {
      throw new TypeError(`${String(raw).slice(0, 40)}… 不是合法 JSON 文本：${String(err)}`);
    }
  }
  return raw;
}

/**
 * 编码 = 序列化，**不是校验**。两件事必须分开写清楚，否则会有人以为这里能挡 -0：
 * `JSON.stringify(-0)` 是 `"0"`，盘上永远不会出现 -0（`codec.test.ts` 第 10 格钉的就是这件事）。
 */
export function encodeEntity(entity: Entity): string {
  return JSON.stringify(entity);
}

/**
 * 返回类型写成 `Entity` 而**不写 `as`**：`EntityShape → Entity` 的赋值就是编译期那道牙。
 * schema 与 core 接口漂开时，红的第一个位置是这个文件（`tsc -p apps/desktop/tsconfig.test.json`），
 * `entity-shape.test.ts` 是同一件事的第二证人 —— 两个都留着，因为证人红了要能指出漂在哪一侧。
 */
export function decodeEntity(ref: RowRef, raw: unknown): Entity {
  return parseEntityShape(where(ref), asJsonValue(raw));
}

export function encodePatch(patch: Patch): string {
  return JSON.stringify(patch);
}

export function decodePatch(ref: RowRef, raw: unknown): Patch {
  return parsePatchShape(where(ref), asJsonValue(raw));
}

function byId(a: Entity, b: Entity): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 落盘形状与 `canonical()` 同一口径：实体按 id 升序。`document.ts` 里那个 `byId` 是模块私有的，
 * 为一次排序给它加导出 = 让 core 多一条只服务于磁盘的 API；这里复制两行比较符，
 * 而"两边排序一致"这条主张由 `codec.test.ts` 第 9 格守（它同时读 `encodeDocument` 的产物与形状表）。
 *
 * **键序是产物形状的一部分**：`['projectId','schemaVersion','journalTurn','entities']`，
 * T8 的委托要吃它，`codec.test.ts` 的「两份契约」那一格逐字节钉住。
 */
export function encodeDocument(doc: Document, journalTurn: number): string {
  return JSON.stringify({
    projectId: doc.projectId,
    schemaVersion: doc.schemaVersion,
    journalTurn,
    entities: [...doc.entities.values()].sort(byId),
  });
}

/** 快照正文里除了文档本身，还要说"这份正文是写到第几发的"（P-70）。 */
export interface SnapshotBody {
  readonly doc: Document;
  readonly journalTurn: number;
}

/**
 * 建 Map + 重复 id 当场抛。T4 那段循环整体搬进这里，抛错文案
 * `${where(ref)} 的 entities 里实体 ${entity.id} 出现两次：一份快照不许有重复 id`
 * **逐字保留** —— `codec.test.ts` 那两格吃它的正则，一字不改地继续成立。
 * （T8 会把它改成 `documentFromPayload(payload, where)`，同一循环、参数顺序不同。）
 */
function documentOf(ref: RowRef, payload: SnapshotPayloadShape): Document {
  const next = new Map<EntityId, Entity>();
  for (const entity of payload.entities) {
    if (next.has(entity.id)) {
      // zod 与 Map.set 都不管数组里的重复：同一份快照存着同一 id 的两个真值，
      // 静默取后者会让 canonical() 说谎 —— 这一型必须在读盘当场炸。
      throw new TypeError(
        `${where(ref)} 的 entities 里实体 ${entity.id} 出现两次：一份快照不许有重复 id`,
      );
    }
    next.set(entity.id, entity);
  }
  return Document.replaceEntities(Document.create(payload.projectId, payload.schemaVersion), next);
}

/**
 * 读快照：验的是**盘上契约**（四键），缺 `journalTurn` 当场抛而不是当它是 null。
 * 这一格就是"有人把 `encodeDocument` 里 `journalTurn,` 那一行删掉"的牙（T7-M25 的靶）。
 */
export function decodeSnapshot(ref: RowRef, raw: unknown): SnapshotBody {
  const payload = parseSnapshotPayload(where(ref), asJsonValue(raw));
  return { doc: documentOf(ref, payload), journalTurn: payload.journalTurn };
}

/** 只要正文的调用方（`repository.ts` 的重放循环之外都算）用它；快照读侧用 `decodeSnapshot`。 */
export function decodeDocument(ref: RowRef, raw: unknown): Document {
  return decodeSnapshot(ref, raw).doc;
}
