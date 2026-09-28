import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_SCHEMA_VERSION } from '@dajia/core';
import { IPC } from '@dajia/protocol';

/**
 * 取 `<flag> <path>` 的落盘路径。`--shot` 之外，T5 的 `--edit-shot` / T4 的 `--pick-shot`
 * 也复用它们各自开关后面的路径。
 *
 * 开关与路径必须成对：拿到的下一个参数若还是 `--…` 开关（或干脆没有），立刻抛 —— 由
 * whenReady 的参数守卫 catch 住、毫秒级 exit(2)，绝不把开关名当文件名写进 writeFileSync，
 * 也不留到 180 秒脚本超时才收尾（6ddb090 给 `--shot` 立的那条 fail-fast，这里推广到全部开关，
 * 顺带收掉 T4 那个 "`--pick-shot` 不带 `--shot` 就悄悄起交互窗口" 的挂账 foot-gun）。
 */
function argPath(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  const p = process.argv[i + 1];
  if (p === undefined || p.startsWith('--')) {
    throw new RangeError(`${flag} 后面必须跟一个文件路径`);
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

  // 闸门期间把 renderer 的 error 级 console 原样转发到 stdout：executeJavaScript 里抛异常时
  // Electron 只在主进程回一句 "check the renderer console"，真凶（renderer 抛的那行 + 栈）
  // 全留在没人看的通道里。没有这一转发，`__dajiaDebug()` 失败只能看到"脚本没跑成"。
  // 只在 shot 模式装（三条闸门都带 `--shot`，交互模式不带）：往 stdout 打 renderer 日志是
  // 闸门的取证手段，不该变成正常用法的运行时行为。
  if (process.argv.includes('--shot')) {
    win.webContents.on('console-message', (...args: unknown[]) => {
      // 声明里详情在第二参，实测这台运行时把它放在**第一**参（第二参是数字 level），
      // 所以取 args[0]，并用 level 字符串判错误级。形状对不上时不打印 —— 宁可不报也别报错东西。
      const first = args[0] as { level?: unknown; message?: unknown };
      if (first?.level !== 'error' || typeof first.message !== 'string') return;
      process.stdout.write(`[renderer] ${first.message}\n`);
    });
  }

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

/** 画布坐标空间（CSS px，相对画布原点）：DrawOp 与 PickProbe 的 clickPx/blankPx 住这里。 */
interface CanvasPx {
  x: number;
  y: number;
}

/** 页面/视口坐标空间（CSS px，相对页面原点）：sendInputEvent 与 getBoundingClientRect 的口径。 */
interface ViewportPx {
  x: number;
  y: number;
}

interface PickProbeShape {
  ownerId: string;
  clickPx: CanvasPx;
  blankPx: CanvasPx;
}

interface ReportShape {
  ops: number;
  selectedIds: string[];
  selectedPx: number;
  pick: PickProbeShape | null;
  selectedAfterBlank: number;
  canvasOriginPx: ViewportPx;
}

function pickShotRequested(): boolean {
  return process.argv.includes('--pick-shot');
}

/** 条件轮询，不是固定 sleep：慢窗口不该导致误判成"没反应"，等不到才是失败。 */
async function waitUntil<T>(label: string, probe: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < 200; i++) {
    const value = await probe();
    if (done(value)) return value;
    last = value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // 超时必须自带最后一眼：否则"没等到"只说明判据没成立，不说明哪一半没成立
  // （选中集空？把手没上屏？像素落在别面墙上？），下一轮排查只能从头再猜。
  throw new Error(`10 秒内没等到：${label}\n最后一眼：${JSON.stringify(last)}`);
}

async function readReport(win: BrowserWindow): Promise<ReportShape> {
  return (await win.webContents.executeJavaScript('window.__dajiaDebug()')) as ReportShape;
}

/**
 * 走合成指针事件，不走 `element.click()`：后者只给 DOM 派发一个 click，
 * 我们的处理器听的是 pointerdown（而且真实点击还带着 offsetX 与 shift 修饰键）。
 *
 * 坐标换算：探针点是**画布 px**，sendInputEvent 吃**页面 px**，两者差一个实测的画布原点
 * （`canvasOriginPx`）。这里显式加回原点，不假定两套空间重合 —— 今天 origin=(0,0) 时加零
 * 等价于没加，但 Task 8 往画布区挂 StoreyTabs/PropPanel 后布局会变，换算必须在位；
 * "前提今天成立"由闸门的 origin PASS 行断言，而不是由这条路径碰巧不出错来背书。
 * 这不是模型几何（角点/沿墙偏移/包围盒一律没碰），是回读通道的坐标空间对齐。
 */
async function clickCanvasPx(win: BrowserWindow, p: CanvasPx, origin: ViewportPx): Promise<void> {
  const x = Math.round(p.x + origin.x);
  const y = Math.round(p.y + origin.y);
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

/**
 * 布局要等它**停下来**再读探针：窗口在 show/focus 之后自己还会改尺寸（实测画布高 865 → 839），
 * 而 `dragProbe` 给的像素是按当时 viewport 算的。拿 865 那版的 fromPx 去点 839 的屏幕，
 * 落点差出的不是一两个像素而是整个命中半径 —— 落空白就 `clear()`（选中集空），
 * 落别面墙就选中别的 owner，两种都只会等满 10 秒超时，看不出是"坐标过期"。
 * 判据是"连续三读尺寸不变"，不是固定 sleep：稳定即走，稳不下来带着最后一眼失败。
 */
async function waitForLayoutSettled(win: BrowserWindow): Promise<{ wPx: number; hPx: number }> {
  let last: { wPx: number; hPx: number } | null = null;
  let same = 0;
  for (let i = 0; i < 200; i += 1) {
    const size = (await win.webContents.executeJavaScript(
      '(() => { const r = window.__dajiaDebug(); return { wPx: r.wPx, hPx: r.hPx }; })()',
    )) as { wPx: number; hPx: number };
    if (last !== null && size.wPx === last.wPx && size.hPx === last.hPx) {
      same += 1;
      if (same >= 2) return size;
    } else {
      same = 0;
    }
    last = size;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`10 秒内画布尺寸没稳定，探针像素不可信：最后一眼 ${JSON.stringify(last)}`);
}

/** 先点中一个构件，再点空白，最后把两个状态一起写盘。坐标一律由 scene-2d 的探针给出。 */
async function runPickShot(win: BrowserWindow, path: string): Promise<void> {
  await whenLoaded(win);
  await waitForDebug(win);
  await focusForInput(win);
  await waitForLayoutSettled(win);
  const before = await readReport(win);
  // 取 falsy 而不是 === null：旧 bundle / 字段改名时 before.pick 是 undefined，
  // 也走这条带标签的失败，而不是在 clickCanvasPx 里炸一个裸 TypeError。
  if (!before.pick) throw new Error('probeTarget 没给靶子：四角离图太近或没有唯一命中的边');
  const probe = before.pick;
  const origin = before.canvasOriginPx;
  await clickCanvasPx(win, probe.clickPx, origin);
  // waitUntil 只等 **store 半区落定**（选中集恰出现 1 个），不判"是谁"也不判像素：
  // 归属（clickedOwner === pick.ownerId）与 selectedPx>100 的判据归脚本（I2：一个判据
  // 一个主人），脚本那两行才可能真打 FAIL —— 两侧同判同一快照时脚本行永远红不了。
  // 快照原子的依据：__dajiaDebug 钩子的 effect 排在 paint effect 之后（同一 commit 的
  // effect flush，executeJavaScript 插不进中间），所以读到新 selectedIds 时画布必已重刷，
  // 不需要在等待谓词里"捎带"像素条件防假红。
  const picked = await waitUntil(
    '点击后选中集没落成恰好 1 个（store 半区）',
    () => readReport(win),
    (r) => r.selectedIds.length === 1,
  );
  await clickCanvasPx(win, probe.blankPx, origin);
  // 同上：只等 store 落定（清空）。"store 与屏幕一起清空"整条判据归脚本那一行。
  const cleared = await waitUntil(
    '点空白后选中集没清空（store 半区）',
    () => readReport(win),
    (r) => r.selectedIds.length === 0,
  );
  const finalReport = {
    ...cleared,
    ops: before.ops,
    pick: probe,
    // 换算用的原点随报告一起落盘：脚本既拿它断言 (0,0)，也用它核对换算用的是同一个值。
    canvasOriginPx: origin,
    clickedOwner: picked.selectedIds[0] ?? null,
    // 清空之后 selectedPx 会回到 0，所以"点中时红了多少"必须单独留档，
    // 不能靠 finalReport 里那个 selectedPx —— 那是空白点的状态。
    pickedSelectedPx: picked.selectedPx,
  };
  writeFileSync(path, `${JSON.stringify(finalReport, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(finalReport)}\n`);
}

interface MmShape {
  x: number;
  y: number;
}

interface ClickPoint {
  x: number;
  y: number;
}

interface DragProbeShape {
  wallId: string;
  end: string;
  pointId: string;
  sharedBy: number;
  fromPx: ClickPoint;
  toPx: ClickPoint;
  anchorPx: ClickPoint;
  targetMm: MmShape;
}

interface DropShape {
  outcome: 'ok' | 'noop' | 'failed';
  wallId: string;
  end: string;
  targetMm: MmShape;
  pointMm: MmShape;
}

interface KeyShape {
  /** 与 `KeyEventReport.seq` 同一字段：主进程靠它认"这一发确实到过 renderer"。 */
  seq: number;
  combo: string;
  depth: number;
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
  lastError: string | null;
}

/**
 * T5 的 `__dajiaDebug()` 全形状：T4 的字段（含实测 `canvasOriginPx`）之外，又多了 12 +
 * 探针与两份诊断。`canvasOriginPx` 必须在这里也在：拖拽助手靠它把画布 px 换算成 sendInputEvent
 * 的页面 px（见 clickCanvasPx 那条坐标空间注），漏了它 = 拿画布 px 直接喂事件（fa05e41 那个真 bug）。
 */
interface EditReportShape {
  ops: number;
  layers: Record<string, number>;
  nonBlankPx: number;
  wPx: number;
  hPx: number;
  selectedIds: string[];
  selectedPx: number;
  pick: unknown;
  selectedAfterBlank: number;
  canvasOriginPx: ViewportPx;
  revision: number;
  depth: number;
  canUndo: boolean;
  canRedo: boolean;
  lastError: string | null;
  handlePx: number;
  previewPx: number;
  previewNearCursorPx: number;
  points: Record<string, MmShape>;
  edit: DragProbeShape | null;
  /** 拖拽进行中的目标毫米（不在拖 = null）。松手前读它，见 `waitDragAt`。 */
  dragTargetMm: MmShape | null;
  /** 拖拽中 store 里已处理的光标像素（不在拖 = null）。只有第 2 步拿它对照 `midPx`，
   *  证"那一发 pointermove 真被处理过"；第 3/4/7 步松手前看的是邻居 `dragTargetMm`。 */
  dragCursorPx: ClickPoint | null;
  lastDrop: DropShape | null;
  lastKeyEvent: KeyShape | null;
}

function editShotRequested(): boolean {
  return process.argv.includes('--edit-shot');
}

/** 把三枚像素读数写成一条 `waitUntil` 的判据，读不到就抛，绝不"等不到算通过"。 */
async function readEditReport(win: BrowserWindow, label: string): Promise<EditReportShape> {
  let value: EditReportShape | undefined;
  try {
    value = (await win.webContents.executeJavaScript('window.__dajiaDebug()')) as
      | EditReportShape
      | undefined;
  } catch (error) {
    // Electron 把这行打成 "Script failed to execute... check the renderer console"，
    // 等于把真凶藏进一个没人看的通道。这里必须把 renderer 的异常原文带出来。
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`__dajiaDebug() 在 renderer 里抛了（${label}）：${message}`);
  }
  if (value === undefined) {
    throw new Error(`__dajiaDebug() 没返回报告（${label}）—— renderer 死了，不是"还没刷完"`);
  }
  return value;
}

/**
 * 松手之前先等 store 里的拖拽目标就位。
 *
 * `sendInputEvent` 只是把事件塞进浏览器输入队列，`await` 不等它被处理；而 `onUp` 读的是
 * **当下 store 的 `drag.targetMm`** —— 那由最后一发**已处理**的 `pointermove` 决定。于是
 * `movePx(to)` 之后立刻 `releasePx(to)` 是在赌队列不压：实测约 6 次里 1 次，松手用的还是
 * 上一发（中途）的光标，落点差出几百毫米，红在「松手后没落到」那道 throw 上 —— 症状在下游，
 * 病根在这一发没等到。这里把它挪到上游等，红的时候说的是真话。
 *
 * 这不是重试：等的就是"那一发到了"这一件事，等不到照样 10 秒 throw、照样 exit=1。
 */
async function waitDragAt(
  win: BrowserWindow,
  want: (r: EditReportShape) => boolean,
  label: string,
): Promise<EditReportShape> {
  return waitUntil(
    `松手前拖拽目标没就位：${label}`,
    () => readEditReport(win, '松手前'),
    want,
  );
}

/** 快照里少一枚点 = 真源被写坏了。"读不到"绝不允许当成"没变"。 */
function mmOf(report: EditReportShape, pointId: string, label: string): MmShape {
  const mm = report.points[pointId];
  if (mm === undefined) throw new Error(`${label}：points 快照里没有端点 ${pointId}`);
  return mm;
}

/**
 * 拖拽三件套：探针点的是**画布 px**，sendInputEvent 吃**页面 px**，差一个实测的画布原点。
 * 这里显式加回 origin（与 clickCanvasPx 同一口径），不假定两套空间重合 —— 今天 origin=(0,0)
 * 时加零等价于没加，但 Task 8 挂 StoreyTabs/PropPanel 后布局会变，换算必须在位；"前提今天成立"
 * 由 --edit-shot 的 origin PASS 行断言。这不是模型几何（角点/沿墙偏移一律没碰），是回读通道对齐。
 */
async function pressPx(win: BrowserWindow, p: ClickPoint, origin: ViewportPx): Promise<void> {
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    x: Math.round(p.x + origin.x),
    y: Math.round(p.y + origin.y),
    button: 'left',
    clickCount: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 16));
}

