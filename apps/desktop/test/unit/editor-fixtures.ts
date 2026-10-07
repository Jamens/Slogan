import { Document, uuidv7, type Entity, type EntityId } from '@dajia/core';
import { useEditor } from '../../src/renderer/src/stores/editorStore';

/**
 * 样例房那份真源的基准三格。**读现成的 state，绝不再调一次 `demoHouse()`**：
 * 它的 id 是随机 UUIDv7，第二次调拿到的是另一套房（`editorStore.ts` 顶上那句"只调一次"
 * 记的就是这件事，而它在测试里同样成立 —— 基准必须是"屏幕上这一套"，不是"长得像的那一套"）。
 */
export const DEMO = {
  log: useEditor.getState().log,
  storeyId: useEditor.getState().storeyId,
  revision: useEditor.getState().revision,
};

/**
 * 把 store 回到"刚 import 完"那一帧。逐字段列出来而不是"存一份快照再整份塞回去"：
 * 快照法会连 `open`/`loadProject` 这些**函数引用**一起塞回去，而那几格本来就不该动 ——
 * 一张写明了"哪些字段属于我"的清单，比一个通配的还原器更能说明本任务动了什么。
 *
 * `DEMO.log` 这份可变实例本身**不回滚**（回滚要调 `undo()`，而那正是被测对象）。
 * 于是所有用例断的是**相对量**：`depth` 与调用前比、`revision` 与 `DEMO.revision` 比。
 */
export function resetEditor(): void {
  useEditor.setState({
    log: DEMO.log,
    storeyId: DEMO.storeyId,
    viewport: null,
    viewportStoreyId: null,
    revision: DEMO.revision,
    lastError: null,
    drag: null,
    draft: null,
    tool: 'select',
    readOnly: false,
  });
}

/** 一份只有一个楼层的最小文档：`loadProject` 的两个分支都用它，不需要真墙。 */
export function oneStoreyDoc(): {
  readonly doc: Document;
  readonly projectId: EntityId;
  readonly storeyId: EntityId;
  readonly wallId: EntityId;
} {
  const projectId = uuidv7();
  const storeyId = uuidv7();
  const wallId = uuidv7();
  const entities = new Map<EntityId, Entity>([
    [storeyId, { kind: 'storey', id: storeyId, projectId, index: 0, elevationMm: 0, heightMm: 3000 }],
    // 一个不属于任何层的墙 id 不进文档：`loadProject` 只看 `storeyId` 那一格是不是 storey，
    // 而"存在但不是层"那一型用**另一个 storey 的 id**去判更准（见 格 5 的第二发）。
    [wallId, {
      kind: 'wall', id: wallId, storeyId, startId: storeyId, endId: storeyId,
      thicknessMm: 200, heightMm: 3000, elevationOffsetMm: 0, loadBearing: false, material: '砖',
    }],
  ]);
  return { doc: Document.replaceEntities(Document.create(projectId), entities), projectId, storeyId, wallId };
}
