import type { Document, Entity } from '@dajia/core';
import type { DocumentPayloadShape } from '@dajia/protocol';

/**
 * 文档 → 线上快照（**renderer 侧要用的那一半**）。
 *
 * ## 为什么 encode 与 decode 分住两个文件
 *
 * `document-wire.ts` 的 decode 那一半**值导入** `@dajia/protocol`（要 `parseDocumentPayload`
 * 逐实体过 zod）。渲染进程若从同一个文件取 encode，bundler 会把 zod 一起拖进浏览器包 ——
 * 而 renderer 段根本没 alias `@dajia/protocol`（`electron.vite.config.ts` 只 alias 了
 * core 与 scene-2d），那是"渲染包引入了主进程依赖"被 bundler 悄悄放行的那一型。
 * 拆开之后本文件**只有类型导入**，运行时不依赖任何包。
 *
 * ## 线上契约是三键（没有 `journalTurn`）
 *
 * `DocumentPayloadSchema` 的注释已写明：线上用 `DocumentPayloadSchema`，
 * `SnapshotPayloadSchema`（四键）只服务 `snapshot` 表 —— **renderer 没有合法的 turn
 * 可填**（P-18）。导出这份快照是"把眼下这份文档递出去"，不是 journal 的一发。
 *
 * ## 实体排序按 id 升序（不是插入序）
 *
 * 与 `codec.ts` 的 `encodeDocument` 同一口径，理由也同一条：落盘/上线字节可复现
 * （plan5 T8 E2/E4）。比较符**刻意复制**而非给 core 加导出 —— 为一次排序给真核加一条
 * 只服务于 I/O 的 API 不划算；"两边排序一致"由 `export-plan-ipc.test.ts` 钉。
 */
function byId(a: Entity, b: Entity): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 文档 → 线上快照。键序与 `DocumentPayloadSchema` 的声明顺序一致，让产物的形状一眼可对账。
 *
 * **纯读**：不重算任何几何，也不动真源 —— 视图侧递出去的是"此刻这份文档"的一份快照。
 */
export function encodeDocumentPayload(doc: Document): DocumentPayloadShape {
  return {
    projectId: doc.projectId,
    schemaVersion: doc.schemaVersion,
    entities: [...doc.entities.values()].sort(byId),
  };
}