async function movePx(win: BrowserWindow, p: ClickPoint, origin: ViewportPx): Promise<void> {
  win.webContents.sendInputEvent({
    type: 'mouseMove',
    x: Math.round(p.x + origin.x),
    y: Math.round(p.y + origin.y),
  });
  await new Promise((resolve) => setTimeout(resolve, 16));
}

async function releasePx(win: BrowserWindow, p: ClickPoint, origin: ViewportPx): Promise<void> {
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: Math.round(p.x + origin.x),
    y: Math.round(p.y + origin.y),
    button: 'left',
    clickCount: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 16));
}

/**
 * `sendInputEvent` 的修饰键只认这几个字面量（Electron 44 `electron.d.ts` 里 `InputEvent.modifiers`
 * 的联合类型）。这里写成字面量数组而不是 `string[]`：后者传进 `sendInputEvent` 会红在
 * `TS2322 Type 'string[]' is not assignable to ...`，而那是一条编译期就能抓住的错，
 * 不该留到真窗口里当"按了没反应"查。
 */
type InputModifier = 'ctrl' | 'shift' | 'alt' | 'meta' | 'command';

/**
 * 默认应用菜单里有 Edit → Undo (Ctrl+Z) / Redo (Ctrl+Shift+Z)，它们与本任务的快捷键**逐字同名**。
 * 合成按键是直接进 Blink 的，正常不该被 accelerator 截走；但一旦"按了没反应"，
 * 现象与被菜单吃掉一模一样。shot 模式下整张菜单摘掉（在 `whenReady` 里、**建窗之前**摘），
 * 把这个变量从实验里去掉。
 */
async function keyCombo(
  win: BrowserWindow,
  keyCode: string,
  modifiers: InputModifier[],
): Promise<void> {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await new Promise((resolve) => setTimeout(resolve, 16));
}

/**
 * 发完快捷键再等 —— **等的是"这一发确实被处理了"**，不是固定 sleep：
 * 等的是 `seq` 变大。别退回去比 `combo`：第 8 步的空栈重做与第 6 步的重做同为
 * `'Ctrl+Shift+Z'`，而那一发故意什么都不改（真源没动 ⇒ `depth`、`revision`、坐标全不动，
 * 只换一句中文），拿它们当条件会等满 10 秒再抛 —— 判据没测到东西， yet 全线红在超时上。
 * `waitUntil` 的谓词替不了类型收窄，所以读回后仍要显式判 `null`。
 */
async function waitKeyApplied(
  win: BrowserWindow,
  before: EditReportShape,
  label: string,
): Promise<KeyShape> {
  const report = await waitUntil(
    `快捷键没生效（${label}）：renderer 的 keydown 没跑到`,
    () => readEditReport(win, label),
    (r) => r.lastKeyEvent !== null && r.lastKeyEvent.seq > (before.lastKeyEvent?.seq ?? 0),
  );
  const key = report.lastKeyEvent;
  if (key === null) throw new Error(`不可达：waitUntil 判定 key 非空后读回 null（${label}）`);
  return key;
}

/**
 * 八步序列：按下即选中 → 中途不写 → 松手落点 → 压扁被拒 → 撤销 → 重做 → 原地 noop → 空栈重做。
 * 每一步的读数都单独存一个 const，最后一起写盘：TS 的使用先于声明会替我们守住
 * "少跑一步就编译不过"，比事后补一堆缺键检查可靠。
 */
