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

interface ClickPoint {
  x: number;
  y: number;
}

interface PickProbeShape {
  ownerId: string;
  clickPx: ClickPoint;
  blankPx: ClickPoint;
}

interface ReportShape {
  ops: number;
  selectedIds: string[];
  selectedPx: number;
  pick: PickProbeShape | null;
  selectedAfterBlank: number;
}

function pickShotRequested(): boolean {
  return process.argv.includes('--pick-shot');
}

/** 条件轮询，不是固定 sleep：慢窗口不该导致误判成"没反应"，等不到才是失败。 */
async function waitUntil<T>(label: string, probe: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await probe();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`10 秒内没等到：${label}`);
}

async function readReport(win: BrowserWindow): Promise<ReportShape> {
  return (await win.webContents.executeJavaScript('window.__dajiaDebug()')) as ReportShape;
}

/**
 * 走合成指针事件，不走 `element.click()`：后者只给 DOM 派发一个 click，
 * 我们的处理器听的是 pointerdown（而且真实点击还带着 offsetX 与 shift 修饰键）。
 */
async function clickPx(win: BrowserWindow, p: ClickPoint): Promise<void> {
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

/**
 * 合成输入只发给有 OS 前台焦点的窗口（sendInputEvent 的原文注记），Windows 的前台锁
 * 又会让刚启动进程的 win.focus() 不保证生效。所以这里不是"调一次 focus 就点"，而是
 * **等到真的拿到焦点**再走；5 秒拿不到就报明确失败，绝不静默地把没派发的点击当判据。
 * （T5 Step 6 会把两条 shot 路径统一收敛到这个函数上。）
 */
async function focusForInput(win: BrowserWindow): Promise<void> {
  app.focus({ steal: true });
  win.focus();
  win.webContents.focus();
  for (let i = 0; i < 100; i++) {
    if (win.isFocused()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('5 秒内窗口没拿到 OS 前台焦点 —— 合成指针事件不会被派发，不是"点了没反应"');
}

/** 先点中一个构件，再点空白，最后把两个状态一起写盘。坐标一律由 scene-2d 的探针给出。 */
async function runPickShot(win: BrowserWindow, path: string): Promise<void> {
  await whenLoaded(win);
  await waitForDebug(win);
  await focusForInput(win);
  const before = await readReport(win);
  if (before.pick === null) throw new Error('probeTarget 没给靶子：四角离图太近或没有唯一命中的边');
  const probe = before.pick;
  await clickPx(win, probe.clickPx);
  const picked = await waitUntil(
    `选中 ${probe.ownerId} 且屏幕变红`,
    () => readReport(win),
    (r) =>
      r.selectedIds.length === 1 && r.selectedIds[0] === probe.ownerId && r.selectedPx > 100,
  );
  await clickPx(win, probe.blankPx);
  // 三个条件一起等：React 提交 store 与重刷画布之间隔着一帧。只等 ids 归零的话，
  // 会在红像素还没落时就把它读进报告，判据 4 假红（看起来像"清空没生效"）。
  const cleared = await waitUntil(
    '点空白后清空选中',
    () => readReport(win),
    (r) => r.selectedIds.length === 0 && r.selectedAfterBlank === 0 && r.selectedPx === 0,
  );
  const finalReport = {
    ...cleared,
    ops: before.ops,
    pick: probe,
    clickedOwner: picked.selectedIds[0] ?? null,
    // 清空之后 selectedPx 会回到 0，所以"点中时红了多少"必须单独留档，
    // 不能靠 finalReport 里那个 selectedPx —— 那是空白点的状态。
    pickedSelectedPx: picked.selectedPx,
  };
  writeFileSync(path, `${JSON.stringify(finalReport, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(finalReport)}\n`);
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
  // --pick-shot 走可见窗口：派发合成输入要求窗口拿到 OS 前台焦点（见 focusForInput），
  // 隐藏窗在 Windows 前台锁下拿不到焦点是实测过的。纯 --shot 保持 6ddb090 落地的
  // 隐藏绘制路径不变 —— 它不派发输入，只回读像素。
  const win = createWindow(shotPath === null || pickShotRequested());
  if (shotPath === null) {
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(true);
    });
    return;
  }
  let code = 0;
  try {
    if (pickShotRequested()) await runPickShot(win, shotPath);
    else await runShot(win, shotPath);
  } catch (err) {
    process.stderr.write(`--shot 失败：${String(err)}\n`);
    code = 1;
  }
  app.exit(code);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
