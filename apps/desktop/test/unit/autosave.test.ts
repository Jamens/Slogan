import { describe, expect, it } from 'vitest';
import { Document, type EntityId } from '@dajia/core';
import { LOCK_HEARTBEAT_INTERVAL_MS } from '../../src/main/db/locks';
import type { JournalEntry, JournalOutcome } from '../../src/main/db/repository';
import {
  Autosave,
  IDLE_SNAPSHOT_MS,
  RETRY_DELAY_MS,
  SNAPSHOT_EVERY_ROWS,
  type AutosaveOptions,
  type EmergencyPayload,
  type JournalSink,
  type SaveStatus,
  type SaveTimer,
  type TimerHandle,
} from '../../src/main/persist/autosave';

const PROJECT_ID = '0193aa00-0000-7000-8000-0000000000f1' as EntityId;
const STOREY_ID = '0193aa00-0000-7000-8000-0000000000f2' as EntityId;
const POINT_ID = '0193aa00-0000-7000-8000-0000000000f3' as EntityId;

/**
 * 引擎不看文档内容，只看 `doc.projectId`（抢救件要它）与"这一发带的是哪份文档"。
 * 所以 unit 档全程共用一份 `Document.create(PROJECT_ID)`：省掉造样房的噪音，
 * 也让 `rescued[i].doc === DOC` 这种引用相等断言写得动。真房子里的账在 db 档。
 */
const DOC = Document.create(PROJECT_ID);

function entry(turn: number): JournalEntry {
  return {
    turn,
    patch: {
      upsert: [{ kind: 'point', id: POINT_ID, storeyId: STOREY_ID, x: turn * 100, y: 0 }],
      remove: [],
    },
    doc: DOC,
  };
}

/** 定时器回调是同步触发的，但它kick出来的活是 async 的：跑 20 发微任务足够把链推到挂起点。 */
async function tick(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

/**
 * 假钟：只做两件事 —— 报当前时间、按到点顺序跑回调。
 * `advance` 里回调新排的定时器若落在同一个窗口内也会被跑到，但 `armIdle()` 排的是
 * `clock + 60_000`，永远在窗口外 ⇒ 一次 advance 不会把"每 60 秒重试"滚成死循环。
 */
class FakeTimer implements SaveTimer {
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

/** 记账型假 sink：谁被调过、按什么顺序、并发度多高、哪些发该抛，全在这里看得见。 */
class FakeSink implements JournalSink {
  readonly appended: number[] = [];
  readonly snapshots: number[] = [];
  maxInFlight = 0;
  failAppends = new Set<number>();
  failAllAppends = false;
  failSnapshots = new Set<number>();
  alreadyApplied = new Set<number>();
  private inFlight = 0;
  private waiter: (() => void) | null = null;
  private waiting: Promise<void> | null = null;

  /** 下一次 append 挂起，直到 `release()`。「队列串行」那一格用它测"队列是不是真串行"。 */
  hold(): void {
    this.waiting = new Promise<void>((resolve) => {
      this.waiter = resolve;
    });
  }

  release(): void {
    const resolve = this.waiter;
    this.waiter = null;
    this.waiting = null;
    resolve?.();
  }

  async appendJournal(entry: JournalEntry): Promise<JournalOutcome> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.waiting) await this.waiting;
      if (this.failAllAppends || this.failAppends.has(entry.turn)) {
        throw Object.assign(new Error(`模拟库故障 turn ${entry.turn}`), { code: 'ECONNREFUSED' });
      }
      this.appended.push(entry.turn);
      return this.alreadyApplied.has(entry.turn) ? 'already-applied' : 'applied';
    } finally {
      this.inFlight -= 1;
    }
  }

  async writeSnapshot(turn: number): Promise<void> {
    if (this.failSnapshots.has(turn)) {
      throw Object.assign(new Error(`模拟快照失败 turn ${turn}`), { code: 'ER_LOCK_WAIT_TIMEOUT' });
    }
    this.snapshots.push(turn);
  }
}