async function runEditShot(win: BrowserWindow, out: string): Promise<void> {
  await whenLoaded(win);
  await waitForDebug(win);
  await focusForInput(win);
  await waitForLayoutSettled(win);

  const start = await readEditReport(win, '拖动前');
  const origin = start.canvasOriginPx;
  const edit = start.edit;
  if (edit === null) {
    throw new Error('dragProbe 没给靶子：一层没有共享端点，或候选落点全不合法');
  }
  if (edit.sharedBy < 2) {
    throw new Error(`探针给出的是孤端点（sharedBy=${String(edit.sharedBy)}）：拖它证不出"邻墙跟着动"`);
  }
  const atStart = mmOf(start, edit.pointId, '拖动前');
  process.stdout.write(
    `探针：${edit.wallId}:${edit.end} 共享 ${String(edit.sharedBy)} 面 ` +
      `from=(${String(edit.fromPx.x)},${String(edit.fromPx.y)}) ` +
      `to=(${String(edit.toPx.x)},${String(edit.toPx.y)}) ` +
      `画布 ${String(start.wPx)}×${String(start.hPx)}\n`,
  );

  // 1) D5 说"拖之前先要点一下"，本任务就是**点两下**：第一下选中，第二下才起拖。
  //    为什么一发按下起不了拖：把手只从**当前选中集**生成，而此刻选中集是空的 ——
  //    `handlesRef` 由 paint effect 按 `ids` 填，空集时它是空的，`pickHandle` 无从命中，
  //    那一发只走 `pickOne` → `select`（选中但不装填 `drag`）。于是 brief 里"一发按下
  //    就 `previewPx > 20`"在真代码上落不了地（见 report 的差异清单）：现实优先，补第二发。
  //    第一下做成一次干净的点击：走 --pick-shot 验过的同一枚原语 clickCanvasPx（按下+松开
  //    一发完成）。松开时 `activeRef` 仍是 false（没命中把手），`onUp` 直接早退，不动选中集，
  //    也不往撤销栈塞东西。
  //    先把光标 move 到目标像素"报到"一发：Windows 合成输入里，加载后第一发裸 mouseDown
  //    有时不进 pointerdown（Blink 命中测试要先有一次同位置的 move）—— 实测 1a 间歇性 10s 不中。
  //    movePx 在无 drag 时于 renderer 是 no-op（onMove 见 activeRef=false 直接返回），不改任何真源。
  await movePx(win, edit.fromPx, origin);
  await clickCanvasPx(win, edit.fromPx, origin);
  const selected = await waitUntil(
    `第一下点完没选中 ${edit.wallId}，或把手没上屏（handlesRef 归 paint effect 填）`,
    () => readEditReport(win, '选中后'),
    (r) =>
      r.selectedIds.length === 1 &&
      r.selectedIds[0] === edit.wallId &&
      r.handlePx > 20,
  );

  // 第二下：把手此刻已在屏上 ⇒ 同一像素 `pickHandle` 命中，`onPointerDown` 在同一趟里
  // `select` 再装填 `drag` ⇒ 临时线上屏（`previewPx > 20`）。这一发只 `mouseDown` 不松开，
  // 让第 2、3 步的 move/release 接着这串拖拽跑下去。
  // 先 `movePx` 到同一像素再按下：真实拖拽本来就是"光标先移到把手上再按"，而合成事件里
  // 同一坐标的裸 mouseDown（上一次 mouseUp 之后没移动过）不保证再产生一发 pointerdown ——
  // 实测：不 move 直接按第二下，`onPointerDown` 不触发，`previewPx` 恒 0。
  await movePx(win, edit.fromPx, origin);
  await pressPx(win, edit.fromPx, origin);
  const pressed = await waitUntil(
    `按下把手后没选中 ${edit.wallId} 或把手没上屏`,
    () => readEditReport(win, '按下后'),
    (r) =>
      r.selectedIds.length === 1 &&
      r.selectedIds[0] === edit.wallId &&
      r.handlePx > 20 &&
      r.previewPx > 20,
  );

  // 2) 中途：临时线要**跟着光标**，真源一个字都不许写。
  //    取两枚整像素的中点并取整：偏移至少 600mm（≈ 75px），指针一定离开起点。
  const midPx = {
    x: Math.round((edit.fromPx.x + edit.toPx.x) / 2),
    y: Math.round((edit.fromPx.y + edit.toPx.y) / 2),
  };
  await movePx(win, midPx, origin);
  // 这一发也必须 `waitUntil` 而不是直读：`pointermove` 进 renderer → React 重渲 → effect 重画，
  // 全在事件循环里排队，`executeJavaScript` 早到一步读到的就是**上一帧**。
  // 等的只有"光标那一撮有像素"：真源动没动是下面两道 throw 的活，别让等待替它们说话。
  const during = await waitUntil(
    `拖拽中临时线没跟到光标 (${String(midPx.x)}, ${String(midPx.y)})：` +
      '要么画家画的终点不是光标，要么 `drag` 没进 paint effect 的依赖',
    () => readEditReport(win, '拖动中'),
    (r) =>
      r.previewNearCursorPx > 0 &&
      // 只数 `previewNearCursorPx` 是**自洽**的：它量的是 store 自报的光标，光标落后一帧
      // 时那撮像素照样跟着落后光标走，照样绿。这里额外要求 store 的光标 == 我发出去的那个像素，
      // 于是"指针到底到没到位"由发送方判，不由被观察方自证。
      r.dragCursorPx !== null &&
      Math.abs(r.dragCursorPx.x - midPx.x) <= 0.5 &&
      Math.abs(r.dragCursorPx.y - midPx.y) <= 0.5,
  );
  const midMm = mmOf(during, edit.pointId, '拖动中');
  if (during.depth !== start.depth || during.revision !== start.revision) {
    throw new Error(
      `拖拽中途就写了真源：depth ${String(start.depth)}→${String(during.depth)}，` +
        `revision ${String(start.revision)}→${String(during.revision)}`,
    );
  }
  if (midMm.x !== atStart.x || midMm.y !== atStart.y) {
    throw new Error(
      `拖拽中途坐标就变了：(${String(atStart.x)}, ${String(atStart.y)}) → (${String(midMm.x)}, ${String(midMm.y)})`,
    );
  }
  process.stdout.write(
    `中途：previewPx=${String(during.previewPx)} nearMid=${String(during.previewNearCursorPx)} ` +
      `depth=${String(during.depth)}\n`,
  );

  // 3) 松手：落点必须逐字等于探针给的那对毫米。
  //    探针的 targetMm 是"取整像素反算回来的毫米"（`snapPx` → `moveTargetOf`），
  //    renderer 松手时算的是同一个纯函数的同一个入参 ⇒ 这里不许有 ±1mm 的"差不多"。
  await movePx(win, edit.toPx, origin);
  await waitDragAt(
    win,
    (r) =>
      r.dragTargetMm !== null &&
      r.dragTargetMm.x === edit.targetMm.x &&
      r.dragTargetMm.y === edit.targetMm.y,
    `要 (${String(edit.targetMm.x)}, ${String(edit.targetMm.y)})，最后一发 pointermove 没进 store`,
  );
  await releasePx(win, edit.toPx, origin);
  const dropped = await waitUntil(
    `松手后没落到 (${String(edit.targetMm.x)}, ${String(edit.targetMm.y)})，` +
      '或者屏幕上残留/该有的是错的（谓词含 previewPx === 0 与 handlePx > 20）',
    () => readEditReport(win, '松手后'),
    (r) => {
      const mm = r.points[edit.pointId];
      return (
        mm !== undefined &&
        mm.x === edit.targetMm.x &&
        mm.y === edit.targetMm.y &&
        r.depth === start.depth + 1 &&
        r.revision === start.revision + 1 &&
        r.previewPx === 0 &&
        r.handlePx > 20
      );
    },
  );
  const drop = dropped.lastDrop;
  if (drop === null || drop.outcome !== 'ok') {
    throw new Error(`松手后 lastDrop 不是 ok：${JSON.stringify(drop)}`);
  }

  // 4) 压扁：从落点拖回**这面墙自己的锚点**。锚点在上一发里没动过，所以 anchorPx 依然有效；
  //    此刻选中集只有这一面墙 ⇒ 两个把手分别在 toPx 与 anchorPx（相距 ≥ 墙厚 240mm ≈ 31px），
  //    按在 toPx 上不可能认错。取整反算的毫米离锚点不到 1 像素（≈ 8mm）⇒ 必然撞几何守卫。
  //    与第 2 步同形：先 `movePx` 再 `pressPx`。第 3 步的 `releasePx` 就落在**同一个** toPx 上，
  //    "上一次 mouseUp 之后没移动过就 mouseDown"在第 1 步实测过是不保证再产生 pointerdown 的 ——
  //    这里两者坐标还相同，正是那条教训描述的形状。`movePx` 在无 drag 时于 renderer 是 no-op，不写真源。
  await movePx(win, edit.toPx, origin);
  await pressPx(win, edit.toPx, origin);
  await movePx(win, edit.anchorPx, origin);
  // 同上：这一发要的是"目标已经离开刚落点"，等不到就红在松手之前，而不是红在
  // 「压扁拖没被拒」（那一句会把真病因——没跟到的 move——读成"守卫没拦住"）。
  await waitDragAt(
    win,
    (r) =>
      r.dragTargetMm !== null &&
      (r.dragTargetMm.x !== edit.targetMm.x || r.dragTargetMm.y !== edit.targetMm.y),
    `要离开 (${String(edit.targetMm.x)}, ${String(edit.targetMm.y)}) 往锚点 (${String(
      edit.anchorPx.x,
    )}, ${String(edit.anchorPx.y)}) 走，最后一发 pointermove 没进 store`,
  );
  await releasePx(win, edit.anchorPx, origin);
  const crushed = await waitUntil(
    '压扁拖没被拒：lastError 一直是空的',
    () => readEditReport(win, '压扁后'),
    (r) => r.lastError !== null,
  );
  // `waitUntil` 的谓词替不了类型收窄：返回的报告里 `lastError` 仍是 `string | null`。
  // 这里显式读回并判空，与 `waitKeyApplied` 对 `lastKeyEvent` 做的事同形。
  const crushError = crushed.lastError;
  if (crushError === null) {
    throw new Error('不可达：waitUntil 判定 lastError 非空后读回 null（压扁后）');
  }
  if (!/轴长|零长/.test(crushError)) {
    throw new Error(`压扁拖报错但不像几何守卫：${crushError}`);
  }
  const crushMm = mmOf(crushed, edit.pointId, '压扁后');
  const dropMm = mmOf(dropped, edit.pointId, '松手后');
  if (
    crushed.depth !== dropped.depth ||
    crushed.revision !== dropped.revision ||
    crushMm.x !== dropMm.x ||
    crushMm.y !== dropMm.y
  ) {
    // 计划 2 转下游 #11 的落地凭据就在这一条：命令抛了 ⇒ 真源、revision、撤销栈三者都不许动。
    throw new Error(
      `失败的拖拽留了痕迹：depth ${String(dropped.depth)}→${String(crushed.depth)}，` +
        `revision ${String(dropped.revision)}→${String(crushed.revision)}`,
    );
  }
  const crushDrop = crushed.lastDrop;
  if (crushDrop === null || crushDrop.outcome !== 'failed') {
    throw new Error(`压扁拖的 lastDrop 不是 failed：${JSON.stringify(crushDrop)}`);
  }
  process.stdout.write(`被拒：${crushError.slice(0, 80)}\n`);

  // 5) Ctrl+Z 回到拖动前，且选中集不许跟着撤销走。
  const beforeUndo = await readEditReport(win, '撤销前');
  await keyCombo(win, 'Z', ['ctrl']);
  const undoKey = await waitKeyApplied(win, beforeUndo, 'Ctrl+Z');
  const undid = await waitUntil(
    `撤销后没回到 (${String(atStart.x)}, ${String(atStart.y)})，` +
      '或者选中集跟着撤销走了（谓词含 selectedIds 仍是那面墙）',
    () => readEditReport(win, '撤销后'),
    (r) => {
      const mm = r.points[edit.pointId];
      return (
        mm !== undefined &&
        mm.x === atStart.x &&
        mm.y === atStart.y &&
        r.depth === start.depth &&
        r.revision === beforeUndo.revision + 1 &&
        r.selectedIds.length === 1 &&
        r.selectedIds[0] === edit.wallId
      );
    },
  );
  if (undoKey.combo !== 'Ctrl+Z') throw new Error(`撤销读到的是另一发快捷键：${undoKey.combo}`);

  // 6) Ctrl+Shift+Z 回到落点，并把上一发失败留下的中文错误抹掉（redo 成功 ⇒ 清 lastError）。
  const beforeRedo = await readEditReport(win, '重做前');
  await keyCombo(win, 'Z', ['ctrl', 'shift']);
  const redoKey = await waitKeyApplied(win, beforeRedo, 'Ctrl+Shift+Z');
  const redid = await waitUntil(
    `重做后没回到 (${String(edit.targetMm.x)}, ${String(edit.targetMm.y)})`,
    () => readEditReport(win, '重做后'),
    (r) => {
      const mm = r.points[edit.pointId];
      return (
        mm !== undefined &&
        mm.x === edit.targetMm.x &&
        mm.y === edit.targetMm.y &&
        r.depth === start.depth + 1 &&
        r.lastError === null
      );
    },
  );
  if (redoKey.combo !== 'Ctrl+Shift+Z') {
    throw new Error(`重做读到的是另一发快捷键：${redoKey.combo}`);
  }

  // 7) 原地按下即松手：D4 的零移动不发命令 ⇒ 撤销栈一步都不许多。
  //    先 `movePx` 再 `pressPx`（第 2 步那条实测教训），再等 store 里真的起了 `drag`：
  //    没有这一句 witnesses，"按下没触发"会一路走到 `lastDrop` 还是上一发的 'failed'，
  //    红是红了，红的却是一句"没给出 noop 诊断"——症状在下游，病根在这一发没落到屏上。
  await movePx(win, edit.toPx, origin);
  await pressPx(win, edit.toPx, origin);
  await waitUntil(
    '原地按下没起拖：store 里没有 drag ⇒ 这一发 pointerdown 根本没进 renderer',
    () => readEditReport(win, '原地按下后'),
    (r) => r.dragTargetMm !== null,
  );
  await releasePx(win, edit.toPx, origin);
  const nooped = await waitUntil(
    '原地松手没给出 noop 诊断，或撤销栈被空操作污染了',
    () => readEditReport(win, '原地松手后'),
    (r) => r.lastDrop !== null && r.lastDrop.outcome === 'noop' && r.depth === redid.depth,
  );

  // 8) 重做栈此时是空的（第 6 步已经把那一发取走，第 7 步没入栈）。
  //    再按一次 Ctrl+Shift+Z：不许静默，要有中文反馈，且真源一个字节都不动。
  const beforeEmpty = await readEditReport(win, '空栈重做前');
  await keyCombo(win, 'Z', ['ctrl', 'shift']);
  const emptyRedoKey = await waitKeyApplied(win, beforeEmpty, '空栈 Ctrl+Shift+Z');
  const emptyRedo = await waitUntil(
    '空重做栈没给出反馈',
    () => readEditReport(win, '空栈重做后'),
    (r) =>
      r.lastError !== null &&
      r.depth === beforeEmpty.depth &&
      r.revision === beforeEmpty.revision,
  );
  if (emptyRedo.lastError !== '没有可重做的操作') {
    throw new Error(`空重做栈的反馈不是那句中文：${String(emptyRedo.lastError)}`);
  }
  if (emptyRedoKey.combo !== 'Ctrl+Shift+Z') {
    throw new Error(`空栈重做读到的是另一发快捷键：${emptyRedoKey.combo}`);
  }

  const finalReport = {
    ...emptyRedo,
    // 探针与第 0 步的读数必须留档：后面的判据拿它们跟真源对账。
    edit,
    xAtStart: atStart.x,
    yAtStart: atStart.y,
    depthAtStart: start.depth,
    revisionAtStart: start.revision,
    canUndoAtStart: start.canUndo,
    selectedAfterClick: selected.selectedIds[0] ?? null,
    handlePxAfterClick: selected.handlePx,
    previewPxAfterClick: selected.previewPx,
    selectedAfterPress: pressed.selectedIds[0] ?? null,
    selectedPxAfterPress: pressed.selectedPx,
    handlePxAfterPress: pressed.handlePx,
    previewPxAfterPress: pressed.previewPx,
    xDuringDrag: midMm.x,
    yDuringDrag: midMm.y,
    depthDuringDrag: during.depth,
    revisionDuringDrag: during.revision,
    canUndoDuringDrag: during.canUndo,
    previewPxDuringDrag: during.previewPx,
    previewNearMidPx: during.previewNearCursorPx,
    xAfterDrop: dropMm.x,
    yAfterDrop: dropMm.y,
    depthAfterDrop: dropped.depth,
    revisionAfterDrop: dropped.revision,
    previewPxAfterDrop: dropped.previewPx,
    handlePxAfterDrop: dropped.handlePx,
    dropOutcomeAfterDrop: drop.outcome,
    xAfterCrush: crushMm.x,
    yAfterCrush: crushMm.y,
    depthAfterCrush: crushed.depth,
    revisionAfterCrush: crushed.revision,
    lastErrorAfterCrush: crushed.lastError,
    dropOutcomeAfterCrush: crushDrop?.outcome ?? null,
    xAfterUndo: mmOf(undid, edit.pointId, '撤销后').x,
    yAfterUndo: mmOf(undid, edit.pointId, '撤销后').y,
    depthAfterUndo: undid.depth,
    revisionAfterUndo: undid.revision,
    selectedAfterUndo: undid.selectedIds[0] ?? null,
    comboAfterUndo: undoKey.combo,
    xAfterRedo: mmOf(redid, edit.pointId, '重做后').x,
    yAfterRedo: mmOf(redid, edit.pointId, '重做后').y,
    depthAfterRedo: redid.depth,
    comboAfterRedo: redoKey.combo,
    lastErrorAfterRedo: redid.lastError,
    dropOutcomeAfterNoop: nooped.lastDrop?.outcome ?? null,
    depthAfterNoop: nooped.depth,
    revisionAfterNoop: nooped.revision,
    comboAfterEmptyRedo: emptyRedoKey.combo,
    lastErrorAfterEmptyRedo: emptyRedo.lastError,
    depthAfterEmptyRedo: emptyRedo.depth,
    revisionAfterEmptyRedo: emptyRedo.revision,
  };
  writeFileSync(out, `${JSON.stringify(finalReport, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(finalReport)}\n`);
}

