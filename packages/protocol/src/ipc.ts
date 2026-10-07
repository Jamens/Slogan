export const IPC = {
  ping: 'dajia:ping',
  /**
   * 导出平面图（plan5 T8 的产物经真实 IPC 落盘）。
   * 请求/响应形状在 `export-plan-schema.ts`；**日期是入参**，契约层不给运行时时钟开口子。
   */
  exportPlan: 'dajia:export-plan',
  // 以下四条归计划 4（T8）。命名口径：`dajia:<域>:<动作或事件>`。
  // `saveStatus` 是这条表里唯一的事件通道（main → renderer，没有请求方向），
  // 它不进 `INVOKE_CHANNELS` 那张名册 —— 名册只管需要注册 handler 的那三条。
  projectOpen: 'dajia:project:open',
  projectClose: 'dajia:project:close',
  journalSubmit: 'dajia:journal:submit',
  saveStatus: 'dajia:save:status',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export function isIpcChannel(value: unknown): value is IpcChannel {
  return typeof value === 'string' && Object.values(IPC).includes(value as IpcChannel);
}
