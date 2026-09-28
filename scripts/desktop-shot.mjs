import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// electron 包的入口在非 Electron 的 node 里 require 出来就是二进制绝对路径（Electron 官方定位法：
// index.js 读 path.txt 拼 dist/）。直接按路径起它，回读路径就不必经 pnpm exec 与 shell 两层转手。
const desktopDir = join(import.meta.dirname, '..', 'apps', 'desktop');
const electronBin = createRequire(join(desktopDir, 'package.json'))('electron');

function assertRan(r, label, timeoutMs) {
  if (r.error) throw r.error;
  if (r.signal) throw new Error(`${label} 被信号 ${String(r.signal)} 打死（窗口没关？超时 ${String(timeoutMs)}ms）`);
  if (r.status !== 0) throw new Error(`${label} → exit ${String(r.status)}`);
}

// Windows 上 pnpm 是 pnpm.cmd，必须走 shell:true 才找得到。但 shell:true 配 args 数组会把参数
// 不加引号拼成一条命令串——含空格的路径在空格处断开（TMPDIR 带空格即假失败），且每次运行报
// DEP0190。所以这里只传拼好的整条命令串、不带 args 数组；本串里没有需要再加引号的分量。
function runPnpm(commandLine, timeoutMs) {
  assertRan(spawnSync(commandLine, { encoding: 'utf8', shell: true, stdio: 'inherit', timeout: timeoutMs }), commandLine, timeoutMs);
}

// Electron 直接起二进制、不经 shell：args 数组原样进 argv（Node 在 Windows 构造进程命令行时
// 会给含空格的参数补引号），--shot 回读路径无论含不含空格都完整。
// cwd 指到 desktop 包目录："." 即应用根，与原先 pnpm --filter … exec electron . 语义一致。
function runElectron(args, timeoutMs) {
  assertRan(
    spawnSync(electronBin, args, { encoding: 'utf8', cwd: desktopDir, stdio: 'inherit', timeout: timeoutMs }),
    `electron ${args.join(' ')}`,
    timeoutMs,
  );
}

const dir = mkdtempSync(join(tmpdir(), 'dajia-shot-'));
const out = join(dir, 'report.json');
const wantPick = process.argv.includes('--pick');
const wantEdit = process.argv.includes('--edit');
// `--shot out` 不是"再写一份报告"：主进程用 `argPath('--shot') !== null` 判定进不进 shot 模式
// （隐藏窗口、跑完 exit）。少了它，`--edit-shot` / `--pick-shot` 那份路径根本没人读。
// 一次运行只有 `runEditShot` 或 `runPickShot` 或 `runShot` 会写盘 ⇒ 三个开关共用 `out` 这一个路径。
// 开关与路径成对（`--pick-shot out` / `--edit-shot out`）：主进程的 `argPath(flag)` 现在读各自
// 开关后面的路径，`--pick-shot` 不再当裸开关 —— 这也收掉了 T4 那个"裸开关被当成缺路径"的隐患。
const electronArgs = wantEdit
  ? ['.', '--edit-shot', out, '--shot', out]
  : ['.', ...(wantPick ? ['--pick-shot', out] : []), '--shot', out];