type ToolShape = 'select' | 'wall';
type SnapKindShape = 'endpoint' | 'midpoint' | 'foot' | 'ortho' | 'angle15';
type DeleteOutcomeShape = 'ok' | 'empty' | 'ignored-in-wall-mode' | 'unsupported';

interface SnapShape {
  kind: SnapKindShape;
  pointId: string | null;
  mm: MmShape;
  distPx: number;
}

/** 与 renderer 的 `DraftPoint` 对齐：`px` 是**按下处**，`snap.mm` 是**落点**（E23 的那两个值）。 */
interface DraftPointShape {
  mm: MmShape;
  px: ClickPoint;
  snap: SnapShape | null;
}

interface DropTargetShape {
  raw: MmShape;
  mm: MmShape;
  snap: SnapShape | null;
}

interface DraftShape {
  storeyId: string;
  start: DraftPointShape;
  cursorPx: ClickPoint;
  end: DropTargetShape;
  legal: boolean;
}

interface CreateShape {
  outcome: 'ok' | 'rejected' | 'failed';
  wallId: string | null;
  startId: string | null;
  endId: string | null;
  endMm: MmShape | null;
  pointCountBefore: number;
  pointCountAfter: number;
}

interface HotkeyShape {
  seq: number;
  combo: string;
  tool: ToolShape;
  draftActive: boolean;
  deleteOutcome: DeleteOutcomeShape | null;
  depth: number;
  revision: number;
  lastError: string | null;
}

/** 与 `WallProbe` 逐字段对齐：主进程只读它，不猜坐标（`pxPerMm` 住在 renderer）。 */
interface WallProbeShape {
  startPx: ClickPoint;
  startMm: MmShape;
  startPointId: string;
  endPx: ClickPoint;
  endMm: MmShape;
  midPx: ClickPoint;
  lengthMm: number;
  defaults: { thicknessMm: number; heightMm: number };
}

interface DrawReportShape extends EditReportShape {
  tool: ToolShape;
  draft: DraftShape | null;
  snapMarkPx: number;
  lastCreate: CreateShape | null;
  deletedIds: string[];
  unsupportedIds: string[];
  selectionAfterDelete: string[];
  lastHotkey: HotkeyShape | null;
  draw: WallProbeShape | null;
}

function drawShotRequested(): boolean {
  return process.argv.includes('--draw-shot');
}

async function readDrawReport(win: BrowserWindow, label: string): Promise<DrawReportShape> {
  const value = (await win.webContents.executeJavaScript('window.__dajiaDebug()')) as
    | DrawReportShape
    | undefined;
  if (value === undefined) {
    throw new Error(`__dajiaDebug() 没返回报告（${label}）—— renderer 死了，不是"还没刷完"`);
  }
  return value;
}

/**
 * 点数的唯一真值来源是 `points` 快照的键集合（renderer 的 `pointCountOf` 同一口径，**不数第二遍语义**）。
 * 这里不读 `lastCreate.pointCountBefore/After`：那两个数只在松手那一发有值，而撤销 / 重做 / 删除
 * 三步的账要靠**当前快照**问 —— 两处各数一遍必然漂，所以判据只认这一个函数。
 */
function pointCountOf(report: DrawReportShape, label: string): number {
  const n = Object.keys(report.points).length;
  if (n === 0) throw new Error(`${label}：points 快照是空的，样例房没了还是 renderer 没起来`);
  return n;
}

async function clickPx(win: BrowserWindow, p: ClickPoint, origin: ViewportPx): Promise<void> {
  await pressPx(win, p, origin);
  await releasePx(win, p, origin);
}

/**
 * 快捷键回声的等待：`seq` 必须变大，**且** `combo` 必须是这一发。
 * 少了 `seq` 这一条，第 9 步那发 `Delete` 若根本没进 renderer，会读到上一发（`W`）的回声然后判过；
 * 少了 `combo`，"回声的是哪一发"就无从判断 —— 与 T5 的 `waitKeyApplied` 同一条 D8 纪律，
 * 只是这里读的是 `lastHotkey`（撤销/重做那一发不碰工具态，两类快捷键各一份回声）。
 */
async function waitHot(
  win: BrowserWindow,
  before: DrawReportShape,
  combo: string,
  label: string,
): Promise<HotkeyShape> {
  const report = await waitUntil(
    `快捷键没生效（${label}）：renderer 的 keydown 没跑到`,
    () => readDrawReport(win, label),
    (r) => r.lastHotkey !== null && r.lastHotkey.seq > (before.lastHotkey?.seq ?? 0),
  );
  const hot = report.lastHotkey;
  if (hot === null) throw new Error(`不可达：waitUntil 判定非空后读回 null（${label}）`);
  if (hot.combo !== combo) {
    throw new Error(`${label}：读到的是另一发快捷键 ${hot.combo}，期望 ${combo}`);
  }
  return hot;
}

