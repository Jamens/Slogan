import { Document, type Entity, type EntityId } from '@dajia/core';
import { parseDocumentPayload } from '@dajia/protocol';
import type { DocumentPayloadShape, SnapshotPayloadShape } from '@dajia/protocol';

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
 * 与 `core/model/document.ts`、`main/db/reconcile.ts` 里那两个同名的模块私有比较符各写一份。
 * 三处都要"按 id 升序"，但它们住在三个互不许 import 的域里（core 不认识磁盘，main 不许被 shared
 * 认识 —— renderer 的 bundle 会顺着那条边把 mysql2 拖进屏幕）。给任何一方开导出都是一条新边。
 *
 * 排序**只影响线上与盘上的字节顺序，不影响语义**：`documentFromPayload` 建的是 `Map`，
 * `canonical()` 自己会再排一次。所以这一份的读者是"字节稳定"（抢救件可比、快照可 diff），不是正确性。
 */
function byId(a: { id: EntityId }, b: { id: EntityId }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 唯一的"文档 → 边界形状"出口**有两条**，共用这一个排序产地（P-70）：
 * 线上三键（`payloadFromDocument`，renderer ↔ main）与盘上四键（`snapshotPayloadFromDocument`，快照正文）。
 * 键序与 entities 的升序**只有一个产地** —— `codec.test.ts` 里「两份契约」那一格吃的是字节序，
 * T7 的 codec 字面量与这里的两个出口必须同一个序；两处各写一份的话，谁改谁红在另一处。
 */
function sortedEntities(doc: Document): Entity[] {
  return [...doc.entities.values()].sort(byId);
}

/**
 * 线上形状（三键）。**不许加 `journalTurn`**：P-18 定了 turn 由主进程分配，发送方没有合法的数可填
 * （T7 的 Step 6b 把这条写进了 `DocumentPayloadSchema` 的注释，这里是它的代码侧）。
 * 编码 = 序列化，**不是校验**：`JSON.stringify(-0)` 是 `"0"`，
 * 挡 -0/浮点/多余字段是读取侧 zod 的活（T4 ② 段同一条口径，别在这里加第二道）。
 */
export function payloadFromDocument(doc: Document): DocumentPayloadShape {
  return {
    projectId: doc.projectId,
    schemaVersion: doc.schemaVersion,
    entities: sortedEntities(doc),
  };
}

/**
 * 盘上形状（四键，P-70）：`journalTurn` 与 `entities` 由**同一个调用**给出，
 * 这正是"列与正文同源自构造"的产地（`repository.writeSnapshot(turn, doc)` 里那一个 `t`）。
 * 这里不校验 turn：编码不是校验（同一口径），必填与 `>=1` 由 `SnapshotPayloadSchema` 在读取侧拦。
 */
export function snapshotPayloadFromDocument(
  doc: Document,
  journalTurn: number,
): SnapshotPayloadShape {
  return {
    projectId: doc.projectId,
    schemaVersion: doc.schemaVersion,
    journalTurn,
    entities: sortedEntities(doc),
  };
}

/**
 * 唯一的"边界形状 → 文档"出口，main 与 renderer 共用这一份。
 * `where` 由调用方给（`snapshot 行 3` / `IPC dajia:journal:submit`），抛错文案的前缀归调用方的坐标 ——
 * 与 T4 的 `codec.ts` 完全一致，所以 `codec.test.ts` 那两格正则一字不动地继续成立。
 *
 * 参数只声明三键（`DocumentPayloadShape`），因此**两种形状都收**：盘上那份四键是它的结构超集，
 * 多出来的 `journalTurn` 由调用方自己比对（`decodeSnapshot` 的第四条判据），这里一个字段都不读。
 */
export function documentFromPayload(payload: DocumentPayloadShape, where: string): Document {
  const next = new Map<EntityId, Entity>();
  for (const entity of payload.entities) {
    if (next.has(entity.id)) {
      // zod 与 Map.set 都不管数组里的重复：同一份快照存着同一 id 的两个真值，
      // 静默取后者会让 canonical() 说谎 —— 这一型必须在过界/读盘当场炸。
      throw new TypeError(
        `${where} 的 entities 里实体 ${entity.id} 出现两次：一份快照不许有重复 id`,
      );
    }
    next.set(entity.id, entity);
  }
  // 只 validate 形状（id 是 UUIDv7、该 kind 的整数毫米字段），不 validate 引用与几何：
  // 放行证在 `assertTruthSourceInvariants`，而它的调用点是 T5 的 `loadProject`（那里才知道读了几层）。
  return Document.replaceEntities(
    Document.create(payload.projectId, payload.schemaVersion),
    next,
  );
}

/**
 * 线上快照 → 文档。**先过 zod 再建 Map**（`parseDocumentPayload` 逐个实体过 `EntitySchema`），
 * 于是"主进程收到一份坏 payload"是在边界上当场炸，不是构造出半个文档之后才炸。
 *
 * 重复 id 的牙与构造口径都住在 `documentFromPayload`（P-19：只有一个产地），这里只是
 * "解析 + 委托"的一行组合；文案前缀仍由调用方递来的 `where` 决定。
 */
export function decodeDocumentPayload(where: string, payload: unknown): Document {
  return documentFromPayload(parseDocumentPayload(where, payload), where);
}