try {
  runPnpm('pnpm --filter @dajia/desktop build');
  runElectron(electronArgs, 180_000);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  const layers = report.layers ?? {};
  const edit = report.edit ?? {};
  // 前六条与 drawlist.test.ts 同源；--pick 下追加的五条：一条实测原点前提 + 四条与
  // pick.test.ts 同源的判据。改样例房必须几处一起改，别只调这里。
  const checks = [
    ['指令表 31 条（8 轮廓 + 12 轴线 + 10 洞口线 + 1 标签）', report.ops === 31],
    ['structure 层 20 条', layers.structure === 20],
    ['opening 层 10 条', layers.opening === 10],
    ['annotation 层 1 条', layers.annotation === 1],
    // Task 3 挂下来的 m5：这条只断下界，从没和内容区对过账 —— 名字改老实，别冒领等式。
    ['画布尺寸过下界（wPx>800 且 hPx>500，非等式比对）', report.wPx > 800 && report.hPx > 500],
    ['非背景像素 > 5000（白屏恒为 0）', report.nonBlankPx > 5000],
  ];
  if (wantPick) {
    // 判据一人一票（I2）：main 的 waitUntil 只等 store 落定，不判归属与像素 ——
    // 下面这四条的 FAIL 都真打得出来（改坏验证：buildDrawList 第四参删掉、选中不上屏时，
    // "点中墙后屏幕上真的有红色像素"这一行红，而不是 main 先抛错）。
    checks.push(
      // 画布原点必须是实测的 (0,0)：探针点（画布 px）→sendInputEvent（页面 px）的换算
      // 靠它，Task 8 改布局后若原点漂移，这一行先红 —— 前提从此是断言不是默契。
      ['画布原点实测 = 视口原点 (0,0)', report.canvasOriginPx?.x === 0 && report.canvasOriginPx?.y === 0],
      ['探针给出可点的构件', typeof report.pick?.ownerId === 'string'],
      ['点中墙后屏幕上真的有红色像素', report.pickedSelectedPx > 100],
      ['选中的就是探针指的那面墙', report.clickedOwner === report.pick?.ownerId],
      // 两半都要：store 空了 **且** 红色像素没了 —— 只查前者的话，paint effect 漏掉 ids
      // 依赖（屏幕还红着）会一路绿灯。
      ['点空白后 store 与屏幕一起清空', report.selectedAfterBlank === 0 && report.selectedPx === 0],
    );
  }
  if (wantEdit) {
    // 前六条与 drawlist.test.ts 同源（拖动改的是坐标不是指令数，所以 `ops === 31` 在 edit 模式下
    // 仍是回归判据）；这十四条与 handles.test.ts + commands-drag.test.ts 同源，
    // 但只测它们管不到的那一层：真窗口里"发的像素 → 真源的毫米 → 撤销栈"。
    checks.push(
      ['探针给出可拖的共享端点（孤端点证不出邻墙）', typeof edit.wallId === 'string' && edit.sharedBy >= 2],
      ['按在把手上即选中那面墙（D5）', report.selectedAfterPress === edit.wallId && report.selectedPxAfterPress > 100],
      ['把手上屏（只有选中的墙才画把手）', report.handlePxAfterPress > 20],
      ['拖拽中不写真源：depth、revision、坐标三者都不动', report.depthDuringDrag === report.depthAtStart && report.revisionDuringDrag === report.revisionAtStart && report.xDuringDrag === report.xAtStart && report.yDuringDrag === report.yAtStart],
      ['拖拽中临时线上屏（白屏与"只画了图"都过不了）', report.previewPxDuringDrag > 20],
      // 上一行只证明"有那根线"，这一行证明"那根线在光标那儿"：把 paintPreview 的终点写死成
      // 按下点，上一行照样绿 —— 位置取自 store 的活光标，颜色取自屏幕的实像素，缺一半就是假绿。
      ['拖拽中临时线跟着光标（钉在按下点就红）', report.previewNearMidPx > 0],
      ['松手落点逐字等于探针给的毫米', report.xAfterDrop === edit.targetMm?.x && report.yAfterDrop === edit.targetMm?.y],
      ['一步拖 = depth +1 且 revision +1（撤销栈知道发生了什么）', report.depthAfterDrop === report.depthAtStart + 1 && report.revisionAfterDrop === report.revisionAtStart + 1],
      ['松手后临时线不残留、把手仍在', report.previewPxAfterDrop === 0 && report.handlePxAfterDrop > 20],
      ['压扁到锚点被真源拒绝（中文报错，不是没反应）', /轴长|零长/.test(report.lastErrorAfterCrush ?? '') && report.dropOutcomeAfterCrush === 'failed'],
      // 计划 2 转下游 #11 的落地凭据：抛错那发不留任何痕迹 —— 这一条只在真窗口里测得到，
      // 因为 renderer 的 dispatch 是唯一读者。
      ['失败的拖拽不改 depth、不改 revision、不改坐标', report.depthAfterCrush === report.depthAfterDrop && report.revisionAfterCrush === report.revisionAfterDrop && report.xAfterCrush === report.xAfterDrop && report.yAfterCrush === report.yAfterDrop],
      ['Ctrl+Z 回到拖动前且选中集不动', report.xAfterUndo === report.xAtStart && report.yAfterUndo === report.yAtStart && report.depthAfterUndo === report.depthAtStart && report.selectedAfterUndo === edit.wallId],
      ['Ctrl+Shift+Z 回到拖动后并把错误抹掉', report.xAfterRedo === edit.targetMm?.x && report.lastErrorAfterRedo === null && report.comboAfterRedo === 'Ctrl+Shift+Z'],
      // 后两条各管一头：noop 证"零移动不入栈"（D4），空栈反馈证"没发生的事要说出来"（D7）。
      ['原地松手 = noop，撤销栈一步都不许多', report.dropOutcomeAfterNoop === 'noop' && report.depthAfterNoop === report.depthAfterRedo],
      ['重做栈空时再按 Ctrl+Shift+Z 给中文反馈且不动真源', report.lastErrorAfterEmptyRedo === '没有可重做的操作' && report.comboAfterEmptyRedo === 'Ctrl+Shift+Z' && report.depthAfterEmptyRedo === report.depthAfterRedo],
    );
  }
  let bad = 0;
  for (const [name, ok] of checks) {
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}\n`);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (bad > 0) throw new Error(`${String(bad)} 项判据没过`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
