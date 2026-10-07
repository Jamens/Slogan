import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  SAVE_STATUS_EVENT,
  UI_COMMAND_EVENT,
  type CloseRequest,
  type CloseValue,
  type ConfigValue,
  type ConnectionInput,
  type ConnectionTestValue,
  type ExportPlanRequestShape,
  type ExportPlanResultShape,
  type IpcResult,
  type OpenValue,
  type ProjectCreateValue,
  type ProjectListValue,
  type SaveStatusWire,
  type SubmitRequest,
  type SubmitValue,
  type UiCommand,
} from '@dajia/protocol';

/**
 * 屏幕能问 main 的全部事情。没有一条是"直接写库"：十一个方法背后是八条请求通道 + 两条事件，
 * 参数与回包的形状全部由 `packages/protocol/src/persist-schema.ts` 定义（T8 第 ③ 段 + T9 第 ④ 段）。
 *
 * 口令在这一族里只有一个通路：`saveConfig` 与 `testConnection` 吃 `ConnectionInput`（类型名，
 * 不是字段名）。于是本文件的文本里一个字节都不必出现那个键（P-33）—— 而 `ipc-channels.test.ts`
 * 最后一格那条禁令因此原样保留，这是它比"摘掉禁令 + 写明只许进方向"更强的一档。
 */
export interface DajiaApi {
  ping(): Promise<string>;
  /**
   * 导出当前方案（plan5 T7/T8：面板「导出平面图」按钮 → `IPC.exportPlan` → 真实 IPC 落盘）。
   *
   * 请求与响应都是纯数据：`doc` 是线上快照（三键，`DocumentPayloadSchema`），
   * 不是 `Document` 实例 —— 跨进程边界只能过结构化克隆，而 `Document` 的 `Map` 与
   * getter 过不去。两侧的转换各住一处：renderer 侧 `src/shared/document-payload.ts`
   * （encode，只有类型导入所以渲染包能安全引）、main 侧 `src/shared/document-wire.ts`
   * （decode，值导入 protocol 做 zod 校验）。preload 只递过去，不认识 `Document`。
   */
  exportPlan(req: ExportPlanRequestShape): Promise<ExportPlanResultShape>;
  /**
   * 参数写 `string` 而不是 `EntityId`：`EntityId = string` 无品牌（core 的 `ids.ts`），
   * 写两个名字等于让读的人多记一件事，而真正的形状检查在 main 的 `parseOpenRequest`。
   */
  openProject(projectId: string): Promise<IpcResult<OpenValue>>;
  submitJournal(request: SubmitRequest): Promise<IpcResult<SubmitValue>>;
  closeProject(request: CloseRequest): Promise<IpcResult<CloseValue>>;
  /** 首屏那一份读数（`probeConfig` 永不抛：没配 ⇒ `state: 'unset'` + 四格 null）。 */
  readConfig(): Promise<IpcResult<ConfigValue>>;
  /** 保存。回的是读回来那一份，不是输入（`writeConfig` 的"写完立刻以读的路径验一遍"）。 */
  saveConfig(connection: ConnectionInput): Promise<IpcResult<ConfigValue>>;
  /** 试连屏幕上那份草稿。它不落盘 —— 试一次不会把人家的配置文件改掉。 */
  testConnection(connection: ConnectionInput): Promise<IpcResult<ConnectionTestValue>>;
  listProjects(): Promise<IpcResult<ProjectListValue>>;
  /** 只回 id。开开会话由屏幕接着调 `openProject`（口径 ② 末那句"顺序由 renderer 负责"）。 */
  createProject(name: string): Promise<IpcResult<ProjectCreateValue>>;
  /** 返回注销函数：屏幕侧一份 store 一次订阅，撤干净是测试（每格一个 store）与 T11 的前提。 */
  onSaveStatus(listener: (status: SaveStatusWire) => void): () => void;
  /** 同上，第二条事件通道（main → 屏幕的"该显示哪一层"）。 */
  onUiCommand(listener: (command: UiCommand) => void): () => void;
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
  // `{}` 必须**显式写出来**：两张空表请求（`ConfigReadRequestSchema` / `ProjectListRequestSchema`）
  // 都拒 `undefined`（`persist-config-schema.test.ts` 第 9 格钉的正是这件事），
  // 漏传参数的症状是"列表永远打不开"，而横幅上那句是"解不开工程列表的请求"—— 一句都不指向真正的病因。
  readConfig: () => ipcRenderer.invoke(IPC.configRead, {}) as Promise<IpcResult<ConfigValue>>,
  saveConfig: (connection) =>
    ipcRenderer.invoke(IPC.configSave, { connection }) as Promise<IpcResult<ConfigValue>>,
  testConnection: (connection) =>
    ipcRenderer.invoke(IPC.configTest, { connection }) as Promise<IpcResult<ConnectionTestValue>>,
  listProjects: () => ipcRenderer.invoke(IPC.projectList, {}) as Promise<IpcResult<ProjectListValue>>,
  createProject: (name) =>
    ipcRenderer.invoke(IPC.projectCreate, { name }) as Promise<IpcResult<ProjectCreateValue>>,
  onSaveStatus: (listener) => {
    // 包一层再挂：`IpcRendererEvent` 不越过 contextBridge（那是 electron 的对象，屏幕侧拿到只会是噪音），
    // 也因为这个注销函数要把**同一个**引用交给 removeListener —— 直接挂 `listener` 就撤不掉。
    const wrapped = (_event: IpcRendererEvent, status: SaveStatusWire): void => {
      listener(status);
    };
    ipcRenderer.on(SAVE_STATUS_EVENT, wrapped);
    return () => ipcRenderer.removeListener(SAVE_STATUS_EVENT, wrapped);
  },
  onUiCommand: (listener) => {
    // 与上面那一发同一个形状，包括那个"包一层"的理由。两份相似不是要抽公共函数：
    // 泛型化之后 `SaveStatusWire` 与 `UiCommand` 的区别就没了读者，而这两发的载荷类型正是它们的价值。
    const wrapped = (_event: IpcRendererEvent, command: UiCommand): void => {
      listener(command);
    };
    ipcRenderer.on(UI_COMMAND_EVENT, wrapped);
    return () => ipcRenderer.removeListener(UI_COMMAND_EVENT, wrapped);
  },
};

contextBridge.exposeInMainWorld('dajia', api);
