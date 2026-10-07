import type { Document, Entity, Patch } from '@dajia/core';
import { parseEntityShape, parsePatchShape, parseSnapshotPayload } from '@dajia/protocol';
import { documentFromPayload, snapshotPayloadFromDocument } from '../../shared/document-wire';

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

/**
 * 落盘形状与线上形状同一个产地（`src/shared/document-wire.ts`，裁决 P-19 + P-70）：这里只补"变成字符串"这一步。
 * 这条委托有三个证人：`codec.test.ts` 第 9 格（`encodeDocument` 的产物与 T4 形状表逐字节比，**原样留着**）、
 * 它的「两份契约」那一格（四键的**键序**，`encodeDocument(doc, 42)` 的产物字节），
 * 与 `document-wire.test.ts` 第 4 格（逐字节等于 `JSON.stringify(snapshotPayloadFromDocument(doc, turn))`）。
 */
export function encodeDocument(doc: Document, journalTurn: number): string {
  return JSON.stringify(snapshotPayloadFromDocument(doc, journalTurn));
}

/** 快照正文里除了文档本身，还要说"这份正文是写到第几发的"（P-70）。 */
export interface SnapshotBody {
  readonly doc: Document;
  readonly journalTurn: number;
}

/** 解码 + 把列上那个 turn 一起交出去：第四条判据（`loadProject`）吃的是这里的 `journalTurn`。 */
export function decodeSnapshot(ref: RowRef, raw: unknown): SnapshotBody {
  const at = where(ref);
  const payload = parseSnapshotPayload(at, asJsonValue(raw));
  return { doc: documentFromPayload(payload, at), journalTurn: payload.journalTurn };
}

/** 只解码、不验不变式：引用与几何的放行证在 T5 的 `loadProject`（那里才知道一共读了几层）。 */
export function decodeDocument(ref: RowRef, raw: unknown): Document {
  return decodeSnapshot(ref, raw).doc;
}
