import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  SAVE_STATUS_EVENT,
  type CloseRequest,
  type CloseValue,
  type ExportPlanRequestShape,
  type ExportPlanResultShape,
  type IpcResult,
  type OpenValue,
  type SaveStatusWire,
  type SubmitRequest,
  type SubmitValue,
} from '@dajia/protocol';

/**
 * 屏幕能问 main 的全部事情。**没有一条是"直接写库"**：五个方法背后是三条请求通道 + 一条事件，
 * 参数与回包的形状全部由 `packages/protocol/src/persist-schema.ts` 定义（③ 段）。
 * （plan5 落地的 `exportPlan` 一并保留 —— 裁决 T8-A③：整体替换允许，但 `ping` 与
 * `exportPlan` 两格连同注释逐字保留。）
 */
export interface DajiaApi {
  ping(): Promise<string>;
  /**
   * 导出当前方案（plan5 T7/T8：面板「导出平面图」按钮 → `IPC.exportPlan` → 真实 IPC 落盘）。
   *
   * **请求与响应都是纯数据**：`doc` 是线上快照（三键，`DocumentPayloadSchema`），
   * 不是 `Document` 实例 —— 跨进程边界只能过结构化克隆，而 `Document` 的 `Map` 与
   * getter 过不去。两侧的转换各住一处：renderer 侧 `src/shared/document-payload.ts`
   * （encode，只有类型导入所以渲染包能安全引）、main 侧 `src/shared/document-wire.ts`
   * （decode，值导入 protocol 做 zod 校验）。preload 只递过去，不认识 `Document`。
   *
   * 返回 `{ ok, outPath?, error? }` 而不是抛：见 `main/ipc/export-plan-core.ts`
   * 那段"为什么错误一律不抛"。
   */
  exportPlan(req: ExportPlanRequestShape): Promise<ExportPlanResultShape>;
  /**
   * 参数写 `string` 而不是 `EntityId`：`EntityId = string` 无品牌（core 的 `ids.ts`），
   * 写两个名字等于让读的人多记一件事，而真正的形状检查在 main 的 `parseOpenRequest`。
   */
  openProject(projectId: string): Promise<IpcResult<OpenValue>>;
  submitJournal(request: SubmitRequest): Promise<IpcResult<SubmitValue>>;
  closeProject(request: CloseRequest): Promise<IpcResult<CloseValue>>;
  /** 返回注销函数：屏幕侧一份 store 一次订阅，撤干净是测试（每格一个 store）与 T11 的前提。 */
  onSaveStatus(listener: (status: SaveStatusWire) => void): () => void;
}

const api: DajiaApi = {
  // 这里的 `as` 是**声明**，不是校验。校验在 main 的出口那一发（`parseXValue`），
  // 而 preload 不可能再验一遍：`apps/desktop` 没有 zod 依赖，pnpm 的严格 node_modules 也解析不到
  // protocol 那一份（T4 写在 `entity-schema.ts` 顶部的同一条理由）。
  ping: () => ipcRenderer.invoke(IPC.ping) as Promise<string>,
  exportPlan: (req) => ipcRenderer.invoke(IPC.exportPlan, req) as Promise<ExportPlanResultShape>,
  openProject: (projectId) =>
    ipcRenderer.invoke(IPC.projectOpen, { projectId }) as Promise<IpcResult<OpenValue>>,
  submitJournal: (request) =>
    ipcRenderer.invoke(IPC.journalSubmit, request) as Promise<IpcResult<SubmitValue>>,
  closeProject: (request) =>
    ipcRenderer.invoke(IPC.projectClose, request) as Promise<IpcResult<CloseValue>>,
  onSaveStatus: (listener) => {
    // 包一层再挂：`IpcRendererEvent` 不越过 contextBridge（那是 electron 的对象，屏幕侧拿到只会是噪音），
    // 也因为这个注销函数要把**同一个**引用交给 removeListener —— 直接挂 `listener` 就撤不掉。
    const wrapped = (_event: IpcRendererEvent, status: SaveStatusWire): void => {
      listener(status);
    };
    ipcRenderer.on(SAVE_STATUS_EVENT, wrapped);
    return () => ipcRenderer.removeListener(SAVE_STATUS_EVENT, wrapped);
  },
};

contextBridge.exposeInMainWorld('dajia', api);
