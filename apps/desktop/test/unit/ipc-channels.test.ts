import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INVOKE_CHANNELS, IPC, type IpcChannel } from '@dajia/protocol';

const MAIN = '../../src/main/ipc-persist.ts';
const PRELOAD = '../../src/preload/index.ts';

function srcOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

/**
 * 通道在 `IPC` 表里的**键名**（`projectOpen`）。为什么不扫字符串值（`'dajia:project-open'`）：
 * 注册与订阅在源码里写的都是 `IPC.projectOpen`，扫值会把"硬编码那一条通道名"也算成合规 ——
 * 而硬编码正是这一格要避免的第二份产地。
 */
function keyOf(channel: IpcChannel): string {
  const key = Object.keys(IPC).find((k) => IPC[k as keyof typeof IPC] === channel);
  if (key === undefined) throw new Error(`通道 ${channel} 不在 IPC 表里：名册与表漂了`);
  return key;
}

describe('三条请求通道 + 一条事件的两端对账', () => {
  it('名册里每一条都在 main 有 case、在 preload 有 invoke（只改一边就红）', () => {
    const main = srcOf(MAIN);
    const preload = srcOf(PRELOAD);
    for (const channel of INVOKE_CHANNELS) {
      const key = keyOf(channel);
      expect(main.includes(`case IPC.${key}:`)).toBe(true);
      expect(preload.includes(`ipcRenderer.invoke(IPC.${key}`)).toBe(true);
    }
    // 正控制：名册悄悄变短（或为空）时上面那个循环一句都不断，这一行才是"扫过了三条"的凭据。
    expect(INVOKE_CHANNELS.length).toBe(3);
  });

  it('保存状态这条事件两头都在：main 发、preload 订，且给得出注销', () => {
    expect(srcOf(MAIN).includes('send(SAVE_STATUS_EVENT')).toBe(true);
    const preload = srcOf(PRELOAD);
    expect(preload.includes('ipcRenderer.on(SAVE_STATUS_EVENT')).toBe(true);
    // 注销不是装饰：一个 store 一份订阅（`createProjectStore` 在模块加载时挂一次，`reopenAsEdit()`
    // 不重挂 —— 它靠 `open()` 里那句 `save: null` 清场）。这份注销函数给的是 T8 测试与 T11 的前提：
    // `project-store.test.ts` 每格建一个 store，撤不干净就是往一份已经作废的 store 里写状态。
    expect(preload.includes('ipcRenderer.removeListener(SAVE_STATUS_EVENT')).toBe(true);
  });

  it('preload 一行数据库都不许碰（"renderer 永不接触数据库"的常驻证人）', () => {
    const preload = srcOf(PRELOAD);
    // 正控制先走一步：同一份文本里必须有 `ipcRenderer.invoke`，否则"没搜到"只说明读错了文件。
    expect(preload.includes('ipcRenderer.invoke')).toBe(true);
    for (const banned of ['mysql', 'node:fs', 'readFileSync', 'createPool', 'password']) {
      expect(preload.includes(banned)).toBe(false);
    }
  });
});
