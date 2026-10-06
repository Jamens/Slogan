import { Document, type Entity, type EntityId } from '@dajia/core';
import { parseDocumentPayload } from '@dajia/protocol';

/**
 * 线上快照 → 文档（**主进程侧的那一半**）。
 *
 * encode 那一半在 `document-payload.ts`：它只有类型导入，所以渲染进程可以安全引入；
 * 而本文件的 decode **值导入 `@dajia/protocol`**（要 `parseDocumentPayload` 逐实体过 zod），
 * 那是只该由主进程拖进来的依赖。两半拆开的理由写在那个文件的头注释里。
 *
 * ## 为什么不 import electron / node:fs
 *
 * 与 plan4 T7 的 P-2 同一条纪律：外部世界只从注入通道进来。这一层只做数据转换，
 * 落盘与对话框在 `ipc/export-plan.ts`，PDF 组装在 `draw/export-plan.ts`。
 * 常驻证人是 `test/unit/export-plan-ipc.test.ts` 的源码判据。
 */

/**
 * 线上快照 → 文档。**先过 zod 再建 Map**（`parseDocumentPayload` 逐个实体过 `EntitySchema`），
 * 于是"主进程收到一份坏 payload"是在边界上当场炸，不是构造出半个文档之后才炸。
 *
 * 重复 id 当场抛，与 `codec.ts` 的 `documentOf` 同一句道理：zod 的数组**不查重复**，
 * 而 `Map.set` 静默取后者 —— 那会让 `canonical()` 对着一份不存在的文档说谎。
 */
export function decodeDocumentPayload(where: string, payload: unknown): Document {
  const parsed = parseDocumentPayload(where, payload);
  const next = new Map<EntityId, Entity>();
  for (const entity of parsed.entities) {
    if (next.has(entity.id)) {
      throw new TypeError(`${where} 的 entities 里实体 ${entity.id} 出现两次：一份快照不许有重复 id`);
    }
    next.set(entity.id, entity);
  }
  return Document.replaceEntities(Document.create(parsed.projectId, parsed.schemaVersion), next);
}