function beatSpy(outcome: () => 'renewed' | 'lost' | 'throw') {
  let count = 0;
  return {
    count: (): number => count,
    beat: async (): Promise<'renewed' | 'lost'> => {
      count += 1;
      const answer = outcome();
      if (answer === 'throw') throw new Error('心跳发不出去');
      return answer;
    },
  };
}

/** 引擎的异步活全部挂在同一条 `chain` 上（定时器回调也接进这条链），所以 `settled()` 是唯一可靠的等待点。 */
function harness(options: Partial<AutosaveOptions> = {}) {
  const sink = new FakeSink();
  const timer = new FakeTimer();
  const statuses: SaveStatus[] = [];
  const rescued: EmergencyPayload[] = [];
  const engine = new Autosave({
    sink,
    timer,
    onStatus: (status) => statuses.push(status),
    onEmergency: (payload) => rescued.push(payload),
    ...options,
  });
  return { sink, timer, statuses, rescued, engine };
}

describe('默认值与入参守卫', () => {
  it('两个阈值是 spec §8.2 的原话；默认值真生效（1 发不到 2000，60 秒到点补一份）', async () => {
    expect(SNAPSHOT_EVERY_ROWS).toBe(2000);
    expect(IDLE_SNAPSHOT_MS).toBe(60_000);
    const { engine, sink, timer } = harness();
    expect(timer.pending()).toBe(0); // 没给 beat ⇒ 构造时一个定时器都不排
    engine.submit(entry(1));
    await engine.settled();
    expect(sink.appended).toEqual([1]);
    expect(sink.snapshots).toEqual([]);
    timer.advance(IDLE_SNAPSHOT_MS);
    await engine.settled();
    expect(sink.snapshots).toEqual([1]);
    expect(engine.status().phase).toBe('idle');
  });

  it('三个延时都是正整数尺：0、负数、小数一律构造期抛', () => {
    // 0 与负数会让阈值判定每发都写或永不写；让它们在构造期响，不等运行期悄悄歪。
    expect(() => harness({ snapshotEveryRows: 0 })).toThrow(/snapshotEveryRows/);
    expect(() => harness({ snapshotEveryRows: -3 })).toThrow(/snapshotEveryRows/);
    expect(() => harness({ snapshotEveryRows: 2.5 })).toThrow(/snapshotEveryRows/);
    expect(() => harness({ idleSnapshotMs: 0 })).toThrow(/idleSnapshotMs/);
    expect(() => harness({ retryDelayMs: -1 })).toThrow(/retryDelayMs/);
  });

  it('submit 的 turn 守卫在投递口：非法 turn 抛，且 sink 一次都没被调', () => {
    const { engine, sink } = harness();
    expect(() => engine.submit(entry(0))).toThrow(/turn/);
    expect(() => engine.submit(entry(1.5))).toThrow(/turn/);
    expect(() => engine.submit(entry(Number.MAX_SAFE_INTEGER + 1))).toThrow(/turn/);
    expect(sink.appended).toEqual([]);
  });

  it('fromJournal 起点按库里的账算：阈值接得上，起点之后的重投不许进队', async () => {
    const { engine, sink } = harness({
      snapshotEveryRows: 3,
      fromJournal: { lastTurn: 11, snapshotTurn: 10, rowsSinceSnapshot: 2 },
    });
    expect(engine.status().lastTurn).toBe(11);
    expect(engine.status().snapshotTurn).toBe(10);
    expect(engine.status().rowsSinceSnapshot).toBe(2);
    // 库里已经欠 2 行 ⇒ 下一发就到 3 ⇒ 快照落在 12，不是 13。
    expect(engine.submit(entry(11))).toBe('ignored-duplicate');
    engine.submit(entry(12));
    await engine.settled();
    expect(sink.snapshots).toEqual([12]);
    expect(engine.status().rowsSinceSnapshot).toBe(0);
    expect(() =>
      new Autosave({
        sink,
        timer: new FakeTimer(),
        fromJournal: { lastTurn: 1, snapshotTurn: null, rowsSinceSnapshot: -1 },
      }),
    ).toThrow(/rowsSinceSnapshot/);
  });
});

