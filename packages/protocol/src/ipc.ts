export const IPC = {
  ping: 'dajia:ping',
  /**
   * 导出平面图（plan5 T8 的产物经真实 IPC 落盘）。
   * 请求/响应形状在 `export-plan-schema.ts`；**日期是入参**，契约层不给运行时时钟开口子。
   */
  exportPlan: 'dajia:export-plan',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export function isIpcChannel(value: unknown): value is IpcChannel {
  return typeof value === 'string' && Object.values(IPC).includes(value as IpcChannel);
}
