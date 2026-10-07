import type { SaveTimer, TimerHandle } from '../../src/main/persist/autosave';

/** 定时器回调是同步触发的，但它kick出来的活是 async 的：跑 20 发微任务足够把链推到挂起点。 */
export async function tick(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

/**
 * 假钟：只做两件事 —— 报当前时间、按到点顺序跑回调。
 * `advance` 里回调新排的定时器若落在同一个窗口内也会被跑到，但 `armIdle()` 排的是
 * `clock + 60_000`，永远在窗口外 ⇒ 一次 advance 不会把"每 60 秒重试"滚成死循环。
 */
export class FakeTimer implements SaveTimer {
  private readonly timers: { id: number; at: number; cb: () => void }[] = [];
  private nextId = 1;
  clock = 0;

  now(): number {
    return this.clock;
  }

  schedule(cb: () => void, ms: number): TimerHandle {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new TypeError(`假钟收到非法延时 ${ms}：定时器不许是负数或 NaN`);
    }
    const id = this.nextId++;
    this.timers.push({ id, at: this.clock + ms, cb });
    return {
      cancel: () => {
        const i = this.timers.findIndex((t) => t.id === id);
        if (i >= 0) this.timers.splice(i, 1);
      },
    };
  }

  advance(ms: number): void {
    const target = this.clock + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.clock = due.at;
      const i = this.timers.indexOf(due);
      if (i >= 0) this.timers.splice(i, 1);
      due.cb();
    }
    this.clock = target;
  }

  pending(): number {
    return this.timers.length;
  }
}