/**
 * 十六步（0…15）加一发 addendum A3 的星形接头（三发墙：横、竖两发预备 + 一发 45° 斜臂）。
 * **整条序列必须把文档送回基线几何**：
 * `desktop-shot.mjs` 前六条判据读的是最后落盘的那一份报告（`ops === 31` 等），所以第 8 步建的
 * 那面墙要在第 12 步删掉、第 13/14 步各撤销与重做一次，终态停在"已删除"的基线上。
 * （第 16 步那三发留在文档里不要紧：写盘的那份报告 spread 的是第 15 步 `fin` 的基线读数。）
 *
 * 坐标一个都不硬编码：三发像素、两对毫米、厚度与墙高全部来自第 0 步读到的探针。
 * 探针**只在第 0 步取一次**并留档 —— 它是每次调用现算的（文档一变就换靶子），
 * 后面再问一次会拿到"建了一面墙之后的场"里挑出的另一发。
 *
 * 每一步的读数存成独立 const，最后一起写盘：TS 的使用先于声明会替我们守住
 * "少跑一步就编译不过"（与 `runEditShot` 同一条纪律）。
 *
 * 第 16 步（addendum A3 那一发）用的角点是**现造**的：起点取同一次读数里的 `pick.blankPx`，
 * 边长由第 0 步探针给的 px↔mm 比例换算 —— 不再从 `edit` / `draw` 那两枚探针里挑既有角点，
 * 因为那两枚都是按 uuid 序抽签抽出来的，吸得上吸不上看视口相位（根因写在第 16 步的注释里）。
 */
