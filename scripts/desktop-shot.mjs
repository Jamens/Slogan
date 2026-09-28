import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Windows 上 pnpm 是 pnpm.cmd：不给 shell:true 会 ENOENT。
const shell = process.platform === 'win32';

function run(cmd, args, timeoutMs) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell, stdio: 'inherit', timeout: timeoutMs });
  if (r.error) throw r.error;
  if (r.signal) throw new Error(`${cmd} 被信号 ${r.signal} 打死（窗口没关？超时 ${String(timeoutMs)}ms）`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} → exit ${String(r.status)}`);
}

const dir = mkdtempSync(join(tmpdir(), 'dajia-shot-'));
const out = join(dir, 'report.json');
try {
  run('pnpm', ['--filter', '@dajia/desktop', 'build']);
  run('pnpm', ['--filter', '@dajia/desktop', 'exec', 'electron', '.', '--shot', out], 180_000);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  const layers = report.layers ?? {};
  // 这四个数与 drawlist.test.ts 同源：改样例房必须两处一起改，别只调这里。
  const checks = [
    ['指令表 31 条（8 轮廓 + 12 轴线 + 10 洞口线 + 1 标签）', report.ops === 31],
    ['structure 层 20 条', layers.structure === 20],
    ['opening 层 10 条', layers.opening === 10],
    ['annotation 层 1 条', layers.annotation === 1],
    ['画布尺寸 = 窗口内容区', report.wPx > 800 && report.hPx > 500],
    ['非背景像素 > 5000（白屏恒为 0）', report.nonBlankPx > 5000],
  ];
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