describe('追加：顺序、串行、重复投递', () => {
  it('三发按投递顺序进 sink，阈值不到就不写快照', async () => {
    const { engine, sink } = harness({ snapshotEveryRows: 10 });
    engine.submit(entry(1));
    engine.submit(entry(2));
    engine.submit(entry(3));
    await engine.settled();
    expect(sink.appended).toEqual([1, 2, 3]);
    expect(sink.snapshots).toEqual([]);
    expect(engine.status()).toMatchObject({ phase: 'idle', lastTurn: 3, rowsSinceSnapshot: 3 });
  });

  it('already-applied 不推进 rowsSinceSnapshot（P-6 那把尺的定义在这里）', async () => {
    const { engine, sink } = harness({ snapshotEveryRows: 3 });
    sink.alreadyApplied.add(2);
    for (const turn of [1, 2, 3]) engine.submit(entry(turn));
    await engine.settled();
    // 1 加一行、2 不加、3 加一行 ⇒ 2 行，离阈值 3 还差一发
    expect(sink.appended).toEqual([1, 2, 3]);
    expect(sink.snapshots).toEqual([]);
    expect(engine.status().rowsSinceSnapshot).toBe(2);
    engine.submit(entry(4));
    await engine.settled();
    expect(sink.snapshots).toEqual([4]);
    expect(engine.status().snapshotTurn).toBe(4);
  });

  it('队列串行：第一发挂在库里时，第二发不许挤进去', async () => {
    const { engine, sink } = harness({ snapshotEveryRows: 10 });
    sink.hold();
    engine.submit(entry(1));
    engine.submit(entry(2));
    await tick();
    // 挂起期间第二发一次都没试过：并发度 2 的形态是"后发先至"，账上的 turn 序就乱了。
    expect(sink.appended).toEqual([]);
    expect(sink.maxInFlight).toBe(1);
    // `phase` 的五个取值里只有这一格能拍到 `'saving'`：队首真的压在库里、一份都还没落地的那一刻。
    // 别的格要么已经 `settled()`（`idle`），要么先出错（`failed`），要么先停写（`paused`）。
    expect(engine.status().phase).toBe('saving');
    sink.release();
    await engine.settled();
    expect(sink.appended).toEqual([1, 2]);
    expect(sink.maxInFlight).toBe(1);
  });

  it('重复或回退的 turn ⇒ ignored-duplicate，sink 一次都不许多调', async () => {
    const { engine, sink } = harness({ snapshotEveryRows: 10, retryDelayMs: 60_000 });
    engine.submit(entry(1));
    engine.submit(entry(2));
    await engine.settled();
    expect(engine.submit(entry(2))).toBe('ignored-duplicate');
    expect(engine.submit(entry(1))).toBe('ignored-duplicate');
    expect(sink.appended).toEqual([1, 2]);
    // 失败还压在队首的那一发同样"见过"：重投不许在队里堆出两份同 turn。
    sink.failAppends.add(3);
    expect(engine.submit(entry(3))).toBe('queued');
    await engine.settled();
    expect(engine.submit(entry(3))).toBe('ignored-duplicate');
    expect(engine.status().queuedTurns).toBe(1);
  });
});

