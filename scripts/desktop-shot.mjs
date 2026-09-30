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
// mode 判定链：`mode` 只有一个值。三个 `includes` 各自为政的旧形状里，`--edit --draw` 会给
// 主进程两个具体 flag，而主进程分支只认第一个、脚本却按后攒的判据读报告 ⇒ 红在"报告里没这个键"。
// 走这条链后两侧永远只认同一个模式，这件事在构造上不可能发生。
// `--prop` 判在最前只是链的一处落点（Task 8 的第五个模式）：真正配对的顺序在主进程那段
// 「从具体到通用」的分支里，这儿四个 `includes` 谁先谁后都一样，因为 `mode` 只会有一个值。
const mode = process.argv.includes('--prop')
  ? 'prop'
  : process.argv.includes('--draw')
    ? 'draw'
    : process.argv.includes('--edit')
      ? 'edit'
      : process.argv.includes('--pick')
        ? 'pick'
        : 'shot';
const wantProp = mode === 'prop';
const wantPick = mode === 'pick';
const wantEdit = mode === 'edit';
const wantDraw = mode === 'draw';
// 具体 flag 与 `--shot` 成对给：`--shot out` 不是"再写一份报告"，主进程用它判定进不进 shot 模式
// （隐藏窗口、跑完 exit）。少了它，`--draw-shot` 那份路径根本没人读。
// 一次运行只有 `runPropShot` 或 `runDrawShot` 或 `runEditShot` 或 `runPickShot` 或 `runShot` 会写盘
// ⇒ 五个开关共用 `out` 这一个路径；开关与路径成对（`--prop-shot out`），主进程的 `argPath` 读各自开关
// 后面的路径 —— 裸开关被当成缺路径的 T4 隐患早已被那条 fail-fast 收掉。
const specificFlag = wantProp
  ? '--prop-shot'
  : wantDraw
    ? '--draw-shot'
    : wantEdit
      ? '--edit-shot'
      : wantPick
        ? '--pick-shot'
        : null;
