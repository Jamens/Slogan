export const IPC = {
  ping: 'dajia:ping',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export function isIpcChannel(value: unknown): value is IpcChannel {
  return typeof value === 'string' && Object.values(IPC).includes(value as IpcChannel);
}