describe('快照触发', () => {
  it('阈值触发：第 N 发落地即快照，计数归零', async () => {
    const { engine, sink } = harness({ snapshotEveryRows: 3 });
    engine.submit(entry(1));
    engine.submit(entry(2));
    await engine.settled();
    expect(sink.snapshots).toEqual([]);
    engine.submit(entry(3));
    await engine.settled();
    expect(sink.snapshots).toEqual([3]);
    expect(engine.status()).toMatchObject({ snapshotTurn: 3, rowsSinceSnapshot: 0 });
  });

  it('连续 60 秒无编辑 ⇒ 在最后一发上补一份快照', async () => {
    const { engine, sink, timer } = harness({ snapshotEveryRows: 5 });
    engine.submit(entry(1));
    engine.submit(entry(2));
    await engine.settled();
    expect(sink.snapshots).toEqual([]);
    timer.advance(IDLE_SNAPSHOT_MS);
    await engine.settled();
    expect(sink.snapshots).toEqual([2]);
    expect(engine.status().snapshotTurn).toBe(2);
  });

  it('空闲计时随新编辑重置：60 秒是给"没有新动作"计的，不是给第一发计的', async () => {
    const { engine, sink, timer } = harness({ snapshotEveryRows: 5 });
    engine.submit(entry(1));
    await engine.settled();
    timer.advance(IDLE_SNAPSHOT_MS - 1);
    expect(sink.snapshots).toEqual([]);
    engine.submit(entry(2));
    await engine.settled();
    timer.advance(IDLE_SNAPSHOT_MS);
    await engine.settled();
    // 重置漂了的话这里会是 [1, 2]：第一发上落一份没意义的快照。
    expect(sink.snapshots).toEqual([2]);
  });

  it('没有新行就不许空转：拨满三次 60 秒，writeSnapshot 调用次数仍是 0，定时器也不留着', async () => {
    const { engine, sink, timer } = harness({ snapshotEveryRows: 3 });
    for (const turn of [1, 2, 3]) engine.submit(entry(turn));
    await engine.settled();
    expect(sink.snapshots).toEqual([3]);
    for (let i = 0; i < 3; i++) {
      timer.advance(IDLE_SNAPSHOT_MS);
      await engine.settled();
    }
    expect(sink.snapshots).toEqual([3]);
    expect(timer.pending()).toBe(0); // 快照已平 ⇒ 空闲定时器该被撤掉，不是留着每 60 秒空敲一次
  });

  it('同一 turn 只落一份：阈值路径与空闲路径盯上同一发时，后到的那个跳过', async () => {
    const { engine, sink, timer } = harness({ snapshotEveryRows: 2 });
    for (const turn of [1, 2, 3]) engine.submit(entry(turn));
    await engine.settled();
    expect(sink.snapshots).toEqual([2]); // 阈值只在 2 上落了一份
    expect(engine.status().rowsSinceSnapshot).toBe(1); // turn 3 欠着
    timer.advance(IDLE_SNAPSHOT_MS);
    await engine.settled();
    expect(sink.snapshots).toEqual([2, 3]); // 空闲把 3 补上
    timer.advance(IDLE_SNAPSHOT_MS);
    await engine.settled();
    expect(sink.snapshots).toEqual([2, 3]); // 再拨一次不许重写 3（库侧那把牙是 T4「同一个 turn 落两份快照 ⇒ 抛」那一格实测过的）
  });
});

