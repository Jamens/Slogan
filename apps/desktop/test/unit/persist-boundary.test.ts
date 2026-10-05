import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 只扫 `from '…'` 的模块说明符，不扫正文：注释里写"落盘 / fs / electron"是本计划注释的正常写法，
 * 不该成为红。三条判据各挡一型漂移，别顺手删成一条。
 */
function srcOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

const AUTOSAVE = '../../src/main/persist/autosave.ts';
const EMERGENCY = '../../src/main/persist/emergency.ts';
const DESCRIBE_ERROR = '../../src/main/persist/describe-error.ts';

describe('persist 档的 import 边界（P-2）', () => {
  it('autosave.ts 既不 import electron 也不 import node:fs：外部世界只从三条注入通道进来', () => {
    const src = srcOf(AUTOSAVE);
    expect(src.includes("from 'electron'")).toBe(false);
    expect(src.includes("from 'node:fs'")).toBe(false);
    // 反向判据：三条通道都在。少了任何一条，"注入"就退化成"连库/连盘才能测"，
    // 而这一格是唯一会注意到那一型退化的地方（退化的文件依然能跑，只是没人测得到）。
    expect(src.includes('JournalSink')).toBe(true);
    expect(src.includes('SaveTimer')).toBe(true);
    expect(src.includes('onEmergency')).toBe(true);
    // 心跳间隔必须是 T6 那个常量的引用，不是本文件里的第二个数（P-4/P-14 的账）：
    // 漂成字面量 `5000` 时值一样、行为一样，只有这一句看得见。
    expect(src.includes('LOCK_HEARTBEAT_INTERVAL_MS')).toBe(true);
  });

  it('emergency.ts 允许碰 fs 但不许认识 electron；describe-error.ts 两样都不许', () => {
    const emergency = srcOf(EMERGENCY);
    // 不对称是有意的：本文件正是 T7 唯一被授权碰盘的那一个（裁决 P-10），
    // 但它同样不许 import electron —— `app.getPath('userData')` 由 T8 当参数递进来。
    expect(emergency.includes("from 'node:fs'")).toBe(true);
    expect(emergency.includes("from 'electron'")).toBe(false);
    const describeError = srcOf(DESCRIBE_ERROR);
    expect(describeError.includes("from 'electron'")).toBe(false);
    expect(describeError.includes("from 'node:fs'")).toBe(false);
    // 文案出口连 core 都不许要：它必须能在任何一侧独立编译（T9 的诊断档也会 import 它）。
    expect(describeError.includes("from '@dajia/core'")).toBe(false);
  });
});
