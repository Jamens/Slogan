import type { EntityId } from '../ids';
import type { Document } from '../model/document';
import type { WallEntity } from '../model/entity';

/** 洞口在宿主墙轴线上占的区间：沿轴浮点毫米，自 start 端起算。 */
export interface OpeningSpan {
  readonly openingId: EntityId;
  readonly fromMm: number;
  readonly toMm: number;
}

/** 被打断后剩下的一段实体墙（墙垛、窗下墙…），同样是沿轴区间。 */
export interface WallPiece {
  readonly wallId: EntityId;
  readonly fromMm: number;
  readonly toMm: number;
}

/**
 * 洞口 → 沿轴区间，按 fromMm 升序（同距离按 id 升序，保证确定性）。
 * 楼层一致性在这里查：真源只管 id 与整数毫米，不管引用完整性，
 * 而"洞口挂在别层的墙上"会让几何凭空出现在错误的标高上。
 */
export function openingSpans(doc: Document, wall: WallEntity): OpeningSpan[] {
  const out: OpeningSpan[] = [];
  for (const opening of doc.byKind('opening')) {
    if (opening.hostWallId !== wall.id) continue;
    if (opening.storeyId !== wall.storeyId) {
      throw new TypeError(
        `洞口 ${opening.id} 属于楼层 ${opening.storeyId}，宿主墙 ${wall.id} 属于楼层 ` +
          `${wall.storeyId}：两者必须同层`,
      );
    }
    out.push({
      openingId: opening.id,
      fromMm: opening.distanceMm,
      toMm: opening.distanceMm + opening.widthMm,
    });
  }
  // doc.byKind 给的是 id 升序，不是沿轴位置升序：不排就等于把文档的 id 序当成几何序，
  // 于是分段结果随 uuidv7 的随机位抖动，尾段与墙垛的顺序在两次运行里能不一样。
  return out.sort(
    (a, b) =>
      a.fromMm - b.fromMm ||
      (a.openingId < b.openingId ? -1 : a.openingId > b.openingId ? 1 : 0),
  );
}

/**
 * 越界与重叠的**唯一**判据：本文件的 piecesFromSpans 内建调用它，Task 7 的
 * openingCreate / openingMove 写盘前也调用它。派生与写入共用一份规则，不会漂。
 * 入参必须已按 fromMm 升序（openingSpans 保证；调用方自己拼表时要先排）。
 */
export function assertSpansFit(
  wallId: EntityId,
  lengthMm: number,
  spans: readonly OpeningSpan[],
): void {
  for (const span of spans) {
    if (span.fromMm < 0 || span.toMm > lengthMm) {
      throw new RangeError(
        `洞口 ${span.openingId} 超出宿主墙 ${wallId}：墙沿轴长 ${lengthMm.toFixed(1)}，` +
          `洞口占 ${span.fromMm}–${span.toMm}`,
      );
    }
  }
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1]!;
    const cur = spans[i]!;
    if (prev.fromMm > cur.fromMm) {
      // 升序是相邻比较的前提：表乱了，"只比邻项"就会漏掉真正的重叠，所以这是内部错误而不是病态输入
      throw new RangeError(`assertSpansFit 需要按 fromMm 升序的洞口表（内部错误）`);
    }
    // <= 而不是 <：贴边（0 墙垛）在施工上就是一樘，且会退化出零长的"段"。
    if (cur.fromMm <= prev.toMm) {
      throw new RangeError(
        `洞口 ${prev.openingId} 与 ${cur.openingId} 在墙 ${wallId} 上重叠或贴边：` +
          `${prev.toMm} ≥ ${cur.fromMm}，中间必须留出墙垛`,
      );
    }
  }
}

/** 沿轴切成一段段实体材料。零长段（洞口压在墙端）跳过，不产空壳。 */
export function piecesFromSpans(
  wallId: EntityId,
  lengthMm: number,
  spans: readonly OpeningSpan[],
): WallPiece[] {
  assertSpansFit(wallId, lengthMm, spans);
  const pieces: WallPiece[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.fromMm > cursor) pieces.push({ wallId, fromMm: cursor, toMm: span.fromMm });
    cursor = span.toMm;
  }
  // 与上面成对：末段同样是"可能零长"的那一端，恰好收到墙尾时不产 [3600,3600] 空壳
  if (cursor < lengthMm) pieces.push({ wallId, fromMm: cursor, toMm: lengthMm });
  return pieces;
}
