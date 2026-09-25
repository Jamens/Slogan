import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { CORE_SCHEMA_VERSION } from '@dajia/core';
import { IPC } from '@dajia/protocol';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    title: '搭家',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  ipcMain.removeHandler(IPC.ping);
  ipcMain.handle(IPC.ping, () => `pong:${CORE_SCHEMA_VERSION}`);

  void win.once('ready-to-show', () => win.show());
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
