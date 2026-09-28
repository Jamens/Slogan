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
const electronArgs = [
  '.',
  ...(wantPick ? ['--pick-shot'] : []),
  '--shot',
  out,
];
try {
  runPnpm('pnpm --filter @dajia/desktop build');
  runElectron(electronArgs, 180_000);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  const layers = report.layers ?? {};
  // 前六条与 drawlist.test.ts 同源；后四条与 pick.test.ts 同源。
  // 改样例房必须几处一起改，别只调这里。
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
    checks.push(
      ['探针给出可点的构件', typeof report.pick?.ownerId === 'string'],
      ['点中墙后屏幕上真的有红色像素', report.pickedSelectedPx > 100],
      ['选中的就是探针指的那面墙', report.clickedOwner === report.pick?.ownerId],
      // 两半都要：store 空了 **且** 红色像素没了 —— 只查前者的话，paint effect 漏掉 ids
      // 依赖（屏幕还红着）会一路绿灯。
      ['点空白后 store 与屏幕一起清空', report.selectedAfterBlank === 0 && report.selectedPx === 0],
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
