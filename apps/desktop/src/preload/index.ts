import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type ExportPlanRequestShape, type ExportPlanResultShape } from '@dajia/protocol';

export interface DajiaApi {
  ping(): Promise<string>;
  /**
   * 导出当前方案（plan5 T7/T8 经真实 IPC 落盘）。
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
}

const api: DajiaApi = {
  ping: () => ipcRenderer.invoke(IPC.ping) as Promise<string>,
  exportPlan: (req) => ipcRenderer.invoke(IPC.exportPlan, req) as Promise<ExportPlanResultShape>,
};

contextBridge.exposeInMainWorld('dajia', api);