async function runDrawShot(win: BrowserWindow, out: string): Promise<void> {
  await whenLoaded(win);
  await waitForDebug(win);
  // 与 runEditShot 同一条通路：合成输入要求 OS 前台焦点（focusForInput 会等，等不到就抛），
  // 探针像素还必须等布局停下来之后再取（窗口 show/focus 后自己还会改尺寸，见 waitForLayoutSettled）。
  await focusForInput(win);
  await waitForLayoutSettled(win);

  // 0) 起始读数 + 探针。
  const start = await readDrawReport(win, '起始');
  const origin = start.canvasOriginPx;
  const probe = start.draw;
  if (probe === null) {
    throw new Error('探针给不出可画的空白落点 —— 样例房或视口改过了，先重跑 wallProbe 的六道筛');
  }
  const probeJson = JSON.stringify(probe);
  const basePoints = pointCountOf(start, '起始');
  if (start.snapMarkPx !== 0) {
    throw new Error(`起始没有草稿也没有拖拽，第四色应当恒 0，实测 ${String(start.snapMarkPx)}`);
  }
  if (start.tool !== 'select' || start.draft !== null) {
    throw new Error('起始状态不是"选择模式、无草稿"');
  }

  // 1) W 进拉墙。
  await keyCombo(win, 'W', []);
  const afterW = await waitHot(win, start, 'W', '按 W 之后');
  if (afterW.tool !== 'wall') throw new Error(`W 没把工具切到 wall：${afterW.tool}`);
  if (afterW.draftActive) throw new Error('按 W 不该顺手起草稿');
  if (afterW.depth !== start.depth) throw new Error('按 W 动了真源');

  // 2) 在既有端点上按下：草稿起来、起点吸上那枚点、零长 ⇒ 不合法。
  await pressPx(win, probe.startPx, origin);
  const pressed = await waitUntil(
    '按下起点没起草稿',
    () => readDrawReport(win, '按下起点后'),
    (r) => r.draft !== null,
  );
  const draft0 = pressed.draft;
  if (draft0 === null) throw new Error('不可达：waitUntil 判定非空后读回 null（按下起点后）');
  const startSnap = draft0.start.snap;
  if (startSnap === null || startSnap.kind !== 'endpoint') {
    throw new Error(`起点必须吸到端点档，实测 ${String(startSnap?.kind)}`);
  }
  if (startSnap.pointId !== probe.startPointId) throw new Error('起点吸上的不是探针指的那枚点');
  if (JSON.stringify(draft0.start.px) !== JSON.stringify(probe.startPx)) {
    throw new Error('按下处的像素与探针给的像素不是同一发');
  }
  if (draft0.legal) throw new Error('零长草稿不该合法（S4 ①：按下不吸方向档，长度也没出来）');
  if (pressed.snapMarkPx === 0) {
    throw new Error('起点吸上了既有端点，第四色标记却没画出来');
  }

  // 3) 移到探针终点：落点毫米逐字等于探针给的那对，标记仍在，真源一个字没动。
  await movePx(win, probe.endPx, origin);
  const moved = await waitUntil(
    '移到探针终点后落点没对上',
    () => readDrawReport(win, '移到终点后'),
    (r) => r.draft !== null && JSON.stringify(r.draft.end.mm) === JSON.stringify(probe.endMm),
  );
  const draft1 = moved.draft;
  if (draft1 === null) throw new Error('不可达：移到终点后草稿没了');
  if (!draft1.legal) throw new Error('探针说过合法的落点，屏幕上判不合法');
  const endSnap = draft1.end.snap;
  if (endSnap === null) {
    throw new Error('方向档必命中：探针偏移全是轴对齐或 45°（位移只剩量化往返残差，实测 0.33 / 0.45px）');
  }
  if (endSnap.pointId !== null) {
    throw new Error(`终点引了别人的点（${endSnap.pointId}），与筛 ② 矛盾`);
  }
  if (draft1.cursorPx.x !== probe.endPx.x || draft1.cursorPx.y !== probe.endPx.y) {
    throw new Error('草稿的裸光标不是探针那一发像素（临时线该画到这里）');
  }
  if (moved.previewNearCursorPx === 0) {
    throw new Error('临时线没跟到光标（S4 第三条纪律）');
  }
  if (moved.snapMarkPx === 0) {
    throw new Error('落点吸上了却没有第四色标记 —— 用户只会觉得"拖不到想去的地方"');
  }
  if (moved.depth !== start.depth || moved.revision !== start.revision) {
    throw new Error('中途把草稿写进真源了（D4）');
  }
  if (pointCountOf(moved, '移到终点后') !== basePoints) throw new Error('中途点数变了 —— 半途建墙');

  // 4) Escape 取消：草稿没了、标记也没了，账一步都不许多。
  const beforeEsc = await readDrawReport(win, '取消前');
  await keyCombo(win, 'Escape', []);
  const afterEsc = await waitHot(win, beforeEsc, 'Escape', '按 Escape 之后');
  if (afterEsc.draftActive) throw new Error('Escape 没取消草稿');
  if (afterEsc.tool !== 'wall') throw new Error('有草稿时 Escape 只该取消草稿，不该退出拉墙模式');
  const cancelled = await waitUntil(
    '取消后标记或账没回到原样',
    () => readDrawReport(win, '取消读数'),
    (r) => r.snapMarkPx === 0 && r.draft === null && r.depth === beforeEsc.depth,
  );
  if (pointCountOf(cancelled, '取消读数') !== basePoints) throw new Error('取消一次草稿留下了点');
  const depthAtCancel = cancelled.depth;

  // 5) 原地按下即松手：预言不合法 ⇒ 一条命令都不发（`rejected` 那一支）。
  await pressPx(win, probe.startPx, origin);
  await releasePx(win, probe.startPx, origin);
  const rejected = await waitUntil(
    '原地松手没给出 rejected 回执',
    () => readDrawReport(win, '原地松手后'),
    (r) => r.lastCreate !== null && r.lastCreate.outcome === 'rejected',
  );
  const rej = rejected.lastCreate;
  if (rej === null) throw new Error('不可达：rejected 分支读不到回执');
  if (rej.wallId !== null || rej.startId !== null || rej.endId !== null) {
    throw new Error('被拒的一发不该留下任何 id');
  }
  if (rej.pointCountBefore !== rej.pointCountAfter) throw new Error('被拒的一发多了点');
  if (rejected.depth !== depthAtCancel) throw new Error('被拒的一发入了栈');

  // 6) 第二次按下起点 —— 与第 2 步同一发像素，这次不松手。
  await pressPx(win, probe.startPx, origin);
  const pressed2 = await waitUntil(
    '第二次按下没起草稿',
    () => readDrawReport(win, '第二次按下'),
    (r) => r.draft !== null,
  );

  // 7) 移到终点
  await movePx(win, probe.endPx, origin);
  const moved2 = await waitUntil(
    '第二次移动落点没对上',
    () => readDrawReport(win, '第二次移到终点'),
    (r) => r.draft !== null && JSON.stringify(r.draft.end.mm) === JSON.stringify(probe.endMm),
  );

  // 8) 松手建墙：点数 +1、起点复用探针那枚点、新建即选中。
  await releasePx(win, probe.endPx, origin);
  const built = await waitUntil(
    '松手没建出墙',
    () => readDrawReport(win, '松手建墙后'),
    (r) => r.lastCreate !== null && r.lastCreate.outcome === 'ok',
  );
  const builtCreate = built.lastCreate;
  if (builtCreate === null) throw new Error('不可达：建墙分支读不到回执');
  if (builtCreate.startId !== probe.startPointId) {
    throw new Error('新建的墙没有与既有墙共享起点 —— 接头全断（S7）');
  }
  if (JSON.stringify(builtCreate.endMm) !== JSON.stringify(probe.endMm)) {
    throw new Error('回执落点与探针预言不一致');
  }
  if (builtCreate.pointCountAfter !== basePoints + 1) {
    throw new Error(
      `一面全新终点的墙应恰好多一枚点：${String(basePoints)} → ${String(builtCreate.pointCountAfter)}`,
    );
  }
  const newWallId = builtCreate.wallId;
  if (newWallId === null || !built.selectedIds.includes(newWallId)) {
    throw new Error('新建即选中没生效（S6）');
  }
  if (built.selectedPx < 100) throw new Error(`选中红像素太少：${String(built.selectedPx)}`);
  if (built.tool !== 'wall') throw new Error('建完一面墙不该自动退出拉墙模式');
  const builtPoints = pointCountOf(built, '松手建墙后');

  // 9) 拉墙模式下按 Delete：四色之一的"故意沉默"。
  const beforeWallDel = await readDrawReport(win, '拉墙模式删除前');
  await keyCombo(win, 'Delete', []);
  const ignored = await waitHot(win, beforeWallDel, 'Delete', '拉墙模式下按 Delete');
  const ignoredReport = await readDrawReport(win, '拉墙删除后');
  if (ignored.deleteOutcome !== 'ignored-in-wall-mode') {
    throw new Error(`拉墙模式的删除沉默读成 ${String(ignored.deleteOutcome)}`);
  }
  if (ignoredReport.depth !== beforeWallDel.depth) throw new Error('拉墙模式下的删除发了命令');
  if (pointCountOf(ignoredReport, '拉墙删除后') !== builtPoints) throw new Error('拉墙模式下的删除动了点');

  // 10) Escape 退出拉墙（此时没有草稿 ⇒ 回到 select）。
  const beforeExit = await readDrawReport(win, '退出拉墙前');
  await keyCombo(win, 'Escape', []);
  const exited = await waitHot(win, beforeExit, 'Escape', '按 Escape 退出拉墙');
  if (exited.tool !== 'select') throw new Error(`Escape 没退回 select：${exited.tool}`);

  // 11) 点新墙中点：筛 ④ 保证那里建墙前一片空白，所以现在命中的只可能是新墙。
  await clickPx(win, probe.midPx, origin);
  const clicked = await waitUntil(
    '点不中新墙（筛 ③ 的像素下限在真窗口里失效）',
    () => readDrawReport(win, '点新墙后'),
    (r) => r.selectedIds.length === 1 && r.selectedIds[0] === newWallId,
  );
  if (clicked.selectedPx < 100) throw new Error(`点中了但屏幕上没有红色像素：${String(clicked.selectedPx)}`);
  if (clicked.handlePx === 0) throw new Error('回到 select 了却没画把手');

  // 12) Backspace 删除：墙与它的孤儿点一起消失，选中集剪枝成空。
  const beforeDel = await readDrawReport(win, '删除前');
  await keyCombo(win, 'Backspace', []);
  const delHot = await waitHot(win, beforeDel, 'Backspace', '按 Backspace 删除');
  if (delHot.deleteOutcome !== 'ok') throw new Error(`删除读成 ${String(delHot.deleteOutcome)}`);
  const deleted = await waitUntil(
    '删除后账没回到基线',
    () => readDrawReport(win, '删除后'),
    (r) => pointCountOf(r, '删除后') === basePoints && r.selectionAfterDelete.length === 0,
  );
  if (deleted.deletedIds.length !== 1 || deleted.deletedIds[0] !== newWallId) {
    throw new Error(`deletedIds 不是那一面墙：${JSON.stringify(deleted.deletedIds)}`);
  }
  if (deleted.unsupportedIds.length !== 0) {
    throw new Error(`样例房里不该有 unsupported 构件：${JSON.stringify(deleted.unsupportedIds)}`);
  }

  // 13) Ctrl+Z：墙连同它那枚孤儿点一起回来（撤销不恢复选中 —— D7）。
  const beforeUndo = await readDrawReport(win, '撤销前');
  await keyCombo(win, 'Z', ['ctrl']);
  const undoKey = await waitKeyApplied(win, beforeUndo, '撤销');
  const undid = await waitUntil(
    '撤销没把墙和它的点带回来',
    () => readDrawReport(win, '撤销后'),
    (r) => pointCountOf(r, '撤销后') === basePoints + 1,
  );
  if (undid.selectedIds.includes(newWallId)) throw new Error('撤销把选中也恢复了（D7 说不许）');

  // 14) Ctrl+Shift+Z：再删回去，序列停在基线几何上。
  const beforeRedo = await readDrawReport(win, '重做前');
  await keyCombo(win, 'Z', ['ctrl', 'shift']);
  const redoKey = await waitKeyApplied(win, beforeRedo, '重做');
  const redid = await waitUntil(
    '重做没把墙再删掉',
    () => readDrawReport(win, '重做后'),
    (r) => pointCountOf(r, '重做后') === basePoints,
  );

  // 15) 终态：几何回到第 0 步，探针重新算出的靶子与第 0 步**逐字相同**。
  //     这一句是整个序列"没留痕"的总账，也是前六条基线判据能继续读最后一份报告的前提。
  const fin = await waitUntil(
    '终态探针没回到基线靶子',
    () => readDrawReport(win, '终态'),
    (r) => r.draw !== null && JSON.stringify(r.draw) === probeJson,
  );
  if (JSON.stringify(fin.points) !== JSON.stringify(start.points)) {
    throw new Error('终态的 points 快照与起始不同 —— 序列改写了基线几何');
  }
  if (fin.tool !== 'select' || fin.draft !== null) throw new Error('终态没回到"选择模式、无草稿"');
  if (fin.snapMarkPx !== 0) throw new Error('终态还留着吸附标记');

  // 16) addendum A3 那一发（十六步之外的正式判据）：把一枚角点逼成**三臂星形**接头，看 F1 那张
  //     兜网接不接得住。星形接头在 `buildDrawList` 里抛 RangeError（`joint.ts` 的 `kindOf` 那一支
  //     "画不出来：…3 个墙端、3 个方向…"），F1 之前这一发是 dispatch 成功 ⇒ React 树整个卸掉、
  //     `__dajiaDebug` 随之没掉（实测 48/48 发全抛，证据 scratch-star-gesture.test.txt）；F1 之后
  //     要的形状是两条读数：报告还读得回来（`starAppAlive`）+ lastError 非空且走"画不出来"那一路。
  //     斜墙与两发预备墙都留在文档里：写盘的报告 spread 的是 `fin`（第 15 步的基线读数），
  //     基线六条不受影响。Task 7 落地 `assertDerivesAfterApply` 后这条判据的语义要改成
  //     "两边都不许写进真源"（已登记给 T7）。
  //     —— 为什么不"按在样例房某枚既有角点上、±1px 找吸得上的那一发"了事（run3 / run6 两轮红的根因）：
  //     能当锚点的共享端点是 dragProbe / wallProbe 各自按 **id 的代码单元序**挑的（handles.ts:117 与
  //     `snapFieldOf` 的 `byKind('wall')`），而 id 是每次开机重造的 uuidv7 ⇒ 每一发闸门抽到哪枚角点
  //     是随机的。"按下吸不吸得上那枚端点"比的是 distPx：端点住在轴线上，垂足是光标到那段轴线
  //     **线段**的正投影 ⇒ 按构造垂足永不比端点远（wallProbe 筛 ① 记过同一件事，editing.ts:365），
  //     只有两者**逐字并列**才轮到档位优先级（`PRIORITY.endpoint = 0 < foot = 2`）。二臂直角的
  //     "背离象限"里两枚垂足都出界 ⇒ 恒吸端点；三臂及以上每一臂都贡献一枚"出界即止"的垂足 ⇒ 环扫
  //     只在"按下像素的量化毫米恰好落回角点坐标"那一列/那一行成立（1px ≈ 8.4mm，有没有那一列纯看
  //     窗口宽高的相位）：run3 抽中的就是没有的那一种，九发全吸成 foot。run6 换按 wallProbe 起点更红
  //     —— 它常是**自由端**（实测 (7000,3000)），从自由端补的第二发只凑出二臂直角 = corner，派生得
  //     干干净净 ⇒ lastError 恒空，那张网根本没被调用。
  //     —— 这一版把它换成**不动点**问题：角点自己在画布空白角现造，三发像素全满足"这枚点的毫米
  //     就是这一发像素量化出来的"。W1 在 `pick.blankPx`（`probeTarget` 从四角里挑的离一切指令最远
  //     那一枚，恒在容差外）按下、朝画布中心横拖一枚：按下不吸任何人 ⇒ 起点毫米 = 该发像素的量化
  //     毫米（这一条当场对账，见 `不动点的前提没了`）；W2 从同一点竖拖一枚、终点吸回它 ⇒ 该点变二臂
  //     直角（corner，派生干净、不抛）；W3 再按在**同一发像素**上：端点候选与两枚垂足候选（横墙
  //     t=0、竖墙 t=length）的毫米逐字都是那枚点的毫米 ⇒ 三枚候选同点同 distPx，并列由 PRIORITY
  //     判给端点 —— 这条不比"谁更近"，比的是"同一个数"，与视口相位无关。再补第三臂（45° 斜墙）⇒
  //     三臂三方向 = star ⇒ 绘制层抛 ⇒ 走 F1 那张网。
  //     坐标一个都不硬编码：三发像素 = `pick.blankPx` 沿"朝画布中心"的两个轴向各推
  //     `STAR_EDGE_MM × pxPerMm`，比例取第 0 步探针自己给的 px↔mm 对比（`endPx - startPx` 对
  //     `lengthMm`）。
  //     `MIN_WALL_LENGTH_MM`（scene-2d 里是 500）加四成余量：短过下限会被 `legalWallCreate` 拒，
  //     长过空白角那一方又会挤进样例房的吸附半径 —— 两头都由逐步读数当场验，不靠这里算准。
  //     那个常量进不了主进程产物（`electron.vite.config.ts` 的 workspaceDeps 只把 @dajia/core 与
  //     @dajia/protocol 打进 main），所以这边抄一份；下限真涨过 700 时 W1 的 `legalAtMove` 就红。
  const STAR_EDGE_MM = 700;
  // 一发完整的"按下 → 拖到 → 松手"，把三处的读数原样带回来（三发墙共用一条通路，判据各自在
  // 调用点钉 —— 病根不同，报错的话也就不同，不能由助手替调用方下结论）。
  // 两处等待钉的都是"那一发到过 renderer"：`sendInputEvent` 不等队列（T5 的实测），所以
  // ① 松手前等目标像素落进草稿的 `cursorPx`（不等到就松手 = 用上一发光标建墙，症状在下游）；
  // ② 松手后等 `lastCreate` 换成**新的一份** —— 上一发的回执还挂在 store 上，"非空"不算数。
  interface StarWallReadout {
    readonly startSnap: SnapShape | null;
    readonly startMm: MmShape;
    readonly endSnap: SnapShape | null;
    readonly endMm: MmShape;
    readonly legalAtPress: boolean;
    readonly legalAtMove: boolean;
    readonly markAtPress: number;
    readonly markAtMove: number;
    readonly create: CreateShape;
    readonly after: DrawReportShape;
  }
  const drawStarWall = async (
    label: string,
    pressP: ClickPoint,
    targetP: ClickPoint,
    before: DrawReportShape,
  ): Promise<StarWallReadout> => {
    await pressPx(win, pressP, origin);
    const pressedR = await waitUntil(
      `${label}按下没起草稿（按下处 ${String(pressP.x)},${String(pressP.y)}）`,
      () => readDrawReport(win, `${label}按下`),
      (r) => r.draft !== null,
    );
    const d0 = pressedR.draft;
    if (d0 === null) throw new Error(`不可达：按下谓词判非空后读回 null（${label}按下）`);
    if (JSON.stringify(d0.start.px) !== JSON.stringify(pressP)) {
      throw new Error(
        `${label}按下处的像素不是发出去的那一发（屏幕另算了一套坐标）：` +
          `${JSON.stringify(d0.start.px)} ≠ ${JSON.stringify(pressP)}`,
      );
    }
    await movePx(win, targetP, origin);
    const movedR = await waitUntil(
      `${label}的拖拽没吃到目标像素（目标 ${String(targetP.x)},${String(targetP.y)}）`,
      () => readDrawReport(win, `${label}拖到目标`),
      (r) => r.draft !== null && r.draft.cursorPx.x === targetP.x && r.draft.cursorPx.y === targetP.y,
    );
    const d1 = movedR.draft;
    if (d1 === null) throw new Error(`不可达：拖拽谓词判非空后读回 null（${label}拖到目标）`);
    await releasePx(win, targetP, origin);
    const beforeCreateJson = JSON.stringify(before.lastCreate);
    const afterR = await waitUntil(
      `${label}松手之后 lastCreate 还是上一发那一份（命令没发出？回声没读回来？）`,
      () => readDrawReport(win, `${label}松手后`),
      (r) => r.lastCreate !== null && JSON.stringify(r.lastCreate) !== beforeCreateJson,
    );
    const created = afterR.lastCreate;
    if (created === null) {
      throw new Error(`不可达：waitUntil 判定 lastCreate 非空后读回 null（${label}松手后）`);
    }
    return {
      startSnap: d0.start.snap,
      startMm: d0.start.mm,
      endSnap: d1.end.snap,
      endMm: d1.end.mm,
      legalAtPress: d0.legal,
      legalAtMove: d1.legal,
      markAtPress: pressedR.snapMarkPx,
      markAtMove: movedR.snapMarkPx,
      create: created,
      after: afterR,
    };
  };
  if (fin.lastError !== null) {
    throw new Error(`斜拖之前 lastError 就非空（${fin.lastError}）—— 这一发判据分不清网接到的是谁`);
  }
  await keyCombo(win, 'W', []);
  const afterW2 = await waitHot(win, fin, 'W', '星形序列进墙模式');
  if (afterW2.tool !== 'wall') throw new Error(`星形序列前 W 没切到 wall：${afterW2.tool}`);
  // 空白角：`pick` 从 T4 起在回读通道里就是 `unknown`，这里当场验形状再用 —— 验不过就抛，
  // 不"读到什么算什么"（图铺满画布时 `probeTarget` 给 null，那一发判据就无从落下）。
  const blankProbe = fin.pick as { readonly blankPx?: ClickPoint } | null;
  const cornerPx = blankProbe?.blankPx ?? null;
  if (cornerPx === null || !Number.isInteger(cornerPx.x) || !Number.isInteger(cornerPx.y)) {
    throw new Error(
      `pick.blankPx 读不回一枚整数画布像素（画布被图铺满时探针给 null）：${JSON.stringify(fin.pick)}`,
    );
  }
  const pxPerMm =
    Math.hypot(probe.endPx.x - probe.startPx.x, probe.endPx.y - probe.startPx.y) / probe.lengthMm;
  if (!Number.isFinite(pxPerMm) || pxPerMm <= 0) {
    throw new Error(`探针那两发像素与 lengthMm 换算不出比例（${String(pxPerMm)}）—— 方形边长无所适从`);
  }
  const starEdgePx = Math.round(STAR_EDGE_MM * pxPerMm);
  // 两个轴向都往画布中心推（屏幕等比缩放 ⇒ 屏幕 45° 就是世界 45°，旧那一发的取法原样留着）。
  const sx = cornerPx.x * 2 < fin.wPx ? 1 : -1;
  const sy = cornerPx.y * 2 < fin.hPx ? 1 : -1;
  const eastPx: ClickPoint = { x: cornerPx.x + starEdgePx * sx, y: cornerPx.y };
  const southPx: ClickPoint = { x: cornerPx.x, y: cornerPx.y + starEdgePx * sy };
  const diagonalPx: ClickPoint = { x: eastPx.x, y: southPx.y };
  const squareCorners: { name: string; p: ClickPoint }[] = [
    { name: '角点', p: cornerPx },
    { name: '横臂终点', p: eastPx },
    { name: '竖臂起点', p: southPx },
    { name: '斜臂终点', p: diagonalPx },
  ];
  for (const { name, p } of squareCorners) {
    if (p.x < 0 || p.y < 0 || p.x >= fin.wPx || p.y >= fin.hPx) {
      throw new Error(
        `空白角那一方放不下边长 ${String(starEdgePx)}px 的方形（${name} ${String(p.x)},${String(p.y)} ` +
          `出画布 ${String(fin.wPx)}×${String(fin.hPx)}）—— 视口或样例房改过了`,
      );
    }
  }

  // W1：横拖一枚预备墙。两头都不许吸到既有的东西（空白角离一切指令都在容差外），
  //      终点吸的是方向档 ⇒ 两枚全新端点 ⇒ 点数 +2；角点那枚的毫米必须逐字等于按下像素的量化值，
  //      这一条就是后面两发"不动点"的前提，它不成立就说明 `pick.blankPx` 那发像素被改过。
  const w1 = await drawStarWall('预备横墙', cornerPx, eastPx, fin);
  if (w1.startSnap !== null) {
    throw new Error(
      `空白角按下了吸附（${JSON.stringify(w1.startSnap)}）—— pick.blankPx 不再空白，样例房或视口改过了`,
    );
  }
  if (w1.markAtPress !== 0) {
    throw new Error(`谁都没吸的按下却画出第四色标记（${String(w1.markAtPress)}）—— 标记与吸附不是同一份账`);
  }
  if (w1.endSnap === null || w1.endSnap.pointId !== null) {
    throw new Error(`横拖那一发的落点没吸到方向档，或引了别人的点（${JSON.stringify(w1.endSnap)}）`);
  }
  if (w1.markAtMove === 0) throw new Error('横拖吸上了却没画第四色标记');
  if (!w1.legalAtMove) {
    throw new Error(
      `预备横墙判不合法（边长 ${String(starEdgePx)}px ≈ ${String(STAR_EDGE_MM)}mm，` +
        `${String(pxPerMm)}px/mm）—— 下限涨过 ${String(STAR_EDGE_MM)} 了就改这一处`,
    );
  }
  if (w1.create.outcome !== 'ok' || w1.create.startId === null || w1.create.endId === null) {
    throw new Error(`第一发预备墙没建成：${JSON.stringify(w1.create)}`);
  }
  if (w1.create.pointCountBefore !== basePoints || w1.create.pointCountAfter !== basePoints + 2) {
    throw new Error(
      `两头全新的墙应恰好多两枚点：${String(w1.create.pointCountBefore)} → ${String(w1.create.pointCountAfter)}（基线 ${String(basePoints)}）`,
    );
  }
  if (JSON.stringify(w1.create.endMm) !== JSON.stringify(w1.endMm)) {
    throw new Error('横墙回执落点与草稿预言不是同一个数（两边各算了一套 px→mm）');
  }
  if (w1.after.lastError !== null) {
    throw new Error(
      `预备横墙就把绘制层打到报错（${w1.after.lastError}）—— 星形那一发的兜网分不清接的是哪一发`,
    );
  }
  const starCornerId = w1.create.startId;
  const cornerMm = w1.after.points[starCornerId];
  if (cornerMm === undefined) {
    throw new Error(`松手后的 points 快照里没有刚建的那枚角点（${starCornerId}）`);
  }
  if (JSON.stringify(w1.startMm) !== JSON.stringify(cornerMm)) {
    throw new Error(
      `角点的真源毫米与按下那发的量化毫米不等（${JSON.stringify(cornerMm)} ≠ ${JSON.stringify(w1.startMm)}）` +
        '—— 不动点的前提没了，后面两发不必再按',
    );
  }

  // W2：竖拖一枚、终点吸回那枚角点 ⇒ 该点凑成二臂直角（corner，派生干净 ⇒ lastError 仍空）。
  const w2 = await drawStarWall('预备竖墙', southPx, cornerPx, w1.after);
  if (w2.startSnap !== null) {
    throw new Error(`竖臂起点按下了吸附（${JSON.stringify(w2.startSnap)}）—— 空白角那一方不再空白`);
  }
  if (w2.endSnap === null || w2.endSnap.kind !== 'endpoint' || w2.endSnap.pointId !== starCornerId) {
    throw new Error(`竖墙终点没吸回刚建的那枚角点（实测 ${JSON.stringify(w2.endSnap)}）—— 星形缺一臂`);
  }
  const w2EndSnap = w2.endSnap;
  if (JSON.stringify(w2EndSnap.mm) !== JSON.stringify(cornerMm)) {
    throw new Error(
      `吸上既有端点却把它挪了毫米（${JSON.stringify(w2EndSnap.mm)} ≠ ${JSON.stringify(cornerMm)}）` +
        '—— snapping.ts 那句"直读真源，不做像素往返"漂了',
    );
  }
  if (w2.markAtMove === 0) throw new Error('竖墙终点吸上了既有端点，第四色标记却没上屏');
  if (!w2.legalAtMove) throw new Error('预备竖墙判不合法（同横墙那条下限）');
  if (w2.create.outcome !== 'ok' || w2.create.endId !== starCornerId) {
    throw new Error(`竖墙没复用那枚角点（回执 ${JSON.stringify(w2.create)}）—— 接头断了`);
  }
  if (w2.create.pointCountAfter !== basePoints + 3) {
    throw new Error(
      `竖墙只该多一枚新点（终点复用角点）：${String(w2.create.pointCountBefore)} → ${String(w2.create.pointCountAfter)}`,
    );
  }
  if (w2.after.lastError !== null) {
    throw new Error(
      `二臂直角就报错了（${w2.after.lastError}）—— 现造角点的前提不成立，星形那一发无从谈起`,
    );
  }

  // W3：再按在**同一发像素**上（端点档与两枚垂足档逐字并列 ⇒ PRIORITY 判给端点），往 45° 补第三臂。
  const w3 = await drawStarWall('星形斜墙', cornerPx, diagonalPx, w2.after);
  if (w3.startSnap === null || w3.startSnap.kind !== 'endpoint' || w3.startSnap.pointId !== starCornerId) {
    throw new Error(
      `角点重按没吸回自己（实测 ${JSON.stringify(w3.startSnap)}）—— 不动点失效，` +
        `这一发压根没落在角点上（对照 run3：吸成 foot 就是并列没成立）`,
    );
  }
  const starStartSnap = w3.startSnap;
  if (JSON.stringify(w3.startMm) !== JSON.stringify(cornerMm)) {
    throw new Error(
      `重按起点的毫米与真源那枚点不同（${JSON.stringify(w3.startMm)} ≠ ${JSON.stringify(cornerMm)}）—— 复用顺手挪了点`,
    );
  }
  if (w3.legalAtPress) throw new Error('零长草稿（刚按下还没拖）判合法 —— S4 ① 那条漂了');
  if (w3.markAtPress === 0) throw new Error('按在既有端点上却没画第四色标记');
  if (
    w3.endSnap === null ||
    (w3.endSnap.kind !== 'ortho' && w3.endSnap.kind !== 'angle15') ||
    w3.endSnap.pointId !== null
  ) {
    throw new Error(
      `45° 斜臂的落点不是方向档或引了别人的点（${JSON.stringify(w3.endSnap)}）—— ` +
        '第三臂吸到别处去的就不是这枚角点的星形',
    );
  }
  const starEndSnap = w3.endSnap;
  if (!w3.legalAtMove) {
    throw new Error(
      `斜墙草稿在屏幕上判不合法（落点 ${String(w3.endMm.x)},${String(w3.endMm.y)}）—— ` +
        '命令发不出去，F1 要测的那一发没有发生（legal 预言漂了）',
    );
  }
  if (w3.create.outcome !== 'ok' || w3.create.startId !== starCornerId) {
    throw new Error(`斜墙没复用角点（回执 ${JSON.stringify(w3.create)}）—— 第三臂没接上，star 的账不成立`);
  }
  if (w3.create.pointCountAfter !== basePoints + 4) {
    throw new Error(
      `斜墙只该多一枚新点：${String(w3.create.pointCountBefore)} → ${String(w3.create.pointCountAfter)}`,
    );
  }

  // 松手在上面已经发生，命令也真发出去了（`w3.create` 就是凭据）—— 抛的是**派生那一步**：
  // 三臂三方向的接头在 `buildDrawList` 里进 `kindOf` 的 else 支。前面两发都钉过 lastError 为空
  // （`w1.after` / `w2.after`），所以这一发等到的 non-null 只可能是星形那一抛，不存在"网接住了
  // 上一发的旧错"那种读法。绘制错误与 store 更新挨着落地，`w3.after` 那份可能已经带着错误 ——
  // 那就第一趟等待立刻返回；晚一拍也是同一句判据，不另开一条通路。
  const starred = await waitUntil(
    '三臂星形没走到画层抛错（lastError 恒空）—— 要么接头分类没抛（那是几何变了），要么网没接住',
    () => readDrawReport(win, '星形松手后'),
    (r) => r.lastError !== null,
  );
  const starError = starred.lastError;
  if (starError === null) throw new Error('不可达：waitUntil 判定 lastError 非空后读回 null（星形松手后）');
  if (!starError.includes('画不出来')) {
    throw new Error(`星形斜墙的报错不来自绘制兜网（应以"画不出来"开头）：${starError.slice(0, 80)}`);
  }
  // 读到这儿本身**就是** `__dajiaDebug` 仍在的凭据：React 树被卸掉时 readDrawReport 直接抛，
  // 走不到这一行（所以 `starAppAlive` 在写盘时恒真 —— 它不是自洽断言，是"读到了"的记录）。
  const starAppAlive = typeof starred.ops === 'number';


  const out1 = {
    ...fin,
    // ↓ 探针与逐步读数全部留档：脚本侧判据拿它们对账，改一步就少一个键。
    probeJsonAtStart: probeJson,
    basePoints,
    depthAtStart: start.depth,
    revisionAtStart: start.revision,
    toolAfterW: afterW.tool,
    depthAfterW: afterW.depth,
    startSnapKind: startSnap.kind,
    startSnapPointId: startSnap.pointId,
    pressPxMatches: JSON.stringify(draft0.start.px) === JSON.stringify(probe.startPx),
    legalAtPress: draft0.legal,
    snapMarkAtPress: pressed.snapMarkPx,
    endSnapKind: endSnap.kind,
    endSnapDistPx: endSnap.distPx,
    endSnapPointId: endSnap.pointId,
    legalAtMove: draft1.legal,
    cursorPxAtMove: draft1.cursorPx,
    previewNearCursorPx: moved.previewNearCursorPx,
    snapMarkAtMove: moved.snapMarkPx,
    depthAtMove: moved.depth,
    revisionAtMove: moved.revision,
    pointsAtMove: pointCountOf(moved, '移到终点后'),
    toolAfterEsc: afterEsc.tool,
    snapMarkAfterEsc: cancelled.snapMarkPx,
    rejectedOutcome: rej.outcome,
    rejectedWallId: rej.wallId,
    rejectedCounts: `${String(rej.pointCountBefore)}→${String(rej.pointCountAfter)}`,
    rejectedDepth: rejected.depth,
    depthAtCancel,
    pressed2Draft: pressed2.draft !== null,
    moved2Mm: moved2.draft?.end.mm ?? null,
    builtOutcome: builtCreate.outcome,
    builtWallId: newWallId,
    builtStartId: builtCreate.startId,
    builtEndId: builtCreate.endId,
    builtEndMm: builtCreate.endMm,
    builtCounts: `${String(builtCreate.pointCountBefore)}→${String(builtCreate.pointCountAfter)}`,
    builtSelectedPx: built.selectedPx,
    builtTool: built.tool,
    builtSelected: built.selectedIds.includes(newWallId),
    builtPointsBefore: builtCreate.pointCountBefore,
    builtPointsAfter: builtCreate.pointCountAfter,
    builtDepth: built.depth,
    deleteOutcomeInWallMode: ignored.deleteOutcome,
    depthInWallMode: ignored.depth,
    toolAfterEscape: exited.tool,
    clickedSelectedIds: clicked.selectedIds,
    clickedSelectedPx: clicked.selectedPx,
    clickedHandlePx: clicked.handlePx,
    deleteOutcomeAfterBackspace: delHot.deleteOutcome,
    deletedCount: deleted.deletedIds.length,
    unsupportedCount: deleted.unsupportedIds.length,
    comboAfterUndo: undoKey.combo,
    pointsAfterUndo: pointCountOf(undid, '撤销后'),
    selectedAfterUndo: undid.selectedIds.length,
    comboAfterRedo: redoKey.combo,
    pointsAfterRedo: pointCountOf(redid, '重做后'),
    probeMatchesStart: JSON.stringify(fin.draw) === probeJson,
    pointsMatchStart: JSON.stringify(fin.points) === JSON.stringify(start.points),
    // ↓ addendum A3 那一发的读数（脚本第 22 行判据拿它们对账）。三发像素、两枚 id、四份账全留档：
    //   哪一发的吸附变了，`starPrep*` 与 `star*` 这两组就能一眼指出是预备墙还是斜臂。
    starEdgeMm: STAR_EDGE_MM,
    starEdgePx,
    starPxPerMm: pxPerMm,
    starPressPx: cornerPx,
    starEastPx: eastPx,
    starSouthPx: southPx,
    starTargetPx: diagonalPx,
    starBuiltCornerId: starCornerId,
    starBuiltCornerMm: cornerMm,
    starPrepEdgeCounts: `${String(w1.create.pointCountBefore)}→${String(w1.create.pointCountAfter)}`,
    starPrepCornerCounts: `${String(w2.create.pointCountBefore)}→${String(w2.create.pointCountAfter)}`,
    starPrepEndSnapKind: w1.endSnap === null ? null : w1.endSnap.kind,
    starPrepCornerSnapPointId: w2.endSnap === null ? null : w2.endSnap.pointId,
    starCounts: `${String(w3.create.pointCountBefore)}→${String(w3.create.pointCountAfter)}`,
    starStartSnapKind: starStartSnap.kind,
    starStartPointId: starStartSnap.pointId,
    starStartMm: starStartSnap.mm,
    starStartDistPx: starStartSnap.distPx,
    starEndSnapKind: starEndSnap.kind,
    starEndSnapPointId: starEndSnap.pointId,
    starMarkAtPress: w3.markAtPress,
    starLegalAtMove: w3.legalAtMove,
    starAppAlive,
    starLastError: starError,
  };
  writeFileSync(out, `${JSON.stringify(out1, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(out1)}\n`);
}