const electronArgs = ['.', ...(specificFlag === null ? [] : [specificFlag, out]), '--shot', out];
try {
  runPnpm('pnpm --filter @dajia/desktop build');
  // 只有 draw 与 prop 那一发放宽到 300 秒：它们一次跑要过 20+ 处等待（每处上限 10 秒 —— 但一处等不到就抛、
  // 进程当场退出，所以真上界是"走完序列的实测一分多钟 + 一处超时"，300 秒是给慢机器留的余量）。
  // 另三条**不跟着放宽** —— 它们的等待数量一字没动，跟着涨等于把"变慢了"这件事抹平。
  runElectron(electronArgs, wantProp || wantDraw ? 300_000 : 180_000);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  const layers = report.layers ?? {};
  const edit = report.edit ?? {};
  // `draw` 是**探针**那一份；序列的逐步读数全部平铺在报告根上 —— 与 `edit` 那一份的形状
  // 不同，那些是 `runEditShot` 自己组的嵌套对象。
  const probe = report.draw ?? {};
  // `prop` 是 `--prop-shot` 第 0 步读到的那枚**面板靶子**（`propProbe` 的六道筛 + 尽力那一发的
  // 第二面墙）。它与 `pick` / `edit` / `draw` 那三枚探针同一条通路：主进程一律不许自己猜坐标。
  const prop = report.prop ?? {};
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
      // 画布原点必须是实测的 (0,32)：探针点（画布 px）→sendInputEvent（页面 px）的换算
      // 靠它。Task 8 的三格布局把画布下移了一栏 tab，所以原点不再是视口原点。
      // 前提从此是断言不是默契：若布局再漂移，这一行先红。
      // y = 32 = 楼层 tab 栏高（`panels.tsx` 的 `STOREY_TAB_HEIGHT_PX`），x 分量仍严格 0（面板在右侧）。
      ['画布原点实测 = (0,32)（Task 8 布局后 y = tab 栏高 32）', report.canvasOriginPx?.x === 0 && report.canvasOriginPx?.y === 32],
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
    // 仍是回归判据）；这十六条与 handles.test.ts + commands-drag.test.ts 同源，
    // 但只测它们管不到的那一层：真窗口里"发的像素 → 真源的毫米 → 撤销栈"。
    checks.push(
      ['探针给出可拖的共享端点（孤端点证不出邻墙）', typeof edit.wallId === 'string' && edit.sharedBy >= 2],
      ['按在把手上即选中那面墙（D5）', report.selectedAfterPress === edit.wallId && report.selectedPxAfterPress > 100],
      // 「第一发只选中、不起拖」（main 第 1 步那段：把手只从当前选中集生成，空集时 pickHandle 无从命中）
      // 的见证者是两枚读数的**和**：`previewPxAfterClick === 0` 证"没起拖"，`handlePxAfterClick > 20`
      // 证"选中真落到了 store"。只留前者的话，把第 1 步整个删掉也照样绿（临时线本来就 0），
      // 而下一行 `handlePxAfterPress` 会把第 2 步画的把手误当成第 1 步的功劳。
      // 阈值 20 与 `handlePxAfterPress` 同源；`handlePxAfterClick` 两次复跑实测 193 / 191（edit-shot.log）。
      ['第一发只选中不起拖：临时线一个像素都没有、把手已上屏', report.selectedAfterClick === edit.wallId && report.previewPxAfterClick === 0 && report.handlePxAfterClick > 20],
      ['把手上屏（只有选中的墙才画把手）', report.handlePxAfterPress > 20],
      ['拖拽中不写真源：depth、revision、坐标三者都不动', report.depthDuringDrag === report.depthAtStart && report.revisionDuringDrag === report.revisionAtStart && report.xDuringDrag === report.xAtStart && report.yDuringDrag === report.yAtStart],
      ['拖拽中临时线上屏（白屏与"只画了图"都过不了）', report.previewPxDuringDrag > 20],
      // 上一行只证明"有那根线"，这一行证明"那根线在光标那儿"：把 paintPreview 的终点写死成
      // 按下点，上一行照样绿 —— 位置取自 store 的活光标，颜色取自屏幕的实像素，缺一半就是假绿。
      ['拖拽中临时线跟着光标（钉在按下点就红）', report.previewNearMidPx > 0],
      ['松手落点逐字等于探针给的毫米', typeof report.xAfterDrop === 'number' && report.xAfterDrop === edit.targetMm?.x && report.yAfterDrop === edit.targetMm?.y],
      ['一步拖 = depth +1 且 revision +1（撤销栈知道发生了什么）', report.depthAfterDrop === report.depthAtStart + 1 && report.revisionAfterDrop === report.revisionAtStart + 1 && report.dropOutcomeAfterDrop === 'ok'],
      ['松手后临时线不残留、把手仍在', report.previewPxAfterDrop === 0 && report.handlePxAfterDrop > 20],
      ['压扁到锚点被真源拒绝（中文报错，不是没反应）', /轴长|零长/.test(report.lastErrorAfterCrush ?? '') && report.dropOutcomeAfterCrush === 'failed'],
      // 计划 2 转下游 #11 的落地凭据：抛错那发不留任何痕迹 —— 这一条只在真窗口里测得到，
      // 因为 renderer 的 dispatch 是唯一读者。
      ['失败的拖拽不改 depth、不改 revision、不改坐标', report.depthAfterCrush === report.depthAfterDrop && report.revisionAfterCrush === report.revisionAfterDrop && report.xAfterCrush === report.xAfterDrop && report.yAfterCrush === report.yAfterDrop],
      ['Ctrl+Z 回到拖动前且选中集不动', report.xAfterUndo === report.xAtStart && report.yAfterUndo === report.yAtStart && report.depthAfterUndo === report.depthAtStart && report.selectedAfterUndo === edit.wallId],
      ['Ctrl+Shift+Z 回到拖动后并把错误抹掉', typeof report.xAfterRedo === 'number' && report.xAfterRedo === edit.targetMm?.x && report.lastErrorAfterRedo === null && report.comboAfterRedo === 'Ctrl+Shift+Z'],
      // 后两条各管一头：noop 证"零移动不入栈"（D4），空栈反馈证"没发生的事要说出来"（D7）。
      ['原地松手 = noop，撤销栈一步都不许多', report.dropOutcomeAfterNoop === 'noop' && report.depthAfterNoop === report.depthAfterRedo],
      ['重做栈空时再按 Ctrl+Shift+Z 给中文反馈且不动真源', report.lastErrorAfterEmptyRedo === '没有可重做的操作' && report.comboAfterEmptyRedo === 'Ctrl+Shift+Z' && report.depthAfterEmptyRedo === report.depthAfterRedo],
    );
  }
  if (wantDraw) {
    // 前六条与 drawlist.test.ts 同源（读的是第 15 步重做回到基线之后那份快照 `fin`，所以 `ops === 31`
    //   在这里仍是回归判据；第 16 步**故意把三面星形墙留在文档里**，它的判据只吃自己那一发的前后差，
    //   不冒充基线 —— 于是"基线那六条"与"星形那几条"读的是两个时刻，这是设计而非漏改）；
    // 这二十二条与 editing.test.ts + snapping.test.ts 同源，但只测它们管不到的那一层：
    // 真窗口里"发的像素 → 吸附的落点 → 真源的账 → 撤销栈"（最后一条是 addendum A3 的星形接头那一发，
    // 测的是绘制层那张兜网，unit 侧没有对应文件 —— 命令发得出去、派生抛错，只有真窗口走得到那一步）。
    checks.push(
      ['D1 探针给得出靶子，起点吸在既有端点上（S7 的复用那一半）', typeof report.startSnapPointId === 'string' && report.startSnapPointId.length > 0 && report.startSnapKind === 'endpoint'],
      ['D2 按下处的像素就是探针给的那一发（屏幕不另算一套坐标）', report.pressPxMatches === true],
      ['D3 零长草稿判不合法，但吸附标记已经上屏', report.legalAtPress === false && report.snapMarkAtPress > 0],
      // 档位只钉到「是方向档、且零位移」：钉死 ortho 还是 angle15 等于拿判据赌 uuidv7 的端点顺序（探针挑中哪枚起点会漂，见 S8 ① 那段实测）。
      // S3 那句"画 4000 的水平墙必须是 ortho"由 snapping.test.ts 的档位互斥用例负责，那一份是确定性的。
      // distPx 的 0 订正为 ≤1.5（D2a 实测）：S8 ① 那句"十发 distPx 逐字为 0"量在 8mm=1px 的二进制对齐格点上
      // （pxPerMm=0.125）；真窗口 Task 8 布局之后是 `fitStorey(1167×833, 60)`，四个进程实测
      // `pxPerMm = 0.114`（main 第 16 步现算的探针比例，终审 B2 P2-6 起不再以 `starPxPerMm` 写进报告——
      // 那格只写不读，删了）与 `endSnapDistPx = 0.5007`（这一格有读者：下面 D4 判据正拿它对账）—— 落在这把尺子的
      // √2 上界之内，且 0.5px 那一发正是"整数毫米落不到整数像素"的往返残差本体。整数毫米落不到整数像素上，
      // `intPx → pxToMm → quantize → mmToPx` 的往返残差按构造 ≤1px/轴（√2≈1.42）。"零位移"的毫米侧对账
      // 由第 3 步与 D12 的 `end.mm === probe.endMm` **逐字相等**钉着；这一行只钉"方向档不把落点拽离光标一像素以上"
      // —— 拽去 8px 容差内的别处、或拽去别面墙，都会红在这一行。
      ['D4 终点吸的是方向档、没引别人的点、位移在量化往返残差内（S7 的另一半 + S8 ① 订正版）', report.endSnapPointId === null && (report.endSnapKind === 'ortho' || report.endSnapKind === 'angle15') && report.endSnapDistPx <= 1.5],
      ['D5 中途临时线跟到光标（S4 第三条纪律）', report.previewNearCursorPx > 0],
      // 橙色桶只证存在不证位置（A1/S8）：整幅画布的橙色总数只能 `> 0` / 比较，位置对账一律走毫米。
      ['D6 中途第四色标记在屏（S8 只证存在）', report.snapMarkAtMove > 0],
      ['D7 中途真源一个字没动：depth、revision、点数三者', report.depthAtMove === report.depthAtStart && report.revisionAtMove === report.revisionAtStart && report.pointsAtMove === report.basePoints],
      ['D8 Escape 只取消草稿、留在拉墙模式，标记跟着消失', report.toolAfterEsc === 'wall' && report.snapMarkAfterEsc === 0 && report.depthAtCancel === report.depthAtStart],
      ['D9 原地松手 = rejected，一条命令都不发（D4 的第三色）', report.rejectedOutcome === 'rejected' && report.rejectedWallId === null && report.rejectedCounts === `${String(report.basePoints)}→${String(report.basePoints)}`],
      ['D10 被拒那一发不入栈：depth 与取消后逐字相同', report.rejectedDepth === report.depthAtCancel],
      ['D11 松手建墙，起点复用探针指的那枚点（接头没断）', report.builtOutcome === 'ok' && report.builtStartId === report.startSnapPointId],
      ['D12 回执落点逐字等于探针预言（两边同一个纯函数）', typeof report.builtEndMm?.x === 'number' && typeof probe.endMm?.x === 'number' && JSON.stringify(report.builtEndMm) === JSON.stringify(probe.endMm)],
      ['D13 一面全新终点的墙恰好多一枚点（S7 的删除账靠它）', report.builtPointsBefore === report.basePoints && report.builtPointsAfter === report.basePoints + 1],
      ['D14 新建即选中，且屏幕上真有红色像素', report.builtSelected === true && report.builtSelectedPx > 100],
      ['D15 建完仍在拉墙模式（连画不该每面退出一次）', report.builtTool === 'wall'],
      ['D16 拉墙模式下按 Delete = 故意沉默，账一步不动', report.deleteOutcomeInWallMode === 'ignored-in-wall-mode' && report.depthInWallMode === report.builtDepth],
      ['D17 再按一次 Escape 才退出拉墙', report.toolAfterEscape === 'select'],
      ['D18 点新墙中点：唯一命中就是刚建那面，把手也画出来了（筛 ④ 的像素下限在真窗口里成立）', Array.isArray(report.clickedSelectedIds) && report.clickedSelectedIds.length === 1 && report.clickedSelectedIds[0] === report.builtWallId && report.clickedHandlePx > 20],
      ['D19 Backspace 只删那一面墙，unsupported 空，选中集剪空', report.deleteOutcomeAfterBackspace === 'ok' && report.deletedCount === 1 && report.unsupportedCount === 0 && Array.isArray(report.selectionAfterDelete) && report.selectionAfterDelete.length === 0],
      ['D20 撤销把墙连同它的孤儿点一起带回来，选中不跟着回来（D7 那半句）', report.pointsAfterUndo === report.basePoints + 1 && report.selectedAfterUndo === 0 && report.comboAfterUndo === 'Ctrl+Z'],
      // 倒数第二条是总账：②③ 两条纪律的凭据都在它身上 —— 第 15 步为止序列没留痕，前六条读的就是这份基线
      //   （第 16 步的三面星形墙落在它之后，只吃自己的前后差，不冒充基线）。
      ['D21 重做回到基线，终态探针与 points 快照逐字回到第 0 步', report.pointsAfterRedo === report.basePoints && report.probeMatchesStart === true && report.pointsMatchStart === true && report.comboAfterRedo === 'Ctrl+Shift+Z'],
      // 最后一条 = addendum A3 的正式判据（十六步之外那一发）：主进程在画布空白角**现造**一枚角点
      // （横、竖两发预备墙把它凑成二臂直角），再按在**同一发像素**上补一发 45° 斜臂 ⇒ 三臂三方向
      // = star。为什么不是"按在样例房某枚既有角点上"：那枚角点是探针按 uuid 序抽出来的，而"按下吸不吸
      // 得上"比的是 distPx，垂足按构造永不比端点远 —— 旧写法（±1px 与环扫 49 发）赌的是"量化毫米恰好
      // 落回角点坐标"那一列/那一行，看视口相位（run3 九发全吸成 foot、run6 抽中自由端补出干净 corner
      // 而 lastError 恒空，根因钉在 main 第 16 步的注释里）。现造这一枚靠的是不动点：端点候选与两枚
      // 垂足候选的毫米**逐字相同**，并列由 `PRIORITY` 判给端点，比的不是"谁更近"。
      // Task 7 之后这一条钉的是**两边都不许写进真源**：屏幕侧 `legalAtMove` 判 false（预言试跑的就是
      // 带 `assertDerivesAfterApply` 的真命令）、渲染端走 `rejected` 那一支一条命令不发、真源的
      // depth/revision/点数三者纹丝不动、`lastError` 恒空（旧语义"发出去了但画不出来"在绘制通路上
      // 已结构性不可达）。最后那两句是**复用**的对账，走毫米不走像素（A1：第四色标记只证存在，`> 0`
      // 那一判在 main 里，位置一律由真源毫米钉）：斜墙起点吸的那枚 id 与那份毫米，逐字等于刚建的那枚角点。
      ['D22 空白角现造角点、按同一发像素补一发 45° 斜臂逼成三臂星形：屏幕判不合法、命令一条没发、真源纹丝不动、lastError 恒空、斜墙起点逐字复用现造那枚角点（两边都不许写进真源，addendum A3 / T7 语义）', report.starLegalAtMove === false && report.starRejectedOutcome === 'rejected' && report.starRejectedWallId === null && report.starRejectedCounts === `${String(report.basePoints + 3)}→${String(report.basePoints + 3)}` && report.starNoopDepth === true && report.starNoopRevision === true && report.starPointsAfter === report.basePoints + 3 && report.starLastError === null && report.starAppAlive === true && report.starStartPointId === report.starBuiltCornerId && JSON.stringify(report.starStartMm) === JSON.stringify(report.starBuiltCornerMm)],
    );
  }
  if (wantProp) {
    // 前六条与 drawlist.test.ts 同源（读的是第 15 步终态那份 `fin`：整条序列回基线 ⇒ `ops === 31`
    //   在这里仍是回归判据）。
    // 这二十四条与 panel.test.ts + handles.test.ts 同源，但只测它们管不到的那一层：真窗口里
    //   "点 tab / 点面板控件 → 屏幕上的读数 → 真源的账（depth）→ 重绘的账（revision）"。
    //   node 侧证得到 `wall.setMaterial` 不跑复核，证不到"画面上一个字都没变"（P13 那三处墨迹对账）；
    //   也证不到"`<select>` 的方向键真落到了焦点上"（P12 那一发只按了一次，blur 掉焦点时它是 0 发）。
    // 写死的字面量全是 2026-09-30 首跑实测回填：depth 基线 30、revision 0 → 1 → 2 → 3、8 枚点、
    //   选中那份墨迹 30744、opening 层 10 → 8 → 10、材料 1 发方向键、撤销 2 发
    //   （计划原文写"Ctrl+Z 三次"，实测是"材料发数 + 1"：第 5 步那发厚度在第 7 步已单独撤过）。
    //   改布局或改样例房要连同 main 的十六步一起重测三遍，别只调这里。
    checks.push(
      ['P1 基线读数写死：depth 30 / 重绘计数 0 / 8 枚点 / 指令表 31 条 / tab 两条（第 1 层标高 0、第 2 层 3000）',
        report.baseDepth === 30 && report.baseRevision === 0 && report.basePoints === 8 && report.opsAtStart === 31 &&
          report.tabStripAtStart === '[{"index":0,"label":"第 1 层","elevationMm":0,"heightMm":3000},{"index":1,"label":"第 2 层","elevationMm":3000,"heightMm":3000}]'],
      ['P2 面板靶子三枚 id 各不相等，且三格读数挂在自己的墙上（"尽力"那一发的第二面墙也在场）',
        typeof prop.wallId === 'string' && typeof prop.openingId === 'string' && typeof prop.secondWallId === 'string' &&
          prop.openingId !== prop.wallId && prop.secondWallId !== prop.wallId && prop.secondWallId !== prop.openingId &&
          prop.props?.wallId === prop.wallId],
      ['P3 画布原点实测 = (0,32)（tab 栏在下边界、面板在右侧），终态视口仍与当前层配对',
        report.canvasOriginPx?.x === 0 && report.canvasOriginPx?.y === 32 && report.viewportStoreyId === report.storeyId],
      ['P4 二层 tab 那发：换层且视口跟着换、选中与面板一起清空、真源 depth 不动而重绘确实发生（revision 0→1）、两层的点不共用（素材自证 8 枚）',
        typeof report.storeyIdAfterTab === 'string' && report.storeyIdAfterTab !== report.storeyIdAtStart &&
          report.viewportStoreyIdAfterTab === report.storeyIdAfterTab && report.selectedCountAfterTab === 0 &&
          report.panelWallAfterTab === null && report.depthAfterTab === report.baseDepth && report.revisionAfterTab === 1 &&
          report.pointKeysDisjoint === true && report.upperPointCount === 8],
      ['P5 点回一层可逆：视口两份值逐字回到第 0 步那一份，depth 仍是基线（P10：切层只换视图，不写文档）',
        report.storeyIdAfterTabBack === report.storeyIdAtStart && report.viewportStoreyIdAfterTabBack === report.storeyIdAfterTabBack &&
          report.viewportBackMatches === true && report.depthAfterTabBack === report.baseDepth && report.revisionAfterTabBack === 2],
      ['P6 点一面改得动的墙：面板开、三格逐字 = 探针那份预言、轴长 > 墙厚、选中集就它一个',
        report.panelWallIdAtSelect === prop.wallId && report.panelMatchesProbe === true &&
          JSON.stringify(report.panelPropsAtSelect) === JSON.stringify(prop.props) &&
          report.axisLongerThanThickness === true && report.selectedIdsAtSelect?.length === 1 && report.selectedIdsAtSelect?.[0] === prop.wallId &&
          // 上屏对账（终审 B2 P1-2）：三格的字真在 DOM 里。轴长那一式取 `prop.props`（探针的
          // **独立预言**）而不是 `panelProps` —— 拿面板证面板又是"用结论证结论"；`?? ''` 只为类型，
          // `chosen` 那一步 `prop.props` 必在。
          report.wallIdDomAtSelect === prop.wallId &&
          report.heightDomAtSelect === String(report.panelPropsAtSelect?.heightMm) &&
          report.axisLenDomAtSelect === String(report.prop?.props?.axisLengthMm ?? '')],
      ['P7 选中那一刻"画面确实变了、几何一个字没变"：墨迹实测 30744（终态 30671 是空面板那一份），ops 与三层计数逐字等于基线',
        report.nonBlankAtSelect === 30744 && report.opsAtSelect === 31 &&
          JSON.stringify(report.layersAtSelect) === JSON.stringify(report.layers)],
      ['P8 厚度框打 240.5 不回车：只问不写 —— 试跑 ok=false、真源中文「整数毫米」、depth 仍基线、真源厚度还是 240',
        report.trial4Kind === 'thickness' && report.trial4Input === '240.5' && report.trial4Ok === false &&
          /整数毫米/.test(report.trial4Reason ?? '') && report.depthAfterTrial4 === report.baseDepth &&
          report.thicknessAfterTrial4 === 240 &&
          // 红字真在屏幕上且与 debug 逐字相同（终审 B2 P1-2）：`trial-reason` 出口今天零读者。
          report.trial4DomReason === report.trial4Reason],
      ['P8b 非法值真按一次 Enter：守卫挡在屏幕侧 —— 一条命令都没发、lastError 没被写过、未捕获异常 0 发（摘掉守卫那一发是裸抛，只有这一格分得出）、红字与输入框那串字都还在屏幕上',
        report.illegalEnterDepth === report.baseDepth && report.illegalEnterThickness === 240 &&
          report.illegalEnterLastError === null && report.illegalEnterUncaughtDelta === 0 &&
          report.illegalEnterTrialOk === false && report.illegalEnterTrialInput === '240.5' &&
          report.illegalEnterDomReason === report.trial4Reason && report.illegalEnterDomValue === '240.5'],
      ['P9 换成探针给的第一档合法值回车：恰好一条命令（depth 基线 +1）、面板读回新值 = 真源',
        report.trial5Input === String(prop.thicknessTo) && report.trial5Ok === true &&
          report.depthAfterThickness === report.baseDepth + 1 && report.revisionAfterThickness === 3 &&
          report.thickness5 === prop.thicknessTo && report.propsAfterEdit5?.thicknessMm === prop.thicknessTo &&
          report.panelMatchesAfterEdit5 === true],
      ['P10 同值再交一次 = 屏幕上一个字都不发（P12，比真源严）：depth 与 revision 两步都不许多',
        report.trial6Input === String(prop.thicknessTo) && report.depthAfterSameValue === report.depthAfterThickness &&
          report.revisionAfterSameValue === report.revisionAfterThickness],
      ['P11 Ctrl+Z 之后面板跟着真源回 240：面板读的是真源，不是本地态',
        report.comboAfterUndoThickness === 'Ctrl+Z' && report.depthAfterUndoThickness === report.baseDepth &&
          report.thicknessAfterUndoThickness === 240],
      ['P12 材料下拉框只按一发方向键就落到 concrete：depth +1、试跑 kind=material 且 ok',
        report.materialArrowPresses === 1 && report.material8 === prop.materialTo && report.trial8Kind === 'material' &&
          report.trial8Ok === true && report.depthAfterMaterial === report.baseDepth + 1],
      ['P13 材料不进派生（P4 在屏幕上的唯一凭据）：ops、三层计数、墨迹三处逐字等于第 3 步那一份',
        report.opsAfterMaterial === report.opsAtSelect &&
          JSON.stringify(report.layersAfterMaterial) === JSON.stringify(report.layersAtSelect) &&
          report.nonBlankAfterMaterial === report.nonBlankAtSelect && report.pixelCountsMatchMaterial === true],
      ['P14 承重的复选框真点得动：loadBearing 翻成探针预言的值、depth 再 +1（此刻基线 +2）',
        report.trial9Kind === 'loadBearing' && report.trial9Ok === true && report.loadBearing9 === prop.loadBearingTo &&
          report.depthAfterLoadBearing === report.baseDepth + 2],
      ['P15 逐发撤销回到第 3 步读数：实测恰好 2 发（不是四发也不是三发），三格逐字相同、depth 回基线',
        report.undoCount === 2 && JSON.stringify(report.undoCombos) === '["Ctrl+Z","Ctrl+Z"]' &&
          report.propsMatchStep3 === true && JSON.stringify(report.propsAfterUndos) === JSON.stringify(prop.props) &&
          report.depthAfterUndos === report.baseDepth],
      ['P16 点墙 + Shift 点它身上的洞口 = 混选：两枚选中、面板仍指那面墙（P3 里"选中集不止一个就关面板"是错的读法）',
        report.selectedAfterOpeningShift?.length === 2 && report.selectedAfterOpeningShift?.includes(prop.wallId) === true &&
          report.selectedAfterOpeningShift?.includes(prop.openingId) === true && report.panelWallAfterMixed === prop.wallId &&
          report.panelMatchesOnMixed === true],
      ['P17 再 Shift 点探针给的第三发（第二面墙）= 两面墙：三枚选中、面板整块消失而不是"取第一面"（M2 那一发红在这儿）',
        report.secondWallId === prop.secondWallId && JSON.stringify(report.secondWallPx) === JSON.stringify(prop.secondWallPx) &&
          report.selectedAfterSecondWall?.length === 3 && report.selectedAfterSecondWall?.includes(prop.secondWallId) === true &&
          report.panelWallAfterTwoWalls === null && report.panelPropsAfterTwoWalls === null &&
          // 整块消失的**屏幕**形状（终审 B2 P1-2）：`wall-id` 连节点都没有，外壳里只剩『未选中墙』
          // 那一枚 span（`panels.tsx` props === null 分支）—— 渲染条件写反时 echo 全绿、这一行红。
          report.wallIdDomAfterTwoWalls === null && report.noWallDomAfterTwoWalls === '未选中墙'],
      ['P18 点空白清空、再点墙恢复：面板关到 null、选中 0，重选又指回那面墙（第 12 步吃的正是这份选中集）',
        report.selectedAfterClear === 0 && report.panelWallAfterClear === null &&
          report.panelWallAfterReselect === prop.wallId && report.selectedBeforeDelete?.length === 2 &&
          report.depthAfterMultiSequence === report.baseDepth &&
          // 与 P17 同一句字的上屏凭据（终审 B2 P1-2）：区别只在同时 `wall-id` 在不在。
          report.noWallDomAfterClear === '未选中墙'],
      ['P19 Delete 只发一条命令：plan 账就那面墙（宿主墙身上的洞口归级联，不发第二条）、unsupported 空、选中剪空、面板关而 tab 两条还在',
        report.deleteOutcome === 'ok' && report.depthAfterDelete === report.baseDepth + 1 &&
          JSON.stringify(report.planDeletedIds) === JSON.stringify([prop.wallId]) && report.deletedCount === 1 &&
          report.unsupportedCount === 0 && report.selectionAfterDeleteCount === 0 && report.panelWallAfterDelete === null &&
          report.tabsCountAtDelete === 2],
      ['P20 级联在屏幕上留痕（真源删的那一发，不在 plan 账上）：opening 层实测 10 → 8',
        report.openingOpsBeforeDelete === 10 && report.openingOpsAfterDelete === 8 &&
          report.openingOpsVanishedOnDelete === true],
      ['P21 Ctrl+Z 撤销的是文档不是视图（D7）：opening 层回 10、指令表回 31、点逐字回第 3 步那份、选中仍为空',
        report.comboAfterUndoDelete === 'Ctrl+Z' && report.openingOpsAfterUndoDelete === 10 &&
          report.opsAfterUndoDelete === 31 && report.depthAfterUndoDelete === report.baseDepth &&
          report.pointsAfterUndoDelete === report.basePoints && report.pointsMatchAfterUndoDelete === true &&
          report.selectedAfterUndoDelete === 0],
      ['P22 连点两次 tab：两份读数与第 0 步那份逐字相同（P6：tab 顺序不随进程漂）',
        report.tabsJsonMatch === true && report.tabStripUpper === report.tabStripAtStart &&
          report.tabStripLower === report.tabStripAtStart],
      ['P23 总账：终态 depth / 点数 / 当前层 / 视口 / 工具全部回第 0 步，面板关、选中空，探针重新算出的靶子逐字相同（整条序列没留痕）',
        report.depthAtFinish === report.baseDepth && report.pointsAtFinish === report.basePoints &&
          report.storeyIdAtFinish === report.storeyIdAtStart && report.toolAtFinish === 'select' &&
          report.panelWallAtFinish === null && report.selectedAtFinish === 0 &&
          JSON.stringify(report.viewportAtFinish) === JSON.stringify(report.viewportAtStart) &&
          report.propMatchesStart === true],
    );
  }
  let bad = 0;
  for (const [name, ok] of checks) {
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}\n`);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (bad > 0) throw new Error(`${String(bad)} 项判据没过`);
  // 判据条数硬闸（终审屏幕侧 P1）：`mode` 是上面那条 argv 链现推的，专属 token 一旦从 root
  // script 里掉出去（`package.json` 那五条是产地），`--prop` 就判不到、一路掉进 'shot' 兜底，
  // `specificFlag` 跟着变 null ⇒ 跑成基本六条那一套、六行全 PASS、`bad === 0`、exit=0，
  // 而操作者以为自己跑的是 `pnpm prop-shot`。**判据整段没跑还报绿**是本仓库最忌讳的一型。
  // 期望值写死成盘上终账（shot 6 / pick 11 / edit 22 / draw 28 / prop 30）：加判据必须同时改这张表。
  const expectedChecksByMode = { shot: 6, pick: 11, edit: 22, draw: 28, prop: 30 };
  const expectedChecks = expectedChecksByMode[mode];
  if (checks.length !== expectedChecks) {
    throw new Error(
      `模式 ${mode} 的判据条数对不上：实到 ${String(checks.length)} 条，应有 ${String(expectedChecks)} 条` +
        `（专属判据整段没跑或被剪了一条都不许算过）`,
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
