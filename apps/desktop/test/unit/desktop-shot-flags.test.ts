import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 真窗口闸门脚本（`scripts/desktop-shot.mjs`）的两条判据。
 *
 * ## 为什么它们属于"源码级判据"这一族
 *
 * 它们守的是**环境与运行参数**上的两类错：两类都曾让 `pnpm shot` / `pick-shot` /
 * `edit-shot` / `draw-shot` / `prop-shot` 五道**全部 exit=1**，而 `pnpm build` exit=0、
 * 766+ 条单测全绿。它们既不在 `packages/*` 也不在 `apps/*`，所以
 * `packaging.test.ts` 那六格扫不到它们。
 *
 * 两条都实测过：
 * - `ELECTRON_RUN_AS_NODE=1`：来自**跑命令的那个 shell**，不是仓库配置、profile 里也没有。
 *   设着它时 `electron.exe` 以纯 Node 模式启动 —— 证据是 `electron.exe --version` 打印
 *   `v24.21.0`（Node 的版本）而不是 `v44.4.5`。那个模式下 `require('electron')` 拿到的是
 *   npm 包装包（只导出 exe 路径字符串）⇒ `app` 是 `undefined` ⇒
 *   `Cannot read properties of undefined (reading 'whenReady')`。
 * - GPU：容器化环境里 GPU 子进程反复 `exit_code=-1073741819`（ACCESS_VIOLATION）⇒
 *   `FATAL: GPU process isn't usable. Goodbye.`。**单给 `--disable-gpu` 不够，缺的是
 *   `--no-sandbox`**（沙箱同样会让 GPU 子进程崩）—— 这一点实测过三组开关才试出来。
 *
 * `--shot` 那一族是 Canvas 2D 的**像素回读**，本来就不经 GPU，所以关掉不影响它要验的东西。
 * 但有一处代价必须写明：软件光栅下**抗锯齿边缘的亚像素精度**与 GPU 路径略有差异 ⇒
 * 凡涉及抗锯齿边缘的像素判据，仍应在一台正常 GPU 的机器上复跑一次。
 */
// 本文件在 `apps/desktop/test/unit/`，往上三级才是仓库根（`packaging.test.ts` 用的
// `../../scripts/...` 是因为它从 `DESKTOP`（= apps/desktop）起算 —— 两者基准不同，别抄错）。
const SHOT = '../../../../scripts/desktop-shot.mjs';

function srcOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

describe('真窗口闸门脚本：环境与运行参数（W9/W10）', () => {
  it('W9 spawn 时必须删掉 ELECTRON_RUN_AS_NODE（它在跑命令的 shell 里，不在仓库配置）', () => {
    const src = srcOf(SHOT);
    // 必须在 spawn 的 env 里**删掉**，而不是靠调用方先 unset（那要求每个人记得）。
    expect(src).toContain('delete env.ELECTRON_RUN_AS_NODE');
    expect(src).toMatch(/env,/);
    // 且 `env` 得真的传给 spawnSync —— 只有 delete 而没传，等于没删。
    expect(/spawnSync\([\s\S]{0,400}env,/.test(src)).toBe(true);
  });

  it('W10 必须带 --no-sandbox + --disable-gpu（单给 --disable-gpu 不够，实测过）', () => {
    const src = srcOf(SHOT);
    const m = /const gpuFlags = \[([^\]]*)\]/.exec(src);
    expect(m).not.toBeNull();
    expect(m![1]).toContain("'--no-sandbox'");
    expect(m![1]).toContain("'--disable-gpu'");
    // 而且这两个 flag 必须真的进了 argv（`electronArgs` 里展开了 gpuFlags）。
    expect(src).toContain('...gpuFlags');
  });
});