describe('失败、重试与抢救', () => {
  it('append 抛 ⇒ failed、欠款留在队首、每 turn 抢救一次、文案带驱动 code', async () => {
    const E2 = entry(2);
    const { engine, sink, rescued } = harness({ snapshotEveryRows: 10, retryDelayMs: 30_000 });
    sink.failAppends.add(2);
    engine.submit(entry(1));
    engine.submit(E2);
    engine.submit(entry(3));
    await engine.settled();
    expect(sink.appended).toEqual([1]);
    const status = engine.status();
    expect(status.phase).toBe('failed');
    // 失败那发连着它后面那发都还在队里：turn 有序，后发先至会在账上留洞。
    expect(status.queuedTurns).toBe(2);
    expect(status.lastTurn).toBe(1);
    expect(status.lastError).toContain('ECONNREFUSED');
    expect(status.lastError).toContain('模拟库故障 turn 2');
    expect(rescued).toHaveLength(1);
    expect(rescued[0]?.turn).toBe(2);
    expect(rescued[0]?.doc).toBe(DOC);
    expect(rescued[0]?.patch).toBe(E2.patch);
  });

  it('重试成功 ⇒ 队列补齐、phase 回 idle、同一 turn 的抢救不重复', async () => {
    const { engine, sink, timer, rescued } = harness({ snapshotEveryRows: 10 });
    sink.failAppends.add(2);
    for (const turn of [1, 2, 3]) engine.submit(entry(turn));
    await engine.settled();
    expect(rescued).toHaveLength(1);
    sink.failAppends.delete(2);
    timer.advance(RETRY_DELAY_MS);
    await engine.settled();
    expect(sink.appended).toEqual([1, 2, 3]);
    expect(engine.status()).toMatchObject({ phase: 'idle', queuedTurns: 0, lastTurn: 3 });
    expect(rescued).toHaveLength(1); // 重试不是重新写盘（T7 ⑦ 段）
  });

  it('队首一直失败：抢救一次都不许多，队列一条都不许丢', async () => {
    const { engine, sink, timer, rescued } = harness({ retryDelayMs: 1_000 });
    sink.failAllAppends = true;
    for (const turn of [1, 2, 3]) engine.submit(entry(turn));
    await engine.settled();
    for (let i = 0; i < 10; i++) {
      timer.advance(1_000);
      await engine.settled();
    }
    expect(sink.appended).toEqual([]);
    expect(engine.status().queuedTurns).toBe(3);
    // 队首 turn 1 反复失败 ⇒ 只抢救一次。spec §9 的"持续重试"是重试，不是持续写盘。
    expect(rescued.map((p) => p.turn)).toEqual([1]);
  });

  it('快照失败不吞日志：那一发已成立，计数不清零，空闲路径负责再试', async () => {
    const { engine, sink, timer } = harness({ snapshotEveryRows: 3 });
    sink.failSnapshots.add(3);
    for (const turn of [1, 2, 3]) engine.submit(entry(turn));
    await engine.settled();
    expect(sink.appended).toEqual([1, 2, 3]);
    expect(sink.snapshots).toEqual([]);
    const failed = engine.status();
    expect(failed.phase).toBe('failed');
    expect(failed.lastError).toContain('快照 turn 3 失败');
    expect(failed.rowsSinceSnapshot).toBe(3); // 没写成就不清零：清零等于宣布库里有一行快照
    sink.failSnapshots.delete(3);
    timer.advance(IDLE_SNAPSHOT_MS);
    await engine.settled();
    expect(sink.snapshots).toEqual([3]);
    expect(engine.status()).toMatchObject({ phase: 'idle', rowsSinceSnapshot: 0 });
  });

  it('flush 在库不可达时如实报 failed，queuedTurns 不清零（不许假装写完）', async () => {
    const { engine, sink } = harness();
    sink.failAllAppends = true;
    engine.submit(entry(1));
    await engine.settled();
    const after = await engine.flush();
    expect(after.phase).toBe('failed');
    expect(after.queuedTurns).toBe(1);
  });

  it('flush 把欠的收尾快照补上，之后的空闲定时器再敲也不重复落', async () => {
    const { engine, sink, timer } = harness({ snapshotEveryRows: 3 });
    for (const turn of [1, 2, 3, 4]) engine.submit(entry(turn));
    await engine.settled();
    expect(sink.snapshots).toEqual([3]);
    const after = await engine.flush();
    expect(sink.snapshots).toEqual([3, 4]);
    expect(after).toMatchObject({ phase: 'idle', snapshotTurn: 4, rowsSinceSnapshot: 0 });
    timer.advance(IDLE_SNAPSHOT_MS);
    await engine.settled();
    expect(sink.snapshots).toEqual([3, 4]);
  });
});

