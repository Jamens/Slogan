import { app, BrowserWindow, ipcMain } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_SCHEMA_VERSION } from '@dajia/core';
import { IPC } from '@dajia/protocol';

/** 取 `--shot <path>` 的落盘路径；没这个开关就是正常启动。 */
function shotPathFromArgv(): string | null {
  const i = process.argv.indexOf('--shot');
  if (i < 0) return null;
  const p = process.argv[i + 1];
  if (p === undefined || p.startsWith('--')) {
    throw new RangeError('--shot 后面必须跟一个文件路径');
  }
  return p;
}

function createWindow(visible: boolean): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: visible,
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

  // 只在可见模式补 show：--shot 从头到尾走 show:false 的隐藏绘制路径——canvas 画进 backing
  // store，getImageData 不依赖合成器上屏（Step 4 注释的那条主张，此前被这行无条件 show 架空）。
  if (visible) {
    win.once('ready-to-show', () => win.show());
  }
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  return win;
}

function whenLoaded(win: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    if (!win.webContents.isLoading()) {
      resolve();
      return;
    }
    win.webContents.once('did-finish-load', () => resolve());
  });
}

/** 条件轮询，不是固定 sleep：窗口慢不会导致误判白屏，等不到就是失败。 */
async function waitForDebug(win: BrowserWindow): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const ready = await win.webContents.executeJavaScript('typeof window.__dajiaDebug === "function"');
    if (ready === true) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('10 秒内 renderer 没挂上 window.__dajiaDebug —— 视图没起来，不是"暂时没测到"');
}

async function runShot(win: BrowserWindow, path: string): Promise<void> {
  await whenLoaded(win);
  await waitForDebug(win);
  const report = await win.webContents.executeJavaScript('window.__dajiaDebug()');
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

void app.whenReady().then(async () => {
  let shotPath: string | null;
  try {
    shotPath = shotPathFromArgv();
  } catch (err) {
    // 参数不合法就立刻非零退出。此前这个 throw 落在被丢弃的 promise rejection 里：没有窗口、
    // 没有退出信号，window-all-closed 永不触发，只能等脚本侧 180 秒超时才收尾。
    process.stderr.write(`--shot 参数无效：${String(err)}\n`);
    app.exit(2);
    return;
  }
  const win = createWindow(shotPath === null);
  if (shotPath === null) {
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(true);
    });
    return;
  }
  let code = 0;
  try {
    await runShot(win, shotPath);
  } catch (err) {
    process.stderr.write(`--shot 失败：${String(err)}\n`);
    code = 1;
  }
  app.exit(code);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