/**
 * 四段分支（T5 的三段再加一段）。顺序是**从具体到通用**：`--draw-shot` 判在
 * `editShotRequested()` 之前 —— 四个 runner 共用 `--shot` 那份落盘路径，谁先命中谁写盘。
 * 脚本侧同样只允许一个具体 flag 生效（`mode` 只有一个值），两边配成一对。
 */
void app.whenReady().then(async () => {
  // fail-fast：四个开关的路径都在起窗之前读完，任何一个开关后面缺路径或跟了另一个开关，
  // 立刻 stderr + exit(2)（毫秒级），绝不落到被丢弃的 promise rejection 里挂到脚本超时。
  let shotPath: string | null;
  let editPath: string | null;
  let pickPath: string | null;
  let drawPath: string | null;
  try {
    shotPath = argPath('--shot');
    editPath = argPath('--edit-shot');
    pickPath = argPath('--pick-shot');
    drawPath = argPath('--draw-shot');
  } catch (err) {
    process.stderr.write(`--shot 参数无效：${String(err)}\n`);
    app.exit(2);
    return;
  }
  // --draw-shot 与 --pick-shot、--edit-shot 一样派发合成输入（鼠标/键盘），要求窗口拿到 OS
  // 前台焦点（见 focusForInput），隐藏窗在 Windows 前台锁下拿不到焦点是 T4 实测过的。纯 --shot
  // 保持 6ddb090 落地的隐藏绘制路径不变 —— 它不派发输入，只回读像素。
  const wantInput = drawShotRequested() || pickShotRequested() || editShotRequested();
  // 摘默认应用菜单必须发生在**建窗之前**：菜单条占着约 26px 客户端高度，运行中摘掉等于给窗口
  // 来一发 resize ⇒ renderer 重算视口 ⇒ 闸门已经发出去的探针像素全体作废（实测：第一次 Ctrl+Z
  // 之后同一个把手从 (253,74) 漂到 (332,75)，第 7 步"原地松手"按到空白，红成"noop 没给出"）。
  // 交互模式保留默认菜单 —— Edit → Undo/Redo 那套 accelerator 是给人用的，不是实验变量。
  if (shotPath !== null) Menu.setApplicationMenu(null);
  const win = createWindow(shotPath === null || wantInput);
  if (shotPath === null) {
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(true);
    });
    return;
  }
  let code = 0;
  try {
    if (drawShotRequested()) await runDrawShot(win, drawPath ?? shotPath);
    else if (editShotRequested()) await runEditShot(win, editPath ?? shotPath);
    else if (pickShotRequested()) await runPickShot(win, pickPath ?? shotPath);
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