describe('心跳与停写', () => {
  it('beat 的间隔默认就是 T6 的那一个数：每 LOCK_HEARTBEAT_INTERVAL_MS 一发', async () => {
    const spy = beatSpy(() => 'renewed');
    const { engine, timer } = harness({ beat: spy.beat });
    timer.advance(LOCK_HEARTBEAT_INTERVAL_MS);
    await engine.settled();
    expect(spy.count()).toBe(1);
    timer.advance(LOCK_HEARTBEAT_INTERVAL_MS);
    await engine.settled();
    expect(spy.count()).toBe(2);
    expect(engine.status().phase).toBe('idle');
  });

  it('beat 报 lost ⇒ paused：后续投递不进 sink、队列留着、重试定时器一起撤', async () => {
    let answer: 'renewed' | 'lost' = 'renewed';
    const spy = beatSpy(() => answer);
    const { engine, sink, timer, statuses } = harness({
      beat: spy.beat,
      snapshotEveryRows: 10,
      retryDelayMs: 500,
    });
    sink.failAppends.add(9);
    engine.submit(entry(9));
    await engine.settled(); // 失败 ⇒ 重试定时器已排上
    expect(engine.status().queuedTurns).toBe(1);
    answer = 'lost';
    timer.advance(LOCK_HEARTBEAT_INTERVAL_MS);
    await engine.settled();
    const paused = engine.status();
    expect(paused.phase).toBe('paused');
    expect(paused.pauseReason).toContain('lock');
    expect(statuses.some((s) => s.phase === 'paused')).toBe(true);
    engine.submit(entry(10));
    await engine.settled();
    expect(sink.appended).toEqual([]); // 停手：T6 第 ④ 段那句"拿到 lost 就必须停手"的落地
    timer.advance(5_000);
    await engine.settled();
    expect(sink.appended).toEqual([]); // 重试定时器也必须被撤掉，不许在停写状态下偷偷写
    expect(engine.status().queuedTurns).toBe(2);
    expect(spy.count()).toBe(1); // paused 之后心跳链也停了：停写状态下再问一次锁没有读者
  });

  it('beat 抛错同样按 lost 停写（问不出去 = 不知道锁还在不在，后果不对称 ⇒ 保守）', async () => {
    const spy = beatSpy(() => 'throw');
    const { engine, timer } = harness({ beat: spy.beat });
    timer.advance(LOCK_HEARTBEAT_INTERVAL_MS);
    await engine.settled();
    expect(spy.count()).toBe(1);
    const status = engine.status();
    expect(status.phase).toBe('paused');
    expect(status.lastError).toContain('按丢锁处理');
    expect(status.lastError).toContain('心跳发不出去');
  });

  it('resume 之后把停写期间憋着的那一发补上', async () => {
    let answer: 'renewed' | 'lost' = 'renewed';
    const spy = beatSpy(() => answer);
    const { engine, sink, timer } = harness({ beat: spy.beat, snapshotEveryRows: 10 });
    answer = 'lost';
    timer.advance(LOCK_HEARTBEAT_INTERVAL_MS);
    await engine.settled();
    engine.submit(entry(1));
    engine.submit(entry(2));
    await engine.settled();
    expect(sink.appended).toEqual([]);
    engine.resume();
    await engine.settled();
    expect(sink.appended).toEqual([1, 2]);
    expect(engine.status()).toMatchObject({ phase: 'idle', queuedTurns: 0, pauseReason: null });
  });

  it('stop 拆掉所有定时器、报 stopped，欠款非空时说清还剩几发', async () => {
    const spy = beatSpy(() => 'renewed');
    const { engine, sink, timer } = harness({ beat: spy.beat, retryDelayMs: 1_000 });
    sink.failAppends.add(1);
    engine.submit(entry(1));
    await engine.settled();
    const stopped = engine.stop();
    expect(stopped.phase).toBe('stopped');
    expect(stopped.lastError).toContain('仍有 1 发未落盘');
    const beats = spy.count();
    timer.advance(IDLE_SNAPSHOT_MS * 2);
    await engine.settled();
    expect(spy.count()).toBe(beats); // 定时器没拆干净的话这里会涨
    expect(sink.appended).toEqual([]);
    expect(() => engine.submit(entry(2))).toThrow(/已 stop/);
  });
});
