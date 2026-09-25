import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@dajia/protocol';

export interface DajiaApi {
  ping(): Promise<string>;
}

const api: DajiaApi = {
  ping: () => ipcRenderer.invoke(IPC.ping) as Promise<string>,
};

contextBridge.exposeInMainWorld('dajia', api);
