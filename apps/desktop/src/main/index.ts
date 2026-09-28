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
  /** 拖拽中 store 里已处理的光标像素（不在拖 = null）。见 `samePx` 那条中途判据。 */
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

void app.whenReady().then(async () => {
  // fail-fast：三个开关的路径都在起窗之前读完，任何一个开关后面缺路径或跟了另一个开关，
  // 立刻 stderr + exit(2)（毫秒级），绝不落到被丢弃的 promise rejection 里挂到脚本超时。
  let shotPath: string | null;
  let editPath: string | null;
  let pickPath: string | null;
  try {
    shotPath = argPath('--shot');
    editPath = argPath('--edit-shot');
    pickPath = argPath('--pick-shot');
  } catch (err) {
    process.stderr.write(`--shot 参数无效：${String(err)}\n`);
    app.exit(2);
    return;
  }
  // --pick-shot 与 --edit-shot 都派发合成输入（鼠标/键盘），要求窗口拿到 OS 前台焦点
  // （见 focusForInput），隐藏窗在 Windows 前台锁下拿不到焦点是 T4 实测过的。纯 --shot
  // 保持 6ddb090 落地的隐藏绘制路径不变 —— 它不派发输入，只回读像素。
  const wantInput = pickShotRequested() || editShotRequested();
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
    if (editShotRequested()) await runEditShot(win, editPath ?? shotPath);
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
